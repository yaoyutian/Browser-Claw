#!/usr/bin/env node
// Native Messaging 宿主：浏览器按需拉起 companion。
//
// 原理：Chrome/Edge 允许扩展通过 chrome.runtime.connectNative 启动一个
// 本地宿主进程（需一次性注册）。这解决了两个问题：
//   1. companion 不用手动启动 —— 打开浏览器它自动起来；
//   2. 扩展检测到 companion 未运行时，界面上点「启动」就能拉起它
//      （扩展自己无法启动本地进程，这是浏览器允许的唯一通道）。
//
// 本宿主是「一次性拉起器」：确保 companion 在跑（没跑就启动 detached
// 子进程），回一条 ready 消息给浏览器，然后退出。
// companion 以 detached 方式存活，浏览器关闭后它继续保留 ——
// 如果不想要这个行为，关掉它即可（taskkill /PID 或直接关机）。
//
// 协议（Native Messaging 标准）：stdin/stdout 上 4 字节小端长度前缀 + UTF-8 JSON。

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NBC_PORT || 8787);

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(len);
  process.stdout.write(body);
}

async function isUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const d = await r.json();
    return d?.name === 'netbrowserclaw-companion';
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isUp()) return { started: false, alreadyRunning: true, port: PORT };

  const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    detached: true, // 浏览器关闭后 companion 继续存活
    stdio: 'ignore',
    env: { ...process.env, NBC_PORT: String(PORT) },
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isUp()) return { started: true, port: PORT, pid: child.pid };
  }
  return { started: false, error: `companion 启动超时（端口 ${PORT}）` };
}

(async () => {
  const result = await ensureServer();
  try {
    send({ type: 'ready', ...result });
  } catch { /* 浏览器已断开 */ }
  // 给浏览器的断开事件留一点时间，然后退出。
  setTimeout(() => process.exit(result.error ? 1 : 0), 300);
})();

// 浏览器断开 stdin（端口关闭/浏览器退出）→ 宿主退出。
// 注意：不杀 server 子进程 —— 它是 detached 的，继续为扩展服务。
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
