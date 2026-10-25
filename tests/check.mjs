// 数据层自测：node tests/check.mjs
import assert from 'node:assert/strict';
import * as C from '../core.js';
import * as S from '../sync.js';
import { mockGitHub } from './mock-github.mjs';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); }
}

const rec = (id, updatedAt, extra = {}) => ({ id, type: 'note', updatedAt, text: id + '@' + updatedAt, ...extra });

console.log('合并规则');
await t('只在一边的记录都保留', () => {
  const m = C.mergeRecords([rec('a', 1)], [rec('b', 1)]);
  assert.deepEqual(m.map(r => r.id), ['a', 'b']);
});
await t('同一条记录后改的胜（本机新）', () => {
  const m = C.mergeRecords([rec('a', 5)], [rec('a', 3)]);
  assert.equal(m[0].updatedAt, 5);
});
await t('同一条记录后改的胜（云端新）', () => {
  const m = C.mergeRecords([rec('a', 3)], [rec('a', 9)]);
  assert.equal(m[0].updatedAt, 9);
});
await t('删除标记也按时间比较：后删的胜', () => {
  const m = C.mergeRecords([rec('a', 4, { deleted: true })], [rec('a', 3)]);
  assert.equal(m[0].deleted, true);
  const m2 = C.mergeRecords([rec('a', 4, { deleted: true })], [rec('a', 6)]);
  assert.ok(!m2[0].deleted);
});
await t('两边同一时刻改了同一条：两台设备合并结果相同', () => {
  const x = rec('a', 7, { text: '手机' }), y = rec('a', 7, { text: '电脑' });
  const m1 = C.mergeRecords([x], [y]), m2 = C.mergeRecords([y], [x]);
  assert.ok(C.sameRecords(m1, m2));
});
await t('合并满足交换律（随机数据 200 轮）', () => {
  for (let k = 0; k < 200; k++) {
    const gen = () => Array.from({ length: 6 }, () => rec('r' + Math.floor(Math.random() * 8), Math.floor(Math.random() * 5), { text: String(Math.random() < .5) }));
    const a = gen(), b = gen();
    assert.ok(C.sameRecords(C.mergeRecords(a, b), C.mergeRecords(b, a)));
  }
});

console.log('编码与导出');
await t('中文和图片字节来回编码不变', () => {
  const s = '拼图推进 ✓ emoji 🧩';
  assert.equal(C.b64ToUtf8(C.utf8ToB64(s)), s);
  const bytes = new Uint8Array(100000).map((_, i) => (i * 37) % 256);
  assert.deepEqual(C.b64ToBytes(C.bytesToB64(bytes)), bytes);
});

console.log('规则');
await t('拼图五项必填 + 2 个引领动作 + 3 条如果就', () => {
  const ok = { deliverable: 'a', deadline: '2026-11-20', acceptor: 'b', value: 'c', stopRule: 'd', leads: [{ name: 'x' }, { name: 'y' }], ifThens: ['1', '2', '3'] };
  assert.deepEqual(C.puzzleMissing(ok), []);
  for (const k of ['deliverable', 'deadline', 'acceptor', 'value', 'stopRule']) assert.equal(C.puzzleMissing({ ...ok, [k]: ' ' }).length, 1, k);
  assert.equal(C.puzzleMissing({ ...ok, leads: [{ name: 'x' }] }).length, 1);
  assert.equal(C.puzzleMissing({ ...ok, ifThens: ['1', '', '3'] }).length, 1);
});
await t('抽卡：7 张抽 5 张不重复，3 张抽 3 张', () => {
  const s = C.sample([1, 2, 3, 4, 5, 6, 7], 5);
  assert.equal(new Set(s).size, 5);
  assert.equal(C.sample([1, 2, 3], 5).length, 3);
});
await t('拼图形状：相邻两块的边完全咬合', () => {
  for (const n of [1, 4, 9, 13, 24]) {
    const J = C.jigsaw(n);
    assert.equal(J.pieces.length, n);
    for (const p of J.pieces) assert.ok(p.d.startsWith('M') && p.d.endsWith('Z'));
  }
});

console.log('指标');
await t('六个指标：预测 4 块、拼上 3 块其中 2 块在预测里 → 命中率 50%', () => {
  const now = new Date('2026-10-25T20:00:00').getTime(); // 周日
  const wk = C.weekKey(now);
  const mon = C.weekStart(now);
  const recs = [
    { id: 'pm', type: 'puzzle', lane: 'main' }, { id: 'ps', type: 'puzzle', lane: 'side' },
    ...['a', 'b', 'c', 'd', 'e'].map(id => ({ id, type: 'piece', puzzleId: 'pm', status: 'empty' })),
  ];
  const piece = id => recs.find(r => r.id === id);
  for (const id of ['a', 'b', 'e']) Object.assign(piece(id), { status: 'done', doneAt: mon + 86400000 });
  piece('a').evidence = [{ kind: 'income', amount: 300 }, { kind: 'link' }];
  recs.push({ id: 'pr', type: 'predict', week: wk, pieceIds: ['a', 'b', 'c', 'd'] });
  recs.push({ id: 'x', type: 'piece', puzzleId: 'ps', status: 'empty' });
  recs.push({ id: 'f1', type: 'focus', pieceId: 'a', start: mon + 3600e3, end: mon + 3 * 3600e3 });
  recs.push({ id: 'f2', type: 'focus', pieceId: 'x', start: mon + 5 * 3600e3, end: mon + 6 * 3600e3 });
  recs.push({ id: 's1', type: 'stopped', action: 'stop', at: mon + 7200e3 });
  recs.push({ id: 's2', type: 'stopped', action: 'change', at: mon + 7200e3 });
  recs.push({ id: 'n1', type: 'note', at: now - 3600e3 }, { id: 'n2', type: 'note', at: now - 3 * 86400000 });
  const m = C.computeMetrics(recs, wk, now);
  assert.equal(m.piecesDone, 3);
  assert.equal(m.predicted, 4);
  assert.equal(m.hits, 2);
  assert.equal(C.pct(m.hitRate), '50%');
  assert.equal(C.pct(m.mainShare), '67%');
  assert.equal(m.stopped, 1);
  assert.equal(m.income, 300);
  assert.equal(m.usageDays14, 3); // 两条随手记各一天 + 周一的专注
  assert.ok(C.metricsText(m, wk).includes('预测命中率：50%'));
});

console.log('同步（对着模拟仓库）');
const gh = await mockGitHub(0, { repo: 'me/data', token: 'tk' });
const cfg = { api: gh.api, repo: 'me/data', token: 'tk' };

function device(name) {
  let recs = [];
  const files = new Map();
  return {
    name, get recs() { return recs; },
    set(r) { recs = C.mergeRecords(recs, [r]); },
    sync: () => S.syncOnce(cfg, {
      device: name,
      localRecords: async () => recs,
      saveLocal: async m => { recs = m; },
      pendingFiles: async () => [...files.values()].filter(f => !f.synced),
      markFileSynced: async id => { files.get(id).synced = true; },
    }),
    addFile(id, bytes) { files.set(id, { id, blob: new Blob([bytes]), synced: false }); },
  };
}

await t('令牌错误给中文原因', async () => {
  await assert.rejects(S.testConnection({ ...cfg, token: 'bad' }), e => e.code === 'auth' && /令牌/.test(e.message));
});
await t('仓库不存在给中文原因', async () => {
  await assert.rejects(S.pull({ ...cfg, repo: 'me/none' }), e => e.code === 'missing');
});
await t('网络不通给中文原因', async () => {
  await assert.rejects(S.pull({ ...cfg, api: 'http://127.0.0.1:1' }), e => e.code === 'network' && /网络/.test(e.message));
});
await t('测试连接能认出私有仓库', async () => {
  assert.deepEqual(await S.testConnection(cfg), { private: true, name: 'me/data' });
});

const phone = device('手机'), pc = device('电脑');
await t('空仓库首次同步：手机推上去，电脑拉下来', async () => {
  phone.set(rec('n1', 10));
  phone.addFile('img1.jpg', new Uint8Array([1, 2, 3, 250]));
  await phone.sync();
  assert.equal(gh.data().records.length, 1);
  assert.deepEqual([...gh.files.get('files/img1.jpg').bytes], [1, 2, 3, 250]);
  await pc.sync();
  assert.ok(C.sameRecords(pc.recs, phone.recs));
});
await t('两边各改不同记录、同时改同一条：同步后完全一致，同一条以后改的为准', async () => {
  phone.set(rec('n2', 20));
  pc.set(rec('n3', 21));
  phone.set(rec('n1', 30, { text: '手机后改' }));
  pc.set(rec('n1', 25, { text: '电脑先改' }));
  await phone.sync(); await pc.sync(); await phone.sync();
  assert.ok(C.sameRecords(pc.recs, phone.recs));
  assert.ok(C.sameRecords(gh.data().records, phone.recs));
  assert.equal(phone.recs.find(r => r.id === 'n1').text, '手机后改');
  assert.equal(phone.recs.length, 3);
});
await t('推送时撞上冲突（409）会重拉重推，最终一致', async () => {
  pc.set(rec('n4', 40));
  gh.forceConflict(2);
  const before = gh.stats.conflicts;
  await pc.sync();
  assert.equal(gh.stats.conflicts - before, 2);
  await phone.sync();
  assert.ok(C.sameRecords(pc.recs, phone.recs));
  assert.ok(phone.recs.some(r => r.id === 'n4'));
});
await t('连续冲突超过 3 次报中文错误', async () => {
  pc.set(rec('n5', 50));
  gh.forceConflict(10);
  await assert.rejects(pc.sync(), e => e.code === 'conflict');
  gh.forceConflict(-10);
  await pc.sync();
});
await t('没有变化时不重复推送', async () => {
  await phone.sync();
  const puts = gh.stats.puts;
  await phone.sync();
  assert.equal(gh.stats.puts, puts);
});
await t('超过 1MB 的数据也能拉回来', async () => {
  const big = 'x'.repeat(1200);
  for (let i = 0; i < 1000; i++) phone.set(rec('big' + i, 60, { text: big }));
  await phone.sync();
  // 模拟真接口：超过 1MB 时不带正文
  const f = gh.files.get('data.json');
  assert.ok(f.bytes.length > 1024 * 1024);
  const realGet = await S.pull(cfg);
  assert.equal(realGet.records.length, phone.recs.length);
});
await gh.close();

console.log('电脑自动入账与动效模型（v1.2）');
const Mo = await import('../motion.js');
await t('电脑自动记的不算进任何指标；在 App 里处理过建议的那天算用过', () => {
  const now = Date.now(), wk = C.weekKey(now);
  const base = [{ id: 'n', type: 'note', at: now, text: 'x' }];
  const autos = [
    { id: 'a1', type: 'auto', kind: 'day', day: C.dayStr(now), lines: ['x'], createdAt: now, at: now },
    { id: 'a2', type: 'auto', kind: 'suggest', pieceId: 'p', dismissed: false, createdAt: now },
  ];
  assert.deepEqual(C.computeMetrics([...base, ...autos], wk, now), C.computeMetrics(base, wk, now));
  const y = now - 86400000;
  const m = C.computeMetrics([...base, { ...autos[1], dismissed: true, dismissedAt: y }], wk, now);
  assert.equal(m.usageDays14, 2);
});
await t('四种动效模型都能画；潮汐水位随进度升高；星图星星数 = 拼上的块数', () => {
  const done = n => Array.from({ length: n }, (_, i) => ({ i, at: i, cx: (i % 3) * 100 + 50, cy: Math.floor(i / 3) * 100 + 50 }));
  for (const m of Mo.MODELS) {
    const s = Mo.scene(m.id, 'seed', 300, 300, 'u', { p: 0.5, u: 0.3, focus: true, newest: -1, done: done(4) });
    assert.ok(s.body.length > 200 && s.defs.length > 50, m.id);
  }
  const lv = p => Number(Mo.scene('tide', 'seed', 300, 300, 'u', { p, u: 0, done: [] }).body.match(/class="m-wave back"[^>]*d="M[-\d.]+ ([\d.]+)/)[1]);
  assert.ok(lv(0.8) < lv(0.2), '水位应随进度升高');
  const st = Mo.scene('stars', 'seed', 300, 300, 'u', { p: 0.5, u: 0, done: done(5) });
  assert.equal((st.body.match(/class="m-star/g) || []).length, 5);
  assert.equal((st.body.match(/class="m-line/g) || []).length, 4);
});
await t('落后程度：按时为 0，时间过半进度为 0 时明显落后', () => {
  const now = Date.now();
  const pz = { createdAt: now - 10 * 86400000, deadline: C.dayStr(now + 10 * 86400000) };
  assert.equal(Mo.urgency(pz, 0.9, now), 0);
  assert.ok(Mo.urgency(pz, 0, now) > 0.7);
});

console.log(`\n数据层自测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
