# 开发约定

> 给 AI 助手与协作者的硬性约束。**违反下面任何一条都会影响用户正常使用浏览器。**

## ⛔ 绝不碰用户的浏览器

用户在开发过程中会**一直开着 Edge/Chrome**（里面装着这个扩展在真实站点上测试）。
自动化脚本绝不能动它。

### 禁止的写法

```bash
taskkill /F /IM msedge.exe     # ❌ 按进程名杀 —— 会连用户的一起杀
taskkill /F /IM chrome.exe     # ❌ 同上
```

### 正确的写法

用 `scripts/_browser.mjs` 提供的工具：

```js
import { killTree, cleanupStrayTestBrowsers, assertOwnsCdpPort } from './_browser.mjs';

// 1) 杀自己启动的进程（按 PID，含整棵子进程树）
killTree(child.pid);

// 2) 清理遗留的测试实例
//    只认命令行里带 nbc- 临时 profile 标记的进程；
//    用户默认 profile 的浏览器永远不匹配
await cleanupStrayTestBrowsersAsync();

// 3) 确认调试端口是我们的实例（见下节）
const owner = assertOwnsCdpPort(CDP_PORT, profile);
if (!owner.ok) { /* 中止测试 */ }
```

## 🔒 测试必须与用户实例隔离

### 1. 端口归属检查（跑测试前）

调试端口上可能蹲着**用户自己开着远程调试的浏览器**（里面也装了这个扩展）。
那样扩展会跑在用户的真实标签页上，工具就会去操作用户的页面。

```js
const owner = assertOwnsCdpPort(CDP_PORT, profile);
if (!owner.ok) {
  console.error('端口不是本次测试的实例，测试中止');
  process.exit(1);
}
```

### 2. MCP 测试必须用专属端口

扩展的 bridge 会轮询 companion。**默认候选端口（8787/8788/8789/8790/8888）
用户浏览器也会去连** —— 于是 MCP 命令会被用户的浏览器抢走，在真实页面上执行。

所以 MCP 测试必须：

- 用**不在默认候选列表里**的端口（当前用 `8791`）
- 跑之前把扩展的 companion 地址写死到该端口：

```js
await sw.evaluate(
  `chrome.storage.local.set({'nbc:settings': {companionUrl: 'http://127.0.0.1:${NBC_PORT}'}}).then(()=>true)`
);
```

## 🧪 验证方式

```bash
node scripts/check-project.mjs        # 结构自检
node scripts/test-agent.mjs           # agent 循环单元测试（不碰浏览器）
node scripts/verify-e2e.mjs           # 端到端（真实启动 Edge，临时 profile）
node scripts/verify-mcp.mjs           # MCP 联动（专属端口）
```

### 每个脚本都会做什么

| 脚本 | 启动浏览器 | profile | 端口 |
|---|---|---|---|
| `verify-e2e.mjs` | 是 | 临时 `nbc-verify-*` | 9444 |
| `verify-mcp.mjs` | 是 | 临时 `nbc-mcp-*` | 9445（CDP）/ 8791（companion） |
| `shot-*.mjs` | 是 | 临时 `nbc-*` | 9446+ |

跑完会自动清理自己启动的进程，**不会碰你的窗口**。

## ⚠️ 改代码时的注意事项

### 用 Edit 工具或按行号编辑，不要用字符串全局替换

之前多次用 Python 做字符串替换，把 `handlers.js` / `providers.js` 反复弄坏：
反斜杠被吃掉、模板字符串被拆行、函数残留半截。
**症状是 `node --check` 报错**，但如果不检查就会带着损坏的代码提交。

每次改完至少跑一次：

```bash
for f in extension/src/**/*.js companion/*.mjs scripts/*.mjs; do node --check "$f" || echo "FAIL $f"; done
```

### 注意作用域

`agent.js` 里变量声明在循环内却在循环外引用，会导致**达到最大轮次时整个循环崩溃**。
改那个文件时注意 `assistantText` / `reasoningText` 的声明位置。

## 📋 提交前

```bash
node scripts/check-project.mjs && \
node scripts/test-agent.mjs && \
node scripts/verify-e2e.mjs && \
node scripts/verify-mcp.mjs
```

全部通过再提交。当前基线：**186 项**（44 + 118 + 24）。
