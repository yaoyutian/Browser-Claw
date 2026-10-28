#!/usr/bin/env node
// 端到端验证脚本：用 CDP 启动 Edge、加载扩展、逐项验证工具是否真的工作。
//
// 用法：
//   node scripts/verify-e2e.mjs
//
// 依赖：本机装有 Edge/Chrome；python3 用于起本地测试页。
// 它会真实地：加载扩展 → 打开测试页 → 调工具 → 检查 DOM/文件系统结果。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
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
  const boxJson = await sc.evaluate(`(() => {
    const cell = document.querySelector('#tbl tbody tr td');
    if (!cell) return 'null';
    const r = cell.getBoundingClientRect();
    return JSON.stringify({
      x1: r.left + 1, y1: r.top + r.height / 2 - 1,
      x2: r.right - 1, y2: r.top + r.height / 2 + 1
    });
  })()`);
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
    cleanup();
    process.exit(fail ? 1 : 0);
  });
