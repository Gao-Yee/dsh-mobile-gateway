// 用法: node probe-ws.js <cookie值|none> [路径] [端口]
'use strict';
const net = require('net');

const cookieArg = process.argv[2];
const cookie = cookieArg === 'none' ? '' : cookieArg;
const reqPath = process.argv[3] || '/';
const host = '127.0.0.1';
const port = Number(process.argv[4] || 3081);

const req = [
  `GET ${reqPath} HTTP/1.1`,
  `Host: ${host}:${port}`,
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
  cookie ? `Cookie: dsh_gw_session=${cookie}` : '',
].filter(Boolean).join('\r\n') + '\r\n\r\n';

const sock = net.connect(port, host, () => {
  sock.write(req);
});
let data = '';
let printed = false;
sock.on('data', (c) => {
  data += c.toString('utf8');
  // 收到完整响应头就停（只打印一次）
  if (!printed && data.includes('\r\n\r\n')) {
    printed = true;
    console.log('--- 响应头 ---');
    console.log(data.split('\r\n\r\n')[0]);
    sock.end();
  }
});
sock.on('error', (e) => console.log('连接错误: ' + e.message));
sock.on('close', () => {
  if (!printed) console.log('--- 未收到完整响应，已收到: ' + data.length + ' 字节 ---');
});
setTimeout(() => { sock.destroy(); }, 4000);
