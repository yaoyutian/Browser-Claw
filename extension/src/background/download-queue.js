// 下载队列：持久化的任务队列 + 实时进度。
//
// 为什么需要队列（而不是直接批量下载）：
//   1. 大批量下载（几百个文件）可能跨越很长时间，MV3 的 service worker
//      随时会被回收 —— 队列状态必须落盘，SW 重启后能接着跑。
//   2. 用户需要看到「还剩几个、当前在下载哪个、失败了几���」。
//   3. 需要能暂停 / 取消。
//
// 状态存储：chrome.storage.session（SW 重启不丢，浏览器关闭即清）。
// 实际下载进度：chrome.downloads 的 onChanged 事件（浏览器权威数据）。

const STORAGE_KEY = 'nbc:downloadQueue';
const MAX_ITEMS = 2000;

/** 队列状态。内存里有一份副本，减少 storage 读写。 */
let queue = {
  items: [],
  running: false,
  paused: false,
  updatedAt: 0,
};

let loaded = false;
let persistTimer = null;
const listeners = new Set();

/** 载入持久化状态。 */
async function ensureLoaded() {
  if (loaded) return queue;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    queue = stored[STORAGE_KEY] || queue;
  } catch {
    // storage.session 不可用时退回内存
  }
  loaded = true;
  return queue;
}

/** 持久化（合并写入，避免频繁 IO）。 */
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: queue });
    } catch { /* 忽略 */ }
  }, 150);
}

/** 广播状态变化给侧边栏。 */
function broadcast() {
  persist();
  for (const fn of listeners) {
    try {
      fn(snapshot());
    } catch { /* ignore */ }
  }
  chrome.runtime.sendMessage({ type: 'nbc:queue:update', queue: snapshot() }).catch(() => {});
}

/** 对外暴露的状态快照（去掉内部字段）。 */
export function snapshot() {
  const items = queue.items || [];
  return {
    running: queue.running,
    paused: queue.paused,
    total: items.length,
    pending: items.filter((i) => i.status === 'pending').length,
    running_: items.filter((i) => i.status === 'running').length,
    done: items.filter((i) => i.status === 'done').length,
    failed: items.filter((i) => i.status === 'failed').length,
    cancelled: items.filter((i) => i.status === 'cancelled').length,
    bytes: items.reduce((a, i) => a + (i.bytes || 0), 0),
    updatedAt: queue.updatedAt,
    items: items.slice(-200).map((i) => ({
      id: i.id,
      url: i.url,
      filename: i.filename,
      status: i.status,
      bytes: i.bytes,
      totalBytes: i.totalBytes,
      error: i.error,
      downloadId: i.downloadId,
    })),
  };
}

/** 监听状态变化。 */
export function onQueueUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 添加任务。 */
export async function enqueue(items) {
  await ensureLoaded();
  const now = Date.now();
  const added = [];
  for (const it of items) {
    if (queue.items.length >= MAX_ITEMS) break;
    const item = {
      id: `dl_${now}_${Math.random().toString(36).slice(2, 7)}`,
      url: it.url,
      filename: it.filename || '',
      referer: it.referer || '',
      status: 'pending',
      bytes: 0,
      totalBytes: it.totalBytes || 0,
      error: '',
      downloadId: null,
      createdAt: now,
    };
    queue.items.push(item);
    added.push(item.id);
  }
  queue.updatedAt = now;
  broadcast();
  return { added: added.length, ids: added };
}

/** 清空队列（只清记录，不删已下载文件）。 */
export async function clear() {
  await ensureLoaded();
  queue.items = [];
  queue.running = false;
  queue.paused = false;
  queue.updatedAt = Date.now();
  broadcast();
  return { ok: true };
}

/** 移除指定任务。 */
export async function remove(id) {
  await ensureLoaded();
  const item = queue.items.find((i) => i.id === id);
  if (!item) return { removed: 0 };
  if (item.downloadId != null) {
    chrome.downloads.cancel(item.downloadId).catch(() => {});
  }
  queue.items = queue.items.filter((i) => i.id !== id);
  queue.updatedAt = Date.now();
  broadcast();
  return { removed: 1 };
}

/** 取消全部。 */
export async function cancelAll() {
  await ensureLoaded();
  for (const item of queue.items) {
    if (item.status === 'pending' || item.status === 'running') {
      item.status = 'cancelled';
      if (item.downloadId != null) {
        chrome.downloads.cancel(item.downloadId).catch(() => {});
      }
    }
  }
  queue.running = false;
  queue.paused = false;
  queue.updatedAt = Date.now();
  broadcast();
  return { ok: true };
}

/** 暂停 / 继续。 */
export async function setPaused(paused) {
  await ensureLoaded();
  queue.paused = Boolean(paused);
  queue.updatedAt = Date.now();
  broadcast();
  return { ok: true, paused: queue.paused };
}

/**
 * 更新某任务的进度。由 chrome.downloads.onChanged 驱动。
 */
export async function updateProgress(downloadId, patch) {
  await ensureLoaded();
  const item = queue.items.find((i) => i.downloadId === downloadId);
  if (!item) return false;
  Object.assign(item, patch);
  queue.updatedAt = Date.now();
  broadcast();
  return true;
}

/** 标记任务完成。 */
export async function complete(downloadId, result) {
  return updateProgress(downloadId, {
    status: result?.ok === false ? 'failed' : 'done',
    error: result?.error || '',
    bytes: result?.bytes ?? undefined,
  });
}

/**
 * 启动队列处理。
 * 逐个下载（可并发），用 chrome.downloads 下发，
 * 进度通过 onChanged 事件回写。
 */
export async function processQueue(downloader, { concurrency = 3 } = {}) {
  await ensureLoaded();
  if (queue.running) return { ok: true, alreadyRunning: true };
  queue.running = true;
  queue.paused = false;
  broadcast();

  const pending = () => queue.items.filter((i) => i.status === 'pending');

  const worker = async () => {
    for (;;) {
      if (queue.paused) {
        queue.running = false;
        broadcast();
        return;
      }
      const item = pending().shift();
      if (!item) return;

      item.status = 'running';
      item.startedAt = Date.now();
      broadcast();

      try {
        const r = await downloader(item);
        item.downloadId = r?.id ?? null;
        if (r?.mode === 'companion' || r?.mode === 'ffmpeg') {
          // companion 下载：没有 chrome.downloads 事件，直接标记完成
          item.status = 'done';
          item.bytes = r?.size || 0;
        } else if (item.downloadId == null) {
          item.status = 'failed';
          item.error = r?.error || '下载未启动';
        }
      } catch (err) {
        item.status = 'failed';
        item.error = err?.message || String(err);
      }
      queue.updatedAt = Date.now();
      broadcast();
    }
  };

  try {
    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(pending().length, 1)) },
      worker
    );
    await Promise.all(workers);
  } finally {
    queue.running = false;
    queue.updatedAt = Date.now();
    broadcast();
  }
  return { ok: true };
}

/**
 * 监听浏览器下载事件，把真实进度写回队列。
 */
export function registerDownloadEvents() {
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state && !delta.bytesReceived) return;
    await ensureLoaded();
    const item = queue.items.find((i) => i.downloadId === delta.id);
    if (!item) return;

    if (delta.bytesReceived !== undefined) item.bytes = delta.bytesReceived;
    if (delta.totalBytes !== undefined) item.totalBytes = delta.totalBytes;

    if (delta.state?.current === 'complete') {
      item.status = 'done';
    } else if (delta.state?.current === 'interrupted') {
      item.status = 'failed';
      item.error = delta.error?.current || '下载中断';
    }
    queue.updatedAt = Date.now();
    broadcast();
  });
}

/**
 * SW 重启后恢复队列。
 * 上次没跑完的 'running' 任务退回 'pending'，重新排队。
 */
export async function recover() {
  await ensureLoaded();
  let recovered = 0;
  for (const item of queue.items) {
    if (item.status === 'running') {
      // 检查浏览器里这个下载是否还在进行
      const info = await chrome.downloads.search({ id: item.downloadId }).catch(() => []);
      if (!info?.length) {
        item.status = 'pending';
        recovered++;
      }
    }
  }
  if (recovered) {
    queue.updatedAt = Date.now();
    broadcast();
  }
  return { recovered };
}
