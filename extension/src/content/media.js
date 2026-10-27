// 媒体嗅探：在页面里 hook fetch / XHR / PerformanceObserver，
// 把动态加载的音视频与文档 URL 记录下来，供「批量下载」使用。
//
// 为什么不用 chrome.webRequest：MV3 里 webRequest 只能观察不能拦截，
// 且拿不到 blob: / mediastream 这类运行时 URL；在页面里 hook 反而更全面。

(() => {
  if (window.__nbcMediaHooked) return;
  window.__nbcMediaHooked = true;

  const seen = new Map(); // url -> { url, type, size, source, ts }
  const MAX = 2000;

  const isInteresting = (url, typeHint) => {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('data:')) return false;
    if (url.startsWith('blob:')) return true;
    if (url.startsWith('chrome-extension:')) return false;
    return true;
  };

  const record = (url, extra = {}) => {
    if (!isInteresting(url)) return;
    if (seen.size >= MAX && !seen.has(url)) return;
    const prev = seen.get(url);
    seen.set(url, {
      url,
      type: extra.type || prev?.type || '',
      size: extra.size ?? prev?.size ?? null,
      source: extra.source || prev?.source || 'network',
      ts: prev?.ts || Date.now(),
      headers: extra.headers || prev?.headers || null,
    });
  };

  // --- fetch hook ---------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url;
        if (url) {
          const type = /m3u8|mpd|mp4|webm|m3u|ts$/.test(url) ? 'stream' : '';
          record(url, { source: 'fetch', type });
        }
      } catch { /* ignore */ }
      return origFetch.apply(this, args);
    };
  }

  // --- XHR hook -----------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const xhrUrls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      xhrUrls.set(this, String(url));
    } catch { /* ignore */ }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = xhrUrls.get(this);
      if (url) record(url, { source: 'xhr' });
    } catch { /* ignore */ }
    return origSend.apply(this, args);
  };

  // --- PerformanceObserver: resource entries ------------------------------
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record(entry.name, {
          source: 'performance',
          size: entry.transferSize || entry.encodedBodySize || null,
          type: entry.initiatorType,
        });
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch { /* ignore */ }

  // --- media element src ---------------------------------------------------
  const trackMediaEl = (el) => {
    const src = el.currentSrc || el.src;
    if (src) {
      record(src, { source: 'media-element', type: el.tagName.toLowerCase() });
    }
    for (const track of el.querySelectorAll('track')) {
      if (track.src) record(track.src, { source: 'track', type: 'subtitle' });
    }
  };
  try {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') trackMediaEl(node);
          node.querySelectorAll?.('video, audio').forEach(trackMediaEl);
        }
      }
    });
    const start = () => {
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
      document.querySelectorAll('video, audio').forEach(trackMediaEl);
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch { /* ignore */ }

  window.__nbcMedia = {
    list: () => Array.from(seen.values()),
    clear: () => seen.clear(),
  };
})();
