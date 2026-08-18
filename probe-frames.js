// 最小 WebSocket 客户端探针：握手后读取 N 个文本帧，打印帧类型
// 用法: node probe-frames.js <cookie> [帧数]
'use strict';
const net = require('net');
const crypto = require('crypto');

const cookie = process.argv[2];
const maxFrames = Number(process.argv[3] || 5);
const path = '/api/events.mux';
const host = '127.0.0.1';
const port = 3081;

const key = crypto.randomBytes(16).toString('base64');
const req = [
  `GET ${path} HTTP/1.1`,
  `Host: ${host}:${port}`,
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Key: ${key}`,
  'Sec-WebSocket-Version: 13',
  `Cookie: dsh_gw_session=${cookie}`,
  '',
  '',
].join('\r\n');

const sock = net.connect(port, host, () => sock.write(req));
let buf = Buffer.alloc(0);
let handshaken = false;
let frames = 0;

sock.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  if (!handshaken) {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    const head = buf.slice(0, i).toString();
    if (!head.startsWith('HTTP/1.1 101')) {
      console.log('握手失败:\n' + head);
      sock.destroy();
      return;
    }
    console.log('握手成功 (101)');
    handshaken = true;
    buf = buf.slice(i + 4);
  }
  // 解析 WS 帧（服务端帧无掩码）
  while (buf.length >= 2 && frames < maxFrames) {
    const b0 = buf[0], b1 = buf[1];
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) break;
    const payload = buf.slice(off, off + len);
    buf = buf.slice(off + len);
    const opcode = b0 & 0x0f;
    if (opcode === 1) { // 文本帧
      frames++;
      try {
        const env = JSON.parse(payload.toString('utf8'));
        const f = env.payload || {};
        console.log(`帧 #${frames}: envelope=${env.type} rpcId=${String(env.rpcId).slice(0,8)} frame.type=${f.type}${f.sessionId ? ' sessionId=' + String(f.sessionId).slice(0, 13) : ''}`);
        if (f.type === 'session/event') console.log(`  event.type=${f.event.type} seq=${f.event.seq}`);
        if (f.type === 'approval/requested') console.log(`  tool=${f.toolName} approvalId=${String(f.approvalId).slice(0, 20)}`);
      } catch (_) {
        console.log(`帧 #${frames}: 非 JSON (${len} 字节)`);
      }
    } else if (opcode === 8) {
      console.log('服务端关闭帧');
      sock.destroy();
      return;
    }
  }
  if (frames >= maxFrames) { console.log('已收到目标帧数，断开'); sock.destroy(); }
});
sock.on('error', (e) => console.log('连接错误: ' + e.message));
setTimeout(() => { console.log('超时'); sock.destroy(); }, 15000);
