// mobile.html 模型逻辑端到端测试：
// 真实登录网关 → 真实 session.list/history → 折叠断言 → 合成实时帧 → loadMore 顺序断言
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3081';
const PASSWORD = process.env.DSH_GW_PASSWORD || process.argv[2];
if (!PASSWORD) {
  console.error('用法: node test-model.js <访问密码>');
  console.error('或:   DSH_GW_PASSWORD=<访问密码> node test-model.js');
  process.exit(1);
}
const html = fs.readFileSync(path.join(__dirname, 'mobile.html'), 'utf8');
const m = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('未提取到脚本'); process.exit(1); }
let script = m[1];

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ FAIL: ' + msg); failures++; }
}

(async () => {
  // 1) 真实登录
  const loginResp = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(PASSWORD),
    redirect: 'manual',
  });
  const sc = loginResp.headers.get('set-cookie') || '';
  const token = /dsh_gw_session=([^;]+)/.exec(sc);
  if (!token) { console.error('登录失败'); process.exit(1); }
  console.log('✓ 登录成功，会话 Cookie 已获取');

  // 2) 环境桩
  function makeEl() {
    return {
      innerHTML: '', textContent: '', value: '', style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {}, remove() {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      insertAdjacentHTML() {}, remove() {}, querySelector() { return null; },
    };
  }
  global.document = { getElementById: () => makeEl() };
  global.location = { href: BASE + '/m', protocol: 'http:' };
  class DeadWS {
    constructor() { this.readyState = 0; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null; }
    close() {} addEventListener() {}
  }
  global.WebSocket = DeadWS;
  const realFetch = global.fetch;
  global.fetch = (url, init) => {
    const u = String(url);
    const abs = u.startsWith('http') ? u : BASE + u;
    const headers = Object.assign({}, (init && init.headers) || {});
    headers.Cookie = 'dsh_gw_session=' + token[1];
    return realFetch(abs, Object.assign({}, init, { headers })).then(async (resp) => {
      if (abs.includes('/api/')) {
        const txt = await resp.clone().text();
        console.log('  [fetch] ' + abs + ' → ' + resp.status + ' ' + txt.slice(0, 160).replace(/\n/g, ' '));
      }
      return resp;
    });
  };

  // 3) 执行 SPA 脚本 + 挂测试钩子（用 getter 读取会被重新赋值的变量）
  script += '\n;globalThis.__t = { sessions, getListItems: () => listItems, openSession, refreshList, loadMore, resyncSession, handleMuxFrame, pendFor, getCurrentId: () => currentId, getView: () => view };\n';
  (0, eval)(script);
  const t = globalThis.__t;
  const listItems = () => t.getListItems();

  // 4) 驱动：列表 → 打开本会话
  await t.refreshList();
  console.log('✓ 会话列表加载，共 ' + listItems().length + ' 条');
  assert(listItems().length > 0, '列表非空');

  const target = listItems()[0];
  assert(!!target, '找到第一个会话（' + String(target && target.sessionId).slice(0, 18) + '…）');

  await t.openSession(target.sessionId);
  const s = t.sessions.get(target.sessionId);
  const kinds = {};
  let seqs = [];
  for (const n of s.nodes) { kinds[n.kind] = (kinds[n.kind] || 0) + 1; seqs.push(n.seq); }
  console.log('  打开后: nodes=' + s.nodes.length + ' 种类=' + JSON.stringify(kinds) +
    ' lastSeq=' + s.lastSeq + ' firstSeq=' + s.firstSeq + ' hasMore=' + s.hasMore);
  assert(s.nodes.length > 0, '折叠出消息节点');
  assert(s.foldCursor === s.lastSeq, 'foldCursor 追上 lastSeq');
  let sorted = seqs.every((v, i) => i === 0 || seqs[i - 1] <= v);
  assert(sorted, '节点 seq 升序');
  const liveDrafts = s.nodes.filter(n => n.live).length;
  console.log('  流式中的草稿节点数: ' + liveDrafts + '（运行中的会话允许 >0）');

  // 4.5) 断线补漏：resyncSession 重放尾页，去重且保持升序
  const lenBeforeR = s.nodes.length;
  await t.resyncSession(target.sessionId);
  const sR = t.sessions.get(target.sessionId);
  const seqsR = sR.nodes.map(n => n.seq);
  console.log('  resync 后 nodes=' + sR.nodes.length + '（重放前 ' + lenBeforeR + '，运行中会话允许新增）');
  assert(sR.nodes.length >= lenBeforeR, 'resync 不丢失节点');
  assert(sR.foldCursor === sR.lastSeq, 'resync 后 foldCursor 仍同步');
  assert(seqsR.every((v, i) => i === 0 || seqsR[i - 1] <= v), 'resync 后仍按 seq 升序');
  assert(t.pendFor(target.sessionId) === 0, 'pendFor 空会话为 0');

  // 5) 合成实时帧：追加 user/message
  const lenBefore = s.nodes.length;
  const newSeq = s.lastSeq + 1;
  t.handleMuxFrame({ rpcId: 'synth-rpc-1' }, {
    type: 'session/event', sessionId: target.sessionId,
    event: { type: 'user/message', seq: newSeq, time: Date.now(), surfaceOp: 'append',
      data: { id: 'synth-user-1', content: [{ type: 'text', text: '合成测试消息' }] } },
    view: undefined,
  });
  const s1 = t.sessions.get(target.sessionId);
  assert(s1.nodes.length === lenBefore + 1, '实时帧追加一个节点');
  assert(s1.nodes[s1.nodes.length - 1].kind === 'user' && s1.nodes[s1.nodes.length - 1].text === '合成测试消息', '新节点为合成用户消息');
  assert(s1.foldCursor === newSeq && s1.lastSeq === newSeq, 'foldCursor 随实时帧推进');
  assert(s1.renderedCount === s1.nodes.length, '增量渲染计数同步');

  // 6) 合成重复帧：seq 相同 → 去重
  t.handleMuxFrame({ rpcId: 'synth-rpc-2' }, {
    type: 'session/event', sessionId: target.sessionId,
    event: { type: 'user/message', seq: newSeq, time: Date.now(), surfaceOp: 'append',
      data: { id: 'synth-user-1', content: [{ type: 'text', text: '重复' }] } },
    view: undefined,
  });
  const s2 = t.sessions.get(target.sessionId);
  assert(s2.nodes.length === s1.nodes.length, '重复 seq 被去重');

  // 7) 合成 chunk + final：草稿替换路径
  const lenBefore3 = s2.nodes.length;
  t.handleMuxFrame({ rpcId: 'synth-rpc-3' }, {
    type: 'session/event', sessionId: target.sessionId,
    event: { type: 'assistant/chunk', seq: newSeq + 1, time: Date.now(),
      data: { turn: 999, step: 0, chunk: { type: 'text-delta', text: '流式片段' } } },
    view: undefined,
  });
  const sChunk = t.sessions.get(target.sessionId);
  assert(sChunk.nodes.length === lenBefore3 + 1 && sChunk.nodes[lenBefore3].live === true && sChunk.nodes[lenBefore3].text === '流式片段', 'chunk 创建流式草稿节点');
  t.handleMuxFrame({ rpcId: 'synth-rpc-4' }, {
    type: 'session/event', sessionId: target.sessionId,
    event: { type: 'assistant/message', seq: newSeq + 2, time: Date.now(), surfaceOp: 'append',
      data: { turn: 999, step: 0, message: { id: 'synth-msg-1', content: [{ type: 'text', text: '最终回复' }] } } },
    view: undefined,
  });
  const s3 = t.sessions.get(target.sessionId);
  assert(s3.nodes.length === lenBefore3 + 1, 'final 原位替换草稿（不新增节点）');
  assert(s3.nodes[lenBefore3].kind === 'assistant' && s3.nodes[lenBefore3].text === '最终回复' && s3.nodes[lenBefore3].live === false, 'final 内容替换草稿');
  assert(s3.nodes.filter(n => n.live).length === liveDrafts, '合成草稿已被 final 替换（live 数不变）');

  // 8) loadMore：老事件前置
  const oldFirstSeq = s3.firstSeq;
  await t.loadMore();
  const s4 = t.sessions.get(target.sessionId);
  const seqs4 = s4.nodes.map(n => n.seq);
  const sorted4 = seqs4.every((v, i) => i === 0 || seqs4[i - 1] <= v);
  console.log('  loadMore 后: nodes=' + s4.nodes.length + ' firstSeq ' + oldFirstSeq + ' → ' + s4.firstSeq + ' hasMore=' + s4.hasMore);
  assert(s4.firstSeq < oldFirstSeq, 'firstSeq 前移（更早事件已加载）');
  assert(sorted4, 'loadMore 后全量重折仍按 seq 升序');

  // 9) 合成老事件混入 → 再 loadMore 场景已被 resetFold 覆盖；收尾断言
  const title = s4.title;
  console.log('  会话标题: ' + title);

  console.log(failures === 0 ? '\n全部断言通过 ✅' : '\n有 ' + failures + ' 个断言失败 ❌');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error('测试异常: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 8).join('\n')); process.exitCode = 1; });
