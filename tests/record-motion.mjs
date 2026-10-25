// 录四套动效的 15 秒视频（同一个剧本）：node tests/record-motion.mjs <输出目录>
// 剧本：首页 → 挑今天的块 → 记一句 → 拼上一块 → 打开拼图页。用模拟手指点，按下回弹也录得到
// 需要 ffmpeg（环境变量 FFMPEG 或 PATH 里）。只用虚构的示例数据
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from './serve.mjs';

const OUT = path.resolve(process.argv[2] || 'videos');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const PORT = 8795;
const ORIGIN = `http://127.0.0.1:${PORT}/?nosw`;
const MODELS = [['dawn', '晨光'], ['tide', '潮汐'], ['stars', '星图'], ['still', '静物']];
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rec-'));
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise(res => { let b = ''; proc.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); });
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const wait = new Map(), handlers = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    else if (m.method) handlers.forEach(h => h(m));
  });
  const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((res, rej) => wait.set(i, { res, rej })); };
  return { send, on: h => handlers.push(h), close: () => { try { ws.close(); } catch { } proc.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1500); } };
}

const SEED = `(async () => {
  const now = Date.now(), recs = [];
  recs.push({ id: 'demo', type: 'puzzle', lane: 'main', name: '独立站上线拿到第一单', deliverable: 'x', deadline: PP.C.dayStr(now + 26 * 864e5), acceptor: '第一位付款客户', value: 'x', stopRule: 'x', leads: [], ifThens: ['a', 'b', 'c'], createdAt: now - 9 * 864e5 });
  const names = ['选品清单', '供应商报价单', '店铺首页', '三款产品详情页', '第一条推广视频', '支付测试订单', '第一位买家询盘', '第一笔订单', '买家评价'];
  names.forEach((name, i) => recs.push({ id: 'dp' + i, type: 'piece', puzzleId: 'demo', name, order: i + 1, status: i < 4 ? 'done' : 'empty', doneAt: i < 4 ? now - (8 - i * 2) * 864e5 : null, today: '',
    evidence: i < 4 || i === 5 ? [{ id: 'e' + i, kind: 'link', url: 'https://example.com/' + i, note: name, at: now }] : [] }));
  await PP.save(...recs);
})()`;

async function record(send, on, model) {
  // 每段一个独立的浏览器空间，免得上一段记下的数据带进下一段（自查视频时发现四段起点不一样）
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const ev = async e => { const r = await s('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + e.slice(0, 80)); return r.result.value; };
  await s('Page.enable'); await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await s('Page.navigate', { url: ORIGIN });
  for (let k = 0; k < 100 && !(await ev('!!window.PP').catch(() => false)); k++) await sleep(100);
  await ev(SEED);
  await ev(`localStorage.setItem('pp.motion', '${model}'); location.hash = '#/'; PP.render(); 1`);
  await sleep(600);

  const frames = [];
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-frames-${model}-`));
  on(m => {
    if (m.sessionId !== sessionId || m.method !== 'Page.screencastFrame') return;
    const f = path.join(frameDir, String(frames.length).padStart(5, '0') + '.jpg');
    fs.writeFileSync(f, Buffer.from(m.params.data, 'base64'));
    frames.push({ f, t: m.params.metadata.timestamp });
    s('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => { });
  });
  // 手指点：按下 90ms 再抬起，按下回弹录得到
  const tap = async sel => {
    const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error('找不到 ' + sel);
    await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
    await sleep(90);
    await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const type = async text => { for (const ch of text) { await s('Input.insertText', { text: ch }); await sleep(70); } };

  const t0 = Date.now();
  await s('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
  await sleep(1400);                                   // 首页
  await tap('[data-act="pick-today"]'); await sleep(700);
  await tap('[data-act="pick-toggle"][data-id="dp4"]'); await sleep(450);
  await tap('[data-act="pick-toggle"][data-id="dp5"]'); await sleep(500);
  await tap('[data-act="pick-save"]'); await sleep(1300); // 挑块回首页
  await tap('#fab'); await sleep(500);
  await type('买家问能不能发 UPS'); await sleep(300);
  await tap('#note-save'); await sleep(1200);            // 记一句
  await ev(`location.hash = '#/piece/dp5'; 1`); await sleep(900);
  await tap('#place-btn'); await sleep(1700);            // 拼上 → 经验卡
  await ev(`PP.state.ui.looked = new Set(); location.hash = '#/puzzle/demo'; 1`); await sleep(15000 - (Date.now() - t0));
  await s('Page.stopScreencast');
  await sleep(200);
  await send('Target.closeTarget', { targetId });

  // 按真实时间戳拼成 30fps 的视频
  const list = path.join(frameDir, 'list.txt');
  let txt = 'ffconcat version 1.0\n';
  frames.forEach((fr, i) => { const d = i < frames.length - 1 ? Math.max(0.001, frames[i + 1].t - fr.t) : 0.5; txt += `file '${fr.f.replace(/\\/g, '/')}'\nduration ${d.toFixed(4)}\n`; });
  txt += `file '${frames[frames.length - 1].f.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(list, txt);
  const out = path.join(OUT, `motion-${model}.mp4`);
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'scale=412:-2,fps=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', out]);
  if (r.status) throw new Error('ffmpeg 失败：' + r.stderr);
  fs.rmSync(frameDir, { recursive: true, force: true });
  return { out, frames: frames.length, secs: frames.length ? frames[frames.length - 1].t - frames[0].t : 0 };
}

const server = await serve(PORT);
const { send, on, close } = await launch();
const made = [];
for (const [m, name] of MODELS) {
  const r = await record(send, on, m);
  console.log(`  ${name}：${r.frames} 帧，${r.secs.toFixed(1)} 秒 → ${r.out}`);
  made.push([r.out, name]);
}
close();
await server.kill();

// 2×2 并排，每格左上角标名字
const font = 'C\\:/Windows/Fonts/msyhbd.ttc';
const inputs = made.flatMap(([f]) => ['-i', f]);
const label = (i, name) => `[${i}:v]scale=412:-2,pad=412:916:0:0:color=0xF3F4F0,drawtext=fontfile='${font}':text='${name}':x=16:y=16:fontsize=30:fontcolor=white:box=1:boxcolor=0x1D2433CC:boxborderw=10[v${i}]`;
const filter = made.map(([, n], i) => label(i, n)).join(';') + `;[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]`;
const grid = path.join(OUT, 'motion-compare-2x2.mp4');
const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', grid]);
if (r.status) { console.error('并排视频失败：' + r.stderr); process.exit(1); }
console.log('  并排：' + grid);
