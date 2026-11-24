// 会话持久化：把侧边栏的对话存进 chrome.storage.local，
// 关闭面板、刷新页面、重启浏览器后都能恢复。
//
// 存储结构（列表与正文分开，列会话时不必读出全部消息）：
//   nbc:sessions          -> [{id,title,createdAt,updatedAt,messageCount,tab}]
//   nbc:session:<id>      -> {id,title,createdAt,updatedAt,tab,messages}
//   nbc:sessions:current  -> 最近一次使用的会话 id
//   nbc:sessionPrefs      -> {followTab:boolean}
//
// 标签页绑定放在 chrome.storage.session：标签页 ID 只在一次浏览器会话内有效，
// 浏览器关闭后自动清空，正好避免 ID 复用导致「串会话」。
//
// 写入策略：截图与超长工具输出会被裁剪。对话历史里不该长期保存 base64
// （一张截图 ≈ 25 万 token / 数十万字符），旧工具结果对后续对话也没有价值。

export const LIST_KEY = 'nbc:sessions';
export const CURRENT_KEY = 'nbc:sessions:current';
export const PREFS_KEY = 'nbc:sessionPrefs';
export const TABMAP_KEY = 'nbc:tabSessions';

const SESSION_PREFIX = 'nbc:session:';

export const MAX_SESSIONS = 20;
export const MAX_MESSAGES = 120;
export const MAX_TEXT = 20000;
export const MAX_TOOL_RESULT = 2000;
export const MAX_SESSION_CHARS = 300000;
export const IMAGE_PLACEHOLDER = '[截图已省略]';

export function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 用第一条用户消息生成会话标题。 */
export function deriveTitle(text, max = 32) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '新会话';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clip(s, max) {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.length > max ? `${str.slice(0, max)}…[已截断]` : str;
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (typeof msg.content === 'string') {
    return { ...msg, content: clip(msg.content, MAX_TEXT) };
  }
  const content = (msg.content || []).map((b) => {
    if (!b || typeof b !== 'object') return b;
    if (b.type === 'image') return { type: 'text', text: IMAGE_PLACEHOLDER };
    if (b.type === 'text') return { ...b, text: clip(b.text, MAX_TEXT) };
    if (b.type === 'tool_result') {
      const body =
        typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null);
      return { ...b, content: clip(body, MAX_TOOL_RESULT) };
    }
    return b;
  });
  return { ...msg, content };
}

/** 持久化前的消息清理：裁掉截图 base64、截断超长文本、限制条数与总量。 */
export function sanitizeMessages(messages) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  const cleaned = list.map(sanitizeMessage);
  // 再按总字符预算从旧到新裁剪：单条都合规、但 120 条 × 2 万字仍可能超配额。
  let total = 0;
  const kept = [];
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const size = JSON.stringify(cleaned[i]).length;
    if (total + size > MAX_SESSION_CHARS && kept.length >= 2) break;
    total += size;
    kept.unshift(cleaned[i]);
  }
  return kept;
}

function hostOf(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function normTab(tab) {
  if (!tab || !tab.url) return null;
  return { url: String(tab.url), title: clip(tab.title || '', 120) };
}

function metaOf(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount ?? session.messages?.length ?? 0,
    tab: session.tab || null,
  };
}

/**
 * 创建会话仓库。
 * @param {{get:Function,set:Function,remove:Function}} storage  chrome.storage.local
 * @param {{get:Function,set:Function,remove:Function}} [sessionStorage] chrome.storage.session
 */
export function createSessionStore(storage, sessionStorage = null) {
  // 所有写操作串行化，避免「读列表 → 改 → 写回」并发覆盖
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function read(key, fallback) {
    try {
      const got = await storage.get(key);
      return got?.[key] === undefined ? fallback : got[key];
    } catch {
      return fallback;
    }
  }

  async function write(obj) {
    await storage.set(obj);
  }

  async function readList() {
    const arr = await read(LIST_KEY, []);
    return Array.isArray(arr) ? arr : [];
  }

  async function writeList(list) {
    await write({ [LIST_KEY]: list });
  }

  async function readTabMap() {
    if (!sessionStorage) return {};
    try {
      const got = await sessionStorage.get(TABMAP_KEY);
      return got?.[TABMAP_KEY] || {};
    } catch {
      return {};
    }
  }

  async function writeTabMap(map) {
    if (!sessionStorage) return;
    try {
      await sessionStorage.set({ [TABMAP_KEY]: map });
    } catch { /* storage.session 不可用时忽略 */ }
  }

  async function dropBindings(ids) {
    if (!sessionStorage || !ids.length) return;
    const map = await readTabMap();
    let changed = false;
    for (const [tabId, entry] of Object.entries(map)) {
      if (!entry || ids.includes(entry.sessionId)) {
        delete map[tabId];
        changed = true;
      }
    }
    if (changed) await writeTabMap(map);
  }

  return {
    async list() {
      const list = await readList();
      return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async load(id) {
      if (!id) return null;
      const s = await read(SESSION_PREFIX + id, null);
      return s && s.id ? s : null;
    },

    /** 保存整段会话；同时更新索引并在超出上限时删除最旧的会话。 */
    saveSession(session) {
      return serial(async () => {
        const messages = sanitizeMessages(session.messages);
        const now = Date.now();
        const full = {
          id: session.id,
          title: session.title || '新会话',
          createdAt: session.createdAt || now,
          updatedAt: now,
          tab: normTab(session.tab),
          messages,
          messageCount: messages.length,
        };
        const list = await readList();
        const next = [metaOf(full), ...list.filter((m) => m.id !== full.id)].sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
        const dropped = next.slice(MAX_SESSIONS);
        const kept = next.slice(0, MAX_SESSIONS);
        await write({
          [SESSION_PREFIX + full.id]: full,
          [LIST_KEY]: kept,
        });
        if (dropped.length) {
          await storage.remove(dropped.map((m) => SESSION_PREFIX + m.id));
          await dropBindings(dropped.map((m) => m.id));
        }
        return full;
      });
    },

    async renameSession(id, title) {
      return serial(async () => {
        const full = await read(SESSION_PREFIX + id, null);
        if (!full) return null;
        full.title = String(title || '').trim() || full.title;
        full.updatedAt = Date.now();
        await write({ [SESSION_PREFIX + id]: full });
        const list = await readList();
        await writeList(
          list.map((m) => (m.id === id ? { ...m, title: full.title, updatedAt: full.updatedAt } : m))
        );
        return full;
      });
    },

    async removeSession(id) {
      return serial(async () => {
        const list = await readList();
        await storage.remove(SESSION_PREFIX + id);
        await writeList(list.filter((m) => m.id !== id));
        await dropBindings([id]);
        const current = await read(CURRENT_KEY, null);
        if (current === id) await storage.remove(CURRENT_KEY);
        return { ok: true };
      });
    },

    async getCurrent() {
      return read(CURRENT_KEY, null);
    },

    async setCurrent(id) {
      if (!id) await storage.remove(CURRENT_KEY);
      else await write({ [CURRENT_KEY]: id });
    },

    async getPrefs() {
      const p = await read(PREFS_KEY, {});
      return { followTab: p?.followTab !== false };
    },

    async setPrefs(patch) {
      const p = await read(PREFS_KEY, {});
      const next = { ...p, ...patch };
      await write({ [PREFS_KEY]: next });
      return next;
    },

    /** 把标签页和会话绑定（发送消息时调用）。 */
    async bindTab(tabId, sessionId, url) {
      if (tabId == null || !sessionId) return;
      const map = await readTabMap();
      map[tabId] = { sessionId, host: hostOf(url), at: Date.now() };
      await writeTabMap(map);
    },

    /**
     * 查标签页绑定的会话。
     * 传入当前 URL 时会校验站点是否一致 —— 标签页 ID 可能被新标签复用，
     * 站点对不上就丢弃这条绑定。
     */
    async sessionForTab(tabId, url) {
      const map = await readTabMap();
      const entry = map[tabId];
      if (!entry?.sessionId) return null;
      const host = hostOf(url);
      if (url && entry.host && host && entry.host !== host) {
        delete map[tabId];
        await writeTabMap(map);
        return null;
      }
      const list = await readList();
      if (!list.some((m) => m.id === entry.sessionId)) {
        delete map[tabId];
        await writeTabMap(map);
        return null;
      }
      return entry.sessionId;
    },
  };
}
