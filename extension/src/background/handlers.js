// 工具处理器集合。
//
// 独立成模块的原因：service-worker.js 需要 import bridge.js（启动轮询），
// 而 bridge.js 又需要在 service-worker 之外执行工具。两者互相 import 会形成
// 循环依赖，把 handlers 抽出来即可彻底切断。

import { ToolError, safeName, siteName, stamp, truncate, formatBytes, mimeOf, extOf } from '../shared/util.js';
import { markdownToDocx } from '../shared/docx.js';
import { findCompanion, companionFetch } from '../shared/companion.js';

/** 判断是否为 HLS/DASH 播放清单（需要 ffmpeg 合并，扩展无法直接下载）。 */
function isStreamManifest(url) {
  try {
    const p = new URL(url, 'https://x.invalid').pathname.toLowerCase();
    return /\.(m3u8|mpd)$/.test(p);
  } catch {
    return /\.(m3u8|mpd)(\?|$)/i.test(String(url));
  }
}

/** 向内容脚本发指令；脚本未注入时先用 chrome.scripting 兜底注入。 */
async function sendToContent(tabId, message) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || '';

  // chrome:// 、扩展页、商店页等不允许注入内容脚本。
  if (!/^https?:|^file:/.test(url)) {
    throw new ToolError('当前页面不允许扩展操作', `页面协议不支持: ${url.slice(0, 80)}`);
  }

  let res = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
  if (!res) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'src/content/media.js',
        'src/content/extractor.js',
        'src/content/style-agent.js',
        'src/content/content.js',
      ],
    }).catch((e) => {
      throw new ToolError('无法注入内容脚本', e?.message || String(e));
    });
    res = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
  }
  if (!res) throw new ToolError('内容脚本无响应', '页面可能正在跳转，请稍后重试');
  if (!res.ok) throw new ToolError(res.error || '内容脚本执行失败', res.stack);
  return res.data;
}

async function contentCall(message, tabId) {
  const tab = await getTab(tabId);
  if (!tab?.id) throw new ToolError('找不到目标标签页');
  return sendToContent(tab.id, message);
}

async function getTab(tabId) {
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) return tab;
    // 显式指定了 tabId 却找不到：明确报错，避免静默操作到别的标签页。
    throw new ToolError(`找不到标签页 (tabId=${tabId})`, '该标签页可能已被关闭');
  }
  // 回落时排除扩展自身页面，否则会对着侧边栏/设置页操作。
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const usable = tabs.filter((t) => /^https?:|^file:/.test(t.url || ''));
  return usable[0] || tabs[0] || null;
}

// ---------------------------------------------------------------------------
// 批量下载
// ---------------------------------------------------------------------------

async function cookieHeaderFor(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies?.length) return '';
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/** Blob → base64（不依赖 DOM，可在 service worker 中运行）。 */
async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // 避免 apply 参数过多导致栈溢出
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function defaultName(url, contentType) {
  const ext = extOf(url);
  if (ext) return `nbc-${stamp()}-${safeName(decodeURIComponent(url.split('/').pop() || 'file'))}`;
  const guess = (contentType || '').split(';')[0].split('/')[1] || 'bin';
  return `nbc-${stamp()}-file.${guess}`;
}

/**
 * 下载单个资源。
 * 直连时用 chrome.downloads（自带浏览器 Cookie 上下文）；
 * 需要自定义 Referer 或走 blob: 时，改用 fetch + data: URL 中转。
 */
async function downloadOne(url, { filename, referer, headers, conflictAction = 'overwrite' } = {}) {
  if (referer || headers) {
    return downloadViaFetch(url, { filename, referer, headers, conflictAction });
  }
  try {
    const id = await chrome.downloads.download({
      url,
      // 批量场景我们自己已经做了文件名去重，用 'overwrite' 避免叠加浏览器的 " (1)" 后缀；
      // 单文件场景交给浏览器 uniquify 更安全。
      conflictAction,
      saveAs: false,
      ...(filename ? { filename } : {}),
    });
    return { ok: true, id, url, mode: 'downloads-api' };
  } catch {
    // blob: 等 chrome.downloads 处理不了的地址，走 fetch。
    return downloadViaFetch(url, { filename, referer, headers, conflictAction });
  }
}

async function downloadViaFetch(url, { filename, referer, headers, conflictAction = 'overwrite' } = {}) {
  const requestHeaders = { ...(headers || {}) };
  if (referer) requestHeaders.Referer = referer;
  if (!requestHeaders.Cookie) {
    const cookie = await cookieHeaderFor(url);
    if (cookie) requestHeaders.Cookie = cookie;
  }

  const res = await fetch(url, { headers: requestHeaders, credentials: 'include' });
  if (!res.ok) throw new ToolError(`下载失败 ${res.status}`, url);

  const blob = await res.blob();
  // MV3 service worker 无 DOM，不能用 URL.createObjectURL —— 走 data: URL。
  const base64 = await blobToBase64(blob);
  const dataUrl = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
  try {
    const id = await chrome.downloads.download({
      url: dataUrl,
      filename: filename || defaultName(url, res.headers.get('content-type')),
      conflictAction,
      saveAs: false,
    });
    return { ok: true, id, url, size: blob.size, mode: 'fetch' };
  } catch (err) {
    throw new ToolError('保存下载失败', err?.message || String(err));
  }
}

async function batchDownload(items, { concurrency = 3, referer } = {}) {
  const results = [];
  const queue = [...items];
  let index = 0;

  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= queue.length) return;
      const item = queue[i];
      try {
        const r = await downloadOne(item.url, {
          filename: item.filename,
          referer: item.referer || referer,
          headers: item.headers,
        });
        results.push({ url: item.url, ok: true, id: r.id, size: r.size });
      } catch (err) {
        results.push({ url: item.url, ok: false, error: err?.message || String(err) });
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(queue.length, 1)) },
    worker
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// 文档导出
// ---------------------------------------------------------------------------

async function saveBlob(blob, filename) {
  // 注意：MV3 的 service worker 里没有 DOM，URL.createObjectURL 不可用。
  // chrome.downloads 因此不能直接接收 Blob URL —— 改用 data: URL。
  const base64 = await blobToBase64(blob);
  const dataUrl = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
  try {
    const id = await chrome.downloads.download({
      url: dataUrl,
      filename: safeName(filename),
      // 单文件导出用 uniquify：不同网页的同名文档不该互相覆盖。
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return id;
  } catch (err) {
    throw new ToolError('保存文件失败', err?.message || String(err));
  }
}

/** 极简 Markdown → HTML（够用于阅读，不追求完备）。 */
function markdownToHtml(md) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let inCode = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const raw of String(md).split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      closeList();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(raw) + '\n');
      continue;
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (!inList) {
        out.push('<ol>');
        inList = true;
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const quote = raw.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    if (!raw.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

async function exportDocument({ format = 'md', content, title = 'document', sourceUrl }) {
  const base = `${siteName(sourceUrl || '')}-${safeName(title)}-${stamp()}`;
  if (format === 'docx') {
    const bytes = markdownToDocx(content, { title });
    const id = await saveBlob(
      new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      `${base}.docx`
    );
    return { ok: true, id, filename: `${base}.docx`, format };
  }
  if (format === 'html') {
    const html =
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<title>${title}</title>` +
      `<style>body{max-width:820px;margin:40px auto;padding:0 20px;line-height:1.75;font-family:system-ui,sans-serif;}` +
      `pre{background:#f6f8fa;padding:12px;overflow:auto;border-radius:6px;}code{background:#f6f8fa;padding:2px 4px;border-radius:4px;}` +
      `blockquote{border-left:4px solid #ddd;margin:0;padding-left:14px;color:#555;}</style>` +
      `</head><body>${markdownToHtml(content)}</body></html>`;
    const id = await saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${base}.html`);
    return { ok: true, id, filename: `${base}.html`, format };
  }
  if (format === 'txt') {
    const id = await saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
    return { ok: true, id, filename: `${base}.txt`, format };
  }
  const id = await saveBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), `${base}.md`);
  return { ok: true, id, filename: `${base}.md`, format };
}

async function captureScreenshot(tabId) {
  const tab = await getTab(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const base64 = dataUrl.split(',')[1];
  return { ok: true, dataUrl, base64, mime: 'image/png' };
}

// ---------------------------------------------------------------------------
// 工具分发表
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 表格文档批量下载
// ---------------------------------------------------------------------------

/** 把文本转成安全的文件名片段。 */
function slug(text, max = 60) {
  const s = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return s || '';
}

/**
 * 为表格里的文档生成有意义的文件名。
 *
 * 真实场景是「一行一列一个文件」，URL 里的文件名往往是 `download?id=123` 这种无意义值。
 * 所以用「行标签 + 列标题」组合来命名，用户拿到文件一看就知道是什么。
 */
function tableDocFilename(item, index) {
  const parts = [];
  if (item.rowLabel) parts.push(slug(item.rowLabel));
  if (item.colHeader) parts.push(slug(item.colHeader, 40));
  if (!parts.length && item.text) parts.push(slug(item.text));

  let base = parts.join('_');
  if (!base) base = `file-${index + 1}`;

  // 保留原扩展名
  let ext = '';
  try {
    const m = new URL(item.href).pathname.match(/\.([a-z0-9]{1,5})$/i);
    if (m) ext = '.' + m[1].toLowerCase();
  } catch { /* ignore */ }
  if (!ext) {
    const m2 = (item.downloadAttr || '').match(/\.([a-z0-9]{1,5})$/i);
    if (m2) ext = '.' + m2[1].toLowerCase();
  }
  if (!ext) ext = '.pdf';

  return `${base}${ext}`;
}

/**
 * 批量下载时给重复的文件名加序号后缀。
 * 分页表格里不同页可能有相同的「行标签 + 列标题」组合，
 * 不去重会互相覆盖。
 */
function dedupeFilenames(items) {
  const seen = new Map();
  return items.map((it, i) => {
    const name = it.filename;
    if (!seen.has(name)) {
      seen.set(name, 1);
      return it;
    }
    const n = seen.get(name) + 1;
    seen.set(name, n);
    const dot = name.lastIndexOf('.');
    const unique = dot > 0 ? `${name.slice(0, dot)}_${n}${name.slice(dot)}` : `${name}_${n}`;
    return { ...it, filename: unique };
  });
}

/** 采集表格文档并生成下载清单。 */
async function collectTableDocs(args) {
  const data = await contentCall(
    {
      type: 'nbc:table:collect',
      exts: args.exts,
      maxPages: args.maxPages,
      waitMs: args.waitMs,
      tableIndex: args.tableIndex,
    },
    args.tabId
  );
  return data;
}

/** 表格文档批量下载：采集 → 命名 → 下载。 */
async function downloadTableDocs(args) {
  const collected = await collectTableDocs(args);
  const items = collected.items || [];

  if (!items.length) {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      pages: collected.pages,
      results: [],
      note: '表格里没有找到文档链接',
    };
  }

  const withNames = dedupeFilenames(
    items.map((item, i) => ({
      url: item.href,
      filename: item.filename && item.filename !== item.text + '.pdf'
        ? item.filename
        : tableDocFilename(item, i),
      _meta: {
        rowLabel: item.rowLabel,
        colHeader: item.colHeader,
        text: item.text,
        page: item.pageIndex,
      },
    }))
  );

  const results = await batchDownload(withNames, {
    concurrency: args.concurrency || 3,
    referer: args.referer,
  });

  return {
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    pages: collected.pages,
    results: results.map((r, i) => ({
      url: r.url,
      ok: r.ok,
      error: r.error,
      size: r.size ? formatBytes(r.size) : undefined,
      filename: withNames[i].filename,
      rowLabel: withNames[i]._meta.rowLabel,
      colHeader: withNames[i]._meta.colHeader,
      page: withNames[i]._meta.page,
    })),
  };
}

export const handlers = {
  async 'page.read'(args) {
    const data = await contentCall({ type: 'nbc:extract' }, args.tabId);
    return {
      title: data.title,
      url: data.url,
      markdown: truncate(data.markdown, args.maxLength || 30000),
      meta: data.meta,
      headings: data.headings,
      linkCount: data.links?.length || 0,
    };
  },

  async 'page.links'(args) {
    return contentCall({ type: 'nbc:links', filter: args }, args.tabId);
  },

  async 'page.tables'(args) {
    return contentCall({ type: 'nbc:tables' }, args.tabId);
  },

  async 'page.images'(args) {
    return contentCall({ type: 'nbc:images', limit: args.limit }, args.tabId);
  },

  async 'page.interactive'(args) {
    return contentCall({ type: 'nbc:interactive:list', limit: args.limit }, args.tabId);
  },

  async 'page.click'(args) {
    return contentCall({ type: 'nbc:click', ...args }, args.tabId);
  },

  async 'page.fill'(args) {
    return contentCall({ type: 'nbc:fill', ...args }, args.tabId);
  },

  async 'page.scroll'(args) {
    return contentCall({ type: 'nbc:scroll', ...args }, args.tabId);
  },

  async 'page.highlight'(args) {
    return contentCall({ type: 'nbc:highlight', ...args }, args.tabId);
  },

  async 'page.eval'(args) {
    // 在 MAIN world 执行：语义上等同于用户在页面控制台执行，
    // 且不受扩展 CSP（默认禁止 unsafe-eval）的限制。
    const tab = await getTab(args.tabId);
    if (!tab?.id) throw new ToolError('找不到目标标签页');
    if (!/^https?:|^file:/.test(tab.url || '')) {
      throw new ToolError(
        '当前页面不允许执行脚本',
        `页面协议不支持: ${(tab.url || '').slice(0, 80)}`
      );
    }
    const code = String(args.code || '').trim();
    if (!code) throw new ToolError('代码为空');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (src) => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => {${src}})()`);
          return fn();
        } catch (e) {
          return { __nbcError: e?.message || String(e) };
        }
      },
      args: [code],
    });

    const value = results?.[0]?.result;
    if (value && typeof value === 'object' && value.__nbcError) {
      throw new ToolError('脚本执行出错', value.__nbcError);
    }
    return value;
  },

  async 'page.screenshot'(args) {
    return captureScreenshot(args.tabId);
  },

  async 'style.apply'(args) {
    return contentCall(
      {
        type: 'nbc:style:apply',
        css: args.css,
        options: { name: args.name, scope: args.scope },
      },
      args.tabId
    );
  },

  async 'style.preset'(args) {
    return contentCall({ type: 'nbc:style:preset', preset: args.preset }, args.tabId);
  },

  async 'style.hide'(args) {
    return contentCall({ type: 'nbc:style:hide', selectors: args.selectors }, args.tabId);
  },

  async 'style.list'(_args, ctx) {
    return contentCall({ type: 'nbc:style:list' }, ctx.tabId);
  },

  async 'style.remove'(args) {
    return contentCall({ type: 'nbc:style:remove', name: args.name }, args.tabId);
  },

  async 'style.reset'(_args, ctx) {
    return contentCall({ type: 'nbc:style:clear' }, ctx.tabId);
  },

  async 'table.docs'(args) {
    return collectTableDocs(args);
  },

  async 'table.download'(args) {
    return downloadTableDocs(args);
  },

  async 'media.list'(args) {
    const list = await contentCall({ type: 'nbc:media:list' }, args.tabId);
    return list.slice(0, args.limit || 300);
  },

  async 'media.download'(args) {
    const urls = args.urls || [];
    if (!urls.length) throw new ToolError('没有要下载的 URL');
    const items = urls.map((u) => (typeof u === 'string' ? { url: u } : u));

    // HLS/DASH 清单无法在扩展内合并分片 —— 交给 companion 用 ffmpeg 处理。
    const streamItems = items.filter((it) => isStreamManifest(it.url));
    const directItems = items.filter((it) => !isStreamManifest(it.url));

    const results = [];
    if (directItems.length) {
      const directResults = await batchDownload(directItems, {
        concurrency: args.concurrency || 3,
        referer: args.referer,
      });
      results.push(...directResults);
    }

    if (streamItems.length) {
      const companion = await findCompanion();
      if (!companion) {
        for (const it of streamItems) {
          results.push({
            url: it.url,
            ok: false,
            error:
              'HLS/DASH 流需要本地 companion + ffmpeg 才能下载（扩展无法合并分片）。' +
              '请运行 node companion/server.mjs 并在设置里配置 ffmpeg 路径。',
          });
        }
      } else {
        for (const it of streamItems) {
          const res = await companionFetch(
            '/hls',
            {
              targetUrl: it.url,
              filename: it.filename,
              referer: it.referer || args.referer,
              cookie: await cookieHeaderFor(it.url),
            },
            { timeout: 300_000 }
          );
          if (res.ok) {
            results.push({
              url: it.url,
              ok: true,
              size: res.data?.size,
              mode: 'ffmpeg',
              path: res.data?.path,
            });
          } else {
            results.push({ url: it.url, ok: false, error: res.error, detail: res.detail });
          }
        }
      }
    }

    const ok = results.filter((r) => r.ok).length;
    return {
      total: results.length,
      succeeded: ok,
      failed: results.length - ok,
      results: results.map((r) => ({
        url: r.url,
        ok: r.ok,
        error: r.error,
        size: r.size ? formatBytes(r.size) : undefined,
        mode: r.mode,
        path: r.path,
      })),
    };
  },

  async 'doc.export'(args) {
    if (!args.content) throw new ToolError('导出内容为空');
    return exportDocument({
      format: args.format || 'md',
      content: args.content,
      title: args.title || 'document',
      sourceUrl: args.sourceUrl,
    });
  },

  async 'tab.list'() {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => /^https?:|^file:/.test(t.url || ''))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
  },

  async 'tab.open'(args) {
    const tab = await chrome.tabs.create({ url: args.url, active: args.active !== false });
    return { ok: true, id: tab.id, url: tab.url };
  },

  async 'tab.switch'(args) {
    const tab = await chrome.tabs.get(args.tabId);
    await chrome.tabs.update(args.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { ok: true, id: args.tabId };
  },

  async 'tab.close'(args) {
    await chrome.tabs.remove(args.tabId);
    return { ok: true };
  },

  async 'tab.reload'(_args, ctx) {
    const tab = await getTab(ctx.tabId);
    await chrome.tabs.reload(tab.id);
    return { ok: true };
  },

  async 'nav.back'(args) {
    const tab = await getTab(args.tabId);
    await chrome.tabs.goBack(tab.id).catch(() => {});
    return { ok: true };
  },
};
