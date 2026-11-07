// 扩展 ↔ companion 桥接客户端。
//
// 作用：当 companion 以 MCP 模式运行时，外部客户端（如 Claude Code / Cursor）
// 可以通过 MCP 调用浏览器工具。这些调用最终要落到扩展里执行 ——
// 扩展主动轮询 companion 取命令，执行完再回传结果。
//
// 传输方式：HTTP 轮询（POST /bridge/poll）。
// 之前试过 WebSocket，但扩展的 Service Worker 里 WebSocket 连不上 127.0.0.1
// （fetch 可以，WebSocket 不行 —— 两者在本地网络访问策略上待遇不同），
// 所以保留实测可用的 HTTP 方案。
//
// 扩展没有连接 companion 时完全不影响正常使用（轮询失败静默重试）。

import { handlers } from './handlers.js';
import { findCompanion } from '../shared/companion.js';

const POLL_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY = 1500;
const KEEPALIVE_INTERVAL = 25_000;

let running = false;
let relayUrl = 'http://127.0.0.1:8787';
let reconnectTimer = null;
let keepAliveTimer = null;
// 上一次执行的结果，随下一个 poll 请求一起带回去。
// 独立 POST 偶发丢失（连接复用/休眠），带回机制保证结果不丢。
let pendingResults = [];
// Native Messaging 自动拉起只试一次：宿主未安装时反复尝试没有意义
let nativeStartTried = false;

/**
 * 找到可用的 companion 地址。
 *
 * 复用 shared/companion.js 的实现 —— 之前这里有一份重复代码，
 * 两处的探测超时/并行策略跑偏过一次（bridge 用 3000ms 误超时，
 * 而 SW 里本地请求需要 5000ms 才稳定）。
 * 共用一份就不会再分叉。
 */
async function findRelayUrl() {
  return findCompanion();
}

/** 执行一个工具（复用 handlers.js 中的实现）。 */
async function executeTool(name, args) {
  const handler = handlers?.[name];
  if (!handler) throw new Error(`未知工具: ${name}`);
  return handler(args || {}, { tabId: undefined });
}

async function pollOnce() {
  let found = await findRelayUrl();
  if (found) relayUrl = found;

  // 自愈：companion 不在时，通过 Native Messaging 静默拉起一次。
  // 宿主未安装会拿到「未安装」的指引，只在日志里记一次，不再重复尝试。
  if (!found && !nativeStartTried) {
    nativeStartTried = true;
    try {
      const { startCompanionViaNative } = await import('./native-host.js');
      const r = await startCompanionViaNative();
      if (r.ok) {
        console.log('[nbc bridge] companion 已通过 Native Messaging 拉起');
        nativeStartTried = false; // 拉起成功后重置：之后 companion 再挂还能自动拉
        found = await findRelayUrl();
        if (found) relayUrl = found;
      } else {
        console.log('[nbc bridge] 未自动拉起 companion：', r.error || '');
      }
    } catch (e) {
      console.log('[nbc bridge] Native 拉起失败：', e?.message || e);
    }
  }

  const carried = pendingResults;
  pendingResults = [];

  const res = await fetch(`${relayUrl}/bridge/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: carried }),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000),
  }).catch(() => null);

  if (!res || !res.ok) {
    // 请求失败：结果不能丢，放回队列下次再带。
    pendingResults = carried.concat(pendingResults);
    return false;
  }

  const data = await res.json().catch(() => null);
  if (!data?.commands?.length) return true;

  const results = [];
  for (const cmd of data.commands) {
    console.log('[nbc bridge] 收到命令', cmd.tool, JSON.stringify(cmd.args));
    try {
      const result = await executeTool(cmd.tool, cmd.args);
      console.log('[nbc bridge] 命令完成', cmd.tool);
      results.push({ id: cmd.id, result });
    } catch (err) {
      console.warn('[nbc bridge] 工具执行失败', cmd.tool, err?.message);
      results.push({ id: cmd.id, error: err?.message || String(err) });
    }
  }

  // 结果既随下一次 poll 带回，也立即单独 POST —— 双保险。
  pendingResults = results;
  await fetch(`${relayUrl}/bridge/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  }).catch(() => null);
  pendingResults = [];

  return true;
}

/** 断开后重连。 */
function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!running) return;
    pollOnce().catch(() => {});
  }, RECONNECT_DELAY);
}

/**
 * 保活：MV3 的 service worker 空闲约 30 秒会被回收。
 * companion 的命令可能长时间没有新请求，此时用一个慢速心跳维持 SW 存活。
 */
function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    fetch(`${relayUrl}/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.text())
      .catch(() => {});
  }, KEEPALIVE_INTERVAL);
}

async function loop() {
  while (running) {
    try {
      const ok = await pollOnce();
      if (!ok) scheduleReconnect();
    } catch {
      // companion 未启动是正常情况，静默等待。
    }
    // 长轮询本身已阻塞约 20s，这里再等一小段，避免高频打点。
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function startBridge() {
  if (running) return;
  running = true;
  loop();
  startKeepAlive();
}

export function stopBridge() {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  pendingResults = [];
}
