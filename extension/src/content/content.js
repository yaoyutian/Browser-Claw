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

  // -------------------------------------------------------------------------
  // 表格中的文档链接采集
  //
  // 真实场景：报表/清单类页面上，每一行、每一列都藏着一个文档下载链接，
  // 而表格本身分页。这类页面靠「找链接」很难定位，必须结合行/列上下文。
  // -------------------------------------------------------------------------

  /** 判断一个链接是否指向可下载文档。 */
  function isDocLink(a, exts) {
    if (!a.href || !/^(https?:|blob:)/.test(a.href)) return false;
    // 带 download 属性的链接一定是下载链接
    if (a.hasAttribute('download')) return true;
    if (!exts) return false;
    try {
      const p = new URL(a.href, location.href);
      const m = p.pathname.match(/\.([a-z0-9]+)$/i);
      return Boolean(m && exts.includes(m[1].toLowerCase()));
    } catch {
      return false;
    }
  }

  /**
   * 提取表格里的文档下载链接，并附带行/列上下文。
   * 返回结构便于模型理解「哪个文件的哪一列」，也便于生成有意义的文件名。
   */
  function extractTableDocs({ exts, tableIndex, limit } = {}) {
    const extList = exts
      ? String(exts).toLowerCase().split(',').map((s) => s.trim().replace(/^\./, '')).filter(Boolean)
      : null;

    const tables = Array.from(document.querySelectorAll('table'));
    const out = [];

    tables.forEach((table, ti) => {
      if (tableIndex != null && ti !== tableIndex) return;

      // 表头：优先 thead，其次第一行
      const headRow = table.querySelector('thead tr') || table.querySelector('tr');
      const headers = headRow
        ? Array.from(headRow.children).map((c) => c.textContent.replace(/\s+/g, ' ').trim())
        : [];

      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((tr, ri) => {
        // 跳过表头行
        if (tr === headRow) return;
        const cells = Array.from(tr.children);
        cells.forEach((cell, ci) => {
          for (const a of cell.querySelectorAll('a[href]')) {
            if (!isDocLink(a, extList)) continue;
            const href = a.href;
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            // 行标签：优先取该行第一列的文本（通常是名称/编号）
            const rowLabel = cells[0]?.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) || '';
            out.push({
              tableIndex: ti,
              rowIndex: ri,
              colIndex: ci,
              rowLabel,
              colHeader: headers[ci] || '',
              text,
              href,
              downloadAttr: a.getAttribute('download') || '',
              filename: a.getAttribute('download') || (text ? `${text}.pdf` : ''),
            });
          }
        });
      });
    });

    return out.slice(0, limit || 1000);
  }

  /** 找到分页控件里的「下一页」。 */
  function findNextButton() {
    const isDisabled = (el) => {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      // 自身或祖先带 disabled / off / inactive 类名
      const cls = `${el.className || ''} ${el.getAttribute('class') || ''}`;
      if (/(^|\s)(disabled|off|inactive|muted|pagination-disabled|ant-pagination-disabled)(\s|$)/i.test(cls)) {
        return true;
      }
      // 常见分页库把禁用态放在 li 上
      const li = el.closest('li');
      if (li && /(^|\s)(disabled|off|inactive)(\s|$)/i.test(li.className || '')) return true;
      // 祖先是 disabled 元素
      const fieldset = el.closest('fieldset[disabled]');
      if (fieldset) return true;
      // pointer-events: none 通常表示禁用
      const st = getComputedStyle(el);
      if (st.pointerEvents === 'none') return true;
      return false;
    };

    const selectors = [
      'a[rel="next"]',
      'button[rel="next"]',
      'a[aria-label*="next" i]',
      'button[aria-label*="next" i]',
      'a[title*="next" i]',
      'button[title*="next" i]',
      '.pagination a.next',
      '.pagination .next',
      '.pagination-next',
      'a.next-page',
      'button.next-page',
      '.page-item.next a',
      '.page-item.next button',
      'li.next > a',
      'li.next > button',
      '[class*="paginat"] a[class*="next"]',
      '[class*="paginat"] button[class*="next"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !isDisabled(el) && el.offsetParent !== null) return el;
    }

    // 文本匹配
    const textRe = /^(下一页|下页|后一页|下一頁|下\s*一\s*页|next|›|»|>|→)$/i;
    const candidates = Array.from(document.querySelectorAll('a, button, li, span')).filter((el) => {
      if (isDisabled(el)) return false;
      if (el.offsetParent === null) return false;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return textRe.test(t);
    });
    // 取最内层的匹配（避免点到包裹层）
    return candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
  }

  /**
   * 表格内容指纹。
   * 只用「行数 + 文本长度」不够：翻页后行数常常相同、长度也接近，
   * 会误判为「内容未变」而提前停止翻页。
   * 这里改用表头 + 前几行文本的内容哈希，翻页后几乎必然不同。
   */
  function tableSignature() {
    const tables = Array.from(document.querySelectorAll('table'));
    const parts = [];
    for (const t of tables) {
      const rows = Array.from(t.rows).slice(0, 5);
      parts.push(
        rows
          .map((r) => Array.from(r.cells).map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(''))
          .join('')
      );
    }
    return parts.join('');
  }

  /** 等待表格内容发生变化（翻页后加载）。 */
  function waitForTableChange(before, timeout = 4000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (tableSignature() !== before) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(false);
          return;
        }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
  }

  /** 找到分页控件里的「上一页」。 */
  function findPrevButton() {
    const isDisabled = (el) => {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      const cls = `${el.className || ''}`;
      if (/(^|\s)(disabled|off|inactive|muted)(\s|$)/i.test(cls)) return true;
      const li = el.closest('li');
      if (li && /(^|\s)(disabled|off|inactive)(\s|$)/i.test(li.className || '')) return true;
      return getComputedStyle(el).pointerEvents === 'none';
    };

    const selectors = [
      'a[rel="prev"]',
      'button[rel="prev"]',
      'a[aria-label*="prev" i]',
      'button[aria-label*="prev" i]',
      'a[title*="prev" i]',
      'button[title*="prev" i]',
      '.pagination a.prev',
      '.pagination .prev',
      'a.prev-page',
      'button.prev-page',
      '.page-item.prev a',
      '.page-item.prev button',
      'li.prev > a',
      'li.prev > button',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !isDisabled(el) && el.offsetParent !== null) return el;
    }

    const textRe = /^(上一页|上页|前一页|上一頁|上\s*一\s*页|prev|previous|‹|«|<|←)$/i;
    const candidates = Array.from(document.querySelectorAll('a, button, li, span')).filter((el) => {
      if (isDisabled(el)) return false;
      if (el.offsetParent === null) return false;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return textRe.test(t);
    });
    return candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
  }

  /**
   * 跨页采集表格中的文档链接。
   * 逐页点击「下一页」并累积，直到没有下一页或达到 maxPages。
   *
   * restartFromFirst：先点「上一页」回到第一页再开始，
   * 避免受当前停留页影响（否则重复调用只会拿到当前页往后的数据）。
   */
  async function collectTableDocs({ exts, maxPages = 10, waitMs = 1000, tableIndex, restartFromFirst = true } = {}) {
    const pages = [];
    const all = [];
    const seen = new Set();

    // 回到第一页。
    // 若「上一页」点了没反应（说明已在首页），立刻停止 —— 否则每次调用都要白等一个超时。
    if (restartFromFirst) {
      for (let i = 0; i < 30; i++) {
        const prev = findPrevButton();
        if (!prev) break;
        const before = tableSignature();
        prev.click();
        const changed = await waitForTableChange(before);
        if (!changed) break;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    for (let p = 0; p < Math.max(1, maxPages); p++) {
      const docs = extractTableDocs({ exts, tableIndex });
      for (const d of docs) {
        const key = `${d.href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ ...d, pageIndex: p + 1 });
      }
      pages.push({ page: p + 1, found: docs.length, total: all.length });

      if (p + 1 >= maxPages) break;
      const next = findNextButton();
      if (!next) break;

      const before = tableSignature();
      next.click();
      const changed = await waitForTableChange(before);
      await new Promise((r) => setTimeout(r, waitMs));
      if (!changed) {
        pages.push({ page: p + 2, note: '内容未变化，停止翻页' });
        break;
      }

      // 翻页后若「下一页」已失效，说明已到最后一页。
      if (!findNextButton()) {
        pages.push({ page: p + 2, note: '已到最后一页' });
        break;
      }
    }

    return { pages, total: all.length, items: all };
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
          case 'nbc:table:docs':
            sendResponse({ ok: true, data: extractTableDocs(msg) });
            break;
          case 'nbc:table:collect':
            sendResponse({ ok: true, data: await collectTableDocs(msg) });
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
