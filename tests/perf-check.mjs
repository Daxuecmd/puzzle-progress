// 性能实测（桌面模拟手机）：node tests/perf-check.mjs
// 本机 Edge 无头模式，手机尺寸，CPU 降速 4 倍，四套动效各量一遍：
//   首页、拼图页各 3 秒的帧间隔（p95、掉帧率）和主线程忙碌比例；30 秒无操作后的主线程忙碌比例
// 预算见 docs/motion-spec.md 第七节。真机（一加 13，120Hz）数据要在手机上另测，这里只是替代
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8793;
const ORIGIN = `http://127.0.0.1:${PORT}/?nosw`;
// anim：动画让主线程多忙了多少（开动画 − 关动画，同一次运行里量）
const BUDGET = { p95: 20, dropped: 0.05, anim: 0.3, idleBusy: 0.02 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-perf-'));
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error('Edge 没启动起来')), 30000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } });
  });
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const wait = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } });
  const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((res, rej) => wait.set(i, { res, rej })); };
  return { send, close: () => { try { ws.close(); } catch { } proc.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1500); } };
}

const SEED = `(async () => {
  const now = Date.now(), H = 3600000, recs = [];
  recs.push({ id: 'demo', type: 'puzzle', lane: 'main', name: '示例拼图', deliverable: 'x', deadline: PP.C.dayStr(now + 20 * 864e5), acceptor: '某位客户', value: 'x', stopRule: 'x', leads: [], ifThens: ['a', 'b', 'c'], createdAt: now - 12 * 864e5 });
  for (let i = 0; i < 9; i++) recs.push({ id: 'dp' + i, type: 'piece', puzzleId: 'demo', name: '块' + i, order: i + 1, status: i < 4 ? 'done' : 'empty', doneAt: i < 4 ? now - (9 - i) * 864e5 : null, today: i === 4 || i === 5 ? PP.C.dayStr() : '', evidence: [] });
  recs.push({ id: 'f0', type: 'focus', pieceId: 'dp4', start: now - 50 * 60000, end: null, planned: 2 * H });
  await PP.save(...recs);
})()`;

async function main() {
  const server = await serve(PORT);
  const { send, close } = await launch();
  const results = [];
  let fail = 0;
  for (const model of ['dawn', 'tide', 'stars', 'still']) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const ev = async expr => { const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr.slice(0, 80)); return r.result.value; };
    await s('Page.enable'); await s('Runtime.enable'); await s('Performance.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await s('Emulation.setCPUThrottlingRate', { rate: 4 });
    await s('Page.navigate', { url: ORIGIN });
    for (let k = 0; k < 100 && !(await ev('!!window.PP').catch(() => false)); k++) await sleep(100);
    await ev(SEED);
    await ev(`localStorage.setItem('pp.motion', '${model}'); PP.state.ui.looked = new Set(['demo']); location.hash = '#/'; PP.render(); 1`);
    const busy = async ms => {
      const get = async () => Object.fromEntries((await s('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      const a = await get(); await sleep(ms); const b = await get();
      return (b.TaskDuration - a.TaskDuration) / ((b.Timestamp - a.Timestamp) || ms / 1000);
    };
    const frames = () => ev(`new Promise(res => { const ts = []; const t0 = performance.now(); const f = t => { ts.push(t); if (t - t0 < 3000) requestAnimationFrame(f); else res(ts); }; requestAnimationFrame(f); })`);
    const stat = ts => {
      const d = ts.slice(1).map((t, i) => t - ts[i]).sort((x, y) => x - y);
      const p95 = d[Math.floor(d.length * 0.95)] || 0;
      return { p95: +p95.toFixed(1), dropped: +(d.filter(x => x > 25).length / Math.max(1, d.length)).toFixed(3), fps: +(d.length / 3).toFixed(0) };
    };
    // 本机其他程序会干扰，单次数据跳得厉害：每项量 3 次取中位数
    const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const row = { model };
    for (const [page, hash] of [['首页', '#/'], ['拼图页', '#/puzzle/demo']]) {
      await ev(`location.hash = '${hash}'; 1`); await sleep(1200);
      const runs = [];
      for (let k = 0; k < 5; k++) { const [ts, b] = await Promise.all([frames(), busy(3000)]); runs.push({ ...stat(ts), busy: b }); }
      // 同一次运行里再量一遍「动画全关」，两者相减就是动画本身的开销，本机其他程序的干扰大体抵掉
      await ev(`(() => { const st = document.createElement('style'); st.id = 'perf-off'; st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(st); return 1; })()`);
      const base = [];
      for (let k = 0; k < 3; k++) { const [, b] = await Promise.all([frames(), busy(3000)]); base.push(b); }
      await ev(`document.getElementById('perf-off').remove(), 1`);
      const b0 = med(base), b1 = med(runs.map(r => r.busy));
      row[page] = { p95: med(runs.map(r => r.p95)), dropped: med(runs.map(r => r.dropped)), fps: med(runs.map(r => r.fps)), busy: +b1.toFixed(3), base: +b0.toFixed(3), anim: +Math.max(0, b1 - b0).toFixed(3) };
    }
    await ev('PP.idleNow(); 1'); await sleep(800);
    row.idleBusy = +med([await busy(2000), await busy(2000), await busy(2000)]).toFixed(3);
    results.push(row);
    for (const page of ['首页', '拼图页']) {
      const r = row[page];
      if (r.p95 > BUDGET.p95 || r.dropped > BUDGET.dropped || r.anim > BUDGET.anim) { fail++; console.log(`  ✗ ${model} ${page} 超预算`, r); }
    }
    if (row.idleBusy > BUDGET.idleBusy) { fail++; console.log(`  ✗ ${model} 静止时主线程忙碌 ${row.idleBusy} 超预算`); }
    await send('Target.closeTarget', { targetId });
  }
  console.log('\n性能实测（桌面 Edge 无头、手机尺寸、CPU 降速 4 倍）');
  console.log('模型\t页面\tp95帧间隔ms\t掉帧率\t帧率\t主线程忙碌\t其中动画增加');
  for (const r of results) {
    for (const page of ['首页', '拼图页']) console.log(`${r.model}\t${page}\t${r[page].p95}\t${(r[page].dropped * 100).toFixed(1)}%\t${r[page].fps}\t${(r[page].busy * 100).toFixed(1)}%\t${(r[page].anim * 100).toFixed(1)}%`);
    console.log(`${r.model}\t静止30秒后\t-\t-\t-\t${(r.idleBusy * 100).toFixed(1)}%\t-`);
  }
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'perf.json'), JSON.stringify({ at: new Date().toISOString(), budget: BUDGET, results }, null, 1));
  close();
  await server.kill();
  console.log(`\n性能预算：${fail ? '超出 ' + fail + ' 项' : '全部达标'}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
