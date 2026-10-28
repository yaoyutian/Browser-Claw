// 整页归档器：把当前页面打包成一个自包含的 HTML 文件。
//
// 借鉴 SingleFile 的思路，但实现要轻得多：
//   · 移除脚本、表单交互等动态部分，保留可读内容
//   · 把 CSS、图片、字体内联成 data: URI
//   · 保留原始排版，附带归档时间与来源信息
//
// 必须在**内容脚本的隔离世界**里做：同源资源用 fetch 不会被 CORS 拦，
// 而页面世界无法直接拿到扩展的权限。
//
// 限制：跨域资源（CDN 上的图片等）可能因 CORS 拿不到二进制，
// 这时会保留原始 URL（离线打开时该资源缺失，但页面结构完整）。

(() => {
  if (window.__nbcArchiver) return;

  /** 把资源转成 data: URI。失败时返回 null（调用方保留原 URL）。 */
  async function inlineResource(url, asDataUrl = true) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!asDataUrl) return null;
      // 体积过大的资源不内联，避免归档文件爆炸
      if (blob.size > 8 * 1024 * 1024) return null;
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  /** 收集页面上所有需要内联的资源。 */
  function collectResources(root) {
    const css = [];
    const images = [];
    const fonts = [];

    for (const el of root.querySelectorAll('link[rel~="stylesheet"][href]')) {
      css.push(el.href);
    }
    for (const el of root.querySelectorAll('style')) {
      // style 元素里可能 @import 了别的样式表
      const text = el.textContent || '';
      for (const m of text.matchAll(/@import\s+(?:url\()?['"]?([^'")]+)['"]?\)?/gi)) {
        try {
          css.push(new URL(m[1], location.href).href);
        } catch { /* ignore */ }
      }
    }
    for (const el of root.querySelectorAll('img[src], image[href]')) {
      const src = el.currentSrc || el.src || el.getAttribute('href');
      if (src && !src.startsWith('data:')) images.push(src);
    }
    for (const el of root.querySelectorAll('source[src], video[src], audio[src]')) {
      const src = el.src || el.getAttribute('src');
      if (src && !src.startsWith('data:')) images.push(src);
    }
    // CSS 里的 url(...) 资源（字体、背景图）
    for (const el of root.querySelectorAll('style')) {
      const text = el.textContent || '';
      for (const m of text.matchAll(/url\(['"]?([^'")]+)['"]?\)/gi)) {
        try {
          const abs = new URL(m[1], location.href).href;
          if (!abs.startsWith('data:')) fonts.push(abs);
        } catch { /* ignore */ }
      }
    }
    return {
      css: [...new Set(css)],
      images: [...new Set(images)],
      fonts: [...new Set(fonts)],
    };
  }

  /**
   * 生成自包含 HTML。
   * @param {object} opts
   * @param {boolean} opts.inlineImages 是否内联图片
   * @param {boolean} opts.inlineCss    是否内联外部样式表
   * @param {boolean} opts.keepDynamic  是否保留脚本（默认移除）
   */
  async function archive(opts = {}) {
    const {
      inlineImages = true,
      inlineCss = true,
      keepDynamic = false,
      includeIframes = false,
    } = opts;

    // 克隆当前文档，避免破坏页面
    const clone = document.documentElement.cloneNode(true);

    // 1) 清理不该保留的部分
    const remove = clone.querySelectorAll(
      'script, noscript, template, object, embed, base, meta[http-equiv="refresh"]'
    );
    remove.forEach((n) => n.remove());

    // 关闭交互控件，保留内容
    clone.querySelectorAll('input, textarea, select, button').forEach((n) => {
      n.setAttribute('disabled', 'disabled');
    });

    // 移除扩展自己注入的样式根（避免把面板样式也存进去）
    clone.querySelectorAll('#nbc-style-root').forEach((n) => n.remove());

    // 2) 处理 iframe
    const frames = clone.querySelectorAll('iframe');
    for (const f of frames) {
      if (!includeIframes) {
        // 用占位内容代替，保留其位置
        const ph = document.createElement('div');
        ph.className = 'nbc-archived-frame';
        ph.style.cssText =
          'border:1px dashed #bbb;padding:12px;color:#888;font-size:13px;margin:8px 0';
        ph.textContent = `[已归档：${f.getAttribute('src') || '内嵌框架'}]`;
        f.replaceWith(ph);
      }
    }

    // 3) 内联外部样式表
    const resources = collectResources(clone);
    let inlinedCss = 0;
    let inlinedImages = 0;

    if (inlineCss) {
      for (const link of clone.querySelectorAll('link[rel~="stylesheet"][href]')) {
        const data = await inlineResource(link.href);
        if (data) {
          const style = document.createElement('style');
          style.textContent = await cssTextOf(link.href);
          link.replaceWith(style);
          inlinedCss++;
        }
      }
    }

    // 4) 内联图片
    if (inlineImages) {
      for (const el of clone.querySelectorAll('img[src], image[href]')) {
        const src = el.currentSrc || el.src || el.getAttribute('href');
        if (!src || src.startsWith('data:')) continue;
        const data = await inlineResource(src);
        if (data) {
          if (el.tagName === 'IMG') el.setAttribute('src', data);
          else el.setAttribute('href', data);
          inlinedImages++;
        }
      }
      // video/audio 的 poster 与 source
      for (const el of clone.querySelectorAll('video[poster]')) {
        const p = el.getAttribute('poster');
        if (p && !p.startsWith('data:')) {
          const data = await inlineResource(p);
          if (data) el.setAttribute('poster', data);
        }
      }
    }

    // 5) 给链接加上说明（离线打开时无法跳回原站）
    //    除 title 外再插入可见标记，方便离线阅读时看到原地址。
    for (const a of clone.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (href && /^https?:/.test(href)) {
        a.setAttribute('title', `原链接：${href}`);
        const mark = document.createElement('span');
        mark.className = 'nbc-archived-link';
        mark.style.cssText =
          'font-size:11px;color:#888;margin-left:4px;text-decoration:none';
        mark.textContent = `⟨${href}⟩`;
        a.insertAdjacentElement('afterend', mark);
      }
    }

    // 6) 组装最终文档
    const now = new Date();
    const meta = {
      title: document.title || location.href,
      url: location.href,
      archivedAt: now.toISOString(),
      site: location.hostname.replace(/^www\./, ''),
    };

    const banner = `<div style="max-width:820px;margin:24px auto;padding:12px 16px;border:1px solid #ddd;border-radius:8px;background:#fafafa;font:13px/1.6 system-ui,sans-serif;color:#555">
  <strong>网页归档</strong> · ${escapeHtml(meta.title)}<br>
  来源：<a href="${escapeHtml(meta.url)}">${escapeHtml(meta.url)}</a> ·
  归档时间：${escapeHtml(meta.archivedAt.replace('T', ' ').replace('Z', ' UTC'))}
</div>`;

    const head = clone.querySelector('head');
    if (head) {
      const metaTags = document.createElement('meta');
      metaTags.setAttribute('charset', 'utf-8');
      head.prepend(metaTags);

      const archiveMeta = document.createElement('meta');
      archiveMeta.setAttribute('name', 'nbc-archived-at');
      archiveMeta.setAttribute('content', meta.archivedAt);
      head.appendChild(archiveMeta);

      const base = document.createElement('base');
      base.setAttribute('href', meta.url);
      head.appendChild(base);
    }

    const body = clone.querySelector('body');
    if (body) {
      const holder = document.createElement('div');
      holder.innerHTML = banner;
      body.prepend(holder.firstChild);
    }

    const html = `<!DOCTYPE html>
<html lang="${escapeHtml(document.documentElement.lang || 'zh-CN')}">
<head>
${head ? head.innerHTML : '<meta charset="utf-8">'}
</head>
<body>
${body ? body.innerHTML : ''}
</body>
</html>`;

    return {
      html,
      meta,
      stats: {
        cssInlined: inlinedCss,
        imagesInlined: inlinedImages,
        cssTotal: resources.css.length,
        imagesTotal: resources.images.length,
        htmlBytes: html.length,
      },
    };
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 取样式表内容（跨域时会被 CORS 拒绝，此时返回空）。 */
  async function cssTextOf(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return '';
      return await res.text();
    } catch {
      return '';
    }
  }

  window.__nbcArchiver = { archive };
})();
