#!/usr/bin/env node
// agent 循环的单元测试（不依赖浏览器与网络）。
//
// 为什么需要它：端到端测试是直接调工具，绕过了 agent 循环，
// 所以「onEvent 是函数还是对象」这类循环内部的问题不会被 E2E 发现。
// 这里用假的 streamChat 覆盖循环的各条分支。
//
// 用法：node scripts/test-agent.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// agent.js 依赖 chrome.* API（runTool 走 chrome.runtime.sendMessage）。
// 这里注入最小桩件。
globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg?.type === 'nbc:tool') {
        return { ok: true, data: { ok: true, tool: msg.name, echo: msg.args } };
      }
      return { ok: true };
    },
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const { pathToFileURL } = await import('node:url');
const AGENT = pathToFileURL(
  join(process.cwd(), 'extension', 'src', 'shared', 'agent.js')
).href;
const PROVIDERS = pathToFileURL(
  join(process.cwd(), 'extension', 'src', 'shared', 'providers.js')
).href;

// 用可控的假 provider 替换真实网络请求
const { runAgent } = await import(AGENT);
const providersMod = await import(PROVIDERS);

/**
 * 让 streamChat 产出预设的序列。
 * 因为 agent.js 内部直接 import 了 streamChat（ESM 静态绑定），
 * 无法从外部替换 —— 所以这里改为起一个本地假 OpenAI 兼容服务。
 */
const PORT = 8899;
const RESPONSES = []; // 每次请求取一个

const { createServer } = await import('node:http');
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const next = RESPONSES.shift() || { text: 'ok' };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (next.reasoning) {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: next.reasoning }, index: 0 }],
        })}\n\n`
      );
    }
    if (next.text) {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: next.text }, index: 0 }],
        })}\n\n`
      );
    }
    if (next.toolCalls) {
      for (const tc of next.toolCalls) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } },
                  ],
                },
                index: 0,
              },
            ],
          })}\n\n`
        );
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const provider = {
  providerId: 'test',
  kind: 'openai',
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  apiKey: 'test-key',
  model: 'test-model',
  transport: 'direct',
};

// ---------------------------------------------------------------------------
console.log('\n[1] onEvent 为对象形式（历史上会抛 "onEvent is not a function"）');
{
  RESPONSES.length = 0;
  RESPONSES.push({ text: '你好' });
  const seen = [];
  const obj = {
    text: (t) => seen.push(['text', t]),
    tool_start: (ev) => seen.push(['tool_start', ev.name]),
    tool_end: (ev) => seen.push(['tool_end', ev.name]),
    done: (ev) => seen.push(['done', ev.text]),
    error: (ev) => seen.push(['error', ev.error]),
  };
  const r = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider,
    onEvent: obj,
  });
  check('对象式 onEvent 不再抛错', true);
  check('收到文本事件', seen.some((s) => s[0] === 'text' && s[1] === '你好'),
    JSON.stringify(seen.map((s) => s[0])));
  check('收到 done 事件', seen.some((s) => s[0] === 'done'), '');
  check('正常返回消息', r.messages.length >= 2, `${r.messages.length} 条`);
}

console.log('\n[2] onEvent 为函数形式');
{
  RESPONSES.length = 0;
  RESPONSES.push({ text: '函数式' });
  const seen = [];
  const r = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider,
    onEvent: (ev) => seen.push([ev.type, ev.text ?? ev.name ?? '']),
  });
  check('函数式 onEvent 正常', seen.some((s) => s[0] === 'text' && s[1] === '函数式'),
    JSON.stringify(seen));
  check('返回消息', r.messages.length >= 2, '');
}

console.log('\n[3] onEvent 缺省 / 非法类型');
{
  RESPONSES.length = 0;
  RESPONSES.push({ text: 'x' });
  const r1 = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider,
  });
  check('不传 onEvent 不报错', r1.messages.length >= 2, '');

  RESPONSES.length = 0;
  RESPONSES.push({ text: 'y' });
  const r2 = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider,
    onEvent: 'not-a-function',
  });
  check('非法 onEvent 类型被忽略而非崩溃', r2.messages.length >= 2, '');
}

console.log('\n[4] 工具调用往返');
{
  RESPONSES.length = 0;
  RESPONSES.push({ toolCalls: [{ id: 'c1', name: 'page.read', args: { tabId: 1 } }] });
  RESPONSES.push({ text: '已读取页面' });
  const seen = [];
  const r = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: '读页面' }] }],
    provider,
    onEvent: (ev) => seen.push(ev.type),
  });
  check('触发了 tool_start', seen.includes('tool_start'), JSON.stringify(seen));
  check('触发了 tool_end', seen.includes('tool_end'), JSON.stringify(seen));
  check('工具调用计数正确', r.toolCalls === 1, `${r.toolCalls}`);
  check('结果回传给模型', r.messages.length >= 4, `${r.messages.length} 条消息`);
  // 工具结果以 user 角色回传（内部协议），内容里是 tool_result block
  const toolResultMsg = r.messages.find((m) =>
    Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')
  );
  check('历史里有工具结果消息', Boolean(toolResultMsg),
    r.messages.map((m) => m.role).join(','));
  check('工具结果内容非空',
    Boolean(toolResultMsg?.content?.find((b) => b.type === 'tool_result')?.content), '');
}

console.log('\n[5] 工具调用前确认（beforeTool 拒绝则跳过）');
{
  RESPONSES.length = 0;
  RESPONSES.push({ toolCalls: [{ id: 'c2', name: 'media.download', args: {} }] });
  RESPONSES.push({ text: '好的，跳过了' });
  const r = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: '下载' }] }],
    provider,
    onEvent: () => {},
    beforeTool: async () => false,
  });
  const serialized = JSON.stringify(r.messages);
  check('跳过的工具没有真正执行', !serialized.includes('"ok":true,"tool":"media.download"'),
    '');
  check('模型收到了跳过信息', serialized.includes('用户拒绝'), '');
}

console.log('\n[6] 网络错误被正确上报');
{
  RESPONSES.length = 0;
  const seen = [];
  const bad = { ...provider, baseUrl: 'http://127.0.0.1:1/v1' };
  let threw = false;
  try {
    await runAgent({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      provider: bad,
      onEvent: (ev) => seen.push(ev.type),
    });
  } catch {
    threw = true;
  }
  check('请求失败时抛出', threw, '');
  check('上报了 error 事件', seen.includes('error'), JSON.stringify(seen));
}

console.log('\n[7] 思考模式（DeepSeek 的 reasoning_content）');
{
  RESPONSES.length = 0;
  RESPONSES.push({ reasoning: '让我想想…', text: '最终答案' });
  const seen = [];
  const r = await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider: { ...provider, thinking: 'on' },
    onEvent: (ev) => seen.push([ev.type, ev.text ?? '']),
  });
  check('思维链事件被单独上报', seen.some((x) => x[0] === 'reasoning'),
    JSON.stringify(seen.map((x) => x[0])));
  check('思维链内容正确', seen.some((x) => x[0] === 'reasoning' && x[1] === '让我想想…'),
    JSON.stringify(seen));
  check('正式回答也上报了', seen.some((x) => x[0] === 'text' && x[1] === '最终答案'),
    JSON.stringify(seen));
  check('思维链不进对话历史',
    !JSON.stringify(r.messages).includes('让我想想'), '');
}

console.log('\n[8] thinking 参数传递');
{
  let receivedBody = null;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      receivedBody = JSON.parse(b || '{}');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(8898, '127.0.0.1', r));

  for (const [thinking, expect] of [
    ['on', { type: 'enabled' }],
    ['off', { type: 'disabled' }],
  ]) {
    receivedBody = null;
    await runAgent({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      provider: {
        ...provider,
        baseUrl: 'http://127.0.0.1:8898/v1',
        thinking,
      },
      onEvent: () => {},
    });
    check(
      `thinking=${thinking} 传对了参数`,
      JSON.stringify(receivedBody?.thinking) === JSON.stringify(expect),
      JSON.stringify(receivedBody?.thinking)
    );
  }

  receivedBody = null;
  await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider: {
      ...provider,
      baseUrl: 'http://127.0.0.1:8898/v1',
      thinking: 'auto',
      reasoningEffort: 'low',
    },
    onEvent: () => {},
  });
  check('auto 模式改用 reasoning_effort', receivedBody?.reasoning_effort === 'low',
    JSON.stringify(receivedBody?.reasoning_effort));
  check('auto 模式不传 thinking', !receivedBody?.thinking,
    JSON.stringify(receivedBody?.thinking));

  srv.close();
}

console.log('\n[9] 工具名映射（DeepSeek 等不允许点号）');
{
  const { sanitizeToolName, buildToolNameMap, toProviderTools } = await import(PROVIDERS);
  const NAME_RE = /^[a-zA-Z0-9_-]+$/;

  const sampleTools = [
    { name: 'page.read', description: 'x', parameters: { type: 'object' } },
    { name: 'style.apply', description: 'x', parameters: { type: 'object' } },
    { name: 'diagnose.connection', description: 'x', parameters: { type: 'object' } },
  ];
  const map = buildToolNameMap(sampleTools);
  check('点号被替换为下划线', map.toRemote.get('page.read') === 'page_read',
    String(map.toRemote.get('page.read')));
  check('映射后的名字符合服务端规则',
    [...map.toRemote.values()].every((n) => NAME_RE.test(n)),
    [...map.toRemote.values()].join(','));
  check('可以还原回原始名', map.toLocal.get('page_read') === 'page.read',
    String(map.toLocal.get('page_read')));

  for (const kind of ['openai', 'anthropic', 'gemini']) {
    const arr = toProviderTools(kind, sampleTools, map.toRemote);
    const names =
      kind === 'openai'
        ? arr.map((x) => x.function.name)
        : kind === 'anthropic'
          ? arr.map((x) => x.name)
          : arr[0].functionDeclarations.map((x) => x.name);
    check(`${kind} 协议的工具名合法`, names.every((n) => NAME_RE.test(n)), names.join(','));
  }

  // 端到端：模型返回下划线名 → 还原成本地名 → 正确分发
  let sentTools = null;
  const srv2 = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      sentTools = JSON.parse(b || '{}').tools || [];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","type":"function",' +
          '"function":{"name":"page_read","arguments":"{}"}}]},"index":0}]}\n\n'
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv2.listen(8897, '127.0.0.1', r));

  RESPONSES.length = 0;
  RESPONSES.push({ toolCalls: [{ id: 'c9', name: 'page_read', args: {} }] });
  RESPONSES.push({ text: 'done' });
  const executed = [];
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'nbc:tool') {
      executed.push(msg.name);
      return { ok: true, data: { ok: true } };
    }
    return { ok: true };
  };
  await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider: { ...provider, baseUrl: 'http://127.0.0.1:8897/v1' },
    onEvent: () => {},
    enabledTools: sampleTools,
  });
  check('发给服务端的工具名是下划线形式',
    sentTools?.[0]?.function?.name === 'page_read',
    sentTools?.[0]?.function?.name || '(无)');
  check('模型返回的下划线名被还原成本地名',
    executed[0] === 'page.read',
    executed.join(','));

  srv2.close();
}

console.log('\n[10] 对象式 onEvent 的 reasoning 必须是字符串');
{
  // 回归测试：曾把整个事件对象传给 reasoning 处理器，
  // 结果面板把对象拼进文本，出现成百上千个 "[object Object]"。
  RESPONSES.length = 0;
  RESPONSES.push({ reasoning: '思考片段A', text: '正式回答' });
  const seen = [];
  await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    provider,
    onEvent: {
      text: (t) => seen.push(['text', t]),
      reasoning: (t) => seen.push(['reasoning', t]),
      done: (t) => seen.push(['done', t]),
    },
  });
  const reasoningArg = seen.find((x) => x[0] === 'reasoning')?.[1];
  const textArg = seen.find((x) => x[0] === 'text')?.[1];
  check('reasoning 收到的是字符串', typeof reasoningArg === 'string',
    typeof reasoningArg === 'string' ? reasoningArg : typeof reasoningArg);
  check('reasoning 不含 [object Object]',
    typeof reasoningArg === 'string' && !reasoningArg.includes('[object Object]'),
    String(reasoningArg).slice(0, 40));
  check('text 收到的也是字符串', typeof textArg === 'string',
    typeof textArg === 'string' ? textArg : typeof textArg);
}

console.log('\n[11] 工具结果必须以 role:tool 发给服务端');
{
  // 回归测试：内部协议把工具结果放在 user 消息里（Anthropic 风格），
  // 转换器若按 role 判断就会把它整个丢掉，服务端会报：
  //   An assistant message with 'tool_calls' must be followed by tool messages
  const bodies = [];
  const srv3 = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push(JSON.parse(b || '{}'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (bodies.length === 1) {
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function",' +
            '"function":{"name":"page_read","arguments":"{}"}}]},"index":0}]}\n\n'
        );
      } else {
        res.write('data: {"choices":[{"delta":{"content":"完成"},"index":0}]}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv3.listen(8896, '127.0.0.1', r));

  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'nbc:tool') return { ok: true, data: { ok: true } };
    return { ok: true };
  };

  await runAgent({
    messages: [{ role: 'user', content: [{ type: 'text', text: '读页面' }] }],
    provider: { ...provider, baseUrl: 'http://127.0.0.1:8896/v1' },
    onEvent: () => {},
    enabledTools: [{ name: 'page.read', description: 'x', parameters: { type: 'object' } }],
  });

  const second = bodies[1]?.messages || [];
  const asst = second.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  const toolMsg = second.find((m) => m.role === 'tool');
  check('第二次请求带 assistant(tool_calls)', Boolean(asst), JSON.stringify(second.map((m) => m.role)));
  check('第二次请求带 role:tool 消息', Boolean(toolMsg), JSON.stringify(second.map((m) => m.role)));
  check('tool_call_id 与 tool_calls 对应',
    toolMsg?.tool_call_id === asst?.tool_calls?.[0]?.id,
    `${toolMsg?.tool_call_id} vs ${asst?.tool_calls?.[0]?.id}`);
  check('工具名已转为下划线形式',
    asst?.tool_calls?.[0]?.function?.name === 'page_read',
    asst?.tool_calls?.[0]?.function?.name);

  srv3.close();
}

console.log('\n[12] 达到最大轮次时不崩溃');
{
  // 模型一直要求调工具 → 触发 MAX_ROUNDS 上限
  RESPONSES.length = 0;
  for (let i = 0; i < 20; i++) {
    RESPONSES.push({ toolCalls: [{ id: `loop${i}`, name: 'page_read', args: {} }] });
  }
  const seen = [];
  let threw = null;
  try {
    await runAgent({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      provider,
      onEvent: (ev) => seen.push(ev.type),
      enabledTools: [{ name: 'page.read', description: 'x', parameters: { type: 'object' } }],
    });
  } catch (e) {
    threw = e;
  }
  check('达到轮次上限时不抛异常', threw === null, threw?.message || '');
  check('发出 done 事件', seen.includes('done'), JSON.stringify(seen.slice(-3)));
  check('工具调用次数达到上限', seen.filter((x) => x === 'tool_start').length >= 10,
    `${seen.filter((x) => x === 'tool_start').length} 次`);
}

server.close();

console.log(`\n${'='.repeat(50)}`);
console.log(`结果：${pass} 项通过，${fail} 项失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail ? 1 : 0);
