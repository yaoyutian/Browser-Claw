// 极简 WebSocket 服务端（零依赖，只实现本项目需要的部分）。
//
// 为什么需要它：Chrome/Edge 的扩展 Service Worker **无法用 fetch 访问
// 127.0.0.1 上的 HTTP 服务**（请求在浏览器内部就被拒掉，
// 连 companion 都收不到），这是浏览器的本地网络访问策略。
// 但 WebSocket 连接不受 CORS / Private Network Access 限制，
// 是扩展与本地程序通信的可行路径。
//
// 实现范围：RFC 6455 的握手 + 文本帧的收发 + 分片重组 + ping/pong。
// 不支持二进制帧与压缩（扩展侧只用 JSON 文本）。

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** 计算 Sec-WebSocket-Accept。 */
function acceptKey(key) {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

/**
 * 从 HTTP upgrade 请求里解出一个 WebSocket 连接。
 * @returns {{socket: import('node:net').Socket}|null}
 */
export function upgradeToWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    return null;
  }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n',
  ].join('\r\n');
  socket.write(headers);
  if (head && head.length) socket.unshift(head);

  const conn = new WebSocketConnection(socket);
  socket.on('data', (chunk) => conn.feed(chunk));
  socket.on('close', () => conn.emit('close'));
  socket.on('error', (e) => {
    if (process.env.NBC_DEBUG) {
      process.stderr.write(`[ws] socket error: ${e?.message || e}
`);
    }
    conn.emit('error');
  });
  socket.on('end', () => conn.emit('close'));
  return conn;
}

/** 一个 WebSocket 连接（服务端视角）。 */
export class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    this.handlers = { message: [], close: [], error: [] };
    this.open = true;
  }

  on(event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) {
      try {
        fn(...args);
      } catch { /* 忽略处理器异常 */ }
    }
  }

  /** 收到原始数据：解析成完整消息。 */
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }

  /** 从缓冲区里读出一个帧；数据不足则返回 null。 */
  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, 'message too large');
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    switch (opcode) {
      case OPCODE.PING:
        this.sendFrame(OPCODE.PONG, payload);
        return;
      case OPCODE.PONG:
        return;
      case OPCODE.CLOSE:
        this.closed = true;
        this.emit('close');
        try {
          this.socket.end();
        } catch { /* ignore */ }
        return;
      case OPCODE.CONTINUATION:
        this.fragments.push(payload);
        break;
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
        break;
      default:
        return;
    }

    if (!fin) return;

    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    const isText = this.fragmentOpcode === OPCODE.TEXT;
    this.fragmentOpcode = null;
    if (isText) this.emit('message', full.toString('utf8'));
  }

  /** 发送一条文本消息。 */
  send(text) {
    if (this.closed || !this.open) return false;
    const data = Buffer.from(String(text), 'utf8');
    this.sendFrame(OPCODE.TEXT, data);
    return true;
  }

  sendFrame(opcode, payload) {
    if (!this.socket.writable) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch { /* 忽略写入失败 */ }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.sendFrame(OPCODE.CLOSE, body);
    try {
      this.socket.end();
    } catch { /* ignore */ }
    this.emit('close');
  }
}
