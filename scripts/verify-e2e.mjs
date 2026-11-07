#!/usr/bin/env node
// 端到端验证脚本：用 CDP 启动 Edge、加载扩展、逐项验证工具是否真的工作。
//
// 用法：
//   node scripts/verify-e2e.mjs
//
// 依赖：本机装有 Edge/Chrome；python3 用于起本地测试页。
// 它会真实地：加载扩展 → 打开测试页 → 调工具 → 检查 DOM/文件系统结果。

import { spawn, spawnSync } from 'node:child_process';
import { killTree, cleanupStrayTestBrowsers, cleanupStrayTestBrowsersAsync, assertOwnsCdpPort } from './_browser.mjs';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync,
  readdirSync, statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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

// 清理残留浏览器进程，避免上次中断留下的进程干扰本次测试
await import('./_cleanup.mjs');

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

// --- 分页表格测试页：3 页 × 3 行，每行 3 个 PDF 链接 ---
mkdirSync(join(webRoot, 'docs'), { recursive: true });
for (let i = 1; i <= 9; i++) {
  writeFileSync(
    join(webRoot, 'docs', `doc${i}.pdf`),
    Buffer.from(`%PDF-1.4\n% nbc table test doc ${i}\n`, 'latin1')
  );
}
// --- 无限滚动表格测试页：无分页控件，滚动到底部才加载下一批 ---
writeFileSync(
  join(webRoot, 'scroll-table.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无限滚动报表</title>
<style>body{font-family:sans-serif;margin:0}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:6px}#spacer{height:2000px}</style></head><body>
<h1>无限滚动报表</h1>
<table id="tbl">
<thead><tr><th>批次</th><th>项目</th><th>第二季度</th></tr></thead>
<tbody id="tbody"></tbody></table>
<div id="spacer"></div>
<script>
let batch = 0;
function loadMore(){
  batch += 1;
  const tb = document.getElementById('tbody');
  for (let i = 0; i < 3; i++) {
    const n = (batch-1)*3 + i + 1;
    const tr = document.createElement('tr');
    ['批次'+batch, '项目'+n, ''].forEach(function(cell, ci){
      const td = document.createElement('td');
      if (ci < 2) { td.textContent = cell; }
      else {
        const a = document.createElement('a');
        a.href = 'docs/sdoc' + n + '.pdf';
        a.textContent = '下载';
        a.setAttribute('download', '');
        td.appendChild(a);
      }
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
}
// 滚到底部时加载下一批（模拟无限滚动）
window.addEventListener('scroll', function(){
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 100 && batch < 3) {
    loadMore();
  }
});
</script></body></html>`
);
for (let i = 1; i <= 9; i++) {
  writeFileSync(
    join(webRoot, 'docs', `sdoc${i}.pdf`),
    Buffer.from(`%PDF-1.4
% nbc scroll test ${i}
`, 'latin1')
  );
}

// --- 带外链资源的测试页：验证归档的内联能力 ---
writeFileSync(
  join(webRoot, 'style.css'),
  'body { color: #123456; font-family: serif; }'
);
writeFileSync(
  join(webRoot, 'pic.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);
writeFileSync(
  join(webRoot, 'assets.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>带资源页面</title>
<link rel="stylesheet" href="style.css"></head><body>
<h1>带外链资源的页面</h1>
<p>这个页面引用了外部 CSS 与图片，用于验证归档时的资源内联。</p>
<img src="pic.png" alt="测试图片" width="1" height="1">
<p><a href="https://example.com/original">外部链接</a></p>
</body></html>`
);

writeFileSync(
  join(webRoot, 'table.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>年度报表</title>
<style>body{font-family:sans-serif}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:6px}a{color:#06c}</style></head><body>
<h1>2026 年度报告下载</h1>
<table id="tbl">
<thead><tr><th>项目名称</th><th>第一季度</th><th>第二季度</th><th>第三季度</th><th>操作</th></tr></thead>
<tbody id="tbody"></tbody></table>
<div class="pagination">
  <button id="prev">上一页</button>
  <span id="pageinfo">1 / 3</span>
  <button id="next">下一页</button>
</div>
<script>
const DATA = [
  [['华东区','产品A','市场报告'],['华南区','产品B','财务报告'],['华北区','产品C','运营报告']],
  [['西南区','产品D','审计报告'],['东北区','产品E','技术报告'],['西北区','产品F','合规报告']],
  [['海外部','产品G','年度报告'],['总部','产品H','质量报告'],['研发部','产品I','专利报告']]
];
let page = 0;
function render(){
  const tb = document.getElementById('tbody');
  tb.innerHTML = '';
  DATA[page].forEach(function(row, ri){
    const tr = document.createElement('tr');
    row.forEach(function(cell, ci){
      const td = document.createElement('td');
      if (ci < 2) { td.textContent = cell; }
      else {
        const a = document.createElement('a');
        a.href = 'docs/doc' + (page*3 + ri + 1) + '.pdf';
        a.textContent = '下载';
        a.setAttribute('download', '');
        td.appendChild(a);
      }
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  document.getElementById('pageinfo').textContent = (page+1)+' / 3';
}
document.getElementById('next').onclick = function(){ if(page < DATA.length-1){ page++; render(); } };
document.getElementById('prev').onclick = function(){ if(page > 0){ page--; render(); } };
render();
</script></body></html>`
);

const webServer = spawn('python', ['-m', 'http.server', String(WEB_PORT), '--directory', webRoot], {
  stdio: 'ignore',
});

// 自己启动一个 companion（默认端口 8787），保证「下载能力」相关测试
// 不依赖外部状态 —— 之前依赖外部手动启动的 companion，会话结束进程被回收，
// 测试就时好时坏。
// 用 8789（不在用户扩展的默认候选列表的坑位之外？在列表里，但这是测试实例自己的
// 扩展在轮询，与用户实例无关 —— 用户实例连的是它自己探测到的端口）。
const companionProc = spawn(
  process.execPath,
  [join(ROOT, 'companion', 'server.mjs')],
  {
    env: { ...process.env, NBC_PORT: '8789' },
    stdio: 'ignore',
  }
);

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

const cleanup = async () => {
  killTree(proc.pid);
  await cleanupStrayTestBrowsersAsync();
  killTree(webServer.pid);
  killTree(companionProc.pid);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(webRoot, { recursive: true, force: true }); } catch {}
};
process.on('exit', () => { cleanupStrayTestBrowsers(); });
process.on('SIGINT', () => { cleanupStrayTestBrowsers(); process.exit(1); });

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

// 测试依赖 Edge 持续运行；若中途被关闭，后续断言会莫名失败。
// 记录存活状态，失败时能区分「环境中断」与「功能缺陷」。
let browserAlive = true;
let aliveCheck = null;

function startAliveCheck() {
  aliveCheck = setInterval(() => {
    httpJson('/json/list')
      .then(() => { browserAlive = true; })
      .catch(() => { browserAlive = false; });
  }, 2000);
}

async function main() {
  await waitForDevtools();
  await sleep(2500);
  startAliveCheck();

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

  // ⚠ 安全闸门：确认占用调试端口的进程确实是**我们这次启动的实例**。
  // 否则扩展可能跑在用户自己开着远程调试的浏览器里，
  // 工具就会去操作用户的真实页面（实测发生过）。
  const owner = assertOwnsCdpPort(PORT, profile);
  if (!owner.ok) {
    console.error(
      `\n✗ 调试端口 ${PORT} 不是本次测试的浏览器实例（${owner.cmd}）。` +
        '\n  为避免在你的真实页面上执行工具，测试已中止。' +
        '\n  请关掉占用该端口的浏览器后重试。'
    );
    process.exit(1);
  }

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

  // --- 11. 表格批量下载 --------------------------------------------------
  console.log('\n[10] table.* —— 表格里的文档批量下载');
  await sw.evaluate(
    `chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/table.html'}).then(t=>t.id)`
  );
  await sleep(2000);
  const tableList = await httpJson('/json/list');
  const tableTarget = tableList.find((t) => t.type === 'page' && t.url.includes('table.html'));
  const tableTabId = await sw.evaluate(
    `chrome.tabs.query({url:'http://127.0.0.1:${WEB_PORT}/table.html'}).then(ts=>ts[ts.length-1].id)`
  );
  check('分页表格页已打开', Boolean(tableTarget), tableTarget?.url || '');

  const tableCall = (name, args = {}) =>
    panel
      .evaluate(
        `chrome.runtime.sendMessage({type:'nbc:tool',name:${JSON.stringify(name)},` +
          `args:${JSON.stringify(args)},tabId:${tableTabId}}).then(r=>JSON.stringify(r))`
      )
      .then((s) => JSON.parse(s));

  const docs = await tableCall('table.docs', { exts: 'pdf', maxPages: 5 });
  check('table.docs 执行成功', docs.ok === true, docs.error || '');
  check('采集到 9 个文档链接', docs.data?.total === 9, `实际 ${docs.data?.total}`);
  // pages 里最后一项可能是「内容未变化」的停止标记，所以真实页数 = 采集到的不同 pageIndex 数
  const distinctPages = new Set((docs.data?.items || []).map((i) => i.pageIndex)).size;
  check('覆盖了 3 页数据', distinctPages === 3, `${distinctPages} 页`);
  check('带上了行标签', (docs.data?.items?.[0]?.rowLabel || '').length > 0, docs.data?.items?.[0]?.rowLabel);
  check('带上了列标题', (docs.data?.items?.[0]?.colHeader || '').length > 0, docs.data?.items?.[0]?.colHeader);
  check('标记了来源页码', docs.data?.items?.[0]?.pageIndex === 1, `pageIndex=${docs.data?.items?.[0]?.pageIndex}`);
  check(
    '翻页后拿到了第 2 页的行',
    docs.data?.items?.some((i) => i.rowLabel === '西南区'),
    docs.data?.items?.map((i) => i.rowLabel).join(',')
  );
  check(
    '翻页后拿到了第 3 页的行',
    docs.data?.items?.some((i) => i.rowLabel === '海外部'),
    ''
  );

  const tdl = await tableCall('table.download', { exts: 'pdf', maxPages: 5 });
  check('table.download 执行成功', tdl.ok === true, tdl.error || '');
  check(
    '9 个文件全部下载成功',
    tdl.data?.succeeded === 9,
    JSON.stringify(tdl.data?.results?.filter((r) => !r.ok))
  );
  check(
    '文件名含行标签',
    (tdl.data?.results?.[0]?.filename || '').includes('华东区'),
    tdl.data?.results?.slice(0, 3).map((r) => r.filename).join(' | ')
  );
  check(
    '文件名含列标题',
    (tdl.data?.results?.[0]?.filename || '').includes('第二季度'),
    tdl.data?.results?.[0]?.filename
  );
  check(
    '文件名保留 pdf 扩展名',
    (tdl.data?.results?.[0]?.filename || '').endsWith('.pdf'),
    tdl.data?.results?.[0]?.filename
  );
  check(
    '跨页文件命名不重复',
    new Set((tdl.data?.results || []).map((r) => r.filename)).size === 9,
    `去重后 ${new Set((tdl.data?.results || []).map((r) => r.filename)).size} 个`
  );

  // --- 12. 无限滚动表格 --------------------------------------------------
  console.log('\n[11] 无限滚动表格采集');
  await sw.evaluate(
    `chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/scroll-table.html'}).then(t=>t.id)`
  );
  await sleep(2000);
  const scrollTabId = await sw.evaluate(
    `chrome.tabs.query({url:'http://127.0.0.1:${WEB_PORT}/scroll-table.html'}).then(ts=>ts[ts.length-1].id)`
  );

  // 等页面真正渲染出表格行 —— 系统负载高时固定 sleep 不够，
  // 表格还是空的就会采到 0 条（实测踩过）。
  const listScrollWait = await httpJson('/json/list');
  const scrollTargetWait = listScrollWait.find(
    (t) => t.type === 'page' && t.url.includes('scroll-table.html')
  );
  if (scrollTargetWait) {
    const scWait = connect(scrollTargetWait.webSocketDebuggerUrl);
    await scWait.ready;
    await scWait.send('Runtime.enable');
    for (let i = 0; i < 24; i++) {
      const rows = await scWait
        .evaluate(`document.querySelectorAll('#tbody tr').length`)
        .catch(() => 0);
      if (rows > 0) break;
      await sleep(400);
    }
    scWait.ws.close();
  }
  await sleep(500);
  const scrollCall = (name, args = {}) =>
    panel
      .evaluate(
        `chrome.runtime.sendMessage({type:'nbc:tool',name:${JSON.stringify(name)},` +
          `args:${JSON.stringify(args)},tabId:${scrollTabId}}).then(r=>JSON.stringify(r))`
      )
      .then((s) => JSON.parse(s));

  const sdocs = await scrollCall('table.docs', { exts: 'pdf', maxPages: 5, scroll: 'scrolled' });
  check('无限滚动采集成功', sdocs.ok === true, sdocs.error || '');
  check(
    '滚动加载收集到多批数据',
    (sdocs.data?.total || 0) >= 6,
    `实际 ${sdocs.data?.total} 条，模式=${sdocs.data?.mode}`
  );
  check('识别为滚动模式', sdocs.data?.mode === 'scrolled', sdocs.data?.mode);

  // --- 13. 划词 ----------------------------------------------------------
  console.log('\n[12] 划词选择');
  const listScroll = await httpJson('/json/list');
  const scrollTarget = listScroll.find(
    (t) => t.type === 'page' && t.url.includes('scroll-table.html')
  );
  const sc = connect(scrollTarget.webSocketDebuggerUrl);
  await sc.ready;
  await sc.send('Runtime.enable');
  // 用真实鼠标拖拽建立选区 ——
  // Runtime.evaluate 建立的选区只属于调试上下文，页面世界（MAIN world）读不到，
  // 而真实选区正是靠 chrome.scripting.executeScript({world:'MAIN'}) 读取的。
  // 先等元素出现（负载高时页面可能还没渲染完）。
  let boxJson = 'null';
  for (let i = 0; i < 20 && boxJson === 'null'; i++) {
    boxJson = await sc.evaluate(`(() => {
      const cell = document.querySelector('#tbl tbody tr td');
      if (!cell) return 'null';
      const r = cell.getBoundingClientRect();
      return JSON.stringify({
        x1: r.left + 1, y1: r.top + r.height / 2 - 1,
        x2: r.right - 1, y2: r.top + r.height / 2 + 1
      });
    })()`);
    if (boxJson === 'null') await sleep(400);
  }
  check('找到可划词元素', boxJson !== 'null', '');
  if (boxJson !== 'null') {
    const b = JSON.parse(boxJson);
    await sc.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: b.x1, y: b.y1, button: 'left', clickCount: 1,
    });
    await sc.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: b.x2, y: b.y2, button: 'left', buttons: 1,
    });
    await sc.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: b.x2, y: b.y2, button: 'left', clickCount: 1,
    });
    await sleep(1200);

    // 走真实路径：侧边栏 → 后台 → MAIN world 查询
    const selAfter = await panel.evaluate(
      `chrome.runtime.sendMessage({type:'nbc:tool',name:'page.selection',args:{tabId:${scrollTabId}}}).then(r=>JSON.stringify(r))`
    );
    const selParsed = JSON.parse(selAfter);
    check('page.selection 读到选中的文字', (selParsed.data?.text || '').length > 0,
      (selParsed.data?.text || '').slice(0, 40));
    check('选区附带页面 URL', (selParsed.data?.url || '').includes('scroll-table.html'),
      (selParsed.data?.url || '').slice(0, 60));
    check('选区附带上下文文本', typeof selParsed.data?.context === 'string',
      (selParsed.data?.context || '').slice(0, 40));
  }
  sc.ws.close();

  // --- 14. 站点样式规则持久化 --------------------------------------------
  console.log('\n[13] style.save —— 站点样式规则持久化');
  await sw.evaluate(
    `chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/testpage.html'}).then(t=>t.id)`
  );
  await sleep(2000);
  const rulesTabId = await sw.evaluate(
    `chrome.tabs.query({url:'http://127.0.0.1:${WEB_PORT}/testpage.html'}).then(ts=>ts[ts.length-1].id)`
  );
  const rulesCall = (name, args = {}) =>
    panel
      .evaluate(
        `chrome.runtime.sendMessage({type:'nbc:tool',name:${JSON.stringify(name)},` +
          `args:${JSON.stringify(args)},tabId:${rulesTabId}}).then(r=>JSON.stringify(r))`
      )
      .then((s) => JSON.parse(s));

  await rulesCall('style.preset', { preset: 'dark' });
  const saved = await rulesCall('style.save', {});
  check('style.save 成功', saved.ok === true, saved.error || '');
  check('按主机名保存', saved.data?.host === '127.0.0.1', saved.data?.host);
  check('保存了规则条数', saved.data?.count === 1, `count=${saved.data?.count}`);

  const listed = await rulesCall('style.rules', {});
  check('style.rules 列出了站点',
    listed.data?.sites?.some((s) => s.host === '127.0.0.1'),
    JSON.stringify(listed.data?.sites?.map((s) => s.host)));

  // 重新加载页面，验证规则自动生效
  await sw.evaluate(`chrome.tabs.reload(${rulesTabId})`);
  await sleep(3000);
  const listRules = await httpJson('/json/list');
  const rulesTarget = listRules.find(
    (t) => t.type === 'page' && t.url.includes('testpage.html')
  );
  const rc = connect(rulesTarget.webSocketDebuggerUrl);
  await rc.ready;
  await rc.send('Runtime.enable');
  await sleep(1500);
  const autoApplied = await rc.evaluate(
    `JSON.stringify({bg: getComputedStyle(document.body).backgroundColor, rules: document.querySelectorAll('#nbc-style-root style').length})`
  );
  const autoObj = JSON.parse(autoApplied);
  check('重载后规则自动应用', autoObj.rules === 1, `规则数=${autoObj.rules}`);
  check('重载后深色样式生效', autoObj.bg !== 'rgba(0, 0, 0, 0)', `bg=${autoObj.bg}`);

  const cleared = await rulesCall('style.rules', { action: 'clear' });
  check('style.rules 可清除规则', cleared.ok === true, cleared.error || '');
  const afterClear = await rulesCall('style.rules', {});
  check('清除后不再有该站点',
    !afterClear.data?.sites?.some((s) => s.host === '127.0.0.1'),
    JSON.stringify(afterClear.data?.sites?.map((s) => s.host)));
  rc.ws.close();


  // --- 15. 摘录导出为 Markdown --------------------------------------------
  console.log('\n[14] clip.export —— 摘录导出为 Markdown');
  const artTabId = await sw.evaluate(
    `chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/testpage.html'}).then(t=>t.id)`
  );
  await sleep(2000);
  const listClip = await httpJson('/json/list');
  const artTarget = listClip.find(
    (t) => t.type === 'page' && t.url.includes('testpage.html')
  );
  const artConn = connect(artTarget.webSocketDebuggerUrl);
  await artConn.ready;
  await artConn.send('Runtime.enable');

  const clipBox = await artConn.evaluate(`(() => {
    const p = document.querySelector('.article-body p');
    if (!p) return 'null';
    const r = p.getBoundingClientRect();
    return JSON.stringify({
      x1: r.left + 1, y1: r.top + r.height / 2 - 1,
      x2: r.right - 1, y2: r.top + r.height / 2 + 1
    });
  })()`);
  check('找到可摘录的段落', clipBox !== 'null', '');
  if (clipBox !== 'null') {
    const b = JSON.parse(clipBox);
    await artConn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: b.x1, y: b.y1, button: 'left', clickCount: 1,
    });
    await artConn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: b.x2, y: b.y2, button: 'left', buttons: 1,
    });
    await artConn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: b.x2, y: b.y2, button: 'left', clickCount: 1,
    });
    await sleep(1200);

    const clip = await panel.evaluate(`chrome.runtime.sendMessage({
      type:'nbc:tool', name:'clip.export',
      args:{ scope:'selection', note:'测试附注', tabId:${artTabId} }
    }).then(r=>JSON.stringify(r))`).then((s) => JSON.parse(s));
    check('clip.export 成功', clip.ok === true, clip.error || '');
    check('生成了 .md 文件', clip.data?.filename?.endsWith('.md'), clip.data?.filename);
    check('内容含 YAML frontmatter', (clip.data?.preview || '').startsWith('---'),
      (clip.data?.preview || '').slice(0, 30));
    check('frontmatter 含来源链接', (clip.data?.preview || '').includes('source:'), '');
    check('frontmatter 含标题', (clip.data?.preview || '').includes('title:'), '');
    check('内容含选中的文字', (clip.data?.preview || '').includes('Manifest V3'), '');
    check('内容含附注', (clip.data?.preview || '').includes('测试附注'), '');
    check('内容含来源 URL', (clip.data?.preview || '').includes('testpage.html'), '');
  }
  artConn.ws.close();

  const clipArticle = await panel.evaluate(`chrome.runtime.sendMessage({
    type:'nbc:tool', name:'clip.export',
    args:{ scope:'article', tabId:${artTabId} }
  }).then(r=>JSON.stringify(r))`).then((s) => JSON.parse(s));
  check('整篇摘录成功', clipArticle.ok === true, clipArticle.error || '');
  check('整篇含完整正文', (clipArticle.data?.bytes || 0) > 800,
    `${clipArticle.data?.bytes} 字节`);
  check('整篇含文章标题', (clipArticle.data?.preview || '').includes('Manifest V3'),
    (clipArticle.data?.preview || '').slice(0, 60));

  // --- 16. 整页归档为单文件 HTML ------------------------------------------
  console.log('\n[15] page.archive —— 整页归档为单文件 HTML');
  const archived = await panel.evaluate(`chrome.runtime.sendMessage({
    type:'nbc:tool', name:'page.archive', args:{ tabId:${artTabId} }
  }).then(r=>JSON.stringify(r))`).then((s) => JSON.parse(s));
  check('page.archive 成功', archived.ok === true, archived.error || '');
  check('生成 .html 文件', archived.data?.filename?.endsWith('.html'), archived.data?.filename);
  check('文件非空', (archived.data?.bytes || 0) > 1000, `${archived.data?.bytes} 字节`);
  check('记录了来源地址',
    (archived.data?.meta?.url || '').includes('testpage.html'), archived.data?.meta?.url);
  check('记录了归档时间', Boolean(archived.data?.meta?.archivedAt), '');
  check('统计了内联资源', typeof archived.data?.stats?.cssTotal === 'number',
    JSON.stringify(archived.data?.stats));

  // 带外链资源的页面：验证 CSS 与图片真的被内联成 data: URI
  await sw.evaluate(
    `chrome.tabs.create({url:'http://127.0.0.1:${WEB_PORT}/assets.html'}).then(t=>t.id)`
  );
  await sleep(2000);
  const assetsTabId = await sw.evaluate(
    `chrome.tabs.query({url:'http://127.0.0.1:${WEB_PORT}/assets.html'}).then(ts=>ts[0].id)`
  );
  const assetsArchive = await panel.evaluate(`chrome.runtime.sendMessage({
    type:'nbc:tool', name:'page.archive', args:{ tabId:${assetsTabId} }
  }).then(r=>JSON.stringify(r))`).then((s) => JSON.parse(s));
  check('带资源页面归档成功', assetsArchive.ok === true, assetsArchive.error || '');
  check('发现外部样式表', (assetsArchive.data?.stats?.cssTotal || 0) >= 1,
    `cssTotal=${assetsArchive.data?.stats?.cssTotal}`);
  check('发现外部图片', (assetsArchive.data?.stats?.imagesTotal || 0) >= 1,
    `imagesTotal=${assetsArchive.data?.stats?.imagesTotal}`);
  check('样式表已内联', (assetsArchive.data?.stats?.cssInlined || 0) >= 1,
    `cssInlined=${assetsArchive.data?.stats?.cssInlined}`);
  check('图片已内联', (assetsArchive.data?.stats?.imagesInlined || 0) >= 1,
    `imagesInlined=${assetsArchive.data?.stats?.imagesInlined}`);

  // 读回归档产物，检查内容真的自包含（data: URI、脚本已移除、来源信息在）。
  // 用 handler 返回的真实路径，并等待文件出现 ——
  // 用目录 glob 会匹配到上一轮遗留的旧文件，断言就失去意义了。
  const dlDir = join(homedir(), 'Downloads');
  let archiveFile = '';
  // 不依赖 handler 返回的路径：chrome.downloads.search({id}) 在下载刚启动时
  // 还查不到记录，返回的路径没有 " (N)" 后缀，与磁盘上的实际文件对不上。
  // 改为按 mtime 找最新的归档文件，再用内容特征确认是本次产物（更严格）。
  for (let i = 0; i < 24; i++) {
    const cands = readdirSync(dlDir)
      .filter((f) => f.includes('archive-') && f.endsWith('.html'))
      .map((f) => {
        const full = join(dlDir, f);
        let t = 0;
        try { t = statSync(full).mtimeMs; } catch { /* ignore */ }
        return { full, t };
      })
      .sort((a, b) => b.t - a.t);
    for (const c of cands) {
      try {
        const html = readFileSync(c.full, 'utf8');
        // 本次归档的特征：引用了带资源的那张图
        if (html.includes('带外链资源的页面')) {
          archiveFile = c.full;
          break;
        }
      } catch { /* ignore */ }
    }
    if (archiveFile) break;
    await sleep(300);
  }
  check('归档文件已落盘', Boolean(archiveFile), archiveFile);
  if (archiveFile) {
    const html = readFileSync(archiveFile, 'utf8');
    check('归档内含 data: URI 的图片', html.includes('data:image/'), '');
    check('归档内含内联的样式', html.includes('#123456'), '');
    check('归档已移除脚本', !html.includes('<script'), '');
    check('归档含来源信息', html.includes('网页归档'), '');
    check('归档含原始链接', html.includes('原链接'), '');
    check('归档内容对应本次页面', html.includes('带外链资源的页面'),
      html.slice(0, 200).replace(/\s+/g, ' '));
  }

  // --- 17. 下载队列与进度 --------------------------------------------------
  console.log('\n[16] download.queue —— 下载队列');
  const qClear = await call('download.queue', { action: 'clear' });
  check('队列可清空', qClear.ok === true, qClear.error || '');

  const queued = await call('media.download', {
    urls: [
      { url: `http://127.0.0.1:${WEB_PORT}/guide.pdf`, filename: 'nbc-q1.pdf' },
      { url: `http://127.0.0.1:${WEB_PORT}/demo.mp4`, filename: 'nbc-q2.mp4' },
    ],
    queue: true,
  });
  check('加入队列成功', queued.ok === true, queued.error || '');
  check('返回队列模式', queued.data?.mode === 'queue', queued.data?.mode);
  check('报告入队数量', queued.data?.queued === 2, `queued=${queued.data?.queued}`);

  await sleep(3000);
  const qStatus = await call('download.queue', { action: 'status' });
  check('队列状态可查询', qStatus.ok === true, qStatus.error || '');
  check('队列含 2 个任务', qStatus.data?.queue?.total === 2,
    `total=${qStatus.data?.queue?.total}`);
  check('有任务已完成', (qStatus.data?.queue?.done || 0) >= 1,
    `done=${qStatus.data?.queue?.done} failed=${qStatus.data?.queue?.failed}`);

  // --- 18. 对话导出为 Markdown --------------------------------------------
  console.log('\n[17] chat.export —— 对话导出为 Markdown');
  const synced = await panel.evaluate(`chrome.runtime.sendMessage({
    type: 'nbc:chat:sync',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '帮我总结这个页面' }] },
      { role: 'assistant', content: [{ type: 'text', text: '这是页面摘要。' },
        { type: 'tool_use', id: 't1', name: 'page.read', input: { tabId: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1',
        content: '{"title":"测试文章","markdown":"# 正文"}' }] }
    ],
    meta: { model: 'gpt-4o-mini', provider: 'OpenAI' }
  }).then(r=>JSON.stringify(r))`);
  check('对话历史同步成功', JSON.parse(synced).ok === true, synced);

  const chat = await call('chat.export', { title: '测试对话' });
  check('chat.export 成功', chat.ok === true, chat.error || '');
  check('生成 .md 文件', chat.data?.filename?.endsWith('.md'), chat.data?.filename);
  check('含 YAML frontmatter', (chat.data?.preview || '').startsWith('---'), '');
  check('含标题', (chat.data?.preview || '').includes('测试对话'), '');
  check('含用户消息', (chat.data?.preview || '').includes('帮我总结这个页面'), '');
  check('含助手消息', (chat.data?.preview || '').includes('这是页面摘要'), '');
  check('含工具调用记录', (chat.data?.preview || '').includes('page.read'), '');
  check('含工具结果', (chat.data?.preview || '').includes('测试文章'), '');
  check('记录了消息条数', chat.data?.count === 3, `count=${chat.data?.count}`);

  // --- 19. 连通性诊断 ----------------------------------------------------
  console.log('\n[18] diagnose.connection —— 连通性诊断');
  const diag = await panel.evaluate(`chrome.runtime.sendMessage({
    type:'nbc:tool', name:'diagnose.connection',
    args:{ provider: {
      providerId:'deepseek', kind:'openai',
      baseUrl:'https://api.deepseek.com', apiKey:'sk-invalid-test',
      model:'deepseek-flash', transport:'direct'
    } }
  }).then(r=>JSON.stringify(r))`).then((s) => JSON.parse(s));
  check('diagnose.connection 执行成功', diag.ok === true, diag.error || '');
  check('返回了直连测试结果', diag.data?.tests?.some((t) => t.path === 'direct'),
    JSON.stringify(diag.data?.tests?.map((t) => t.path)));
  check('返回了中继测试结果', diag.data?.tests?.some((t) => t.path === 'relay'),
    JSON.stringify(diag.data?.tests?.map((t) => t.path)));
  const directTest = diag.data?.tests?.find((t) => t.path === 'direct');
  check('直连测试有明确结论', Boolean(directTest?.ok !== undefined),
    directTest?.note || directTest?.error || '');
  check('失败时给出可操作的原因',
    directTest?.ok !== false || Boolean(directTest?.note),
    directTest?.note?.slice(0, 60) || '');

  // --- 20. 下载能力（yt-dlp 链路）---------------------------------------
  console.log('\n[19] media.capabilities / media.downloadPage —— 下载能力');
  const caps = await call('media.capabilities', {});
  check('media.capabilities 执行成功', caps.ok === true, caps.error || '');
  check('返回了 companion 状态', typeof caps.data?.companion === 'boolean',
    JSON.stringify(caps.data)?.slice(0, 80));
  check('返回了 yt-dlp / ffmpeg 可用性',
    typeof caps.data?.ytDlp === 'boolean' && typeof caps.data?.ffmpeg === 'boolean',
    JSON.stringify({ ytDlp: caps.data?.ytDlp, ffmpeg: caps.data?.ffmpeg }));
  check('给出了可操作提示', typeof caps.data?.hint === 'string' && caps.data.hint.length > 0,
    (caps.data?.hint || '').slice(0, 60));

  // companion 未配置 yt-dlp 时，downloadPage 要给出明确引导，而不是含糊报错
  const dpage = await call('media.downloadPage', {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  check('media.downloadPage 有明确结果', dpage.ok === true || dpage.ok === false, '');
  if (!dpage.ok) {
    check('未配置 yt-dlp 时给出配置指引',
      String(dpage.error || '') + String(dpage.detail || '').includes('yt-dlp'),
      String(dpage.error || '').slice(0, 60));
    // 失败有两种合法指引：companion 没运行（提示启动命令）、
    // 或 companion 在但没配 yt-dlp（提示去设置里填路径）。
    // 两者都可操作，都算通过 —— 不能只认其中一种。
    const guidance = String(dpage.detail || '') + String(dpage.error || '');
    check(
      '失败时给出可操作的指引（启动 companion 或配置 yt-dlp）',
      guidance.includes('companion/server.mjs') || guidance.includes('设置'),
      guidance.slice(0, 80)
    );
  }

  console.log('\n面板控制台日志：');
  console.log(panel.logs.slice(-15).join('\n') || '（无）');
}

main()
  .catch((e) => {
    console.error('验证过程出错：', e);
    fail++;
  })
  .finally(async () => {
    if (aliveCheck) clearInterval(aliveCheck);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`结果：${pass} 项通过，${fail} 项失败`);
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach((f) => console.log('  ✗ ' + f));
      if (!browserAlive) {
        console.log(
          '\n⚠ 注意：测试期间浏览器已断开（可能窗口被手动关闭）。' +
            '这种失败属于环境中断，不代表功能有问题，请重新运行。'
        );
      }
    }
    await sleep(300);
    await cleanup();
    process.exit(fail ? 1 : 0);
  });
