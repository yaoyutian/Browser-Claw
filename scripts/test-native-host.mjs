#!/usr/bin/env node
// Native Messaging 宿主冒烟测试：
// 模拟浏览器的 4 字节长度前缀协议喂一条消息，验证宿主拉起 companion 并回 ready。
// 用法：node scripts/test-native-host.mjs

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 注意：不能用 taskkill /IM node.exe 清场 —— 那会把本测试自己的 node 进程
// 也杀掉（血淋淋的教训）。宿主自己会探测已运行的 companion 并报告
// alreadyRunning，无需清场。

const host = spawn(
  process.execPath,
  [join(ROOT, 'companion', 'native-host.mjs')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
);

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

let buf = Buffer.alloc(0);
let done = false;

host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  const payload = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  done = true;
  console.log('宿主回复:', JSON.stringify(payload));
  console.log(payload.started ? '✓ companion 被拉起' : payload.alreadyRunning ? '✓ companion 已在运行' : '✗ 未拉起');
  // 验证 health
  fetch('http://127.0.0.1:8787/health')
    .then((r) => r.json())
    .then((h) => {
      console.log('companion health:', h.name, '| extensionConnected:', h.extensionConnected);
      const ok = h.name === 'netbrowserclaw-companion';
      console.log(ok ? '\n冒烟测试通过' : '\n冒烟测试失败');
      host.kill();
      process.exit(ok ? 0 : 1);
    });
});

host.on('error', (e) => {
  console.log('宿主启动失败:', e.message);
  process.exit(1);
});

// 模拟浏览器发来一条消息（宿主不要求内容，任意帧都触发拉起）
host.stdin.write(frame({ type: 'ping' }));

setTimeout(() => {
  if (!done) {
    console.log('✗ 超时未收到宿主回复');
    host.kill();
    process.exit(1);
  }
}, 25000);
