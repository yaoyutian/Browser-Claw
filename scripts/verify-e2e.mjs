#!/usr/bin/env node
// 端到端验证脚本：用 CDP 启动 Edge、加载扩展、逐项验证工具是否真的工作。
//
// 用法：
//   node scripts/verify-e2e.mjs
//
// 依赖：本机装有 Edge/Chrome；python3 用于起本地测试页。
// 它会真实地：加载扩展 → 打开测试页 → 调工具 → 检查 DOM/文件系统结果。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXT = join(ROOT, 'extension');
const PORT = 9444;
const WEB_PORT = 8901;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('未找到 Edge/Chrome 可执行文件');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nbc-verify-'));
const webRoot = mkdtempSync(join(tmpdir(), 'nbc-web-'));
let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 测试页面
// ---------------------------------------------------------------------------

writeFileSync(
  join(webRoot, 'testpage.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>测试文章 - NetBrowserClaw</title>
<meta name="description" content="用于验证扩展功能的测试页面">
<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;line-height:1.8}
.ad-banner{background:#fee;padding:20px}.article-body{color:#222}</style></head><body>
<div class="ad-banner">广告位：应该被隐藏</div>
<nav class="sidebar">侧边栏导航</nav>
<article class="article-body">
<h1>深入理解浏览器扩展 Manifest V3</h1>
<p>Manifest V3 是 Chrome 扩展的新一代平台，它引入了一个基于 Service Worker 的后台模型，取代了旧版的背景页。这一变化对扩展的安全性有重大意义。</p>
<h2>Service Worker 生命周期</h2>
<p>Service Worker 会在空闲约三十秒后被回收，这意味着开发者不能依赖一个常驻的内存状态。</p>
<blockquote>关键限制：MV3 禁止远程托管代码。</blockquote>
<pre><code>chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =&gt; {
  sendResponse({ ok: true });
  return true;
});</code></pre>
<ul><li>内容脚本需要通过 messaging 与后台通信</li><li>侧边栏可以独立于页面导航保持存活</li></ul>
<p><a href="/docs/guide.pdf">下载指南 PDF</a> · <a href="/media/demo.mp4">演示视频</a></p>
</article>
<table><thead><tr><th>项目</th><th>评分</th></tr></thead><tbody><tr><td>性能</td><td>92</td></tr></tbody></table>
</body></html>`
);
writeFileSync(join(webRoot, 'demo.txt'), 'hello from nbc test server\n');
// 伪造一个 PDF 与 mp4，用于下载链路测试
writeFileSync(join(webRoot, 'guide.pdf'), Buffer.from('%PDF-1.4\n% netbrowserclaw test\n', 'latin1'));
writeFileSync(join(webRoot, 'demo.mp4'), Buffer.from('\x00\x00\x00\x18ftypmp42fakevideodata', 'latin1'));

const webServer = spawn('python', ['-m', 'http.server', String(WEB_PORT), '--directory', webRoot], {
  stdio: 'ignore',
});

// ---------------------------------------------------------------------------
// 浏览器
// ---------------------------------------------------------------------------

const proc = spawn(
  browser,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

const cleanup = () => {
  try { proc.kill('SIGKILL'); } catch {}
  try { webServer.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(webRoot, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const httpJson = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('DevTools 未就绪');
}

/** 极简 CDP 客户端。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  return { ws, send, logs, ready, evaluate };
}

/**
 * 等待目标执行上下文就绪（能访问 chrome.* API）。
 * Service Worker / 页面在 CDP attach 后需要一点时间才可求值，
 * 过早求值会得到 "chrome is not defined"。
 */
async function waitForChromeApi(conn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const ok = await conn
      .evaluate(`typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined'`)
      .catch(() => false);
    if (ok === true) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  await waitForDevtools();
  await sleep(2500);

  const targets = await httpJson('/json/list');
  // 精确匹配本扩展的 worker：Edge 可能同时开着其他扩展的 service worker，
  // 路径匹配不足以区分，必须确认 URL 形态正确。
  const swTarget = targets.find(
    (t) =>
      t.type === 'service_worker' &&
      t.url.startsWith('chrome-extension://') &&
      t.url.includes('/src/background/service-worker.js')
  );
  check('扩展 Service Worker 已启动', Boolean(swTarget), swTarget?.url || '未找到');
  if (!swTarget) return;

  // 确认跑的是最新代码：Edge 可能缓存了上一次的扩展内容。
  // 用一个只有新代码才有的标记来校验，避免"测的是旧版本"的假绿。
  const swConn = connect(swTarget.webSocketDebuggerUrl);
  await swConn.ready;
  await swConn.send('Runtime.enable');
  await waitForChromeApi(swConn);
  const marker = await swConn
    .evaluate(
      `(async()=>{try{const r=await fetch(chrome.runtime.getURL('src/background/handlers.js'));const t=await r.text();return t.includes('blobToBase64')}catch(e){return 'ERR:'+e.message}})()`
    )
    .catch((e) => 'ERR:' + e.message);
  check('加载的是最新扩展代码', marker === true, `blobToBase64 标记=${marker}`);
  if (marker !== true) {
    console.log('  ⚠ 扩展代码未更新，测试结果不可信。请关闭所有 Edge 窗口后重试。');
  }
  swConn.ws.close();

  const extId = new URL(swTarget.url).host;

  // 面板页作为扩展上下文（可以给后台发消息）
  const sw = connect(swTarget.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send('Runtime.enable');
  await waitForChromeApi(sw);
  await sw.evaluate(`chrome.tabs.create({url:'chrome-extension://${extId}/src/sidepanel/panel.html'}).then(t=>t.id)`);
  await sleep(2000);

  const list2 = await httpJson('/json/list');
  const panelTarget = list2.find(
    (t) => t.url.startsWith(`chrome-extension://${extId}/`) && t.url.includes('/src/sidepanel/panel.html')
  );
  check('侧边栏页面可加载', Boolean(panelTarget), panelTarget?.url || '');
  if (!panelTarget) return;

  const panel = connect(panelTarget.webSocketDebuggerUrl);
  await panel.ready;
  await panel.send('Runtime.enable');
  await waitForChromeApi(panel);
  await sleep(1000);

  // 打开唯一标识的测试页
  const uniq = 'nbc' + Date.now();
  const tabId = await sw.evaluate(
    `chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/testpage.html?${uniq}'}).then(t=>t.id)`
  );
  await sleep(2500);
  check('测试页已打开', Number.isInteger(tabId), 'tabId=' + tabId);

  const call = (name, args = {}) =>
    panel
      .evaluate(
        `chrome.runtime.sendMessage({type:'nbc:tool',name:${JSON.stringify(name)},` +
          `args:${JSON.stringify(args)},tabId:${tabId}}).then(r=>JSON.stringify(r))`
      )
      .then((s) => JSON.parse(s));

  // --- 1. page.read ------------------------------------------------------
  console.log('\n[1] page.read —— 读取网页正文');
  const read = await call('page.read');
  check('返回成功', read.ok === true, read.error || '');
  check('标题正确', read.data?.title?.includes('测试文章'), read.data?.title);
  check('抽取到正文', (read.data?.markdown?.length || 0) > 200, `${read.data?.markdown?.length} 字符`);
  check('保留了标题层级', JSON.stringify(read.data?.headings || []).includes('Manifest V3'));
  check('清除了广告噪音', !read.data?.markdown?.includes('广告位'));
  check('保留了表格内容', read.data?.markdown?.includes('性能'));
  check('提取到元信息', read.data?.meta?.description?.includes('测试页面'));

  // --- 2. page.links -----------------------------------------------------
  console.log('\n[2] page.links —— 按扩展名过滤链接');
  const links = await call('page.links', { filter: { ext: 'pdf,mp4', sameOrigin: true } });
  check('返回成功', links.ok === true, links.error || '');
  check('找到 2 个媒体链接', links.data?.length === 2, `实际 ${links.data?.length}`);
  check('包含 pdf', JSON.stringify(links.data).includes('guide.pdf'));
  check('包含 mp4', JSON.stringify(links.data).includes('demo.mp4'));

  // --- 3. page.tables ----------------------------------------------------
  console.log('\n[3] page.tables —— 提取表格');
  const tables = await call('page.tables');
  check('返回成功', tables.ok === true, tables.error || '');
  check('表头正确', tables.data?.[0]?.headers?.includes('评分'));
  check('行数据正确', tables.data?.[0]?.rows?.[0]?.includes('92'));

  // --- 4. page.eval ------------------------------------------------------
  console.log('\n[4] page.eval —— 在 MAIN world 执行脚本');
  const ev = await call('page.eval', { code: 'return {t: document.title, sum: 1+1};' });
  check('返回成功', ev.ok === true, ev.error || '');
  check('脚本结果正确', ev.data?.sum === 2, JSON.stringify(ev.data));

  // --- 5. 样式改写 -------------------------------------------------------
  console.log('\n[5] style.* —— 修改网站样式');
  const list3 = await httpJson('/json/list');
  const pageTarget = list3.find((t) => t.type === 'page' && t.url.includes(uniq));
  const pageConn = connect(pageTarget.webSocketDebuggerUrl);
  await pageConn.ready;
  await pageConn.send('Runtime.enable');

  const pre = await pageConn.evaluate(
    `JSON.stringify({ad:getComputedStyle(document.querySelector('.ad-banner')).display, bg:getComputedStyle(document.body).backgroundColor})`
  );
  const preObj = JSON.parse(pre);

  const dark = await call('style.preset', { preset: 'dark' });
  check('dark 预设注入成功', dark.ok === true, dark.error || '');
  const hide = await call('style.hide', { selectors: ['.ad-banner'] });
  check('隐藏元素成功', hide.ok === true, hide.error || '');

  const post = JSON.parse(
    await pageConn.evaluate(
      `JSON.stringify({ad:getComputedStyle(document.querySelector('.ad-banner')).display, bg:getComputedStyle(document.body).backgroundColor, rules:Array.from(document.querySelectorAll('#nbc-style-root style')).map(s=>s.getAttribute('data-nbc-name'))})`
    )
  );
  check('广告位已被真正隐藏', post.ad === 'none', `display=${post.ad}`);
  check('深色背景已生效', post.bg !== preObj.bg, `${preObj.bg} → ${post.bg}`);
  check('规则注入到独立根节点', post.rules.length === 2, post.rules.join(','));

  const styleList = await call('style.list');
  check('style.list 返回规则', styleList.data?.length === 2);

  // --- 6. style.reset ----------------------------------------------------
  const reset = await call('style.reset');
  check('style.reset 成功', reset.ok === true, reset.error || '');
  const after = JSON.parse(
    await pageConn.evaluate(
      `JSON.stringify({ad:getComputedStyle(document.querySelector('.ad-banner')).display, rules:document.querySelectorAll('#nbc-style-root style').length})`
    )
  );
  check('页面恢复原状', after.ad === 'block', `display=${after.ad}`);
  check('规则已清空', after.rules === 0);

  // --- 7. 批量下载 -------------------------------------------------------
  console.log('\n[6] media.download —— 批量下载');
  const dl = await call('media.download', {
    urls: [
      { url: `http://127.0.0.1:${WEB_PORT}/guide.pdf`, filename: 'nbc-test-guide.pdf' },
      { url: `http://127.0.0.1:${WEB_PORT}/demo.mp4`, filename: 'nbc-test-demo.mp4' },
    ],
  });
  check('下载调用成功', dl.ok === true, dl.error || '');
  check('两个文件均成功', dl.data?.succeeded === 2, JSON.stringify(dl.data?.results));

  // --- 8. 文档导出 -------------------------------------------------------
  console.log('\n[7] doc.export —— 导出文档');
  const exp = await call('doc.export', {
    content: '# 标题\n\n正文段落。\n\n- 要点一\n- 要点二\n',
    format: 'docx',
    title: '导出测试',
  });
  check('docx 导出成功', exp.ok === true, exp.error || '');
  check('文件名正确', exp.data?.filename?.endsWith('.docx'), exp.data?.filename);

  // --- 9. 标签页管理 -----------------------------------------------------
  console.log('\n[8] tab.* —— 标签页管理');
  const tabList = await call('tab.list');
  check('tab.list 成功', tabList.ok === true, tabList.error || '');
  check('能列出网页标签页', (tabList.data?.length || 0) > 0, `${tabList.data?.length} 个`);

  // --- 10. 错误处理 ------------------------------------------------------
  console.log('\n[9] 错误处理');
  const bad = await call('page.read', { tabId: 999999 });
  check('无效 tabId 返回错误而非崩溃', bad.ok === false, bad.error?.slice(0, 60));

  console.log('\n面板控制台日志：');
  console.log(panel.logs.slice(-15).join('\n') || '（无）');
}

main()
  .catch((e) => {
    console.error('验证过程出错：', e);
    fail++;
  })
  .finally(async () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`结果：${pass} 项通过，${fail} 项失败`);
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach((f) => console.log('  ✗ ' + f));
    }
    await sleep(300);
    cleanup();
    process.exit(fail ? 1 : 0);
  });
