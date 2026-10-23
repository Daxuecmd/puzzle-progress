// 线上实测：无头 Edge 打开线上地址，填令牌（只从环境变量 PP_TOKEN 读），同步后应看到私有仓库里的主线拼图
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.env.PP_URL || 'https://daxuecmd.github.io/puzzle-progress/';
const token = process.env.PP_TOKEN;
if (!token) { console.log('没有 PP_TOKEN'); process.exit(1); }
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-live-'));
const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise(res => { let b = ''; proc.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); });
const ws = new WebSocket(wsUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const wait = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }, sessionId);

let ok = true;
try {
  await send('Page.navigate', { url: URL_ }, sessionId);
  for (let i = 0; i < 100 && !(await ev('!!window.PP')); i++) await sleep(150);
  await ev(`localStorage.setItem('pp.cfg', JSON.stringify({ repo: 'Daxuecmd/puzzle-progress-data', token: ${JSON.stringify(token)}, device: '线上实测' }))`);
  const st = await ev('PP.syncNow().then(s => JSON.stringify(s))');
  const main = await ev('PP.live("puzzle").find(p => p.lane === "main")?.name || ""');
  const pieces = await ev('PP.live("piece").length');
  const sw = await ev('navigator.serviceWorker.ready.then(() => "就绪")');
  console.log('同步状态：', st);
  console.log('主线拼图：', main, '· 拼块', pieces);
  console.log('离线缓存：', sw);
  ok = main === '错题本演示谈钱' && pieces === 9;
  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(os.tmpdir(), 'pp-live-home.png'), Buffer.from(data, 'base64'));
  console.log('截图：', path.join(os.tmpdir(), 'pp-live-home.png'));
} finally {
  ws.close(); proc.kill();
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1500);
}
console.log(ok ? '✓ 线上实测通过' : '✗ 线上实测未通过');
process.exit(ok ? 0 : 1);
