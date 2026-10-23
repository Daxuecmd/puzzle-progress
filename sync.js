// 和私有数据仓库同步：数据是一个 data.json，图片和录音各自是 files/ 下的一个文件
import { mergeRecords, sameRecords, utf8ToB64, b64ToUtf8, bytesToB64 } from './core.js';

export const DATA_PATH = 'data.json';

export class SyncError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

async function call(cfg, path, { method = 'GET', body, raw } = {}) {
  let r;
  try {
    r = await fetch(`${cfg.api}/repos/${cfg.repo}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('网络不通，联网后会自动同步', 'network');
  }
  if (r.status === 401) throw new SyncError('令牌不对或已过期，请到设置里重新填', 'auth');
  if (r.status === 403) throw new SyncError('令牌没有数据仓库的读写权限', 'perm');
  return r;
}

const fail = async (r, what) => {
  let detail = '';
  try { detail = (await r.json()).message || ''; } catch { /* 无正文 */ }
  return new SyncError(`${what}失败（${r.status}${detail ? '：' + detail : ''}）`, 'http');
};

export async function testConnection(cfg) {
  const r = await call(cfg, '');
  if (r.status === 404) throw new SyncError('找不到数据仓库：检查仓库名，或令牌没有选这个仓库', 'missing');
  if (!r.ok) throw await fail(r, '连接');
  const info = await r.json();
  return { private: info.private, name: info.full_name };
}

export async function pull(cfg) {
  const r = await call(cfg, `/contents/${DATA_PATH}`);
  if (r.status === 404) {
    const repo = await call(cfg, '');
    if (repo.status === 404) throw new SyncError('找不到数据仓库：检查仓库名，或令牌没有选这个仓库', 'missing');
    return { records: [], sha: null };
  }
  if (!r.ok) throw await fail(r, '拉取');
  const meta = await r.json();
  let text;
  if (meta.content) text = b64ToUtf8(meta.content);
  else {
    // 超过 1MB 时接口不带正文，改取原文
    const rr = await call(cfg, `/contents/${DATA_PATH}`, { raw: true });
    if (!rr.ok) throw await fail(rr, '拉取');
    text = await rr.text();
  }
  const data = JSON.parse(text || '{}');
  return { records: data.records || [], sha: meta.sha };
}

export async function push(cfg, records, sha, device) {
  const content = utf8ToB64(JSON.stringify({ app: 'puzzle-progress', version: 1, records }, null, 1));
  const r = await call(cfg, `/contents/${DATA_PATH}`, {
    method: 'PUT',
    body: { message: `同步：${device} ${new Date().toLocaleString('zh-CN')}`, content, ...(sha ? { sha } : {}) },
  });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw await fail(r, '上传');
  return { conflict: false, sha: (await r.json()).content.sha };
}

export async function uploadFile(cfg, file) {
  const bytes = new Uint8Array(await file.blob.arrayBuffer());
  const r = await call(cfg, `/contents/files/${file.id}`, {
    method: 'PUT',
    body: { message: `附件：${file.name || file.id}`, content: bytesToB64(bytes) },
  });
  // 422 = 文件已经在仓库里（另一台设备传过或上次传了一半）
  if (!r.ok && r.status !== 422) throw await fail(r, '上传附件');
}

export async function downloadFile(cfg, id) {
  const r = await call(cfg, `/contents/files/${id}`, { raw: true });
  if (!r.ok) throw await fail(r, '下载附件');
  return r.blob();
}

// 一次完整同步：拉 → 合并 → 写回本机 → 传附件 → 推。推的时候撞上别的设备刚推过，就重来，最多 3 次
export async function syncOnce(cfg, { localRecords, saveLocal, pendingFiles, markFileSynced, device }) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const remote = await pull(cfg);
    const local = await localRecords();
    const merged = mergeRecords(local, remote.records);
    if (!sameRecords(merged, local)) await saveLocal(merged);
    for (const f of await pendingFiles()) {
      await uploadFile(cfg, f);
      await markFileSynced(f.id);
    }
    if (sameRecords(merged, remote.records)) return { pushed: false, count: merged.length };
    const res = await push(cfg, merged, remote.sha, device);
    if (!res.conflict) return { pushed: true, count: merged.length };
  }
  throw new SyncError('同时有别的设备在同步，稍后会自动重试', 'conflict');
}
