// 摘录（clipping）的 Markdown 生成。
//
// 摘录 = 选中的文字 + 上下文 + 页面元信息，存成带 YAML frontmatter 的 .md，
// 这样丢进 Obsidian / Logseq / 任何静态博客都能直接用。

/** YAML 字符串值：含特殊字符时加引号。 */
function yamlString(value) {
  if (value === undefined || value === null || value === '') return '""';
  const s = String(value);
  // 需要加引号的情况：含特殊标点、以特殊字符开头、看起来像数字/布尔
  const needsQuote =
    /^[\s>|*&!%@`{}[\],#?:-]/.test(s) ||
    /[:#]\s/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^[\d.-]+$/.test(s) ||
    /^(true|false|null|yes|no|on|off)$/i.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** YAML 数组。 */
function yamlArray(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return '[]';
  return `[${list.map((i) => yamlString(i)).join(', ')}]`;
}

/** ISO 时间戳（去掉毫秒和 Z，方便阅读）。 */
function isoTime(d = new Date()) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

/** 生成 YAML frontmatter。 */
export function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: ${yamlArray(value)}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * 生成摘录 Markdown。
 *
 * @param {object} clip
 * @param {string} clip.text        选中的文字
 * @param {string} clip.context     选区所在的段落/章节文本
 * @param {string} clip.title       页面标题
 * @param {string} clip.url         来源 URL
 * @param {string} clip.author      作者
 * @param {string} clip.published   发布日期
 * @param {string} clip.siteName    站点名
 * @param {string} clip.note        用户附注
 * @param {string} clip.selectedAt  摘录时间
 */
export function buildClipMarkdown(clip) {
  const fm = frontmatter({
    title: clip.title,
    source: clip.url,
    author: clip.author || undefined,
    published: clip.published || undefined,
    site: clip.siteName || undefined,
    created: clip.selectedAt || isoTime(),
    tags: clip.tags || ['clippings'],
  });

  const body = [];

  if (clip.title) body.push(`# ${clip.title}`, '');

  if (clip.text) {
    // 多行选区用引用块保留换行结构
    const quoted = clip.text
      .split('\n')
      .map((l) => (l.trim() ? `> ${l.trim()}` : '>'))
      .join('\n');
    body.push(quoted, '');
  }

  if (clip.context && clip.context !== clip.text) {
    body.push('**上下文**', '', clip.context, '');
  }

  if (clip.note) {
    body.push('**笔记**', '', clip.note, '');
  }

  body.push('---', '', `来源：[${clip.title || clip.siteName || '原文'}](${clip.url})`);

  return `${fm}\n\n${body.join('\n').trim()}\n`;
}

/**
 * 生成纯文本版摘录（用于 .txt / 剪贴板）。
 */
export function buildClipText(clip) {
  const lines = [];
  if (clip.title) lines.push(clip.title);
  lines.push(clip.url || '');
  if (clip.author) lines.push(`作者：${clip.author}`);
  lines.push('');
  if (clip.text) lines.push(clip.text);
  if (clip.context && clip.context !== clip.text) {
    lines.push('');
    lines.push('上下文：');
    lines.push(clip.context);
  }
  if (clip.note) {
    lines.push('');
    lines.push('笔记：');
    lines.push(clip.note);
  }
  return lines.join('\n');
}
