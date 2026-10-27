// 诊断：扩展的 bridge 为什么连不上 companion。
// 用法：node scripts/diag-bridge.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9445);

const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

function connect(url) {
  const ws = new WebSocket(url);
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
      logs.push('[c] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[E] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
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

const list = await httpJson('/json/list');
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('/src/background/service-worker.js'));
if (!sw) {
  console.log('未找到扩展 Service Worker');
  process.exit(1);
}
const c = connect(sw.webSocketDebuggerUrl);
await c.ready;
await c.send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2000));

console.log('SW 控制台输出:', c.logs.join('\n') || '(无)');

const probe = await c.evaluate(`(async () => {
  const out = [];
  for (const p of [8787, 8788, 8789, 8790]) {
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/health', { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      out.push(p + ' => ' + d.name + ' ext=' + d.extensionConnected);
    } catch (e) {
      out.push(p + ' => ERR ' + e.message);
    }
  }
  return out.join('\\n');
})()`);
console.log('\ncompanion 端口探测:\n' + probe);

const files = await c.evaluate(`(async () => {
  const names = ['src/background/bridge.js','src/background/handlers.js','src/background/service-worker.js'];
  const out = [];
  for (const n of names) {
    try {
      const r = await fetch(chrome.runtime.getURL(n));
      const t = await r.text();
      out.push(n + ' => HTTP ' + r.status + ', ' + t.length + ' bytes');
    } catch (e) { out.push(n + ' => ERR ' + e.message); }
  }
  return out.join('\\n');
})()`);
console.log('\n扩展文件可读性:\n' + files);

process.exit(0);
