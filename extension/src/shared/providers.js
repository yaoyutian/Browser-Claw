// 模型服务商抽象层。
//
// 设计要点：
// 1. 内部统一使用「多模态内容块」消息格式（接近 Anthropic 的结构，天然支持图片/工具），
//    各家协议只在边界处做转换，避免业务代码到处 if/else。
// 2. 全部走流式（SSE），面板可以边生成边渲染。
// 3. 每个服务商可单独配置 baseURL / key / model，
//    OpenAI 兼容这一类覆盖了绝大多数国产与自建模型（DeepSeek、Kimi、通义、智谱、
//    SiliconFlow、OpenRouter、Groq、Ollama、LM Studio、vLLM…）。
// 4. transport 可选 'direct'（浏览器直连）或 'relay'（走本地 companion 中继，
//    用于解决 CORS 或本地网络无法直连官方 API 的情况）。

import { ToolError } from './util.js';
import { findCompanion } from './companion.js';

/** 内部统一内容块。 */
export const Text = (text) => ({ type: 'text', text });
export const Image = (mime, data) => ({ type: 'image', mime, data });
export const ToolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const ToolResult = (toolUseId, content, isError = false) => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content,
  is_error: isError,
});

/** 预设服务商。用户可在设置里改，也可以自建。 */
export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    supportsImages: true,
    supportsTools: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
    supportsImages: true,
    supportsTools: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-pro'],
    supportsImages: true,
    supportsTools: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    kind: 'openai',
    // 官方文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
    // base_url 为 https://api.deepseek.com（不带 /v1；带 /v1 也兼容 OpenAI SDK）
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    supportsImages: false,
    supportsTools: true,
    // DeepSeek 默认开启思考模式，思维链会占用 max_tokens
    supportsThinking: true,
  },
  {
    id: 'moonshot',
    label: 'Kimi 月之暗面',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    supportsImages: false,
    supportsTools: true,
  },
  {
    id: 'qwen',
    label: '阿里云百炼 通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    keyUrl: 'https://bailian.console.aliyun.com/',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
    supportsImages: true,
    supportsTools: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
    supportsImages: true,
    supportsTools: true,
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3', 'moonshotai/Kimi-K2-Instruct'],
    supportsImages: false,
    supportsTools: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    keyUrl: 'https://openrouter.ai/keys',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini', 'google/gemini-2.0-flash-001'],
    supportsImages: true,
    supportsTools: true,
  },
  {
    id: 'ollama',
    label: 'Ollama 本地模型',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    keyUrl: '',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b'],
    supportsImages: false,
    supportsTools: true,
    noKey: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio 本地',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    keyUrl: '',
    models: ['local-model'],
    supportsImages: false,
    supportsTools: true,
    noKey: true,
  },
];

export const PRESET_MAP = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]));

/** 合并用户配置与预设默认值。 */
export function resolveProvider(config = {}) {
  const preset = PRESET_MAP[config.providerId] || {};
  const kind = config.kind || preset.kind || 'openai';
  return {
    providerId: config.providerId || 'openai',
    kind,
    label: config.label || preset.label || config.providerId || '自定义',
    baseUrl: (config.baseUrl || preset.baseUrl || '').replace(/\/+$/, ''),
    apiKey: config.apiKey || '',
    model: config.model || preset.defaultModel || '',
    transport: config.transport || 'direct',
    relayUrl: (config.relayUrl || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
    maxTokens: config.maxTokens || undefined,
    supportsImages: config.supportsImages ?? preset.supportsImages ?? false,
    supportsTools: config.supportsTools ?? preset.supportsTools ?? true,
    supportsThinking: config.supportsThinking ?? preset.supportsThinking ?? false,
    thinking: config.thinking || 'auto',
    reasoningEffort: config.reasoningEffort || '',
    headers: config.headers || {},
    noKey: config.noKey ?? preset.noKey ?? false,
  };
}

// ---------------------------------------------------------------------------
// 工具 schema 转换
// ---------------------------------------------------------------------------

/**
 * 工具名的合法性。
 *
 * OpenAI 兼容端点（含 DeepSeek、Kimi、通义等）要求函数名匹配
 * `^[a-zA-Z0-9_-]+$` —— **不允许点号**。而本项目的工具名为了可读性
 * 用了 `page.read` 这种点号命名，直接发过去会被服务端拒绝：
 *   Invalid 'tools[0].function.name': string does not match pattern
 *
 * Anthropic 同样要求 `^[a-zA-Z0-9_-]{1,64}$`。
 * Gemini 允许点号，但统一处理更省心。
 *
 * 所以：发给服务商时把点号换成下划线，收到调用时再映射回原始名。
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 把工具名转成服务端接受的形式。 */
export function sanitizeToolName(name) {
  let out = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  // 不能以数字开头（部分服务端要求首字符为字母或下划线）
  if (/^[0-9]/.test(out)) out = `_${out}`;
  // 长度上限（Anthropic 是 64）
  if (out.length > 60) out = out.slice(0, 60);
  return out || 'tool';
}

/**
 * 构建「原始名 ↔ 服务端名」的双向映射。
 * 多个工具名 sanitize 后理论上可能撞名，但要保证安全：撞名时加数字后缀。
 */
export function buildToolNameMap(tools = []) {
  const toRemote = new Map(); // 原始名 → 服务端名
  const toLocal = new Map(); // 服务端名 → 原始名
  const used = new Set();

  for (const t of tools) {
    const original = t.name;
    let remote = sanitizeToolName(original);
    if (used.has(remote)) {
      let i = 2;
      while (used.has(`${remote}_${i}`)) i++;
      remote = `${remote}_${i}`;
    }
    used.add(remote);
    toRemote.set(original, remote);
    toLocal.set(remote, original);
  }
  return { toRemote, toLocal };
}

/**
 * 把工具定义转成各服务商的格式。
 * @param {string} kind
 * @param {Array} tools
 * @param {Map<string,string>} [nameMap] 原始名 → 服务端名
 */
export function toProviderTools(kind, tools, nameMap) {
  if (!tools || !tools.length) return undefined;
  const remote = (t) => (nameMap ? nameMap.get(t.name) || t.name : sanitizeToolName(t.name));

  if (kind === 'anthropic') {
    return tools.map((t) => ({
      name: remote(t),
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }
  if (kind === 'gemini') {
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: remote(t),
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        })),
      },
    ];
  }
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: remote(t),
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

// ---------------------------------------------------------------------------
// 消息格式转换
// ---------------------------------------------------------------------------

function blocksOf(msg) {
  if (typeof msg.content === 'string') return [{ type: 'text', text: msg.content }];
  return msg.content || [];
}

function toOpenAIMessages(messages) {
  const out = [];
  for (const msg of messages) {
    const blocks = blocksOf(msg);
    if (msg.role === 'system') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'system', content: text });
      continue;
    }
    if (msg.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      const entry = { role: 'assistant', content: text || null };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    if (msg.role === 'tool') {
      const results = blocks.filter((b) => b.type === 'tool_result');
      for (const r of results) {
        out.push({
          role: 'tool',
          tool_call_id: r.tool_use_id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        });
      }
      continue;
    }
    // user
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.mime};base64,${b.data}` } });
    }
    if (parts.length) {
      // 纯文本时用字符串形式 —— 部分 OpenAI 兼容端点（含国产模型）
      // 对 content 数组形式的兼容性不如字符串。
      const hasImage = parts.some((x) => x.type === 'image_url');
      const text = parts.filter((x) => x.type === 'text').map((x) => x.text).join(String.fromCharCode(10));
      out.push({
        role: 'user',
        content: hasImage ? parts : text,
      });
    }
  }
  return out;
}

function toAnthropicMessages(messages) {
  const out = [];
  let system = '';
  for (const msg of messages) {
    const blocks = blocksOf(msg);
    if (msg.role === 'system') {
      system += blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') + '\n';
      continue;
    }
    if (msg.role === 'assistant') {
      const content = blocks.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
        return null;
      }).filter(Boolean);
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    if (msg.role === 'tool') {
      const content = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
          ...(b.is_error ? { is_error: true } : {}),
        }));
      if (content.length) out.push({ role: 'user', content });
      continue;
    }
    const content = blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'image') {
        return { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } };
      }
      return null;
    }).filter(Boolean);
    if (content.length) out.push({ role: 'user', content });
  }
  return { system: system.trim(), messages: out };
}

function toGeminiContents(messages) {
  const contents = [];
  let system = '';
  for (const msg of messages) {
    const blocks = blocksOf(msg);
    if (msg.role === 'system') {
      system += blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') + '\n';
      continue;
    }
    if (msg.role === 'assistant') {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ text: b.text });
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    if (msg.role === 'tool') {
      const parts = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({
          functionResponse: {
            name: b.tool_use_id,
            response: { content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) },
          },
        }));
      if (parts.length) contents.push({ role: 'user', parts });
      continue;
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image') parts.push({ inlineData: { mimeType: b.mime, data: b.data } });
    }
    if (parts.length) contents.push({ role: 'user', parts });
  }
  return { systemInstruction: system.trim() ? { parts: [{ text: system.trim() }] } : undefined, contents };
}

// ---------------------------------------------------------------------------
// HTTP 传输
// ---------------------------------------------------------------------------

/**
 * 统一的 fetch 包装。relay 模式下把请求原样转发到本地 companion，
 * 由它代为发出去，从而绕开浏览器 CORS 限制或本地网络出口问题。
 */
async function httpFetch(provider, { url, init, signal }) {
  if (provider.transport === 'relay') {
    // 走本地 companion 中继。
    // 地址要自动探测 —— 用户填的端口可能不对（companion 换了端口、
    // 或者填了带路径的地址），硬编码会直接 "Failed to fetch"。
    const base = await findCompanion();
    if (!base) {
      throw new ToolError(
        '本地中继未连接',
        '请先运行 node companion/server.mjs，或在设置里把「连接方式」改回「浏览器直连」'
      );
    }
    let res;
    try {
      res = await fetch(`${base}/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: url,
          method: init.method || 'POST',
          headers: init.headers || {},
          body: init.body ? JSON.parse(init.body) : undefined,
          stream: true,
        }),
        signal,
      });
    } catch (e) {
      throw new ToolError(
        '无法连接本地中继',
        `${base} —— ${e?.message || e}。请确认 companion 正在运行。`
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ToolError(`中继请求失败 (${res.status})`, detail.slice(0, 500));
    }
    return res;
  }

  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    // fetch 的网络层错误信息很笼统（"Failed to fetch"），
    // 换成人能看懂的提示，并给出最可能的原因。
    throw new ToolError(
      '无法连接模型服务',
      describeFetchFailure(e, url, provider)
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ToolError(`模型请求失败 (${res.status} ${res.statusText})`, detail.slice(0, 800));
  }
  return res;
}

/** 把笼统的网络错误翻译成可操作的原因。 */
function describeFetchFailure(err, url, provider) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const base = `${err?.message || err}（${host}）`;
  const tips = [];
  if (provider?.transport === 'relay') {
    tips.push('中继模式：确认 node companion/server.mjs 正在运行');
  } else {
    tips.push('检查 Base URL 是否正确、API Key 是否有效');
    tips.push('若报 CORS 错误，在设置里改用「本地中继」');
  }
  tips.push('若使用代理，扩展不会自动继承系统代理设置');
  return `${base}\n${tips.map((t) => `· ${t}`).join('\n')}`;
}

/** 逐行解析 SSE。 */
async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf.replace(/\r$/, '');
}

function parseSseData(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return payload === '[DONE]' ? { done: true } : null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 各服务商流式实现
// ---------------------------------------------------------------------------

async function* streamOpenAI(provider, { messages, tools, signal }) {
  const payload = {
    model: provider.model,
    messages: toOpenAIMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (provider.temperature !== undefined) payload.temperature = provider.temperature;
  if (provider.maxTokens) payload.max_tokens = provider.maxTokens;
  const nameMap = buildToolNameMap(tools || []);
  const t = toProviderTools('openai', tools, nameMap.toRemote);
  if (t) payload.tools = t;

  // 思考模式（DeepSeek 等）：thinking 优先于 reasoning_effort。
  // 默认 'auto' 表示不干预，由服务端决定。
  if (provider.thinking === 'on' || provider.thinking === 'off') {
    payload.thinking = { type: provider.thinking === 'on' ? 'enabled' : 'disabled' };
  } else if (provider.reasoningEffort) {
    payload.reasoning_effort = provider.reasoningEffort;
  }

  const headers = {
    'Content-Type': 'application/json',
    ...provider.headers,
  };
  if (!provider.noKey && provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await httpFetch(provider, {
    url: `${provider.baseUrl}/chat/completions`,
    init: { method: 'POST', headers, body: JSON.stringify(payload) },
    signal,
  });

  // 工具调用是增量拼接的，需要按 index 聚合。
  const toolAcc = new Map();
  for await (const line of sseLines(res)) {
    const data = parseSseData(line);
    if (!data) continue;
    if (data.done) break;
    if (data.error) throw new ToolError('模型返回错误', JSON.stringify(data.error).slice(0, 500));
    const choice = data.choices?.[0];
    const delta = choice?.delta;
    if (!delta) continue;
    if (delta.content) yield { type: 'text', text: delta.content };
    // 思考模式下的思维链 —— 单独标记，便于 UI 以浅色/斜体展示
    if (delta.reasoning_content) {
      yield { type: 'reasoning', text: delta.reasoning_content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolAcc.has(idx)) {
          toolAcc.set(idx, { id: tc.id || `call_${idx}`, name: '', args: '' });
        }
        const acc = toolAcc.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }
  for (const acc of toolAcc.values()) {
    let input = {};
    try {
      input = acc.args ? JSON.parse(acc.args) : {};
    } catch {
      input = { _raw: acc.args };
    }
    // 把服务端名还原成本地名（page_read → page.read）
    yield {
      type: 'tool_call',
      id: acc.id,
      name: nameMap.toLocal.get(acc.name) || acc.name,
      input,
    };
  }
}

async function* streamAnthropic(provider, { messages, tools, signal }) {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const payload = {
    model: provider.model,
    messages: msgs,
    max_tokens: provider.maxTokens || 8192,
    stream: true,
  };
  if (provider.temperature !== undefined) payload.temperature = provider.temperature;
  if (system) payload.system = system;
  const nameMap = buildToolNameMap(tools || []);
  const t = toProviderTools('anthropic', tools, nameMap.toRemote);
  if (t) payload.tools = t;

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    // 允许从浏览器直接调用 Anthropic API（官方要求的头）。
    'anthropic-dangerous-direct-browser-access': 'true',
    ...provider.headers,
  };
  if (!provider.noKey && provider.apiKey) headers['x-api-key'] = provider.apiKey;

  const res = await httpFetch(provider, {
    url: `${provider.baseUrl}/messages`,
    init: { method: 'POST', headers, body: JSON.stringify(payload) },
    signal,
  });

  let current = null; // 当前累积中的 tool_use
  const buffer = new Map(); // index -> 累积
  for await (const line of sseLines(res)) {
    const data = parseSseData(line);
    if (!data || data.done) continue;
    if (data.type === 'content_block_start') {
      const cb = data.content_block;
      if (cb?.type === 'tool_use') {
        current = { index: data.index, id: cb.id, name: cb.name, args: '' };
        buffer.set(data.index, current);
      }
    } else if (data.type === 'content_block_delta') {
      const d = data.delta;
      if (d?.type === 'text_delta') yield { type: 'text', text: d.text };
      else if (d?.type === 'input_json_delta') {
        const cur = buffer.get(data.index);
        if (cur) cur.args += d.partial_json || '';
      }
    } else if (data.type === 'content_block_stop') {
      current = null;
    } else if (data.type === 'error') {
      throw new ToolError('模型返回错误', JSON.stringify(data.error).slice(0, 500));
    }
  }
  for (const acc of buffer.values()) {
    let input = {};
    try {
      input = acc.args ? JSON.parse(acc.args) : {};
    } catch {
      input = { _raw: acc.args };
    }
    // 把服务端名还原成本地名
    yield {
      type: 'tool_call',
      id: acc.id,
      name: nameMap.toLocal.get(acc.name) || acc.name,
      input,
    };
  }
}

async function* streamGemini(provider, { messages, tools, signal }) {
  const { systemInstruction, contents } = toGeminiContents(messages);
  const payload = {
    contents,
    generationConfig: { maxOutputTokens: provider.maxTokens || 8192 },
  };
  if (provider.temperature !== undefined) payload.generationConfig.temperature = provider.temperature;
  if (systemInstruction) payload.systemInstruction = systemInstruction;
  const nameMap = buildToolNameMap(tools || []);
  const t = toProviderTools('gemini', tools, nameMap.toRemote);
  if (t) payload.tools = t;

  const headers = { 'Content-Type': 'application/json', ...provider.headers };
  const url = `${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse`;
  const keyParam = provider.apiKey ? `&key=${encodeURIComponent(provider.apiKey)}` : '';
  const fullUrl = `${url}${keyParam}`;

  const res = await httpFetch(provider, {
    url: fullUrl,
    init: { method: 'POST', headers, body: JSON.stringify(payload) },
    signal,
  });

  let callIndex = 0;
  for await (const line of sseLines(res)) {
    const data = parseSseData(line);
    if (!data || data.done) continue;
    if (data.error) throw new ToolError('模型返回错误', JSON.stringify(data.error).slice(0, 500));
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.text) yield { type: 'text', text: p.text };
      if (p.functionCall) {
        yield {
          type: 'tool_call',
          id: p.functionCall.id || `call_${callIndex++}`,
          // 把服务端名还原成本地名
          name: nameMap.toLocal.get(p.functionCall.name) || p.functionCall.name,
          input: p.functionCall.args || {},
        };
      }
    }
  }
}

/**
 * 统一的流式对话入口。
 * 产出事件：{type:'text', text} / {type:'tool_call', id, name, input}
 */
export async function* streamChat(providerConfig, { messages, tools, signal } = {}) {
  const provider = resolveProvider(providerConfig);
  if (!provider.model) throw new ToolError('未配置模型名称', '请在设置中填写 model');
  if (!provider.baseUrl) throw new ToolError('未配置接口地址', '请在设置中填写 baseUrl');
  if (!provider.noKey && !provider.apiKey) {
    throw new ToolError('未配置 API Key', '请在设置中填写 API Key，或改用本地模型');
  }
  switch (provider.kind) {
    case 'anthropic':
      yield* streamAnthropic(provider, { messages, tools, signal });
      break;
    case 'gemini':
      yield* streamGemini(provider, { messages, tools, signal });
      break;
    case 'openai':
    default:
      yield* streamOpenAI(provider, { messages, tools, signal });
      break;
  }
}

/** 拉取可用模型列表（尽力而为，失败不阻塞使用）。 */
export async function listModels(providerConfig) {
  const provider = resolveProvider(providerConfig);
  const headers = { 'Content-Type': 'application/json', ...provider.headers };
  if (!provider.noKey && provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  try {
    const res = await httpFetch(provider, {
      url: `${provider.baseUrl}/models`,
      init: { method: 'GET', headers },
    });
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return list.map((m) => m.id || m.name).filter(Boolean);
  } catch {
    return [];
  }
}
