// 纯逻辑：不碰 DOM、不碰存储，浏览器和 Node 测试共用

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const pad = n => String(n).padStart(2, '0');

export function dayStr(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function weekStart(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// 周的编号用那周周一的日期
export const weekKey = (t = Date.now()) => dayStr(weekStart(t));
export const nextWeekKey = (t = Date.now()) => dayStr(addDays(weekStart(t), 7));

export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h} 小时 ${m % 60} 分` : `${m} 分钟`;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// 键排序后的序列化，保证两台设备对同一条记录算出同样的字符串
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

// 同一条记录两边都有时，后改的胜；改的时间相同就按内容定，保证两边结果一致
export function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

export function mergeRecords(local, remote) {
  const m = new Map();
  for (const r of remote) m.set(r.id, newer(m.get(r.id), r));
  for (const r of local) m.set(r.id, newer(m.get(r.id), r));
  return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sameRecords(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map(b.map(r => [r.id, stableStringify(r)]));
  return a.every(r => m.get(r.id) === stableStringify(r));
}

// ---------- 编码 ----------

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const utf8ToB64 = text => bytesToB64(new TextEncoder().encode(text));
export const b64ToUtf8 = b64 => new TextDecoder().decode(b64ToBytes(b64));

// ---------- 规则 ----------

export const PUZZLE_FIELDS = [
  ['deliverable', '交付物', '做完时别人手里拿到什么'],
  ['deadline', '截止日', ''],
  ['acceptor', '外部验收人', '由谁说「成了」，不能是自己'],
  ['value', '金额或价值', '钱数，或换算成钱 / 时间 / 机会'],
  ['stopRule', '停止条件', ''],
];
export const DEFAULT_STOP_RULE = '连续 2 周没有任何外部反馈';
export const MAX_PIECES = 24;

export function puzzleMissing(p) {
  const miss = PUZZLE_FIELDS.filter(([k]) => !String(p[k] || '').trim()).map(([, label]) => label);
  if ((p.leads || []).filter(l => l.name.trim()).length < 2) miss.push('至少 2 个引领动作');
  if ((p.ifThens || []).filter(s => s.trim()).length < 3) miss.push('3 条「如果…就…」');
  return miss;
}

export const CARD_CELLS = [
  ['core', '核心', '一句话说清这条经验'],
  ['logic', '逻辑', '为什么成立'],
  ['method', '方法', '下次照着做的步骤'],
  ['boundary', '边界', '什么情况下不适用'],
];
export const AAR = [
  ['plan', '本来应该怎样？'],
  ['actual', '实际怎样？'],
  ['why', '差距的原因是什么？'],
  ['next', '下次怎么做？'],
];
export const cellsComplete = c => CARD_CELLS.every(([k]) => String(c?.[k] || '').trim());

// 从数组里随机抽 k 个不重复的
export function sample(arr, k, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(k, a.length));
}

// ---------- 指标 ----------

export function computeMetrics(recs, wk, now = Date.now()) {
  const live = recs.filter(r => !r.deleted);
  const puzzles = new Map(live.filter(r => r.type === 'puzzle').map(p => [p.id, p]));
  const pieces = new Map(live.filter(r => r.type === 'piece').map(p => [p.id, p]));
  const done = [...pieces.values()].filter(p => p.status === 'done' && p.doneAt && weekKey(p.doneAt) === wk);

  let total = 0, main = 0;
  for (const f of live) {
    if (f.type !== 'focus' || !f.end || weekKey(f.start) !== wk) continue;
    const d = f.end - f.start;
    total += d;
    const pz = puzzles.get(pieces.get(f.pieceId)?.puzzleId);
    if (pz && pz.lane === 'main') main += d;
  }

  const pred = live.find(r => r.type === 'predict' && r.week === wk);
  const predIds = (pred?.pieceIds || []).filter(id => pieces.has(id));
  const hits = predIds.filter(id => done.some(p => p.id === id)).length;

  const stopped = live.filter(r => r.type === 'stopped' && r.action === 'stop' && weekKey(r.at) === wk).length;
  const income = done.reduce((s, p) => s + (p.evidence || [])
    .filter(e => e.kind === 'income').reduce((a, e) => a + (Number(e.amount) || 0), 0), 0);

  const days = new Set();
  const since = addDays(new Date(dayStr(now) + 'T00:00:00').getTime(), -13);
  for (const r of live) {
    const t = r.type === 'note' ? r.at : r.type === 'focus' ? r.start : 0;
    if (t && t >= since && t <= now) days.add(dayStr(t));
  }

  return {
    piecesDone: done.length,
    mainShare: total ? main / total : null,
    focusTotal: total,
    predicted: predIds.length,
    hits,
    hitRate: predIds.length ? hits / predIds.length : null,
    stopped,
    income,
    usageDays14: days.size,
  };
}

export const pct = v => (v == null ? '—' : Math.round(v * 100) + '%');

export function metricsText(m, wk) {
  return [
    `拼图推进 · ${wk} 这一周`,
    `拼上块数：${m.piecesDone}`,
    `主线时间占比：${pct(m.mainShare)}（专注共 ${fmtDuration(m.focusTotal)}）`,
    `预测命中率：${pct(m.hitRate)}（预测 ${m.predicted} 块，中 ${m.hits} 块）`,
    `半途放弃：${m.stopped}`,
    `收入：¥${m.income}`,
    `近 14 天使用天数：${m.usageDays14}`,
  ].join('\n');
}

// ---------- 拼图形状 ----------

function edge(a, b, dir) {
  if (!dir) return ` L${b[0]} ${b[1]}`;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n = [u[1], -u[0]];
  const p = (t, h) => {
    const x = a[0] + u[0] * t * L + n[0] * h * L * dir;
    const y = a[1] + u[1] * t * L + n[1] * h * L * dir;
    return `${+x.toFixed(1)} ${+y.toFixed(1)}`;
  };
  return ` L${p(0.38, 0)} C${p(0.42, 0)} ${p(0.43, 0.05)} ${p(0.40, 0.10)}` +
    ` C${p(0.35, 0.20)} ${p(0.42, 0.28)} ${p(0.50, 0.28)}` +
    ` C${p(0.58, 0.28)} ${p(0.65, 0.20)} ${p(0.60, 0.10)}` +
    ` C${p(0.57, 0.05)} ${p(0.58, 0)} ${p(0.62, 0)} L${b[0]} ${b[1]}`;
}

// n 块拼成一幅，相邻块的凸起和凹口互相咬合
export function jigsaw(n) {
  const cols = n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5;
  const rows = Math.max(1, Math.ceil(n / cols));
  const C = 100;
  const has = (r, c) => r >= 0 && c >= 0 && c < cols && r < rows && r * cols + c < n;
  const hs = (r, c) => ((r * 5 + c * 3) % 2 ? 1 : -1);
  const vs = (r, c) => ((r * 3 + c * 5 + 1) % 2 ? 1 : -1);
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols, x = c * C, y = r * C;
    const top = has(r - 1, c) ? -hs(r - 1, c) : 0;
    const right = has(r, c + 1) ? vs(r, c) : 0;
    const bottom = has(r + 1, c) ? hs(r, c) : 0;
    const left = has(r, c - 1) ? -vs(r, c - 1) : 0;
    const d = `M${x} ${y}` + edge([x, y], [x + C, y], top) + edge([x + C, y], [x + C, y + C], right) +
      edge([x + C, y + C], [x, y + C], bottom) + edge([x, y + C], [x, y], left) + ' Z';
    pieces.push({ d, cx: x + C / 2, cy: y + C / 2 });
  }
  return { cols, rows, size: C, pieces };
}

// ---------- 拼图画面：每幅拼图按编号生成一张固定的风景，拼上一块露出一块 ----------

function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6D2B79F5) | 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PALETTES = [
  { sky: ['#F7DCC8', '#EDB49E'], sun: '#FFF3DE', ridges: ['#D19A9F', '#A6738C', '#6B5276', '#33304B'] },   // 晨
  { sky: ['#E2ECE3', '#BCD6C9'], sun: '#FAF6E6', ridges: ['#97BBA8', '#66937F', '#3E6A58', '#203F35'] },   // 林
  { sky: ['#D3E3EF', '#F2DABB'], sun: '#FFEBC8', ridges: ['#90ACC7', '#6283A8', '#3E5D83', '#233651'] },   // 海
  { sky: ['#F5E6B9', '#E7C07D'], sun: '#FFF7E0', ridges: ['#CDA56D', '#A07D50', '#6E5839', '#3C3225'] },   // 秋
];

export const paletteFor = seed => PALETTES[Math.floor(rng(seed)() * PALETTES.length)];

export function picture(seed, W, H, uid) {
  const r = rng(seed);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)];
  const sx = W * (0.22 + r() * 0.56), sy = H * (0.16 + r() * 0.12), sr = Math.min(W, H) * 0.1 + 6;
  const defs = `<linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${pal.sky[0]}"/><stop offset="1" stop-color="${pal.sky[1]}"/></linearGradient>`;
  let body = `<rect x="-40" y="-40" width="${W + 80}" height="${H + 80}" fill="url(#${uid}-sky)"/>` +
    `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${(sr * 1.9).toFixed(1)}" fill="${pal.sun}" opacity=".35"/>` +
    `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${sr.toFixed(1)}" fill="${pal.sun}"/>`;
  for (let c = 0; c < 2; c++) {
    const cx = W * r(), cy = H * (0.12 + r() * 0.2), cw = W * (0.12 + r() * 0.12);
    body += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${cw.toFixed(1)}" ry="${(cw * 0.22).toFixed(1)}" fill="#fff" opacity=".45"/>`;
  }
  pal.ridges.forEach((color, k) => {
    const base = H * (0.40 + k * 0.155), amp = H * (0.13 - k * 0.018);
    const n = 5 + k * 2, step = (W + 80) / n;
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push([-40 + i * step, base - amp * (0.25 + r() * 0.75)]);
    let d = `M-40 ${H + 40} L${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
      d += ` Q${pts[i - 1][0].toFixed(1)} ${pts[i - 1][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    d += ` L${W + 40} ${pts[pts.length - 1][1].toFixed(1)} L${W + 40} ${H + 40} Z`;
    body += `<path d="${d}" fill="${color}"/>`;
  });
  return { defs, body };
}

// 单块拼图形状（散块、图标用）
export const singlePiece = () =>
  'M0 0' + edge([0, 0], [100, 0], 1) + edge([100, 0], [100, 100], -1) + edge([100, 100], [0, 100], 1) + edge([0, 100], [0, 0], -1) + ' Z';
