// Native Messaging 客户端：通过浏览器按需拉起本地 companion。
//
// 这是扩展与本地进程之间的唯一官方通道（扩展本身无法启动本地程序）。
// 宿主是「一次性拉起器」：确保 companion 在跑（没有就启动 detached 子进程），
// 回一条 ready 后退出。companion 是 detached 的，浏览器关闭后继续存活。

const HOST_NAME = 'netbrowserclaw';
const CONNECT_TIMEOUT = 20_000;

/**
 * 通过 Native Messaging 拉起 companion。
 *
 * @returns {Promise<{ok:boolean, started?:boolean, alreadyRunning?:boolean,
 *                    port?:number, error?:string, hint?:string}>}
 */
export function startCompanionViaNative() {
  if (!chrome.runtime.connectNative) {
    return Promise.resolve({
      ok: false,
      error: '此浏览器不支持 Native Messaging',
    });
  }

  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      return resolve({
        ok: false,
        error: `无法连接 Native Messaging 宿主（${HOST_NAME}）`,
        detail: String(e),
        hint: '先运行 node scripts/install-native-host.mjs 完成一次性安装',
      });
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* ignore */ }
      resolve(result);
    };

    // 宿主是「拉起器」，正常几秒内回 ready 并自行退出
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: 'Native Messaging 宿主无响应',
        hint: '请运行 node scripts/install-native-host.mjs 完成一次性安装，然后重启浏览器',
      });
    }, CONNECT_TIMEOUT);

    port.onMessage.addListener((msg) => {
      if (msg?.type !== 'ready') return;
      clearTimeout(timer);
      finish({
        ok: !msg.error,
        started: msg.started,
        alreadyRunning: msg.alreadyRunning,
        port: msg.port,
        error: msg.error,
      });
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError?.message;
      clearTimeout(timer);
      finish({
        ok: false,
        error: err || 'Native Messaging 宿主提前退出',
        detail: '通常是宿主未注册，或注册表里的 allowed_origins 不包含本扩展 ID',
        hint: '运行 node scripts/install-native-host.mjs <扩展ID>',
      });
    });
  });
}
