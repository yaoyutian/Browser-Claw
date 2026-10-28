#!/usr/bin/env node
// 侧边栏划词提示条截图（用于人工检视）。
// 用法：node scripts/shot-selection.mjs [--dark]
//
// 产物：docs/screenshot-selection.png

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DARK = process.argv.includes('--dark');
const CDP = 9450;
const WEB = 8907;

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

const profile = mkdtempSync(join(tmpdir(), 'nbc-sel-'));
const webRoot = mkdtempSync(join(tmpdir(), 'nbc-selweb-'));
writeFileSync(
  join(webRoot, 'art.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>文章</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;line-height:1.9">
<h1>浏览器扩展与自动化</h1>
<p>Manifest V3 引入了基于 Service Worker 的后台模型，扩展的权限模型也更加严格。
内容脚本运行在隔离世界，无法直接访问页面的 JavaScript 变量。</p>
</body></html>`
);
const webServer = spawn('python', ['-m', 'http.server', String(WEB), '--directory', webRoot], { stdio: 'ignore' });

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
  for (const p of [edge, webServer]) { try { p.kill('SIGKILL'); } catch {} }
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, ready, evaluate };
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
await swc.send('Runtime.evaluate', {
  expression: `chrome.tabs.create({url:'http://127.0.0.1:${WEB}/art.html'}).then(t=>t.id)`,
  awaitPromise: true,
});
await sleep(3000);

const l2 = await httpJson('/json/list');
const panelTarget = l2.find((t) => t.url.includes('/src/sidepanel/panel.html'));
const pc = conn(panelTarget.webSocketDebuggerUrl);
await pc.ready;
await pc.send('Runtime.enable');
await pc.send('Emulation.setDeviceMetricsOverride', {
  width: 400, height: 820, deviceScaleFactor: 2, mobile: false,
});
if (DARK) {
  await pc.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
}
await sleep(1500);

// 在文章页做一次真实选区
const artTarget = (await httpJson('/json/list')).find(
  (t) => t.type === 'page' && t.url.includes('art.html')
);
const ac = conn(artTarget.webSocketDebuggerUrl);
await ac.ready;
await ac.send('Runtime.enable');
// 等页面渲染
await ac.evaluate(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.querySelectorAll('p').length > 0) break;
    await new Promise(r => setTimeout(r, 150));
  }
  return 'ready';
})()`);

// 用真实鼠标拖拽做划词 —— CDP 的 Input 事件会进入页面的真实输入管线，
// 产生的选区对 MAIN world 可见（Runtime.evaluate 建立的选区只属于调试上下文）。
const box = await ac.evaluate(`(() => {
  const ps = document.querySelectorAll('p');
  const p = ps[ps.length - 1];
  if (!p) return 'null';
  const r = p.getBoundingClientRect();
  return JSON.stringify({x1: r.left + 2, y1: r.top + r.height/2 - 2, x2: r.right - 2, y2: r.top + r.height/2 + 2});
})()`);
if (box === 'null') { console.error('页面没有可划词的段落'); process.exit(1); }
const b = JSON.parse(box);
await ac.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x1, y: b.y1, button: 'left', clickCount: 1 });
await ac.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x2, y: b.y2, button: 'left', buttons: 1 });
await ac.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x2, y: b.y2, button: 'left', clickCount: 1 });
// 等 selectionchange 触发并被探针捕获
await sleep(1500);

// 侧边栏（面板页面上下文，真实路径）通过 page.selection 工具查询当前选区
const panelState = await pc.evaluate(`(async()=>{
  const tabs = await chrome.tabs.query({url:'http://127.0.0.1:${WEB}/*'});
  if(!tabs.length) return 'no-tab';
  const res = await chrome.runtime.sendMessage({
    type:'nbc:tool', name:'page.selection', args:{tabId: tabs[tabs.length-1].id}
  });
  if(res?.ok && res.data?.text){
    document.getElementById('selection-text').textContent = res.data.text;
    document.getElementById('selection-bar').hidden = false;
    return 'ok:'+res.data.text.slice(0,50);
  }
  return 'no-selection:'+JSON.stringify(res).slice(0,80);
})()`);
console.log('侧边栏获取选区:', panelState);
await sleep(500);

const shot = await pc.send('Page.captureScreenshot', { format: 'png' });
const out = join(ROOT, 'docs', DARK ? 'screenshot-selection-dark.png' : 'screenshot-selection.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('截图已保存:', out);

cleanup();
process.exit(0);
