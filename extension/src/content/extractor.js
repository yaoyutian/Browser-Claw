// 正文抽取：从 DOM 中提取「可读正文」，用于「读取网页内容 → 输出文档」。
//
// 借鉴 Readability / Defuddle 的思路（评分 + 清洗），
// 但这里用一个轻量实现，避免把整个依赖打进扩展。
// 需要更高保真时，companion 侧可切换到 defuddle / readability。

(() => {
  if (window.__nbcExtractor) return;

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'UL', 'OL', 'BLOCKQUOTE',
    'PRE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'FOOTER',
    'NAV', 'ASIDE', 'FORM', 'BUTTON', 'IMG', 'FIGURE', 'FIGCAPTION', 'HR',
  ]);

  const UNLIKELY = /ad|advert|banner|popup|modal|newsletter|subscribe|comment|share|social|cookie|consent|promo|related|recommend|sidebar|footer|header|nav|sponsor|paywall|skip-link|breadcrumb/i;

  const textLen = (el) => (el.textContent || '').trim().length;

  /** 计算一个候选节点的"正文分"。 */
  function score(node) {
    if (!node || node.nodeType !== 1) return -1;
    const tag = node.tagName;
    if (!BLOCK_TAGS.has(tag)) return -1;
    const text = textLen(node);
    if (text < 25) return -1;

    let s = text.length;
    s += (node.querySelectorAll('p').length + node.querySelectorAll('pre').length) * 25;

    // 链接密度惩罚：正文块里链接太多多半是导航。
    const links = node.querySelectorAll('a');
    if (links.length) {
      const linkText = Array.from(links).reduce((a, l) => a + textLen(l), 0);
      const density = linkText / Math.max(text, 1);
      s -= density * 120;
    }

    // 语义加分。
    const cls = `${node.className || ''} ${node.id || ''}`;
    if (/article|content|post|entry|main|body|story|text|markdown/i.test(cls)) s += 40;
    if (/comment|sidebar|footer|header|nav|menu|ad|promo|related/i.test(cls)) s -= 80;

    const tagBonus = { ARTICLE: 60, MAIN: 50, SECTION: 20, DIV: 10, P: 5 };
    s += tagBonus[tag] || 0;

    // 段落长度惩罚（避免把导航堆叠当成正文）。
    const paragraphs = node.querySelectorAll('p');
    if (paragraphs.length) {
      const avg = Array.from(paragraphs).reduce((a, p) => a + textLen(p), 0) / paragraphs.length;
      if (avg < 60) s -= 30;
    }

    return s;
  }

  function pickBest() {
    const candidates = Array.from(document.querySelectorAll('article, main, [role=main], section, div'));
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const s = score(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    if (best) return best;

    // 退化方案：body。
    const body = document.body;
    if (!body) return null;
    const clone = body.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,nav,aside,footer,header,form').forEach((n) => n.remove());
    return clone;
  }

  /** 把 DOM 转成 Markdown 风格的文本。 */
  function toMarkdown(root) {
    const out = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const t = node.textContent.replace(/\s+/g, ' ');
        if (t.trim()) out.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE'].includes(tag)) return;

      switch (tag) {
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
          const lvl = Number(tag[1]);
          out.push(`\n${'#'.repeat(lvl)} ${node.textContent.trim()}\n`);
          return;
        }
        case 'P': {
          const t = node.textContent.replace(/\s+/g, ' ').trim();
          if (t) out.push(`${t}\n`);
          return;
        }
        case 'BR':
          out.push('\n');
          return;
        case 'HR':
          out.push('\n---\n');
          return;
        case 'IMG': {
          const src = node.currentSrc || node.src || node.dataset.src;
          const alt = node.alt || '';
          if (src && !src.startsWith('data:')) out.push(`![${alt}](${src})\n`);
          return;
        }
        case 'A': {
          const href = node.href || node.getAttribute('href') || '';
          const t = node.textContent.replace(/\s+/g, ' ').trim();
          if (!t) return;
          if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
            out.push(`[${t}](${href})`);
          } else {
            out.push(t);
          }
          return;
        }
        case 'LI': {
          const t = node.textContent.replace(/\s+/g, ' ').trim();
          if (t) out.push(`- ${t}\n`);
          return;
        }
        case 'PRE': {
          out.push(`\n\`\`\`\n${node.textContent}\n\`\`\`\n`);
          return;
        }
        case 'CODE': {
          out.push(`\`${node.textContent}\``);
          return;
        }
        case 'BLOCKQUOTE': {
          const t = node.textContent.replace(/\s+/g, ' ').trim();
          if (t) out.push(`\n> ${t}\n`);
          return;
        }
        case 'TABLE': {
          const rows = Array.from(node.querySelectorAll('tr')).map((tr) =>
            Array.from(tr.querySelectorAll('th,td'))
              .map((c) => c.textContent.replace(/\s+/g, ' ').trim())
              .join(' | ')
          );
          if (rows.length) out.push(`\n${rows.join('\n')}\n`);
          return;
        }
        default:
          break;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extract() {
    const best = pickBest();
    if (!best) return { title: document.title, text: '', markdown: '', links: [] };

    // 去掉噪音节点（但保留 best 自身内部的正文）。
    const clone = best.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,iframe,form,button,input,select,textarea,svg').forEach((n) => {
      if (!/article|content/i.test(n.className || '')) n.remove();
    });
    // 移除明显的广告/推荐块。
    clone.querySelectorAll('*').forEach((n) => {
      const cls = `${n.className || ''} ${n.id || ''}`;
      if (UNLIKELY.test(cls) && textLen(n) < 400) n.remove();
    });

    const markdown = toMarkdown(clone);
    const text = (clone.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), href: a.href }))
      .filter((l) => l.href.startsWith('http') && l.text)
      .slice(0, 500);

    const meta = {};
    const get = (sel, attr = 'content') =>
      document.querySelector(sel)?.getAttribute(attr) || '';
    meta.description = get('meta[name=description]');
    meta.author = get('meta[name=author]') || get('meta[property="article:author"]');
    meta.published = get('meta[property="article:published_time"]') || get('meta[name=pubdate]');
    meta.siteName = get('meta[property="og:site_name"]') || location.hostname;

    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.replace(/\s+/g, ' ').trim() }))
      .filter((h) => h.text)
      .slice(0, 120);

    return {
      title: document.title,
      url: location.href,
      markdown,
      text,
      links,
      meta,
      headings,
      lang: document.documentElement.lang || '',
    };
  }

  window.__nbcExtractor = { extract };
})();
