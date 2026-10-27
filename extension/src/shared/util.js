// 通用小工具：扩展各模块共用。
// 保持零依赖，方便审计与二次分发。

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 截断长文本，避免把整个模型上下文撑爆。 */
export function truncate(text, max = 20000, marker = '\n...[已截断]...\n') {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}

/** 统一错误形状，便于在面板里展示与日志。 */
export class ToolError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ToolError';
    this.detail = detail;
  }
}

/** 安全的 JSON 解析，不抛异常。 */
export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 简易脱敏，日志里不落 API Key。 */
export function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/("?(?:api[_-]?key|authorization)"?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1***');
}

/** 把字节数格式化成人类可读。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 依据 URL 推断媒体/文档类型。 */
const EXT_MAP = {
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', flv: 'video/x-flv', m3u8: 'application/vnd.apple.mpegurl',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', opus: 'audio/opus',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  xml: 'application/xml', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
  epub: 'application/epub+zip', apk: 'application/vnd.android.package-archive',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
};

export function extOf(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

export function mimeOf(url) {
  const ext = extOf(url);
  return EXT_MAP[ext] || '';
}

export function isMediaUrl(url) {
  const m = mimeOf(url);
  return m.startsWith('video/') || m.startsWith('audio/');
}

export function isDocumentUrl(url) {
  const m = mimeOf(url);
  return (
    m === 'application/pdf' ||
    m.startsWith('application/vnd.openxmlformats') ||
    m.startsWith('application/vnd.ms-') ||
    m === 'text/csv' || m === 'text/plain' || m === 'application/epub+zip' ||
    m === 'application/zip' || m === 'application/x-7z-compressed' ||
    m === 'application/vnd.rar' || m === 'application/gzip' || m === 'application/x-tar'
  );
}

export function isImageUrl(url) {
  return mimeOf(url).startsWith('image/');
}

/** 域名匹配：支持 `*.example.com` 与精确匹配。 */
export function hostMatches(pattern, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === p;
}

/** 从 hostname 提取站点主名，用于文件命名。 */
export function siteName(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.split('.')[0] || 'site';
  } catch {
    return 'site';
  }
}

/** 时间戳，用于文件名。 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把文件名里的非法字符替换掉。 */
export function safeName(name, fallback = 'file') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}
