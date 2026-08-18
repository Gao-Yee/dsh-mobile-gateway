// iPhone 15 Pro Max 视口的真实浏览器 UI 验证（完整交互套件）
'use strict';
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3081';
const PASSWORD = process.env.DSH_GW_PASSWORD || process.argv[2];
if (!PASSWORD) {
  console.error('用法: node ui-test.js <访问密码>');
  console.error('或:   DSH_GW_PASSWORD=<访问密码> node ui-test.js');
  process.exit(1);
}
const CHROME = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = __dirname + '\\shots';
const fs = require('fs');
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ FAIL: ' + msg); failures++; }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const errors = [];
  const responds = [];
  const prompts = [];
  let muxFrames = 0;
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  page.on('request', (r) => {
    if (r.url().includes('/api/respond') && r.postData()) {
      try { responds.push(JSON.parse(r.postData())); } catch (_) {}
    }
    if (r.url().includes('/api/session.prompt') && r.postData()) {
      try { prompts.push(JSON.parse(r.postData())); } catch (_) {}
    }
  });
  page.on('websocket', (ws) => {
    if (ws.url().includes('/api/events.mux')) {
      ws.on('framereceived', () => { muxFrames++; });
    }
  });

  // 1) 未登录访问 /m → 跳转登录页
  await page.goto(BASE + '/m', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type=password]', { timeout: 8000 });
  console.log('1. 未登录跳转登录页');
  assert(page.url().includes('/login'), 'URL 含 /login');

  // 2) 登录 → 回到 /m
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sess-card', { timeout: 15000 });
  console.log('2. 登录后进入 /m 会话列表');
  assert(page.url().endsWith('/m'), 'URL 回到 /m');
  const cardCount = await page.locator('.sess-card').count();
  assert(cardCount > 0, '会话卡片渲染（' + cardCount + ' 个）');
  await page.screenshot({ path: SHOTS + '\\2-list.png' });

  // 3) 打开主会话
  const card = page.locator('.sess-card').first();
  const sid = await card.getAttribute('onclick').then((s) => /openSession\('([^']+)'\)/.exec(s)[1]);
  console.log('3. 打开主会话 ' + sid.slice(0, 16) + '…');
  await card.click();
  await page.waitForSelector('.msg', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const title = await page.textContent('#hTitle');
  assert((title || '').length > 0, '标题非空');
  const msgCount = await page.locator('.msg').count();
  assert(msgCount > 0, '消息渲染（' + msgCount + ' 节点）');
  assert(muxFrames > 0, 'mux WebSocket 实时帧到达（' + muxFrames + ' 帧）');
  await page.evaluate(() => { const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOTS + '\\3-chat.png' });

  // 3.5) 合成审批帧 → 卡片渲染 → 允许一次 → respond 信封校验 → 清除
  await page.evaluate((sid) => {
    handleMuxFrame({ rpcId: 'tst-apr-1' }, {
      type: 'approval/requested', sessionId: sid, approvalId: 'test-approval-1', toolName: '测试工具', reason: '合成测试',
    });
  }, sid);
  await page.waitForSelector('.pend .p-body', { timeout: 5000 });
  const pendText = await page.textContent('.pend');
  assert((pendText || '').includes('测试工具') && (pendText || '').includes('允许一次'), '审批卡片渲染');
  await page.screenshot({ path: SHOTS + '\\3b-approval.png' });
  await page.click('.pend button.ok');
  await page.waitForTimeout(800);
  const aprResp = responds.find(r => r && r.rpcId === 'tst-apr-1');
  assert(!!aprResp && aprResp.type === 'client-response'
    && aprResp.result && aprResp.result.ok === true
    && aprResp.result.value && aprResp.result.value.outcome === 'allowed-once'
    && aprResp.result.value.approvalId === 'test-approval-1',
    '「允许一次」发送了正确的 client-response 信封');
  await page.evaluate((sid) => {
    handleMuxFrame({ rpcId: 'clr' }, { type: 'approval/resolved', sessionId: sid, approvalId: 'test-approval-1', outcome: 'unavailable' });
  }, sid);
  await page.waitForTimeout(400);

  // 3.6) 合成提问帧 → 弹层渲染 → 选选项 → 提交 → 信封校验 → 清除
  await page.evaluate((sid) => {
    handleMuxFrame({ rpcId: 'tst-q-1' }, {
      type: 'question/requested', sessionId: sid,
      questions: [{ id: 'q1', question: '合成问题：选一个？', options: [{ label: '选项A' }, { label: '选项B' }] }],
    });
  }, sid);
  await page.waitForSelector('#qmask.show .q-opt', { timeout: 5000 });
  const qText = await page.textContent('#qcard');
  assert((qText || '').includes('合成问题') && (qText || '').includes('选项A'), '提问弹层渲染');
  await page.screenshot({ path: SHOTS + '\\3c-question.png' });
  await page.click('.q-opt');
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.querySelector('.q-opt').classList.contains('sel')), '选项选中态生效');
  await page.click('#qcard .q-actions button.primary');
  await page.waitForTimeout(800);
  const qResp = responds.find(r => r && r.rpcId === 'tst-q-1');
  assert(!!qResp && qResp.result && qResp.result.ok === true
    && qResp.result.value && qResp.result.value.answer
    && qResp.result.value.answer.answers[0].id === 'q1'
    && qResp.result.value.answer.answers[0].selected[0] === '选项A',
    '提交答案发送了正确信封');
  await page.evaluate((sid) => {
    handleMuxFrame({ rpcId: 'clr2' }, { type: 'question/resolved', sessionId: sid, questionRpcId: 'tst-q-1', outcome: 'cancelled' });
  }, sid);
  await page.waitForTimeout(400);
  assert(!(await page.evaluate(() => document.getElementById('qmask').classList.contains('show'))), '提问弹层已关闭');

  // 4) 任务面板切换
  await page.click('#btnJobs');
  await page.waitForTimeout(600);
  const jobsText = await page.textContent('#main');
  console.log('4. 任务面板（' + (jobsText || '').length + ' 字符）');
  await page.screenshot({ path: SHOTS + '\\4-jobs.png' });
  await page.click('#btnJobs'); // 切回聊天
  await page.waitForTimeout(400);

  // 5) 布局断言
  const layout = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const msgs = [...document.querySelectorAll('.msg')].map(el => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    });
    const composer = document.getElementById('composer').getBoundingClientRect();
    const input = document.getElementById('input').getBoundingClientRect();
    return { vw, overflow: document.body.scrollWidth - vw, overflowMsgs: msgs.filter(r => r.left < -1 || r.right > vw + 1).length, composerInView: composer.bottom <= window.innerHeight, inputH: Math.round(input.height) };
  });
  console.log('5. 布局: ' + JSON.stringify(layout));
  assert(layout.overflow <= 0, '无横向溢出');
  assert(layout.overflowMsgs === 0, '消息气泡不越界');
  assert(layout.composerInView, '输入区在视口内');
  assert(layout.inputH >= 40, '输入框高度正常');

  // 6) 返回列表 → 工作区「＋」新建会话 → 真实发消息闭环
  await page.click('#btnBack');
  await page.waitForSelector('.ws-group', { timeout: 8000 });
  // 手机端列表只保留工作区分组：验证「未分组/已归档」不再出现
  const groupTitles = await page.evaluate(() => [...document.querySelectorAll('.ws-title')].map(e => e.textContent));
  console.log('  分组: ' + groupTitles.join(' | '));
  assert(!groupTitles.includes('未分组') && !groupTitles.includes('已归档'), '「未分组」「已归档」分类已移除');
  // 点第一个工作区的「＋」创建新会话
  const firstGroup = page.locator('.ws-group').first();
  await firstGroup.locator('summary button.mini').click();
  await page.waitForSelector('#input', { timeout: 10000 });
  await page.fill('#input', '连通性测试：请只回复「手机端连通成功」');
  await page.click('#send');
  await page.waitForTimeout(1500);
  const promptReq = prompts[prompts.length - 1];
  const bid = promptReq && promptReq.payload && promptReq.payload.sessionId;
  assert(!!promptReq && promptReq.payload.mode === 'queue'
    && promptReq.payload.content[0].type === 'text'
    && promptReq.payload.content[0].text.includes('连通性测试'),
    'session.prompt 信封正确');
  // 等待自己的消息经 WS 回显
  try {
    await page.waitForSelector('.msg.user', { timeout: 15000 });
    console.log('  用户消息已实时回显 ✓');
  } catch (_) {
    assert(false, '用户消息实时回显');
  }
  await page.screenshot({ path: SHOTS + '\\6-sent.png' });
  // 停止该会话，避免残留 agent 运行
  await page.evaluate((bid) => { fetch('/api/session.cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'tst-cancel', method: 'session.cancel', payload: { sessionId: bid } }) }); }, bid);
  await page.waitForTimeout(500);
  await page.click('#btnBack');
  await page.waitForSelector('.ws-group', { timeout: 8000 });
  // 新会话应出现在列表中（等待 host/session-added 帧刷新列表快照）
  try {
    await page.waitForSelector('.sess-card[onclick*="' + bid + '"]', { timeout: 8000 });
    assert(true, '新会话出现在工作区分组列表中');
  } catch (_) {
    assert(false, '新会话出现在工作区分组列表中（bid=' + bid + '）');
  }

  // 6.5) 重命名：卡片 ⋯ → 菜单 → 重命名 → 保存
  const newCardLoc = '.sess-card[onclick*="' + bid + '"]';
  await page.click(newCardLoc + ' button.card-menu');
  await page.waitForSelector('#scard .sh-opt', { timeout: 5000 });
  await page.click('#scard .sh-opt:has-text("重命名")');
  await page.waitForSelector('#renameInput', { timeout: 5000 });
  await page.fill('#renameInput', 'UI测试会话');
  await page.click('#scard .q-actions button.primary');
  await page.waitForTimeout(1000);
  const renamedCard = page.locator(newCardLoc);
  assert(await renamedCard.count() > 0 && ((await renamedCard.first().textContent()) || '').includes('UI测试会话'), '重命名后卡片标题更新');
  console.log('  重命名 ✓ → UI测试会话');
  await page.screenshot({ path: SHOTS + '\\6b-renamed.png' });

  // 6.6) 归档：菜单 → 两次点击确认 → 卡片消失
  await page.click(newCardLoc + ' button.card-menu');
  await page.waitForSelector('#scard .sh-opt', { timeout: 5000 });
  await page.click('#scard .sh-opt.danger-opt');
  await page.waitForTimeout(400);
  const armedText = await page.textContent('#scard .sh-opt.danger-opt');
  assert((armedText || '').includes('确认归档'), '归档需要二次确认');
  await page.click('#scard .sh-opt.danger-opt');
  try {
    await page.waitForSelector(newCardLoc, { state: 'detached', timeout: 8000 });
    assert(true, '归档后卡片从列表消失');
  } catch (_) {
    assert(false, '归档后卡片从列表消失');
  }
  console.log('  归档 ✓（测试会话已自动归档，不留垃圾）');
  await page.screenshot({ path: SHOTS + '\\6c-archived.png' });

  // 7) 无 Cookie 安全复查
  const ctx2 = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  const page2 = await ctx2.newPage();
  page2.on('console', (msg) => { if (msg.type() === 'error') errors.push('page2 console: ' + msg.text()); });
  await page2.goto(BASE + '/m', { waitUntil: 'networkidle' });
  assert(page2.url().includes('/login'), '无 Cookie 访问 /m 被拦截');
  await ctx2.close();

  console.log('浏览器控制台错误: ' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'));
  assert(errors.length === 0, '无 JS 运行时错误');
  await browser.close();
  console.log(failures === 0 ? '\n浏览器 UI 验证全部通过 ✅' : '\n有 ' + failures + ' 项失败 ❌');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n')); process.exit(1); });
