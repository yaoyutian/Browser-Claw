// 站点样式规则持久化。
//
// 需求：用户给某个网站改过版（深色模式、隐藏广告、调字号）后，
// 希望下次访问该站自动生效，不用每次重新说一遍。
//
// 设计：
//   · 规则按「主机名」存储（不含 www.），存在 chrome.storage.local
//   · 规则内容复用 style-agent 的同一套 CSS，因此可以随时增删改
//   · 页面导航后由后台通过 webNavigation 触发自动应用
//   · 规则可被用户在设置里查看/删除

import { hostMatches } from '../shared/util.js';

const STORAGE_KEY = 'nbc:siteRules';

/** 取规则存储的完整对象：{ [host]: { rules: [...], updatedAt } } */
async function getAll() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || {};
}

async function setAll(all) {
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

/** 规范化主机名：去掉 www. 前缀，保留端口以外的部分。 */
function normalizeHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 保存某站点的一组规则。 */
export async function saveSiteRules(url, rules) {
  const host = normalizeHost(url);
  if (!host) throw new Error('无效的 URL');
  const all = await getAll();
  all[host] = {
    rules: rules.filter((r) => r?.css),
    updatedAt: Date.now(),
  };
  await setAll(all);
  return { host, count: all[host].rules.length };
}

/** 读取某站点（及其父域）的规则。 */
export async function getSiteRules(url) {
  const host = normalizeHost(url);
  if (!host) return [];
  const all = await getAll();
  // 先找精确匹配，再找父域（example.com 的规则也适用于 a.example.com）
  const candidates = [host];
  const parts = host.split('.');
  if (parts.length > 2) candidates.push(parts.slice(-2).join('.'));
  for (const c of candidates) {
    if (all[c]?.rules?.length) return all[c].rules;
  }
  return [];
}

/** 列出所有站点规则。 */
export async function listSiteRules() {
  const all = await getAll();
  return Object.entries(all).map(([host, v]) => ({
    host,
    count: v.rules?.length || 0,
    updatedAt: v.updatedAt,
    rules: v.rules || [],
  }));
}

/** 删除某站点的全部规则。 */
export async function clearSiteRules(url) {
  const host = normalizeHost(url);
  const all = await getAll();
  if (!all[host]) return { removed: 0 };
  delete all[host];
  await setAll(all);
  return { removed: 1, host };
}

/** 删除某站点下的单条规则。 */
export async function removeSiteRule(url, name) {
  const host = normalizeHost(url);
  const all = await getAll();
  if (!all[host]?.rules?.length) return { removed: 0 };
  const before = all[host].rules.length;
  all[host].rules = all[host].rules.filter((r) => r.name !== name);
  const removed = before - all[host].rules.length;
  if (!all[host].rules.length) delete all[host];
  await setAll(all);
  return { removed, host };
}

/**
 * 页面加载完成后自动应用该站点的规则。
 * 通过 webNavigation 的 onCommitted 触发（DOM 已就绪，内容脚本已注入）。
 */
export async function applyRulesForTab(tabId, url) {
  const rules = await getSiteRules(url);
  if (!rules.length) return { applied: 0 };

  // 等待内容脚本就绪
  for (let i = 0; i < 12; i++) {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'nbc:style:applyRules', rules }).catch(() => null);
    if (res?.ok) {
      return { applied: res.data?.length || 0 };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { applied: 0 };
}

/** 注册导航监听，自动应用规则。 */
export function registerAutoApply() {
  chrome.webNavigation?.onCommitted?.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (!/^https?:/.test(details.url || '')) return;
    try {
      await applyRulesForTab(details.tabId, details.url);
    } catch { /* 忽略 */ }
  });

  // 同一标签页内的 SPA 路由切换也要应用
  chrome.webNavigation?.onHistoryStateUpdated?.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (!/^https?:/.test(details.url || '')) return;
    try {
      await applyRulesForTab(details.tabId, details.url);
    } catch { /* 忽略 */ }
  });
}
