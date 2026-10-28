// 对话导出为 Markdown。
//
// 内部消息是统一的多模态格式（见 providers.js），这里负责把它
// 摊平成人类可读的 Markdown —— 保留角色、工具调用记录与结果。

/** 取出消息里的纯文本。 */
export function messageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();
}

/** 取出一条消息里的工具调用。 */
export function toolCallsOf(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks.filter((b) => b?.type === 'tool_use');
}

/** 取出一条消息里的工具结果。 */
export function toolResultsOf(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks.filter((b) => b?.type === 'tool_result');
}

/** 工具结果可能是字符串，也可能是 JSON 字符串。 */
function prettyResult(content) {
  if (typeof content !== 'string') return JSON.stringify(content, null, 2);
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch { /* 不是 JSON，原样输出 */ }
  }
  return content;
}

/**
 * 生成对话 Markdown。
 *
 * @param {Array} messages  内部统一格式的消息数组
 * @param {object} meta     { provider, model, startedAt, exportedAt, title }
 */
export function buildChatMarkdown(messages, meta = {}) {
  const lines = [];

  const title = meta.title || '对话记录';
  const exportedAt = meta.exportedAt || new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  lines.push('---');
  lines.push(`title: ${JSON.stringify(title)}`);
  if (meta.model) lines.push(`model: ${JSON.stringify(meta.model)}`);
  if (meta.provider) lines.push(`provider: ${JSON.stringify(meta.provider)}`);
  if (meta.startedAt) lines.push(`started: ${meta.startedAt}`);
  lines.push(`exported: ${exportedAt}`);
  lines.push(`messages: ${messages?.length || 0}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');

  if (!messages?.length) {
    lines.push('_（没有对话内容）_');
    return lines.join('\n');
  }

  for (const msg of messages) {
    const role = msg.role;

    if (role === 'system') continue;

    if (role === 'user') {
      // 用户消息里可能夹着工具结果（内部协议），要分开处理
      const text = messageText(msg);
      const results = toolResultsOf(msg);
      if (text) {
        lines.push('## 👤 我', '');
        lines.push(text);
        lines.push('');
      }
      for (const r of results) {
        lines.push('> **工具结果**');
        lines.push('>');
        lines.push(
          String(prettyResult(r.content) || '')
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
        );
        lines.push('');
      }
      continue;
    }

    if (role === 'assistant') {
      const text = messageText(msg);
      const calls = toolCallsOf(msg);
      if (text) {
        lines.push('## 🤖 助手', '');
        lines.push(text);
        lines.push('');
      }
      for (const c of calls) {
        lines.push(`### 🔧 工具调用：\`${c.name}\``, '');
        lines.push('```json');
        lines.push(JSON.stringify(c.input ?? {}, null, 2));
        lines.push('```');
        lines.push('');
      }
      continue;
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * 生成纯文本版对话（用于 .txt）。
 */
export function buildChatText(messages, meta = {}) {
  const out = [];
  out.push(meta.title || '对话记录');
  if (meta.model) out.push(`模型：${meta.model}`);
  out.push(`导出时间：${meta.exportedAt || new Date().toISOString()}`);
  out.push('');

  for (const msg of messages || []) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const text = messageText(msg);
      if (text) out.push('【我】', text, '');
      for (const r of toolResultsOf(msg)) {
        out.push('  [工具结果]', String(r.content || '').slice(0, 500), '');
      }
    } else if (msg.role === 'assistant') {
      const text = messageText(msg);
      if (text) out.push('【助手】', text, '');
      for (const c of toolCallsOf(msg)) {
        out.push(`  [调用工具] ${c.name}`, `  ${JSON.stringify(c.input ?? {})}`, '');
      }
    }
  }
  return out.join('\n');
}
