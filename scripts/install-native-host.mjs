#!/usr/bin/env node
// 一次性安装 Native Messaging 宿主（让浏览器能按需拉起 companion）。
//
// 做三件事：
//   1. 生成 native-host.cmd（浏览器启动宿主的入口）
//   2. 生成 Native Messaging manifest JSON
//   3. 写入 Edge 与 Chrome 的注册表键（HKCU，不需要管理员权限）
//
// 用法：
//   node scripts/install-native-host.mjs [扩展ID ...]
//
// 扩展 ID 从 edge://extensions 或 chrome://extensions 页面复制。
// 不带参数时使用本机开发路径派生的默认 ID。

import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COM_DIR = join(ROOT, 'companion');
const IS_WIN = process.platform === 'win32';

if (!IS_WIN) {
  console.error('当前仅支持 Windows（Linux/macOS 的注册方式不同，欢迎贡献）');
  process.exit(1);
}

// ---- 1. 扩展 ID ------------------------------------------------------------
const ids = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
const DEV_ID = 'pdcgopianbckmmleogbioopmbaglobba'; // 本仓库路径派生的开发 ID
if (!ids.includes(DEV_ID)) ids.unshift(DEV_ID);

const origins = ids.map((id) => `chrome-extension://${id}/`);

// ---- 2. native-host.cmd（浏览器启动宿主的入口）------------------------------
const appDir = join(
  process.env.LOCALAPPDATA || join(process.env.USERPROFILE, 'AppData', 'Local'),
  'NetBrowserClaw'
);
mkdirSync(appDir, { recursive: true });

const cmdPath = join(appDir, 'native-host.cmd');
// NBC_PORT 可用环境变量覆盖；默认 8787（与扩展的候选端口一致）
writeFileSync(
  cmdPath,
  `@echo off\r\nset "NBC_PORT=%NBC_PORT%"\r\nif "%NBC_PORT%"=="" set "NBC_PORT=8787"\r\n` +
    `node "${join(COM_DIR, 'native-host.mjs')}" %*\r\n`,
  'utf8'
);

// ---- 3. manifest JSON -------------------------------------------------------
const manifestPath = join(appDir, 'netbrowserclaw.json');
const manifest = {
  name: 'netbrowserclaw',
  description: 'NetBrowserClaw：让浏览器按需启动本地 companion（媒体下载/yt-dlp/ffmpeg）',
  path: cmdPath,
  type: 'stdio',
  allowed_origins: origins,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

// ---- 4. 注册表（Edge + Chrome，HKCU 无需管理员）-----------------------------
const keys = [
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\netbrowserclaw',
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\netbrowserclaw',
];
let regOk = true;
for (const key of keys) {
  const r = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    regOk = false;
    console.error(`  ✗ 写入注册表失败：${key}`);
    if (r.stderr) console.error('    ' + String(r.stderr).trim().slice(0, 120));
  }
}

console.log('Native Messaging 宿主安装完成：');
console.log(`  宿主入口   ${cmdPath}`);
console.log(`  manifest   ${manifestPath}`);
console.log(`  允许的扩展 ${origins.join(', ')}`);
console.log(`  注册表     ${regOk ? 'Edge 与 Chrome 均已写入（HKCU）' : '部分失败，见上方'}`);
console.log('');
console.log('重启浏览器后生效。之后打开浏览器时 companion 会自动启动；');
console.log('也可以在扩展设置里点「启动 companion」手动拉起。');
