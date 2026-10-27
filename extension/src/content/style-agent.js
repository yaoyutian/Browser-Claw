// 样式改写代理：让模型可以「修改网站样式」。
//
// 关键设计：
// 1. 所有注入的 CSS 都挂在 <style data-nbc-style> 上，带独立 id，方便精确撤销。
// 2. 站点原生样式与注入样式分层：注入层优先级更高（!important 可控），
//    但撤销后完全恢复原状，不破坏页面。
// 3. 支持「按域名持久化」：某个网站的改版规则保存下来，下次访问自动生效。
// 4. 提供明暗主题、字号、宽度、隐藏元素等高频预设，模型不必每次写复杂 CSS。

(() => {
  if (window.__nbcStyleAgent) return;

  const STYLE_ATTR = 'data-nbc-style';
  let seq = 0;

  const ensureRoot = () => {
    let root = document.getElementById('nbc-style-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'nbc-style-root';
      root.setAttribute(STYLE_ATTR, 'root');
      (document.head || document.documentElement).appendChild(root);
    }
    return root;
  };

  function upsert(name, css) {
    const root = ensureRoot();
    let el = root.querySelector(`style[data-nbc-name="${CSS.escape(name)}"]`);
    if (!el) {
      el = document.createElement('style');
      el.setAttribute(STYLE_ATTR, 'rule');
      el.setAttribute('data-nbc-name', name);
      root.appendChild(el);
    }
    el.textContent = css;
    return name;
  }

  function remove(name) {
    const root = document.getElementById('nbc-style-root');
    if (!root) return false;
    const el = root.querySelector(`style[data-nbc-name="${CSS.escape(name)}"]`);
    if (el) {
      el.remove();
      return true;
    }
    return false;
  }

  function list() {
    const root = document.getElementById('nbc-style-root');
    if (!root) return [];
    return Array.from(root.querySelectorAll('style[data-nbc-name]')).map((el) => ({
      name: el.getAttribute('data-nbc-name'),
      css: el.textContent,
    }));
  }

  function clearAll() {
    const root = document.getElementById('nbc-style-root');
    if (root) root.innerHTML = '';
  }

  // --- 预设 ---------------------------------------------------------------
  const PRESETS = {
    dark: {
      name: 'preset-dark',
      css: `:root {
  color-scheme: dark !important;
  --nbc-bg: #16181d; --nbc-fg: #e6e6e6; --nbc-accent: #7aa2f7;
}
html, body { background: var(--nbc-bg) !important; color: var(--nbc-fg) !important; }
body *:not(svg):not(path) {
  background-color: transparent !important;
  color: var(--nbc-fg) !important;
  border-color: #2a2f3a !important;
}
img, video, picture, canvas, svg { filter: invert(0) hue-rotate(180deg) saturate(0.85) !important; }
a { color: var(--nbc-accent) !important; }
pre, code, kbd, samp { background: #1d2027 !important; color: #c0caf5 !important; }
input, textarea, select { background: #1d2027 !important; color: var(--nbc-fg) !important; }
table, tr, td, th { border-color: #2a2f3a !important; }
`,
    },
    light: {
      name: 'preset-light',
      css: `:root { color-scheme: light !important; }
html, body { background: #ffffff !important; color: #1a1a1a !important; }
img, video, picture, canvas, svg { filter: none !important; }
`,
    },
    compact: {
      name: 'preset-compact',
      css: `body { line-height: 1.5 !important; font-size: 14px !important; }
p, li { margin-top: 0.2em !important; margin-bottom: 0.2em !important; }
h1, h2, h3, h4 { margin: 0.6em 0 0.3em !important; line-height: 1.25 !important; }
img, video { max-width: 100% !important; height: auto !important; }
`,
    },
    readable: {
      name: 'preset-readable',
      css: `body {
  max-width: 46em !important;
  margin: 0 auto !important;
  padding: 32px 20px !important;
  font-size: 17px !important;
  line-height: 1.75 !important;
}
aside, nav, .sidebar, .ad, .advertisement { display: none !important; }
`,
    },
    hideImages: {
      name: 'preset-hide-images',
      css: `img:not([data-nbc-keep]), picture, video { display: none !important; }
`,
    },
    wide: {
      name: 'preset-wide',
      css: `body, .container, .content, main { max-width: none !important; width: 100% !important; }
`,
    },
  };

  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return { ok: false, error: `未知预设: ${key}` };
    upsert(p.name, p.css);
    return { ok: true, applied: key, name: p.name };
  }

  /**
   * 应用自定义 CSS。支持两种模式：
   *  - scoped: 选择器被限定在容器内，避免污染全站
   *  - global: 直接作用于页面
   */
  function applyCss(css, { name, scope } = {}) {
    const ruleName = name || `custom-${++seq}`;
    let finalCss = css;
    if (scope) {
      finalCss = scopeCss(css, scope);
    }
    upsert(ruleName, finalCss);
    return { ok: true, name: ruleName, css: finalCss };
  }

  /**
   * 把一段 CSS 限定到某个选择器作用域内。
   * 简单实现：给每条顶层规则的选择器加上作用域前缀。
   */
  function scopeCss(css, scope) {
    // 逐条规则处理，保留 @media 块结构。
    const out = [];
    let i = 0;
    const len = css.length;
    while (i < len) {
      // 找到下一个 { 的位置
      const brace = css.indexOf('{', i);
      if (brace < 0) break;
      const prelude = css.slice(i, brace).trim();
      // 找到匹配的 }
      let depth = 1;
      let j = brace + 1;
      while (j < len && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const body = css.slice(brace + 1, j - 1);

      if (prelude.startsWith('@')) {
        if (/@media|@supports|@container/.test(prelude)) {
          out.push(`${prelude} {${scopeCss(body, scope)}}`);
        } else {
          out.push(`${prelude} {${body}}`);
        }
      } else if (prelude) {
        const scoped = prelude
          .split(',')
          .map((sel) => {
            const s = sel.trim();
            if (!s) return s;
            // 已经是作用域后代的（:hover 等伪类保留在最后）
            if (s.includes(':')) {
              const idx = s.indexOf(':');
              return `${scope} ${s.slice(0, idx)}${s.slice(idx)}`;
            }
            return `${scope} ${s}`;
          })
          .join(', ');
        out.push(`${scoped} {${body}}`);
      }
      i = j;
    }
    return out.join('\n');
  }

  /** 隐藏指定文本/选择器匹配的元素。 */
  function hideElements(selectors) {
    const list = Array.isArray(selectors) ? selectors : String(selectors).split(',').map((s) => s.trim());
    const parts = [];
    for (const sel of list) {
      if (!sel) continue;
      parts.push(`${sel} { display: none !important; }`);
    }
    if (!parts.length) return { ok: false, error: '没有有效的选择器' };
    upsert('custom-hide', parts.join('\n'));
    return { ok: true, hidden: list.filter(Boolean) };
  }

  window.__nbcStyleAgent = {
    applyCss,
    applyPreset,
    clearAll,
    hideElements,
    list,
    presets: Object.keys(PRESETS),
    remove,
    scopeCss,
    upsert,
  };
})();
