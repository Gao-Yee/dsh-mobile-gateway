#!/usr/bin/env node
'use strict';
/**
 * dsh-mobile-gateway
 * 一个零依赖的反向代理网关，让手机（同一 Wi-Fi 或 Tailscale 虚拟网内）
 * 通过密码登录后访问本机 DeepSeek Harness Web GUI（127.0.0.1:3080）。
 *
 * 特性：
 *  - 仅监听 0.0.0.0:3081，DSH 本身仍只监听 127.0.0.1:3080，不对外暴露
 *  - 密码登录（仅存 SHA-256 哈希），登录失败限速
 *  - HMAC 签名的 HttpOnly 会话 Cookie（默认 30 天）
 *  - 完整透传 HTTP（含 SSE 长连接）与 WebSocket Upgrade
 *  - 全零 npm 依赖，仅使用 Node.js 内置模块
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'gateway.log');
const SESSION_COOKIE = 'dsh_gw_session';

// ---------- 日志 ----------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

// ---------- 配置 ----------
function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function loadOrCreateConfig() {
  const defaults = {
    port: 3081,
    targetHost: '127.0.0.1',
    targetPort: 3080,
    sessionDays: 30,
    maxLoginFails: 5,
    loginFailWindowMs: 10 * 60 * 1000,
  };
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error('config.json 解析失败：' + e.message);
      process.exit(1);
    }
  }
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (config[k] === undefined) { config[k] = v; changed = true; }
  }
  if (!config.sessionSecret || typeof config.sessionSecret !== 'string' || config.sessionSecret.length < 32) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
    changed = true;
  }
  if (!config.passwordHash || typeof config.passwordHash !== 'string' || config.passwordHash.length !== 64) {
    const password = crypto.randomBytes(12).toString('base64url');
    config.passwordHash = sha256hex(password);
    changed = true;
    log('==========================================================');
    log('首次运行：已生成随机访问密码（仅显示这一次，请立即保存）：');
    log(`  访问密码: ${password}`);
    log('以后可用以下命令修改密码：');
    log('  node gateway.js --set-password <新密码>');
    log('==========================================================');
  }
  if (changed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  }
  return config;
}

function setPassword(newPassword) {
  if (!newPassword || newPassword.length < 6) {
    console.error('新密码至少 6 个字符。');
    process.exit(1);
  }
  const config = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  config.passwordHash = sha256hex(newPassword);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log('密码已更新。');
  console.log('注意：需重启网关后生效（运行 stop-gateway.ps1 再 start-gateway.ps1）。');
  console.log('已登录设备的会话 Cookie 不受影响，仍保持登录；如需强制重新登录，在设备上访问 /logout。');
  process.exit(0);
}

if (process.argv[2] === '--set-password') {
  setPassword(process.argv[3]);
}

const config = loadOrCreateConfig();

// ---------- 会话令牌 ----------
function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function makeSession() {
  const exp = Date.now() + config.sessionDays * 86400000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validSession(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function sessionCookieHeader() {
  return `${SESSION_COOKIE}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionDays * 86400}`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- 登录限速 ----------
const fails = new Map(); // ip -> {n, t}
function tooManyFails(ip) {
  const r = fails.get(ip);
  if (!r) return false;
  if (Date.now() - r.t > config.loginFailWindowMs) { fails.delete(ip); return false; }
  return r.n >= config.maxLoginFails;
}
function recordFail(ip) {
  const r = fails.get(ip);
  if (!r || Date.now() - r.t > config.loginFailWindowMs) fails.set(ip, { n: 1, t: Date.now() });
  else r.n++;
}
function resetFails(ip) { fails.delete(ip); }

function checkPassword(pw) {
  const a = Buffer.from(sha256hex(pw), 'utf8');
  const b = Buffer.from(config.passwordHash, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 登录页 ----------
function loginPage(err, nextPath) {
  const errText = err === 'ratelimit' ? '尝试次数过多，请 10 分钟后再试' : '密码错误，请重试';
  const nextInput = nextPath ? `<input type="hidden" name="next" value="${escapeHtml(nextPath)}">` : '';
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<link rel="icon" href="data:,">
<title>DSH 远程访问登录</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1115;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-tap-highlight-color:transparent}
  .card{width:100%;max-width:360px;background:#161a21;border:1px solid #262b35;border-radius:16px;padding:32px 24px}
  h1{font-size:20px;font-weight:650;text-align:center;margin-bottom:6px;letter-spacing:.5px}
  p.sub{font-size:13px;color:#8b93a3;text-align:center;margin-bottom:24px}
  input{width:100%;font-size:16px;padding:13px 14px;border-radius:10px;border:1px solid #333a47;background:#0f1115;color:#e6e8eb;outline:none}
  input:focus{border-color:#4f8cff}
  button{width:100%;margin-top:14px;font-size:16px;font-weight:600;padding:13px;border-radius:10px;border:none;background:#3b82f6;color:#fff;cursor:pointer}
  button:active{background:#2f6fd6}
  .err{display:none;background:#3a1f24;border:1px solid #6b2f38;color:#f2a7b3;font-size:13px;padding:10px 12px;border-radius:10px;margin-bottom:14px;text-align:center}
</style></head><body>
<div class="card">
  <h1>DeepSeek Harness</h1>
  <p class="sub">手机远程访问网关</p>
  <div class="err" id="e">${errText}</div>
  <form method="post" action="/login">
    ${nextInput}
    <input type="password" name="password" placeholder="访问密码" autocomplete="current-password" autofocus>
    <button type="submit">登 录</button>
  </form>
  <p style="text-align:center;margin-top:18px"><a href="/m" style="color:#4f8cff;font-size:13px;text-decoration:none">📱 手机版界面 →</a></p>
</div>
<script>
  var m = location.search.match(/err=([a-z]+)/);
  if (m) { var e = document.getElementById('e');
    if (m[1] === 'ratelimit') e.textContent = '尝试次数过多，请 10 分钟后再试';
    e.style.display = 'block';
    var n = location.search.match(/next=([^&]+)/);
    history.replaceState(null, '', n ? '/login?next=' + n[1] : '/login');
  }
</script>
</body></html>`;
}

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** decodeURIComponent 的安全包装：畸形百分号编码会抛 URIError，不能让单个请求打崩进程 */
function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return '';
  }
}

/** 只允许同源绝对路径（防开放重定向） */
function safeNextPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return '/';
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\r') && !raw.includes('\n')) return raw;
  return '/';
}

function nextFromUrl(reqUrl) {
  const query = reqUrl.split('?')[1] || '';
  const raw = new URLSearchParams(query).get('next');
  return raw ? safeNextPath(safeDecodeURIComponent(raw)) : '/';
}

function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (req.method === 'GET') {
    const nextPath = nextFromUrl(req.url);
    res.writeHead(200, HTML_HEADERS);
    res.end(loginPage(undefined, nextPath));
    return;
  }
  if (req.method === 'POST') {
    if (tooManyFails(ip)) {
      res.writeHead(429, HTML_HEADERS);
      res.end(loginPage('ratelimit'));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      const pwMatch = /(?:^|&)password=([^&]*)/.exec(body);
      const nextMatch = /(?:^|&)next=([^&]*)/.exec(body);
      const pw = pwMatch ? safeDecodeURIComponent(pwMatch[1].replace(/\+/g, ' ')) : '';
      const nextPath = safeNextPath(safeDecodeURIComponent(nextMatch ? nextMatch[1].replace(/\+/g, ' ') : '/'));
      if (checkPassword(pw)) {
        resetFails(ip);
        log(`login OK from ${ip}`);
        res.writeHead(302, { Location: nextPath, 'Set-Cookie': sessionCookieHeader() });
        res.end();
      } else {
        recordFail(ip);
        log(`login FAIL from ${ip} (${fails.get(ip).n}/${config.maxLoginFails})`);
        res.writeHead(401, HTML_HEADERS);
        res.end(loginPage(undefined, nextPath));
      }
    });
    return;
  }
  res.writeHead(405, HTML_HEADERS);
  res.end('Method Not Allowed');
}

// ---------- 反向代理 ----------
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function forwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  // 移除网关会话 Cookie：req.headers 里它是 cookie 头的一部分，delete 单键无效
  delete out[SESSION_COOKIE];
  if (out.cookie) {
    out.cookie = String(out.cookie)
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith(SESSION_COOKIE + '='))
      .join('; ');
    if (!out.cookie) delete out.cookie;
  }
  // DSH 仅信任本机来源（Host/Origin 带局域网地址会被 403），转发前重写为本机地址
  out.host = `${config.targetHost}:${config.targetPort}`;
  if (out.origin) out.origin = `http://${config.targetHost}:${config.targetPort}`;
  return out;
}

function proxyRequest(req, res) {
  const preq = http.request(
    {
      host: config.targetHost,
      port: config.targetPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers),
    },
    (pres) => {
      const headers = forwardHeaders(pres.headers);
      res.writeHead(pres.statusCode, headers);
      pres.pipe(res);
    }
  );
  preq.on('error', (e) => {
    log(`upstream error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><h3>502 Bad Gateway</h3><p>无法连接 DSH（127.0.0.1:3080），请确认 <code>dsh web</code> 正在运行。</p>');
    } else {
      res.destroy();
    }
  });
  req.on('error', () => preq.destroy());
  req.pipe(preq);
}

function proxyUpgrade(req, socket, head) {
  const headers = forwardHeaders(req.headers);
  headers['Connection'] = 'Upgrade';
  headers['Upgrade'] = req.headers.upgrade || 'websocket';
  const preq = http.request(
    { host: config.targetHost, port: config.targetPort, method: 'GET', path: req.url, headers },
    (pres) => {
      // 上游对 Upgrade 请求返回了普通 HTTP 响应（非 101）
      let resp = `HTTP/${pres.httpVersion} ${pres.statusCode} ${pres.statusMessage}\r\n`;
      for (let i = 0; i < pres.rawHeaders.length; i += 2) {
        if (HOP_BY_HOP.has(pres.rawHeaders[i].toLowerCase())) continue;
        resp += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
      }
      resp += '\r\n';
      socket.write(resp);
      pres.pipe(socket);
      pres.on('end', () => socket.end());
    }
  );
  preq.on('upgrade', (pres, psock, phead) => {
    let resp = `HTTP/${pres.httpVersion} ${pres.statusCode} ${pres.statusMessage}\r\n`;
    for (let i = 0; i < pres.rawHeaders.length; i += 2) {
      resp += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
    }
    resp += '\r\n';
    socket.write(resp);
    if (phead && phead.length) socket.write(phead);
    socket.pipe(psock);
    psock.pipe(socket);
    psock.on('close', () => socket.destroy());
    socket.on('close', () => psock.destroy());
  });
  preq.on('error', (e) => {
    log(`upstream ws error: ${e.message}`);
    socket.destroy();
  });
  socket.on('error', () => preq.destroy());
  preq.end();
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (pathname === '/login') { handleLogin(req, res); return; }

  if (pathname === '/logout') {
    res.writeHead(302, {
      Location: '/login',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  if (validSession(cookies[SESSION_COOKIE])) {
    // 手机专用界面（同源 SPA，复用登录 Cookie，直连 /api 与 WS）
    if (pathname === '/m' || pathname === '/m/') {
      const pagePath = path.join(ROOT, 'mobile.html');
      if (fs.existsSync(pagePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(pagePath).pipe(res);
      } else {
        res.writeHead(500, HTML_HEADERS);
        res.end('mobile.html 缺失');
      }
      return;
    }
    if (pathname === '/m/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({
        id: '/m',
        name: 'DSH Mobile',
        short_name: 'DSH',
        start_url: '/m',
        scope: '/m',
        display: 'standalone',
        theme_color: '#151517',
        background_color: '#151517',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      }));
      return;
    }
    proxyRequest(req, res);
    return;
  }

  // 未登录
  if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
    const next = encodeURIComponent(req.url);
    res.writeHead(302, { Location: `/login?next=${next}` });
    res.end();
  } else {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', login: '/login' }));
  }
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/login' || pathname === '/logout' || pathname === '/m') {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (!validSession(cookies[SESSION_COOKIE])) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  proxyUpgrade(req, socket, head);
});

server.on('clientError', (err, socket) => {
  const raw = err && err.rawPacket ? err.rawPacket.toString('utf8').replace(/\r\n/g, '\\n').slice(0, 300) : '';
  log(`clientError: ${err && (err.code || err.message)} raw=${raw}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`启动失败：端口 ${config.port} 已被占用。请先停止旧实例，或修改 config.json 中的 port 后重试。`);
    process.exit(1);
  }
  log(`server error: ${e.message}`);
  process.exit(1);
});

server.listen(config.port, '0.0.0.0', () => {
  log(`dsh-mobile-gateway 已启动，监听 0.0.0.0:${config.port} → ${config.targetHost}:${config.targetPort}`);
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        log(`  局域网入口: http://${a.address}:${config.port}  (${name})`);
      }
    }
  }
  log('提示: 修改密码 → node gateway.js --set-password <新密码>');
});
