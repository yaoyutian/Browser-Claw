// Agent 循环：把「用户消息」变成「模型 → 工具 → 模型 → … → 最终回答」。
//
// 放在侧边栏页面里跑（而不是 service worker），原因是 MV3 的 service worker
// 随时可能被回收，长时间流式对话放在侧边栏页面更稳定。

import { streamChat, Text, ToolUse, ToolResult, resolveProvider } from './providers.js';
import { TOOLS, TOOL_MAP } from './tools.js';
import { truncate, redact } from './util.js';

const MAX_ROUNDS = 12;

/** 调用后台执行工具。 */
/**
 * 调用一个浏览器工具。
 *
 * 会自动把当前的 provider 配置带上 —— 有些工具（如 diagnose.connection）
 * 需要知道用户正在用哪个服务商、哪个 Base URL。
 */
export async function runTool(name, args = {}, provider = null) {
  const payload = provider ? { ...args, provider } : args;
  const res = await chrome.runtime.sendMessage({ type: 'nbc:tool', name, args: payload });
  if (!res) throw new Error('后台无响应（service worker 可能正在重启，请重试）');
  if (!res.ok) {
    const err = new Error(res.error || '工具执行失败');
    err.detail = res.detail;
    throw err;
  }
  return res.data;
}

/**
 * 事件分发适配层。
 *
 * onEvent 支持两种形式：
 *   · 函数   —— onEvent({ type: 'text', text })
 *   · 对象   —— { text: (t) => {...}, tool_start: (ev) => {...} }
 *
 * 历史上两边约定不一致（agent.js 当函数调、panel.js 传对象），
 * 出现过 "onEvent is not a function"。这里统一兼容，避免再犯。
 */
function makeEmitter(onEvent) {
  if (!onEvent) return () => {};
  if (typeof onEvent === 'function') {
    return (ev) => {
      try {
        onEvent(ev);
      } catch (e) {
        console.warn('[nbc agent] onEvent 处理出错', e);
      }
    };
  }
  if (typeof onEvent === 'object') {
    return (ev) => {
      const handler = onEvent[ev?.type];
      if (typeof handler !== 'function') return;
      try {
        // 文本类事件（text / reasoning）传字符串，其余传整个事件对象。
        // 注意 reasoning 也必须传字符串 —— 传对象会被拼成 "[object Object]"。
        const isTextLike = ev?.type === 'text' || ev?.type === 'reasoning';
        handler(isTextLike ? ev.text ?? '' : ev);
      } catch (e) {
        console.warn('[nbc agent] onEvent 处理出错', e);
      }
    };
  }
  console.warn('[nbc agent] onEvent 类型不正确，已忽略', typeof onEvent);
  return () => {};
}

/**
 * 执行一轮 agent 循环。
 *
 * @param {object} opts
 * @param {Array} opts.messages  历史消息（内部统一格式）
 * @param {object} opts.provider  服务商配置
 * @param {(ev)=>void|object} opts.onEvent 事件回调：text / tool_start / tool_end / error / done。
 *        可以是函数，也可以是 `{ text: fn, tool_start: fn, ... }` 形式的对象。
 * @param {AbortSignal} opts.signal
 * @param {(name, input)=>Promise<boolean>} opts.beforeTool 工具执行前的确认钩子；
 *        返回 false 则跳过该工具，把「已跳过」作为结果回传给模型
 * @returns {{messages: Array, toolCalls: number}}
 */
export async function runAgent({ messages, provider, onEvent, signal, enabledTools, beforeTool }) {
  const emit = makeEmitter(onEvent);
  const tools = (enabledTools || TOOLS).filter((t) => providerSupportsTools(provider));
  const history = [...messages];
  let toolCalls = 0;
  // 声明在循环外：达到最大轮次时循环外也要用到 assistantText。
  let assistantText = '';
  let reasoningText = '';
  // 服务端的结束原因：'stop' 正常、'length' 表示输出被 max_tokens 截断
  let finishReason = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 注意：这两个变量声明在循环外（见上方）——
    // 达到最大轮次时循环外也要用到 assistantText。
    assistantText = '';
    reasoningText = '';
    // 服务端的结束原因：'stop' 正常、'length' 表示输出被 max_tokens 截断
    finishReason = null;
    const pendingCalls = [];

    try {
      for await (const ev of streamChat(provider, { messages: history, tools, signal })) {
        if (ev.type === 'text') {
          assistantText += ev.text;
          emit({ type: 'text', text: ev.text });
        } else if (ev.type === 'reasoning') {
          // 思考模式下的思维链 —— 只展示，不进对话历史
          reasoningText += ev.text;
          emit({ type: 'reasoning', text: ev.text });
        } else if (ev.type === 'tool_call') {
          pendingCalls.push(ev);
        } else if (ev.type === 'finish') {
          finishReason = ev.reason;
        }
      }
    } catch (err) {
      emit({ type: 'error', error: err?.message || String(err), detail: err?.detail });
      throw err;
    }

    if (!pendingCalls.length) {
      // 模型可能只输出了思维链、正文为空（例如思考模式 + max_tokens 耗尽）。
      // 这种**空的 assistant 消息**发回服务端会被拒：
      //   Invalid assistant message: content or tool_calls must be set
      // 所以正文为空时干脆不入历史。
      if (assistantText.trim()) {
        history.push({ role: 'assistant', content: [Text(assistantText)] });
      }
      // 给出可操作的提示，而不是让用户面对一句没有内容的话。
      if (!assistantText.trim()) {
        emit({
          type: 'text',
          text:
            finishReason === 'length'
              ? '\n_（模型输出被 max_tokens 截断，未产生正文。可在设置里调大「最大输出 tokens」，' +
                '或在思考模式里选择「关闭」以节省 token。）_'
              : '\n_（模型没有返回内容。可尝试换个模型，或检查 API Key 权限。）_',
        });
      } else if (finishReason === 'length') {
        emit({
          type: 'text',
          text:
            '\n_（输出被 max_tokens 截断，内容可能不完整。可在设置里调大「最大输出 tokens」。）_',
        });
      }
      emit({
        type: 'done',
        text: assistantText,
        rounds: round + 1,
        truncated: finishReason === 'length',
        empty: !assistantText.trim(),
      });
      return { messages: history, toolCalls };
    }

    // 记录助手消息（含工具调用请求）。
    const blocks = [];
    if (assistantText) blocks.push(Text(assistantText));
    for (const c of pendingCalls) blocks.push(ToolUse(c.id, c.name, c.input));
    history.push({ role: 'assistant', content: blocks });

    // 逐个执行工具调用。
    const results = [];
    for (const call of pendingCalls) {
      toolCalls += 1;

      // 用户可能要求先确认再执行。
      if (beforeTool) {
        let approved = true;
        try {
          approved = await beforeTool(call.name, call.input);
        } catch {
          approved = false;
        }
        if (!approved) {
          const skipped = { skipped: true, reason: '用户拒绝了本次工具执行' };
          emit({
            type: 'tool_end',
            id: call.id,
            name: call.name,
            output: skipped,
            isError: false,
          });
          results.push(ToolResult(call.id, JSON.stringify(skipped), false));
          continue;
        }
      }

      emit({ type: 'tool_start', id: call.id, name: call.name, input: call.input });

      let output;
      let isError = false;
      try {
        if (!TOOL_MAP[call.name]) throw new Error(`未知工具 ${call.name}`);
        output = await runTool(call.name, call.input || {}, provider);
      } catch (err) {
        isError = true;
        output = {
          error: err?.message || String(err),
          detail: err?.detail ? truncate(String(err.detail), 1000) : undefined,
        };
      }
      emit({ type: 'tool_end', id: call.id, name: call.name, output, isError });
      results.push(
        ToolResult(call.id, typeof output === 'string' ? output : JSON.stringify(output), isError)
      );
    }

    // 工具结果以 user 角色回传（Anthropic 风格），各家协议层会再转换。
    history.push({ role: 'user', content: results });
  }

  emit({ type: 'done', text: assistantText, rounds: MAX_ROUNDS, truncated: true });
  return { messages: history, toolCalls };
}

function providerSupportsTools(provider) {
  const p = resolveProvider(provider);
  return p.supportsTools !== false;
}

/** 构造首次请求的系统提示词。 */
export function systemPrompt({ siteName, pageTitle }) {
  const context = siteName ? `当前页面：${siteName}${pageTitle ? ` — ${pageTitle}` : ''}` : '';
  return [
    '你是一个运行在浏览器侧边栏里的 AI 助手，可以直接操作用户当前的浏览器。',
    '',
    '你可以：',
    '- 读取网页正文、表格、图片、链接（page.read / page.tables / page.images / page.links）',
    '- 修改网站样式：深色模式、阅读模式、隐藏广告、注入自定义 CSS（style.*）',
    '- 批量下载页面中的音视频与文档（media.list / media.download / page.links）',
    '- 把网页内容导出为 Markdown / Word / HTML / txt 文档（doc.export）',
    '- 点击、填写表单、滚动页面（page.click / page.fill / page.scroll）',
    '- 管理标签页与导航（tab.* / nav.back）',
    '',
    '工作准则：',
    '1. 需要页面信息时先调用工具读取，不要凭空猜测页面内容。',
    '2. 执行破坏性或不可逆操作（提交表单、删除、批量下载大量文件）前，' +
      '先用 page.highlight 标出目标并向用户说明你的意图。',
    '3. 批量下载前先用 page.links / media.list 列出候选项，把数量和文件名告诉用户。',
    '4. 工具报错时，读懂错误信息后调整参数重试一次；仍失败就如实说明，不要编造结果。',
    '5. 用中文回答，除非用户用其他语言提问。回答要具体、可执行，避免空话。',
    context ? `\n${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 供调试：打印脱敏后的请求体。 */
export function debugRequest(provider, messages, tools) {
  return JSON.stringify(
    {
      provider: resolveProvider(provider),
      messages,
      tools: tools?.length || 0,
    },
    null,
    2
  ).replace(/("apiKey":")[^"]+/g, '$1***');
}
