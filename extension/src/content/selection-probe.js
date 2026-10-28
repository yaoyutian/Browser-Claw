// 划词探针 —— 运行在 MAIN world（页面世界）。
//
// 为什么需要它：内容脚本运行在**隔离世界**，那里有独立的 selection 状态，
// 读不到用户在页面上真正选中的文字（实测返回 null）。
// 页面世界才有真实的选区，所以监听与读取都必须在 MAIN world 完成，
// 再用 postMessage 把结果交给隔离世界的内容脚本。
//
// 由后台用 chrome.scripting.executeScript({ world: 'MAIN' }) 注入。

(() => {
  if (window.__nbcSelectionProbe) return;

  const CHANNEL = '__nbc_selection__';
  let lastText = '';

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) return null;

    let anchorNode = null;
    try {
      anchorNode = sel.anchorNode;
    } catch { /* ignore */ }

    return {
      text: text.slice(0, 4000),
      anchorNode,
    };
  }

  function publish() {
    const info = readSelection();
    if (!info) return;
    if (info.text === lastText) return;
    lastText = info.text;

    // anchorNode 不能结构化克隆，单独传递其父元素的可读信息
    let context = '';
    try {
      const el =
        info.anchorNode?.nodeType === 1
          ? info.anchorNode
          : info.anchorNode?.parentElement;
      context = (el?.closest?.('article, main, section, p, li, h1, h2, h3')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
    } catch { /* ignore */ }

    window.postMessage(
      {
        [CHANNEL]: true,
        text: info.text,
        context,
        url: location.href,
        title: document.title,
      },
      '*'
    );
  }

  // 双保险触发：
  //   1. selectionchange —— 覆盖键盘选词、拖拽选词、程序化选词
  //   2. mouseup         —— 覆盖大多数鼠标选词
  let timer = null;
  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(publish, delay);
  };

  document.addEventListener('selectionchange', () => schedule(250), true);
  document.addEventListener('mouseup', () => schedule(120), true);
  document.addEventListener('keyup', () => schedule(200), true);

  // 供内容脚本同步调用（拿当前最新选区）
  window.__nbcSelectionProbe = () => {
    const info = readSelection();
    if (!info) return null;
    let context = '';
    try {
      const el =
        info.anchorNode?.nodeType === 1 ? info.anchorNode : info.anchorNode?.parentElement;
      context = (el?.closest?.('article, main, section, p, li, h1, h2, h3')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
    } catch { /* ignore */ }
    return { text: info.text, context, url: location.href, title: document.title };
  };

  // 页面可能已经加载完，探测脚本是后注入的，先报一次当前选区
  setTimeout(publish, 300);
})();
