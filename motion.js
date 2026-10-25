// 动效模型：拼图画面和页面背景跟着任务情况动
// 输入只有几个数（见 sceneState）：进度 p、落后程度 u、是否在专注、拼上的块。数一变，画面就变
import { rng, PALETTES, picture } from './core.js';

export const MODELS = [
  { id: 'dawn', name: '晨光', desc: '拼得越多太阳越高，落后了天色转暮' },
  { id: 'tide', name: '潮汐', desc: '拼得越多水位越高，越临近截止浪越急' },
  { id: 'stars', name: '星图', desc: '拼上一块亮一颗星，连成星座' },
  { id: 'still', name: '静物', desc: '画面不动，只有正在做的块呼吸' },
];
export const DEFAULT_MODEL = 'dawn';
export const modelOf = id => MODELS.find(m => m.id === id) || MODELS[0];

const f1 = n => n.toFixed(1);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// 落后程度：时间过去的比例比进度多出多少（0 = 按时或超前，1 = 严重落后）
export function urgency(pz, p, now = Date.now()) {
  if (!pz?.deadline) return 0;
  const start = pz.createdAt || now;
  const end = new Date(pz.deadline + 'T23:59:59').getTime();
  if (end <= start) return p >= 1 ? 0 : 1;
  return clamp(((now - start) / (end - start) - p) * 1.6);
}

function ridge(r, W, H, base, amp, n) {
  const step = (W + 80) / n, pts = [];
  for (let i = 0; i <= n; i++) pts.push([-40 + i * step, base - amp * (0.25 + r() * 0.75)]);
  let d = `M-40 ${H + 40} L${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
    d += ` Q${f1(pts[i - 1][0])} ${f1(pts[i - 1][1])} ${f1(mx)} ${f1(my)}`;
  }
  return d + ` L${W + 40} ${f1(pts[pts.length - 1][1])} L${W + 40} ${H + 40} Z`;
}

// ---------- 晨光：太阳高度 = 进度，黄昏程度 = 落后 ----------
function dawn(seed, W, H, uid, s) {
  const r = rng(seed);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)];
  const sx = W * (0.22 + r() * 0.56);
  r();
  const sr = Math.min(W, H) * 0.1 + 6;
  const syAt = p => H * (0.42 - 0.3 * p);
  const sy = syAt(s.p), lift = s.p0 == null ? 0 : syAt(s.p0) - sy;
  const defs = `<linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.sky[0]}"/><stop offset="1" stop-color="${pal.sky[1]}"/></linearGradient>
    <linearGradient id="${uid}-dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5B4A7A" stop-opacity=".9"/><stop offset="1" stop-color="#E0876A" stop-opacity=".5"/></linearGradient>`;
  let body = `<rect x="-40" y="-40" width="${W + 80}" height="${H + 80}" fill="url(#${uid}-sky)"/>
    <rect class="m-dusk" x="-40" y="-40" width="${W + 80}" height="${H + 80}" fill="url(#${uid}-dusk)" opacity="${(s.u * 0.55).toFixed(2)}"/>
    <g class="m-sun" style="--rise:${f1(lift)}px"><circle class="m-glow" cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(sr * 1.9)}" fill="${pal.sun}" opacity=".35"/>
    <circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(sr)}" fill="${pal.sun}"/></g>`;
  for (let c = 0; c < 3; c++) {
    const cx = W * r(), cy = H * (0.1 + r() * 0.22), cw = W * (0.1 + r() * 0.12);
    body += `<ellipse class="m-cloud" style="--d:${(38 + c * 17).toFixed(0)}s;--dx:${(18 + c * 10).toFixed(0)}px" cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(cw)}" ry="${f1(cw * 0.22)}" fill="#fff" opacity=".5"/>`;
  }
  pal.ridges.forEach((color, k) => { body += `<path d="${ridge(r, W, H, H * (0.4 + k * 0.155), H * (0.13 - k * 0.018), 5 + k * 2)}" fill="${color}"/>`; });
  return { defs, body };
}

// ---------- 潮汐：水位 = 进度，浪的急缓和高低 = 落后 ----------
function wave(W, y, L, A) {
  let d = `M${-L - 40} ${f1(y)}`;
  for (let x = -L - 40; x < W + 40 + L; x += L) d += ` q${f1(L / 4)} ${f1(-A)} ${f1(L / 2)} 0 t${f1(L / 2)} 0`;
  return d + ` L${W + 40 + L} ${f1(y + 400)} L${-L - 40} ${f1(y + 400)} Z`;
}
function tide(seed, W, H, uid, s) {
  const r = rng(seed);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)];
  const sx = W * (0.22 + r() * 0.56), sy = H * (0.14 + r() * 0.1), sr = Math.min(W, H) * 0.08 + 5;
  const lvAt = p => H * (0.86 - 0.6 * p);
  const y = lvAt(s.p), lift = s.p0 == null ? 0 : lvAt(s.p0) - y;
  const L = W / 3, A = 5 + 9 * s.u, T = (7.5 - 4.5 * s.u).toFixed(1);
  const defs = `<linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.sky[0]}"/><stop offset="1" stop-color="${pal.sky[1]}"/></linearGradient>
    <linearGradient id="${uid}-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FAAC6"/><stop offset="1" stop-color="#2E4F6D"/></linearGradient>`;
  let body = `<rect x="-40" y="-40" width="${W + 80}" height="${H + 80}" fill="url(#${uid}-sky)"/>
    <circle class="m-glow" cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(sr * 1.9)}" fill="${pal.sun}" opacity=".35"/><circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(sr)}" fill="${pal.sun}"/>
    <path d="${ridge(r, W, H, H * 0.5, H * 0.12, 5)}" fill="${pal.ridges[0]}" opacity=".75"/>
    <g class="m-water" style="--rise:${f1(lift)}px">
      <path class="m-wave" style="--d:${T}s;--L:${f1(L)}px" d="${wave(W, y - 7, L, A * 0.7)}" fill="#B7D2E2" opacity=".75"/>
      <path class="m-wave back" style="--d:${(T * 1.35).toFixed(1)}s;--L:${f1(L)}px" d="${wave(W, y, L, A)}" fill="url(#${uid}-sea)"/>`;
  for (let k = 0; k < 6; k++) {
    const gx = W * r(), gy = y + 14 + r() * (H - y);
    body += `<rect class="m-glint" style="--k:${(r() * 4).toFixed(2)}s" x="${f1(gx)}" y="${f1(gy)}" width="${f1(8 + r() * 14)}" height="1.6" rx=".8" fill="#fff" opacity=".55"/>`;
  }
  return { defs, body: body + '</g>' };
}

// ---------- 星图：拼上一块亮一颗星，按先后连线；专注时有流星 ----------
const NIGHTS = [['#1C2140', '#4B3F6E'], ['#13283A', '#2F5560'], ['#2A1C38', '#6A4561']];
function stars(seed, W, H, uid, s) {
  const r = rng(seed);
  const sky = NIGHTS[Math.floor(r() * NIGHTS.length)];
  const defs = `<linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>
    <linearGradient id="${uid}-au" x1="0" x2="1"><stop offset="0" stop-color="${s.u > 0.5 ? '#F2A0A8' : '#8FE3C0'}" stop-opacity="0"/><stop offset=".5" stop-color="${s.u > 0.5 ? '#F2A0A8' : '#8FE3C0'}" stop-opacity=".55"/><stop offset="1" stop-color="#B9A8F5" stop-opacity="0"/></linearGradient>`;
  let body = `<rect x="-40" y="-40" width="${W + 80}" height="${H + 80}" fill="url(#${uid}-sky)"/>
    <path class="m-aurora" d="M-40 ${f1(H * 0.3)} C${f1(W * 0.3)} ${f1(H * 0.12)} ${f1(W * 0.6)} ${f1(H * 0.42)} ${W + 40} ${f1(H * 0.2)} L${W + 40} ${f1(H * 0.32)} C${f1(W * 0.6)} ${f1(H * 0.52)} ${f1(W * 0.3)} ${f1(H * 0.24)} -40 ${f1(H * 0.42)} Z" fill="url(#${uid}-au)" opacity="${(0.35 + 0.4 * s.u).toFixed(2)}"/>`;
  for (let k = 0; k < 46; k++) {
    body += `<circle class="m-tw" style="--k:${(r() * 5).toFixed(2)}s" cx="${f1(W * r())}" cy="${f1(H * 0.7 * r())}" r="${(0.5 + r() * 1.1).toFixed(2)}" fill="#fff" opacity="${(0.35 + r() * 0.5).toFixed(2)}"/>`;
  }
  body += `<path d="${ridge(r, W, H, H * 0.78, H * 0.1, 6)}" fill="#2B2747" opacity=".9"/><path d="${ridge(r, W, H, H * 0.9, H * 0.08, 8)}" fill="#15142A"/>`;
  // 星座：每块拼上的位置附近一颗亮星，按拼上的先后连线
  const pts = (s.done || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0)).map(d => {
    const q = rng(seed + ':' + d.i);
    return { x: d.cx + (q() - 0.5) * 44, y: Math.min(d.cy + (q() - 0.5) * 44, H * 0.72), i: d.i };
  });
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], len = Math.hypot(b.x - a.x, b.y - a.y);
    body += `<line class="m-line ${pts[k].i === s.newest ? 'new' : ''}" style="--len:${f1(len)}" x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" stroke="#E9E5FF" stroke-width="1.3" stroke-dasharray="${f1(len)}" opacity=".6"/>`;
  }
  for (const p of pts) {
    body += `<g class="m-star ${p.i === s.newest ? 'new' : ''}"><circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="9" fill="#fff" opacity=".18"/><circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="3.2" fill="#fff"/></g>`;
  }
  if (s.focus) body += `<line class="m-shoot" x1="${f1(W * 0.85)}" y1="${f1(H * 0.06)}" x2="${f1(W * 0.85 - 46)}" y2="${f1(H * 0.06 + 22)}" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`;
  return { defs, body };
}

export function scene(model, seed, W, H, uid, s) {
  if (model === 'tide') return tide(seed, W, H, uid, s);
  if (model === 'stars') return stars(seed, W, H, uid, s);
  if (model === 'still') return picture(seed, W, H, uid);
  return dawn(seed, W, H, uid, s);
}

// 页面背景的颜色和强弱：跟主线拼图的进度、落后程度、专注状态走
export function ambient(model, seed, s) {
  const r = rng(seed);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)];
  const base = { '--amb-p': s.p.toFixed(3), '--amb-u': s.u.toFixed(3) };
  if (model === 'tide') return { cls: 'amb-tide', vars: { ...base, '--amb-a': pal.ridges[1], '--amb-b': pal.sky[0] } };
  if (model === 'stars') return { cls: 'amb-stars', vars: { ...base, '--amb-a': '#4B3F6E', '--amb-b': '#8FE3C0' } };
  if (model === 'still') return { cls: 'amb-still', vars: base };
  return { cls: 'amb-dawn', vars: { ...base, '--amb-a': pal.sky[1], '--amb-b': '#8E6A9A' } };
}
