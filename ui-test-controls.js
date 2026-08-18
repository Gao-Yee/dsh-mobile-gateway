// 新增功能 UI 验证：主题切换 / 对话模式选择 / 模型与思考强度选择
// iPhone 15 Pro Max 视口，真实网关 + 真实 DSH 后端
'use strict';
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3081';
const PASSWORD = process.env.DSH_GW_PASSWORD || process.argv[2];
if (!PASSWORD) {
  console.error('用法: node ui-test-controls.js <访问密码>');
  console.error('或:   DSH_GW_PASSWORD=<访问密码> node ui-test-controls.js');
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
  const presetCalls = [];
  const modelCalls = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  page.on('request', (r) => {
    if (r.url().includes('/api/agentPreset.select') && r.postData()) {
      try { presetCalls.push(JSON.parse(r.postData())); } catch (_) {}
    }
    if (r.url().includes('/api/session.selectModel') && r.postData()) {
      try { modelCalls.push(JSON.parse(r.postData())); } catch (_) {}
    }
  });

  // 0) 登录
  await page.goto(BASE + '/m', { waitUntil: 'networkidle' });
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sess-card', { timeout: 15000 });
  console.log('0. 已登录，进入会话列表');

  // 1) 主题切换（列表页 footer 按钮）
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
  assert(themeBefore === 'dark', '默认深色主题（data-theme=' + themeBefore + '）');
  await page.click('#btnThemeList');
  await page.waitForTimeout(400);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeAfter === 'light', '点击后切换为浅色主题');
  const lsTheme = await page.evaluate(() => localStorage.getItem('dsh-m-theme'));
  assert(lsTheme === 'light', '主题已持久化到 localStorage');
  const metaColor = await page.evaluate(() => document.querySelector('meta[name=theme-color]').content);
  assert(metaColor === '#f2f4f8', 'meta theme-color 同步（' + metaColor + '）');
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(bgLight === 'rgb(242, 244, 248)', '浅色背景生效（' + bgLight + '）');
  await page.screenshot({ path: SHOTS + '\\c1-list-light.png' });
  // 刷新页面 → 主题保持
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sess-card', { timeout: 15000 });
  const themeReload = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeReload === 'light', '刷新后浅色主题保持');
  // 切回深色，继续后续测试
  await page.click('#btnThemeList');
  await page.waitForTimeout(300);
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', '切回深色主题');

  // 2) 打开进行中的会话（非 blank）：模式 chip 锁定 + 模型 chip 显示真实模型
  const card = page.locator('.sess-card').first();
  await card.click();
  await page.waitForSelector('#chatbar', { timeout: 15000 });
  await page.waitForTimeout(2000); // 等 session.models / agentPreset.list 返回
  console.log('2. 进行中会话的控制条');
  const modeLocked = await page.evaluate(() => document.getElementById('chipMode').classList.contains('locked'));
  assert(modeLocked, '非 blank 会话模式 chip 为锁定态');
  const modelLabel = await page.textContent('#chipModelLabel');
  assert(!!modelLabel && modelLabel !== '模型…' && modelLabel.length > 1, '模型 chip 显示真实模型（' + modelLabel + '）');
  // 锁定态点击 → toast 提示
  await page.click('#chipMode');
  await page.waitForTimeout(500);
  const toastText = await page.textContent('#toast');
  assert((toastText || '').includes('固定'), '锁定态点击弹出固定提示（' + toastText + '）');
  assert(!(await page.evaluate(() => document.getElementById('smask').classList.contains('show'))), '锁定态不打开弹层');
  await page.screenshot({ path: SHOTS + '\\c2-chatbar.png' });

  // 3) 模型弹层：root → 模型列表 → 返回 → 思考强度 → 选当前档
  // 先记录当前选择，测试结束后恢复（重选模型会把强度重置为 default）
  const origSel = await page.evaluate(() => {
    const s = sessions.get(currentId);
    return s && s.models && s.models.current ? JSON.parse(JSON.stringify(s.models.current)) : null;
  });
  await page.click('#chipModel');
  await page.waitForSelector('#smask.show .sh-cur', { timeout: 8000 });
  const rootText = await page.textContent('#scard');
  assert((rootText || '').includes('当前'), '模型弹层 root 显示当前模型');
  await page.screenshot({ path: SHOTS + '\\c3-model-root.png' });
  await page.click('#scard .sh-opt'); // 「模型」行
  await page.waitForSelector('#scard .sh-group', { timeout: 5000 });
  const groupCount = await page.locator('#scard .sh-group').count();
  const optCount = await page.locator('#scard .sh-opt').count();
  assert(groupCount >= 1 && optCount >= 2, '模型列表按提供商分组（' + groupCount + ' 组 / ' + optCount + ' 个模型）');
  const selCount = await page.locator('#scard .sh-opt.sel').count();
  assert(selCount === 1, '当前模型有选中标记');
  await page.screenshot({ path: SHOTS + '\\c4-model-list.png' });
  // 点击当前已选模型 → 信封正确且回到 root
  await page.click('#scard .sh-opt.sel');
  await page.waitForTimeout(900);
  assert(modelCalls.length === 1 && modelCalls[0].payload.provider && modelCalls[0].payload.model,
    'session.selectModel 信封正确（' + JSON.stringify(modelCalls[0] && modelCalls[0].payload) + '）');
  await page.waitForSelector('#smask.show .sh-cur', { timeout: 5000 });
  // 思考强度
  const effortBtn = page.locator('#scard .sh-opt', { hasText: '思考强度' });
  if (await effortBtn.count() > 0) {
    await effortBtn.click();
    await page.waitForTimeout(600);
    const effOpts = await page.locator('#scard .sh-opt').count();
    assert(effOpts >= 2, '思考强度选项渲染（' + effOpts + ' 个）');
    await page.screenshot({ path: SHOTS + '\\c5-effort.png' });
    await page.click('#scard .sh-opt.sel'); // 重选当前档，无副作用
    await page.waitForTimeout(900);
    assert(modelCalls.length === 2, '重选思考强度发出第二个 selectModel');
  } else {
    console.log('  （当前模型无思考强度档位，跳过）');
  }
  await page.click('#scard .sh-close');
  await page.waitForTimeout(400);
  assert(!(await page.evaluate(() => document.getElementById('smask').classList.contains('show'))), '弹层已关闭');
  // 恢复原模型选择
  if (origSel) {
    await page.evaluate((sel) => rpc('session.selectModel', {
      sessionId: currentId, provider: sel.provider, model: sel.model,
      ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
    }).then(v => { sessions.get(currentId).models.current = v.selected; renderChatBar(); }), origSel);
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => sessions.get(currentId).models.current);
    assert(restored && restored.reasoningEffort === origSel.reasoningEffort, '已恢复原模型/强度（' + (origSel.reasoningEffort || '默认') + '）');
  }
  await page.click('#btnBack');
  await page.waitForSelector('.sess-card', { timeout: 8000 });

  // 4) 新建 blank 会话：模式可选择（真实 agentPreset.select 闭环）
  await page.click('footer.listfoot button:has-text("新会话")');
  await page.waitForSelector('#chatbar', { timeout: 15000 });
  await page.waitForTimeout(1200);
  console.log('4. blank 会话的模式选择');
  const modeLocked2 = await page.evaluate(() => document.getElementById('chipMode').classList.contains('locked'));
  assert(!modeLocked2, 'blank 会话模式 chip 可点击');
  await page.click('#chipMode');
  await page.waitForSelector('#smask.show .sh-opt', { timeout: 8000 });
  const presetText = await page.textContent('#scard');
  assert((presetText || '').includes('标准模式') && (presetText || '').includes('PTC 模式'), '预设列表含标准/PTC 模式');
  await page.screenshot({ path: SHOTS + '\\c6-preset-sheet.png' });
  await page.click('#scard .sh-opt:has-text("PTC 模式")');
  await page.waitForTimeout(1000);
  assert(presetCalls.length === 1 && presetCalls[0].payload.agentPreset === 'code' && presetCalls[0].payload.sessionId,
    'agentPreset.select 信封正确（' + JSON.stringify(presetCalls[0] && presetCalls[0].payload) + '）');
  const chipLabel = await page.textContent('#chipModeLabel');
  assert((chipLabel || '').includes('PTC'), '模式 chip 更新为 PTC 模式（' + chipLabel + '）');
  assert(!(await page.evaluate(() => document.getElementById('smask').classList.contains('show'))), '选择后弹层自动关闭');
  await page.screenshot({ path: SHOTS + '\\c7-preset-selected.png' });
  await page.click('#btnBack');
  await page.waitForSelector('.sess-card', { timeout: 8000 });

  console.log('浏览器控制台错误: ' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'));
  assert(errors.length === 0, '无 JS 运行时错误');
  await browser.close();
  console.log(failures === 0 ? '\n控制条/主题 UI 验证全部通过 ✅' : '\n有 ' + failures + ' 项失败 ❌');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n')); process.exit(1); });
