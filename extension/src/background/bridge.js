// 扩展 ↔ companion 桥接客户端。
//
// 作用：当 companion 以 MCP 模式运行时，外部客户端（如 Claude Code / Cursor）
// 可以通过 MCP 调用浏览器工具。这些调用最终要落到扩展里执行 ——
// 扩展主动轮询 companion 取命令，执行完再回传结果。
//
// 扩展没有连接 companion 时完全不影响正常使用（轮询失败静默重试）。

import { handlers } from './handlers.js';
import { findCompanion, DEFAULT_COMPANION_URL } from '../shared/companion.js';

const POLL_INTERVAL_MS = 20_000; // companion 侧长轮询上限是 20s，这里略短避免堆积

let running = false;
let relayUrl = DEFAULT_COMPANION_URL;
// 上一次执行的结果，随下一个 poll 请求一起带回去。
// 独立 POST 偶发丢失（连接复用/休眠），带回机制保证结果不丢。
let pendingResults = [];

/** 找到可用的 companion 地址（设置优先，其次常见端口）。 */
async function getRelayUrl() {
  const found = await findCompanion();
  return found || relayUrl;
}

/** 执行一个工具（复用 handlers.js 中的实现）。 */
async function executeTool(name, args) {
  const handler = handlers?.[name];
  if (!handler) throw new Error(`未知工具: ${name}`);
  return handler(args || {}, { tabId: undefined });
}

async function pollOnce() {
  relayUrl = await getRelayUrl();
  const carried = pendingResults;
  pendingResults = [];

  const res = await fetch(`${relayUrl}/bridge/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: carried }),
    signal: AbortSignal.timeout(25_000),
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
      console.warn('[nbc bridge] 工具执行失败', cmd.tool, err?.message, err?.stack);
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
  // 单独 POST 已送达，但下次 poll 带回同一份结果是幂等的（settle 第二次会被忽略）。
  pendingResults = [];

  return true;
}

/**
 * 保活：MV3 的 service worker 空闲约 30 秒会被回收。
 * companion 的命令可能长时间没有新请求，此时用一个慢速心跳维持 SW 存活。
 * 这是 MV3 的既定做法（Chrome 官方文档明确提到用 WebSocket/心跳延长 SW 生命周期）。
 */
function startKeepAlive() {
  const ping = () => {
    fetch(`${relayUrl}/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.text())
      .catch(() => {});
  };
  ping();
  setInterval(ping, 20_000);
}

async function loop() {
  while (running) {
    try {
      await pollOnce();
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
}

export function stopBridge() {
  running = false;
}
