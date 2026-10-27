#!/usr/bin/env node
// 侧边栏 UI 截图工具：按真实侧边栏宽度渲染，便于人工检视视觉效果。
// 用法：node scripts/shot-panel.mjs [--dark]
//
// 产物：docs/screenshot-panel.png

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DARK = process.argv.includes('--dark');
const CDP = 9448;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error('未找到浏览器');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nbc-shot-'));
const edge = spawn(
  browser,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${join(ROOT, 'extension')}`,
    `--disable-extensions-except=${join(ROOT, 'extension')}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const cleanup = () => {
  try { edge.kill('SIGKILL'); } catch {}
  try { (globalThis).__rm?.(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

function conn(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send, ready };
}

const httpJson = async (p) => (await fetch(`http://127.0.0.1:${CDP}${p}`)).json();

await sleep(6000);
const list = await httpJson('/json/list');
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('service-worker.js'));
if (!sw) {
  console.error('扩展未加载');
  process.exit(1);
}
const extId = new URL(sw.url).host;

const swc = conn(sw.webSocketDebuggerUrl);
await swc.ready;
await swc.send('Runtime.enable');
await swc.send('Runtime.evaluate', {
  expression: `chrome.tabs.create({url:'chrome-extension://${extId}/src/sidepanel/panel.html'}).then(t=>t.id)`,
  awaitPromise: true,
});
await sleep(2500);

const l2 = await httpJson('/json/list');
const panelTarget = l2.find((t) => t.url.includes('/src/sidepanel/panel.html'));
const pc = conn(panelTarget.webSocketDebuggerUrl);
await pc.ready;
await pc.send('Runtime.enable');

// 按真实侧边栏宽度渲染
await pc.send('Emulation.setDeviceMetricsOverride', {
  width: 400,
  height: 820,
  deviceScaleFactor: 2,
  mobile: false,
});
if (DARK) {
  await pc.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
}
await sleep(600);

// 等 panel.js 初始化完成，再注入示例对话
await sleep(1500);
await pc.send('Runtime.evaluate', {
  expression: `(async () => {
    const m = document.getElementById('messages');
    m.innerHTML = '';
    const mk = (role, html) => {
      const d = document.createElement('div');
      d.className = 'msg ' + role;
      const r = document.createElement('div');
      r.className = 'msg-role';
      r.textContent = role === 'user' ? '你' : '助手';
      const b = document.createElement('div');
      b.className = 'bubble';
      b.innerHTML = html;
      d.append(r, b);
      m.append(d);
    };
    mk('user', '这个页面的排版太挤了，改成阅读模式，再把字号调大一点');
    const card = document.createElement('div');
    card.className = 'tool-card open';
    card.innerHTML =
      '<div class="tool-head"><span class="tool-icon">⚙</span>' +
      '<span class="tool-name">style.preset</span>' +
      '<span class="tool-status ok">完成</span></div>' +
      '<div class="tool-body">' +
      '<div class="tool-section"><h4>入参</h4><pre>{\\n  "preset": "readable"\\n}</pre></div>' +
      '<div class="tool-section"><h4>结果</h4><pre>{\\n  "ok": true,\\n  "applied": "readable"\\n}</pre></div>' +
      '</div>';
    m.append(card);
    mk('assistant', '已经改好了：<br><br>· 应用了 <code>readable</code> 预设（限制行宽、隐藏侧栏）<br>· 正文字号调整为 17px，行高 1.75<br><br>刷新后就能看到效果。要不要我再导出一份 Word？');
    return 'ok';
  })()`,
  awaitPromise: true,
});
await sleep(800);

const shot = await pc.send('Page.captureScreenshot', { format: 'png' });
const out = join(ROOT, 'docs', DARK ? 'screenshot-panel-dark.png' : 'screenshot-panel.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('截图已保存:', out);

cleanup();
process.exit(0);
