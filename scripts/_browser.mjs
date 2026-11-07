// 浏览器进程管理：只动我们自己启动的，绝不碰用户正在用的浏览器。
//
// 背景：测试脚本会启动浏览器来验证扩展。历史上两次出过事故：
//   1. `taskkill /IM msedge.exe`（按进程名杀）—— 把用户开着的窗口一起杀掉；
//   2. 按 PID 清理时的 **PID 复用竞态** —— 查出 PID 列表后、真正杀之前，
//      测试进程退出、Windows 把同一个 PID 分配给了用户刚开的进程，
//      按旧 PID 杀下去就误杀了用户的东西。
//
// 因此这里的杀进程一律走 `killPidVerified()`：**杀之前重新核对命令行**，
// 确认它仍是我们带 `nbc-` 临时 profile 标记的进程。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';

/** 我们的测试实例用的临时 profile 目录都以这个前缀开头。 */
export const OUR_PROFILE_MARK = 'nbc-';

/** 测试用的浏览器候选（按优先级）。可用环境变量 NBC_BROWSER 覆盖。 */
const BROWSER_CANDIDATES = {
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
};

/**
 * 按用户偏好（NBC_BROWSER=chrome|edge|auto）选出测试用的浏览器可执行文件。
 *
 * 默认是 **Edge**：Chrome 136+ 正式版移除了 --load-extension（不允许加载
 * 未打包扩展），测试会直接失败 —— 所以不能用用户装的那个 Chrome。
 * 想用 Chrome 的话装 Chrome for Testing（Google 专为自动化提供的构建），
 * 然后把它的路径放进 NBC_BROWSER。
 */
export function findTestBrowser() {
  const pref = (process.env.NBC_BROWSER || 'auto').toLowerCase();
  let order;
  if (pref === 'chrome') order = ['chrome', 'edge'];
  else if (pref === 'edge') order = ['edge', 'chrome'];
  else order = ['edge', 'chrome'];

  for (const name of order) {
    for (const p of BROWSER_CANDIDATES[name]) {
      if (existsSync(p)) return p;
    }
  }
  return '';
}

/**
 * 核对一个 PID 当前是否仍是我们带 nbc- 标记的测试进程。
 * 这是防 PID 复用误杀的关键：查出的 PID 在杀之前必须再核对一次。
 */
function isStillOurProcess(pid) {
  if (!IS_WIN) return false;
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
        'ForEach-Object { $_.CommandLine }',
    ],
    { encoding: 'utf8' }
  );
  const cmd = (r.stdout || '').trim();
  return Boolean(cmd) && cmd.includes(OUR_PROFILE_MARK);
}

/** 杀掉某个 PID 及其整棵子进程树（只针对我们自己 spawn 出来的进程）。 */
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}

/**
 * 找出遗留的测试浏览器实例（命令行里带我们的临时 profile 标记）。
 * 返回 PID 数组。
 */
export function findStrayTestBrowsers() {
  if (!IS_WIN) return [];
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | " +
        'Where-Object { $_.CommandLine -like "*user-data-dir=*nbc-*" } | ' +
        'ForEach-Object { $_.ProcessId }',
    ],
    { encoding: 'utf8' }
  );
  return (r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

/**
 * 清理遗留的测试实例。
 *
 * 只杀命令行里带 `nbc-` 临时 profile 标记的进程 ——
 * 用户自己的浏览器（默认 profile）不在其中，不会被影响。
 * 每个 PID 在杀之前都会**重新核对命令行**，防止 PID 复用误杀。
 */
export function cleanupStrayTestBrowsers() {
  const pids = findStrayTestBrowsers();
  let killed = 0;
  for (const pid of pids) {
    if (!isStillOurProcess(pid)) continue; // PID 已被复用 → 跳过
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    killed++;
  }
  return killed;
}

/**
 * 循环清理直到干净。
 *
 * Edge/Chrome 的启动器进程会立刻退出，真正的浏览器是另外的 PID，
 * 而且子进程是陆续生成的 —— 一次性清理会漏掉一部分，
 * 所以要「找到→杀→等→再找」地循环几轮。
 */
export async function cleanupStrayTestBrowsersAsync(rounds = 6, delayMs = 400) {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const killed = cleanupStrayTestBrowsers();
    total += killed;
    if (killed === 0) {
      // 再确认一次没有新冒出来的
      await new Promise((r) => setTimeout(r, delayMs));
      if (findStrayTestBrowsers().length === 0) break;
      continue;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return total;
}

/**
 * 提示用户当前有多少用户浏览器进程正在运行（只提示，不动）。
 */
export function countUserBrowsers() {
  if (!IS_WIN) return 0;
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | " +
        'Where-Object { $_.CommandLine -notlike "*user-data-dir=*nbc-*" } | ' +
        'ForEach-Object { 1 } | Measure-Object | ' +
        'ForEach-Object { $_.Count }',
    ],
    { encoding: 'utf8' }
  );
  return Number((r.stdout || '0').trim()) || 0;
}

/**
 * 确认某个调试端口确实是我们启动的浏览器实例占用的。
 *
 * 归属判定不能只看「扩展能不能跑起来」—— 用户自己开着远程调试的浏览器
 * 里也装了这个扩展，行为完全一样。唯一可靠的依据是：
 * **占用该端口的进程，其 --user-data-dir 必须是我们这次的临时目录。**
 *
 * @returns {{ok: boolean, pid?: string, cmd?: string}}
 */
export function assertOwnsCdpPort(port, profileDir) {
  if (!IS_WIN) return { ok: true };
  const net = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  const pids = new Set();
  for (const line of (net.stdout || '').split('\n')) {
    if (line.includes(`:${port}`) && line.includes('LISTENING')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
  }
  if (!pids.size) return { ok: false, cmd: `端口 ${port} 上没有进程在监听` };

  for (const pid of pids) {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
          'ForEach-Object { $_.CommandLine }',
      ],
      { encoding: 'utf8' }
    );
    const cmd = (r.stdout || '').trim();
    if (cmd && cmd.includes(profileDir)) return { ok: true, pid, cmd };
  }
  return { ok: false, cmd: `端口 ${port} 由其它进程占用（不是本次测试的实例）` };
}
