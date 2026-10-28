// 后台 Service Worker：调度层。
//
// 为什么把工具执行放在这里：
//   1. content script 拿不到 chrome.downloads / chrome.tabs 等权限；
//   2. 侧边栏 UI 一旦关闭，工具逻辑不该丢失；
//   3. 统一的错误处理与日志。
//
// 注意：MV3 的 service worker 会被回收，所以这里不做长耗时状态机，
// 每次调用都是无状态的「收指令 → 执行 → 回结果」。
//
// 具体的工具实现见 handlers.js —— 独立成模块是为了避免
// service-worker ↔ bridge 的循环依赖。

import { handlers } from './handlers.js';
import { startBridge } from './bridge.js';
import { registerAutoApply } from './site-rules.js';

// ---------------------------------------------------------------------------
// 侧边栏
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'nbc-open',
      title: '用 NetBrowserClaw 打开侧边栏',
      contexts: ['page', 'selection', 'link', 'image'],
    });
    chrome.contextMenus.create({
      id: 'nbc-ask-selection',
      title: '询问选中内容：%s',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'nbc-open' && tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  } else if (info.menuItemId === 'nbc-ask-selection' && tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    chrome.runtime
      .sendMessage({
        type: 'nbc:ui:ask',
        text: info.selectionText || '',
        url: info.pageUrl,
      })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 工具调用入口
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // 划词：内容脚本检测到选区后转发给侧边栏。
    // 侧边栏没打开时消息会失败，忽略即可。
    if (msg?.type === 'nbc:selection') {
      chrome.runtime.sendMessage({ type: 'nbc:ui:selection', info: msg.info }).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    // 划词探针必须在 MAIN world（页面世界）才有真实的选区状态，
    // 隔离世界里的 selection 读不到用户选中的内容。
    if (msg?.type === 'nbc:selection:probe') {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: '无法确定标签页' });
        return;
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['src/content/selection-probe.js'],
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg?.type !== 'nbc:tool') {
      sendResponse({ ok: false, error: '未知消息类型' });
      return;
    }
    const { name, args = {} } = msg;
    const handler = handlers[name];
    if (!handler) {
      sendResponse({ ok: false, error: `未知工具: ${name}` });
      return;
    }
    try {
      const ctx = {
        tabId: msg.tabId ?? sender.tab?.id,
        sender,
      };
      // 统一 tabId 优先级：消息级 > 参数级 > 发起方标签页。
      // 各 handler 只读 args.tabId，若不合并会误落到"当前活动页"。
      const mergedArgs = { ...args };
      if (ctx.tabId != null && mergedArgs.tabId == null) mergedArgs.tabId = ctx.tabId;
      const data = await handler(mergedArgs, ctx);
      sendResponse({ ok: true, data });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err?.message || String(err),
        detail: err?.detail,
      });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// 连接本地 companion：让外部 MCP 客户端也能驱动这个浏览器
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => startBridge());
startBridge();

// 站点样式规则：页面导航后自动应用已保存的规则
registerAutoApply();
