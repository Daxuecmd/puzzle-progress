// 真仓库冒烟测试：令牌只从环境变量 PP_TOKEN 读，不落盘。
// 拉取 → 新增一条随手记 → 推送 → 再拉取看到它 → 标记删除 → 推送
import * as C from '../core.js';
import * as S from '../sync.js';

const token = process.env.PP_TOKEN;
if (!token) { console.log('没有 PP_TOKEN，跳过'); process.exit(1); }
const cfg = { api: 'https://api.github.com', repo: process.env.PP_REPO || 'Daxuecmd/puzzle-progress-data', token };

const info = await S.testConnection(cfg);
console.log('仓库：', info.name, info.private ? '私有' : '公开！');
if (!info.private) process.exit(1);

let recs = (await S.pull(cfg)).records;
console.log('拉取到记录：', recs.length);
const id = 'smoke-' + C.uid();
const note = { id, type: 'note', text: '冒烟测试（会自动删除）', at: Date.now(), pieceId: null, createdAt: Date.now(), updatedAt: Date.now() };
const opts = () => ({
  device: '冒烟测试',
  localRecords: async () => recs,
  saveLocal: async m => { recs = m; },
  pendingFiles: async () => [],
  markFileSynced: async () => { },
});
recs = C.mergeRecords(recs, [note]);
await S.syncOnce(cfg, opts());
const again = (await S.pull(cfg)).records;
if (!again.some(r => r.id === id)) { console.log('✗ 推上去后拉不回来'); process.exit(1); }
console.log('✓ 推送后再拉取能看到这条');
recs = C.mergeRecords(again, [{ ...note, deleted: true, updatedAt: Date.now() + 1 }]);
await S.syncOnce(cfg, opts());
const last = (await S.pull(cfg)).records.find(r => r.id === id);
if (!last?.deleted) { console.log('✗ 删除标记没生效'); process.exit(1); }
console.log('✓ 删除标记已同步');
