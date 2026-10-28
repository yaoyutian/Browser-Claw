// 对话历史暂存。
//
// 对话的主体在**侧边栏页面**的内存里（Agent 循环跑在那儿）。
// 但导出功能是后台工具（chat.export），需要能拿到历史。
// 所以侧边栏每次对话结束后把消息同步一份到这里。
//
// 存在 chrome.storage.session：SW 重启不丢，浏览器关闭即清（隐私考虑）。

const STORAGE_KEY = 'nbc:chatHistory';
const MAX_MESSAGES = 200;

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    cache = stored[STORAGE_KEY] || { messages: [], meta: {} };
  } catch {
    cache = { messages: [], meta: {} };
  }
  return cache;
}

async function save(data) {
  cache = data;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: data });
  } catch { /* 忽略 */ }
}

/** 侧边栏同步对话历史过来。 */
export async function setHistory(messages, meta = {}) {
  const data = await load();
  data.messages = (messages || []).slice(-MAX_MESSAGES);
  data.meta = { ...data.meta, ...meta, updatedAt: Date.now() };
  await save(data);
  return { count: data.messages.length };
}

/** 读取对话历史。 */
export async function getHistory() {
  const data = await load();
  return { messages: data.messages || [], meta: data.meta || {} };
}

/** 清空对话历史。 */
export async function clearHistory() {
  await save({ messages: [], meta: {} });
  return { ok: true };
}
