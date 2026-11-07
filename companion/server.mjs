#!/usr/bin/env node
// NetBrowserClaw Companion —— 本地伴生服务（零依赖，仅用 Node 内置模块）
//
// 职责：
//   1. /proxy        —— 反向代理，把扩展的模型请求转发到 API，绕开浏览器 CORS / 网络出口限制。
//   2. /bridge/*     —— 与扩展通信的桥，让外部 MCP 客户端也能驱动这个浏览器。
//   3. MCP (stdio)   —— 以 MCP 协议暴露浏览器工具，可挂到 Claude Code / Cursor / Claude Desktop。
//
// 启动：
//   node companion/server.mjs            # 只启动 HTTP 服务
//   node companion/server.mjs --mcp      # 额外以 stdio 启动 MCP 服务器（给 MCP 客户端用）
//
// 隐私：只监听 127.0.0.1；不写任何日志文件；所有数据在内存中。

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { upgradeToWebSocket } from './ws-server.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.NBC_PORT || 8787);
const HOST = '127.0.0.1';
const START_MCP = process.argv.includes('--mcp');

// ---------------------------------------------------------------------------
// 本地工具配置（ffmpeg / yt-dlp / 下载目录）
//
// 扩展无法启动本地进程，所以"在浏览器里配置路径"的落地方式是：
// 扩展把配置推到 companion，由 companion 实际调用这些程序。
// 配置持久化在用户主目录，不写进仓库。
// ---------------------------------------------------------------------------

const CONFIG_DIR = pathJoin(homedir(), '.netbrowserclaw');
const CONFIG_FILE = pathJoin(CONFIG_DIR, 'config.json');

const defaultDownloadsDir = pathJoin(homedir(), 'Downloads');

let toolConfig = {
  ffmpegPath: '',
  ytdlpPath: '',
  downloadDir: defaultDownloadsDir,
};

function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return;
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    toolConfig = { ...toolConfig, ...raw };
  } catch {
    // 配置损坏时用默认值，不影响服务启动。
  }
}

function saveConfig() {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(toolConfig, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

loadConfig();

/**
 * 探测本机可用的 JS runtime。
 *
 * 新版 yt-dlp 需要 JS runtime 才能解 YouTube 的签名（需要执行网页里的 JS）。
 * 它只认 deno / node / bun 等少数几个，且不接受裸名字 —— 必须给绝对路径。
 */
function findJsRuntime() {
  // 首选当前进程的可执行文件（一定是绝对路径，且必定是 node）。
  // 它就是跑 companion 的那个 node，最可靠。
  if (process.execPath && /\.exe$/i.test(process.execPath)) {
    try {
      const r = spawnSync(process.execPath, ['--version'], { encoding: 'utf8', shell: false });
      if (r.status === 0) return `node:${process.execPath}`;
    } catch { /* 落到下面的探测 */ }
  }

  const candidates = [
    { cmd: 'deno', hint: 'deno' },
    { cmd: 'node', hint: 'node' },
    { cmd: 'bun', hint: 'bun' },
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c.cmd, ['--version'], { encoding: 'utf8', shell: false });
      if (r.status === 0) {
        // where.exe 能拿到绝对路径。
        // 直接 spawn 而不用 shell —— 带参数走 shell 既是 Node 的弃用模式，
        // 也意味着参数会被 shell 拼接解释。
        const w = spawnSync('where.exe', [c.cmd], { encoding: 'utf8', shell: false });
        const line = (w.stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)[0];
        const abs = line || c.cmd;
        return `${c.hint}:${abs}`;
      }
    } catch { /* 继续试下一个 */ }
  }
  return '';
}

/**
 * 工具探测结果缓存（60 秒）。
 *
 * probeBinary 会同步 spawn 子进程（各几百毫秒），而 /health 被扩展
 * 高频调用（并行探活多个端口 + 每秒轮询）—— 每个请求都 spawn 的话
 * 事件循环会被阻塞，连接堆积后直接 ECONNRESET（实测踩过）。
 * 所以探测结果必须缓存，不能按请求现算。
 */
let toolsCache = null;
let toolsCacheAt = 0;
const TOOLS_CACHE_TTL = 60_000;

/** 拿 ffmpeg / yt-dlp 的探测状态（带 60 秒缓存）。 */
function getToolsStatus(force = false) {
  if (!force && toolsCache && Date.now() - toolsCacheAt < TOOLS_CACHE_TTL) {
    return toolsCache;
  }
  toolsCache = {
    ffmpeg: probeBinary(toolConfig.ffmpegPath),
    ytdlp: probeBinary(toolConfig.ytdlpPath, '--version'),
  };
  toolsCacheAt = Date.now();
  return toolsCache;
}

/**
 * 探测一个可执行文件是否可用。
 * 只做只读检查（-version），不执行任何用户输入的任意参数。
 */
function probeBinary(binPath, versionFlag = '-version') {
  if (!binPath) return { ok: false, reason: '未配置路径' };
  if (!existsSync(binPath)) return { ok: false, reason: '文件不存在' };
  try {
    const res = spawnSync(binPath, [versionFlag], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    if (res.error) return { ok: false, reason: res.error.message };
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n')[0] || '';
    return { ok: res.status === 0, version: out, path: binPath };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}


// ---------------------------------------------------------------------------
// 桥：扩展轮询取命令，我们回传结果
// ---------------------------------------------------------------------------

const pending = [];          // 等待被扩展取走的命令
const waiters = [];          // 正在等待结果的命令
const commandSeq = new Map(); // id -> { resolve, reject, timer }
let lastExtensionSeen = 0;

function enqueue(tool, args) {
  const id = `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commandSeq.delete(id);
      reject(new Error(`工具 ${tool} 执行超时（扩展未响应）`));
    }, 120_000);
    commandSeq.set(id, { resolve, reject, timer });
  });
  pending.push({ id, tool, args });
  pump();
  return promise;
}

/** 有等待者时立刻唤醒。 */
function pump() {
  while (pending.length && waiters.length) {
    const waiter = waiters.shift();
    const cmd = pending.shift();
    waiter(cmd);
  }
}

function settle(id, result, error) {
  const entry = commandSeq.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  commandSeq.delete(id);
  if (error) entry.reject(new Error(error));
  else entry.resolve(result);
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.end(body);
}

/** 取 URL 的文件名部分。 */
function urlBasename(u) {
  try {
    const p = new URL(u).pathname;
    return decodeURIComponent(p.split('/').pop() || 'download');
  } catch {
    return 'download';
  }
}

/** 取文件大小（字节）。 */
function statSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

// WebSocket 升级：扩展通过它接收命令。
// 必须用 WebSocket 而不是 HTTP 轮询 —— Chrome/Edge 的扩展 Service Worker
// 无法用 fetch 访问 127.0.0.1 的 HTTP 服务（浏览器本地网络策略会直接拒绝，
// 连 companion 都收不到请求），而 WebSocket 不受该限制。
const wsConnections = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (process.env.NBC_DEBUG) {
    process.stderr.write(
      `[req] ${req.method} ${url.pathname} origin=${req.headers.origin || '-'} ` +
      `prn=${req.headers['access-control-request-private-network'] || '-'} ` +
      `host=${req.headers.host}
`
    );
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
      // Private Network Access：扩展访问 127.0.0.1 属于「本地网络」，
      // 浏览器会发带 Access-Control-Request-Private-Network 的预检，
      // 服务端必须显式回这个头，否则扩展侧 fetch 会直接 Failed to fetch。
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end();
    return;
  }

  try {
    // --- 健康检查 ---------------------------------------------------------
    if (url.pathname === '/health') {
      const tools = getToolsStatus();
      sendJson(res, 200, {
        ok: true,
        name: 'netbrowserclaw-companion',
        version: '0.1.0',
        // 长轮询每 20 秒才回来一次，存活窗口必须比这个间隔大，
        // 否则 health 会时真时假，依赖它的测试会不稳定。
        extensionConnected:
          Date.now() - lastExtensionSeen < 30_000 || wsConnections.size > 0,
        wsConnections: wsConnections.size,
        pendingCommands: pending.length,
        tools: {
          ffmpeg: tools.ffmpeg.ok,
          ytdlp: tools.ytdlp.ok,
        },
        downloadDir: toolConfig.downloadDir,
      });
      return;
    }

    // --- 反向代理 ---------------------------------------------------------
    if (url.pathname === '/proxy' && req.method === 'POST') {
      const { target, method = 'POST', headers = {}, body } = await readJson(req);
      if (!target) {
        sendJson(res, 400, { error: '缺少 target' });
        return;
      }
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch {
        sendJson(res, 400, { error: 'target 不是合法 URL' });
        return;
      }
      // 只允许 http/https，避免被用来读本地文件。
      if (!/^https?:$/.test(targetUrl.protocol)) {
        sendJson(res, 400, { error: '只允许 http/https' });
        return;
      }

      const upstream = await fetch(targetUrl, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
      });

      const outHeaders = {};
      upstream.headers.forEach((v, k) => {
        // 逐字透传内容类型，跳过 hop-by-hop 与长度（由 Node 重算）。
        if (!/^(content-length|transfer-encoding|connection|content-encoding)$/i.test(k)) {
          outHeaders[k] = v;
        }
      });
      outHeaders['Access-Control-Allow-Origin'] = '*';
      outHeaders['Access-Control-Allow-Private-Network'] = 'true';
      // 不压缩，流式转发更稳。
      delete outHeaders['content-encoding'];

      res.writeHead(upstream.status, outHeaders);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }

    // --- 桥：扩展轮询取命令 ------------------------------------------------
    if (url.pathname === '/bridge/poll' && req.method === 'POST') {
      lastExtensionSeen = Date.now();
      const body = await readJson(req).catch(() => ({}));
      if (Array.isArray(body.results)) {
        for (const r of body.results) {
          settle(r.id, r.result, r.error);
        }
      }
      if (pending.length) {
        const cmd = pending.shift();
        sendJson(res, 200, { commands: [cmd] });
        return;
      }
      // 短暂长轮询，最多 8 秒。
      // 不用 20 秒是为了让扩展在配置变更后能较快切换到新的 companion 地址。
      const timeout = setTimeout(() => {
        const idx = waiters.indexOf(handler);
        if (idx >= 0) waiters.splice(idx, 1);
        if (!res.writableEnded) sendJson(res, 200, { commands: [] });
      }, 8_000);
      const handler = (cmd) => {
        clearTimeout(timeout);
        if (!res.writableEnded) sendJson(res, 200, { commands: [cmd] });
      };
      waiters.push(handler);
      req.on('close', () => {
        const idx = waiters.indexOf(handler);
        if (idx >= 0) waiters.splice(idx, 1);
      });
      return;
    }

    // --- 保存文本内容到磁盘 ------------------------------------------------
    // 归档大页面时用（扩展里 base64 会占大量内存）
    if (url.pathname === '/save' && req.method === 'POST') {
      const { filename, content } = await readJson(req);
      if (!filename || typeof content !== 'string') {
        sendJson(res, 400, { error: '缺少 filename 或 content' });
        return;
      }
      mkdirSync(toolConfig.downloadDir, { recursive: true });
      // 去掉路径分隔符，避免写到目录外
      const safeName = String(filename).replace(/[\/:*?"<>|]+/g, '_').slice(0, 180);
      const outPath = pathJoin(toolConfig.downloadDir, safeName);
      writeFileSync(outPath, content, 'utf8');
      sendJson(res, 200, { ok: true, path: outPath, bytes: Buffer.byteLength(content, 'utf8') });
      return;
    }

    // --- 本地工具配置 -----------------------------------------------------
    if (url.pathname === '/config' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        config: {
          ...toolConfig,
          ffmpegDetected: getToolsStatus().ffmpeg,
          ytdlpDetected: getToolsStatus().ytdlp,
          downloadDirExists: existsSync(toolConfig.downloadDir),
        },
      });
      return;
    }

    if (url.pathname === '/config' && req.method === 'POST') {
      const body = await readJson(req);
      const next = { ...toolConfig };
      if (typeof body.ffmpegPath === 'string') next.ffmpegPath = body.ffmpegPath.trim();
      if (typeof body.ytdlpPath === 'string') next.ytdlpPath = body.ytdlpPath.trim();
      if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
        next.downloadDir = body.downloadDir.trim();
      }
      toolConfig = next;
      toolsCache = null; // 配置变了，下次探测强制刷新
      const persisted = saveConfig();
      sendJson(res, 200, {
        ok: true,
        persisted,
        config: {
          ...toolConfig,
          ffmpegDetected: getToolsStatus(true).ffmpeg,
          ytdlpDetected: getToolsStatus(true).ytdlp,
          downloadDirExists: existsSync(toolConfig.downloadDir),
        },
      });
      return;
    }

    // --- 检测本地工具 -----------------------------------------------------
    if (url.pathname === '/tools/detect' && req.method === 'POST') {
      const body = await readJson(req);
      const result = {
        ffmpeg: probeBinary(body.ffmpegPath),
        ytdlp: probeBinary(body.ytdlpPath, '--version'),
      };
      if (body.downloadDir) {
        result.downloadDir = {
          ok: existsSync(body.downloadDir),
          path: body.downloadDir,
          reason: existsSync(body.downloadDir) ? '' : '目录不存在',
        };
      }
      sendJson(res, 200, result);
      return;
    }

    // --- 流媒体下载（ffmpeg 合并 HLS/DASH） --------------------------------
    if (url.pathname === '/hls' && req.method === 'POST') {
      const { targetUrl, filename, referer, cookie } = await readJson(req);
      if (!targetUrl) {
        sendJson(res, 400, { error: '缺少 targetUrl' });
        return;
      }
      if (!toolConfig.ffmpegPath) {
        sendJson(res, 400, { error: '未配置 ffmpeg 路径' });
        return;
      }
      const ffmpeg = probeBinary(toolConfig.ffmpegPath);
      if (!ffmpeg.ok) {
        sendJson(res, 400, { error: `ffmpeg 不可用: ${ffmpeg.reason}` });
        return;
      }

      const outName = (filename || 'video').replace(/[\\/:*?"<>|]/g, '_').replace(/\.[a-z0-9]+$/i, '');
      const outPath = pathJoin(toolConfig.downloadDir, `${outName}.mp4`);
      mkdirSync(toolConfig.downloadDir, { recursive: true });

      // 组装请求头：ffmpeg 用 -headers 传，格式为 "Key: Value\r\n"
      const headerLines = [];
      if (referer) headerLines.push(`Referer: ${referer}`);
      if (cookie) headerLines.push(`Cookie: ${cookie}`);
      if (headerLines.length) headerLines.push('User-Agent: Mozilla/5.0');

      const args = [];
      if (headerLines.length) args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
      args.push('-i', targetUrl, '-c', 'copy', '-movflags', '+faststart', '-y', outPath);

      const proc = spawn(toolConfig.ffmpegPath, args, { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      const code = await new Promise((resolve) => {
        proc.on('error', (e) => resolve({ error: e.message }));
        proc.on('close', (c) => resolve({ code: c }));
      });

      if (code.error) {
        sendJson(res, 500, { error: `ffmpeg 启动失败: ${code.error}` });
        return;
      }
      if (code.code !== 0) {
        const tail = stderr.split('\n').filter(Boolean).slice(-6).join('\n');
        sendJson(res, 500, { error: `ffmpeg 退出码 ${code.code}`, detail: tail });
        return;
      }
      const size = existsSync(outPath) ? statSize(outPath) : null;
      sendJson(res, 200, { ok: true, path: outPath, size, mode: 'ffmpeg' });
      return;
    }

    // --- 通用下载（优先用 yt-dlp，回退到原生 fetch） -------------------------
    if (url.pathname === '/download' && req.method === 'POST') {
      const { targetUrl, filename, referer, cookie, audioOnly, format } = await readJson(req);
      if (!targetUrl) {
        sendJson(res, 400, { error: '缺少 targetUrl' });
        return;
      }
      mkdirSync(toolConfig.downloadDir, { recursive: true });

      // 有 yt-dlp 就用它（能处理更多站点）
      if (toolConfig.ytdlpPath && probeBinary(toolConfig.ytdlpPath, '--version').ok) {
        const outName = (filename || 'download').replace(/[\\/:*?"<>|]/g, '_');
        const outTemplate = pathJoin(toolConfig.downloadDir, `${outName}.%(ext)s`);
        const args = ['--no-playlist', '--newline', '-o', outTemplate];

        // 并发分片下载 —— YouTube 对单连接限速明显，多连接能快数倍
        const frags = Math.min(Math.max(Number(process.env.NBC_YTDLP_FRAGMENTS) || 8, 1), 16);
        args.push('-N', String(frags));

        // 只要音频
        if (audioOnly) {
          args.push('-x', '--audio-format', 'mp3');
        } else if (format) {
          args.push('-f', format);
        } else {
          // 默认：最佳画质 + 最佳音质合并
          args.push('-f', 'bv*+ba/b');
        }

        if (referer) args.push('--referer', referer);
        if (cookie) args.push('--add-header', `Cookie:${cookie}`);

        // 新版 yt-dlp 需要 JS runtime 才能解 YouTube 的签名。
        // 自动探测本机的 node/deno/bun，找不到就明确提示，而不是让用户看一堆英文报错。
        const jsRuntime = findJsRuntime();
        if (jsRuntime) {
          args.push('--js-runtimes', jsRuntime);
        } else if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
          sendJson(res, 400, {
            error: 'yt-dlp 缺少 JS runtime，无法解析 YouTube 签名',
            detail:
              '新版 yt-dlp 需要 Node.js / Deno / Bun 之一来执行网页脚本。' +
              '本机未探测到，可在设置里安装 Node.js，或改用带 JS runtime 的 yt-dlp 版本。',
          });
          return;
        }

        args.push(targetUrl);

        const proc = spawn(toolConfig.ytdlpPath, args, { windowsHide: true });
        let stderr = '';
        let lastProgress = '';
        proc.stderr.on('data', (d) => {
          stderr += d.toString();
          if (stderr.length > 20000) stderr = stderr.slice(-20000);
        });
        proc.stdout.on('data', (d) => {
          const line = d.toString();
          // yt-dlp --newline 的进度行形如 "[download]  12.3% of ..."
          const m = line.match(/\[download\]\s+([\d.]+)%/);
          if (m && m[1] !== lastProgress) {
            lastProgress = m[1];
            if (process.env.NBC_DEBUG) {
              process.stderr.write(`[ytdlp] ${m[1]}%\n`);
            }
          }
        });
        const code = await new Promise((resolve) => {
          proc.on('error', (e) => resolve({ error: e.message }));
          proc.on('close', (c) => resolve({ code: c }));
        });
        if (code.error) {
          sendJson(res, 500, { error: `yt-dlp 启动失败: ${code.error}` });
          return;
        }
        if (code.code !== 0) {
          sendJson(res, 500, {
            error: `yt-dlp 退出码 ${code.code}`,
            detail: stderr.split('\n').filter(Boolean).slice(-6).join('\n'),
          });
          return;
        }
        // 报告实际产出的文件（yt-dlp 的 %(ext)s 是我们猜不出来的）
        let produced = [];
        try {
          produced = readdirSync(toolConfig.downloadDir)
            .filter((f) => f.startsWith(outName))
            .map((f) => {
              const full = pathJoin(toolConfig.downloadDir, f);
              let size = null;
              try { size = statSync(full).size; } catch { /* ignore */ }
              return { name: f, path: full, size };
            });
        } catch { /* ignore */ }
        sendJson(res, 200, {
          ok: true,
          dir: toolConfig.downloadDir,
          mode: 'yt-dlp',
          files: produced,
          count: produced.length,
        });
        return;
      }

      // 回退：原生 fetch
      try {
        const headers = {};
        if (referer) headers.Referer = referer;
        if (cookie) headers.Cookie = cookie;
        const upstream = await fetch(targetUrl, { headers, credentials: 'include' });
        if (!upstream.ok) {
          sendJson(res, 502, { error: `上游返回 ${upstream.status}` });
          return;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        const safe = (filename || urlBasename(targetUrl)).replace(/[\\/:*?"<>|]/g, '_');
        const outPath = pathJoin(toolConfig.downloadDir, safe);
        writeFileSync(outPath, buf);
        sendJson(res, 200, { ok: true, path: outPath, size: buf.length, mode: 'fetch' });
      } catch (e) {
        sendJson(res, 500, { error: e?.message || String(e) });
      }
      return;
    }

    // --- 桥：扩展回传结果 --------------------------------------------------
    if (url.pathname === '/bridge/result' && req.method === 'POST') {
      const body = await readJson(req);
      const entries = Array.isArray(body) ? body : [body];
      for (const e of entries) {
        if (e?.id) settle(e.id, e.result, e.error);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/bridge') {
    socket.destroy();
    return;
  }
  const conn = upgradeToWebSocket(req, socket, head);
  if (!conn) {
    socket.destroy();
    return;
  }
  wsConnections.add(conn);
  lastExtensionSeen = Date.now();
  if (process.env.NBC_DEBUG) process.stderr.write('[ws] 扩展已连接\n');

  conn.on('message', (text) => {
    lastExtensionSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // 扩展回传工具执行结果
    if (msg.type === 'result') {
      for (const r of msg.results || []) settle(r.id, r.result, r.error);
      return;
    }
    // 扩展主动发来的工具请求
    if (msg.type === 'request' && msg.tool) {
      enqueue(msg.tool, msg.args || {}).catch(() => {});
    }
  });

  conn.on('close', () => {
    wsConnections.delete(conn);
    if (process.env.NBC_DEBUG) process.stderr.write('[ws] 扩展已断开\n');
  });

  // 立刻把待执行命令推给它
  if (pending.length) {
    const cmd = pending.shift();
    conn.send(JSON.stringify({ type: 'command', id: cmd.id, tool: cmd.tool, args: cmd.args }));
  }
});


server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `端口 ${PORT} 已被占用。\n` +
      `请用 NBC_PORT=<其他端口> 启动，或先关闭占用该端口的进程。\n`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  process.stderr.write(
    `NetBrowserClaw companion 已启动：http://${HOST}:${PORT}\n` +
    `  · /proxy        反向代理（扩展用 'relay' 传输时走这里）\n` +
    `  · /bridge      WebSocket（扩展接收命令的通道）\n` +
    `  · /health       健康检查\n`
  );
  if (START_MCP) startMcpStdio();
});

// ---------------------------------------------------------------------------
// MCP（stdio）—— 把浏览器工具暴露给外部 MCP 客户端
// ---------------------------------------------------------------------------

/** MCP 客户端能调用的浏览器工具子集。 */
const MCP_TOOLS = [
  {
    name: 'browser_read_page',
    description: '读取当前浏览器活动页面的正文（Markdown 形式）。当需要了解用户正在看的网页内容时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: '目标标签页 ID，省略则为当前活动页' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取浏览器当前活动页面的可见区域截图。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_list_links',
    description: '列出页面中的链接，可按扩展名或关键词过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        ext: { type: 'string', description: '如 "pdf,mp4"' },
        contains: { type: 'string' },
        sameOrigin: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_find_media',
    description: '列出页面中已加载的媒体（视频、音频、图片）与网络请求 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_download',
    description: '批量下载资源文件（带登录态 Cookie）。',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
      },
      required: ['urls'],
    },
  },
  {
    name: 'browser_apply_style',
    description: '向页面注入 CSS 修改样式，或套用内置预设（dark/compact/readable/hideImages/wide）。',
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string', description: '自定义 CSS；与 preset 二选一' },
        preset: { type: 'string', description: 'dark|light|compact|readable|hideImages|wide' },
        scope: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_click',
    description: '点击页面元素（selector 或 index）。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        index: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_fill',
    description: '填写输入框。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        index: { type: 'integer' },
        value: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['value'],
    },
  },
  {
    name: 'browser_table_downloads',
    description:
      '采集表格单元格里的文档下载链接（PDF/Word/Excel），自动翻页累积全部页面，' +
      '并带出行标签与列标题。当页面是清单/报表类表格、每行每列都藏着文档链接时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        exts: { type: 'string', description: '扩展名列表，默认 "pdf,doc,docx,xls,xlsx,ppt,pptx,csv,zip"' },
        maxPages: { type: 'integer', description: '最多翻页数，默认 10' },
      },
    },
  },
  {
    name: 'browser_download_table',
    description:
      '批量下载表格里的所有文档（自动翻页收集），文件名按「行标签_列标题」命名。' +
      '这是「把这个清单页上的 PDF 全下载下来」的正确工具。',
    inputSchema: {
      type: 'object',
      properties: {
        exts: { type: 'string' },
        maxPages: { type: 'integer' },
        tabId: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_read_selection',
    description: '读取用户在当前页面上选中的文字（连同所在段落的上下文）。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'integer' } },
    },
  },
  {
    name: 'browser_save_site_style',
    description:
      '把当前页面已注入的样式规则按域名保存，之后访问该网站会自动应用同样的改版。' +
      '（例如让某个站点永久使用深色模式）',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'integer' } },
    },
  },
  {
    name: 'browser_list_site_styles',
    description: '列出已保存样式规则的站点，或清除当前站点的规则。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'clear'] },
        tabId: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_clip_export',
    description:
      '把当前页面选中的内容（或整篇文章）摘录保存为带 YAML frontmatter 的 Markdown 文件。' +
      '适用于把网页内容收集进 Obsidian / Logseq 一类的笔记系统。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['selection', 'article'], description: '默认 selection' },
        format: { type: 'string', enum: ['md', 'txt', 'article'] },
        note: { type: 'string', description: '可选附注' },
      },
    },
  },
  {
    name: 'browser_archive_page',
    description:
      '把整个页面归档成一个自包含的 HTML 文件（CSS/图片内联），离线双击即可打开。',
    inputSchema: {
      type: 'object',
      properties: {
        inlineImages: { type: 'boolean' },
        inlineCss: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_download_queue',
    description: '查看与管理下载队列（status / pause / resume / cancel / clear）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'pause', 'resume', 'cancel', 'clear'] },
      },
    },
  },
  {
    name: 'browser_export_chat',
    description: '把当前对话导出为 Markdown 文件。',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['md', 'txt'] } },
    },
  },
  {
    name: 'browser_download_page',
    description:
      '用 yt-dlp 下载网页里的视频/音频（YouTube、Bilibili 等）。' +
      '传页面链接。需要本地 companion 配置了 yt-dlp。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频页面链接' },
        filename: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_download_capabilities',
    description: '查询本地 companion 与 yt-dlp / ffmpeg 的可用状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_list_tabs',
    description: '列出所有打开的网页标签页。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_open_tab',
    description: '打开新的标签页。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
];

/** MCP 工具名 → 扩展内部工具名 + 参数映射。 */
const MCP_TO_DISPATCH = {
  browser_read_page: (a) => ['page.read', { tabId: a.tabId }],
  browser_screenshot: (a) => ['page.screenshot', { tabId: a.tabId }],
  browser_list_links: (a) => [
    'page.links',
    { tabId: a.tabId, filter: { ext: a.ext, contains: a.contains, sameOrigin: a.sameOrigin } },
  ],
  browser_find_media: (a) => ['media.list', { tabId: a.tabId }],
  browser_download: (a) => ['media.download', { urls: a.urls }],
  browser_apply_style: (a) =>
    a.preset ? ['style.preset', { preset: a.preset }] : ['style.apply', { css: a.css, scope: a.scope }],
  browser_click: (a) => ['page.click', { selector: a.selector, index: a.index }],
  browser_fill: (a) => ['page.fill', { selector: a.selector, index: a.index, value: a.value, submit: a.submit }],
  browser_table_downloads: (a) => ['table.docs', { exts: a.exts, maxPages: a.maxPages, tabId: a.tabId }],
  browser_download_table: (a) => ['table.download', { exts: a.exts, maxPages: a.maxPages, tabId: a.tabId }],
  browser_read_selection: (a) => ['page.selection', { tabId: a.tabId }],
  browser_save_site_style: (a) => ['style.save', { tabId: a.tabId }],
  browser_list_site_styles: (a) => ['style.rules', { action: a.action, tabId: a.tabId }],
  browser_clip_export: (a) => ['clip.export', { scope: a.scope, format: a.format, note: a.note }],
  browser_archive_page: (a) => ['page.archive', { inlineImages: a.inlineImages, inlineCss: a.inlineCss }],
  browser_download_queue: (a) => ['download.queue', { action: a.action }],
  browser_export_chat: (a) => ['chat.export', { format: a.format }],
  browser_download_page: (a) => ['media.downloadPage', { url: a.url, filename: a.filename }],
  browser_download_capabilities: () => ['media.capabilities', {}],
  browser_list_tabs: () => ['tab.list', {}],
  browser_open_tab: (a) => ['tab.open', { url: a.url }],
};

function startMcpStdio() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) handleMcpLine(line);
    }
  });

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  async function handleMcpLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;

    const reply = (result) => {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result });
    };
    const fail = (code, message) => {
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } });
    };

    try {
      switch (method) {
        case 'initialize':
          reply({
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'netbrowserclaw', version: '0.1.0' },
          });
          break;
        case 'notifications/initialized':
          break;
        case 'ping':
          reply({});
          break;
        case 'tools/list':
          reply({ tools: MCP_TOOLS });
          break;
        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments || {};
          const mapping = MCP_TO_DISPATCH[name];
          if (!mapping) {
            reply({
              content: [{ type: 'text', text: `未知工具: ${name}` }],
              isError: true,
            });
            break;
          }
          const [tool, toolArgs] = mapping(args);
          try {
            const result = await enqueue(tool, toolArgs);
            reply({
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            reply({
              content: [{ type: 'text', text: `执行失败: ${err.message}` }],
              isError: true,
            });
          }
          break;
        }
        default:
          fail(-32601, `未实现的方法: ${method}`);
      }
    } catch (err) {
      fail(-32603, err?.message || String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// 可选：本地 yt-dlp 增强下载（MCP 侧）
// ---------------------------------------------------------------------------

export function ytDlpAvailable() {
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// 长驻守护：不能让偶发错误把进程带崩。
//
// 实测的退出源：浏览器/SW 被回收时，companion 正在往已断开的 socket 写响应，
// 触发 EPIPE；以及未处理的 Promise 拒绝（Node 15+ 默认直接崩进程）。
// 这类错误都只记日志、继续服务 —— 宕机的代价（浏览器功能失联）远大于继续跑。
// ---------------------------------------------------------------------------

process.on('uncaughtException', (e) => {
  process.stderr.write(`[companion] 未捕获异常（已忽略，继续运行）：${e?.stack || e}\n`);
});

process.on('unhandledRejection', (e) => {
  process.stderr.write(`[companion] 未处理的 Promise 拒绝（已忽略）：${e?.stack || e}\n`);
});

// 客户端粗暴断开（SW 被回收、浏览器关闭）时不崩
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch { /* ignore */ }
});
