// 桥接诊断：同时观察 companion 与扩展两侧，定位 MCP 桥接失败的原因。
// 用法：node scripts/diag-mcp-bridge.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const NBC_PORT = 8791;
const CDP = 9445;
const WEB = 8902;
const ROOT = 'C:/Users/laoya/Code/netbrowserclaw';

const comp = spawn('node', ['companion/server.mjs', '--mcp'], {
  cwd: ROOT,
  env: { ...process.env, NBC_PORT: String(NBC_PORT), NBC_DEBUG: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
comp.stderr.on('data', (d) => process.stderr.write('[comp] ' + d));

const prof = mkdtempSync(join(tmpdir(), 'nbc-diag-'));
const web = mkdtempSync(join(tmpdir(), 'nbc-diagweb-'));
mkdirSync(join(web, 'docs'), { recursive: true });
writeFileSync(
  join(web, 'p.html'),
  '<!doctype html><meta charset=utf-8><title>MCP 测试页</title><article><h1>标题</h1><a href=/docs/a.pdf>pdf</a></article>'
);
writeFileSync(join(web, 'docs', 'a.pdf'), '%PDF test');
const ws1 = spawn('python', ['-m', 'http.server', String(WEB), '--directory', web], { stdio: 'ignore' });
const edge = spawn(
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${prof}`,
    `--load-extension=${ROOT}/extension`,
    `--disable-extensions-except=${ROOT}/extension`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

await sleep(7000);
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('service-worker.js'));
if (!sw) {
  console.log('SW 未找到');
  process.exit(1);
}
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
await sleep(1200);

let mid = 10;
const ev = (expr) =>
  new Promise((resolve) => {
    ws.send(
      JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })
    );
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === mid) {
        ws.removeEventListener('message', h);
        resolve(d.result?.result?.value ?? 'EXC:' + (d.result?.exceptionDetails?.exception?.description || '?'));
      }
    };
    ws.addEventListener('message', h);
  });

// 写入 companionUrl（合并而不是覆盖）
console.log(
  '写入 companionUrl:',
  await ev(`chrome.storage.local.get('nbc:settings').then(cur=>chrome.storage.local.set({'nbc:settings':{...(cur['nbc:settings']||{}),companionUrl:'http://127.0.0.1:${NBC_PORT}'}}).then(()=>1))`)
);

for (let i = 0; i < 45; i++) {
  const h = await (await fetch(`http://127.0.0.1:${NBC_PORT}/health`)).json();
  if (h.extensionConnected) {
    console.log(`扩展已连接（第 ${i} 秒），wsConnections=${h.wsConnections}`);
    break;
  }
  if (i === 20) {
    // 中途从 SW 侧看一次配置与探活结果
    console.log(
      'SW 侧状态:',
      await ev(`(async()=>{
        const s = await chrome.storage.local.get('nbc:settings');
        const cfg = (s['nbc:settings']||{});
        const probe = async (u) => {
          try { const r = await fetch(u+'/health',{signal:AbortSignal.timeout(5000)}); const d = await r.json(); return d.name; }
          catch(e){ return 'ERR:'+e.name; }
        };
        return JSON.stringify({
          companionUrl: cfg.companionUrl, relayUrl: cfg.relayUrl,
          probe8791: await probe('http://127.0.0.1:8791'),
          probe8787: await probe('http://127.0.0.1:8787'),
        });
      })()`)
    );
  }
  await sleep(1000);
}

const h = await (await fetch(`http://127.0.0.1:${NBC_PORT}/health`)).json();
console.log('最终 health:', JSON.stringify(h));

for (const p of [edge, ws1, comp]) {
  try { p.kill(); } catch {}
}
process.exit(0);
