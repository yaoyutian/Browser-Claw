#!/usr/bin/env node
// 设置面板截图工具：按真实侧边栏宽度渲染，便于人工检视。
// 用法：node scripts/shot-settings.mjs [--dark]
//
// 产物：docs/screenshot-settings.png

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DARK = process.argv.includes('--dark');
const CDP = 9449;

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

const profile = mkdtempSync(join(tmpdir(), 'nbc-set-'));
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
  width: 400, height: 900, deviceScaleFactor: 2, mobile: false,
});
if (DARK) {
  await pc.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
}
await sleep(2000);

// 打开设置并填入示例路径
await pc.send('Runtime.evaluate', {
  expression: `(async () => {
    document.getElementById('btn-settings').click();
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('inp-ffmpeg').value = 'C:\\\\commontools\\\\ffmpeg-master-latest-win64-gpl\\\\bin\\\\ffmpeg.exe';
    document.getElementById('inp-ytdlp').value = 'C:\\\\tools\\\\yt-dlp.exe';
    document.getElementById('inp-dl-dir').value = 'C:\\\\Users\\\\laoya\\\\Downloads';
    document.getElementById('ffmpeg-status').textContent = '✓ 可用：ffmpeg version N-117623';
    document.getElementById('ffmpeg-status').style.color = 'var(--ok)';
    document.getElementById('ytdlp-status').textContent = '✗ 不可用：文件不存在';
    document.getElementById('ytdlp-status').style.color = 'var(--err)';
    document.getElementById('dl-dir-status').textContent = '✓ C:\\\\Users\\\\laoya\\\\Downloads';
    document.getElementById('dl-dir-status').style.color = 'var(--ok)';
    document.getElementById('settings').scrollTop = 9999;
    return 'ok';
  })()`,
  awaitPromise: true,
});
await sleep(800);

const shot = await pc.send('Page.captureScreenshot', { format: 'png' });
const out = join(ROOT, 'docs', DARK ? 'screenshot-settings-dark.png' : 'screenshot-settings.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('截图已保存:', out);

cleanup();
process.exit(0);
