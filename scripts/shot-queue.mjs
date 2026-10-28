#!/usr/bin/env node
// 下载队列面板截图（人工检视用）。
// 用法：node scripts/shot-queue.mjs [--dark]
//
// 产物：docs/screenshot-queue.png

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DARK = process.argv.includes('--dark');
const CDP = 9457;
const WEB = 8914;

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

const profile = mkdtempSync(join(tmpdir(), 'nbc-q-'));
const webRoot = mkdtempSync(join(tmpdir(), 'nbc-qweb-'));
// 造几个不同大小的文件，让下载有真实进度差异
for (const [name, size] of [['a.bin', 40000], ['b.bin', 90000], ['c.bin', 15000]]) {
  writeFileSync(join(webRoot, name), Buffer.alloc(size, 65));
}
const webServer = spawn('python', ['-m', 'http.server', String(WEB), '--directory', webRoot], {
  stdio: 'ignore',
});

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
await sleep(2500);

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
await sleep(1200);

// 加入一批下载任务
await pc.evaluate(`(async()=>{
  const urls = [];
  for (let i = 0; i < 5; i++) {
    urls.push({ url: 'http://127.0.0.1:${WEB}/' + ['a.bin','b.bin','c.bin'][i%3], filename: '项目报告_' + i + '.bin' });
  }
  const res = await chrome.runtime.sendMessage({
    type:'nbc:tool', name:'media.download', args:{ urls, queue:true }
  });
  return JSON.stringify(res);
})()`);
await sleep(1200);

const shot = await pc.send('Page.captureScreenshot', { format: 'png' });
const out = join(ROOT, 'docs', DARK ? 'screenshot-queue-dark.png' : 'screenshot-queue.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('截图已保存:', out);

cleanup();
process.exit(0);
