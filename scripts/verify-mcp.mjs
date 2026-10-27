#!/usr/bin/env node
// 验证 companion 的 MCP 能力与扩展的联动：
//   MCP 客户端 → companion(stdio) → bridge → 扩展 service worker → 真实浏览器
//
// 用法：node scripts/verify-mcp.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXT = join(ROOT, 'extension');
const CDP_PORT = 9445;
const WEB_PORT = 8902;
const NBC_PORT = 8788;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('未找到浏览器');
  process.exit(1);
}

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const profile = mkdtempSync(join(tmpdir(), 'nbc-mcp-'));
const webRoot = mkdtempSync(join(tmpdir(), 'nbc-mcpweb-'));
writeFileSync(
  join(webRoot, 'p.html'),
  `<!doctype html><meta charset="utf-8"><title>MCP 测试页</title>
<article><h1>MCP 联动测试</h1><p>这段文字用于验证 MCP 能否读到真实页面内容。</p>
<a href="/x.pdf">报告 PDF</a></article>
<table><thead><tr><th>项目</th><th>文件</th></tr></thead>
<tbody><tr><td>华东区</td><td><a href="/docs/a.pdf" download>下载</a></td></tr>
<tr><td>华南区</td><td><a href="/docs/b.pdf" download>下载</a></td></tr></tbody></table>`
);
mkdirSync(join(webRoot, 'docs'), { recursive: true });
writeFileSync(join(webRoot, 'docs', 'a.pdf'), Buffer.from('%PDF-1.4\n% mcp a\n', 'latin1'));
writeFileSync(join(webRoot, 'docs', 'b.pdf'), Buffer.from('%PDF-1.4\n% mcp b\n', 'latin1'));
const webServer = spawn('python', ['-m', 'http.server', String(WEB_PORT), '--directory', webRoot], { stdio: 'ignore' });
/** 探测本机 ffmpeg（用于验证本地工具配置链路）。 */
function findFfmpeg() {
  if (process.env.NBC_TEST_FFMPEG) return process.env.NBC_TEST_FFMPEG;
  for (const p of [
    'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    // 常见的绿色版安装位置
    'C:/commontools/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe',
    'C:/ffmpeg/bin/ffmpeg.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  // 借助 PATH
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', shell: true });
  if (r.status === 0) return 'ffmpeg';
  return '';
}

const FFMPEG = findFfmpeg();

const browserProc = spawn(browser, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const companion = spawn('node', [join(ROOT, 'companion', 'server.mjs'), '--mcp'], {
  env: { ...process.env, NBC_PORT: String(NBC_PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
companion.stderr.on('data', (d) => process.stderr.write('[companion] ' + d));

const cleanup = () => {
  for (const p of [browserProc, webServer, companion]) { try { p.kill('SIGKILL'); } catch {} }
  for (const d of [profile, webRoot]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);

const httpJson = async (p) => (await fetch(`http://127.0.0.1:${CDP_PORT}${p}`)).json();

/**
 * 等待目标执行上下文就绪（能访问 chrome.* API）。
 * Service Worker / 页面在 CDP attach 后需要一点时间才可求值。
 */
async function waitForChromeApi(conn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const ok = await conn
      .evaluate(`typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined'`)
      .catch(() => false);
    if (ok === true) return true;
    await sleep(250);
  }
  return false;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, ready, evaluate };
}

// MCP stdio 客户端
let mcpBuf = '';
const mcpWaiters = new Map();
companion.stdout.on('data', (d) => {
  mcpBuf += d.toString();
  let i;
  while ((i = mcpBuf.indexOf('\n')) >= 0) {
    const line = mcpBuf.slice(0, i).trim(); mcpBuf = mcpBuf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const w = mcpWaiters.get(m.id); if (w) { mcpWaiters.delete(m.id); w(m); }
  }
});
const rpc = (method, params) => new Promise((res) => {
  const id = Math.floor(Math.random() * 1e6);
  mcpWaiters.set(id, res);
  companion.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

// 测试依赖 Edge 持续运行；若中途被关闭，后续断言会莫名失败。
let browserAlive = true;
let aliveCheck = null;

function startAliveCheck() {
  aliveCheck = setInterval(() => {
    httpJson('/json/list')
      .then(() => { browserAlive = true; })
      .catch(() => { browserAlive = false; });
  }, 2000);
}

async function main() {
  startAliveCheck();

  // 1. MCP 协议握手
  console.log('\n[1] MCP 协议');
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' },
  });
  check('initialize 成功', Boolean(init.result?.serverInfo?.name === 'netbrowserclaw'),
    init.result?.serverInfo?.name);

  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  check('tools/list 返回工具', names.length >= 8, `${names.length} 个`);
  check('包含 browser_read_page', names.includes('browser_read_page'));
  check('包含 browser_apply_style', names.includes('browser_apply_style'));
  check('包含 browser_download', names.includes('browser_download'));

  // 2. 启动浏览器并打开页面
  console.log('\n[2] 浏览器与扩展');
  let swTarget = null;
  for (let i = 0; i < 60 && !swTarget; i++) {
    try {
      const list = await httpJson('/json/list');
      // 精确匹配本扩展的 service worker。
      // Edge 可能同时开着其他扩展的 worker，必须用路径精确匹配，
      // 否则会连到别的扩展的 target 上（表现为 "chrome is not defined"）。
      swTarget = list.find(
        (t) =>
          t.type === 'service_worker' &&
          t.url.includes('/src/background/service-worker.js') &&
          t.url.startsWith('chrome-extension://')
      );
    } catch {}
    if (!swTarget) await sleep(500);
  }
  check('扩展已加载', Boolean(swTarget), swTarget?.url || '');
  if (!swTarget) return;

  const sw = connect(swTarget.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send('Runtime.enable');
  // Service Worker 的执行上下文在 attach 后需要一点时间才可求值，
  // 否则 Runtime.evaluate 会报 "chrome is not defined"。
  await waitForChromeApi(sw);
  await sw.evaluate(`chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/p.html'}).then(t=>t.id)`);
  await sleep(2500);

  // 3. 扩展连接 companion（bridge 轮询）
  console.log('\n[3] 扩展 ↔ companion 桥接');
  let connected = false;
  for (let i = 0; i < 30 && !connected; i++) {
    const h = await (await fetch(`http://127.0.0.1:${NBC_PORT}/health`)).json();
    connected = h.extensionConnected;
    if (!connected) await sleep(1000);
  }
  check('扩展已连上 companion', connected);

  // 4. MCP → 桥 → 扩展 → 浏览器 真实执行
  console.log('\n[4] MCP 调用真实浏览器');
  const read = await rpc('tools/call', { name: 'browser_read_page', arguments: {} });
  const readText = read.result?.content?.[0]?.text || '';
  check('browser_read_page 执行成功', read.result?.isError !== true, readText.slice(0, 70));
  check('读到了真实页面标题', readText.includes('MCP 测试页'));

  const links = await rpc('tools/call', { name: 'browser_list_links', arguments: { ext: 'pdf' } });
  const linkText = links.result?.content?.[0]?.text || '';
  check('browser_list_links 找到 PDF 链接', linkText.includes('x.pdf'));

  const style = await rpc('tools/call', { name: 'browser_apply_style', arguments: { preset: 'dark' } });
  check('browser_apply_style 执行成功', style.result?.isError !== true, (style.result?.content?.[0]?.text || '').slice(0, 70));

  const tabs = await rpc('tools/call', { name: 'browser_list_tabs', arguments: {} });
  const tabText = tabs.result?.content?.[0]?.text || '';
  check('browser_list_tabs 返回标签页', tabText.includes('p.html'));

  const bad = await rpc('tools/call', { name: 'browser_read_page', arguments: { tabId: 999999 } });
  check('无效 tabId 返回错误而非崩溃', bad.result?.isError === true, (bad.result?.content?.[0]?.text || '').slice(0, 60));

  const unknown = await rpc('tools/call', { name: 'nonexistent_tool', arguments: {} });
  check('未知工具返回错误', unknown.result?.isError === true);

  // 5. 表格文档批量下载（经 MCP）
  console.log('\n[5] MCP 表格批量下载');
  const tableDocs = await rpc('tools/call', { name: 'browser_table_downloads', arguments: { exts: 'pdf' } });
  const tableText = tableDocs.result?.content?.[0]?.text || '';
  check('browser_table_downloads 执行成功', tableDocs.result?.isError !== true, tableText.slice(0, 60));
  check('采集到表格里的 PDF', tableText.includes('rowLabel') && tableText.includes('colHeader'));

  // 6. 本地工具配置（ffmpeg 路径）
  console.log('\n[6] companion 本地工具配置');
  const cfg = await (
    await fetch(`http://127.0.0.1:${NBC_PORT}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ffmpegPath: FFMPEG,
        downloadDir: webRoot,
      }),
    })
  ).json();
  check('配置接口返回成功', cfg.ok === true, cfg.error || '');
  check(
    'ffmpeg 路径检测结果已返回',
    typeof cfg.config?.ffmpegDetected?.ok === 'boolean',
    JSON.stringify(cfg.config?.ffmpegDetected)
  );
  if (process.env.NBC_TEST_FFMPEG) {
    check('检测到可用的 ffmpeg', cfg.config?.ffmpegDetected?.ok === true, cfg.config?.ffmpegDetected?.version);
  }

  // 7. HLS 合并（扩展 → companion → ffmpeg）
  console.log('\n[7] HLS 流合并（ffmpeg）');
  if (FFMPEG) {
    // 造一个真实的 HLS：3 个 TS 分片 + m3u8 清单
    const segDir = join(webRoot, 'hls');
    mkdirSync(segDir, { recursive: true });
    const made = spawnSync(
      FFMPEG,
      [
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
        '-c:v', 'libx264', '-g', '15', '-f', 'segment', '-segment_time', '1',
        '-segment_format', 'mpegts', join(segDir, 'seg%03d.ts'), '-y',
      ],
      { encoding: 'utf8' }
    );
    const segs = existsSync(join(segDir, 'seg001.ts'))
      ? ['seg000.ts', 'seg001.ts', 'seg002.ts']
      : [];
    if (segs.length) {
      writeFileSync(
        join(segDir, 'playlist.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' +
          segs.map((s) => `#EXTINF:1.0,\n${s}`).join('\n') +
          '\n#EXT-X-ENDLIST\n'
      );
      const hls = await (
        await fetch(`http://127.0.0.1:${NBC_PORT}/hls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: `http://127.0.0.1:${WEB_PORT}/hls/playlist.m3u8`,
            filename: 'nbc-hls-verify',
          }),
        })
      ).json();
      check('HLS 合并成功', hls.ok === true, hls.error || hls.detail?.slice(0, 120));
      check('产物已生成', existsSync(hls.path || ''), hls.path || '');
      if (hls.ok && existsSync(hls.path)) {
        const size = statSync(hls.path).size;
        check('产物非空', size > 1000, `${size} 字节`);
        const probe = spawnSync(FFMPEG, ['-i', hls.path], { encoding: 'utf8' });
        check('ffprobe 可解析产物', /Duration: 00:00:0[23]/.test(probe.stderr || ''),
          (probe.stderr || '').match(/Duration: [0-9:.]+/)?.[0] || '');
      }
    } else {
      check('生成测试用 HLS 分片', false, made.stderr?.slice(0, 120) || 'ffmpeg 未产出分片');
    }
  } else {
    console.log('  (跳过：本机未找到 ffmpeg)');
  }

  // 7. proxy
  console.log('\n[7] companion 反向代理');
  const proxied = await fetch(`http://127.0.0.1:${NBC_PORT}/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: `http://127.0.0.1:${WEB_PORT}/p.html`, method: 'GET' }),
  });
  const proxiedText = await proxied.text();
  check('代理转发成功', proxiedText.includes('MCP 测试页'));
}

main()
  .catch((e) => { console.error('出错：', e); fail++; })
  .finally(async () => {
    if (aliveCheck) clearInterval(aliveCheck);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`结果：${pass} 项通过，${fail} 项失败`);
    if (failures.length) {
      failures.forEach((f) => console.log('  ✗ ' + f));
      if (!browserAlive) {
        console.log(
          '\n⚠ 注意：测试期间浏览器已断开（可能窗口被手动关闭）。' +
            '这种失败属于环境中断，不代表功能有问题，请重新运行。'
        );
      }
    }
    await sleep(300);
    cleanup();
    process.exit(fail ? 1 : 0);
  });
