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
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = Number(process.env.NBC_PORT || 8787);
const HOST = '127.0.0.1';
const START_MCP = process.argv.includes('--mcp');

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
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  try {
    // --- 健康检查 ---------------------------------------------------------
    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        name: 'netbrowserclaw-companion',
        version: '0.1.0',
        extensionConnected: Date.now() - lastExtensionSeen < 10_000,
        pendingCommands: pending.length,
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
      // 短暂长轮询，最多 20 秒，减少空转。
      const timeout = setTimeout(() => {
        const idx = waiters.indexOf(handler);
        if (idx >= 0) waiters.splice(idx, 1);
        if (!res.writableEnded) sendJson(res, 200, { commands: [] });
      }, 20_000);
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
    `  · /bridge/poll  扩展轮询取命令\n` +
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
