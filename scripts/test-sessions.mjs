#!/usr/bin/env node
// 会话持久化的单元测试（不依赖浏览器）。
//
// 覆盖：标题生成、持久化前的裁剪（截图/超长文本/条数）、
// 索引与正文分层、超出上限的清理、标签页轻关联、偏好读写。
//
// 用法：node scripts/test-sessions.mjs

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

/** 内存版 chrome.storage：只实现本项目用到的 get/set/remove。 */
function makeStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

const SESSIONS = pathToFileURL(
  join(process.cwd(), 'extension', 'src', 'shared', 'sessions.js')
).href;
const mod = await import(SESSIONS);
const {
  createSessionStore,
  newSessionId,
  deriveTitle,
  sanitizeMessages,
  MAX_SESSIONS,
  MAX_MESSAGES,
  MAX_TEXT,
  MAX_SESSION_CHARS,
  IMAGE_PLACEHOLDER,
  LIST_KEY,
} = mod;

const local = makeStorage();
const session = makeStorage();
const store = createSessionStore(local, session);

const now = Date.now();

console.log('\n[1] 标题生成');
{
  check('压缩空白', deriveTitle('  你好\n\n  世界  ') === '你好 世界', deriveTitle('  你好\n\n  世界  '));
  check('超长截断并加省略号', deriveTitle('啊'.repeat(50)).length <= 33, String(deriveTitle('啊'.repeat(50)).length));
  check('空内容回退到「新会话」', deriveTitle('   ') === '新会话', deriveTitle('   '));
  check('去掉代码块', !deriveTitle('看这个 ```js\nx\n``` 结果').includes('x'), '');
}

console.log('\n[2] 持久化前的裁剪');
{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'user',
      content: [
        { type: 'image', mime: 'image/jpeg', data: 'A'.repeat(5000) },
        { type: 'tool_result', tool_use_id: 't1', content: 'B'.repeat(9000) },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'C'.repeat(30000) }] },
  ];
  const out = sanitizeMessages(msgs);
  const json = JSON.stringify(out);
  check('截图 base64 被替换成占位符', !json.includes('A'.repeat(100)) && json.includes(IMAGE_PLACEHOLDER), '');
  check('超长工具结果被截断', !json.includes('B'.repeat(2100)), '');
  check('超长正文被截断', !json.includes('C'.repeat(20100)), '');
  check('截断处有标记', json.includes('[已截断]'), '');
  check('消息条数上限', sanitizeMessages(Array.from({ length: MAX_MESSAGES + 10 }, (_, i) => ({ role: 'user', content: `m${i}` }))).length === MAX_MESSAGES, '');

  // 单条都合规、总量也不能无限：120 条 × 2 万字一样会撑爆存储配额
  const heavy = Array.from({ length: 40 }, () => ({
    role: 'user',
    content: [{ type: 'text', text: 'D'.repeat(MAX_TEXT) }],
  }));
  const hs = sanitizeMessages(heavy);
  const hsSize = JSON.stringify(hs).length;
  check('会话总量有预算上限', hsSize <= MAX_SESSION_CHARS + MAX_TEXT + 200,
    `${hsSize} 字符 / 上限 ${MAX_SESSION_CHARS}`);
  check('预算内至少保留最近两条', hs.length >= 2, `${hs.length} 条`);
}

console.log('\n[3] 保存 / 列出 / 读取');
{
  const a = await store.saveSession({
    id: 'a',
    title: '会话 A',
    createdAt: now - 1000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }],
    tab: { url: 'https://example.com/a', title: 'A 页面' },
  });
  const b = await store.saveSession({
    id: 'b',
    title: '会话 B',
    createdAt: now - 500,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'B' }] }],
  });
  const list = await store.list();
  check('列表按更新时间倒序', list[0].id === 'b' && list[1].id === 'a', list.map((x) => x.id).join(','));
  check('索引含消息条数', list[0].messageCount === 1, String(list[0].messageCount));
  check('索引含来源标签页', list[1].tab?.url === 'https://example.com/a', JSON.stringify(list[1].tab));
  const loaded = await store.load('a');
  check('能读回完整消息', loaded?.messages?.[0]?.content?.[0]?.text === 'A', '');
  check('保存时刷新 updatedAt', a.updatedAt <= b.updatedAt, `${a.updatedAt} / ${b.updatedAt}`);
  check('不存在的会话返回 null', (await store.load('nope')) === null, '');
}

console.log('\n[4] 当前会话指针');
{
  await store.setCurrent('b');
  check('写入并读回', (await store.getCurrent()) === 'b', String(await store.getCurrent()));
  await store.setCurrent(null);
  check('清空指针', (await store.getCurrent()) === null, '');
}

console.log('\n[5] 重命名');
{
  const r = await store.renameSession('a', '  改名后的 A  ');
  check('返回新标题', r?.title === '改名后的 A', r?.title);
  const list = await store.list();
  check('索引同步更新', list.find((x) => x.id === 'a')?.title === '改名后的 A', '');
}

console.log('\n[6] 标签页轻关联');
{
  await store.bindTab(101, 'a', 'https://example.com/page1');
  check('同站点能找回会话', (await store.sessionForTab(101, 'https://example.com/page2')) === 'a', '');
  check('站点不一致时丢弃绑定', (await store.sessionForTab(101, 'https://other.com/x')) === null, '');
  check('丢弃后再次查询为空', (await store.sessionForTab(101, 'https://example.com/page2')) === null, '');
  await store.bindTab(102, 'b', 'https://example.com/b');
  check('未绑定标签页返回 null', (await store.sessionForTab(999)) === null, '');
  await store.removeSession('b');
  check('删除会话时清掉绑定', (await store.sessionForTab(102)) === null, '');
}

console.log('\n[7] 偏好设置');
{
  check('默认跟随标签页', (await store.getPrefs()).followTab === true, '');
  await store.setPrefs({ followTab: false });
  check('写入后读回 false', (await store.getPrefs()).followTab === false, '');
}

console.log('\n[8] 超出上限时清理最旧会话');
{
  const s2 = makeStorage();
  const st2 = createSessionStore(s2);
  for (let i = 0; i < MAX_SESSIONS + 3; i++) {
    await st2.saveSession({
      id: `x${i}`,
      title: `X${i}`,
      createdAt: now + i,
      messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
    });
  }
  const list = await st2.list();
  check('会话数量被限制', list.length === MAX_SESSIONS, `${list.length}`);
  check('最旧的会话被删除', !list.some((x) => x.id === 'x0'), '');
  check('最旧的正文也已删除', (await st2.load('x0')) === null, '');
  check('索引键没有被残留', s2.data.has(LIST_KEY), '');
}

console.log('\n[9] 删除当前会话');
{
  await store.setCurrent('a');
  await store.removeSession('a');
  check('正文已删除', (await store.load('a')) === null, '');
  check('索引已移除', !(await store.list()).some((x) => x.id === 'a'), '');
  check('当前指针被清空', (await store.getCurrent()) === null, String(await store.getCurrent()));
}

console.log('\n[10] 会话 id 不重复');
{
  const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
  check('200 个 id 互不相同', ids.size === 200, `${ids.size}`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`结果：${pass} 项通过，${fail} 项失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail ? 1 : 0);
