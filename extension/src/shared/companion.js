// companion 客户端。
//
// companion 是本地伴生服务，负责两件扩展做不了的事：
//   1. 反向代理 —— 绕开浏览器 CORS / 网络出口限制；
//   2. 调用本地程序 —— 扩展无法启动原生进程，ffmpeg / yt-dlp 必须由 companion 执行。
//
// companion 地址会自动探测：设置里配置的地址优先，其次是几个常见端口。

const STORAGE_KEY = 'nbc:settings';
export const DEFAULT_COMPANION_URL = 'http://127.0.0.1:8787';
export const CANDIDATE_PORTS = [8787, 8788, 8789, 8790, 8888];

const cache = { url: null, at: 0 };
const CACHE_TTL = 5_000;

/** 读取设置里配置的 companion 地址。 */
export async function configuredUrl() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = stored[STORAGE_KEY] || {};
    return (cfg.companionUrl || '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 探测地址是否为可用的 companion。 */
export async function probe(url) {
  if (!url) return false;
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.name === 'netbrowserclaw-companion';
  } catch {
    return false;
  }
}

/**
 * 找到可用的 companion 地址；找不到返回 null。
 * 带短缓存，避免每次调用都探测一遍。
 */
export async function findCompanion({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.url && now - cache.at < CACHE_TTL) return cache.url;

  const configured = await configuredUrl();
  if (configured && (await probe(configured))) {
    cache.url = configured;
    cache.at = now;
    return configured;
  }
  for (const port of CANDIDATE_PORTS) {
    const url = `http://127.0.0.1:${port}`;
    if (await probe(url)) {
      cache.url = url;
      cache.at = now;
      return url;
    }
  }
  cache.url = null;
  cache.at = now;
  return null;
}

/** 向 companion 发请求。找不到 companion 时返回 { ok:false, error }。 */
export async function companionFetch(path, body, { method = 'POST', timeout = 30_000 } = {}) {
  const base = await findCompanion();
  if (!base) {
    return {
      ok: false,
      error: '本地 companion 未运行',
      hint: '请运行 node companion/server.mjs 后重试',
    };
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error || `companion 返回 ${res.status}`, detail: data?.detail };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `companion 请求失败: ${e?.message || String(e)}` };
  }
}

/** 把本地工具路径配置推送给 companion。 */
export async function pushToolConfig(config) {
  return companionFetch('/config', {
    ffmpegPath: config.ffmpegPath || '',
    ytdlpPath: config.ytdlpPath || '',
    downloadDir: config.downloadDir || '',
  });
}

/** 读取 companion 当前的工具配置与检测结果。 */
export async function fetchToolConfig() {
  return companionFetch('/config', null, { method: 'GET' });
}

/** 检测本地程序路径是否可用。 */
export async function detectTools(config) {
  return companionFetch('/tools/detect', {
    ffmpegPath: config.ffmpegPath || '',
    ytdlpPath: config.ytdlpPath || '',
    downloadDir: config.downloadDir || '',
  });
}
