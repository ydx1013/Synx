// Synx-Sync WebDAV 全链路端到端测试（对着部署后的 Workers URL）。
//
// 跑法（PowerShell）：
//   $env:SYNX_WORKER_URL='https://synx-sync-worker.ydxu.workers.dev'
//   $env:SYNX_WEBDAV_ADDRESS='https://dav.jianguoyun.com/dav/'
//   $env:SYNX_WEBDAV_USER='<账号>'
//   $env:SYNX_WEBDAV_PASS='<应用密码>'
//   node scripts/e2e/webdav-e2e.mjs
//
// 链路：register → storage/test → storage create → put v1 → get 校验 → list
//       → put v2 → history(2 版本) → rollback 到 v1 → 坚果云 PROPFIND → 严格删除
// 用户名、对象 key 和远程目录均唯一，结束时确认 API 元数据与远程目录已清理。

const WORKER_URL = (process.env.SYNX_WORKER_URL || '').replace(/\/+$/, '');
const WD_ADDRESS = process.env.SYNX_WEBDAV_ADDRESS || '';
const WD_USER = process.env.SYNX_WEBDAV_USER || '';
const WD_PASS = process.env.SYNX_WEBDAV_PASS || '';
const runId = `${Date.now()}-${crypto.randomUUID()}`;
const REMOTE_BASE_DIR = `synx-e2e-test-${runId}`;
const SYNC_FOLDER = `synx-e2e-${runId}`;

if (!WORKER_URL || !WD_ADDRESS || !WD_USER || !WD_PASS) {
  console.error('缺少环境变量 SYNX_WORKER_URL / SYNX_WEBDAV_ADDRESS / SYNX_WEBDAV_USER / SYNX_WEBDAV_PASS');
  process.exit(2);
}

const ts = Date.now();
const username = `synx_e2e_${ts}`;
const email = `synx-e2e-${ts}@example.com`;
const password = crypto.randomUUID();
const basicAuth = 'Basic ' + Buffer.from(`${WD_USER}:${WD_PASS}`).toString('base64');

let step = 0;
function log(msg) { console.log(`[${String(step).padStart(2, '0')}] ${msg}`); }
function fail(msg) { throw new Error(msg); }

let token = '';
let storageId = '';
const path = 'e2e-test.md';
let v1Id = '';

async function api(method, route, { headers = {}, body, query } = {}) {
  const url = new URL(WORKER_URL + route);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

try {
  // 01 注册
  step = 1; log(`注册用户 ${username}`);
  {
    const r = await api('POST', '/api/auth/register', { body: { username, email, password } });
    if (r.status !== 201) fail(`register 期望 201，实际 ${r.status}: ${r.text}`);
    token = r.json.token;
    if (!token) fail('register 没返回 token');
    console.log(`    token 拿到，user=${r.json.user.username}`);
  }

  // 02 连通性测试（真实打坚果云）
  step = 2; log('POST /api/storage/test 连通性测试（真实坚果云 list→put→overwrite→get→delete）');
  {
    const r = await api('POST', '/api/storage/test', {
      headers: authHeaders(),
      body: {
        type: 'webdav',
        config: { address: WD_ADDRESS, username: WD_USER, password: WD_PASS, authType: 'basic', remoteBaseDir: REMOTE_BASE_DIR },
      },
    });
    if (r.status !== 200 || !r.json?.ok) fail(`storage/test 期望 {ok:true}，实际 ${r.status}: ${r.text}`);
    console.log('    连通性 OK');
  }

  // 03 创建存储
  step = 3; log('POST /api/storage 创建 WebDAV 存储');
  {
    const r = await api('POST', '/api/storage', {
      headers: authHeaders(),
      body: {
        name: `e2e-${ts}`,
        type: 'webdav',
        config: { address: WD_ADDRESS, username: WD_USER, password: WD_PASS, authType: 'basic', remoteBaseDir: REMOTE_BASE_DIR },
      },
    });
    if (r.status !== 201) fail(`storage create 期望 201，实际 ${r.status}: ${r.text}`);
    storageId = r.json.storage.id;
    console.log(`    storageId=${storageId}`);
  }

  const storageHeaders = authHeaders({ 'X-Storage-Id': storageId });
  const putHeaders = authHeaders({ 'X-Storage-Id': storageId, 'X-Sync-Folder': SYNC_FOLDER });

  // 04 put v1
  step = 4; log(`POST /api/put v1 (path=${path})`);
  {
    const content = Buffer.from(`hello e2e v1 @ ${ts}`);
    const r = await api('POST', '/api/put', {
      headers: putHeaders,
      body: { path, mtime: ts, content: content.toString('base64'), author: 'e2e-script' },
    });
    if (r.status !== 201) fail(`put v1 期望 201，实际 ${r.status}: ${r.text}`);
    v1Id = r.json.version.versionId;
    if (!v1Id) fail('put v1 没返回 version.versionId');
    console.log(`    versionId=${v1Id}`);
  }

  // 05 get 校验内容
  step = 5; log('GET /api/get 校验内容');
  {
    const r = await api('GET', '/api/get', { headers: storageHeaders, query: { path } });
    if (r.status !== 200) fail(`get 期望 200，实际 ${r.status}: ${r.text}`);
    const got = Buffer.from(r.json.content, 'base64').toString();
    if (got !== `hello e2e v1 @ ${ts}`) fail(`内容不匹配：${got}`);
    console.log('    内容一致');
  }

  // 06 list
  step = 6; log('GET /api/list');
  {
    const r = await api('GET', '/api/list', { headers: storageHeaders });
    if (r.status !== 200) fail(`list 期望 200，实际 ${r.status}: ${r.text}`);
    const hit = r.json.files.some(f => f.path === path);
    if (!hit) fail(`list 没找到 ${path}`);
    console.log(`    list 含 ${path}（共 ${r.json.files.length} 个 current 文件）`);
  }

  // 07 put v2
  step = 7; log('POST /api/put v2（同 path 不同内容）');
  {
    const content = Buffer.from(`hello e2e v2 @ ${ts}`);
    const r = await api('POST', '/api/put', {
      headers: putHeaders,
      body: { path, mtime: ts + 1000, content: content.toString('base64'), author: 'e2e-script' },
    });
    if (r.status !== 201) fail(`put v2 期望 201，实际 ${r.status}: ${r.text}`);
    console.log(`    versionId=${r.json.version.versionId}`);
  }

  // 08 history（期望 2 版本）
  step = 8; log('GET /api/history');
  {
    const r = await api('GET', '/api/history', { headers: storageHeaders, query: { path } });
    if (r.status !== 200) fail(`history 期望 200，实际 ${r.status}: ${r.text}`);
    if (r.json.versions.length < 2) fail(`history 期望 >=2 版本，实际 ${r.json.versions.length}`);
    console.log(`    历史 ${r.json.versions.length} 个版本`);
  }

  // 09 rollback 到 v1
  step = 9; log(`POST /api/rollback 回滚到 ${v1Id}`);
  {
    const r = await api('POST', '/api/rollback', {
      headers: putHeaders,
      body: { path, version: v1Id },
    });
    if (r.status !== 201) fail(`rollback 期望 201，实际 ${r.status}: ${r.text}`);
    console.log(`    新版本 ${r.json.version.versionId}（内容回退为 v1）`);
  }

  // 10 校验回滚后 get 是 v1 内容
  step = 10; log('GET /api/get 校验回滚后内容');
  {
    const r = await api('GET', '/api/get', { headers: storageHeaders, query: { path } });
    if (r.status !== 200) fail(`get 期望 200，实际 ${r.status}: ${r.text}`);
    const got = Buffer.from(r.json.content, 'base64').toString();
    if (got !== `hello e2e v1 @ ${ts}`) fail(`回滚后内容应为 v1，实际：${got}`);
    console.log('    回滚后内容 = v1 ✓');
  }

  // 11 坚果云侧 PROPFIND 确认对象真的落地
  step = 11; log('坚果云 PROPFIND 确认对象落地');
  {
    const url = `${WD_ADDRESS.replace(/\/+$/, '')}/${REMOTE_BASE_DIR}/${SYNC_FOLDER}/`;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: { Authorization: basicAuth, Depth: '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
    });
    if (!res.ok) fail(`坚果云 PROPFIND 失败 ${res.status}`);
    const xml = await res.text();
    if (!xml.includes(path)) fail(`坚果云侧未找到 ${path}`);
    const occurrences = (xml.match(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    console.log(`    坚果云侧找到 ${occurrences} 个 ${path} 版本对象`);
  }

  step = 12; log('DELETE /api/storage 仅删除 Synx 元数据并保留远端文件');
  {
    const r = await api('DELETE', `/api/storage/${encodeURIComponent(storageId)}`, { headers: authHeaders() });
    if (r.status !== 200 || !r.json?.ok) fail(`storage delete 期望 200 {ok:true}，实际 ${r.status}: ${r.text}`);
    if (!r.json.remoteFilesPreserved || r.json.deletedVersions < 3) fail(`storage delete 纯中介语义异常: ${r.text}`);
    const verify = await api('GET', `/api/storage/${encodeURIComponent(storageId)}`, { headers: authHeaders() });
    if (verify.status !== 404) fail(`storage metadata 应已删除，GET 实际 ${verify.status}: ${verify.text}`);
    const remote = await fetch(`${WD_ADDRESS.replace(/\/+$/, '')}/${REMOTE_BASE_DIR}/${SYNC_FOLDER}/`, {
      method: 'PROPFIND',
      headers: { Authorization: basicAuth, Depth: '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
    });
    if (!remote.ok || !(await remote.text()).includes(path)) fail('移除 Synx 存储后用户远端文件未被保留');
    storageId = '';
    console.log(`    已删除元数据 ${r.json.deletedVersions} 条，远端文件仍保留`);
  }

  console.log('\n✅ 全链路 e2e 通过（Synx 仅作中介，远端文件由测试专属目录清理）');
} catch (e) {
  console.error(`\n✗ FAIL: ${e?.stack || e}`);
  process.exitCode = 1;
} finally {
  if (WD_ADDRESS) {
    const url = `${WD_ADDRESS.replace(/\/+$/, '')}/${REMOTE_BASE_DIR}/`;
    try {
      const deleted = await fetch(url, { method: 'DELETE', headers: { Authorization: basicAuth } });
      if (!deleted.ok && deleted.status !== 404) throw new Error(`DELETE ${deleted.status}`);
      const verified = await fetch(url, {
        method: 'PROPFIND',
        headers: { Authorization: basicAuth, Depth: '0', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
      });
      if (verified.status !== 404 && verified.status !== 410) throw new Error(`PROPFIND ${verified.status}`);
      console.log(`\n清理：已确认删除坚果云 ${REMOTE_BASE_DIR}/`);
    } catch (error) {
      console.error(`\n清理失败：${REMOTE_BASE_DIR}/ 仍可能残留（${error instanceof Error ? error.message : error}）`);
      process.exitCode = 1;
    }
  }
}
