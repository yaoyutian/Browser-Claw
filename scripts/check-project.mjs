#!/usr/bin/env node
// 项目结构自检：manifest 引用完整性 + 工具 schema 与 handler 一致性。
// 用法：node scripts/check-project.mjs
//
// 这个检查存在的意义：新增工具时如果只写了 schema 忘了写 handler，
// 扩展不会报错，只会在模型调用时静默失败 —— 很难排查。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let failed = 0;
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failed++;
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

// --- 1. manifest 引用完整性 ---------------------------------------------
console.log('\n[1] manifest 引用检查');
const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
else pass('Manifest V3');

for (const key of ['name', 'version', 'permissions', 'background', 'action', 'side_panel']) {
  if (!(key in manifest)) fail(`manifest 缺少字段: ${key}`);
}

const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
].filter(Boolean);

for (const p of referenced) {
  if (!existsSync(join(ROOT, 'extension', p))) fail(`manifest 引用的文件不存在: extension/${p}`);
}
if (!failed) pass(`${referenced.length} 个文件引用全部存在`);

// --- 2. 工具 schema 与 handler 一致 --------------------------------------
console.log('\n[2] 工具与 handler 一致性');
const toolsSrc = readFileSync(join(ROOT, 'extension', 'src', 'shared', 'tools.js'), 'utf8');
const handlersSrc = readFileSync(join(ROOT, 'extension', 'src', 'background', 'handlers.js'), 'utf8');

const toolNames = [...toolsSrc.matchAll(/name:\s*'([a-z]+\.[a-zA-Z]+)'/g)].map((m) => m[1]);
const toolSet = new Set(toolNames);

if (toolSet.size !== toolNames.length) fail('tools.js 中存在重复的工具名');

for (const n of toolNames) {
  if (!handlersSrc.includes(`'${n}'`)) fail(`工具 ${n} 没有对应的 handler`);
}

// 反向检查：handler 里的工具名都在 schema 里（避免写了实现却没暴露给模型）
const handlerNames = [...handlersSrc.matchAll(/async\s+'([a-z]+\.[a-zA-Z]+)'/g)].map((m) => m[1]);
for (const n of handlerNames) {
  if (!toolSet.has(n)) fail(`handler ${n} 未在 tools.js 中声明，模型无法调用`);
}

if (!failed) pass(`${toolNames.length} 个工具与 handler 双向一致`);

// --- 3. 工具描述质量 ------------------------------------------------------
console.log('\n[3] 工具描述质量');
const blocks = toolsSrc.split(/\n  \{\n/).slice(1);
let shortDesc = 0;
for (const b of blocks) {
  const name = b.match(/name:\s*'([^']+)'/)?.[1];
  const desc = b.match(/description:\s*([\s\S]*?),\n\s*parameters:/)?.[1] || '';
  const len = desc.replace(/\s+/g, '').length;
  if (len < 40) {
    console.warn(`  ! ${name} 的描述过短（${len} 字），模型可能不知道何时使用`);
    shortDesc++;
  }
}
if (!shortDesc) pass('所有工具描述都足够详细');

console.log('');
if (failed) {
  console.error(`检查未通过：${failed} 项问题`);
  process.exit(1);
}
console.log('项目结构自检全部通过');
