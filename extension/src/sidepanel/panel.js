// 侧边栏主逻辑：设置管理、对话循环、工具调用可视化。

import { PROVIDER_PRESETS, PRESET_MAP, resolveProvider, listModels } from '../shared/providers.js';
import { runAgent, systemPrompt } from '../shared/agent.js';
import { Text } from '../shared/providers.js';
import { TOOLS } from '../shared/tools.js';
import { formatBytes } from '../shared/util.js';
import {
  detectTools,
  fetchToolConfig,
  pushToolConfig,
  configuredUrl,
} from '../shared/companion.js';
import { createSessionStore, newSessionId, deriveTitle } from '../shared/sessions.js';

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
  selectionBar: $('selection-bar'),
  selectionText: $('selection-text'),
  queuePanel: $('queue-panel'),
  queueList: $('queue-list'),
  queueSummary: $('queue-summary'),
  queueToggle: $('btn-queue-toggle'),
  sessions: $('btn-sessions'),
  sessionDrawer: $('session-drawer'),
  sessionList: $('session-list'),
  sessionCurrent: $('session-current'),
  closeSessions: $('btn-close-sessions'),
  newSession: $('btn-new-session'),
  followTab: $('chk-follow-tab'),
};

const state = {
  messages: [],
  provider: null,
  busy: false,
  controller: null,
  selection: null,
  chatStartedAt: null,
  // 会话持久化
  sessionStore: null,
  sessionId: null,
  sessionTitle: '新会话',
  sessionCreatedAt: null,
  sessionTab: null, // {url,title}：会话是在哪个标签页开始的
  followTab: true,
  windowId: null,
  tools: {
    ffmpegPath: '',
    ytdlpPath: '',
    downloadDir: '',
  },
};

// ---------------------------------------------------------------------------
// 设置存取
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'nbc:settings';
const TOOLS_KEY = 'nbc:tools';

async function loadSettings() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, TOOLS_KEY]);
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
    companionUrl: s.companionUrl || '',
    temperature: s.temperature ?? 0.7,
    maxTokens: s.maxTokens || 8192,
    thinking: s.thinking || 'auto',
  };

  const t = stored[TOOLS_KEY] || {};
  state.tools = {
    ffmpegPath: t.ffmpegPath || '',
    ytdlpPath: t.ytdlpPath || '',
    downloadDir: t.downloadDir || '',
  };
  return state.provider;
}

async function saveSettings() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: state.provider,
    [TOOLS_KEY]: state.tools,
  });
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
  $('sel-thinking').value = p.thinking || 'auto';
  // 只有支持思考模式的服务商才显示这个选项
  $('thinking-field').hidden = !resolveProvider(p).supportsThinking;

  const t = state.tools;
  $('inp-ffmpeg').value = t.ffmpegPath || '';
  $('inp-ytdlp').value = t.ytdlpPath || '';
  $('inp-dl-dir').value = t.downloadDir || '';

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
  el.sessionDrawer.hidden = true;
  syncSettingsForm();
  el.settings.hidden = false;
  refreshToolStatus();
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

// ---------------------------------------------------------------------------
// 会话管理（持久化 + 标签页轻关联）
//
// 设计取舍：会话默认是「全局一条时间线」，不会因为切标签页就硬切会话
// （那会打断正在跑的 agent，也容易把上下文切碎）。标签页只做轻关联：
//   · 每条会话记住它开始时的标签页，列表里显示站点；
//   · 发消息时把「当前标签页 → 会话」记到 storage.session；
//   · 打开「跟随标签页」后，切回某标签页会恢复它上次用的会话；
//   · 没有绑定的标签页保持当前会话，不新建空会话。
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(text) {
  el.statusHint.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.statusHint.textContent = '';
  }, 2500);
}

function hostOf(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function formatWhen(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

async function activeTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    return { id: tab.id, url: tab.url || '', title: tab.title || '' };
  } catch {
    return null;
  }
}

function firstUserText(messages) {
  for (const m of messages || []) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      if (m.content.trim()) return m.content;
      continue;
    }
    const t = (m.content || [])
      .filter((b) => b?.type === 'text' && b.text)
      .map((b) => b.text)
      .join(' ');
    if (t.trim()) return t;
  }
  return '';
}

/** 把恢复出来的消息重绘成气泡（工具调用细节不展开，只留一行说明）。 */
function renderHistory(messages) {
  for (const m of messages || []) {
    const blocks =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const text = blocks
      .filter((b) => b?.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
    if (m.role === 'user') {
      if (text.trim()) renderMessage('user', text);
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (text.trim()) renderMessage('assistant', text);
    const toolCount = blocks.filter((b) => b?.type === 'tool_use').length;
    if (toolCount) {
      const note = document.createElement('div');
      note.className = 'msg-note';
      note.textContent = `（本轮调用了 ${toolCount} 个工具，详情未保存）`;
      el.messages.appendChild(note);
    }
  }
  scrollToBottom();
}

function updateSessionChrome() {
  const host = hostOf(state.sessionTab?.url);
  el.sessions.title = `会话：${state.sessionTitle}${host ? `（${host}）` : ''}`;
  el.sessionCurrent.textContent = host
    ? `当前：${state.sessionTitle} · 来源 ${host}`
    : `当前：${state.sessionTitle}`;
}

async function renderSessionList() {
  if (!state.sessionStore || !el.sessionList) return;
  const items = await state.sessionStore.list();
  el.sessionList.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 's-empty';
    empty.textContent = '还没有保存的会话。发送第一条消息后会自动保存。';
    el.sessionList.appendChild(empty);
    updateSessionChrome();
    return;
  }
  for (const s of items) {
    const host = hostOf(s.tab?.url);
    const row = document.createElement('div');
    row.className = `s-row${s.id === state.sessionId ? ' active' : ''}`;
    row.dataset.id = s.id;
    row.innerHTML =
      '<div class="s-main">' +
      '<div class="s-title"></div>' +
      '<div class="s-meta">' +
      (host ? `<span class="s-host">${escapeHtml(host)}</span> · ` : '') +
      `${formatWhen(s.updatedAt)} · ${s.messageCount || 0} 条` +
      '</div>' +
      '</div>' +
      '<button class="icon-btn tiny s-del" title="删除会话">✕</button>';
    const titleEl = row.querySelector('.s-title');
    titleEl.textContent = s.title || '未命名会话';
    titleEl.title = '双击重命名';
    titleEl.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const name = prompt('重命名会话', s.title || '');
      if (!name || !name.trim()) return;
      await state.sessionStore.renameSession(s.id, name.trim());
      if (s.id === state.sessionId) {
        state.sessionTitle = name.trim();
        updateSessionChrome();
      }
      await renderSessionList();
    });
    row.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSession(s.id);
    });
    row.addEventListener('click', async () => {
      if (state.busy) {
        toast('对话进行中，稍后再切换会话');
        return;
      }
      if (s.id !== state.sessionId) await switchSession(s.id);
      el.sessionDrawer.hidden = true;
    });
    el.sessionList.appendChild(row);
  }
  updateSessionChrome();
}

async function switchSession(id, { render = true } = {}) {
  if (!state.sessionStore) return false;
  const s = await state.sessionStore.load(id);
  if (!s) return false;
  state.sessionId = s.id;
  state.sessionTitle = s.title || '未命名会话';
  state.sessionCreatedAt = s.createdAt || Date.now();
  state.chatStartedAt = new Date(state.sessionCreatedAt).toISOString();
  state.sessionTab = s.tab || null;
  state.messages = Array.isArray(s.messages) ? s.messages : [];
  await state.sessionStore.setCurrent(s.id);
  if (render) {
    el.messages.innerHTML = '';
    el.tray.hidden = true;
    el.tray.innerHTML = '';
    renderHistory(state.messages);
  }
  updateSessionChrome();
  await renderSessionList();
  syncChatHistory();
  return true;
}

async function startBlankSession({ withCurrentTab = true } = {}) {
  state.sessionId = newSessionId();
  state.sessionTitle = '新会话';
  state.sessionCreatedAt = Date.now();
  state.chatStartedAt = new Date(state.sessionCreatedAt).toISOString();
  state.messages = [];
  state.sessionTab = null;
  if (withCurrentTab) {
    const tab = await activeTabInfo();
    if (tab) state.sessionTab = { url: tab.url, title: tab.title };
  }
  el.messages.innerHTML = '';
  el.tray.hidden = true;
  el.tray.innerHTML = '';
  updateSessionChrome();
  await renderSessionList();
  syncChatHistory();
}

/**
 * 把当前对话写进本地存储。
 * 只在有消息时保存 —— 空白会话不占用列表。
 */
async function persistCurrentSession() {
  if (!state.sessionStore || !state.messages.length) return;
  if (!state.sessionId) state.sessionId = newSessionId();
  if (!state.sessionTitle || state.sessionTitle === '新会话') {
    state.sessionTitle = deriveTitle(firstUserText(state.messages));
  }
  const tab = await activeTabInfo();
  if (!state.sessionTab && tab) state.sessionTab = { url: tab.url, title: tab.title };
  try {
    await state.sessionStore.saveSession({
      id: state.sessionId,
      title: state.sessionTitle,
      createdAt: state.sessionCreatedAt || Date.now(),
      tab: state.sessionTab,
      messages: state.messages,
    });
    await state.sessionStore.setCurrent(state.sessionId);
    if (tab?.id != null) await state.sessionStore.bindTab(tab.id, state.sessionId, tab.url);
  } catch (err) {
    console.warn('[nbc panel] 会话保存失败', err);
    toast('会话保存失败（存储空间可能已满）');
  }
  updateSessionChrome();
  await renderSessionList();
}

async function deleteSession(id) {
  if (state.busy) {
    toast('对话进行中，稍后再删除会话');
    return;
  }
  await state.sessionStore.removeSession(id);
  if (id === state.sessionId) {
    const rest = await state.sessionStore.list();
    if (rest.length) await switchSession(rest[0].id);
    else await startBlankSession();
  } else {
    await renderSessionList();
  }
}

async function initSessions() {
  state.sessionStore = createSessionStore(chrome.storage.local, chrome.storage.session);
  const prefs = await state.sessionStore.getPrefs();
  state.followTab = prefs.followTab !== false;
  el.followTab.checked = state.followTab;
  try {
    state.windowId = (await chrome.windows.getCurrent()).id;
  } catch { /* 拿不到窗口也不影响会话 */ }

  const tab = await activeTabInfo();
  let target = null;
  if (state.followTab && tab?.id != null) {
    target = await state.sessionStore.sessionForTab(tab.id, tab.url);
  }
  if (!target) target = await state.sessionStore.getCurrent();
  if (target && (await switchSession(target))) return;
  await startBlankSession();
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
  if (!state.chatStartedAt) state.chatStartedAt = new Date().toISOString();

  renderMessage('user', text);

  // 流式内容先以纯文本累积，结束后再按 Markdown 渲染，
  // 否则每次追加都会把已渲染的 Markdown 标签冲掉。
  const bubble = renderMessage('assistant', '');
  let acc = '';
  let reasoningAcc = '';
  let rendered = '';
  const toolCards = new Map();
  let lastError = null;

  // 思维链单独放一个可折叠区域，不与正式回答混在一起。
  const reasoningBox = document.createElement('details');
  reasoningBox.className = 'reasoning-box';
  reasoningBox.hidden = true;
  reasoningBox.innerHTML =
    '<summary>思考过程</summary><div class="reasoning-body"></div>';
  bubble.parentElement.insertBefore(reasoningBox, bubble);

  const pageCtx = await currentPageContext();
  const history = [...state.messages];
  history.push({ role: 'user', content: [Text(text)] });
  // 先把用户消息写进 state/本地存储：即使模型请求失败、或用户中途关掉面板，
  // 这条提问也不会凭空消失。
  state.messages = history;
  await persistCurrentSession();

  // 事件回调：函数式（agent.js 的约定）
  const events = {
    text: (t) => {
      acc += t;
      bubble.textContent = acc;
      scrollToBottom();
    },
    reasoning: (t) => {
      // 思考模式的思维链：单独折叠展示，不进对话历史
      reasoningAcc += t;
      reasoningBox.hidden = false;
      reasoningBox.querySelector('.reasoning-body').textContent = reasoningAcc;
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
        // 截图类结果：显示缩略图而不是几千行的 base64 文本
        const resultHtml = ev.imageDataUrl
          ? `<div class="tool-section"><h4>截图</h4><img class="tool-shot" src="${ev.imageDataUrl}" alt="截图" /></div>` +
            `<div class="tool-section"><h4>结果</h4><pre>${escapeHtml(JSON.stringify(ev.output ?? {}, null, 2))}</pre></div>`
          : `<div class="tool-section"><h4>入参</h4><pre>${escapeHtml(JSON.stringify(toolCards.get(ev.id)?.input ?? {}, null, 2))}</pre></div>` +
            `<div class="tool-section"><h4>结果</h4><pre>${escapeHtml(typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? {}, null, 2))}</pre></div>`;
        card.querySelector('.tool-body').innerHTML = resultHtml;
      }
      const rows = el.tray.querySelectorAll('.t-row');
      const row = rows[rows.length - 1];
      if (row) {
        row.innerHTML = `<span class="t-name">${escapeHtml(ev.name)}</span> ${ev.isError ? '<span style="color:var(--err)">失败</span>' : '完成'}`;
      }
    },
    error: (ev) => {
      // agent.js 在抛错前会先发 error 事件，随后 catch 块也会写一次。
      // 这里只记录不展示，避免同一个错误显示两遍。
      lastError = ev.error;
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
    await persistCurrentSession();
    await saveSettings();
    syncChatHistory();
  } catch (err) {
    if (err?.name === 'AbortError') {
      acc += '\n（已中断）';
    } else {
      const msg = err?.message || String(err);
      const detail = err?.detail ? `\n${String(err.detail).slice(0, 400)}` : '';
      acc += `\n[错误] ${msg}${detail}`;
    }
  } finally {
    // 最终按 Markdown 渲染（流式阶段是纯文本，避免标签闪烁）。
    rendered = renderMarkdown(acc);
    bubble.innerHTML = rendered;
    bubble.classList.remove('is-reasoning');
    // 思维链也按 Markdown 渲染
    if (reasoningAcc) {
      reasoningBox.querySelector('.reasoning-body').innerHTML = renderMarkdown(reasoningAcc);
    } else {
      reasoningBox.remove();
    }
    state.busy = false;
    state.controller = null;
    el.send.disabled = false;
    el.input.focus();
    scrollToBottom();
    // 失败/中断时历史里可能只有用户消息，也同步一份给 chat.export
    syncChatHistory();
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

el.clear.addEventListener('click', async () => {
  if (state.busy) return;
  // 不再直接丢弃：旧会话留在「会话」记录里，这里只是开一条新的。
  await startBlankSession();
  el.input.focus();
});

// ---------- 会话抽屉 ----------
el.sessions.addEventListener('click', async () => {
  el.settings.hidden = true;
  await renderSessionList();
  el.sessionDrawer.hidden = false;
});

el.closeSessions.addEventListener('click', () => {
  el.sessionDrawer.hidden = true;
});

el.newSession.addEventListener('click', async () => {
  if (state.busy) {
    toast('对话进行中，稍后再新建会话');
    return;
  }
  await startBlankSession();
  el.sessionDrawer.hidden = true;
  el.input.focus();
});

el.followTab.addEventListener('change', async () => {
  state.followTab = el.followTab.checked;
  await state.sessionStore?.setPrefs({ followTab: state.followTab });
  toast(state.followTab ? '已开启：切换标签页时恢复该页会话' : '已关闭标签页跟随');
});

// 标签页切换：恢复该标签页上次使用的会话（轻关联，不新建空会话）
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!state.followTab || state.busy || !state.sessionStore) return;
  if (state.windowId != null && windowId !== state.windowId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const sid = await state.sessionStore.sessionForTab(tabId, tab?.url);
  if (!sid || sid === state.sessionId) return;
  if (await switchSession(sid)) toast(`已切换到「${state.sessionTitle}」`);
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
  state.provider.thinking = $('sel-thinking').value;

  state.tools.ffmpegPath = $('inp-ffmpeg').value.trim();
  state.tools.ytdlpPath = $('inp-ytdlp').value.trim();
  state.tools.downloadDir = $('inp-dl-dir').value.trim();

  await saveSettings();
  updateProviderBar();

  // 把本地工具路径推送给 companion（扩展不能直接调本地程序）。
  const pushed = await pushToolConfig(state.tools);
  $('save-status').textContent = pushed.ok ? '已保存 ✓' : '已保存（companion 未运行）';
  setTimeout(() => ($('save-status').textContent = ''), 2200);
});

/** 读取当前输入框里的本地工具配置。 */
function currentToolsConfig() {
  return {
    ffmpegPath: $('inp-ffmpeg').value.trim(),
    ytdlpPath: $('inp-ytdlp').value.trim(),
    downloadDir: $('inp-dl-dir').value.trim(),
  };
}

function setStatus(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.style.color = ok === true ? 'var(--ok)' : ok === false ? 'var(--err)' : '';
}

/** 检测本地程序路径（需要 companion 参与）。 */
async function detect(kind) {
  const cfg = currentToolsConfig();
  const statusId =
    kind === 'ffmpeg' ? 'ffmpeg-status' : kind === 'ytdlp' ? 'ytdlp-status' : 'dl-dir-status';
  setStatus(statusId, '检测中…');

  const res = await detectTools(cfg);
  if (!res.ok) {
    setStatus(statusId, `${res.error}。${res.hint || ''} 请先运行 node companion/server.mjs`, false);
    return;
  }

  const d = res.data || {};
  if (kind === 'ffmpeg') {
    const f = d.ffmpeg;
    setStatus(
      'ffmpeg-status',
      f.ok ? `✓ 可用：${f.version || '已检测到'}` : `✗ 不可用：${f.reason}`,
      f.ok
    );
  } else if (kind === 'ytdlp') {
    const y = d.ytdlp;
    setStatus(
      'ytdlp-status',
      y.ok ? `✓ 可用：${y.version || '已检测到'}` : `✗ 不可用：${y.reason}`,
      y.ok
    );
  } else {
    const dd = d.downloadDir;
    setStatus(
      'dl-dir-status',
      dd?.ok ? `✓ 目录可用：${dd.path}` : `✗ 不可用：${dd?.reason || '未知'}`,
      dd?.ok
    );
  }
}

$('btn-test-conn').addEventListener('click', async () => {
  const btn = $('btn-test-conn');
  const status = $('conn-status');
  btn.disabled = true;
  btn.textContent = '测试中…';
  status.textContent = '';
  status.style.color = '';

  const provider = {
    providerId: state.provider.providerId,
    kind: state.provider.kind,
    baseUrl: $('inp-baseurl').value.trim(),
    apiKey: $('inp-key').value.trim(),
    model: $('inp-model').value.trim(),
    transport: $('sel-transport').value,
    relayUrl: $('inp-relay').value.trim(),
    noKey: PRESET_MAP[state.provider.providerId]?.noKey,
  };

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'nbc:tool',
      name: 'diagnose.connection',
      args: { provider },
    });
    if (!res?.ok) {
      status.textContent = `诊断失败：${res?.error || '未知错误'}`;
      status.style.color = 'var(--err)';
    } else {
      const direct = res.data.tests.find((t) => t.path === 'direct');
      const relay = res.data.tests.find((t) => t.path === 'relay');
      const lines = [];
      if (direct) {
        lines.push(
          direct.ok
            ? `✓ 直连正常（${direct.ms}ms）${direct.note ? ' · ' + direct.note : ''}`
            : `✗ 直连失败：${direct.error || direct.note}`
        );
      }
      if (relay) {
        lines.push(
          relay.ok
            ? `✓ 本地中继可用（${relay.ms}ms）`
            : `✗ 本地中继不可用：${relay.error || relay.note}`
        );
      }
      status.textContent = lines.join('\n');
      status.style.color = direct?.ok ? 'var(--ok)' : 'var(--err)';
    }
  } catch (e) {
    status.textContent = `测试失败：${e?.message || e}`;
    status.style.color = 'var(--err)';
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
});

$('btn-start-companion').addEventListener('click', async () => {
  const btn = $('btn-start-companion');
  btn.disabled = true;
  btn.textContent = '启动中…';
  const res = await chrome.runtime.sendMessage({ type: 'nbc:companion:start' });
  if (res?.ok) {
    $('companion-status').textContent =
      'companion 状态：已' + (res.alreadyRunning ? '在运行' : '启动');
    await refreshToolStatus();
  } else {
    $('companion-status').textContent = `companion 状态：启动失败（${res?.error || '未知'}）`;
    console.warn('[nbc] 启动 companion 失败', res);
  }
  btn.disabled = false;
  btn.hidden = !res?.ok; // 失败时保持按钮可见以便重试
});

$('btn-detect-ffmpeg').addEventListener('click', () => detect('ffmpeg'));
$('btn-detect-ytdlp').addEventListener('click', () => detect('ytdlp'));
$('btn-detect-dir').addEventListener('click', () => detect('dir'));

/** 打开设置时，从 companion 拉一次已保存的配置。 */
async function refreshToolStatus() {
  const res = await fetchToolConfig();
  const compStatus = $('companion-status');
  const startBtn = $('btn-start-companion');
  if (!res.ok) {
    setStatus('ffmpeg-status', 'companion 未运行 —— 本地工具功能不可用', false);
    setStatus('ytdlp-status', 'companion 未运行', false);
    compStatus.textContent = 'companion 状态：未运行';
    startBtn.hidden = false; // 显示「启动」按钮（走 Native Messaging 拉起）
    return;
  }
  compStatus.textContent = 'companion 状态：运行中（' + res.data?.config?.downloadDir + '）';
  startBtn.hidden = true;
  const c = res.data?.config || {};
  const f = c.ffmpegDetected || {};
  const y = c.ytdlpDetected || {};
  setStatus(
    'ffmpeg-status',
    c.ffmpegPath
      ? f.ok
        ? `✓ 可用：${f.version || ''}`
        : `✗ 不可用：${f.reason}`
      : '未配置（下载 HLS/DASH 视频流时才需要）',
    c.ffmpegPath ? f.ok : null
  );
  setStatus(
    'ytdlp-status',
    c.ytdlpPath ? (y.ok ? `✓ 可用：${y.version || ''}` : `✗ 不可用：${y.reason}`) : '未配置（可选）',
    c.ytdlpPath ? y.ok : null
  );
  setStatus(
    'dl-dir-status',
    c.downloadDir
      ? c.downloadDirExists
        ? `✓ ${c.downloadDir}`
        : `✗ 目录不存在：${c.downloadDir}`
      : '未配置',
    c.downloadDir ? c.downloadDirExists : null
  );
  // 用 companion 里的配置回填输入框（只在输入框为空时，避免覆盖用户正在编辑的内容）
  if (!$('inp-ffmpeg').value && c.ffmpegPath) $('inp-ffmpeg').value = c.ffmpegPath;
  if (!$('inp-ytdlp').value && c.ytdlpPath) $('inp-ytdlp').value = c.ytdlpPath;
  if (!$('inp-dl-dir').value && c.downloadDir) $('inp-dl-dir').value = c.downloadDir;
}

$('btn-clear-storage').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  try {
    await chrome.storage.session.clear();
  } catch { /* 旧版本可能没有 storage.session */ }
  state.messages = [];
  state.sessionId = null;
  state.sessionTitle = '新会话';
  state.sessionCreatedAt = null;
  state.sessionTab = null;
  await loadSettings();
  syncSettingsForm();
  updateProviderBar();
  await startBlankSession();
  $('save-status').textContent = '已清除';
});

// 来自右键菜单的提问
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'nbc:ui:ask') {
    el.input.value = msg.text || '';
    el.input.focus();
    el.input.dispatchEvent(new Event('input'));
  }
  if (msg?.type === 'nbc:ui:selection') {
    showSelection(msg.info);
  }
});

// ---------------------------------------------------------------------------
// 对话历史同步与导出
// ---------------------------------------------------------------------------

/** 把对话历史同步给后台，供 chat.export 工具读取。 */
async function syncChatHistory() {
  try {
    await chrome.runtime.sendMessage({
      type: 'nbc:chat:sync',
      messages: state.messages,
      meta: {
        model: state.provider?.model,
        provider: state.provider?.label || state.provider?.providerId,
        startedAt: state.chatStartedAt,
      },
    });
  } catch { /* 后台未就绪，忽略 */ }
}

/** 导出当前对话为 Markdown。 */
async function exportChat() {
  if (!state.messages.length) {
    el.statusHint.textContent = '还没有对话可导出';
    setTimeout(() => (el.statusHint.textContent = ''), 2000);
    return;
  }
  await syncChatHistory();
  const res = await chrome.runtime.sendMessage({
    type: 'nbc:tool',
    name: 'chat.export',
    args: { format: 'md' },
  });
  if (res?.ok) {
    el.statusHint.textContent = `已导出：${res.data.filename}`;
  } else {
    el.statusHint.textContent = `导出失败：${res?.error || '未知错误'}`;
  }
  setTimeout(() => (el.statusHint.textContent = ''), 3000);
}

// ---------------------------------------------------------------------------
// 下载队列
// ---------------------------------------------------------------------------

const QUEUE_ICON = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
  cancelled: '—',
};

function renderQueue(queue) {
  if (!queue) return;
  const total = queue.total || 0;
  const hasItems = total > 0;
  el.queuePanel.hidden = !hasItems;
  if (!hasItems) return;

  el.queueSummary.textContent =
    `${queue.done || 0}/${total} 完成` +
    (queue.failed ? ` · ${queue.failed} 失败` : '') +
    (queue.pending ? ` · ${queue.pending} 等待` : '') +
    (queue.bytes ? ` · ${formatBytes(queue.bytes)}` : '');

  el.queueToggle.textContent = queue.paused ? '继续' : '暂停';

  el.queueList.innerHTML = '';
  for (const item of queue.items || []) {
    const wrap = document.createElement('div');
    wrap.className = 'q-item-wrap';

    const row = document.createElement('div');
    row.className = 'q-item';

    const name = document.createElement('span');
    name.className = 'q-name';
    name.textContent = item.filename || item.url;
    name.title = item.url;

    const status = document.createElement('span');
    status.className = `q-status ${item.status}`;
    status.textContent =
      item.status === 'failed'
        ? QUEUE_ICON.failed + ' ' + (item.error || '失败')
        : QUEUE_ICON[item.status] || '';

    row.append(name, status);
    wrap.appendChild(row);

    // 进度条
    if (item.status === 'running' && item.totalBytes > 0) {
      const bar = document.createElement('div');
      bar.className = 'q-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, (item.bytes / item.totalBytes) * 100)}%`;
      bar.appendChild(fill);
      wrap.appendChild(bar);
    }

    el.queueList.appendChild(wrap);
  }
}

// 队列事件（后台广播）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'nbc:queue:update') renderQueue(msg.queue);
});

$('btn-export-chat').addEventListener('click', exportChat);

$('btn-queue-close').addEventListener('click', () => {
  el.queuePanel.hidden = true;
});

$('btn-queue-toggle').addEventListener('click', async () => {
  const paused = el.queueToggle.textContent === '继续';
  await chrome.runtime.sendMessage({
    type: 'nbc:tool',
    name: 'download.queue',
    args: { action: paused ? 'resume' : 'pause' },
  });
});

$('btn-queue-clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'nbc:tool',
    name: 'download.queue',
    args: { action: 'clear' },
  });
});

// 启动时拉一次队列状态
async function refreshQueue() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'nbc:tool',
      name: 'download.queue',
      args: { action: 'status' },
    });
    if (res?.ok) renderQueue(res.data?.queue);
  } catch { /* 后台未就绪，忽略 */ }
}

// ---------------------------------------------------------------------------
// 划词提问
// ---------------------------------------------------------------------------

function showSelection(info) {
  if (!info?.text) return;
  state.selection = info;
  el.selectionText.textContent = info.text;
  el.selectionBar.hidden = false;
}

$('btn-close-selection').addEventListener('click', () => {
  el.selectionBar.hidden = true;
  state.selection = null;
});

$('btn-ask-selection').addEventListener('click', () => {
  const sel = state.selection;
  if (!sel) return;
  const quoted = sel.text.length > 300 ? sel.text.slice(0, 300) + '…' : sel.text;
  el.input.value = `关于这段内容：\n「${quoted}」\n\n`;
  el.selectionBar.hidden = true;
  el.input.focus();
  el.input.dispatchEvent(new Event('input'));
  el.input.setSelectionRange(el.input.value.length, el.input.value.length);
});

/** 侧边栏打开时，主动检查当前页面是否已有选区。 */
async function checkCurrentSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
    // 走后台的 MAIN world 查询 —— 隔离世界读不到真实选区。
    const res = await chrome.runtime.sendMessage({
      type: 'nbc:tool',
      name: 'page.selection',
      args: { tabId: tab.id },
    });
    if (res?.ok && res.data?.text) showSelection(res.data);
  } catch {
    // 页面不支持或未注入，忽略
  }
}

/**
 * 调用一个浏览器工具。
 * 优先走后台消息通道；若后台正在重启导致无响应，
 * 直接用 scripting 在页面里取（只支持少数无需后台权限的工具）。
 */
async function callTool(name, args = {}) {
  const res = await chrome.runtime.sendMessage({ type: 'nbc:tool', name, args });
  if (!res) throw new Error('后台无响应（service worker 可能正在重启，请重试）');
  if (!res.ok) throw new Error(res.error || '工具执行失败');
  return res.data;
}

// 快捷键：Ctrl+Shift+K 由 manifest commands 处理，这里只做聚焦兜底
chrome.commands?.onCommand?.addListener?.(() => el.input.focus());

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  await loadSettings();
  await initSessions();
  fillProviderSelect();
  updateProviderBar();
  el.input.focus();
  checkCurrentSelection();
  refreshQueue();

  if (
    !state.provider.apiKey &&
    !PRESET_MAP[state.provider.providerId]?.noKey &&
    !state.messages.length
  ) {
    el.messages.innerHTML =
      '<div class="msg assistant"><div class="bubble">' +
      '👋 欢迎使用 NetBrowserClaw。\n\n' +
      '点击右上角 ⚙ 按钮，选择模型服务商并填入你的 API Key。' +
      '本扩展完全开源、无需订阅，也不会把 Key 上传到任何第三方。' +
      '</div></div>';
  }
})();
