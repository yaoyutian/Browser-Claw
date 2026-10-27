// Agent 循环：把「用户消息」变成「模型 → 工具 → 模型 → … → 最终回答」。
//
// 放在侧边栏页面里跑（而不是 service worker），原因是 MV3 的 service worker
// 随时可能被回收，长时间流式对话放在侧边栏页面更稳定。

import { streamChat, Text, ToolUse, ToolResult, resolveProvider } from './providers.js';
import { TOOLS, TOOL_MAP } from './tools.js';
import { truncate, redact } from './util.js';

const MAX_ROUNDS = 12;

/** 调用后台执行工具。 */
export async function runTool(name, args) {
  const res = await chrome.runtime.sendMessage({ type: 'nbc:tool', name, args });
  if (!res) throw new Error('后台无响应（service worker 可能正在重启，请重试）');
  if (!res.ok) {
    const err = new Error(res.error || '工具执行失败');
    err.detail = res.detail;
    throw err;
  }
  return res.data;
}

/**
 * 执行一轮 agent 循环。
 *
 * @param {object} opts
 * @param {Array} opts.messages  历史消息（内部统一格式）
 * @param {object} opts.provider  服务商配置
 * @param {(ev)=>void} opts.onEvent 事件回调：text / tool_start / tool_end / error / done
 * @param {AbortSignal} opts.signal
 * @param {(name, input)=>Promise<boolean>} opts.beforeTool 工具执行前的确认钩子；
 *        返回 false 则跳过该工具，把「已跳过」作为结果回传给模型
 * @returns {{messages: Array, toolCalls: number}}
 */
export async function runAgent({ messages, provider, onEvent, signal, enabledTools, beforeTool }) {
  const tools = (enabledTools || TOOLS).filter((t) => providerSupportsTools(provider));
  const history = [...messages];
  let toolCalls = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let assistantText = '';
    const pendingCalls = [];

    try {
      for await (const ev of streamChat(provider, { messages: history, tools, signal })) {
        if (ev.type === 'text') {
          assistantText += ev.text;
          onEvent?.({ type: 'text', text: ev.text });
        } else if (ev.type === 'tool_call') {
          pendingCalls.push(ev);
        }
      }
    } catch (err) {
      onEvent?.({ type: 'error', error: err?.message || String(err), detail: err?.detail });
      throw err;
    }

    if (!pendingCalls.length) {
      history.push({ role: 'assistant', content: [Text(assistantText)] });
      onEvent?.({ type: 'done', text: assistantText, rounds: round + 1 });
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
          onEvent?.({
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

      onEvent?.({ type: 'tool_start', id: call.id, name: call.name, input: call.input });

      let output;
      let isError = false;
      try {
        if (!TOOL_MAP[call.name]) throw new Error(`未知工具 ${call.name}`);
        output = await runTool(call.name, call.input || {});
      } catch (err) {
        isError = true;
        output = {
          error: err?.message || String(err),
          detail: err?.detail ? truncate(String(err.detail), 1000) : undefined,
        };
      }
      onEvent?.({ type: 'tool_end', id: call.id, name: call.name, output, isError });
      results.push(
        ToolResult(call.id, typeof output === 'string' ? output : JSON.stringify(output), isError)
      );
    }

    // 工具结果以 user 角色回传（Anthropic 风格），各家协议层会再转换。
    history.push({ role: 'user', content: results });
  }

  onEvent?.({ type: 'done', text: assistantText, rounds: MAX_ROUNDS, truncated: true });
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
