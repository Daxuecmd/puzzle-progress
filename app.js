import * as C from './core.js';
import * as DB from './db.js';
import * as S from './sync.js';
import * as M from './motion.js';

export const VERSION = '1.2.0';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOUR2 = 2 * 3600 * 1000;
const DAY = 86400000;

const LANES = { main: '主线', side: '副线', paused: '暂停区', done: '已完成', stopped: '已停止' };
const STAGES = { draft: '草稿', carded: '待讲', told: '已讲', library: '已入库' };
const STAGE_STEP = { draft: 1, carded: 2, told: 3, library: 3 };
const STEPS = [
  ['做', '2 小时专注', '不刷碎片，不囤干货。只做能产生结果的事：读书、方案、实践。'],
  ['卡', '30 分钟提炼', '核心、逻辑、方法、边界。写不清，就是没学透。'],
  ['讲', '5 到 10 分钟费曼', '不看稿讲清：痛点、原理、步骤、行动。卡壳的地方就是认知漏洞。'],
  ['送', '迭代成资产', '补齐漏洞，精简表达，变成别人也能直接用的东西。'],
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

// 电脑自动入账写进来的记录（type: 'auto'），格式见工单区 D002
const autos = kind => live('auto').filter(a => a.kind === kind);
const todayAutos = () => autos('day').filter(a => a.day === C.dayStr()).sort((a, b) => String(a.projectName).localeCompare(String(b.projectName), 'zh'));
const suggestions = () => autos('suggest').filter(s => !s.dismissed && get(s.pieceId) && get(s.pieceId).status !== 'done');

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
  if (!navigator.onLine || state.sync.status === 'offline') { cls = 'off'; text = '离线，联网后同步'; }
  else if (!c.token) text = '只在本机';
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

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"/></svg>',
};

function top(title, { back, home } = {}) {
  return `<div class="top">
    ${back ? `<button class="back" data-act="go" data-to="${esc(back)}" aria-label="返回">${ICON.back}</button>` : ''}
    <div class="grow">${home ? `<div class="today">${fmtDate(Date.now())}</div>` : `<div class="page-title">${esc(title)}</div>`}</div>
    ${syncBadge()}
    ${home ? `<button class="icon-btn" data-act="go" data-to="#/settings" aria-label="设置">${ICON.gear}</button>` : ''}
  </div>`;
}

let svgSeq = 0;

// 动效模型存在这台设备上（设置里选）
const motionModel = () => { try { return M.modelOf(localStorage.getItem('pp.motion')).id; } catch { return M.DEFAULT_MODEL; } };

// 画面要用的任务情况：进度、落后程度、专注中、拼上的块（星图按先后连线）
function sceneState(pz, ps, J, arriving) {
  const done = ps.map((p, i) => ({ p, i })).filter(x => x.p.status === 'done');
  const p = ps.length ? done.length / ps.length : 0;
  const ai = ps.findIndex(x => x.id === arriving);
  return {
    p,
    p0: ai >= 0 ? Math.max(0, done.length - 1) / ps.length : null,
    u: M.urgency(pz, p),
    focus: !!activeFocus(),
    newest: ai >= 0 ? ai : -1,
    done: done.map(({ p: x, i }) => ({ i, at: x.doneAt, cx: J.pieces[i].cx, cy: J.pieces[i].cy })),
  };
}

// 整幅拼图：拼上的块露出这幅拼图自己的画面，空位是灰的；画面按动效模型跟着任务情况动
// arriving：刚拼上的那块先空着，再从下方飞进自己的位置（落位动画用）
// reveal：打开拼图页时已拼上的块按模型的顺序依次亮出来
function jigsawSvg(pz, { mini = false, arriving = null, model = motionModel(), reveal = false } = {}) {
  const ps = piecesOf(pz.id);
  if (!ps.length) return `<div class="empty">还没有拼块，先在下面加一块。</div>`;
  const J = C.jigsaw(ps.length);
  const W = J.cols * J.size, H = J.rows * J.size;
  const uid = 'j' + (++svgSeq);
  const st = sceneState(pz, ps, J, arriving);
  const art = M.scene(model, pz.id, W, H, uid, st);
  const sts = ps.map(p => (p.id === arriving ? 'empty' : pieceState(p)));
  const doneIdx = sts.map((s, i) => (s === 'done' ? i : -1)).filter(i => i >= 0);
  const ai = ps.findIndex(p => p.id === arriving);
  // 亮出来的顺序：晨光从上往下，潮汐从下往上，星图按拼上的先后
  const revealOrder = model === 'tide' ? [...doneIdx].reverse() : model === 'stars' ? [...doneIdx].sort((a, b) => (ps[a].doneAt || 0) - (ps[b].doneAt || 0)) : doneIdx;
  const covers = reveal && model !== 'still' ? revealOrder.map((i, k) => `<path class="m-cover" style="--k:${k}" d="${J.pieces[i].d}"/>`).join('') : '';
  const slots = J.pieces.map((g, i) => (sts[i] === 'done' ? '' : `<g class="${sts[i]}"><path class="fill" d="${g.d}"/></g>`)).join('');
  // 进行中的块描边最后画，免得被邻块的缝盖住
  const order = J.pieces.map((_, i) => i).sort((a, b) => (sts[a] === 'doing') - (sts[b] === 'doing'));
  const seams = order.map(i => { const g = J.pieces[i]; return `<g class="${sts[i]} ${mini ? '' : 'tap'}" data-piece="${ps[i].id}" ${mini ? '' : `data-act="go" data-to="#/piece/${ps[i].id}"`}>
      <path class="seam" d="${g.d}" style="fill:transparent"/>${mini || sts[i] === 'done' ? '' : `<text x="${g.cx}" y="${g.cy}">${i + 1}</text>`}</g>`; }).join('');
  return `<svg class="jig ${mini ? 'mini' : ''} m-${model} ${st.focus ? 'focusing' : ''} ${ai >= 0 ? 'rising' : ''}" viewBox="-3 -3 ${W + 6} ${H + 6}" role="img" aria-label="${esc(pz.name)}：已拼 ${doneIdx.length} / ${ps.length}">
    <defs>${art.defs}<clipPath id="${uid}-c">${doneIdx.map(i => `<path d="${J.pieces[i].d}"/>`).join('')}</clipPath>
      <clipPath id="${uid}-all">${J.pieces.map(g => `<path d="${g.d}"/>`).join('')}</clipPath>
      ${ai >= 0 ? `<clipPath id="${uid}-a"><path d="${J.pieces[ai].d}"/></clipPath>
      <linearGradient id="${uid}-sh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` : ''}</defs>
    <g class="ghost-art" clip-path="url(#${uid}-all)">${art.body}</g>
    ${slots}
    ${doneIdx.length ? `<g clip-path="url(#${uid}-c)">${art.body}</g>` : ''}
    ${covers}
    ${seams}
    ${ai >= 0 ? `<g class="arrive"><g clip-path="url(#${uid}-a)">${art.body}</g><path class="arrive-edge" d="${J.pieces[ai].d}"/></g>
      <g clip-path="url(#${uid}-all)"><rect class="sheen" x="${-W * 0.6}" y="0" width="${W * 0.6}" height="${H}" fill="url(#${uid}-sh)"/></g>` : ''}
  </svg>`;
}

// 单独一块：拼上了就是那一小块风景
function pieceArt(p, { big = false } = {}) {
  const ps = piecesOf(p.puzzleId);
  const i = ps.findIndex(x => x.id === p.id);
  const pz = get(p.puzzleId);
  if (i < 0 || !pz) return '';
  const J = C.jigsaw(ps.length);
  const W = J.cols * J.size, H = J.rows * J.size;
  const g = J.pieces[i];
  const x = g.cx - 80, y = g.cy - 80;
  const uid = 'p' + (++svgSeq);
  const st = pieceState(p);
  let inner;
  if (st === 'done') {
    const art = M.scene(motionModel(), pz.id, W, H, uid, sceneState(pz, ps, J, null));
    inner = `<defs>${art.defs}<clipPath id="${uid}-c"><path d="${g.d}"/></clipPath></defs><g clip-path="url(#${uid}-c)">${art.body}</g>`;
  } else {
    inner = `<path d="${g.d}" fill="${st === 'doing' ? '#F7F8F5' : 'var(--slot)'}" ${st === 'doing' ? 'stroke="var(--ink)" stroke-width="3" stroke-dasharray="7 6"' : ''}/>`;
  }
  return `<svg class="${big ? 'piece-hero' : 'pc'}" viewBox="${x} ${y} 160 160" aria-hidden="true">${inner}</svg>`;
}

const pcIcon = (cls = '') => `<svg class="pc pc-icon ${cls}" viewBox="-30 -30 160 160" aria-hidden="true"><path d="${C.singlePiece()}"/></svg>`;

function progress(pz) {
  const ps = piecesOf(pz.id);
  return { done: ps.filter(p => p.status === 'done').length, total: ps.length };
}

// 专注中：顶部一条细条，不抢拼图和今天的块
function focusBar(f) {
  const p = get(f.pieceId);
  const pctDone = Math.min(100, ((Date.now() - f.start) / f.planned) * 100);
  return `<div class="focus" title="满 2 小时自动结束">
    <span class="beat" aria-hidden="true"></span>
    <div class="what ellipsis tap" data-act="go" data-to="#/piece/${f.pieceId}">${esc(p?.name || '')}</div>
    <div class="clock" data-clock="${f.id}">${C.fmtClock(Date.now() - f.start)}</div>
    <button class="btn sm" data-act="focus-end" data-id="${f.id}">结束</button>
    <div class="bar"><i data-bar="${f.id}" style="width:${pctDone.toFixed(1)}%"></i></div>
  </div>`;
}

function pieceRow(p) {
  const st = pieceState(p);
  return `<div class="row-item tap" data-act="go" data-to="#/piece/${p.id}">
    ${pieceArt(p)}
    <div class="grow"><div class="name ${st} ellipsis">${esc(p.name)}</div></div>
    <span class="state ${st}">${PIECE_STATE[st]}</span>
  </div>`;
}

// ================= 页面：首页 =================

function pageHome() {
  const m = mainPuzzle();
  const f = activeFocus();
  const today = todayPieces();
  const scat = scatterNotes();
  const lead = leadSummary();
  let h = top('', { home: true });
  if (f) h += focusBar(f);

  if (!m) {
    h += `<div class="puzzle-head"><h1>一幅拼图，<br>一个要拿到的结果</h1>
      <p class="lede">每拼上一块，就露出一块风景。先定下你最想拿到的那个结果。</p></div>
      <div class="section"><button class="btn block" data-act="go" data-to="#/new-puzzle">新建主线拼图</button>
      ${cfg().token ? '' : `<p class="faint" style="text-align:center;margin-top:12px">别的设备上已经有数据？<a class="link" href="#/settings">先开同步</a></p>`}</div>`;
    return h;
  }

  // 第一屏的顺序：能拼上的 → 今天做这几块 → 主线拼图一行 → 今天电脑上做了
  for (const s of suggestions()) {
    const p = get(s.pieceId);
    h += `<div class="suggest" id="suggest-${esc(s.id)}">
      ${pieceArt(p)}
      <div class="grow"><div class="name">可以拼上：${esc(p.name)}</div><div class="small">${esc(s.text || '')}</div>
        <div class="btns"><button class="btn sm" data-act="suggest-place" data-id="${esc(s.id)}">拼上</button>
        <button class="btn sm soft" data-act="suggest-dismiss" data-id="${esc(s.id)}">忽略</button></div></div>
    </div>`;
  }

  h += `<div class="section first" id="home-today"><div class="section-head"><h2>今天做这几块</h2>${today.length ? `<button class="link" data-act="pick-today">调整</button>` : ''}</div>`;
  if (!today.length) {
    h += `<div class="sheet pad"><p style="margin:0 0 14px;color:var(--ink-2)">开工前挑 1 到 3 块，今天只做这几块。</p>
      <button class="btn" data-act="pick-today">挑今天的块</button></div>`;
  } else {
    h += `<div class="sheet">${today.map(p => {
      const focusing = f?.pieceId === p.id;
      return `<div class="row-item today-row">
        ${pieceArt(p)}
        <div class="grow tap" data-act="go" data-to="#/piece/${p.id}"><div class="name ellipsis">${esc(p.name)}</div>
          <div class="faint">${get(p.puzzleId)?.lane === 'side' ? '副线，' : ''}已专注 ${C.fmtDuration(focusTotal(p.id))}，记了 ${notesOf(p.id).length} 条</div></div>
        ${focusing ? '<span class="state doing">专注中</span>' : f ? '' : `<button class="btn sm line" data-act="focus-start" data-id="${p.id}">专注</button>`}
      </div>`;
    }).join('')}</div>`;
  }
  h += `</div>`;

  const pr = progress(m);
  h += `<div class="main-row tap" data-act="go" data-to="#/puzzle/${m.id}" id="home-main">
    <div class="thumb">${jigsawSvg(m, { mini: true })}</div>
    <div class="grow"><div class="count"><b class="num">${pr.done}</b><span> / ${pr.total}</span></div>
      <div class="name">${esc(m.name)}</div>
      <div class="faint">${esc(daysLeft(m.deadline))}，${esc(m.acceptor)}说了算</div></div>
  </div>`;

  const ta = todayAutos();
  if (ta.length) {
    h += `<div class="section" id="home-auto"><div class="section-head"><h2>今天电脑上做了</h2><span class="faint">电脑自动记下</span></div>
      <div class="sheet">${ta.map(a => {
        const lines = a.lines || [];
        const open = state.ui.autoOpen?.[a.id];
        const shown = open ? lines : lines.slice(0, 3);
        return `<div class="auto-item"><div class="proj">${esc(a.projectName || a.project)}</div>
          <ul>${shown.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
          ${lines.length > 3 ? `<button class="link quiet" data-act="auto-more" data-id="${esc(a.id)}">${open ? '收起' : `还有 ${lines.length - 3} 条`}</button>` : ''}</div>`;
      }).join('')}</div></div>`;
  }

  h += `<div class="meta-line">
    <a href="#/scatter" class="${scat.length ? 'warn' : ''}">${scat.length ? `${scat.length} 条记录没归位` : '散块盒是空的'}</a>
    <span>本周引领动作 <span class="num">${lead.done}/${lead.target}</span></span>
  </div>`;

  const rv = live('review').find(r => r.week === C.weekKey());
  if (new Date().getDay() === 0 && !rv?.done) {
    h += `<div class="section"><button class="btn block line" data-act="go" data-to="#/review">今天是周日，做 20 分钟周回顾</button></div>`;
  }
  return h;
}

// ================= 页面：拼图列表 / 详情 / 编辑 =================

function puzzleRow(pz) {
  const pr = progress(pz);
  return `<div class="row-item tap" data-act="go" data-to="#/puzzle/${pz.id}">
    <div style="width:64px;flex:none">${jigsawSvg(pz, { mini: true })}</div>
    <div class="grow"><div class="name ellipsis">${esc(pz.name)}</div>
      <div class="faint">${LANES[pz.lane]}，已拼 ${pr.done} / ${pr.total}${pz.deadline && ['main', 'side'].includes(pz.lane) ? '，' + esc(daysLeft(pz.deadline)) : ''}</div></div>
  </div>`;
}

function pagePuzzles() {
  const full = mainPuzzle() && sidePuzzle();
  let h = top('');
  h += `<h1 style="margin:4px 2px 4px">拼图</h1><p class="lede" style="margin:0 2px 18px">同时最多一幅主线、一幅副线。</p>`;
  const act = puzzlesIn('main', 'side');
  h += `<div class="sheet">${act.length ? act.map(puzzleRow).join('') : '<div class="empty">还没有在推进的拼图。</div>'}</div>`;
  h += `<div style="margin-top:14px"><button class="btn block ${act.length ? 'soft' : ''}" data-act="go" data-to="#/new-puzzle" ${full ? 'disabled' : ''} id="new-puzzle-btn">新建拼图</button>
    ${full ? `<p class="faint" style="text-align:center;margin:8px 0 0">已有 1 幅主线 + 1 幅副线，先暂停或结束一幅再新建</p>` : ''}</div>`;
  const paused = puzzlesIn('paused');
  if (paused.length) h += `<div class="section"><div class="section-head"><h2>暂停区</h2></div><div class="sheet">${paused.map(puzzleRow).join('')}</div></div>`;
  const done = puzzlesIn('done');
  if (done.length) h += `<div class="section"><div class="section-head"><h2>拼完的</h2></div><div class="sheet">${done.map(puzzleRow).join('')}</div></div>`;
  const stops = live('stopped').sort((a, b) => b.at - a.at);
  h += `<div class="section"><div class="section-head"><h2>半途而废清单</h2></div>
    <div class="sheet">${stops.length ? stops.map(s => `<div class="row-item"><div class="grow">
      <div class="name">${s.action === 'stop' ? '停了' : '换做法'}：${esc(s.name)}</div><div class="small pre">${esc(s.reason)}</div><div class="faint">${fmtTime(s.at)}</div></div></div>`).join('')
      : '<div class="empty">停下或转向时，在这里写一句真实原因。</div>'}</div></div>`;
  return h;
}

// 每次打开 App 后第一次看某幅拼图，已拼上的块依次亮出来；之后不再重复
function firstLook(id) {
  state.ui.looked = state.ui.looked || new Set();
  if (state.ui.looked.has(id)) return false;
  state.ui.looked.add(id);
  return true;
}

function pagePuzzle(id) {
  const pz = get(id);
  if (!pz) return top('拼图', { back: '#/puzzles' }) + '<div class="empty">这幅拼图不存在了。</div>';
  const ps = piecesOf(pz.id);
  const pr = progress(pz);
  const wk = C.weekKey();
  let h = top(LANES[pz.lane], { back: '#/puzzles' });
  h += `<div class="puzzle-head" style="margin-top:0"><h1>${esc(pz.name)}</h1>
    <p class="lede">已拼 <span class="num">${pr.done} / ${pr.total}</span>，${esc(daysLeft(pz.deadline))}</p></div>
  <div class="tray" style="margin-top:16px">${jigsawSvg(pz, { reveal: firstLook(pz.id) })}</div>
  <p class="faint" style="text-align:center;margin:10px 0 0">点一块进去</p>`;

  h += `<div class="section"><div class="section-head"><h2>拼块</h2><span class="faint num">${ps.length} / ${C.MAX_PIECES}</span></div>
    <div class="sheet">${ps.map(pieceRow).join('')}
      <div class="row-item"><input type="text" id="new-piece" class="grow" placeholder="新拼块：写成一个能交出去的产出" ${ps.length >= C.MAX_PIECES ? 'disabled' : ''}>
      <button class="btn sm" data-act="add-piece" data-pz="${pz.id}" ${ps.length >= C.MAX_PIECES ? 'disabled' : ''}>加一块</button></div>
    </div>
    ${ps.length >= C.MAX_PIECES ? '<p class="faint">已到 24 块：目标太大，拆成两幅拼图吧。</p>' : ''}</div>`;

  h += `<div class="section"><div class="section-head"><h2>这周的引领动作</h2></div><div class="sheet">
    ${(pz.leads || []).map(l => {
      const n = leadCount(l, wk), t = Number(l.target) || 1;
      return `<div class="row-item"><div class="grow"><div class="name">${esc(l.name)}</div><div class="faint">本周 <span class="num">${n} / ${t}</span>${n >= t ? '，做够了' : ''}</div></div>
        <button class="btn sm soft" data-act="lead-minus" data-pz="${pz.id}" data-lead="${l.id}" ${n ? '' : 'disabled'} aria-label="减一次">−</button>
        <button class="btn sm ${n >= t ? 'soft' : ''}" data-act="lead-plus" data-pz="${pz.id}" data-lead="${l.id}">做了一次</button></div>`;
    }).join('')}</div></div>`;

  h += `<div class="section"><div class="section-head"><h2>被打断时</h2></div><div class="sheet">
    ${(pz.ifThens || []).map(s => `<div class="row-item"><div class="grow small pre" style="color:var(--ink)">${esc(s)}</div></div>`).join('')}</div></div>`;

  h += `<div class="section"><div class="section-head"><h2>目标</h2><button class="link" data-act="go" data-to="#/edit-puzzle/${pz.id}">编辑</button></div>
    <dl class="sheet" style="margin:0">${C.PUZZLE_FIELDS.map(([k, label]) => `<div class="kv"><dt>${label}</dt><dd>${esc(pz[k])}</dd></div>`).join('')}</dl></div>`;

  const btns = [];
  if (pz.lane === 'side') btns.push(`<button class="btn sm line" data-act="lane" data-id="${pz.id}" data-lane="main">设为主线</button>`);
  if (['main', 'side'].includes(pz.lane)) {
    btns.push(`<button class="btn sm line" data-act="lane" data-id="${pz.id}" data-lane="done">宣布完成</button>`);
    btns.push(`<button class="btn sm soft" data-act="lane" data-id="${pz.id}" data-lane="paused">放进暂停区</button>`);
    btns.push(`<button class="btn sm warn" data-act="stop-dialog" data-id="${pz.id}">停下或换做法</button>`);
  } else {
    btns.push(`<button class="btn sm line" data-act="lane" data-id="${pz.id}" data-lane="resume">恢复推进</button>`);
  }
  h += `<div class="section btns">${btns.join('')}</div>`;
  return h;
}

function pageEditPuzzle(id) {
  const editing = id ? get(id) : null;
  if (!editing && mainPuzzle() && sidePuzzle()) {
    return top('新建拼图', { back: '#/puzzles' }) + `<div class="notice bad">已有 1 幅主线 + 1 幅副线。先把一幅放进暂停区或宣布完成 / 停下，再新建。</div>
      <button class="btn" data-act="go" data-to="#/puzzles">回拼图页</button>`;
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
  h += `<h1 style="margin:4px 2px 6px">${editing ? '改一改这幅拼图' : '你要拿到什么结果？'}</h1>
    <p class="lede" style="margin:0 2px 18px">五项都要写，缺一项就开始不了。</p>
    <div id="form-err"></div>
    <div class="sheet pad">
    <div class="field"><label for="f-name">拼图名称</label><input type="text" id="f-name" value="${esc(d.name)}" placeholder="一句话说清这幅拼图"></div>
    ${C.PUZZLE_FIELDS.map(([k, label, hint]) => `<div class="field"><label for="f-${k}">${label}<span class="hint">${hint}</span></label>
      ${k === 'deadline' ? `<input type="date" id="f-${k}" value="${esc(d[k])}">` : `<input type="text" id="f-${k}" value="${esc(d[k])}" placeholder="${esc(ph[k] || '')}">`}</div>`).join('')}
  </div>
  <div class="section"><div class="section-head"><h2>每周引领动作</h2><span class="faint">2 到 3 个，自己能控制、能计数</span></div><div class="sheet pad">
    ${leads.slice(0, 3).map((l, i) => `<div class="btns" style="flex-wrap:nowrap;align-items:center;${i ? 'margin-top:10px' : ''}">
      <input type="text" style="flex:1;min-width:0" id="f-lead-${i}" data-lid="${esc(l.id)}" value="${esc(l.name)}" placeholder="${i === 0 ? '例：每周约 2 位客户看演示' : i === 1 ? '例：每周发 3 份报价' : '可以不填'}">
      <input type="number" id="f-lead-t-${i}" value="${esc(l.target || 1)}" min="1" max="50" style="width:64px;flex:none" aria-label="每周次数"><span class="faint" style="flex:none">次/周</span></div>`).join('')}
  </div></div>
  <div class="section"><div class="section-head"><h2>被打断时怎么办</h2><span class="faint">写 3 条</span></div><div class="sheet pad">
    ${ifs.slice(0, 3).map((s, i) => `<div class="field" style="${i === 2 ? 'margin:0' : ''}"><textarea id="f-if-${i}" rows="2" aria-label="第 ${i + 1} 条" placeholder="${['如果有人临时找我做别的，我就先记进散块盒，主线 2 小时做完再处理', '如果卡住超过半天，我就先做不依赖它的块', '如果刷手机超过 15 分钟，我就打开拼图看今天的块'][i]}">${esc(s)}</textarea></div>`).join('')}
  </div></div>`;
  if (!editing) {
    h += `<div class="section"><div class="section-head"><h2>先拆几块</h2><span class="faint">一行一块，以后还能加</span></div>
      <div class="sheet pad"><textarea id="f-pieces" rows="5" aria-label="拼块" placeholder="每块写成一个能交出去的产出，例如：&#10;报价单&#10;第一次演示录屏"></textarea></div></div>`;
  }
  h += `<div class="section"><button class="btn block" data-act="save-puzzle" data-id="${editing ? editing.id : ''}" data-lane="${lane}">${editing ? '保存' : '开始这幅拼图'}</button></div>`;
  return h;
}

// ================= 页面：拼块 =================

function pagePiece(id) {
  const p = get(id);
  if (!p) return top('拼块', { back: '#/' }) + '<div class="empty">这块不存在了。</div>';
  const pz = get(p.puzzleId);
  const idx = piecesOf(p.puzzleId).findIndex(x => x.id === id);
  const st = pieceState(p);
  const f = activeFocus();
  const notes = notesOf(id);
  const ev = p.evidence || [];
  let h = top(pz?.name || '', { back: pz ? `#/puzzle/${pz.id}` : '#/' });
  if (f && f.pieceId === id) h += focusBar(f);
  h += pieceArt(p, { big: true });
  h += `<div style="text-align:center;margin:0 8px">
    <div class="faint">第 ${idx + 1} 块，${PIECE_STATE[st]}</div>
    <h1 style="margin-top:4px">${esc(p.name)}</h1>
    <p class="small" style="margin:6px 0 0">专注 ${C.fmtDuration(focusTotal(id))} <button class="link quiet" style="margin-left:10px" data-act="rename-piece" data-id="${id}">改名</button></p>
    <p class="small" style="margin:2px 0 0" id="piece-refs">${(p.refs || []).length ? `关联工单 <span class="num">${p.refs.map(esc).join('、')}</span> <button class="link quiet" style="margin-left:6px" data-act="edit-refs" data-id="${id}">改</button>`
      : `<button class="link quiet" data-act="edit-refs" data-id="${id}">关联工单</button>`}</p>
  </div>`;
  if (p.status !== 'done') {
    h += `<div class="btns" style="justify-content:center;margin-top:16px">
      ${f ? '' : `<button class="btn" data-act="focus-start" data-id="${id}">开始专注 2 小时</button>`}
      ${isToday(p) ? `<button class="btn soft" data-act="today-off" data-id="${id}">移出今天</button>` : `<button class="btn line" data-act="today-on" data-id="${id}">加入今天</button>`}
    </div>`;
  }

  h += `<div class="section" id="evidence"><div class="section-head"><h2>证据</h2><span class="faint">拼上前至少附一项</span></div>
    <div class="sheet">${ev.length ? ev.map(e => evidenceRow(p, e)).join('') : '<div class="empty">链接、图片、文件或收款，能让别人看见这块确实做出来了。</div>'}</div>
    <div class="btns" style="margin-top:10px">
      <button class="btn sm soft" data-act="evi-link" data-id="${id}">加链接</button>
      <label class="btn sm soft">加图片<input type="file" accept="image/*" hidden data-change="evi-image" data-id="${id}"></label>
      <label class="btn sm soft">加文件<input type="file" hidden data-change="evi-file" data-id="${id}"></label>
      <button class="btn sm soft" data-act="evi-income" data-id="${id}">记一笔收款</button>
    </div></div>`;

  if (p.status === 'done') {
    const card = cardOf(id);
    h += `<div class="section"><div class="notice good">${fmtTime(p.doneAt)} 拼上</div>
      <div class="btns">${card ? `<button class="btn" data-act="go" data-to="#/card/${card.id}">经验卡：${STAGES[card.stage]}</button>` : ''}
      <button class="btn soft" data-act="unplace" data-id="${id}">撤销拼上</button></div></div>`;
  } else {
    h += `<div class="section"><button class="btn block" id="place-btn" data-act="place" data-id="${id}" ${ev.length ? '' : 'disabled'}>拼上这一块</button>
      ${ev.length ? '' : '<p class="faint" style="text-align:center;margin-top:8px">先附一个证据</p>'}</div>`;
  }

  h += `<div class="section"><div class="section-head"><h2>随手记</h2><button class="link" data-act="note" data-piece="${id}">记一句</button></div>
    <div class="sheet">${notes.length ? notes.map(n => `<div class="row-item"><div class="grow"><div class="pre">${esc(n.text)}</div><div class="faint">${fmtTime(n.at)}${n.feedback ? '，外部反馈' : ''}</div></div></div>`).join('') : '<div class="empty">做的时候随手记一句，拼上后写经验卡会用到。</div>'}</div></div>`;
  h += `<p style="text-align:center;margin-top:26px"><button class="link quiet" data-act="delete-piece" data-id="${id}">删除这块</button></p>`;
  return h;
}

function evidenceRow(p, e) {
  const del = `<button class="link quiet" data-act="evi-del" data-id="${p.id}" data-eid="${e.id}">删除</button>`;
  const when = `<div class="faint">${fmtTime(e.at)}</div>`;
  if (e.kind === 'link' && !/^https?:/i.test(e.url || '')) return `<div class="row-item evi"><div class="ico">电脑</div><div class="grow"><div>${esc(e.note || e.text || '电脑上的文件')}</div><div class="faint path">${esc(e.url)}</div>${when}</div>${del}</div>`;
  if (e.kind === 'link') return `<div class="row-item evi"><div class="ico">链接</div><div class="grow"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.note || e.url)}</a>${when}</div>${del}</div>`;
  if (e.kind === 'image') return `<div class="row-item evi"><img data-file="${esc(e.fileId)}" alt="证据图片"><div class="grow">${esc(e.note || '图片')}${when}</div>${del}</div>`;
  if (e.kind === 'file') return `<div class="row-item evi"><div class="ico">文件</div><div class="grow"><a data-file="${esc(e.fileId)}" download="${esc(e.name)}">${esc(e.name)}</a>${when}</div>${del}</div>`;
  return `<div class="row-item evi">${e.fileId ? `<img data-file="${esc(e.fileId)}" alt="收款截图">` : '<div class="ico">¥</div>'}<div class="grow"><b>收款 ¥${esc(e.amount)}</b> ${esc(e.note || '')}${when}</div>${del}</div>`;
}

// ================= 页面：散块盒 =================

function scatterItem(n) {
  return `<div class="row-item" style="align-items:flex-start">${pcIcon('loose')}
    <div class="grow"><div class="pre">${esc(n.text)}</div><div class="faint">${fmtTime(n.at)}${n.feedback ? '，外部反馈' : ''}</div>
      <div class="btns" style="margin-top:10px">
        <button class="btn sm line" data-act="scatter-attach" data-id="${n.id}">挂到某块</button>
        <button class="btn sm soft" data-act="scatter-upgrade" data-id="${n.id}">变成新拼块</button>
        <button class="btn sm soft" data-act="scatter-del" data-id="${n.id}">删除</button>
      </div></div></div>`;
}

function pageScatter() {
  const list = scatterNotes();
  let h = top('', { back: '#/' });
  h += `<h1 style="margin:4px 2px 6px">散块盒</h1>
    <p class="lede" style="margin:0 2px 18px">挂不到任何一块上的记录，就是偏离的地方。每周清空一次。</p>`;
  h += `<div class="sheet">${list.length ? list.map(scatterItem).join('') : '<div class="empty">空的，这周没有跑偏。</div>'}</div>`;
  return h;
}

// ================= 页面：经验卡 =================

function pageCards() {
  const filter = state.ui.cardFilter || 'all';
  const all = live('card');
  const cards = all.filter(c => filter === 'all' || c.stage === filter).sort((a, b) => b.updatedAt - a.updatedAt);
  const open = state.ui.glyph;
  let h = top('');
  h += `<div class="motto"><h1>以输出倒逼输入，<br>用实践校准认知</h1></div>
    <div class="glyphs">${STEPS.map(([ch, title], i) => `<button class="glyph" data-act="glyph" data-i="${i}" aria-expanded="${open === i}" style="${open === i ? 'box-shadow:inset 0 0 0 2px var(--ink)' : ''}"><b>${ch}</b><span>${title}</span></button>`).join('')}</div>
    ${open != null ? `<div class="glyph-detail sheet pad"><p><b>${STEPS[open][0]}</b>${STEPS[open][2]}</p></div>` : ''}`;
  h += `<div class="section"><div style="margin-bottom:6px">${[['all', '全部'], ...Object.entries(STAGES)].map(([k, v]) =>
    `<button class="chip ${filter === k ? 'on' : ''}" data-act="card-filter" data-f="${k}">${v} <span class="num">${k === 'all' ? all.length : all.filter(c => c.stage === k).length}</button></button>`).join('')}</div>`;
  h += `<div class="sheet">${cards.length ? cards.map(c => `<div class="row-item tap card-row" data-act="go" data-to="#/card/${c.id}">
      <div class="grow"><div class="name">${esc(c.title)}</div><div class="core ellipsis">${esc(c.cells?.core || '还没提炼')}</div></div>
      <span class="state ${c.stage === 'library' ? 'done' : c.stage === 'draft' ? '' : 'doing'}">${STAGES[c.stage]}</span></div>`).join('')
    : '<div class="empty">拼上一块，这里就会多一张经验卡。</div>'}</div></div>`;
  return h;
}

let recorder = null;

function pageCard(id) {
  const c = get(id);
  if (!c) return top('经验卡', { back: '#/cards' }) + '<div class="empty">这张卡不存在了。</div>';
  const p = get(c.pieceId);
  const reach = STAGE_STEP[c.stage];
  const cur = state.ui.cardStep[id] ?? reach;
  let h = top(get(c.puzzleId)?.name || '经验卡', { back: '#/cards' });
  h += `<div style="margin:0 2px 18px"><h1>${esc(c.title)}</h1>
    <p class="lede"><span id="card-stage">${STAGES[c.stage]}</span></p></div>`;
  h += `<div class="stepper">${STEPS.map(([ch, title], i) => `<button class="step ${i === cur ? 'cur' : i <= reach ? 'passed' : ''}" data-step="${i}"
      ${i <= reach && i !== cur ? `data-act="card-step" data-id="${id}" data-i="${i}"` : ''} ${i > reach ? 'disabled' : ''} aria-label="${ch}：${title}"><b>${ch}</b><span>${i < reach ? '做完了' : i === cur ? '现在' : i <= reach ? '可回看' : '还没到'}</span></button>`).join('')}</div>`;
  h += `<div class="step-intro"><h2>${STEPS[cur][0]}，${STEPS[cur][1]}</h2><p>${STEPS[cur][2]}</p></div>`;
  h += `<div class="sheet pad">${cardStepBody(c, p, cur)}</div>`;
  return h;
}

function cardStepBody(c, p, i) {
  if (i === 0) {
    const notes = p ? notesOf(p.id) : [];
    return `<p style="margin:0 0 12px">这一块专注了 <b>${C.fmtDuration(p ? focusTotal(p.id) : 0)}</b>，随手记了 ${notes.length} 条。</p>
      <div class="cells">${notes.map(n => `<div class="cell"><div>${esc(n.text)}</div><span class="faint">${fmtTime(n.at)}</span></div>`).join('')}</div>
      <button class="btn block" style="margin-top:14px" data-act="card-step" data-id="${c.id}" data-i="1">去提炼卡片</button>`;
  }
  if (i === 1) {
    return `<div class="field"><label for="c-title">卡片标题</label><input type="text" id="c-title" value="${esc(c.title)}"></div>
      <h2 style="font-size:16px;margin:22px 0 12px">先复盘</h2>
      ${C.AAR.map(([k, q]) => `<div class="field"><label for="c-aar-${k}">${q}</label><textarea id="c-aar-${k}" rows="2">${esc(c.aar?.[k])}</textarea></div>`).join('')}
      <h2 style="font-size:16px;margin:22px 0 12px">再提炼四格</h2>
      ${C.CARD_CELLS.map(([k, l, hint]) => `<div class="field"><label for="c-cell-${k}">${l}<span class="hint">${hint}</span></label><textarea id="c-cell-${k}" rows="2">${esc(c.cells?.[k])}</textarea></div>`).join('')}
      <button class="btn block" data-act="card-save" data-id="${c.id}">保存</button>
      <p class="faint" style="text-align:center;margin:8px 0 0">四格有一格空着，就先存成草稿。</p>`;
  }
  if (i === 2) {
    const rec = recorder?.cardId === c.id;
    return `<p style="margin:0 0 14px">合上手机，对着空气讲一遍，录下来，回放时找卡壳的地方。</p>
      ${rec
        ? `<button class="btn warn block" data-act="rec-stop"><span class="rec-dot"></span>停止录音 <span data-rec-clock class="num">0:00:00</span></button>`
        : `<button class="btn line block" data-act="rec-start" data-id="${c.id}">${c.audioFileId ? '重新录一遍' : '开始录音'}（最长 10 分钟）</button>`}
      ${c.audioFileId ? `<audio controls data-file="${esc(c.audioFileId)}"></audio>` : ''}
      <div class="field" style="margin-top:18px"><label for="c-gaps">卡壳的地方<span class="hint">每个卡壳点都是一个漏洞</span></label><textarea id="c-gaps" rows="3">${esc(c.gaps)}</textarea></div>
      <button class="btn block" data-act="card-told" data-id="${c.id}">讲完了，去补漏洞</button>`;
  }
  return `${c.gaps ? `<div class="cell" style="margin-bottom:16px"><b>上次卡壳的地方</b><div>${esc(c.gaps)}</div></div>` : ''}
    ${C.CARD_CELLS.map(([k, l]) => `<div class="field"><label for="c-cell-${k}">${l}</label><textarea id="c-cell-${k}" rows="2">${esc(c.cells?.[k])}</textarea></div>`).join('')}
    <div class="btns"><button class="btn" data-act="card-version" data-id="${c.id}">保存新版本</button>
      ${c.stage === 'library' ? '<span class="state done" style="align-self:center">已入库</span>' : `<button class="btn line" data-act="card-library" data-id="${c.id}">标记为已入库</button>`}
      <button class="btn soft" data-act="card-copy" data-id="${c.id}">复制成文字</button></div>
    ${(c.versions || []).length ? `<details style="margin-top:18px"><summary class="small">历史版本 ${c.versions.length} 个</summary>
      ${c.versions.slice().reverse().map(v => `<div class="cell" style="margin-top:8px"><span class="faint">${fmtTime(v.at)}</span>
        ${C.CARD_CELLS.map(([k, l]) => `<div><b style="display:inline">${l}：</b>${esc(v.cells?.[k])}</div>`).join('')}</div>`).join('')}</details>` : ''}`;
}

const cardText = c => `${c.title}\n` + C.CARD_CELLS.map(([k, l]) => `${l}：${c.cells?.[k] || ''}`).join('\n');

// ================= 页面：周回顾 =================

function reviewRec(wk) { return live('review').find(r => r.week === wk) || null; }

function pageReview() {
  const wk = C.weekKey();
  const rv = reviewRec(wk);
  const step = rv?.step || 0;
  const md = s => `${Number(s.slice(5, 7))} 月 ${Number(s.slice(8, 10))} 日`;
  const end = C.dayStr(C.addDays(C.weekStart(), 6));
  let h = top('');
  h += `<h1 style="margin:4px 2px 4px">周回顾</h1><p class="lede" style="margin:0 2px">${md(wk)} 到 ${md(end)}，周日花 20 分钟按顺序做完</p>`;
  if (rv?.done) {
    const m = C.computeMetrics(state.recs, wk);
    h += `<div class="section"><div class="notice good">本周回顾已完成</div>${metricsGrid(m)}
      <div class="btns" style="margin-top:16px"><button class="btn" data-act="review-copy">复制成文字，发给问责伙伴</button>
      <button class="btn soft" data-act="review-redo">从头再做一遍</button></div></div>`;
    return h;
  }
  h += `<div class="progress-steps" aria-hidden="true">${REVIEW_STEPS.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  const body = reviewBody(step, wk, rv);
  h += `<div id="review-step" data-step="${step}"><div class="section-head"><h2>第 ${step + 1} 步：${REVIEW_STEPS[step]}</h2><span class="faint">共 6 步</span></div>
    <div class="sheet pad">${body.html}</div>
    <div class="btns" style="margin-top:14px">${step > 0 ? `<button class="btn soft" data-act="review-back">上一步</button>` : ''}
    <button class="btn" style="flex:1" id="review-next" data-act="review-next" ${body.ok ? '' : 'disabled'}>${step === 5 ? '完成回顾' : '下一步'}</button></div>
    ${body.ok ? '' : `<p class="faint" style="text-align:center;margin-top:8px">${body.why}</p>`}</div>`;
  return h;
}

function metricsGrid(m) {
  const items = [
    ['拼上块数', m.piecesDone],
    ['主线时间占比', C.pct(m.mainShare)],
    ['预测命中率', C.pct(m.hitRate)],
    ['半途放弃', m.stopped],
    ['收入', '¥' + m.income],
    ['近 14 天用了几天', m.usageDays14],
  ];
  return `<div class="metrics">${items.map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
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
      html: `<div class="big-rate" id="hit-rate">${m.predicted ? C.pct(m.hitRate) : ''}</div>
        ${m.predicted ? `<p class="small" style="margin:0 0 12px">预测命中率：上周日说会拼上 ${m.predicted} 块，拼上了其中 ${m.hits} 块</p>` : ''}
        ${ids.length ? ids.map(id => `<div class="row-item">${pcIcon(doneIds.includes(id) ? 'done' : '')}<div class="grow ellipsis">${esc(get(id).name)}</div><span class="state ${doneIds.includes(id) ? 'done' : ''}">${doneIds.includes(id) ? '拼上了' : '没拼上'}</span></div>`).join('')
          : '<p class="small" style="margin:0">这周没有预测，第一周正常。最后一步会定下周的预测。</p>'}
        ${extra.length ? `<p class="faint" style="margin:10px 0 0">预测之外拼上的：${extra.map(id => esc(get(id)?.name)).join('、')}</p>` : ''}`,
    };
  }
  if (step === 1) {
    const list = scatterNotes();
    return {
      ok: !list.length,
      why: `还有 ${list.length} 条没归位：挂到某块、变成新拼块，或删掉`,
      html: list.length ? `<p class="small" style="margin:0 0 4px">删之前看一眼：这就是本周跑偏的地方。</p>${list.map(scatterItem).join('')}` : '<p style="margin:0">散块盒已经清空。</p>',
    };
  }
  if (step === 2) {
    const ids = (rv?.quiz || []).filter(id => get(id));
    const res = rv?.quizResults || {};
    if (!ids.length) return { ok: true, html: '<p style="margin:0">还没有写完四格的经验卡，这一步跳过。</p>' };
    const left = ids.filter(id => !res[id]).length;
    return {
      ok: !left,
      why: `还有 ${left} 张没自评`,
      html: `<p class="small" style="margin:0 0 12px">只看标题，先在心里说出「核心」和「方法」，再翻开对照。</p>
        ${ids.map(id => {
          const c = get(id);
          const open = state.ui.reveal[id];
          return `<div class="quiz" data-quiz="${id}"><b>${esc(c.title)}</b>
            ${open ? `<div class="cells" style="margin-top:10px"><div class="cell" style="background:#fff"><b>核心</b><div>${esc(c.cells.core)}</div></div><div class="cell" style="background:#fff"><b>方法</b><div>${esc(c.cells.method)}</div></div></div>
              <div style="margin-top:10px">${[['ok', '记得'], ['vague', '模糊'], ['forgot', '忘了']].map(([k, l]) =>
                `<button class="chip ${res[id] === k ? 'on' : ''}" style="background:${res[id] === k ? '' : '#fff'}" data-act="quiz-rate" data-id="${id}" data-r="${k}">${l}</button>`).join('')}</div>`
              : `<div style="margin-top:10px"><button class="btn sm line" data-act="quiz-reveal" data-id="${id}">翻开</button></div>`}</div>`;
        }).join('')}`,
    };
  }
  if (step === 3) {
    const pzs = [mainPuzzle(), sidePuzzle()].filter(Boolean);
    return {
      ok: true,
      html: pzs.map(pz => `<p class="small" style="margin:${pz.lane === 'main' ? 0 : '14px'} 0 0">${LANES[pz.lane]}：${esc(pz.name)}</p>
        ${(pz.leads || []).map(l => { const n = leadCount(l, wk), t = Number(l.target) || 1; return `<div class="row-item"><div class="grow">${esc(l.name)}</div><span class="state ${n >= t ? 'done' : ''} num">${n} / ${t}</span></div>`; }).join('')}`).join('')
        || '<p style="margin:0">没有在推进的拼图。</p>',
    };
  }
  if (step === 4) {
    const flagged = puzzlesIn('main', 'side').filter(needsStopCheck);
    const handled = id => live('stopped').some(s => s.puzzleId === id && s.week === wk);
    const left = flagged.filter(pz => !handled(pz.id));
    return {
      ok: !left.length,
      why: '有拼图连续 2 周没有外部反馈，先选停下还是换做法',
      html: flagged.length ? flagged.map(pz => {
        const days = Math.floor((Date.now() - lastFeedbackAt(pz)) / DAY);
        if (handled(pz.id)) return `<div class="row-item"><div class="grow">${esc(pz.name)}</div><span class="state done">已处理</span></div>`;
        return `<div class="quiz"><b>${esc(pz.name)}</b><p class="small" style="margin:4px 0 10px">已经 ${days} 天没有任何外部反馈：没人用、没人问价、没人付钱。</p>
          <textarea id="stop-reason-${pz.id}" rows="2" style="background:#fff" placeholder="一句真实原因"></textarea>
          <div class="btns" style="margin-top:10px"><button class="btn sm warn" data-act="stop-do" data-id="${pz.id}" data-a="stop">停下</button>
          <button class="btn sm line" data-act="stop-do" data-id="${pz.id}" data-a="change">换个做法再试 2 周</button></div></div>`;
      }).join('') : '<p style="margin:0">在推进的拼图最近 2 周都有外部反馈。</p><p class="faint" style="margin:8px 0 0">外部反馈指随手记时标了「这是外部反馈」，或者收到了收款。</p>',
    };
  }
  const nk = C.nextWeekKey();
  const pred = live('predict').find(r => r.week === nk);
  const sel = new Set(pred?.pieceIds || []);
  const pzs = [mainPuzzle(), sidePuzzle()].filter(Boolean);
  return {
    ok: true,
    html: `<p class="small" style="margin:0 0 12px">点出下周会拼上的块，下周日拿来对账。已选 <b class="num">${sel.size}</b> 块。</p>
      ${pzs.map(pz => `<p class="faint" style="margin:10px 0 6px">${LANES[pz.lane]}：${esc(pz.name)}</p>
        ${piecesOf(pz.id).filter(p => p.status !== 'done').map(p => `<button class="chip ${sel.has(p.id) ? 'on' : ''}" data-act="predict-toggle" data-id="${p.id}">${esc(p.name)}</button>`).join('') || '<span class="faint">没有空位</span>'}`).join('')}`,
  };
}

// ================= 页面：设置 =================

function pageSettings() {
  const c = cfg();
  let h = top('', { back: '#/' });
  h += `<h1 style="margin:4px 2px 18px">设置</h1>
  <div class="section-head"><h2>手机和电脑同步</h2></div>
  <div class="sheet pad">
    <p class="small" id="sync-detail" style="margin:0 0 14px">${syncDetail()}</p>
    <div class="field"><label for="s-repo">数据仓库</label><input type="text" id="s-repo" value="${esc(c.repo)}"></div>
    <div class="field"><label for="s-token">令牌<span class="hint">只存在这台设备上</span></label><input type="password" id="s-token" value="${esc(c.token)}" placeholder="github_pat_ 开头的一长串" autocomplete="off"></div>
    <div class="field"><label for="s-device">这台设备叫</label><input type="text" id="s-device" value="${esc(c.device)}"></div>
    <div id="s-msg"></div>
    <div class="btns"><button class="btn" data-act="sync-save">保存并测试</button><button class="btn line" data-act="sync-now">立即同步</button></div>
    ${c.token ? '' : `<details style="margin-top:18px" ${/Android|iPhone/i.test(navigator.userAgent) ? '' : 'open'}><summary class="link">第一次开同步：先在电脑上开（约 2 分钟）</summary>
      <ol class="steps-list">
        <li>在电脑上点下面的按钮，打开 GitHub 的新建令牌页，名称、有效期、权限都已填好</li>
        <li>「Repository access」选 <b>Only select repositories</b>，再选 <b>puzzle-progress-data</b></li>
        <li>拉到底点绿色的 <b>Generate token</b>，复制那串 github_pat_ 开头的字</li>
        <li>粘到上面的「令牌」里，点「保存并测试」</li>
        <li>手机不用再建：电脑上这一页会多出「在手机上开同步」，用手机 Edge 扫码就好</li>
      </ol>
      <a class="btn sm line" href="${esc(TOKEN_URL)}" target="_blank" rel="noopener">打开 GitHub 建令牌页</a>
    </details>`}
  </div>
  ${c.token ? `<div class="section" id="pair"><div class="section-head"><h2>在手机上开同步</h2></div><div class="sheet pad">
    <p class="small" style="margin:0 0 14px">在手机上打开 Edge，点地址栏右边的扫码图标，扫电脑屏幕上的二维码。扫完就同步好了，手机上不用填任何东西。</p>
    <button class="btn line" data-act="pair-show">显示二维码</button>
  </div></div>` : ''}
  ${motionPicker()}
  <div class="section"><div class="section-head"><h2>备份</h2></div><div class="sheet pad">
    <p class="small" style="margin:0 0 14px">整包导出成一个文件，含图片和录音，不含令牌。换手机时导入，也可以用微信发给自己留底。</p>
    <div class="btns"><button class="btn line" data-act="export">导出全部数据</button>
    <label class="btn soft">导入备份<input type="file" accept=".json,application/json" hidden data-change="import"></label></div>
  </div></div>
  <div class="section"><div class="section-head"><h2>清空这台设备</h2></div><div class="sheet pad">
    <p class="small" style="margin:0 0 14px">只清这台设备上的数据。开了同步的话，下次同步会从云端拿回来。</p>
    <button class="btn warn" data-act="wipe">清空本机数据</button>
  </div></div>
  <p class="faint" style="text-align:center;margin-top:24px">拼图推进 ${VERSION}</p>`;
  return h;
}

// 动效模型：四种画面各配一张实时小样，点一下就换
function motionPicker() {
  const m = mainPuzzle();
  const cur = motionModel();
  const demo = m && piecesOf(m.id).some(p => p.status === 'done');
  const preview = id => {
    if (m) return jigsawSvg(m, { mini: true, model: id });
    const uid = 'mv' + (++svgSeq);
    const art = M.scene(id, 'demo', 300, 300, uid, { p: 0.55, u: 0.2, focus: true, newest: -1, done: [0, 1, 3, 4].map(i => ({ i, at: i, cx: (i % 3) * 100 + 50, cy: Math.floor(i / 3) * 100 + 50 })) });
    return `<svg class="jig m-${id} focusing" viewBox="0 0 300 300" aria-hidden="true"><defs>${art.defs}</defs>${art.body}</svg>`;
  };
  return `<div class="section" id="motion"><div class="section-head"><h2>动效</h2><span class="faint">画面跟着任务情况变</span></div>
    <div class="motion-grid">${M.MODELS.map(x => `<button class="motion-opt ${x.id === cur ? 'on' : ''}" data-act="motion-pick" data-id="${x.id}" aria-pressed="${x.id === cur}">
      <div class="pv">${preview(x.id)}</div><b>${x.name}</b><span>${x.desc}</span></button>`).join('')}</div>
    ${demo ? `<button class="btn line block" style="margin-top:12px" data-act="motion-demo">用「${esc(M.modelOf(cur).name)}」看一遍拼上的样子</button>` : ''}
  </div>`;
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

// 页面背景：跟主线拼图的进度、落后程度、专注状态走
function paintAmbient() {
  const el = $('#ambient');
  if (!el) return;
  const m = mainPuzzle();
  const model = motionModel();
  const ps = m ? piecesOf(m.id) : [];
  const p = ps.length ? ps.filter(x => x.status === 'done').length / ps.length : 0;
  const a = M.ambient(model, m?.id || 'none', { p, u: m ? M.urgency(m, p) : 0 });
  el.className = `${a.cls} ${activeFocus() ? 'focusing' : ''}`;
  for (const [k, v] of Object.entries(a.vars)) el.style.setProperty(k, v);
}

function render() {
  const { name, id } = route();
  $('#view').innerHTML = ROUTES[name](id);
  paintAmbient();
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.nav === NAV_OF[name]));
  hydrate();
}

// ================= 操作 =================

const A = {};

A.go = d => { if (location.hash === d.to) render(); else location.hash = d.to; };

// ---- 动效模型 ----
A['motion-pick'] = d => {
  try { localStorage.setItem('pp.motion', d.id); } catch { /* 存不了就只这次生效 */ }
  render();
  document.querySelector(`.motion-opt[data-id="${d.id}"]`)?.classList.add('just');
};
A['motion-demo'] = () => {
  const m = mainPuzzle();
  const last = piecesOf(m.id).filter(p => p.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
  if (last) showPlaced(last, { sub: '这是预览，不会改动数据' });
};

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
      ${ps.map(p => `<button class="chip ${sel.has(p.id) ? 'on' : ''}" data-act="pick-toggle" data-id="${p.id}">${esc(p.name)}</button>`).join('') || '<div class="faint">没有空位了</div>'}</div>`;
  });
  return `<h2>今天做哪几块？<span class="faint" style="font-weight:400"> 最多 3 块</span></h2>${groups.join('')}
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
  return `<h2>随手记一句</h2>
    <textarea id="note-text" rows="3" aria-label="随手记" placeholder="此刻在做什么、想到什么，一句话就行。可以用输入法的语音输入">${esc(state.ui.noteDraft || '')}</textarea>
    <p class="faint" style="margin:14px 0 8px">记在哪一块上</p>
    <div id="note-targets">
      ${cands.map(id => `<button class="chip ${t === id ? 'on' : ''}" data-act="note-target" data-id="${id}">${esc(get(id).name)}</button>`).join('')}
      <button class="chip ${!t ? 'on' : ''}" data-act="note-target" data-id="">都不是，放散块盒</button>
    </div>
    <div style="margin:4px 0 14px"><button class="chip ${state.ui.noteFeedback ? 'on' : ''}" data-act="note-feedback" aria-pressed="${!!state.ui.noteFeedback}">这是别人给的反馈</button></div>
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
  toast(pieceId ? '记下了' : '记下了，放进散块盒');
  render();
};

// ---- 散块 ----
function piecePickerHtml(title, act, extra = '') {
  const groups = [mainPuzzle(), sidePuzzle(), ...puzzlesIn('paused')].filter(Boolean).map(pz => {
    const ps = piecesOf(pz.id);
    return `<div class="field"><label>${LANES[pz.lane]} · ${esc(pz.name)}</label>
      ${ps.map(p => `<button class="chip" data-act="${act}" data-id="${p.id}" ${extra}>${esc(p.name)}</button>`).join('') || '<div class="faint">没有拼块</div>'}</div>`;
  });
  return `<h2>${title}</h2>${groups.join('') || '<div class="faint">还没有拼图</div>'}`;
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
  openModal(`<h2>变成哪幅拼图的新拼块？</h2>
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
    $('#form-err').innerHTML = `<div class="notice bad">还缺：${miss.join('、')}</div>`;
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
  openModal(`<h2>停下，还是换个做法？</h2>
    <p class="small" style="margin:0 0 12px">写一句真实原因，会记进半途而废清单。停下就移出推进；换做法就再试 2 周。</p>
    <textarea id="stop-reason-${d.id}" rows="3" placeholder="一句真实原因"></textarea>
    <div class="btns" style="margin-top:12px"><button class="btn warn" data-act="stop-do" data-id="${d.id}" data-a="stop">停下</button>
    <button class="btn line" data-act="stop-do" data-id="${d.id}" data-a="change">换个做法</button></div>`);
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

A['evi-link'] = d => openModal(`<h2>加一个链接证据</h2>
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

A['evi-income'] = d => openModal(`<h2>加一笔收款</h2>
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

A.place = d => placePiece(get(d.id));

async function placePiece(p, extra = []) {
  if (!(p.evidence || []).length) return toast('先附一个证据');
  const recs = [p, ...extra];
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
  showPlaced(p, {
    sub: '趁热写下这块的经验',
    then: () => {
      state.ui.cardStep[card.id] = 1;
      location.hash = `#/card/${card.id}`;
      if (pr.done === pr.total) toast('整幅拼图拼完了，可以在拼图页宣布完成', 3500);
    },
  });
}

// 落位：整幅拼图里这块空着，它从下方转着飞进来、卡进位置，光从画面上扫过，数字跳一格
function showPlaced(p, { sub = '', then = () => {}, model } = {}) {
  const pz = get(p.puzzleId);
  const pr = progress(pz);
  closeModal();
  const o = document.createElement('div');
  o.className = 'placed-overlay';
  o.innerHTML = `<div class="placed-stage">
    <div class="tray">${jigsawSvg(pz, { mini: true, arriving: p.id, model })}</div>
    <p class="placed-count"><b class="num" data-count>${pr.done - 1}</b><span> / ${pr.total}</span></p>
    <p class="placed-sub">拼上了「${esc(p.name)}」<span>${esc(sub)}</span></p>
  </div>`;
  document.body.appendChild(o);
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    o.remove();
    then();
  };
  o.addEventListener('click', go);
  setTimeout(() => {
    const n = o.querySelector('[data-count]');
    if (n) { n.textContent = pr.done; n.classList.add('bump'); }
    if (!calm && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(12);
  }, calm ? 0 : 820);
  setTimeout(go, calm ? 900 : 2400);
}

// ---- 电脑自动入账的建议 ----
A['suggest-place'] = async d => {
  const s = get(d.id);
  const p = s && get(s.pieceId);
  if (!p) return;
  s.dismissed = true;
  s.dismissedAt = Date.now();
  p.evidence = [...(p.evidence || []), ...(s.evidence || []).map(e => ({ ...e, id: C.uid(), at: Date.now(), note: e.note || e.text || s.text || '' }))];
  if (!p.evidence.length) p.evidence.push({ id: C.uid(), at: Date.now(), kind: 'link', url: s.ref || '', note: s.text || '' });
  await placePiece(p, [s]);
};
A['suggest-dismiss'] = async d => {
  const s = get(d.id);
  if (!s) return;
  s.dismissed = true;
  s.dismissedAt = Date.now();
  const el = document.getElementById('suggest-' + s.id);
  await save(s);
  if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.classList.add('leaving');
    await new Promise(r => setTimeout(r, 260));
  }
  render();
};
A['auto-more'] = d => { state.ui.autoOpen = { ...(state.ui.autoOpen || {}), [d.id]: !state.ui.autoOpen?.[d.id] }; render(); };

A['edit-refs'] = d => {
  const p = get(d.id);
  openModal(`<h2>关联工单</h2>
    <p class="small" style="margin:0 0 12px">这块对应工单区里的哪个任务。任务做完时，首页会提示「可以拼上」，证据自动带上。</p>
    <div class="field"><label for="refs-in">工单编号<span class="hint">可填多个，空格隔开</span></label><input type="text" id="refs-in" value="${esc((p.refs || []).join(' '))}" placeholder="例如 T027" autocomplete="off"></div>
    <button class="btn block" data-act="refs-save" data-id="${d.id}">保存</button>`);
  setTimeout(() => $('#refs-in')?.focus(), 50);
};
A['refs-save'] = async d => {
  const p = get(d.id);
  const raw = $('#refs-in').value.toUpperCase();
  p.refs = [...new Set(raw.match(/T\d{3}(?:-\d{2})?/g) || [])];
  closeModal();
  await save(p);
  render();
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
A.glyph = d => { const i = Number(d.i); state.ui.glyph = state.ui.glyph === i ? null : i; render(); };
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
  if (!token) { msg.innerHTML = '<div class="notice good">已保存。没填令牌：数据只在这台设备上。</div>'; return; }
  msg.innerHTML = '<div class="notice good">正在测试连接…</div>';
  try {
    const info = await S.testConnection(cfg());
    msg.innerHTML = info.private
      ? `<div class="notice good">连上了：${esc(info.name)}（私有仓库）。正在同步…</div>`
      : `<div class="notice bad">连上了，但 ${esc(info.name)} 是公开仓库，别人能看到你的记录。请到 GitHub 把它改成私有。</div>`;
    await doSync();
  } catch (e) {
    msg.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
};
A['sync-now'] = () => doSync(true);

// ---- 扫码开同步：电脑显示二维码，手机扫开就带着令牌进来 ----
const PAIR_BASE = 'https://daxuecmd.github.io/puzzle-progress/';

async function qrSvg(text) {
  const { default: qrcode } = await import('./vendor/qrcode.js');
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount(), m = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="开同步的二维码"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#1D2433"/></svg>`;
}

A['pair-show'] = async () => {
  const c = cfg();
  if (!c.token) return toast('这台设备还没开同步');
  const url = `${location.origin.startsWith('http://127.0.0.1') || location.origin.startsWith('http://localhost') ? location.origin + location.pathname : PAIR_BASE}#/pair/${encodeURIComponent(c.token)}${c.repo !== DEFAULT_REPO ? '?repo=' + encodeURIComponent(c.repo) : ''}`;
  openModal(`<h2>用手机 Edge 扫这个码</h2>
    <div class="qr-wrap" id="pair-qr">${await qrSvg(url)}</div>
    <p class="small" style="margin:14px 0 0">手机 Edge 地址栏右边的扫码图标，对准它。扫完手机会自动同步，看到「同步已开好」就行。</p>
    <p class="faint" style="margin:6px 0 16px">这个码里有你的同步令牌，别让别人拍到。</p>
    <button class="btn block line" data-act="pair-close">关掉</button>`);
};
A['pair-close'] = () => closeModal();

// 地址是 #/pair/<令牌> 时：先把令牌从地址栏和历史里抹掉，再测试、保存、同步
async function handlePair() {
  const m = location.hash.match(/^#\/pair\/([^?]+)(?:\?repo=(.+))?$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search + '#/');
  const token = decodeURIComponent(m[1]);
  const repo = m[2] ? decodeURIComponent(m[2]) : cfg().repo;
  render();
  toast('正在开同步…', 6000);
  try {
    const info = await S.testConnection({ ...cfg(), token, repo });
    setCfg({ token, repo });
    await doSync();
    toast(info.private ? '同步已开好' : '同步已开好，但数据仓库是公开的，请改成私有', 3500);
  } catch (e) {
    toast('没开成：' + (e.message || e), 4000);
  }
  render();
  return true;
}

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
  document.querySelectorAll('[data-bar]').forEach(el => {
    const ff = get(el.dataset.bar);
    if (ff) el.style.width = Math.min(100, ((Date.now() - ff.start) / ff.planned) * 100).toFixed(1) + '%';
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
  addEventListener('hashchange', () => { if (/^#\/pair\//.test(location.hash)) { handlePair(); return; } closeModal(); render(); scrollTo(0, 0); });
  addEventListener('online', () => { setSync('idle'); doSync(); });
  addEventListener('offline', () => setSync('offline', '网络不通，联网后会自动同步'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { tick(); doSync(); }
  });
  $('#fab').addEventListener('click', () => A.note({}));
  setInterval(tick, 1000);
  if (await handlePair()) { /* 扫码进来的：handlePair 已经渲染并同步 */ }
  else {
    render();
    if (sessionStorage.getItem('pp.updated')) { sessionStorage.removeItem('pp.updated'); toast('已更新到新版本'); }
    setTimeout(() => doSync(), 300);
  }

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
