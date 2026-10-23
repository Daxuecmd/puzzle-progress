// 模拟 GitHub 内容接口：读、写、版本号不对时返回 409。测试一律对着它跑，不碰真仓库
import http from 'node:http';
import crypto from 'node:crypto';

export async function mockGitHub(port = 0, { repo = 'me/data', token = 'test-token', private: isPrivate = true } = {}) {
  const files = new Map(); // 路径 → { bytes, sha }
  const stats = { gets: 0, puts: 0, conflicts: 0 };
  let forceConflicts = 0;
  let down = false;
  const sha = b => crypto.createHash('sha1').update(b).digest('hex');

  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    };
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { ...cors, 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (down) { req.socket.destroy(); return; }
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
    const url = new URL(req.url, 'http://x');
    const base = `/repos/${repo}`;
    if (!url.pathname.startsWith(base)) return send(404, { message: 'Not Found' });
    const rest = url.pathname.slice(base.length);
    if (rest === '' || rest === '/') return send(200, { full_name: repo, private: isPrivate });
    if (!rest.startsWith('/contents/')) return send(404, { message: 'Not Found' });
    const p = decodeURIComponent(rest.slice('/contents/'.length));

    if (req.method === 'GET') {
      stats.gets++;
      const f = files.get(p);
      if (!f) return send(404, { message: 'Not Found' });
      if ((req.headers.accept || '').includes('raw')) return send(200, f.bytes, 'application/octet-stream');
      // 和真接口一样：超过 1MB 的文件不带正文
      const big = f.bytes.length > 1024 * 1024;
      return send(200, { path: p, sha: f.sha, size: f.bytes.length, encoding: big ? 'none' : 'base64', content: big ? '' : f.bytes.toString('base64') });
    }
    if (req.method === 'PUT') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      const cur = files.get(p);
      if (forceConflicts > 0) { forceConflicts--; stats.conflicts++; return send(409, { message: 'conflict (forced)' }); }
      if (cur && body.sha !== cur.sha) { stats.conflicts++; return send(cur && !body.sha ? 422 : 409, { message: 'sha mismatch' }); }
      if (!cur && body.sha) { stats.conflicts++; return send(409, { message: 'file gone' }); }
      const bytes = Buffer.from(body.content || '', 'base64');
      const s = sha(bytes);
      files.set(p, { bytes, sha: s });
      stats.puts++;
      return send(cur ? 200 : 201, { content: { path: p, sha: s } });
    }
    send(405, { message: 'Method Not Allowed' });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  return {
    api: `http://127.0.0.1:${addr.port}`,
    repo, token, files, stats,
    forceConflict(n = 1) { forceConflicts = Math.max(0, forceConflicts + n); },
    setDown(v) { down = v; },
    data() { const f = files.get('data.json'); return f ? JSON.parse(f.bytes.toString('utf8')) : null; },
    close: () => new Promise(r => server.close(r)),
  };
}
