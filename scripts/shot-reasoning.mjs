#!/usr/bin/env node
// 思考过程折叠区截图（人工检视用）。
// 用法：node scripts/shot-reasoning.mjs [--dark]
//
// 产物：docs/screenshot-reasoning.png

import { spawn } from 'node:child_process';
import { killTree, cleanupStrayTestBrowsers, cleanupStrayTestBrowsersAsync } from './_browser.mjs';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DARK = process.argv.includes('--dark');
const CDP = 9454;

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

const profile = mkdtempSync(join(tmpdir(), 'nbc-rs-'));
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
const cleanup = async () => {
  killTree(edge.pid);
  await cleanupStrayTestBrowsersAsync();
};
process.on('exit', () => { cleanupStrayTestBrowsers(); });

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

// 模拟一次带思维链的回复
await pc.evaluate(`(() => {
  const m = document.getElementById('messages');
  m.innerHTML = '';

  const user = document.createElement('div');
  user.className = 'msg user';
  user.innerHTML = '<div class="msg-role">你</div><div class="bubble">这个页面的排版太挤了，改成阅读模式</div>';
  m.appendChild(user);

  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = '<div class="msg-role">助手</div>';

  const box = document.createElement('details');
  box.className = 'reasoning-box';
  box.open = true;
  box.innerHTML = '<summary>思考过程</summary><div class="reasoning-body">' +
    '用户想调整排版。当前页面是文档详情页，主内容区宽度受限。' +
    '先看看有没有可用的样式预设 —— readable 预设会限制行宽并隐藏侧栏，' +
    '正好符合需求。\\n\\n另外还应该把字号调大一点。' +
    '</div>';
  wrap.appendChild(box);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '已经改好了：<br><br>· 应用了 <code>readable</code> 预设（限制行宽、隐藏侧栏）<br>' +
    '· 正文字号调整为 17px，行高 1.75<br><br>刷新后就能看到效果。要不要我再导出一份 Word？';
  wrap.appendChild(bubble);

  m.appendChild(wrap);
  return 'ok';
})()`);
await sleep(800);

const shot = await pc.send('Page.captureScreenshot', { format: 'png' });
const out = join(ROOT, 'docs', DARK ? 'screenshot-reasoning-dark.png' : 'screenshot-reasoning.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('截图已保存:', out);

await cleanup();
process.exit(0);
