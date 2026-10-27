// 侧边栏主逻辑：设置管理、对话循环、工具调用可视化。

import { PROVIDER_PRESETS, PRESET_MAP, resolveProvider, listModels } from '../shared/providers.js';
import { runAgent, systemPrompt } from '../shared/agent.js';
import { Text } from '../shared/providers.js';
import { TOOLS } from '../shared/tools.js';

const $ = (id) => document.getElementById(id);

const el = {
  messages: $('messages'),
  input: $('input'),
  send: $('btn-send'),
  clear: $('btn-clear'),
  settings: $('settings'),
  closeSettings: $('btn-close-settings'),
  btnSettings: $('btn-settings'),
  context: $('btn-context'),
  tray: $('tool-tray'),
  providerName: $('provider-name'),
  providerDot: $('provider-dot'),
  switchModel: $('btn-switch-model'),
  statusHint: $('toast-hint'),
  auto: $('chk-auto'),
};

const state = {
  messages: [],
  provider: null,
  busy: false,
  controller: null,
};

// ---------------------------------------------------------------------------
// 设置存取
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'nbc:settings';

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const s = stored[STORAGE_KEY] || {};
  const providerId = s.providerId || 'deepseek';
  const preset = PRESET_MAP[providerId] || PROVIDER_PRESETS[0];
  state.provider = {
    providerId,
    kind: s.kind || preset.kind,
    label: s.label || preset.label,
    baseUrl: s.baseUrl || preset.baseUrl,
    apiKey: s.apiKey || '',
    model: s.model || preset.defaultModel,
    transport: s.transport || 'direct',
    relayUrl: s.relayUrl || 'http://127.0.0.1:8787',
    temperature: s.temperature ?? 0.7,
    maxTokens: s.maxTokens || 8192,
  };
  return state.provider;
}

async function saveSettings() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state.provider });
}

// ---------------------------------------------------------------------------
// 设置界面
// ---------------------------------------------------------------------------

function fillProviderSelect() {
  const sel = $('sel-provider');
  sel.innerHTML = '';
  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  // 自定义项
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = '自定义 (OpenAI 兼容)';
  sel.appendChild(custom);
  sel.value = state.provider.providerId;
}

function fillModelSuggestions(models) {
  const dl = $('model-suggestions');
  dl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.appendChild(opt);
  }
}

function syncSettingsForm() {
  const p = state.provider;
  fillProviderSelect();
  $('inp-model').value = p.model || '';
  $('inp-key').value = p.apiKey || '';
  $('inp-baseurl').value = p.baseUrl || '';
  $('sel-transport').value = p.transport || 'direct';
  $('inp-relay').value = p.relayUrl || 'http://127.0.0.1:8787';
  $('inp-temp').value = p.temperature ?? 0.7;
  $('temp-value').textContent = String(p.temperature ?? 0.7);
  $('inp-maxtokens').value = p.maxTokens || 8192;

  const preset = PRESET_MAP[p.providerId];
  $('provider-hint').textContent = preset?.keyUrl
    ? `API Key 获取地址：${preset.keyUrl}`
    : '本地模型通常无需 API Key。';
  fillModelSuggestions(preset?.models || []);
  updateTransportHint();
}

function updateTransportHint() {
  const t = $('sel-transport').value;
  $('transport-hint').textContent =
    t === 'relay'
      ? '请求会先发到本地中继再转发，适合官方接口拒绝浏览器直连的情况。'
      : '直接由扩展请求 API。若遇到 CORS 报错，切换到「本地中继」。';
}

function updateProviderBar() {
  const p = resolveProvider(state.provider);
  const configured = p.noKey ? true : Boolean(p.apiKey);
  el.providerName.textContent = configured
    ? `${p.label} · ${p.model || '未选模型'}`
    : '未配置 API Key';
  el.providerDot.className = `dot ${configured ? 'ok' : 'err'}`;
}

function openSettings() {
  syncSettingsForm();
  el.settings.hidden = false;
}

function closeSettings() {
  el.settings.hidden = true;
}

// ---------------------------------------------------------------------------
// 消息渲染
// ---------------------------------------------------------------------------

function scrollToBottom() {
  requestAnimationFrame(() => {
    el.messages.scrollTop = el.messages.scrollHeight;
  });
}

function renderMessage(role, text, extraClass = '') {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role} ${extraClass}`.trim();

  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role';
  roleEl.textContent = role === 'user' ? '你' : role === 'error' ? '错误' : '助手';
  wrap.appendChild(roleEl);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(text);
  wrap.appendChild(bubble);

  el.messages.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

/** 轻量 Markdown 渲染（够用即可，避免引入 marked 等依赖）。 */
function renderMarkdown(src) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = [];
  let inCode = false;
  let codeBuf = [];
  let listBuf = [];

  const flushList = () => {
    if (!listBuf.length) return;
    const ordered = /^\s*\d+\./.test(listBuf[0]);
    const tag = ordered ? 'ol' : 'ul';
    blocks.push(`<${tag}>${listBuf.map((i) => `<li>${inline(i.replace(/^\s*(?:[-*+]|\d+\.)\s*/, ''))}</li>`).join('')}</${tag}>`);
    listBuf = [];
  };

  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  for (const raw of String(src).split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      flushList();
      blocks.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(esc(raw));
      continue;
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      const lv = h[1].length;
      blocks.push(`<h${lv} style="margin:.6em 0 .3em;font-size:${17 - lv}px">${inline(h[2])}</h${lv}>`);
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(raw)) {
      listBuf.push(raw);
      continue;
    }
    flushList();
    if (!raw.trim()) continue;
    if (/^>\s?/.test(raw)) {
      blocks.push(`<blockquote style="border-left:3px solid var(--border);margin:.5em 0;padding-left:10px;color:var(--fg-dim)">${inline(raw.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    blocks.push(`<p style="margin:.35em 0">${inline(raw)}</p>`);
  }
  if (inCode) blocks.push('</code></pre>');
  flushList();
  return blocks.join('');
}

// ---------------------------------------------------------------------------
// 工具卡片
// ---------------------------------------------------------------------------

function createToolCard(name) {
  const card = document.createElement('div');
  card.className = 'tool-card';

  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML =
    `<span class="tool-icon">⚙</span><span class="tool-name">${name}</span>` +
    `<span class="tool-status run">运行中…</span>`;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'tool-body';
  card.appendChild(body);

  head.addEventListener('click', () => card.classList.toggle('open'));

  el.messages.appendChild(card);
  scrollToBottom();
  return { card, head, body };
}

function fillToolCard(tc, id, name, input, output, isError) {
  const card = el.messages.querySelectorAll('.tool-card');
  let node = null;
  for (const c of card) {
    if (c.dataset.toolId === id) {
      node = c;
      break;
    }
  }
  if (!node) return;
  const status = node.querySelector('.tool-status');
  status.className = `tool-status ${isError ? 'err' : 'ok'}`;
  status.textContent = isError ? '失败' : '完成';

  const inputJson = JSON.stringify(input ?? {}, null, 2);
  const outputText =
    typeof output === 'string' ? output : JSON.stringify(output ?? {}, null, 2);

  node.querySelector('.tool-body').innerHTML =
    `<div class="tool-section"><h4>入参</h4><pre>${escapeHtml(inputJson)}</pre></div>` +
    `<div class="tool-section"><h4>结果</h4><pre>${escapeHtml(outputText)}</pre></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

async function currentPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) return null;
    return { url: tab.url, title: tab.title || '' };
  } catch {
    return null;
  }
}

async function send() {
  const text = el.input.value.trim();
  if (!text || state.busy) return;

  const p = resolveProvider(state.provider);
  if (!p.noKey && !p.apiKey) {
    openSettings();
    renderMessage('error', '还没有配置 API Key。请在设置里选择模型服务商并填入 Key。');
    return;
  }

  el.input.value = '';
  el.input.style.height = 'auto';
  el.send.disabled = true;
  state.busy = true;
  state.controller = new AbortController();

  renderMessage('user', text);

  // 流式内容先以纯文本累积，结束后再按 Markdown 渲染，
  // 否则每次追加都会把已渲染的 Markdown 标签冲掉。
  const bubble = renderMessage('assistant', '');
  let acc = '';
  let rendered = '';
  const toolCards = new Map();

  const pageCtx = await currentPageContext();
  const history = [...state.messages];
  history.push({ role: 'user', content: [Text(text)] });

  const events = {
    text: (t) => {
      acc += t;
      bubble.textContent = acc;
      scrollToBottom();
    },
    tool_start: (ev) => {
      const tc = createToolCard(ev.name);
      tc.card.dataset.toolId = ev.id;
      toolCards.set(ev.id, { name: ev.name, input: ev.input });
      el.tray.hidden = false;
      const row = document.createElement('div');
      row.className = 't-row';
      row.innerHTML = `<span class="t-name">${escapeHtml(ev.name)}</span> 运行中…`;
      el.tray.appendChild(row);
    },
    tool_end: (ev) => {
      const card = el.messages.querySelector(`.tool-card[data-tool-id="${ev.id}"]`);
      if (card) {
        const status = card.querySelector('.tool-status');
        status.className = `tool-status ${ev.isError ? 'err' : 'ok'}`;
        status.textContent = ev.isError ? '失败' : '完成';
        card.querySelector('.tool-body').innerHTML =
          `<div class="tool-section"><h4>入参</h4><pre>${escapeHtml(JSON.stringify(toolCards.get(ev.id)?.input ?? {}, null, 2))}</pre></div>` +
          `<div class="tool-section"><h4>结果</h4><pre>${escapeHtml(typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? {}, null, 2))}</pre></div>`;
      }
      const rows = el.tray.querySelectorAll('.t-row');
      const row = rows[rows.length - 1];
      if (row) {
        row.innerHTML = `<span class="t-name">${escapeHtml(ev.name)}</span> ${ev.isError ? '<span style="color:var(--err)">失败</span>' : '完成'}`;
      }
    },
    error: (ev) => {
      acc += `\n[错误] ${ev.error}`;
      bubble.textContent = acc;
    },
  };

  try {
    const system = systemPrompt({ siteName: pageCtx?.title, pageTitle: pageCtx?.title });
    const result = await runAgent({
      messages: [{ role: 'system', content: [Text(system)] }, ...history],
      provider: state.provider,
      onEvent: events,
      signal: state.controller.signal,
      enabledTools: TOOLS,
      // 未勾选「自动执行工具」时，每次工具调用前都问一次。
      beforeTool: el.auto.checked ? null : confirmTool,
    });
    state.messages = result.messages.filter((m) => m.role !== 'system');
    await saveSettings();
  } catch (err) {
    if (err?.name === 'AbortError') {
      acc += '\n（已中断）';
    } else {
      acc += `\n[错误] ${err?.message || String(err)}`;
    }
  } finally {
    // 最终按 Markdown 渲染（流式阶段是纯文本，避免标签闪烁）。
    rendered = renderMarkdown(acc);
    bubble.innerHTML = rendered;
    state.busy = false;
    state.controller = null;
    el.send.disabled = false;
    el.input.focus();
    scrollToBottom();
  }
}

// ---------------------------------------------------------------------------
// 工具执行确认（当「自动执行工具」未勾选时）
// ---------------------------------------------------------------------------

/**
 * 在执行工具前请求用户确认。
 * 返回 true 表示允许执行。
 */
function confirmTool(name, input) {
  return new Promise((resolve) => {
    const detail = JSON.stringify(input ?? {}, null, 2);
    const ok = window.confirm(
      `即将执行工具：${name}\n\n${detail.slice(0, 800)}\n\n是否继续？`
    );
    resolve(ok);
  });
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

el.send.addEventListener('click', send);

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
});

el.clear.addEventListener('click', () => {
  if (state.busy) return;
  state.messages = [];
  el.messages.innerHTML = '';
  el.tray.hidden = true;
  el.tray.innerHTML = '';
});

el.btnSettings.addEventListener('click', openSettings);
el.closeSettings.addEventListener('click', closeSettings);

el.switchModel.addEventListener('click', openSettings);

el.context.addEventListener('click', async () => {
  const ctx = await currentPageContext();
  if (!ctx) {
    el.input.value = '（当前页面不支持读取上下文）';
    return;
  }
  const existing = el.input.value.trim();
  const prefix = `关于「${ctx.title}」（${ctx.url}）：`;
  el.input.value = existing ? `${existing}\n${prefix}` : prefix;
  el.input.focus();
});

$('sel-provider').addEventListener('change', (e) => {
  const id = e.target.value;
  if (id === '__custom__') {
    state.provider.providerId = '__custom__';
    state.provider.kind = 'openai';
    state.provider.label = '自定义';
    state.provider.baseUrl = state.provider.baseUrl || 'https://api.openai.com/v1';
    state.provider.model = state.provider.model || 'gpt-4o-mini';
  } else {
    const preset = PRESET_MAP[id];
    state.provider.providerId = id;
    state.provider.kind = preset.kind;
    state.provider.label = preset.label;
    state.provider.baseUrl = preset.baseUrl;
    state.provider.model = preset.defaultModel;
  }
  syncSettingsForm();
  updateProviderBar();
});

$('sel-transport').addEventListener('change', updateTransportHint);

$('inp-temp').addEventListener('input', (e) => {
  $('temp-value').textContent = e.target.value;
});

$('btn-toggle-key').addEventListener('click', () => {
  const inp = $('inp-key');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('btn-fetch-models').addEventListener('click', async () => {
  const btn = $('btn-fetch-models');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const models = await listModels({
      providerId: state.provider.providerId,
      kind: state.provider.kind,
      baseUrl: $('inp-baseurl').value.trim(),
      apiKey: $('inp-key').value.trim(),
      transport: $('sel-transport').value,
      relayUrl: $('inp-relay').value.trim(),
    });
    if (models.length) {
      fillModelSuggestions(models);
      el.statusHint.textContent = `已拉取 ${models.length} 个模型`;
    } else {
      el.statusHint.textContent = '该接口不支持拉取模型列表';
    }
  } catch (err) {
    el.statusHint.textContent = `拉取失败：${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取';
  }
});

$('btn-save-settings').addEventListener('click', async () => {
  state.provider.baseUrl = $('inp-baseurl').value.trim().replace(/\/+$/, '');
  state.provider.model = $('inp-model').value.trim();
  state.provider.apiKey = $('inp-key').value.trim();
  state.provider.transport = $('sel-transport').value;
  state.provider.relayUrl = $('inp-relay').value.trim().replace(/\/+$/, '');
  state.provider.temperature = Number($('inp-temp').value);
  state.provider.maxTokens = Number($('inp-maxtokens').value) || 8192;
  await saveSettings();
  updateProviderBar();
  $('save-status').textContent = '已保存 ✓';
  setTimeout(() => ($('save-status').textContent = ''), 1800);
});

$('btn-clear-storage').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  state.messages = [];
  el.messages.innerHTML = '';
  await loadSettings();
  syncSettingsForm();
  updateProviderBar();
  $('save-status').textContent = '已清除';
});

// 来自右键菜单的提问
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'nbc:ui:ask') {
    el.input.value = msg.text || '';
    el.input.focus();
    el.input.dispatchEvent(new Event('input'));
  }
});

// 快捷键：Ctrl+Shift+K 由 manifest commands 处理，这里只做聚焦兜底
chrome.commands?.onCommand?.addListener?.(() => el.input.focus());

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  await loadSettings();
  fillProviderSelect();
  updateProviderBar();
  el.input.focus();

  if (!state.provider.apiKey && !PRESET_MAP[state.provider.providerId]?.noKey) {
    el.messages.innerHTML =
      '<div class="msg assistant"><div class="bubble">' +
      '👋 欢迎使用 NetBrowserClaw。\n\n' +
      '点击右上角 ⚙ 按钮，选择模型服务商并填入你的 API Key。' +
      '本扩展完全开源、无需订阅，也不会把 Key 上传到任何第三方。' +
      '</div></div>';
  }
})();
