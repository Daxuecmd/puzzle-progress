// 自动入账自测：node tests/collect-check.mjs
// 全部用假数据在系统临时目录里跑：假工单区、假代码仓库、假存档、假数据仓库（本地裸仓库当远程）。
// 不碰真实工单、代码、存档和数据仓库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, dayOf, timeOf, dayWindow, loadConfig } from '../tools/collect.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + String(e.stack || e).split('\n').slice(0, 4).join('\n    ')); }
}

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true,
}).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const pad = n => String(n).padStart(2, '0');
// 对话存档 INDEX 里的时间由 archive.mjs 按本机时钟写，这里照样用本机时钟造数据
const localStamp = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const day = dayOf(Date.now());

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-check-'));
const tasksArea = path.join(root, 'tasks-area');
const codeRoot = path.join(root, 'code');
const archiveRoot = path.join(root, 'archive');
const dataRepo = path.join(root, 'data-repo');
const remote = path.join(root, 'remote.git');
const stateFile = path.join(root, 'state', 'collect-state.json');
const configFile = path.join(root, 'collect.config.json');
const projectDir = path.join(tasksArea, 'projects', 'demo-project');
const taskDir = path.join(projectDir, 'tasks', 'T901-first');
const codeRepo = path.join(codeRoot, 'demo-project');
const dataFile = path.join(dataRepo, 'data.json');

function config() {
  return { tasksArea, codeRoot, archiveRoot, dataRepo, stateFile, timeZone: 'Asia/Shanghai' };
}
const readData = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const writeTask = status => write(path.join(taskDir, 'TASK.md'),
  `---\nid: T901\ntitle: 示例任务\nstatus: ${status}\n---\n\n假任务，只给自测用。\n`);
const writeConfig = () => write(configFile, JSON.stringify(config(), null, 1));

function setup() {
  // 假工单区
  write(path.join(projectDir, 'PROJECT.md'), '---\nproject: demo-project\nshort_name: 示例项目\nstatus: 进行中\n---\n\n假项目。\n');
  writeTask('执行中');

  // 假代码仓库：先有 1 次提交
  fs.mkdirSync(codeRepo, { recursive: true });
  git(codeRepo, 'init', '-b', 'main');
  git(codeRepo, 'config', 'user.name', '测试');
  git(codeRepo, 'config', 'user.email', 'test@example.com');
  write(path.join(codeRepo, 'README.md'), '假代码仓库\n');
  git(codeRepo, 'add', 'README.md');
  git(codeRepo, 'commit', '-m', 'T901: 示例初始提交');

  // 假存档：目录里 1 段标题能对上项目的对话（时间按本机时钟写，和真存档一样）
  write(path.join(archiveRoot, 'conversations', 'INDEX.md'),
    `# 对话目录\n\n| 最后时间 | 标题 | 来自 | 用户发言 | 文件 |\n|---|---|---|---|---|\n` +
    `| ${localStamp()} | 示例项目进度 | claude | 2 | conversations/claude/demo__1.md |\n`);
  write(path.join(archiveRoot, 'conversations', 'claude', 'demo__1.md'), '# 示例项目进度\n\n假对话正文。\n');

  // 假数据仓库：本地仓库 + 裸仓库当远程，先放非 auto 记录
  const initial = {
    app: 'puzzle-progress',
    version: 1,
    records: [
      { id: 'demo-puzzle', type: 'puzzle', lane: 'main', name: '示例拼图', updatedAt: 1 },
      { id: 'demo-piece', type: 'piece', puzzleId: 'demo-puzzle', name: '示例拼块', status: 'empty', refs: ['T901'], updatedAt: 1 },
      { id: 'demo-note', type: 'note', text: '示例随手记', at: 1, updatedAt: 1 },
    ],
  };
  fs.mkdirSync(dataRepo, { recursive: true });
  git(dataRepo, 'init', '-b', 'main');
  git(dataRepo, 'config', 'user.name', '测试');
  git(dataRepo, 'config', 'user.email', 'test@example.com');
  write(dataFile, JSON.stringify(initial, null, 1));
  git(dataRepo, 'add', 'data.json');
  git(dataRepo, 'commit', '-m', '测试：初始数据');

  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--bare');
  git(dataRepo, 'remote', 'add', 'origin', remote);
  git(dataRepo, 'push', '-u', 'origin', 'main');

  writeConfig();
}

function assertNonAuto(data) {
  const initial = [
    { id: 'demo-puzzle', type: 'puzzle', lane: 'main', name: '示例拼图', updatedAt: 1 },
    { id: 'demo-piece', type: 'piece', puzzleId: 'demo-puzzle', name: '示例拼块', status: 'empty', refs: ['T901'], updatedAt: 1 },
    { id: 'demo-note', type: 'note', text: '示例随手记', at: 1, updatedAt: 1 },
  ];
  for (const rec of initial) {
    assert.deepEqual(data.records.find(r => r.id === rec.id), rec, `非 auto 记录 ${rec.id} 被改了`);
  }
  assert.equal(data.records.filter(r => r.type !== 'auto').length, initial.length);
}

const quiet = { configPath: configFile, log: () => {}, warn: () => {} };

setup();

console.log('自动入账');

t('按北京时间分天，不受本机时区影响', () => {
  // 本机是太平洋时间：17:30 已是北京第二天 08:30；08:00 仍是北京同一天 23:00
  assert.equal(dayOf(Date.parse('2026-10-25T17:30:00-07:00')), '2026-10-26');
  assert.equal(dayOf(Date.parse('2026-10-25T08:00:00-07:00')), '2026-10-25');
  assert.equal(timeOf(Date.parse('2026-10-25T17:30:00-07:00')), '2026-10-26 08:30');
  assert.equal(timeOf(Date.parse('2026-10-25T08:00:00-07:00')), '2026-10-25 23:00');
  // 北京时间 10-26 这一天，对应的 UTC 起止应是 10-25 16:00 到 10-26 15:59:59
  const { start, end } = dayWindow('2026-10-26', 'Asia/Shanghai');
  assert.equal(new Date(start).toISOString(), '2026-10-25T16:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-10-26T15:59:59.000Z');
});

t('配置里没写 timeZone 时默认按北京时间', () => {
  const noTz = path.join(root, 'collect.config.no-timezone.json');
  const { timeZone, ...rest } = config();
  write(noTz, JSON.stringify(rest, null, 1));
  assert.equal(loadConfig(noTz).timeZone, 'Asia/Shanghai');
  assert.equal(loadConfig(configFile).timeZone, 'Asia/Shanghai');
});

let firstDay = null;
let firstHead = '';
const dismissedAt = Date.now() + 1000;

t('首次运行只建快照，不写状态变化行，也不生成建议', () => {
  const res = run(quiet);
  assert.equal(res.firstRun, true);
  assert.ok(fs.existsSync(stateFile), '没有写状态快照');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.statuses['demo-project/T901'], '执行中');

  const data = readData();
  const days = data.records.filter(r => r.type === 'auto' && r.kind === 'day');
  assert.equal(days.length, 1);
  firstDay = days[0];
  assert.equal(firstDay.id, `auto-${day}-demo-project`);
  assert.equal(firstDay.projectName, '示例项目');
  assert.ok(!firstDay.lines.some(l => l.includes('→')), '首次运行不该有状态变化行');
  assert.ok(firstDay.lines.some(l => l === '提交 1 次：示例初始提交'));
  assert.ok(firstDay.lines.some(l => l === '和 Claude 聊了 1 段：示例项目进度'));
  assert.deepEqual(firstDay.refs, ['T901']);
  assert.equal(data.records.filter(r => r.type === 'auto' && r.kind === 'suggest').length, 0);
  assertNonAuto(data);
  firstHead = git(dataRepo, 'rev-parse', 'HEAD');
  assert.ok(git(remote, 'log', '--oneline', '--all').includes('自动入账'), '没有推送到远程');
});

t('同一天没有变化时不提交', () => {
  const res = run(quiet);
  assert.equal(res.changed, false);
  assert.equal(git(dataRepo, 'rev-parse', 'HEAD'), firstHead, 'HEAD 变了，说明又提交了');
  const data = readData();
  assert.equal(data.records.filter(r => r.type === 'auto' && r.kind === 'day').length, 1);
  assertNonAuto(data);
});

t('状态变化成一行，同一天重跑覆盖同一 id，不新增', () => {
  writeTask('待验收');
  write(path.join(codeRepo, 'second.txt'), '第二次提交\n');
  git(codeRepo, 'add', 'second.txt');
  git(codeRepo, 'commit', '-m', 'T901: 示例第二次提交');
  write(path.join(taskDir, 'R1-REPORT-fake.md'), '# 假报告\n');

  const res = run(quiet);
  assert.equal(res.committed, true);
  const data = readData();
  const days = data.records.filter(r => r.type === 'auto' && r.kind === 'day');
  assert.equal(days.length, 1, '同一天不该新增第二条汇总');
  const d = days[0];
  assert.equal(d.id, firstDay.id);
  assert.equal(d.createdAt, firstDay.createdAt, '同一条记录不该换 createdAt');
  assert.ok(d.updatedAt >= firstDay.updatedAt);
  const statusLines = d.lines.filter(l => l.startsWith('T901 '));
  assert.deepEqual(statusLines, ['T901 示例任务：执行中 → 待验收']);
  assert.ok(d.lines.some(l => l.startsWith('提交 2 次：')), '提交次数没有累加');
  assert.ok(d.lines.some(l => l.includes('示例第二次提交')));
  assert.ok(d.lines.some(l => l.includes('示例初始提交')), '只有 2 条提交，不该省略');

  const sug = data.records.find(r => r.id === 'auto-suggest-demo-piece-T901');
  assert.ok(sug, '待验收时没有生成建议');
  assert.equal(sug.kind, 'suggest');
  assert.equal(sug.pieceId, 'demo-piece');
  assert.equal(sug.ref, 'T901');
  assert.equal(sug.text, 'T901 示例任务 已待验收');
  assert.equal(sug.dismissed, false);
  assert.equal(sug.evidence.length, 1);
  assert.equal(sug.evidence[0].kind, 'link');
  assert.equal(sug.evidence[0].text, 'R1 报告');
  assert.ok(sug.evidence[0].url.endsWith('R1-REPORT-fake.md'));
  assertNonAuto(data);
});

t('状态变化后再跑一次（无新变化），旧状态行仍在，且不产生新提交', () => {
  const head = git(dataRepo, 'rev-parse', 'HEAD');
  const res = run(quiet);
  assert.equal(res.changed, false, '没有新变化却又写入了');
  assert.equal(git(dataRepo, 'rev-parse', 'HEAD'), head, 'HEAD 变了，说明又提交了');
  const d = readData().records.find(r => r.id === firstDay.id);
  const statusLines = d.lines.filter(l => l.startsWith('T901 '));
  assert.deepEqual(statusLines, ['T901 示例任务：执行中 → 待验收'], '旧的状态变化行被抹掉或重复了');
  assert.deepEqual(d.lines.slice(-2).map(l => l.replace(/\d+/g, 'N')), [
    '提交 N 次：示例第二次提交；示例初始提交',
    '和 Claude 聊了 N 段：示例项目进度',
  ], '状态变化行没有排在最前，或两段汇总没接在后面');
});

t('dismissed: true 的建议不被改', () => {
  const data = readData();
  const sug = data.records.find(r => r.id === 'auto-suggest-demo-piece-T901');
  sug.dismissed = true;
  sug.updatedAt = dismissedAt;
  write(dataFile, JSON.stringify(data, null, 1));
  git(dataRepo, 'add', 'data.json');
  git(dataRepo, 'commit', '-m', '测试：用户忽略了建议');
  git(dataRepo, 'push');

  writeTask('完成');
  write(path.join(taskDir, 'R2-REPORT-fake.md'), '# 第二轮假报告\n');
  const res = run(quiet);
  assert.equal(res.committed, true);

  const after = readData();
  const again = after.records.find(r => r.id === 'auto-suggest-demo-piece-T901');
  assert.equal(again.dismissed, true, '被忽略的建议又被改了');
  assert.equal(again.text, 'T901 示例任务 已待验收', '被忽略的建议内容被改了');
  assert.equal(again.updatedAt, dismissedAt, '被忽略的建议 updatedAt 被改了');
  assert.equal(again.evidence[0].url.endsWith('R1-REPORT-fake.md'), true);

  const days = after.records.filter(r => r.type === 'auto' && r.kind === 'day');
  assert.equal(days.length, 1);
  assert.ok(days[0].lines.includes('T901 示例任务：待验收 → 完成'));
  assert.equal(after.records.filter(r => r.type === 'auto' && r.kind === 'suggest').length, 1);
  assertNonAuto(after);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.statuses['demo-project/T901'], '完成');
  assert.ok((git(remote, 'log', '--oneline', '--all').match(/自动入账/g) || []).length >= 3);
});

t('同一天先后两次不同变化，两行都在、顺序正确', () => {
  // 新项目、新工单：第一次出现只登记快照，不算变化
  const p2 = path.join(tasksArea, 'projects', 'demo-two');
  write(path.join(p2, 'PROJECT.md'), '---\nproject: demo-two\nshort_name: 示例二号\n---\n\n假项目。\n');
  const t2dir = path.join(p2, 'tasks', 'T902-second');
  const writeT2 = s => write(path.join(t2dir, 'TASK.md'), `---\nid: T902\ntitle: 二号任务\nstatus: ${s}\n---\n`);
  writeT2('执行中');
  assert.equal(run(quiet).changed, false, '新工单第一次出现不该写变化行');

  writeT2('待验收');
  assert.equal(run(quiet).changed, true, '第一次变化没有写入');
  writeT2('完成');
  assert.equal(run(quiet).changed, true, '第二次变化没有写入');

  const data = readData();
  const days = data.records.filter(r => r.type === 'auto' && r.kind === 'day' && r.project === 'demo-two');
  assert.equal(days.length, 1, '同一天不该新增第二条汇总');
  assert.deepEqual(days[0].lines, [
    'T902 二号任务：执行中 → 待验收',
    'T902 二号任务：待验收 → 完成',
  ], '两行状态变化没有按先后顺序保留');
  assert.deepEqual(days[0].refs, ['T902']);
  assertNonAuto(data);

  // 只有状态变化行的记录，没有新内容再跑一次也要原样保留
  const head = git(dataRepo, 'rev-parse', 'HEAD');
  assert.equal(run(quiet).changed, false, '没有新变化却又写入了');
  assert.equal(git(dataRepo, 'rev-parse', 'HEAD'), head, 'HEAD 变了，说明又提交了');
  const again = readData().records.find(r => r.id === days[0].id);
  assert.deepEqual(again.lines, days[0].lines, '再跑一次把状态变化行抹掉了');
});

console.log(`\n${pass} 项通过，${fail} 项失败`);

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ }
if (fail) process.exitCode = 1;
