// 浏览器自测：用本机 Edge 无头模式 + 调试协议。node tests/browser-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { mockGitHub } from './mock-github.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8792;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- 调试协议 ----------

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = [];
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) {
        const { res, rej, method } = this.wait.get(m.id);
        this.wait.delete(m.id);
        m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
      } else if (m.method) this.handlers.forEach(h => h(m));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej, method }));
  }
  on(fn) { this.handlers.push(fn); }
}

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-edge-'));
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-features=msEdgeSidebarV2', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error('Edge 没启动起来')), 30000);
    proc.stderr.on('data', d => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(to); res(m[1]); }
    });
  });
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  return { cdp, close: () => { try { ws.close(); } catch { } proc.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1500); } };
}

async function newPage(cdp, { width = 412, height = 915, mobile = true } = {}) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  const logs = [];
  cdp.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Page.javascriptDialogOpening') s('Page.handleJavaScriptDialog', { accept: true });
    if (m.method === 'Runtime.exceptionThrown') logs.push('页面报错：' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('控制台错误：' + m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
  const page = {
    s, logs, clicks: 0, browserContextId,
    async size(w, h, mob) {
      await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mob ? 2 : 1, mobile: mob });
      await s('Emulation.setTouchEmulationEnabled', { enabled: mob });
    },
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面里执行出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  ' + expr.slice(0, 200));
      return r.result.value;
    },
    async waitFor(expr, ms = 8000, what = expr) {
      const end = Date.now() + ms;
      for (;;) {
        try { if (await page.eval(expr)) return; } catch { /* 页面切换中 */ }
        if (Date.now() > end) throw new Error('等不到：' + what);
        await sleep(80);
      }
    },
    async goto(url) { await s('Page.navigate', { url }); await page.waitFor('!!window.PP && !!document.querySelector("#view").children.length', 15000, '页面加载'); },
    async reload() { await s('Page.reload', { ignoreCache: false }); await sleep(300); await page.waitFor('!!window.PP && !!document.querySelector("#view").children.length', 15000, '页面重新加载'); },
    async hash(h) { await page.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(120); },
    async click(sel) {
      await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 8000, '找不到 ' + sel);
      page.clicks++;
      await page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
      await sleep(150);
    },
    async fill(sel, v) { await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`); },
    text: sel => page.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`),
    async shot(name) {
      await sleep(350);
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
    },
    async setFile(sel, file) {
      const { result } = await s('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})` });
      await s('DOM.enable');
      await s('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
    },
    async offline(on) {
      await s('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },
  };
  await page.size(width, height, mobile);
  return page;
}

// ---------- 用例框架 ----------

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name); console.log('  ✗ ' + name + '\n    ' + String(e.stack || e).split('\n').slice(0, 4).join('\n    ')); }
}

// ---------- 准备 ----------

const server = await serve(PORT);
let server2;
async function serveAgain() { server2 = await serve(PORT); }
const gh = await mockGitHub(0, { repo: 'me/data', token: 'tk-test' });
const SYNC_CFG = d => `localStorage.setItem('pp.cfg', JSON.stringify({ repo: 'me/data', token: 'tk-test', api: ${JSON.stringify(gh.api)}, device: '${d}' }))`;
const { cdp, close } = await launch();
const IMG = path.join(ROOT, 'icons', 'icon-512.png');

async function makePuzzle(page, data) {
  await page.hash('#/new-puzzle');
  await page.waitFor('!!document.querySelector("#f-name")');
  for (const [k, v] of Object.entries(data)) await page.fill('#f-' + k, v);
  await page.click('[data-act="save-puzzle"]');
}

const FULL = {
  name: '测试拼图', deliverable: '一份交付物', deadline: '2026-12-01', acceptor: '某位客户', value: '¥500', stopRule: '连续 2 周没有外部反馈',
  'lead-0': '每周发 3 份报价', 'lead-1': '每周约 2 次演示',
  'if-0': '如果被打断，我就先记进散块盒', 'if-1': '如果卡住半天，我就换一块', 'if-2': '如果刷手机，我就打开拼图',
  pieces: '报价单\n演示录屏\n第一笔付款\n试用反馈\n第二位客户',
};

const A = await newPage(cdp);
await A.goto(ORIGIN);
await A.eval(SYNC_CFG('手机'));
await A.reload();

console.log('浏览器场景');

await t('1 新建拼图缺任一必填项无法保存；已有 1 主线 + 1 副线时无法再建', async () => {
  for (const k of ['deliverable', 'deadline', 'acceptor', 'value']) {
    await makePuzzle(A, { ...FULL, [k]: '' });
    assert.match(await A.text('#form-err'), /还缺/, '缺 ' + k + ' 时应该报错');
    assert.equal(await A.eval('PP.live("puzzle").length'), 0);
  }
  await makePuzzle(A, { ...FULL, 'if-2': '' });
  assert.match(await A.text('#form-err'), /如果/);
  await makePuzzle(A, FULL);
  await A.waitFor('location.hash.startsWith("#/puzzle/")');
  assert.equal(await A.eval('PP.live("puzzle")[0].lane'), 'main');
  assert.equal(await A.eval('PP.live("piece").length'), 5);
  await makePuzzle(A, { ...FULL, name: '副线拼图', pieces: '副线第一块' });
  await A.waitFor('PP.live("puzzle").length === 2');
  assert.deepEqual(await A.eval('PP.live("puzzle").map(p => p.lane).sort()'), ['main', 'side']);
  await A.hash('#/puzzles');
  assert.equal(await A.eval('document.querySelector("#new-puzzle-btn").disabled'), true);
  await A.hash('#/new-puzzle');
  assert.match(await A.text('#view'), /已有 1 幅主线 \+ 1 幅副线/);
});

let mainId, firstPiece;
await t('2 无证据不能拼上；加图片证据后拼上 → 进经验卡 → 四格缺一格是草稿，补齐后变「待讲」', async () => {
  mainId = await A.eval('PP.live("puzzle").find(p => p.lane === "main").id');
  firstPiece = await A.eval(`PP.live("piece").filter(p => p.puzzleId === "${mainId}").sort((a,b)=>a.order-b.order)[0].id`);
  await A.hash('#/piece/' + firstPiece);
  assert.equal(await A.eval('document.querySelector("#place-btn").disabled'), true);
  assert.match(await A.text('#view'), /先附一个证据/);
  await A.setFile('input[data-change="evi-image"]', IMG);
  await A.waitFor(`(PP.get("${firstPiece}").evidence || []).length === 1`, 10000, '图片证据');
  const size = await A.eval(`PP.DB.getFile(PP.get("${firstPiece}").evidence[0].fileId).then(f => f.size)`);
  assert.ok(size > 0 && size <= 300 * 1024, '图片压缩到 300KB 以内');
  await A.waitFor('document.querySelector("#place-btn") && !document.querySelector("#place-btn").disabled');
  await A.click('#place-btn');
  await A.waitFor('location.hash.startsWith("#/card/")', 5000, '拼上后进入经验卡');
  assert.equal(await A.eval(`PP.get("${firstPiece}").status`), 'done');
  assert.equal(await A.eval('document.querySelector(".stepper .step.cur").dataset.step'), '1');
  await A.fill('#c-aar-plan', '一天做完'); await A.fill('#c-aar-actual', '两天'); await A.fill('#c-aar-why', '低估了'); await A.fill('#c-aar-next', '先列清单');
  await A.fill('#c-cell-core', '报价先给区间'); await A.fill('#c-cell-logic', '降低决策压力'); await A.fill('#c-cell-method', '三档报价');
  await A.click('[data-act="card-save"]');
  assert.equal(await A.text('#card-stage'), '草稿');
  await A.fill('#c-cell-boundary', '大客户不适用');
  await A.click('[data-act="card-save"]');
  assert.equal(await A.text('#card-stage'), '待讲');
  assert.equal(await A.eval('document.querySelector(".stepper .step.cur").dataset.step'), '2');
});

await t('3 首页到记下一句 ≤ 2 次点击；没在专注时进散块盒；散块升级成新拼块后拼图多一块', async () => {
  await A.hash('#/');
  A.clicks = 0;
  await A.click('#fab');
  assert.equal(await A.eval('document.activeElement.id'), 'note-text', '输入框自动聚焦');
  await A.fill('#note-text', '临时想到：报价单要加一个学期套餐');
  await A.click('#note-save');
  assert.equal(A.clicks, 2);
  const n = await A.eval('PP.live("note").find(n => n.text.startsWith("临时想到"))');
  assert.equal(n.pieceId, null);
  const before = await A.eval(`PP.live("piece").filter(p => p.puzzleId === "${mainId}").length`);
  await A.hash('#/scatter');
  await A.click('[data-act="scatter-upgrade"]');
  await A.click(`[data-act="upgrade-to"][data-pz="${mainId}"]`);
  assert.equal(await A.eval(`PP.live("piece").filter(p => p.puzzleId === "${mainId}").length`), before + 1);
  assert.equal(await A.eval('PP.live("note").filter(n => !n.pieceId).length'), 0);
});

await t('4 断网后刷新能打开、能记一条；恢复网络后自动同步到仓库', async () => {
  await A.waitFor('!!navigator.serviceWorker.controller', 20000, '离线缓存就绪').catch(async e => {
    const why = await A.eval(`navigator.serviceWorker.getRegistration().then(r => JSON.stringify({ reg: !!r, installing: r?.installing?.state, waiting: r?.waiting?.state, active: r?.active?.state, ctrl: !!navigator.serviceWorker.controller }))`);
    throw new Error(e.message + ' ' + why);
  });
  await A.eval('PP.syncNow()');
  await A.offline(true);
  gh.setDown(true);
  await server.kill(); // 连本地网页服务也关掉，证明是离线缓存在提供页面
  await A.reload();
  assert.match(await A.text('#sync-badge'), /离线/);
  await A.click('#fab');
  await A.fill('#note-text', '断网时记的一句');
  await A.click('#note-save');
  assert.ok(await A.eval('PP.live("note").some(n => n.text === "断网时记的一句")'));
  assert.ok(!(gh.data()?.records || []).some(r => r.text === '断网时记的一句'));
  await serveAgain();
  gh.setDown(false);
  await A.offline(false);
  await A.eval('dispatchEvent(new Event("online"))');
  const end = Date.now() + 10000;
  while (!(gh.data()?.records || []).some(r => r.text === '断网时记的一句')) {
    if (Date.now() > end) throw new Error('恢复网络后没有自动同步');
    await sleep(200);
  }
});

const B = await newPage(cdp, { width: 1366, height: 768, mobile: false });
await t('5 手机和电脑：各改不同记录、同时改同一条、制造 409 冲突，最终两边完全一致', async () => {
  await B.goto(ORIGIN);
  await B.eval(SYNC_CFG('电脑'));
  await B.reload();
  await B.eval('PP.syncNow()');
  await B.waitFor('PP.live("puzzle").length === 2', 8000, '电脑拉到手机的数据');
  await A.eval('PP.syncNow()');
  await A.eval(`(async () => { await PP.save(PP.C && { id: 'note-a', type: 'note', text: '手机记的', at: Date.now(), pieceId: null, createdAt: Date.now() }); })()`);
  await B.eval(`(async () => { await PP.save({ id: 'note-b', type: 'note', text: '电脑记的', at: Date.now(), pieceId: null, createdAt: Date.now() }); })()`);
  await A.eval(`(async () => { const p = PP.get("${mainId}"); p.value = '手机先改'; await PP.save(p); })()`);
  await sleep(30);
  await B.eval(`(async () => { const p = PP.get("${mainId}"); p.value = '电脑后改'; await PP.save(p); })()`);
  await A.eval('PP.syncNow()'); await B.eval('PP.syncNow()');
  gh.forceConflict(1);
  await B.eval(`(async () => { await PP.save({ id: 'note-c', type: 'note', text: '冲突时记的', at: Date.now(), pieceId: null, createdAt: Date.now() }); })()`);
  const c0 = gh.stats.conflicts;
  await B.eval('PP.syncNow()');
  assert.ok(gh.stats.conflicts > c0, '确实撞上了冲突');
  await A.eval('PP.syncNow()');
  const dump = p => p.eval('PP.DB.allRecords().then(rs => rs.sort((a, b) => a.id < b.id ? -1 : 1).map(r => PP.C.stableStringify(r)).join("\\n"))');
  const [da, db] = [await dump(A), await dump(B)];
  assert.equal(da, db, '两边数据不一致');
  assert.equal(await A.eval(`PP.get("${mainId}").value`), '电脑后改');
  for (const id of ['note-a', 'note-b', 'note-c']) assert.ok(await A.eval(`!!PP.get("${id}")`), id);
  // 电脑上能看到手机拍的证据图
  await B.hash('#/piece/' + firstPiece);
  await B.waitFor('document.querySelector(".evi img")?.src.startsWith("blob:")', 8000, '电脑上显示手机的证据图片');
});

await t('6 专注计时：时间往回拨 30 分钟显示正确；超过 2 小时自动结束并按 2 小时记', async () => {
  const pid = await A.eval(`PP.live("piece").find(p => p.puzzleId === "${mainId}" && p.status !== "done").id`);
  await A.hash('#/piece/' + pid);
  await A.click('[data-act="focus-start"]');
  await A.eval(`(async () => { const f = PP.live("focus").find(f => !f.end); f.start -= 30 * 60000; await PP.save(f); PP.render(); })()`);
  await sleep(1100);
  assert.match(await A.text('[data-clock]'), /^0:30:0\d$/);
  await A.click('[data-act="focus-end"]');
  assert.match(await A.text('#view'), /专注 30 分钟/);
  await A.click('[data-act="focus-start"]');
  const fid = await A.eval(`(async () => { const f = PP.live("focus").find(f => !f.end); f.start -= 3 * 3600000; await PP.save(f); return f.id; })()`);
  await A.waitFor('!PP.live("focus").some(f => !f.end)', 4000, '自动结束');
  const last = await A.eval(`PP.get("${fid}")`);
  assert.equal(last.end - last.start, 2 * 3600000);
});

await t('7 周回顾六步按顺序；预测 4 块、拼上 3 块其中 2 块在预测里 → 命中率 50%', async () => {
  await A.eval(`(async () => {
    const wk = PP.C.weekKey(), now = Date.now(), recs = [];
    const pz = { id: 'pz-rv', type: 'puzzle', lane: 'paused', name: '回顾用', createdAt: now };
    recs.push(pz);
    for (const i of [1, 2, 3, 4, 5]) recs.push({ id: 'rv' + i, type: 'piece', puzzleId: 'pz-rv', name: '回顾块' + i, order: i, status: [1, 2, 5].includes(i) ? 'done' : 'empty', doneAt: [1, 2, 5].includes(i) ? now : null, evidence: [] });
    recs.push({ id: 'pred-rv', type: 'predict', week: wk, pieceIds: ['rv1', 'rv2', 'rv3', 'rv4'], createdAt: now });
    await PP.save(...recs);
  })()`);
  await A.eval(`(async () => { for (const n of PP.live("note").filter(n => !n.pieceId)) { n.deleted = true; await PP.save(n); } })()`);
  await A.eval('(async () => { const n = { id: "scatter-rv", type: "note", text: "回顾前的散块", at: Date.now(), pieceId: null }; await PP.save(n); })()');
  await A.hash('#/review');
  assert.equal(await A.text('#hit-rate'), '50%');
  await A.click('#review-next');
  assert.equal(await A.eval('document.querySelector("#review-step").dataset.step'), '1');
  assert.equal(await A.eval('document.querySelector("#review-next").disabled'), true, '散块没清空不能下一步');
  await A.click('[data-act="scatter-del"]');
  assert.equal(await A.eval('document.querySelector("#review-next").disabled'), false);
  await A.click('#review-next');
  const quiz = await A.eval('PP.live("review")[0].quiz.length');
  const pool = await A.eval('PP.live("card").filter(c => c.stage !== "draft" && PP.C.cellsComplete(c.cells)).length');
  assert.equal(quiz, Math.min(5, pool));
  if (quiz) {
    assert.equal(await A.eval('document.querySelector("#review-next").disabled'), true, '没自评不能下一步');
    await A.click('[data-act="quiz-reveal"]');
    await A.click('[data-act="quiz-rate"][data-r="vague"]');
  }
  await A.click('#review-next');
  await A.click('#review-next');
  await A.click('#review-next');
  assert.equal(await A.eval('document.querySelector("#review-step").dataset.step'), '5');
  await A.click('[data-act="predict-toggle"]');
  assert.equal(await A.eval(`PP.live("predict").find(p => p.week === PP.C.nextWeekKey()).pieceIds.length`), 1);
  await A.click('#review-next');
  assert.match(await A.text('#view'), /本周回顾已完成/);
  assert.match(await A.text('#view'), /预测命中率/);
});

await t('8 导出 → 新设备导入 → 记录、图片一致；导出文件里没有令牌', async () => {
  await A.hash('#/settings');
  await A.click('[data-act="export"]');
  const json = await A.eval('JSON.stringify(window.__lastExport)');
  assert.ok(!json.includes('tk-test'), '导出文件里有令牌');
  assert.ok(JSON.parse(json).files.length >= 1, '导出带上了图片');
  const D = await newPage(cdp);
  await D.goto(ORIGIN);
  await D.eval(`PP.importData(${json})`);
  const dump = p => p.eval('PP.DB.allRecords().then(rs => rs.sort((a, b) => a.id < b.id ? -1 : 1).map(r => PP.C.stableStringify(r)).join("\\n"))');
  assert.equal(await dump(D), await dump(A));
  const files = p => p.eval('PP.DB.allFiles().then(fs => fs.map(f => f.id + ":" + f.size).sort().join(","))');
  assert.equal(await files(D), await files(A));
  await D.s('Target.closeTarget', { targetId: (await D.s('Target.getTargetInfo')).targetInfo.targetId }).catch(() => { });
});

const PAGES = async p => ['#/', '#/puzzles', '#/puzzle/' + mainId, '#/piece/' + firstPiece, '#/scatter', '#/cards',
  '#/card/' + await p.eval('PP.live("card")[0]?.id'), '#/review', '#/settings', '#/new-puzzle'];
await t('9 412×915 和 1366×768 下所有页面没有横向滚动', async () => {
  for (const [p, label] of [[A, '手机'], [B, '电脑']]) {
    if (p === B) await B.eval('PP.syncNow()');
    for (const h of await PAGES(p)) {
      await p.hash(h);
      const over = await p.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      assert.ok(over <= 0, `${label} ${h} 横向多出 ${over}px`);
    }
  }
});

await t('10 抽卡：有 7 张卡时抽 5 张不重复，3 张时抽 3 张', async () => {
  assert.equal(await A.eval('new Set(PP.C.sample([1,2,3,4,5,6,7], 5)).size'), 5);
  assert.equal(await A.eval('PP.C.sample([1,2,3], 5).length'), 3);
});

// ---------- v1.2：电脑自动入账、扫码开同步、关联工单 ----------

const AUTO_SUGGEST = (id, pieceId) => JSON.stringify({ id, type: 'auto', kind: 'suggest', pieceId, ref: 'T900', text: 'T900 假任务 已待验收',
  evidence: [{ kind: 'link', text: 'R1 报告', url: 'D:\\假路径\\R1-REPORT.md' }], dismissed: false, createdAt: 1 });

await t('12 首页顺序：可以拼上 → 今天做这几块 → 主线一行 → 今天电脑上做了', async () => {
  const pid = await A.eval(`PP.live("piece").find(p => p.puzzleId === "${mainId}" && p.status !== "done").id`);
  await A.eval(`(async () => {
    await PP.save(${AUTO_SUGGEST('auto-sg-1', pid)}, { id: 'auto-day-1', type: 'auto', kind: 'day', day: PP.C.dayStr(), project: 'demo', projectName: '假项目', lines: ['T900 假任务：执行中 → 待验收', '提交 2 次：甲；乙'], refs: ['T900'], createdAt: Date.now() });
    location.hash = '#/'; PP.render();
  })()`);
  const order = await A.eval(`['.suggest', '#home-today', '#home-main', '#home-auto'].map(s => document.querySelector(s)?.getBoundingClientRect().top ?? -1)`);
  assert.ok(order.every(v => v >= 0), '四节都要在：' + order);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序不对：' + order);
});

await t('13 建议点「拼上」：证据带进拼块、进经验卡、建议不再显示；「忽略」只标记', async () => {
  const pid = await A.eval('PP.get("auto-sg-1").pieceId');
  await A.click('[data-act="suggest-place"]');
  await A.waitFor('location.hash.startsWith("#/card/")', 5000, '拼上后进入经验卡');
  assert.equal(await A.eval(`PP.get("${pid}").status`), 'done');
  assert.ok(await A.eval(`PP.get("${pid}").evidence.some(e => e.url.includes("R1-REPORT"))`), '证据没带进拼块');
  assert.equal(await A.eval('PP.get("auto-sg-1").dismissed'), true);
  const other = await A.eval(`PP.live("piece").find(p => p.puzzleId === "${mainId}" && p.status !== "done").id`);
  await A.eval(`(async () => { await PP.save(${AUTO_SUGGEST('auto-sg-2', other)}); location.hash = '#/'; PP.render(); })()`);
  await A.click('[data-act="suggest-dismiss"]');
  await A.waitFor('!document.querySelector(".suggest")', 3000, '忽略后不显示');
  assert.equal(await A.eval('PP.get("auto-sg-2").dismissed'), true);
  assert.equal(await A.eval(`PP.get("${other}").status`), 'empty', '忽略不应拼上');
  await A.hash('#/piece/' + pid);
  assert.match(await A.text('#evidence'), /R1-REPORT/);
});

await t('14 拼块关联工单：填「t027 T031 别的」存成 T027、T031', async () => {
  const pid = await A.eval(`PP.live("piece").find(p => p.puzzleId === "${mainId}" && p.status !== "done").id`);
  await A.hash('#/piece/' + pid);
  await A.click('[data-act="edit-refs"]');
  await A.fill('#refs-in', 't027 T031 别的');
  await A.click('[data-act="refs-save"]');
  assert.deepEqual(await A.eval(`PP.get("${pid}").refs`), ['T027', 'T031']);
  assert.match(await A.text('#piece-refs'), /T027、T031/);
});

await t('15 扫码进来：令牌从地址栏抹掉、保存、同步拉到数据；电脑上能显示二维码', async () => {
  const E = await newPage(cdp);
  await E.goto(ORIGIN);
  await E.eval(`localStorage.setItem('pp.cfg', JSON.stringify({ repo: 'me/data', api: ${JSON.stringify(gh.api)}, device: '平板' }))`);
  await E.s('Page.navigate', { url: ORIGIN + '?pair#/pair/tk-test' });
  await E.waitFor('!!window.PP && JSON.parse(localStorage.getItem("pp.cfg")).token === "tk-test"', 15000, '扫码后保存令牌');
  assert.ok(!(await E.eval('location.href')).includes('tk-test'), '地址栏里还有令牌');
  await E.waitFor('PP.live("puzzle").length >= 1', 10000, '扫码后同步拉到数据');
  assert.equal(await E.eval('location.hash'), '#/');
  await E.s('Target.closeTarget', { targetId: (await E.s('Target.getTargetInfo')).targetInfo.targetId }).catch(() => { });
  await A.hash('#/settings');
  await A.click('[data-act="pair-show"]');
  await A.waitFor('!!document.querySelector("#pair-qr svg.qr path")', 5000, '二维码');
  assert.ok((await A.eval('document.querySelector("#pair-qr path").getAttribute("d").length')) > 1000, '二维码内容太少');
  await A.eval('document.querySelector(".modal-wrap").remove()');
});

await t('页面没有报错', async () => {
  const all = [...A.logs, ...B.logs].filter(l => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|net::/.test(l));
  assert.deepEqual(all, []);
});

// ---------- 截图（虚构的演示数据） ----------

console.log('截图');
await t('11 张截图', async () => {
  const P = await newPage(cdp);
  await P.goto(ORIGIN);
  await P.eval(`(async () => {
    const now = Date.now(), H = 3600000, recs = [];
    const pz = { id: 'demo', type: 'puzzle', lane: 'main', name: '独立站上线拿到第一单', deliverable: '第一位海外客户下单并完成付款',
      deadline: PP.C.dayStr(now + 26 * 86400000), acceptor: '第一位付款客户', value: '首单 $120，验证选品', stopRule: '连续 2 周没有任何外部反馈',
      leads: [{ id: 'l1', name: '每周联系 5 位潜在买家', target: 5 }, { id: 'l2', name: '每周发 3 条产品短视频', target: 3 }],
      ifThens: ['如果有人临时找我做别的，我就先记进散块盒，主线 2 小时做完再处理', '如果卡在技术问题超过半天，我就先做不依赖它的块', '如果刷手机超过 15 分钟，我就打开拼图看今天的块'],
      createdAt: now - 9 * 86400000 };
    const side = { id: 'demo2', type: 'puzzle', lane: 'side', name: '短视频课第一期招生', deliverable: '10 位学员报名', deadline: PP.C.dayStr(now + 40 * 86400000),
      acceptor: '报名学员', value: '¥9800', stopRule: '连续 2 周没有任何外部反馈', leads: [{ id: 'l3', name: '每周发 2 篇招生图文', target: 2 }, { id: 'l4', name: '每周 1 次直播', target: 1 }],
      ifThens: ['如果…', '如果…', '如果…'], createdAt: now - 5 * 86400000 };
    recs.push(pz, side);
    const names = ['选品清单', '供应商报价单', '店铺首页', '三款产品详情页', '第一条推广视频', '支付测试订单', '第一位买家询盘', '第一笔订单', '买家评价'];
    names.forEach((name, i) => recs.push({ id: 'dp' + i, type: 'piece', puzzleId: 'demo', name, order: i + 1, status: i < 4 ? 'done' : 'empty',
      doneAt: i < 4 ? now - (8 - i * 2) * 86400000 : null, today: i === 4 || i === 5 ? PP.C.dayStr() : '',
      evidence: i < 4 ? [{ id: 'e' + i, kind: 'link', url: 'https://example.com/' + i, note: name + '链接', at: now - 86400000 }] : [] }));
    ['课程大纲', '招生海报', '报名表'].forEach((name, i) => recs.push({ id: 'sp' + i, type: 'piece', puzzleId: 'demo2', name, order: i + 1, status: i < 1 ? 'done' : 'empty', doneAt: i < 1 ? now - 86400000 : null, evidence: [] }));
    recs.push({ id: 'f0', type: 'focus', pieceId: 'dp4', start: now - 50 * 60000, end: null, planned: 2 * H });
    recs.push({ id: 'f1', type: 'focus', pieceId: 'dp3', start: now - 30 * H, end: now - 28.5 * H, planned: 2 * H });
    recs.push({ id: 'n1', type: 'note', text: '开头 3 秒要直接展示产品使用场景', at: now - 20 * 60000, pieceId: 'dp4' });
    recs.push({ id: 'n2', type: 'note', text: '背景音乐换成无版权的', at: now - 40 * 60000, pieceId: 'dp4' });
    recs.push({ id: 'n3', type: 'note', text: '朋友找我帮忙改简历', at: now - 3 * H, pieceId: null });
    recs.push({ id: 'n4', type: 'note', text: '看到一个新的 AI 剪辑工具，想试试', at: now - 5 * H, pieceId: null });
    for (let k = 0; k < 3; k++) recs.push({ id: 'lt' + k, type: 'leadtap', puzzleId: 'demo', leadId: 'l1', at: now - k * H });
    recs.push({ id: 'lt9', type: 'leadtap', puzzleId: 'demo', leadId: 'l2', at: now - H });
    recs.push({ id: 'c1', type: 'card', pieceId: 'dp3', puzzleId: 'demo', title: '详情页先写买家顾虑再写卖点', stage: 'carded',
      aar: { plan: '半天写完三页', actual: '用了一天半', why: '每页都在纠结卖点顺序', next: '先列买家的 5 个顾虑，按顾虑写' },
      cells: { core: '详情页回答的是买家的顾虑，不是我的卖点', logic: '买家犹豫是因为有疑问，疑问被回答才会下单', method: '列 5 个顾虑 → 每个顾虑配一张图一句话 → 最后放保障', boundary: '冲动型低价小商品不需要这么写' }, versions: [], gaps: '' });
    recs.push({ id: 'c2', type: 'card', pieceId: 'dp1', puzzleId: 'demo', title: '找供应商先问起订量', stage: 'library', aar: {}, cells: { core: '起订量决定能不能小批量试', logic: '', method: '', boundary: '' } });
    recs.push({ id: 'c3', type: 'card', pieceId: 'dp2', puzzleId: 'demo', title: '店铺首页只放一款主推', stage: 'draft', aar: {}, cells: { core: '首页聚焦一款，转化更高' } });
    await PP.save(...recs);
    PP.render();
  })()`);
  await P.hash('#/'); await P.shot('home');
  // 电脑自动入账的两种记录
  await P.eval(`(async () => {
    const now = Date.now(), day = PP.C.dayStr();
    await PP.save(
      { id: 'auto-s-demo', type: 'auto', kind: 'suggest', pieceId: 'dp5', ref: 'T901', text: 'T901 支付通道联调 已待验收', evidence: [{ kind: 'link', text: 'R1 报告', url: 'D:\\\\示例\\\\T901\\\\R1-REPORT.md' }], dismissed: false, createdAt: now },
      { id: 'auto-d-demo1', type: 'auto', kind: 'day', day, project: 'shop', projectName: '独立站', lines: ['T901 支付通道联调：执行中 → 待验收', '提交 4 次：接入测试支付；修复回调签名；补退款流程', '和 Claude 聊了 1 段：支付回调排查'], refs: ['T901'], createdAt: now },
      { id: 'auto-d-demo2', type: 'auto', kind: 'day', day, project: 'course', projectName: '短视频课', lines: ['T902 招生海报：待执行 → 执行中', '提交 2 次：海报三版', '和 Claude 聊了 2 段：课程定价；海报文案', '提交 1 次：报名表字段'], refs: ['T902'], createdAt: now });
    PP.render();
  })()`);
  await P.size(412, 860, true); await P.hash('#/'); await P.eval('PP.render()'); await P.shot('home-auto');
  const fold = await P.eval('({ today: document.querySelector("#home-today").getBoundingClientRect().top, main: document.querySelector("#home-main").getBoundingClientRect().bottom, h: innerHeight })');
  assert.ok(fold.today < fold.h && fold.main <= fold.h, '412×860 第一屏看不全今天和主线：' + JSON.stringify(fold));
  await P.size(412, 915, true);
  // 落位动画定格在飞入途中
  await P.eval(`(() => { const st = window.setTimeout; window.setTimeout = (fn, ms, ...a) => (ms >= 2000 ? 0 : st(fn, ms, ...a)); document.querySelector('[data-act="suggest-place"]').click(); })()`);
  await sleep(150);
  await P.eval('document.getAnimations().forEach(a => { a.pause(); a.currentTime = 1000; })');
  const { data: placed } = await P.s('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, 'suggest-place.png'), Buffer.from(placed, 'base64'));
  await P.reload();
  await P.hash('#/piece/dp6'); await P.eval(`(async () => { const p = PP.get('dp6'); p.refs = ['T903']; await PP.save(p); PP.render(); })()`); await P.shot('piece-refs');
  await P.eval(`localStorage.setItem('pp.cfg', JSON.stringify({ repo: 'Daxuecmd/puzzle-progress-data', token: 'tk-demo', api: 'http://127.0.0.1:9', device: '电脑' }))`);
  await P.hash('#/settings'); await P.eval('PP.render()'); await P.click('[data-act="pair-show"]'); await P.waitFor('!!document.querySelector("#pair-qr svg")'); await P.shot('pair-qr');
  await P.eval('document.querySelector(".modal-wrap").remove()');
  await P.hash('#/puzzle/demo'); await P.shot('puzzle');
  // 四种动效模型各一张拼图页（等亮出动画走完），再来一张设置里的选择
  for (const m of ['dawn', 'tide', 'stars', 'still']) {
    await P.eval(`localStorage.setItem('pp.motion', '${m}'); PP.state.ui.looked = new Set(['demo']); PP.render()`);
    await sleep(900); await P.shot('motion-' + m);
  }
  await P.eval(`localStorage.setItem('pp.motion', 'dawn')`);
  await P.hash('#/settings'); await P.eval('PP.render(); document.querySelector("#motion").scrollIntoView()'); await sleep(600); await P.shot('settings-motion');
  await P.hash('#/piece/dp3'); await P.eval('document.querySelector("#evidence").scrollIntoView()'); await P.shot('piece-evidence');
  await P.hash('#/'); await P.click('#fab'); await P.fill('#note-text', '买家问能不能发 UPS'); await P.shot('note-quick');
  await P.eval('document.querySelector(".modal-wrap").remove()');
  await P.hash('#/scatter'); await P.shot('scatter-box');
  await P.hash('#/card/c1'); await P.eval('PP.state.ui.cardStep.c1 = 1; PP.render()'); await P.shot('card-steps');
  await P.eval('PP.state.ui.cardStep.c1 = 2; PP.render()'); await P.shot('card-feynman');
  await P.hash('#/review'); await P.shot('review');
  await P.eval(`localStorage.setItem('pp.cfg', JSON.stringify({ repo: 'Daxuecmd/puzzle-progress-data', token: '', device: '手机' }))`);
  await P.hash('#/settings'); await P.eval('document.querySelector("details").open = true'); await P.shot('settings-sync');
  await P.offline(true); await P.eval('dispatchEvent(new Event("offline"))'); await P.hash('#/'); await P.eval('PP.render()'); await P.shot('offline');
  await P.offline(false);
  await P.size(1366, 768, false); await P.hash('#/puzzle/demo'); await P.eval('PP.render()'); await P.shot('pc-1366');
  for (const n of ['home', 'home-auto', 'suggest-place', 'piece-refs', 'pair-qr', 'puzzle', 'motion-dawn', 'motion-tide', 'motion-stars', 'motion-still', 'settings-motion', 'piece-evidence', 'note-quick', 'scatter-box', 'card-steps', 'card-feynman', 'review', 'settings-sync', 'offline', 'pc-1366']) {
    assert.ok(fs.existsSync(path.join(SHOTS, n + '.png')), n);
  }
});

close();
await gh.close();
await server2?.kill();
console.log(`\n浏览器自测：通过 ${pass}，失败 ${fail}${failures.length ? '（' + failures.join('；') + '）' : ''}`);
process.exit(fail ? 1 : 0);
