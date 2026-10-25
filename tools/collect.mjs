// 电脑工作自动入账：把当天的工单状态变化、代码提交、和 Claude 的对话按项目汇总成一条
// type: "auto" 的 day 记录；关联工单完成或待验收时，给拼块生成「可以拼上」的建议。
// 本机路径和个人内容一律从 --config 指向的配置文件读，脚本里不写任何路径。
//
// 用法：
//   node tools/collect.mjs --config <配置文件> [--dry-run] [--day YYYY-MM-DD]
//   --dry-run  只打印将写入的记录，不写快照、不提交、不推送
//   --day      汇总哪一天，默认本机今天
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mergeRecords, sameRecords, stableStringify } from '../core.js';

const STATUS_DONE = ['待验收', '完成'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_RE = /\bT\d{3}\b/g;

const pad = n => String(n).padStart(2, '0');
export const dayOf = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeOf = (t = Date.now()) => {
  const d = new Date(t);
  return `${dayOf(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---------- 配置、元数据 ----------

export function parseArgs(argv) {
  const out = { configPath: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 后面缺少值`);
      return v;
    };
    if (a === '--config') out.configPath = take();
    else if (a.startsWith('--config=')) out.configPath = a.slice('--config='.length);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--day') out.day = take();
    else if (a.startsWith('--day=')) out.day = a.slice('--day='.length);
    else throw new Error(`不认识的参数：${a}`);
  }
  if (!out.configPath) throw new Error('缺少 --config <配置文件>');
  if (out.day && !DAY_RE.test(out.day)) throw new Error(`--day 要写成 YYYY-MM-DD，收到：${out.day}`);
  return out;
}
export function loadConfig(configPath) {
  if (!configPath) throw new Error('缺少 --config <配置文件>');
  const file = path.resolve(configPath);
  if (!fs.existsSync(file)) throw new Error(`找不到配置文件：${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${e.message}`);
  }
  const base = path.dirname(file);
  const cfg = {};
  for (const [key, label] of [
    ['tasksArea', '工单区路径'],
    ['codeRoot', '代码根目录'],
    ['archiveRoot', '存档路径'],
    ['dataRepo', '数据仓库路径'],
    ['stateFile', '状态快照文件路径'],
  ]) {
    const v = raw[key];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`配置文件缺少「${label}」（${key}）`);
    cfg[key] = path.resolve(base, v.trim());
  }
  if (!fs.existsSync(path.join(cfg.tasksArea, 'projects'))) throw new Error(`工单区里没有 projects 目录：${cfg.tasksArea}`);
  return cfg;
}

// 读 TASK.md / PROJECT.md 开头的 --- 元数据，只取单行的「键: 值」
export function frontMatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if (/\s+#/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[mm[1]] = v;
  }
  return out;
}

export function loadProjects(cfg, warn = () => {}) {
  const root = path.join(cfg.tasksArea, 'projects');
  const out = new Map();
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const fm = frontMatter(path.join(dir, 'PROJECT.md'));
    if (!fm || !fm.project) continue;
    out.set(fm.project, {
      code: fm.project,
      name: fm.short_name || fm.project,
      dir,
      tasksDir: path.join(dir, 'tasks'),
    });
  }
  if (!out.size) warn('工单区里没有带 PROJECT.md 的项目');
  return out;
}

export function loadTasks(projects) {
  const list = [];
  for (const p of projects.values()) {
    if (!fs.existsSync(p.tasksDir)) continue;
    for (const name of fs.readdirSync(p.tasksDir).sort()) {
      const dir = path.join(p.tasksDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const fm = frontMatter(path.join(dir, 'TASK.md'));
      if (!fm || !fm.id) continue;
      list.push({
        project: p.code,
        id: fm.id,
        title: fm.title || name,
        status: fm.status || '',
        dir,
      });
    }
  }
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const taskKey = t => `${t.project}/${t.id}`;

// ---------- 快照 ----------

export function loadState(file) {
  if (!fs.existsSync(file)) return { first: true, statuses: {} };
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!o || typeof o !== 'object' || !o.statuses || typeof o.statuses !== 'object') return { first: true, statuses: {} };
    return { first: false, statuses: o.statuses };
  } catch {
    // 快照坏了按第一次运行处理：只重建，不凭空写出变化行
    return { first: true, statuses: {} };
  }
}

export function saveState(file, tasks, now = Date.now()) {
  const statuses = {};
  for (const t of tasks) statuses[taskKey(t)] = t.status;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), statuses }, null, 1), 'utf8');
}

export function statusChanges(tasks, state) {
  if (state.first) return [];
  const changes = [];
  for (const t of tasks) {
    const old = state.statuses[taskKey(t)];
    if (old === undefined) continue;
    if (old !== t.status) changes.push({ ...t, from: old, to: t.status });
  }
  return changes;
}

// ---------- git ----------

export function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      windowsHide: true,
    });
  } catch (e) {
    if (allowFail) return null;
    const msg = String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/)[0];
    throw new Error(`git ${args[0]} 失败（${repo}）：${msg}`);
  }
}

const isRepo = dir => fs.existsSync(path.join(dir, '.git'));

function commitsInRepo(repo, day) {
  const out = git(repo, [
    'log',
    `--since=${day}T00:00:00`,
    `--until=${day}T23:59:59`,
    '--pretty=format:%H%x1f%ct%x1f%s%x1e',
  ], { allowFail: true });
  if (!out) return [];
  const list = [];
  for (const block of out.split('\x1e')) {
    const line = block.replace(/^\s+|\s+$/g, '');
    if (!line) continue;
    const [hash, ts, subject] = line.split('\x1f');
    if (hash) list.push({ hash, at: Number(ts) || 0, subject: subject || '' });
  }
  return list;
}

function taskAreaCommits(cfg, day) {
  if (!isRepo(cfg.tasksArea)) return [];
  const out = git(cfg.tasksArea, [
    'log',
    `--since=${day}T00:00:00`,
    `--until=${day}T23:59:59`,
    '--pretty=format:%x1e%H%x1f%ct%x1f%s',
    '--name-only',
  ], { allowFail: true });
  if (!out) return [];
  const commits = [];
  for (const block of out.split('\x1e')) {
    const lines = block.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const [hash, ts, subject] = lines[0].split('\x1f');
    if (!hash) continue;
    commits.push({ hash, at: Number(ts) || 0, subject: subject || '', paths: lines.slice(1) });
  }
  return commits;
}

// 每个项目当天提交：自己的代码仓库 + 工单区里改到 projects/<项目> 的提交
export function collectCommits(cfg, projects, day) {
  const out = new Map();
  const add = (code, c) => {
    if (!out.has(code)) out.set(code, new Map());
    out.get(code).set(c.hash, c);
  };
  for (const p of projects.values()) {
    const repo = path.join(cfg.codeRoot, p.code);
    if (!isRepo(repo)) continue;
    for (const c of commitsInRepo(repo, day)) add(p.code, c);
  }
  for (const c of taskAreaCommits(cfg, day)) {
    const touched = new Set();
    for (const file of c.paths) {
      const parts = file.split('/');
      if (parts[0] !== 'projects' || !parts[1] || !projects.has(parts[1])) continue;
      touched.add(parts[1]);
    }
    for (const code of touched) add(code, c);
  }
  const sorted = new Map();
  for (const [code, m] of out) sorted.set(code, [...m.values()].sort((a, b) => b.at - a.at));
  return sorted;
}

// ---------- 对话 ----------

const countOf = (hay, needle) => {
  if (!needle) return 0;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(hay).match(new RegExp(esc, 'gi'));
  return m ? m.length : 0;
};

// 读存档的对话目录；按标题或内容里的项目代号 / 中文简称归到项目，归不上的算 other
export function collectChats(cfg, day, projects, warn = () => {}) {
  const index = path.join(cfg.archiveRoot, 'conversations', 'INDEX.md');
  const out = new Map();
  if (!fs.existsSync(index)) {
    warn(`对话目录不存在，跳过对话：${index}`);
    return out;
  }
  const rows = [];
  for (const line of fs.readFileSync(index, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (cells.length < 5 || !DAY_RE.test(cells[0].slice(0, 10))) continue;
    if (cells[0].slice(0, 10) !== day) continue;
    rows.push({ title: cells[1] || '（未命名）', file: cells[4] });
  }
  const list = projects.size ? [...projects.values()] : [];
  for (const row of rows) {
    let text = row.title;
    const file = row.file ? path.join(cfg.archiveRoot, row.file) : '';
    if (file && fs.existsSync(file)) {
      try { text += '\n' + fs.readFileSync(file, 'utf8'); } catch { /* 读不到就只看标题 */ }
    }
    let best = null;
    for (const p of list) {
      const titleScore = (countOf(row.title, p.code) + countOf(row.title, p.name)) * 1000;
      const bodyScore = countOf(text, p.code) + countOf(text, p.name) * 2;
      const score = titleScore + bodyScore;
      if (!score) continue;
      if (!best || score > best.score) best = { code: p.code, score, title: row.title };
    }
    const code = best ? best.code : 'other';
    if (!out.has(code)) out.set(code, new Map());
    out.get(code).set(row.title, (out.get(code).get(row.title) || 0) + 1);
  }
  const sorted = new Map();
  for (const [code, m] of out) sorted.set(code, [...m.entries()].sort((a, b) => b[1] - a[1]).map(([title]) => title));
  return sorted;
}

// ---------- 生成记录 ----------

const brief = s => {
  const t = String(s).replace(/^T\d{3}[：:]\s*/, '').trim();
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
};
const idsIn = s => String(s).match(TASK_RE) || [];

export function buildDayRecords({ day, projects, changes, commits, chats, now = Date.now() }) {
  const codes = new Set([...commits.keys(), ...chats.keys(), ...changes.map(c => c.project)]);
  const records = [];
  for (const code of [...codes].sort()) {
    const lines = [];
    const refs = new Set();
    for (const c of changes.filter(x => x.project === code)) {
      lines.push(`${c.id} ${c.title}：${c.from} → ${c.to}`);
      refs.add(c.id);
    }
    const cs = commits.get(code) || [];
    if (cs.length) {
      const shown = cs.slice(0, 3).map(c => brief(c.subject));
      lines.push(`提交 ${cs.length} 次：${shown.join('；')}${cs.length > 3 ? '；…' : ''}`);
      for (const c of cs) for (const id of idsIn(c.subject)) refs.add(id);
    }
    const ts = chats.get(code) || [];
    if (ts.length) {
      lines.push(`和 Claude 聊了 ${ts.length} 段：${ts.slice(0, 5).join('；')}${ts.length > 5 ? '；…' : ''}`);
      for (const t of ts) for (const id of idsIn(t)) refs.add(id);
    }
    if (!lines.length) continue;
    const p = projects.get(code);
    records.push({
      id: `auto-${day}-${code}`,
      type: 'auto',
      kind: 'day',
      day,
      project: code,
      projectName: code === 'other' ? '其他' : (p ? p.name : code),
      lines,
      refs: [...refs].sort(),
      createdAt: now,
      updatedAt: now,
    });
  }
  return records;
}

// 最新一轮报告：R<数字>-REPORT-*.md 里数字最大的；没有就用 TASK.md
export function latestEvidence(task) {
  let best = null;
  try {
    for (const name of fs.readdirSync(task.dir)) {
      const m = /^R(\d+)-REPORT-.*\.md$/i.exec(name);
      if (!m) continue;
      const round = Number(m[1]);
      const file = path.join(task.dir, name);
      const at = fs.statSync(file).mtimeMs;
      if (!best || round > best.round || (round === best.round && at > best.at)) best = { round, file, at, name };
    }
  } catch { /* 目录读不到就退回 TASK.md */ }
  if (best) return { kind: 'link', text: `R${best.round} 报告`, url: best.file };
  return { kind: 'link', text: '工单 TASK.md', url: path.join(task.dir, 'TASK.md') };
}

export function buildSuggestions({ records, tasks, now = Date.now() }) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out = [];
  for (const piece of records) {
    if (piece.deleted || piece.type !== 'piece') continue;
    if (!Array.isArray(piece.refs) || !piece.refs.length) continue;
    if (piece.status === 'done') continue;
    for (const ref of new Set(piece.refs)) {
      const task = byId.get(ref);
      if (!task || !STATUS_DONE.includes(task.status)) continue;
      out.push({
        id: `auto-suggest-${piece.id}-${ref}`,
        type: 'auto',
        kind: 'suggest',
        pieceId: piece.id,
        ref,
        text: `${ref} ${task.title} 已${task.status}`,
        evidence: [latestEvidence(task)],
        dismissed: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const contentOf = r => {
  const { createdAt, updatedAt, ...rest } = r;
  return stableStringify(rest);
};

// 只动 type: "auto"：已忽略的建议不改，内容没变的不重写
export function planWrites(existing, candidates, now = Date.now()) {
  const byId = new Map(existing.map(r => [r.id, r]));
  const writes = [];
  const skipped = [];
  for (const cand of candidates) {
    const old = byId.get(cand.id);
    if (!old) { writes.push(cand); continue; }
    if (old.type !== 'auto') { skipped.push({ id: cand.id, why: 'id 已被非 auto 记录占用' }); continue; }
    if (cand.kind === 'suggest' && old.dismissed === true) continue;
    if (contentOf(old) === contentOf(cand)) continue;
    writes.push({ ...old, ...cand, createdAt: old.createdAt ?? cand.createdAt, updatedAt: now });
  }
  return { writes, skipped };
}

// ---------- 数据仓库 ----------

function readData(repo) {
  const file = path.join(repo, 'data.json');
  if (!fs.existsSync(file)) return { app: 'puzzle-progress', version: 1, records: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.records)) data.records = [];
  return data;
}

function writeData(repo, data, records) {
  const file = path.join(repo, 'data.json');
  fs.writeFileSync(file, JSON.stringify({ ...data, records }, null, 1), 'utf8');
}

function aheadCount(repo) {
  const out = git(repo, ['rev-list', '--count', '@{u}..HEAD'], { allowFail: true });
  const n = out ? Number(out.trim()) : 0;
  return Number.isFinite(n) ? n : 0;
}

function push(repo, warn) {
  const out = git(repo, ['push'], { allowFail: true });
  if (out === null) {
    warn('推送失败（可能没网），本地已提交，下次运行再推');
    return false;
  }
  return true;
}

// ---------- 主流程 ----------

export function run({ configPath, day = dayOf(), dryRun = false, log = console.log, warn = console.error } = {}) {
  const now = Date.now();
  const cfg = loadConfig(configPath);
  const projects = loadProjects(cfg, warn);
  const tasks = loadTasks(projects);
  const state = loadState(cfg.stateFile);
  const changes = statusChanges(tasks, state);
  const commits = collectCommits(cfg, projects, day);
  const chats = collectChats(cfg, day, projects, warn);
  const dayRecords = buildDayRecords({ day, projects, changes, commits, chats, now });

  if (dryRun) {
    if (state.first) log('[试运行] 首次运行：只建快照，不产生状态变化行');
    const data = readData(cfg.dataRepo);
    const suggestions = buildSuggestions({ records: data.records, tasks, now });
    const { writes, skipped } = planWrites(data.records, [...dayRecords, ...suggestions], now);
    for (const s of skipped) warn(`跳过 ${s.id}：${s.why}`);
    log(`[试运行] ${day}：将写入 ${writes.length} 条记录（不写快照、不提交、不推送）`);
    log(JSON.stringify(writes, null, 2));
    return { writes, merged: data.records, changed: writes.length > 0, committed: false, pushed: false, firstRun: state.first, skipped };
  }

  const pulled = git(cfg.dataRepo, ['pull', '--rebase'], { allowFail: true });
  if (pulled === null) {
    warn('拉取数据仓库失败（可能没网），这次不写入，下次运行再试');
    return { writes: [], merged: [], changed: false, committed: false, pushed: false, firstRun: state.first, skipped: [] };
  }
  const data = readData(cfg.dataRepo);
  const suggestions = buildSuggestions({ records: data.records, tasks, now });
  const { writes, skipped } = planWrites(data.records, [...dayRecords, ...suggestions], now);
  for (const s of skipped) warn(`跳过 ${s.id}：${s.why}`);
  const merged = mergeRecords(writes, data.records);
  const changed = !sameRecords(merged, data.records);
  // --day 指到别的日期时只补那一天，不动今天的快照，免得吞掉今天的状态变化
  const today = day === dayOf(now);
  const save = () => {
    if (today) saveState(cfg.stateFile, tasks, now);
    else warn(`${day} 不是今天，状态快照不更新`);
  };

  if (!changed) {
    if (state.first) log(`首次运行：只建快照，不产生状态变化行（${day}）`);
    log(`${day} 没有变化，不提交`);
    save();
    const pending = aheadCount(cfg.dataRepo);
    if (pending > 0) {
      log(`有 ${pending} 条上次没推上去的提交，重试推送`);
      push(cfg.dataRepo, warn);
    }
    return { writes, merged, changed: false, committed: false, pushed: false, firstRun: state.first, skipped };
  }

  writeData(cfg.dataRepo, data, merged);
  git(cfg.dataRepo, ['add', '--', 'data.json']);
  git(cfg.dataRepo, ['commit', '-m', `自动入账 ${timeOf(now)}`]);
  const pushed = push(cfg.dataRepo, warn);
  save();
  log(`${day} 写入 ${writes.length} 条记录，已提交${pushed ? '并推送' : '，推送待重试'}`);
  log(writes.map(r => r.id).join('\n'));
  return { writes, merged, changed: true, committed: true, pushed, firstRun: state.first, skipped };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = run(opts);
    if (res.skipped.length) process.exitCode = 0;
  } catch (e) {
    console.error(`自动入账失败：${e.message}`);
    process.exitCode = 1;
  }
}
