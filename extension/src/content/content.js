// 内容脚本主入口：接收来自后台的工具调用，在页面上下文中执行。
// 所有页面级操作都收敛到这里，便于统一权限边界与错误处理。

(() => {
  if (window.__nbcContentReady) return;
  window.__nbcContentReady = true;

  const call = (fn, ...args) => {
    if (typeof fn !== 'function') throw new Error('函数不存在');
    return fn(...args);
  };

  /** 等待页面加载完成（限时）。 */
  const waitReady = (timeout = 8000) =>
    new Promise((resolve) => {
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, timeout);
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });

  /** 列出页面上可交互元素，供模型定位。 */
  function listInteractive(limit = 200) {
    const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [onclick], summary, [contenteditable=true]';
    const nodes = Array.from(document.querySelectorAll(sel));
    const out = [];
    for (const el of nodes) {
      if (out.length >= limit) break;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible =
        rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      if (!visible) continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      const id = el.id ? `#${CSS.escape(el.id)}` : '';
      const tag = el.tagName.toLowerCase();
      const cls = typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).map((c) => CSS.escape(c)).join('.')}`
        : '';
      out.push({
        index: out.length,
        tag,
        type: el.getAttribute('type') || '',
        selector: id ? `${tag}${id}` : `${tag}${cls}`,
        text,
        href: el.href || '',
        value: el.type === 'password' ? '***' : (el.value || '').slice(0, 80),
        placeholder: el.placeholder || '',
      });
    }
    return out;
  }

  /**
   * 执行一段页面 JS。
   * 注意：不能在这里直接用 new Function —— MV3 扩展的 CSP 默认禁止 'unsafe-eval'，
   * 会导致页面级 eval 工具全部失效。真正的执行交给后台在 MAIN world 中完成
   * （受页面自身 CSP 约束，行为与用户在该页面控制台执行一致）。
   */
  function evalJs(code) {
    throw new Error('EVAL_DELEGATED');
  }

  /** 滚动到元素或滚动到底部。 */
  async function scroll({ selector, to = 'bottom', behavior = 'smooth' }) {
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`找不到元素: ${selector}`);
      el.scrollIntoView({ behavior, block: 'center' });
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, scrolledTo: selector };
    }
    const before = window.scrollY;
    if (to === 'bottom') {
      window.scrollTo({ top: document.body.scrollHeight, behavior });
    } else if (to === 'top') {
      window.scrollTo({ top: 0, behavior });
    } else {
      window.scrollBy({ top: window.innerHeight * 0.9, behavior });
    }
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, from: before, to: window.scrollY };
  }

  /** 点击元素。 */
  async function click({ selector, index }) {
    let el = null;
    if (selector) el = document.querySelector(selector);
    else if (typeof index === 'number') {
      const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [onclick], summary';
      const nodes = Array.from(document.querySelectorAll(sel)).filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      el = nodes[index];
    }
    if (!el) throw new Error(`找不到要点击的元素 (selector=${selector}, index=${index})`);
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 80);
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    el.click();
    await new Promise((r) => setTimeout(r, 600));
    return { ok: true, clicked: label };
  }

  /** 填写输入框。 */
  async function fill({ selector, index, value, submit }) {
    let el = null;
    if (selector) el = document.querySelector(selector);
    else if (typeof index === 'number') {
      const nodes = Array.from(document.querySelectorAll('input, textarea, [contenteditable=true]'));
      el = nodes[index];
    }
    if (!el) throw new Error(`找不到输入框 (selector=${selector}, index=${index})`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      // 用原生 setter 触发框架的 change 事件（React/Vue 常见坑）。
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) {
      const form = el.closest('form');
      if (form) form.requestSubmit();
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    return { ok: true, filled: true };
  }

  /** 高亮元素，便于用户肉眼确认模型要操作的位置。 */
  function highlight({ selector, index, color = '#ff3b30' }) {
    let el = selector ? document.querySelector(selector) : null;
    if (!el && typeof index === 'number') {
      el = document.querySelectorAll('a[href],button,input,textarea,select,[role=button]')[index];
    }
    if (!el) throw new Error('找不到要高亮的元素');
    const old = el.getAttribute('data-nbc-highlight');
    if (old) el.style.outline = old;
    el.setAttribute('data-nbc-highlight', el.style.outline || '');
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';
    return { ok: true };
  }

  /** 提取表格数据。 */
  function extractTables() {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.slice(0, 30).map((t, i) => {
      const rows = Array.from(t.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((c) => c.textContent.replace(/\s+/g, ' ').trim())
      );
      const headers = rows.length ? rows[0] : [];
      const body = rows.slice(1);
      return { index: i, headers, rows: body, rowCount: body.length };
    });
  }

  /** 获取页面内所有图片。 */
  function extractImages(limit = 200) {
    return Array.from(document.images)
      .filter((img) => !img.src.startsWith('data:'))
      .slice(0, limit)
      .map((img, i) => ({
        index: i,
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight,
      }));
  }

  /** 读取页面中所有链接（用于「抓取站内文档」）。 */
  function extractLinks(filter = {}) {
    const all = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150),
        href: a.href,
      }))
      .filter((l) => l.href.startsWith('http'));
    let list = all;
    if (filter.ext) {
      const exts = String(filter.ext).toLowerCase().split(',').map((s) => s.trim().replace(/^\./, ''));
      list = list.filter((l) => {
        try {
          const m = new URL(l.href).pathname.match(/\.([a-z0-9]+)$/i);
          return m && exts.includes(m[1].toLowerCase());
        } catch {
          return false;
        }
      });
    }
    if (filter.sameOrigin !== false) {
      try {
        list = list.filter((l) => new URL(l.href).origin === location.origin);
      } catch { /* ignore */ }
    }
    if (filter.contains) {
      const needle = String(filter.contains).toLowerCase();
      list = list.filter((l) => (l.href + ' ' + l.text).toLowerCase().includes(needle));
    }
    return list.slice(0, filter.limit || 500);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case 'nbc:extract':
            await waitReady();
            sendResponse({ ok: true, data: call(window.__nbcExtractor.extract) });
            break;
          case 'nbc:media:list':
            sendResponse({ ok: true, data: call(window.__nbcMedia.list) });
            break;
          case 'nbc:media:clear':
            call(window.__nbcMedia.clear);
            sendResponse({ ok: true });
            break;
          case 'nbc:style:apply':
            sendResponse({ ok: true, data: call(window.__nbcStyleAgent.applyCss, msg.css, msg.options) });
            break;
          case 'nbc:style:preset':
            sendResponse({ ok: true, data: call(window.__nbcStyleAgent.applyPreset, msg.preset) });
            break;
          case 'nbc:style:hide':
            sendResponse({ ok: true, data: call(window.__nbcStyleAgent.hideElements, msg.selectors) });
            break;
          case 'nbc:style:list':
            sendResponse({ ok: true, data: call(window.__nbcStyleAgent.list) });
            break;
          case 'nbc:style:remove':
            sendResponse({ ok: true, data: { removed: call(window.__nbcStyleAgent.remove, msg.name) } });
            break;
          case 'nbc:style:clear':
            call(window.__nbcStyleAgent.clearAll);
            sendResponse({ ok: true });
            break;
          case 'nbc:interactive:list':
            sendResponse({ ok: true, data: listInteractive(msg.limit) });
            break;
          case 'nbc:click':
            sendResponse({ ok: true, data: await click(msg) });
            break;
          case 'nbc:fill':
            sendResponse({ ok: true, data: await fill(msg) });
            break;
          case 'nbc:scroll':
            sendResponse({ ok: true, data: await scroll(msg) });
            break;
          case 'nbc:highlight':
            sendResponse({ ok: true, data: highlight(msg) });
            break;
          case 'nbc:tables':
            sendResponse({ ok: true, data: extractTables() });
            break;
          case 'nbc:images':
            sendResponse({ ok: true, data: extractImages(msg.limit) });
            break;
          case 'nbc:links':
            sendResponse({ ok: true, data: extractLinks(msg.filter) });
            break;
          case 'nbc:eval':
            // 实际执行在后台的 MAIN world 中完成（扩展 CSP 禁止 unsafe-eval）。
            try {
              sendResponse({ ok: true, data: await evalJs(msg.code) });
            } catch (e) {
              sendResponse({
                ok: false,
                error: 'eval 需由后台在 MAIN world 执行，请通过 page.eval 工具调用',
              });
            }
            break;
          default:
            sendResponse({ ok: false, error: `未知指令: ${msg?.type}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err), stack: err?.stack });
      }
    })();
    return true; // 异步响应
  });
})();
