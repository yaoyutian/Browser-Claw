// 测试前的环境清理。
//
// ⚠ 重要原则：**绝不能杀用户自己的浏览器**。
// 之前这里用的是 `taskkill /F /IM msedge.exe`（按进程名杀），
// 结果把用户正在使用的 Edge 窗口也一起关掉了。
//
// 现在改为：只清理命令行里带 `nbc-` 临时 profile 标记的进程 ——
// 那是我们自己的测试实例。用户默认 profile 的浏览器永远不在其中。

import { cleanupStrayTestBrowsers, countUserBrowsers } from './_browser.mjs';

const killed = cleanupStrayTestBrowsers();
if (killed > 0) {
  process.stdout.write(`已清理 ${killed} 个遗留的测试浏览器实例\n`);
}

// 报告用户自己的浏览器还开着几个 —— 只是提示，我们不动它。
const userBrowsers = countUserBrowsers();
if (userBrowsers > 0) {
  process.stdout.write(
    `检测到 ${userBrowsers} 个你自己的浏览器进程，测试期间不会影响它们\n`
  );
}

await new Promise((r) => setTimeout(r, 800));
