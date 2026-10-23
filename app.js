import * as C from './core.js';
import * as DB from './db.js';
import * as S from './sync.js';

export const VERSION = '1.0.0';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOUR2 = 2 * 3600 * 1000;
const DAY = 86400000;

const LANES = { main: '主线', side: '副线', paused: '暂停区', done: '已完成', stopped: '已停止' };
const STAGES = { draft: '草稿', carded: '待讲', told: '已讲', library: '已入库' };
const STAGE_STEP = { draft: 1, carded: 2, told: 3, library: 3 };
const STEPS = [
  ['ACTION 01', '做：2小时专注行动', '不刷碎片，不囤干货。只做能产生结果的事：读书、方案、实践。'],
  ['EXTRACT 02', '卡：30分钟提炼卡片', '核心、逻辑、方法、边界。写不清 = 没学透。'],
  ['FEYNMAN 03', '讲：5-10分钟费曼输出', '不看稿讲清：痛点→原理→步骤→行动。卡壳即是认知漏洞。'],
  ['OPTIMIZE 04', '送：迭代优化资产', '补齐漏点，精简表达。形成个人可复用的知识资产。'],
];
const REVIEW_STEPS = ['对账', '清空散块盒', '抽卡自测', '引领动作', '停止规则检查', '下周预测'];
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: '拼图推进同步',
  description: '拼图推进 App 读写私有数据仓库 puzzle-progress-data',
  target_name: 'Daxuecmd',
  expires_in: '366',
  contents: 'write',
}).toString();

// ================= 状态 =================

const state = { recs: [], byId: new Map(), ui: { cardStep: {}, reveal: {}, pick: new Set() }, sync: { status: 'idle', msg: '' } };

function index() { state.byId = new Map(state.recs.map(r => [r.id, r])); }
const live = type => state.recs.filter(r => r.type === type && !r.deleted);
const get = id => { const r = state.byId.get(id); return r && !r.deleted ? r : null; };
const mk = (type, fields) => ({ id: C.uid(), type, createdAt: Date.now(), updatedAt: 0, ...fields });

async function save(...recs) {
  const now = Date.now();
  for (const r of recs) {
    r.updatedAt = Math.max(now, (r.updatedAt || 0) + 1);
    if (!state.byId.has(r.id)) state.recs.push(r);
    else if (state.byId.get(r.id) !== r) state.recs = state.recs.map(x => (x.id === r.id ? r : x));
    state.byId.set(r.id, r);
  }
  await DB.putRecords(recs);
  scheduleSync();
}

const remove = rec => { rec.deleted = true; return save(rec); };

const puzzlesIn = (...lanes) => live('puzzle').filter(p => lanes.includes(p.lane)).sort((a, b) => a.createdAt - b.createdAt);
const mainPuzzle = () => puzzlesIn('main')[0] || null;
const sidePuzzle = () => puzzlesIn('side')[0] || null;
const piecesOf = pid => live('piece').filter(p => p.puzzleId === pid).sort((a, b) => a.order - b.order);
const notesOf = pieceId => live('note').filter(n => n.pieceId === pieceId).sort((a, b) => b.at - a.at);
const scatterNotes = () => live('note').filter(n => !n.pieceId).sort((a, b) => b.at - a.at);
const cardOf = pieceId => live('card').find(c => c.pieceId === pieceId) || null;
const activeFocus = () => live('focus').find(f => !f.end) || null;
const isToday = p => p.today === C.dayStr() && p.status !== 'done';
const todayPieces = () => live('piece').filter(isToday).filter(p => ['main', 'side'].includes(get(p.puzzleId)?.lane));
const pieceState = p => (p.status === 'done' ? 'done' : isToday(p) || activeFocus()?.pieceId === p.id ? 'doing' : 'empty');
const PIECE_STATE = { empty: '空位', doing: '进行中', done: '已拼上' };

function focusTotal(pieceId) {
  return live('focus').filter(f => f.pieceId === pieceId)
    .reduce((s, f) => s + ((f.end || Math.min(Date.now(), f.start + f.planned)) - f.start), 0);
}

const leadCount = (lead, wk = C.weekKey()) =>
  live('leadtap').filter(t => t.leadId === lead.id && C.weekKey(t.at) === wk).length;

function leadSummary() {
  let done = 0, target = 0;
  for (const pz of [mainPuzzle(), sidePuzzle()].filter(Boolean)) {
    for (const l of pz.leads || []) {
      const t = Number(l.target) || 1;
      target += t;
      done += Math.min(t, leadCount(l));
    }
  }
  return { done, target };
}

function lastFeedbackAt(pz) {
  const ids = new Set(piecesOf(pz.id).map(p => p.id));
  let t = Math.max(pz.createdAt || 0, pz.reviseAt || 0);
  for (const n of live('note')) if (n.feedback && (ids.has(n.pieceId) || n.puzzleId === pz.id)) t = Math.max(t, n.at);
  for (const p of piecesOf(pz.id)) for (const e of p.evidence || []) if (e.kind === 'income') t = Math.max(t, e.at || 0);
  return t;
}
const needsStopCheck = pz => ['main', 'side'].includes(pz.lane) && Date.now() - lastFeedbackAt(pz) > 14 * DAY;

// ================= 配置 =================

const DEFAULT_REPO = 'Daxuecmd/puzzle-progress-data';
function cfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('pp.cfg') || '{}'); } catch { /* 坏数据当空 */ }
  return {
    repo: c.repo || DEFAULT_REPO,
    token: c.token || '',
    device: c.device || (/Android|iPhone/i.test(navigator.userAgent) ? '手机' : '电脑'),
    api: c.api || 'https://api.github.com',
  };
}
const setCfg = patch => localStorage.setItem('pp.cfg', JSON.stringify({ ...cfg(), ...patch }));

// ================= 小工具 =================

function toast(msg, ms = 2200) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function openModal(html) {
  closeModal();
  const w = document.createElement('div');
  w.className = 'modal-wrap';
  w.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  w.addEventListener('click', e => { if (e.target === w) closeModal(); });
  document.body.appendChild(w);
  return w;
}
const setModal = html => { const m = $('.modal'); if (m) m.innerHTML = html; };
const closeModal = () => document.querySelectorAll('.modal-wrap').forEach(m => m.remove());
const modalOpen = () => !!$('.modal-wrap');
const isTyping = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

const fmtTime = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

function daysLeft(deadline) {
  if (!deadline) return '';
  const d = Math.round((new Date(deadline + 'T00:00:00') - new Date(C.dayStr() + 'T00:00:00')) / DAY);
  return d > 0 ? `还剩 ${d} 天` : d === 0 ? '今天截止' : `已过期 ${-d} 天`;
}

// ================= 文件（图片 / 录音） =================

const urlCache = new Map();

async function storeFile(blob, name) {
  const ext = (blob.type.split('/')[1] || 'bin').split(';')[0].replace('jpeg', 'jpg');
  const id = `${C.uid()}.${ext}`;
  await DB.putFile({ id, blob, name, type: blob.type, size: blob.size, synced: false });
  scheduleSync();
  return id;
}

async function fileUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  let f = await DB.getFile(id);
  if (!f) {
    const c = cfg();
    if (!c.token) return null;
    try {
      const blob = await S.downloadFile(c, id);
      f = { id, blob, name: id, type: blob.type, size: blob.size, synced: true };
      await DB.putFile(f);
    } catch { return null; }
  }
  const u = URL.createObjectURL(f.blob);
  urlCache.set(id, u);
  return u;
}

async function hydrate() {
  for (const el of document.querySelectorAll('[data-file]')) {
    const u = await fileUrl(el.dataset.file);
    if (!u) continue;
    if (el.tagName === 'A') el.href = u;
    else el.src = u;
  }
}

async function compressImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  let best = null;
  for (let round = 0; round < 6; round++) {
    cv.width = Math.max(1, Math.round(bmp.width * scale));
    cv.height = Math.max(1, Math.round(bmp.height * scale));
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    for (const q of [0.82, 0.7, 0.58, 0.46]) {
      best = await new Promise(r => cv.toBlob(r, 'image/jpeg', q));
      if (best.size <= 300 * 1024) return best;
    }
    scale *= 0.8;
  }
  return best;
}

// ================= 同步 =================

let syncTimer = null, syncing = false, syncAgain = false, renderAfterSync = false;

function scheduleSync(delay = 10000) {
  if (!cfg().token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(), delay);
}

function setSync(status, msg = '') {
  state.sync = { status, msg };
  const b = $('#sync-badge');
  if (b) b.outerHTML = syncBadge();
  const s = $('#sync-detail');
  if (s) s.innerHTML = syncDetail();
}

async function doSync(manual = false) {
  const c = cfg();
  if (!c.token) {
    if (manual) toast('先在设置里填令牌');
    return;
  }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSync('busy');
  try {
    await S.syncOnce(c, {
      device: c.device,
      localRecords: () => DB.allRecords(),
      saveLocal: async merged => {
        // 同步途中本机又改过的，以本机为准
        const cur = await DB.allRecords();
        const all = C.mergeRecords(cur, merged);
        const curMap = new Map(cur.map(r => [r.id, C.stableStringify(r)]));
        const changed = all.filter(r => curMap.get(r.id) !== C.stableStringify(r));
        await DB.putRecords(changed);
        state.recs = C.mergeRecords(state.recs, all);
        index();
        if (changed.length) renderAfterSync = true;
      },
      pendingFiles: async () => (await DB.allFiles()).filter(f => !f.synced),
      markFileSynced: async id => { const f = await DB.getFile(id); f.synced = true; await DB.putFile(f); },
    });
    localStorage.setItem('pp.lastSync', String(Date.now()));
    setSync('ok');
    if (manual) toast('已同步');
  } catch (e) {
    setSync(e.code === 'network' ? 'offline' : 'err', e.message || String(e));
    if (manual) toast(e.message || '同步失败');
    if (e.code === 'conflict' || e.code === 'network') scheduleSync(e.code === 'conflict' ? 3000 : 30000);
  } finally {
    syncing = false;
    if (renderAfterSync && !modalOpen() && !isTyping() && !/new-puzzle|edit-puzzle|card\//.test(location.hash)) {
      renderAfterSync = false;
      render();
    }
    if (syncAgain) { syncAgain = false; scheduleSync(1500); }
  }
}

function syncBadge() {
  const c = cfg();
  const last = Number(localStorage.getItem('pp.lastSync') || 0);
  let cls = '', text;
  if (!navigator.onLine || state.sync.status === 'offline') { cls = ''; text = '离线，联网后自动同步'; }
  else if (!c.token) text = '仅本机';
  else if (state.sync.status === 'busy') { cls = 'busy'; text = '同步中…'; }
  else if (state.sync.status === 'err') { cls = 'err'; text = '同步失败'; }
  else if (last) { cls = 'ok'; text = '已同步 ' + new Date(last).toTimeString().slice(0, 5); }
  else text = '待同步';
  return `<span class="sync ${cls}" id="sync-badge" data-act="go" data-to="#/settings" title="${esc(state.sync.msg)}">${text}</span>`;
}

function syncDetail() {
  const c = cfg();
  const last = Number(localStorage.getItem('pp.lastSync') || 0);
  if (!c.token) return '还没开同步：数据只在这台设备上。';
  const lines = [`上次同步：${last ? new Date(last).toLocaleString('zh-CN') : '还没有'}`];
  if (state.sync.status === 'err' || state.sync.status === 'offline') lines.push(`<span style="color:var(--warn)">${esc(state.sync.msg)}</span>`);
  if (state.sync.status === 'busy') lines.push('正在同步…');
  return lines.join('<br>');
}

// ================= 公共片段 =================

function top(title, { back, home } = {}) {
  return `<div class="top">
    ${back ? `<button class="back" data-act="go" data-to="${esc(back)}" aria-label="返回">‹</button>` : ''}
    <div class="grow">${home ? `<h1>${esc(title)}</h1><div class="date">${fmtDate(Date.now())}</div>` : `<h1 style="font-size:19px">${esc(title)}</h1>`}</div>
    ${syncBadge()}
    ${home ? `<button class="icon-btn" data-act="go" data-to="#/settings" aria-label="设置">⚙</button>` : ''}
  </div>`;
}

function jigsawSvg(pz, { mini = false } = {}) {
  const ps = piecesOf(pz.id);
  if (!ps.length) return `<div class="muted" style="padding:12px 0">还没有拼块</div>`;
  const J = C.jigsaw(ps.length);
  const W = J.cols * J.size, H = J.rows * J.size;
  const gs = J.pieces.map((g, i) => {
    const p = ps[i];
    const act = mini ? '' : `data-act="go" data-to="#/piece/${p.id}"`;
    return `<g class="${pieceState(p)} ${mini ? '' : 'tap'}" data-piece="${p.id}" ${act}><path d="${g.d}"/><text x="${g.cx}" y="${g.cy}">${i + 1}</text></g>`;
  }).join('');
  return `<svg class="jigsaw ${mini ? 'mini' : ''}" viewBox="-4 -4 ${W + 8} ${H + 8}" role="img" aria-label="拼图">${gs}</svg>`;
}

function progress(pz) {
  const ps = piecesOf(pz.id);
  return { done: ps.filter(p => p.status === 'done').length, total: ps.length };
}

function focusBar(f) {
  const p = get(f.pieceId);
  return `<div class="focus-bar">
    <div class="grow">
      <div style="font-size:12px;opacity:.85">专注中 · ${esc(p?.name || '')}</div>
      <div class="clock" data-clock="${f.id}">${C.fmtClock(Date.now() - f.start)}</div>
      <div style="font-size:12px;opacity:.85">目标 2 小时，到点自动结束</div>
    </div>
    <button class="btn small" data-act="focus-end" data-id="${f.id}">结束</button>
  </div>`;
}

function pieceRow(p, i, { showPuzzle = false } = {}) {
  const st = pieceState(p);
  const pz = get(p.puzzleId);
  return `<div class="piece-row tap" data-act="go" data-to="#/piece/${p.id}">
    <div class="num ${st}">${i + 1}</div>
    <div class="name ${st} ellipsis">${esc(p.name)}${showPuzzle && pz?.lane === 'side' ? ' <span class="tag">副线</span>' : ''}</div>
    <span class="tag ${st === 'done' ? 'done' : st === 'doing' ? 'blue' : ''}">${PIECE_STATE[st]}</span>
  </div>`;
}

const singleSvg = cls => `<svg viewBox="-30 -30 160 160" class="${cls || ''}"><path d="${C.singlePiece()}"/></svg>`;

// ================= 页面：首页 =================

function pageHome() {
  const m = mainPuzzle();
  const f = activeFocus();
  const today = todayPieces();
  const scat = scatterNotes();
  const todayScatter = scat.filter(n => C.dayStr(n.at) === C.dayStr()).length;
  const lead = leadSummary();
  let h = top('拼图推进', { home: true });
  if (f) h += focusBar(f);

  if (!m) {
    h += `<div class="card hero">
      <h2>以输出倒逼输入<br>用实践校准认知</h2>
      <div class="label">DAILY WORKFLOW</div>
      <p class="desc" style="margin:14px 0 16px">一幅拼图 = 一个目标。先建第一幅主线拼图。</p>
      <button class="btn" data-act="go" data-to="#/new-puzzle">新建主线拼图</button>
      ${cfg().token ? '' : `<p class="muted" style="margin-top:12px">在别的设备上已经有数据？<a class="link" href="#/settings">先去设置里开同步</a></p>`}
    </div>`;
  } else {
    const pr = progress(m);
    h += `<div class="card tap" data-act="go" data-to="#/puzzle/${m.id}" id="home-main">
      <div class="label">MAIN PUZZLE · 主线</div>
      <div class="title">${esc(m.name)}</div>
      <div class="row" style="margin-top:10px;align-items:center">
        <div style="width:46%;max-width:200px">${jigsawSvg(m, { mini: true })}</div>
        <div class="grow" style="padding-left:8px">
          <div class="stat"><b>${pr.done}</b><span class="desc">/ ${pr.total} 块已拼上</span></div>
          <div class="desc" style="margin-top:6px">${esc(daysLeft(m.deadline))}</div>
          <div class="muted ellipsis">验收人：${esc(m.acceptor)}</div>
        </div>
      </div>
    </div>`;

    h += `<div class="card" id="home-today">
      <div class="label" style="display:flex;justify-content:space-between"><span>TODAY · 今天的 1–3 块</span>${today.length ? `<button class="link" data-act="pick-today">调整</button>` : ''}</div>`;
    if (!today.length) {
      h += `<p class="desc" style="margin:8px 0 12px">开工前从主线挑 1–3 块，今天只做这几块。</p>
        <button class="btn" data-act="pick-today">挑今天的块</button>`;
    } else {
      h += today.map((p, i) => {
        const focusing = f?.pieceId === p.id;
        return `<div class="piece-row">
          <div class="num doing">${i + 1}</div>
          <div class="name ellipsis tap" data-act="go" data-to="#/piece/${p.id}">${esc(p.name)}${get(p.puzzleId)?.lane === 'side' ? ' <span class="tag">副线</span>' : ''}
            <div class="muted">专注 ${C.fmtDuration(focusTotal(p.id))} · 记录 ${notesOf(p.id).length} 条</div></div>
          ${focusing ? '<span class="tag blue">专注中</span>' : f ? '' : `<button class="btn small ghost" data-act="focus-start" data-id="${p.id}">专注</button>`}
        </div>`;
      }).join('');
    }
    h += `</div>`;
  }

  h += `<div class="muted" style="text-align:center;margin-top:4px">
    <a class="link" href="#/scatter" style="color:${scat.length ? 'var(--warn)' : 'var(--faint)'}">今天新增散块 ${todayScatter}${scat.length > todayScatter ? `（共 ${scat.length}）` : ''}</a>
    · 本周引领动作 ${lead.done}/${lead.target}
  </div>`;

  const rv = live('review').find(r => r.week === C.weekKey());
  if (new Date().getDay() === 0 && !rv?.done) {
    h += `<div class="card tap" data-act="go" data-to="#/review" style="margin-top:14px">
      <div class="label">SUNDAY · 周回顾</div><div class="title">今天是周回顾日，20 分钟</div>
      <div class="desc">对账、清散块、抽卡自测、定下周预测。</div></div>`;
  }
  return h;
}

// ================= 页面：拼图列表 / 详情 / 编辑 =================

function puzzleCard(pz) {
  const pr = progress(pz);
  return `<div class="card tap row" data-act="go" data-to="#/puzzle/${pz.id}">
    <div class="grow">
      <div class="label">${pz.lane === 'main' ? 'MAIN' : pz.lane === 'side' ? 'SIDE' : pz.lane.toUpperCase()} · ${LANES[pz.lane]}</div>
      <div class="title ellipsis">${esc(pz.name)}</div>
      <div class="desc">已拼 ${pr.done} / ${pr.total} · ${esc(daysLeft(pz.deadline))}</div>
    </div>
    <div style="width:76px;flex:none">${jigsawSvg(pz, { mini: true })}</div>
  </div>`;
}

function pagePuzzles() {
  const full = mainPuzzle() && sidePuzzle();
  let h = top('拼图');
  h += `<div style="margin-bottom:14px">
    <button class="btn block" data-act="go" data-to="#/new-puzzle" ${full ? 'disabled' : ''} id="new-puzzle-btn">＋ 新建拼图</button>
    ${full ? `<p class="muted" style="text-align:center;margin:6px 0 0">已有 1 幅主线 + 1 幅副线，先暂停或结束一幅再新建</p>` : ''}
  </div>`;
  const act = puzzlesIn('main', 'side');
  h += act.length ? act.map(puzzleCard).join('') : `<div class="card"><div class="desc">还没有在推进的拼图。</div></div>`;
  const paused = puzzlesIn('paused');
  if (paused.length) h += `<div class="section-h"><h3>暂停区</h3></div>` + paused.map(puzzleCard).join('');
  const done = puzzlesIn('done');
  if (done.length) h += `<div class="section-h"><h3>已完成</h3></div>` + done.map(puzzleCard).join('');
  const stops = live('stopped').sort((a, b) => b.at - a.at);
  h += `<div class="section-h"><h3>半途而废清单</h3><span class="muted">停或改的真实原因</span></div>
    <div class="card">${stops.length ? stops.map(s => `<div class="piece-row"><span class="tag ${s.action === 'stop' ? '' : 'blue'}">${s.action === 'stop' ? '停' : '改'}</span>
      <div class="name"><b>${esc(s.name)}</b><div class="desc pre">${esc(s.reason)}</div><div class="muted">${fmtTime(s.at)}</div></div></div>`).join('')
      : '<div class="muted">还没有。停下或转向时，在这里写一句真实原因。</div>'}</div>`;
  return h;
}

function pagePuzzle(id) {
  const pz = get(id);
  if (!pz) return top('拼图', { back: '#/puzzles' }) + '<div class="card">这幅拼图不存在了。</div>';
  const ps = piecesOf(pz.id);
  const pr = progress(pz);
  const wk = C.weekKey();
  let h = top(pz.name, { back: '#/puzzles' });
  h += `<div class="card">
    <div class="label">${LANES[pz.lane]} · 已拼 ${pr.done} / ${pr.total}</div>
    <div style="margin:12px auto 4px;max-width:${Math.min(420, C.jigsaw(Math.max(1, ps.length)).cols * 110)}px">${jigsawSvg(pz)}</div>
    <div class="desc" style="text-align:center">${esc(daysLeft(pz.deadline))} · 点一块进去</div>
  </div>`;

  h += `<div class="card"><div class="label">GOAL · 目标</div>
    ${C.PUZZLE_FIELDS.map(([k, label]) => `<div class="piece-row"><div class="muted" style="width:76px;flex:none">${label}</div><div class="name pre">${esc(pz[k])}</div></div>`).join('')}
  </div>`;

  h += `<div class="card"><div class="label">LEAD · 本周引领动作</div>
    ${(pz.leads || []).map(l => {
      const n = leadCount(l, wk), t = Number(l.target) || 1;
      return `<div class="piece-row"><div class="name">${esc(l.name)}<div class="muted">本周 ${n} / ${t}</div></div>
        <button class="btn small plain" data-act="lead-minus" data-pz="${pz.id}" data-lead="${l.id}" ${n ? '' : 'disabled'}>−</button>
        <button class="btn small ${n >= t ? 'ghost' : ''}" data-act="lead-plus" data-pz="${pz.id}" data-lead="${l.id}">＋1</button></div>`;
    }).join('')}
  </div>`;

  h += `<div class="card"><div class="label">IF-THEN · 被打断时</div>
    ${(pz.ifThens || []).map(s => `<div class="piece-row"><div class="name pre desc">${esc(s)}</div></div>`).join('')}
  </div>`;

  h += `<div class="card"><div class="label" style="display:flex;justify-content:space-between"><span>PIECES · 拼块</span><span>${ps.length} / ${C.MAX_PIECES}</span></div>
    ${ps.map((p, i) => pieceRow(p, i)).join('')}
    <div class="row" style="margin-top:10px">
      <input type="text" id="new-piece" class="grow" placeholder="新拼块：写成一个能交出去的产出" ${ps.length >= C.MAX_PIECES ? 'disabled' : ''}>
      <button class="btn small" data-act="add-piece" data-pz="${pz.id}" ${ps.length >= C.MAX_PIECES ? 'disabled' : ''}>添加</button>
    </div>
    ${ps.length >= C.MAX_PIECES ? '<p class="muted">已到 24 块：目标太大，考虑拆成两幅拼图。</p>' : ''}
  </div>`;

  const btns = [`<button class="btn plain small" data-act="go" data-to="#/edit-puzzle/${pz.id}">编辑</button>`];
  if (pz.lane === 'side') btns.push(`<button class="btn ghost small" data-act="lane" data-id="${pz.id}" data-lane="main">设为主线</button>`);
  if (['main', 'side'].includes(pz.lane)) {
    btns.push(`<button class="btn plain small" data-act="lane" data-id="${pz.id}" data-lane="paused">放进暂停区</button>`);
    btns.push(`<button class="btn ghost small" data-act="lane" data-id="${pz.id}" data-lane="done">宣布完成</button>`);
    btns.push(`<button class="btn danger small" data-act="stop-dialog" data-id="${pz.id}">停或改</button>`);
  } else {
    btns.push(`<button class="btn ghost small" data-act="lane" data-id="${pz.id}" data-lane="resume">恢复推进</button>`);
  }
  h += `<div class="btns">${btns.join('')}</div>`;
  return h;
}

function pageEditPuzzle(id) {
  const editing = id ? get(id) : null;
  if (!editing && mainPuzzle() && sidePuzzle()) {
    return top('新建拼图', { back: '#/puzzles' }) + `<div class="card"><div class="err-box">已有 1 幅主线 + 1 幅副线。先把一幅放进暂停区或宣布完成 / 停止，再新建。</div>
      <button class="btn" data-act="go" data-to="#/puzzles">回拼图页</button></div>`;
  }
  const d = editing || {
    name: '', deliverable: '', deadline: '', acceptor: '', value: '', stopRule: C.DEFAULT_STOP_RULE,
    leads: [], ifThens: [],
  };
  const lane = editing ? editing.lane : mainPuzzle() ? 'side' : 'main';
  const leads = [...(d.leads || [])];
  while (leads.length < 3) leads.push({ id: '', name: '', target: 1 });
  const ifs = [...(d.ifThens || [])];
  while (ifs.length < 3) ifs.push('');
  const ph = { deliverable: '例：第一位客户确认试用并付第一笔费用', acceptor: '例：客户本人', value: '例：每位客户 ¥300 / 学期' };
  let h = top(editing ? '编辑拼图' : `新建${LANES[lane]}拼图`, { back: editing ? `#/puzzle/${id}` : '#/puzzles' });
  h += `<div id="form-err"></div><div class="card">
    <div class="field"><label>拼图名称</label><input type="text" id="f-name" value="${esc(d.name)}" placeholder="一句话说清这幅拼图"></div>
    ${C.PUZZLE_FIELDS.map(([k, label, hint]) => `<div class="field"><label>${label}<span class="hint">${hint}</span></label>
      ${k === 'deadline' ? `<input type="date" id="f-${k}" value="${esc(d[k])}">` : `<input type="text" id="f-${k}" value="${esc(d[k])}" placeholder="${esc(ph[k] || '')}">`}</div>`).join('')}
  </div>
  <div class="card"><div class="label">LEAD · 每周引领动作（2–3 个，自己能控制、能计数）</div>
    ${leads.slice(0, 3).map((l, i) => `<div class="row" style="margin-top:10px">
      <input type="text" class="grow" id="f-lead-${i}" data-lid="${esc(l.id)}" value="${esc(l.name)}" placeholder="${i === 0 ? '例：每周约 2 位客户看演示' : i === 1 ? '例：每周发 3 份报价' : '可不填'}">
      <input type="number" id="f-lead-t-${i}" value="${esc(l.target || 1)}" min="1" max="50" style="width:72px" aria-label="每周次数"><span class="muted">次/周</span></div>`).join('')}
  </div>
  <div class="card"><div class="label">IF-THEN · 3 条「如果被××打断，我就××」</div>
    ${ifs.slice(0, 3).map((s, i) => `<div class="field" style="margin:10px 0 0"><textarea id="f-if-${i}" rows="2" placeholder="${['如果有人临时找我做别的，我就先记进散块盒，主线 2 小时做完再处理', '如果卡住超过半天，我就先做不依赖它的块', '如果刷手机超过 15 分钟，我就打开拼图看今天的块'][i]}">${esc(s)}</textarea></div>`).join('')}
  </div>`;
  if (!editing) {
    h += `<div class="card"><div class="label">PIECES · 先拆几块（每行一块，可以以后再加）</div>
      <textarea id="f-pieces" rows="5" style="margin-top:10px" placeholder="每块写成一个能交出去的产出，例如：&#10;报价单&#10;第一次演示录屏"></textarea></div>`;
  }
  h += `<button class="btn block" data-act="save-puzzle" data-id="${editing ? editing.id : ''}" data-lane="${lane}">${editing ? '保存' : '开始这幅拼图'}</button>`;
  return h;
}

// ================= 页面：拼块 =================

function pagePiece(id) {
  const p = get(id);
  if (!p) return top('拼块', { back: '#/' }) + '<div class="card">这块不存在了。</div>';
  const pz = get(p.puzzleId);
  const idx = piecesOf(p.puzzleId).findIndex(x => x.id === id);
  const st = pieceState(p);
  const f = activeFocus();
  const notes = notesOf(id);
  const ev = p.evidence || [];
  let h = top(`第 ${idx + 1} 块`, { back: pz ? `#/puzzle/${pz.id}` : '#/' });
  if (f && f.pieceId === id) h += focusBar(f);
  h += `<div class="card">
    <div class="label">PIECE ${String(idx + 1).padStart(2, '0')} · ${esc(pz?.name || '')}</div>
    <div class="title">${esc(p.name)} <button class="link" data-act="rename-piece" data-id="${id}">改名</button></div>
    <div class="row" style="margin:6px 0 12px"><span class="tag ${st === 'done' ? 'done' : st === 'doing' ? 'blue' : ''}">${PIECE_STATE[st]}</span>
      <span class="muted">专注 ${C.fmtDuration(focusTotal(id))}</span></div>
    ${p.status === 'done' ? '' : `<div class="btns">
      ${isToday(p) ? `<button class="btn plain small" data-act="today-off" data-id="${id}">移出今天</button>` : `<button class="btn ghost small" data-act="today-on" data-id="${id}">加入今天</button>`}
      ${f ? '' : `<button class="btn small" data-act="focus-start" data-id="${id}">开始专注 2 小时</button>`}
    </div>`}
  </div>`;

  h += `<div class="card"><div class="label" style="display:flex;justify-content:space-between"><span>NOTES · 随手记 ${notes.length}</span><button class="link" data-act="note" data-piece="${id}">记一句</button></div>
    ${notes.length ? notes.map(n => `<div class="piece-row"><div class="name"><div class="pre">${esc(n.text)}</div><div class="muted">${fmtTime(n.at)}${n.feedback ? ' · 外部反馈' : ''}</div></div></div>`).join('') : '<div class="muted" style="margin-top:6px">做的时候随手记一句，拼上时写经验卡会用到。</div>'}
  </div>`;

  h += `<div class="card" id="evidence"><div class="label">EVIDENCE · 证据（拼上必须有一项）</div>
    ${ev.length ? ev.map(e => evidenceRow(p, e)).join('') : '<div class="muted" style="margin-top:6px">链接、图片、文件、收款截图，至少一项。</div>'}
    <div class="btns" style="margin-top:12px">
      <button class="btn plain small" data-act="evi-link" data-id="${id}">＋ 链接</button>
      <label class="btn plain small">＋ 图片<input type="file" accept="image/*" hidden data-change="evi-image" data-id="${id}"></label>
      <label class="btn plain small">＋ 文件<input type="file" hidden data-change="evi-file" data-id="${id}"></label>
      <button class="btn plain small" data-act="evi-income" data-id="${id}">＋ 收款</button>
    </div>
  </div>`;

  if (p.status === 'done') {
    const card = cardOf(id);
    h += `<div class="card"><div class="label">PLACED · 已拼上</div>
      <div class="desc">${fmtTime(p.doneAt)}</div>
      <div class="btns" style="margin-top:10px">${card ? `<button class="btn" data-act="go" data-to="#/card/${card.id}">经验卡 · ${STAGES[card.stage]}</button>` : ''}
      <button class="btn plain small" data-act="unplace" data-id="${id}">撤销拼上</button></div></div>`;
  } else {
    h += `<button class="btn block" id="place-btn" data-act="place" data-id="${id}" ${ev.length ? '' : 'disabled'}>拼上这一块</button>
      ${ev.length ? '' : '<p class="muted" style="text-align:center;margin-top:6px">先附一个证据</p>'}`;
  }
  h += `<p style="text-align:center;margin-top:18px"><button class="link" style="color:var(--faint)" data-act="delete-piece" data-id="${id}">删除这块</button></p>`;
  return h;
}

function evidenceRow(p, e) {
  const del = `<button class="link" style="color:var(--faint)" data-act="evi-del" data-id="${p.id}" data-eid="${e.id}">删除</button>`;
  const when = `<div class="muted">${fmtTime(e.at)}</div>`;
  if (e.kind === 'link') return `<div class="evi"><div class="ico">🔗</div><div class="grow" style="min-width:0"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.note || e.url)}</a>${when}</div>${del}</div>`;
  if (e.kind === 'image') return `<div class="evi"><img data-file="${esc(e.fileId)}" alt="证据图片"><div class="grow">${esc(e.note || '图片')}${when}</div>${del}</div>`;
  if (e.kind === 'file') return `<div class="evi"><div class="ico">📄</div><div class="grow" style="min-width:0"><a data-file="${esc(e.fileId)}" download="${esc(e.name)}">${esc(e.name)}</a>${when}</div>${del}</div>`;
  return `<div class="evi">${e.fileId ? `<img data-file="${esc(e.fileId)}" alt="收款截图">` : '<div class="ico">¥</div>'}<div class="grow"><b>收款 ¥${esc(e.amount)}</b> ${esc(e.note || '')}${when}</div>${del}</div>`;
}

// ================= 页面：散块盒 =================

function scatterItem(n) {
  return `<div class="card scatter">${singleSvg()}
    <div class="pre">${esc(n.text)}</div><div class="muted">${fmtTime(n.at)}${n.feedback ? ' · 外部反馈' : ''}</div>
    <div class="btns" style="margin-top:10px">
      <button class="btn small ghost" data-act="scatter-attach" data-id="${n.id}">挂到某块</button>
      <button class="btn small plain" data-act="scatter-upgrade" data-id="${n.id}">升级成新拼块</button>
      <button class="btn small plain" data-act="scatter-del" data-id="${n.id}">删除</button>
    </div></div>`;
}

function pageScatter() {
  const list = scatterNotes();
  let h = top('散块盒', { back: '#/' });
  h += `<p class="desc" style="margin:0 4px 14px">挂不到任何一块上的记录。它们就是偏离的地方：每周清空一次。</p>`;
  h += list.length ? list.map(scatterItem).join('') : '<div class="card"><div class="desc">散块盒是空的 ✓</div></div>';
  return h;
}

// ================= 页面：经验卡 =================

function stepGuide() {
  return STEPS.map(([lab, title, desc]) => `<div class="card"><div class="label">${lab}</div><div class="title">${title}</div><div class="desc">${desc}</div></div>`).join('');
}

function pageCards() {
  const filter = state.ui.cardFilter || 'all';
  const cards = live('card').filter(c => filter === 'all' || c.stage === filter).sort((a, b) => b.updatedAt - a.updatedAt);
  let h = top('经验卡');
  h += `<div class="hero"><h2>以输出倒逼输入<br>用实践校准认知</h2><div class="label">DAILY WORKFLOW</div></div>`;
  if (!state.ui.hideGuide) h += stepGuide() + `<p style="text-align:center;margin:-4px 0 10px"><button class="link" data-act="hide-guide">收起说明</button></p>`;
  else h += `<p style="text-align:center;margin:-8px 0 10px"><button class="link" data-act="show-guide">展开「做 · 卡 · 讲 · 送」说明</button></p>`;
  h += `<div style="margin:6px 0 10px">${[['all', '全部'], ...Object.entries(STAGES)].map(([k, v]) =>
    `<span class="chip ${filter === k ? 'on' : ''}" data-act="card-filter" data-f="${k}">${v} ${k === 'all' ? live('card').length : live('card').filter(c => c.stage === k).length}</span>`).join('')}</div>`;
  h += cards.length ? cards.map(c => `<div class="card tap" data-act="go" data-to="#/card/${c.id}">
      <div class="label">${STAGES[c.stage]} · ${esc(get(c.puzzleId)?.name || '')}</div>
      <div class="title">${esc(c.title)}</div>
      <div class="desc ellipsis">${esc(c.cells?.core || '还没提炼')}</div></div>`).join('')
    : '<div class="card"><div class="desc">拼上一块，就会在这里出现一张经验卡。</div></div>';
  return h;
}

let recorder = null;

function pageCard(id) {
  const c = get(id);
  if (!c) return top('经验卡', { back: '#/cards' }) + '<div class="card">这张卡不存在了。</div>';
  const p = get(c.pieceId);
  const reach = STAGE_STEP[c.stage];
  const cur = state.ui.cardStep[id] ?? reach;
  let h = top('经验卡', { back: '#/cards' });
  h += `<div class="hero" style="padding-bottom:12px"><div class="label" style="color:var(--faint)">${esc(get(c.puzzleId)?.name || '')}</div><h2 style="font-size:20px">${esc(c.title)}</h2>
    <div style="margin-top:6px"><span class="tag blue" id="card-stage">${STAGES[c.stage]}</span></div></div>`;
  STEPS.forEach(([lab, title, desc], i) => {
    const cls = i === cur ? 'cur' : i <= reach ? 'passed' : '';
    const can = i <= reach;
    h += `<div class="card step ${cls}" data-step="${i}">
      <div class="${can ? 'tap' : ''}" ${can && i !== cur ? `data-act="card-step" data-id="${id}" data-i="${i}"` : ''}>
        <div class="label"><span>${lab}</span><span>${i < reach ? '✓' : ''}</span></div>
        <div class="title">${title}</div><div class="desc">${desc}</div>
      </div>
      ${i === cur ? `<div class="step-body">${cardStepBody(c, p, i)}</div>` : ''}
    </div>`;
  });
  return h;
}

function cardStepBody(c, p, i) {
  if (i === 0) {
    const notes = p ? notesOf(p.id) : [];
    return `<div class="desc">这一块专注了 <b>${C.fmtDuration(p ? focusTotal(p.id) : 0)}</b>，随手记 ${notes.length} 条：</div>
      ${notes.map(n => `<div class="cell" style="margin-top:8px"><div>${esc(n.text)}</div><span class="muted">${fmtTime(n.at)}</span></div>`).join('') || '<div class="muted">没有记录。</div>'}
      <button class="btn block" style="margin-top:12px" data-act="card-step" data-id="${c.id}" data-i="1">去提炼卡片</button>`;
  }
  if (i === 1) {
    return `<div class="field"><label>卡片标题</label><input type="text" id="c-title" value="${esc(c.title)}"></div>
      <div class="label" style="margin:4px 0 8px">先复盘：四个问题</div>
      ${C.AAR.map(([k, q]) => `<div class="field"><label>${q}</label><textarea id="c-aar-${k}" rows="2">${esc(c.aar?.[k])}</textarea></div>`).join('')}
      <div class="label" style="margin:14px 0 8px">再提炼：四格</div>
      ${C.CARD_CELLS.map(([k, l, hint]) => `<div class="field"><label>${l}<span class="hint">${hint}</span></label><textarea id="c-cell-${k}" rows="2">${esc(c.cells?.[k])}</textarea></div>`).join('')}
      <button class="btn block" data-act="card-save" data-id="${c.id}">保存</button>
      <p class="muted" style="text-align:center;margin-top:6px">四格有一格空着就存为草稿。写不清 = 没学透。</p>`;
  }
  if (i === 2) {
    const rec = recorder?.cardId === c.id;
    return `<div class="desc">合上手机，不看稿讲一遍：痛点 → 原理 → 步骤 → 行动。录下来，回放时找卡壳的地方。</div>
      <div style="margin:12px 0">${rec
        ? `<button class="btn danger block" data-act="rec-stop"><span class="rec-dot"></span>停止录音 <span data-rec-clock>0:00:00</span></button>`
        : `<button class="btn ghost block" data-act="rec-start" data-id="${c.id}">🎙 ${c.audioFileId ? '重新录一遍' : '开始录音'}（最长 10 分钟）</button>`}</div>
      ${c.audioFileId ? `<audio controls data-file="${esc(c.audioFileId)}"></audio>` : ''}
      <div class="field" style="margin-top:12px"><label>卡壳的地方<span class="hint">每个卡壳点就是一个认知漏洞</span></label><textarea id="c-gaps" rows="3">${esc(c.gaps)}</textarea></div>
      <button class="btn block" data-act="card-told" data-id="${c.id}">讲完了，去补漏洞</button>`;
  }
  return `${c.gaps ? `<div class="cell" style="margin-bottom:12px"><b>上次卡壳的地方</b><div>${esc(c.gaps)}</div></div>` : ''}
    <div class="desc" style="margin-bottom:10px">按卡壳的地方改写四格，精简表达。每次保存留一个历史版本。</div>
    ${C.CARD_CELLS.map(([k, l]) => `<div class="field"><label>${l}</label><textarea id="c-cell-${k}" rows="2">${esc(c.cells?.[k])}</textarea></div>`).join('')}
    <div class="btns"><button class="btn" data-act="card-version" data-id="${c.id}">保存新版本</button>
      ${c.stage === 'library' ? '<span class="tag done" style="align-self:center">已入库</span>' : `<button class="btn ghost" data-act="card-library" data-id="${c.id}">标记为已入库</button>`}
      <button class="btn plain" data-act="card-copy" data-id="${c.id}">复制成文字</button></div>
    ${(c.versions || []).length ? `<details style="margin-top:14px"><summary class="muted">历史版本 ${c.versions.length}</summary>
      ${c.versions.slice().reverse().map(v => `<div class="cell" style="margin-top:8px"><span class="muted">${fmtTime(v.at)}</span>
        ${C.CARD_CELLS.map(([k, l]) => `<div><b style="display:inline">${l}：</b>${esc(v.cells?.[k])}</div>`).join('')}</div>`).join('')}</details>` : ''}`;
}

const cardText = c => `${c.title}\n` + C.CARD_CELLS.map(([k, l]) => `${l}：${c.cells?.[k] || ''}`).join('\n');

// ================= 页面：周回顾 =================

function reviewRec(wk) { return live('review').find(r => r.week === wk) || null; }

function pageReview() {
  const wk = C.weekKey();
  const rv = reviewRec(wk);
  const step = rv?.step || 0;
  const end = C.dayStr(C.addDays(C.weekStart(), 6));
  let h = top('周回顾');
  h += `<p class="desc" style="margin:-6px 4px 12px">${wk} 至 ${end} · 每周日 20 分钟，按顺序做完</p>`;
  if (rv?.done) {
    const m = C.computeMetrics(state.recs, wk);
    h += `<div class="card"><div class="label">DONE · 本周回顾已完成</div>${metricsGrid(m)}
      <div class="btns" style="margin-top:12px"><button class="btn" data-act="review-copy">复制成文字（发给问责伙伴）</button>
      <button class="btn plain small" data-act="review-redo">从头再做一遍</button></div></div>`;
    return h;
  }
  h += `<div class="steps-line">${REVIEW_STEPS.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  h += `<div class="card" id="review-step" data-step="${step}"><div class="label">STEP 0${step + 1} / 06</div><div class="title">${REVIEW_STEPS[step]}</div>`;
  const body = reviewBody(step, wk, rv);
  h += `<div class="step-body">${body.html}</div>`;
  h += `<div class="btns" style="margin-top:14px">${step > 0 ? `<button class="btn plain" data-act="review-back">上一步</button>` : ''}
    <button class="btn grow" style="flex:1" id="review-next" data-act="review-next" ${body.ok ? '' : 'disabled'}>${step === 5 ? '完成回顾' : '下一步'}</button></div>
    ${body.ok ? '' : `<p class="muted" style="text-align:center;margin-top:6px">${body.why}</p>`}</div>`;
  return h;
}

function metricsGrid(m) {
  const items = [
    ['拼上块数', m.piecesDone],
    ['主线时间占比', C.pct(m.mainShare)],
    ['预测命中率', C.pct(m.hitRate)],
    ['半途放弃', m.stopped],
    ['收入', '¥' + m.income],
    ['近 14 天使用天数', m.usageDays14],
  ];
  return `<div class="metric-grid" style="margin-top:10px">${items.map(([l, v]) => `<div class="metric"><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
}

function reviewBody(step, wk, rv) {
  if (step === 0) {
    const m = C.computeMetrics(state.recs, wk);
    const pred = live('predict').find(r => r.week === wk);
    const ids = (pred?.pieceIds || []).filter(id => get(id));
    const doneIds = live('piece').filter(p => p.status === 'done' && p.doneAt && C.weekKey(p.doneAt) === wk).map(p => p.id);
    const extra = doneIds.filter(id => !ids.includes(id));
    return {
      ok: true,
      html: `<div class="desc">上周日预测这周会拼上的块，和实际拼上的对一下。</div>
        ${ids.length ? ids.map(id => `<div class="piece-row"><span class="tag ${doneIds.includes(id) ? 'done' : ''}">${doneIds.includes(id) ? '✓ 中' : '✗ 没拼上'}</span><div class="name ellipsis">${esc(get(id).name)}</div></div>`).join('')
          : '<div class="muted" style="margin-top:8px">这周没有预测（第一周正常）。今天最后一步会做下周的预测。</div>'}
        ${extra.length ? `<div class="muted" style="margin-top:8px">预测外拼上的：${extra.map(id => esc(get(id)?.name)).join('、')}</div>` : ''}
        <div class="stat" style="margin-top:12px"><b id="hit-rate">${C.pct(m.hitRate)}</b><span class="desc">命中率（预测 ${m.predicted} 块，中 ${m.hits} 块）</span></div>`,
    };
  }
  if (step === 1) {
    const list = scatterNotes();
    return {
      ok: !list.length,
      why: `还有 ${list.length} 个散块：挂到某块、升级成拼块，或删掉`,
      html: `<div class="desc" style="margin-bottom:10px">每个散块：挂到某块 / 升级成新拼块 / 删除。删之前看一眼：这就是本周偏离的地方。</div>
        ${list.length ? list.map(scatterItem).join('') : '<div class="desc">散块盒已清空 ✓</div>'}`,
    };
  }
  if (step === 2) {
    const ids = (rv?.quiz || []).filter(id => get(id));
    const res = rv?.quizResults || {};
    if (!ids.length) return { ok: true, html: '<div class="desc">还没有写完的经验卡，这一步跳过。</div>' };
    const left = ids.filter(id => !res[id]).length;
    return {
      ok: !left,
      why: `还有 ${left} 张没自评`,
      html: `<div class="desc" style="margin-bottom:10px">只看标题，先在心里说出「核心」和「方法」，再翻开对照。</div>
        ${ids.map(id => {
          const c = get(id);
          const open = state.ui.reveal[id];
          return `<div class="quiz-card" data-quiz="${id}"><b>${esc(c.title)}</b>
            ${open ? `<div class="cell" style="margin-top:8px"><b>核心</b><div>${esc(c.cells.core)}</div></div><div class="cell" style="margin-top:6px"><b>方法</b><div>${esc(c.cells.method)}</div></div>
              <div class="btns" style="margin-top:8px">${[['ok', '记得'], ['vague', '模糊'], ['forgot', '忘了']].map(([k, l]) =>
                `<span class="chip ${res[id] === k ? 'on' : ''}" data-act="quiz-rate" data-id="${id}" data-r="${k}">${l}</span>`).join('')}</div>`
              : `<div style="margin-top:8px"><button class="btn small ghost" data-act="quiz-reveal" data-id="${id}">翻开</button></div>`}</div>`;
        }).join('')}`,
    };
  }
  if (step === 3) {
    const pzs = [mainPuzzle(), sidePuzzle()].filter(Boolean);
    return {
      ok: true,
      html: pzs.map(pz => `<div class="label" style="margin-top:6px">${LANES[pz.lane]} · ${esc(pz.name)}</div>
        ${(pz.leads || []).map(l => { const n = leadCount(l, wk), t = Number(l.target) || 1; return `<div class="piece-row"><span class="tag ${n >= t ? 'done' : ''}">${n} / ${t}</span><div class="name">${esc(l.name)}</div></div>`; }).join('')}`).join('')
        || '<div class="desc">没有在推进的拼图。</div>',
    };
  }
  if (step === 4) {
    const flagged = puzzlesIn('main', 'side').filter(needsStopCheck);
    const handled = id => live('stopped').some(s => s.puzzleId === id && s.week === wk);
    const left = flagged.filter(pz => !handled(pz.id));
    return {
      ok: !left.length,
      why: '有拼图连续 2 周没有外部反馈，先选停还是改',
      html: flagged.length ? flagged.map(pz => {
        const days = Math.floor((Date.now() - lastFeedbackAt(pz)) / DAY);
        if (handled(pz.id)) return `<div class="piece-row"><span class="tag done">已处理</span><div class="name">${esc(pz.name)}</div></div>`;
        return `<div class="quiz-card"><b>${esc(pz.name)}</b><div class="desc">已经 ${days} 天没有任何外部反馈（没人用、没人问价、没人付钱）</div>
          <textarea id="stop-reason-${pz.id}" rows="2" style="margin-top:8px" placeholder="一句真实原因"></textarea>
          <div class="btns" style="margin-top:8px"><button class="btn small danger" data-act="stop-do" data-id="${pz.id}" data-a="stop">停</button>
          <button class="btn small ghost" data-act="stop-do" data-id="${pz.id}" data-a="change">改（换个做法再试 2 周）</button></div></div>`;
      }).join('') : '<div class="desc">在推进的拼图最近 2 周都有外部反馈 ✓</div><div class="muted" style="margin-top:6px">外部反馈 = 随手记时勾了「这是外部反馈」，或收到了收款。</div>',
    };
  }
  const nk = C.nextWeekKey();
  const pred = live('predict').find(r => r.week === nk);
  const sel = new Set(pred?.pieceIds || []);
  const pzs = [mainPuzzle(), sidePuzzle()].filter(Boolean);
  return {
    ok: true,
    html: `<div class="desc">勾出下周会拼上的块（下周日用来对账）。</div>
      ${pzs.map(pz => `<div class="label" style="margin:12px 0 6px">${LANES[pz.lane]} · ${esc(pz.name)}</div>
        ${piecesOf(pz.id).filter(p => p.status !== 'done').map(p => `<span class="chip ${sel.has(p.id) ? 'on' : ''}" data-act="predict-toggle" data-id="${p.id}">${esc(p.name)}</span>`).join('') || '<span class="muted">没有空位</span>'}`).join('')}
      <div class="muted" style="margin-top:8px">已选 ${sel.size} 块</div>`,
  };
}

// ================= 页面：设置 =================

function pageSettings() {
  const c = cfg();
  let h = top('设置', { back: '#/' });
  h += `<div class="card"><div class="label">SYNC · 手机和电脑同步</div>
    <div class="desc" id="sync-detail" style="margin:6px 0 12px">${syncDetail()}</div>
    <div class="field"><label>数据仓库</label><input type="text" id="s-repo" value="${esc(c.repo)}"></div>
    <div class="field"><label>令牌<span class="hint">只存在这台设备上</span></label><input type="password" id="s-token" value="${esc(c.token)}" placeholder="github_pat_ 开头的一长串" autocomplete="off"></div>
    <div class="field"><label>这台设备叫</label><input type="text" id="s-device" value="${esc(c.device)}"></div>
    <div id="s-msg"></div>
    <div class="btns"><button class="btn" data-act="sync-save">保存并测试</button><button class="btn ghost" data-act="sync-now">立即同步</button></div>
    <details style="margin-top:14px"><summary class="link">怎么拿令牌（第一次用，约 2 分钟）</summary>
      <ol class="desc" style="padding-left:20px">
        <li>点下面的按钮，打开 GitHub 的「新建令牌」页（名称、有效期、权限已经填好）</li>
        <li>「Repository access」选 <b>Only select repositories</b>，再选 <b>puzzle-progress-data</b> 一个仓库</li>
        <li>拉到底点绿色的 <b>Generate token</b>，复制那串 github_pat_ 开头的字</li>
        <li>粘到上面「令牌」里，点「保存并测试」。手机和电脑各填一次</li>
      </ol>
      <a class="btn ghost small" href="${esc(TOKEN_URL)}" target="_blank" rel="noopener">打开 GitHub 建令牌页</a>
    </details>
  </div>
  <div class="card"><div class="label">BACKUP · 备份</div>
    <div class="desc" style="margin:6px 0 12px">整包导出成一个文件（含图片和录音，不含令牌）。换手机时导入，或用微信传给自己留底。</div>
    <div class="btns"><button class="btn ghost" data-act="export">导出全部数据</button>
    <label class="btn plain">导入备份<input type="file" accept=".json,application/json" hidden data-change="import"></label></div>
  </div>
  <div class="card"><div class="label">DANGER · 清空</div>
    <div class="desc" style="margin:6px 0 12px">只清这台设备上的数据；开了同步的话，下次同步会从云端拿回来。</div>
    <button class="btn danger" data-act="wipe">清空本机数据</button>
  </div>
  <p class="muted" style="text-align:center">拼图推进 ${VERSION}</p>`;
  return h;
}

// ================= 路由 =================

const ROUTES = {
  '': pageHome, puzzles: pagePuzzles, puzzle: pagePuzzle, 'new-puzzle': () => pageEditPuzzle(), 'edit-puzzle': pageEditPuzzle,
  piece: pagePiece, scatter: pageScatter, cards: pageCards, card: pageCard, review: pageReview, settings: pageSettings,
};
const NAV_OF = { '': '', puzzles: 'puzzles', puzzle: 'puzzles', 'new-puzzle': 'puzzles', 'edit-puzzle': 'puzzles', piece: 'puzzles', cards: 'cards', card: 'cards', review: 'review', scatter: '', settings: '' };

function route() {
  const [name = '', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: ROUTES[name] ? name : '', id: id && decodeURIComponent(id) };
}

function render() {
  const { name, id } = route();
  $('#view').innerHTML = ROUTES[name](id);
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.nav === NAV_OF[name]));
  hydrate();
}

// ================= 操作 =================

const A = {};

A.go = d => { if (location.hash === d.to) render(); else location.hash = d.to; };

// ---- 今天 ----
function todayLimit(p) {
  const t = todayPieces();
  if (t.length >= 3) return '今天已经 3 块了，先做完再加';
  if (get(p.puzzleId)?.lane === 'side' && t.some(x => get(x.puzzleId)?.lane === 'side')) return '副线今天最多 1 块';
  if (!['main', 'side'].includes(get(p.puzzleId)?.lane)) return '这幅拼图不在推进中';
  return '';
}

function pickHtml() {
  const sel = state.ui.pick;
  const groups = [mainPuzzle(), sidePuzzle()].filter(Boolean).map(pz => {
    const ps = piecesOf(pz.id).filter(p => p.status !== 'done');
    return `<div class="field"><label>${pz.lane === 'main' ? '主线' : '副线（最多 1 块）'} · ${esc(pz.name)}</label>
      ${ps.map(p => `<span class="chip ${sel.has(p.id) ? 'on' : ''}" data-act="pick-toggle" data-id="${p.id}">${esc(p.name)}</span>`).join('') || '<div class="muted">没有空位了</div>'}</div>`;
  });
  return `<h3>今天做哪几块？<span class="muted" style="font-weight:400"> 最多 3 块</span></h3>${groups.join('')}
    <button class="btn block" data-act="pick-save">定下来（${sel.size} 块）</button>`;
}

A['pick-today'] = () => {
  if (!mainPuzzle()) return toast('先建一幅主线拼图');
  state.ui.pick = new Set(todayPieces().map(p => p.id));
  openModal(pickHtml());
};

A['pick-toggle'] = d => {
  const sel = state.ui.pick;
  if (sel.has(d.id)) sel.delete(d.id);
  else {
    if (sel.size >= 3) return toast('最多 3 块');
    const isSide = get(get(d.id).puzzleId).lane === 'side';
    if (isSide && [...sel].some(id => get(get(id).puzzleId).lane === 'side')) return toast('副线最多 1 块');
    sel.add(d.id);
  }
  setModal(pickHtml());
};

A['pick-save'] = async () => {
  const sel = state.ui.pick, td = C.dayStr(), changed = [];
  for (const p of live('piece')) {
    if (sel.has(p.id) && p.today !== td) { p.today = td; changed.push(p); }
    if (!sel.has(p.id) && p.today === td) { p.today = ''; changed.push(p); }
  }
  if (changed.length) await save(...changed);
  closeModal();
  render();
};

A['today-on'] = async d => {
  const p = get(d.id);
  const why = todayLimit(p);
  if (why) return toast(why);
  p.today = C.dayStr();
  await save(p);
  render();
};
A['today-off'] = async d => { const p = get(d.id); p.today = ''; await save(p); render(); };

// ---- 专注 ----
A['focus-start'] = async d => {
  if (activeFocus()) return toast('先结束正在专注的那块');
  const p = get(d.id);
  const f = mk('focus', { pieceId: p.id, start: Date.now(), end: null, planned: HOUR2 });
  const recs = [f];
  if (!isToday(p) && !todayLimit(p)) { p.today = C.dayStr(); recs.push(p); }
  await save(...recs);
  toast('开始 2 小时专注：只做这一块');
  render();
};

async function endFocus(f, auto = false) {
  f.end = Math.min(Date.now(), f.start + f.planned);
  await save(f);
  toast(auto ? '2 小时到了，记一句做到哪了' : `记下专注 ${C.fmtDuration(f.end - f.start)}`);
  render();
}
A['focus-end'] = d => endFocus(get(d.id));

// ---- 随手记 ----
function noteHtml() {
  const t = state.ui.noteTarget;
  const f = activeFocus();
  const cands = [];
  const add = id => { if (id && get(id) && !cands.includes(id)) cands.push(id); };
  add(t); add(f?.pieceId); todayPieces().forEach(p => add(p.id));
  return `<h3>随手记一句</h3>
    <textarea id="note-text" rows="3" placeholder="此刻在做什么 / 想到什么，一句话。可用输入法的语音输入">${esc(state.ui.noteDraft || '')}</textarea>
    <div style="margin:10px 0 4px" id="note-targets">
      ${cands.map(id => `<span class="chip ${t === id ? 'on' : ''}" data-act="note-target" data-id="${id}">${f?.pieceId === id ? '专注中 · ' : ''}${esc(get(id).name)}</span>`).join('')}
      <span class="chip ${!t ? 'on' : ''}" data-act="note-target" data-id="">散块盒</span>
    </div>
    <div style="margin-bottom:12px"><span class="chip ${state.ui.noteFeedback ? 'on' : ''}" data-act="note-feedback">这是外部反馈</span></div>
    <button class="btn block" data-act="note-save" id="note-save">记下</button>`;
}

A.note = d => {
  state.ui.noteTarget = d.piece || activeFocus()?.pieceId || '';
  state.ui.noteFeedback = false;
  state.ui.noteDraft = '';
  openModal(noteHtml());
  const ta = $('#note-text');
  ta.focus();
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); A['note-save'](); }
  });
};

function refreshNoteModal() {
  state.ui.noteDraft = $('#note-text')?.value || '';
  const html = noteHtml();
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  $('#note-targets').innerHTML = $('#note-targets', tmp).innerHTML;
  $('[data-act="note-feedback"]').classList.toggle('on', !!state.ui.noteFeedback);
}
A['note-target'] = d => { state.ui.noteTarget = d.id; refreshNoteModal(); };
A['note-feedback'] = () => { state.ui.noteFeedback = !state.ui.noteFeedback; refreshNoteModal(); };

A['note-save'] = async () => {
  const text = $('#note-text').value.trim();
  if (!text) return toast('先写一句');
  const pieceId = state.ui.noteTarget || null;
  const n = mk('note', { text, at: Date.now(), pieceId, feedback: !!state.ui.noteFeedback, puzzleId: pieceId ? get(pieceId).puzzleId : mainPuzzle()?.id || null });
  await save(n);
  closeModal();
  toast(pieceId ? '已记下' : '已记下 · 进了散块盒');
  render();
};

// ---- 散块 ----
function piecePickerHtml(title, act, extra = '') {
  const groups = [mainPuzzle(), sidePuzzle(), ...puzzlesIn('paused')].filter(Boolean).map(pz => {
    const ps = piecesOf(pz.id);
    return `<div class="field"><label>${LANES[pz.lane]} · ${esc(pz.name)}</label>
      ${ps.map(p => `<span class="chip" data-act="${act}" data-id="${p.id}" ${extra}>${esc(p.name)}</span>`).join('') || '<div class="muted">没有拼块</div>'}</div>`;
  });
  return `<h3>${title}</h3>${groups.join('') || '<div class="muted">还没有拼图</div>'}`;
}

A['scatter-attach'] = d => { state.ui.attachNote = d.id; openModal(piecePickerHtml('挂到哪一块？', 'attach-to')); };
A['attach-to'] = async d => {
  const n = get(state.ui.attachNote);
  n.pieceId = d.id;
  n.puzzleId = get(d.id).puzzleId;
  await save(n);
  closeModal();
  toast('已挂上');
  render();
};

A['scatter-upgrade'] = d => {
  state.ui.attachNote = d.id;
  const pzs = [mainPuzzle(), sidePuzzle(), ...puzzlesIn('paused')].filter(Boolean);
  if (!pzs.length) return toast('先建一幅拼图');
  openModal(`<h3>升级成哪幅拼图的新拼块？</h3>
    <div class="field"><label>拼块名称<span class="hint">写成一个能交出去的产出</span></label><input type="text" id="up-name" value="${esc(get(d.id).text.slice(0, 40))}"></div>
    ${pzs.map(pz => `<button class="btn block ${pz.lane === 'main' ? '' : 'ghost'}" style="margin-bottom:8px" data-act="upgrade-to" data-pz="${pz.id}">${LANES[pz.lane]} · ${esc(pz.name)}</button>`).join('')}`);
};

async function addPiece(pzId, name) {
  const ps = piecesOf(pzId);
  if (ps.length >= C.MAX_PIECES) { toast('已到 24 块：目标太大，考虑拆成两幅'); return null; }
  const p = mk('piece', { puzzleId: pzId, name, status: 'empty', order: ps.length ? Math.max(...ps.map(x => x.order)) + 1 : 1, evidence: [], today: '' });
  await save(p);
  return p;
}

A['upgrade-to'] = async d => {
  const name = $('#up-name').value.trim();
  if (!name) return toast('写个拼块名称');
  const p = await addPiece(d.pz, name);
  if (!p) return;
  const n = get(state.ui.attachNote);
  n.pieceId = p.id;
  n.puzzleId = d.pz;
  await save(n);
  closeModal();
  toast('已升级成新拼块');
  render();
};

A['scatter-del'] = async d => { await remove(get(d.id)); toast('已删除'); render(); };

// ---- 拼图 ----
A['save-puzzle'] = async d => {
  const v = id => ($('#' + id)?.value || '').trim();
  const old = d.id ? get(d.id) : null;
  const data = {
    name: v('f-name'),
    ...Object.fromEntries(C.PUZZLE_FIELDS.map(([k]) => [k, v('f-' + k)])),
    leads: [0, 1, 2].map(i => ({ id: $('#f-lead-' + i).dataset.lid || C.uid(), name: v('f-lead-' + i), target: Math.max(1, Number(v('f-lead-t-' + i)) || 1) })).filter(l => l.name),
    ifThens: [0, 1, 2].map(i => v('f-if-' + i)),
  };
  const miss = C.puzzleMissing(data);
  if (!data.name) miss.unshift('拼图名称');
  if (miss.length) {
    $('#form-err').innerHTML = `<div class="err-box">还缺：${miss.join('、')}</div>`;
    scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  data.ifThens = data.ifThens.filter(Boolean);
  if (old) {
    Object.assign(old, data);
    await save(old);
    location.hash = `#/puzzle/${old.id}`;
    return;
  }
  const lane = !mainPuzzle() ? 'main' : !sidePuzzle() ? 'side' : null;
  if (!lane) return toast('已有 1 幅主线 + 1 幅副线');
  const pz = mk('puzzle', { ...data, lane });
  await save(pz);
  const names = v('f-pieces').split('\n').map(s => s.trim()).filter(Boolean).slice(0, C.MAX_PIECES);
  if (names.length) {
    await save(...names.map((name, i) => mk('piece', { puzzleId: pz.id, name, status: 'empty', order: i + 1, evidence: [], today: '' })));
  }
  location.hash = `#/puzzle/${pz.id}`;
};

A['add-piece'] = async d => {
  const name = $('#new-piece').value.trim();
  if (!name) return toast('写个拼块名称');
  if (await addPiece(d.pz, name)) render();
};

A.lane = async d => {
  const pz = get(d.id);
  let lane = d.lane;
  if (lane === 'resume') {
    lane = !mainPuzzle() ? 'main' : !sidePuzzle() ? 'side' : null;
    if (!lane) return toast('已有 1 幅主线 + 1 幅副线，先暂停一幅');
  }
  const recs = [pz];
  if (lane === 'main') {
    const m = mainPuzzle();
    if (m && m.id !== pz.id) { m.lane = 'side'; recs.push(m); }
  }
  if (lane === 'done') {
    const pr = progress(pz);
    if (pr.done < pr.total && !confirm(`还有 ${pr.total - pr.done} 块没拼上，确定宣布完成？`)) return;
  }
  pz.lane = lane;
  if (lane !== 'paused' && lane !== 'done') pz.reviseAt = Date.now();
  await save(...recs);
  toast({ main: '已设为主线', side: '已恢复为副线', paused: '已放进暂停区', done: '恭喜，这幅拼图完成了' }[lane]);
  render();
};

A['stop-dialog'] = d => {
  openModal(`<h3>停，还是改？</h3>
    <div class="desc" style="margin-bottom:10px">写一句真实原因，进「半途而废清单」。停 = 移出推进；改 = 换个做法再试 2 周。</div>
    <textarea id="stop-reason-${d.id}" rows="3" placeholder="一句真实原因"></textarea>
    <div class="btns" style="margin-top:12px"><button class="btn danger" data-act="stop-do" data-id="${d.id}" data-a="stop">停</button>
    <button class="btn ghost" data-act="stop-do" data-id="${d.id}" data-a="change">改</button></div>`);
};

A['stop-do'] = async d => {
  const pz = get(d.id);
  const reason = ($('#stop-reason-' + d.id)?.value || '').trim();
  if (!reason) return toast('写一句真实原因');
  const s = mk('stopped', { puzzleId: pz.id, name: pz.name, action: d.a, reason, at: Date.now(), week: C.weekKey() });
  if (d.a === 'stop') pz.lane = 'stopped';
  else pz.reviseAt = Date.now();
  await save(s, pz);
  closeModal();
  toast(d.a === 'stop' ? '已停下，记进半途而废清单' : '已记下，换个做法再试 2 周');
  render();
};

A['lead-plus'] = async d => {
  await save(mk('leadtap', { puzzleId: d.pz, leadId: d.lead, at: Date.now() }));
  render();
};
A['lead-minus'] = async d => {
  const wk = C.weekKey();
  const last = live('leadtap').filter(t => t.leadId === d.lead && C.weekKey(t.at) === wk).sort((a, b) => b.at - a.at)[0];
  if (last) await remove(last);
  render();
};

// ---- 拼块 ----
A['rename-piece'] = async d => {
  const p = get(d.id);
  const name = prompt('拼块名称（写成一个能交出去的产出）', p.name);
  if (!name || !name.trim()) return;
  p.name = name.trim();
  await save(p);
  render();
};

A['delete-piece'] = async d => {
  if (!confirm('删除这一块？挂在上面的记录会回到散块盒。')) return;
  const p = get(d.id);
  const notes = notesOf(p.id);
  notes.forEach(n => { n.pieceId = null; });
  p.deleted = true;
  await save(p, ...notes);
  location.hash = `#/puzzle/${p.puzzleId}`;
};

async function addEvidence(p, e) {
  p.evidence = [...(p.evidence || []), { id: C.uid(), at: Date.now(), ...e }];
  await save(p);
  render();
}

A['evi-link'] = d => openModal(`<h3>加一个链接证据</h3>
  <div class="field"><label>链接</label><input type="url" id="evi-url" placeholder="https://"></div>
  <div class="field"><label>说明<span class="hint">可不填</span></label><input type="text" id="evi-note"></div>
  <button class="btn block" data-act="evi-link-save" data-id="${d.id}">加上</button>`);

A['evi-link-save'] = async d => {
  const url = $('#evi-url').value.trim();
  if (!/^https?:\/\/\S+/.test(url)) return toast('链接要以 http 开头');
  const note = $('#evi-note').value.trim();
  closeModal();
  await addEvidence(get(d.id), { kind: 'link', url, note });
};

A['evi-income'] = d => openModal(`<h3>加一笔收款</h3>
  <div class="field"><label>金额（元）</label><input type="number" id="evi-amount" min="0" step="0.01" inputmode="decimal"></div>
  <div class="field"><label>说明<span class="hint">谁付的、为什么付</span></label><input type="text" id="evi-note"></div>
  <div class="field"><label>收款截图<span class="hint">建议附上</span></label><input type="file" accept="image/*" id="evi-shot"></div>
  <button class="btn block" data-act="evi-income-save" data-id="${d.id}">加上</button>`);

A['evi-income-save'] = async d => {
  const amount = Number($('#evi-amount').value);
  if (!(amount > 0)) return toast('填一个金额');
  const note = $('#evi-note').value.trim();
  const file = $('#evi-shot').files[0];
  let fileId = '';
  if (file) fileId = await storeFile(await compressImage(file), '收款截图');
  closeModal();
  await addEvidence(get(d.id), { kind: 'income', amount, note, fileId });
};

A['evi-del'] = async d => {
  if (!confirm('删除这个证据？')) return;
  const p = get(d.id);
  p.evidence = (p.evidence || []).filter(e => e.id !== d.eid);
  await save(p);
  render();
};

const CHANGE = {};
CHANGE['evi-image'] = async (el) => {
  const file = el.files[0];
  if (!file) return;
  toast('正在压缩图片…');
  const blob = await compressImage(file);
  const fileId = await storeFile(blob, file.name);
  await addEvidence(get(el.dataset.id), { kind: 'image', fileId, note: '' });
};
CHANGE['evi-file'] = async (el) => {
  const file = el.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast('文件超过 20MB，换成链接吧');
  const fileId = await storeFile(file, file.name);
  await addEvidence(get(el.dataset.id), { kind: 'file', fileId, name: file.name });
};

A.place = async d => {
  const p = get(d.id);
  if (!(p.evidence || []).length) return toast('先附一个证据');
  const recs = [p];
  const f = activeFocus();
  if (f?.pieceId === p.id) { f.end = Math.min(Date.now(), f.start + f.planned); recs.push(f); }
  p.status = 'done';
  p.doneAt = Date.now();
  p.today = '';
  let card = cardOf(p.id);
  if (!card) {
    card = mk('card', { pieceId: p.id, puzzleId: p.puzzleId, title: p.name, stage: 'draft', aar: {}, cells: {}, versions: [], gaps: '' });
    recs.push(card);
  }
  await save(...recs);
  const pr = progress(get(p.puzzleId));
  const o = document.createElement('div');
  o.className = 'placed-overlay';
  o.innerHTML = `<div>${singleSvg()}<p>拼上了！${pr.done} / ${pr.total}<br><span class="desc" style="font-weight:400">趁热写经验卡</span></p></div>`;
  document.body.appendChild(o);
  setTimeout(() => {
    o.remove();
    state.ui.cardStep[card.id] = 1;
    location.hash = `#/card/${card.id}`;
    if (pr.done === pr.total) toast('整幅拼图拼完了！可以在拼图页宣布完成', 3500);
  }, 1100);
};

A.unplace = async d => {
  if (!confirm('撤销拼上？经验卡会保留。')) return;
  const p = get(d.id);
  p.status = 'empty';
  p.doneAt = null;
  await save(p);
  render();
};

// ---- 经验卡 ----
A['card-filter'] = d => { state.ui.cardFilter = d.f; render(); };
A['hide-guide'] = () => { state.ui.hideGuide = true; render(); };
A['show-guide'] = () => { state.ui.hideGuide = false; render(); };
A['card-step'] = d => { state.ui.cardStep[d.id] = Number(d.i); render(); };

A['card-save'] = async d => {
  const c = get(d.id);
  const v = id => ($('#' + id)?.value || '').trim();
  c.title = v('c-title') || c.title;
  c.aar = Object.fromEntries(C.AAR.map(([k]) => [k, v('c-aar-' + k)]));
  c.cells = Object.fromEntries(C.CARD_CELLS.map(([k]) => [k, v('c-cell-' + k)]));
  if (!C.cellsComplete(c.cells)) c.stage = 'draft';
  else if (c.stage === 'draft') c.stage = 'carded';
  await save(c);
  if (c.stage === 'draft') {
    toast('已存为草稿：四格写满才能进入「讲」');
    render();
  } else {
    toast('卡片写好了，下一步：讲一遍');
    state.ui.cardStep[c.id] = 2;
    render();
  }
};

A['rec-start'] = async d => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('这个浏览器不支持录音');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('没有麦克风权限：在浏览器设置里允许麦克风'); }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported?.(m));
  const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24000 });
  const chunks = [];
  const cardId = d.id;
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearTimeout(recorder?.timer);
    recorder = null;
    const blob = new Blob(chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] });
    if (blob.size) {
      const c = get(cardId);
      c.audioFileId = await storeFile(blob, '讲解录音');
      await save(c);
      toast('录好了，回放一遍找卡壳的地方');
    }
    render();
  };
  mr.start(1000);
  recorder = { mr, cardId, start: Date.now(), timer: setTimeout(() => mr.state !== 'inactive' && mr.stop(), 10 * 60 * 1000) };
  render();
};
A['rec-stop'] = () => { if (recorder?.mr.state !== 'inactive') recorder?.mr.stop(); };

A['card-told'] = async d => {
  const c = get(d.id);
  c.gaps = ($('#c-gaps')?.value || '').trim();
  if (c.stage === 'carded') { c.stage = 'told'; c.toldAt = Date.now(); }
  await save(c);
  state.ui.cardStep[c.id] = 3;
  render();
};

A['card-version'] = async d => {
  const c = get(d.id);
  const cells = Object.fromEntries(C.CARD_CELLS.map(([k]) => [k, ($('#c-cell-' + k)?.value || '').trim()]));
  if (!C.cellsComplete(cells)) return toast('四格都要写');
  if (C.stableStringify(cells) === C.stableStringify(c.cells)) return toast('没有改动');
  c.versions = [...(c.versions || []), { at: Date.now(), cells: c.cells }];
  c.cells = cells;
  await save(c);
  toast('已保存新版本');
  render();
};

A['card-library'] = async d => {
  const c = get(d.id);
  if (!C.cellsComplete(c.cells)) return toast('四格都要写');
  c.stage = 'library';
  await save(c);
  toast('已入库：这是一份可复用的资产了');
  render();
};
A['card-copy'] = d => copyText(cardText(get(d.id)));

// ---- 周回顾 ----
async function ensureReview(wk) {
  let rv = reviewRec(wk);
  if (!rv) { rv = mk('review', { week: wk, step: 0, done: false, quiz: null, quizResults: {} }); await save(rv); }
  return rv;
}

A['review-next'] = async () => {
  const wk = C.weekKey();
  const rv = await ensureReview(wk);
  if (rv.step === 5) {
    rv.done = true;
    rv.completedAt = Date.now();
    await save(rv);
    toast('本周回顾完成');
    return render();
  }
  rv.step += 1;
  if (rv.step === 2 && !rv.quiz) {
    const pool = live('card').filter(c => c.stage !== 'draft' && C.cellsComplete(c.cells));
    rv.quiz = C.sample(pool, 5).map(c => c.id);
    rv.quizResults = {};
  }
  await save(rv);
  render();
  scrollTo(0, 0);
};
A['review-back'] = async () => { const rv = await ensureReview(C.weekKey()); rv.step = Math.max(0, rv.step - 1); await save(rv); render(); };
A['review-redo'] = async () => { const rv = reviewRec(C.weekKey()); rv.done = false; rv.step = 0; rv.quiz = null; await save(rv); render(); };
A['review-copy'] = () => copyText(C.metricsText(C.computeMetrics(state.recs, C.weekKey()), C.weekKey()));

A['quiz-reveal'] = d => { state.ui.reveal[d.id] = true; render(); };
A['quiz-rate'] = async d => {
  const rv = reviewRec(C.weekKey());
  rv.quizResults = { ...(rv.quizResults || {}), [d.id]: d.r };
  const c = get(d.id);
  c.quiz = [...(c.quiz || []).filter(q => q.week !== rv.week), { week: rv.week, at: Date.now(), result: d.r }];
  await save(rv, c);
  render();
};

A['predict-toggle'] = async d => {
  const nk = C.nextWeekKey();
  let pred = live('predict').find(r => r.week === nk);
  if (!pred) pred = mk('predict', { week: nk, pieceIds: [] });
  const s = new Set(pred.pieceIds);
  if (s.has(d.id)) s.delete(d.id); else s.add(d.id);
  pred.pieceIds = [...s];
  await save(pred);
  render();
};

// ---- 设置 ----
A['sync-save'] = async () => {
  const repo = $('#s-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $('#s-token').value.trim();
  const device = $('#s-device').value.trim() || cfg().device;
  setCfg({ repo, token, device });
  const msg = $('#s-msg');
  if (!token) { msg.innerHTML = '<div class="ok-box">已保存。没填令牌：数据只在这台设备上。</div>'; return; }
  msg.innerHTML = '<div class="ok-box">正在测试连接…</div>';
  try {
    const info = await S.testConnection(cfg());
    msg.innerHTML = info.private
      ? `<div class="ok-box">连上了：${esc(info.name)}（私有仓库）。正在同步…</div>`
      : `<div class="err-box">连上了，但 ${esc(info.name)} 是公开仓库，别人能看到你的记录。请到 GitHub 把它改成私有。</div>`;
    await doSync();
  } catch (e) {
    msg.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
  }
};
A['sync-now'] = () => doSync(true);

A.export = async () => {
  const files = [];
  for (const f of await DB.allFiles()) {
    files.push({ id: f.id, name: f.name, type: f.type, data: C.bytesToB64(new Uint8Array(await f.blob.arrayBuffer())) });
  }
  const data = { app: 'puzzle-progress', version: 1, exportedAt: new Date().toISOString(), records: await DB.allRecords(), files };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `拼图推进备份-${C.dayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.__lastExport = data;
  toast(`已导出 ${data.records.length} 条记录、${files.length} 个附件`);
};

CHANGE.import = async el => {
  const file = el.files[0];
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('这个文件打不开'); }
  await importData(data);
};

async function importData(data) {
  if (data?.app !== 'puzzle-progress') return toast('这不是拼图推进的备份文件');
  for (const f of data.files || []) {
    if (await DB.getFile(f.id)) continue;
    const blob = new Blob([C.b64ToBytes(f.data)], { type: f.type });
    await DB.putFile({ id: f.id, blob, name: f.name, type: f.type, size: blob.size, synced: false });
  }
  const cur = await DB.allRecords();
  const merged = C.mergeRecords(cur, data.records || []);
  await DB.putRecords(merged);
  state.recs = merged;
  index();
  scheduleSync(1000);
  toast(`已导入 ${(data.records || []).length} 条记录`);
  render();
}

A.wipe = async () => {
  if (!confirm('清空这台设备上的全部数据？')) return;
  if (!confirm('再确认一次：清空后，没同步也没导出的内容就找不回来了。')) return;
  await DB.clearAll();
  state.recs = [];
  index();
  localStorage.removeItem('pp.lastSync');
  toast('已清空本机数据');
  location.hash = '#/';
  render();
};

// ================= 启动 =================

function tick() {
  const f = activeFocus();
  if (f && Date.now() >= f.start + f.planned) { endFocus(f, true); return; }
  document.querySelectorAll('[data-clock]').forEach(el => {
    const ff = get(el.dataset.clock);
    if (ff) el.textContent = C.fmtClock(Date.now() - ff.start);
  });
  if (recorder) document.querySelectorAll('[data-rec-clock]').forEach(el => { el.textContent = C.fmtClock(Date.now() - recorder.start); });
}

async function start() {
  state.recs = await DB.allRecords();
  index();
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = A[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve(fn(el.dataset, el, e)).catch(err => { console.error(err); toast('出错了：' + (err.message || err)); });
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    Promise.resolve(CHANGE[el.dataset.change](el)).catch(err => { console.error(err); toast('出错了：' + (err.message || err)); });
  });
  addEventListener('hashchange', () => { closeModal(); render(); scrollTo(0, 0); });
  addEventListener('online', () => { setSync('idle'); doSync(); });
  addEventListener('offline', () => setSync('offline', '网络不通，联网后会自动同步'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { tick(); doSync(); }
  });
  $('#fab').addEventListener('click', () => A.note({}));
  setInterval(tick, 1000);
  render();
  if (sessionStorage.getItem('pp.updated')) { sessionStorage.removeItem('pp.updated'); toast('已更新到新版本'); }
  setTimeout(() => doSync(), 300);

  if ('serviceWorker' in navigator && !/[?&]nosw/.test(location.search)) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 不支持就当普通网页用 */ });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!had) return;
      sessionStorage.setItem('pp.updated', '1');
      if (!modalOpen() && !isTyping() && !recorder) location.reload();
    });
  }
}

// 给自测脚本用的入口
const idle = async () => { while (syncing) await new Promise(r => setTimeout(r, 50)); };
window.PP = {
  state, save, render, doSync, importData, C, DB, get, live,
  syncNow: async () => { await idle(); await doSync(); await idle(); return state.sync; },
  reload: async () => { state.recs = await DB.allRecords(); index(); render(); },
};

start();
