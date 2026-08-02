import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import app from '../index.js';
import { signJwt } from '../auth/jwt.js';
import { makeEnv, makeD1Mock } from '../test/helpers.js';
import { encryptString } from '../auth/crypto.js';

const SECRET = 'test-jwt-secret-min-32-characters-pls!';
const USER = 'user-1';
const STORAGE_ID = 's-1';
const SYNC_FOLDER = 'my-vault';
const ENCRYPTION_KEY = 'test-encryption-key';

const s3Config = {
  endpoint: 'https://s3.example.com',
  bucket: 'b',
  accessKey: 'ak',
  secretKey: 'sk',
  region: 'us-east-1',
  pathStyle: true,
};

let token: string;
beforeAll(async () => {
  token = await signJwt({ sub: USER }, SECRET);
});

function makeApp() {
  return app;
}

function authHeaders(extras: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extras };
}

describe('OPTIONS /api/*', () => {
  it('responds to Obsidian preflight without authentication', async () => {
    const res = await makeApp().request(
      '/api/list',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'app://obsidian.md',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization, X-Storage-Id, X-Sync-Folder',
        },
      },
      makeEnv(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('app://obsidian.md');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Storage-Id');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Sync-Folder');
  });

  it('does not allow an unknown HTTPS origin', async () => {
    const res = await makeApp().request(
      '/api/list',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://unknown.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      },
      makeEnv(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

/** 构造一个 DB mock：storages 表有匹配的加密行 */
async function makeEnvWithStorage() {
  const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
  const row = { id: STORAGE_ID, user_id: USER, name: 'mine', type: 's3', config: encrypted, created_at: 1 };
  const db = makeD1Mock({ first: row });
  return makeEnv({ DB: db, ENCRYPTION_KEY });
}

describe('POST /api/put', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(new Response('', { status: url.includes('tombstone.json') ? 404 : 200 }));
    }));
  });

  it('returns 400 when X-Storage-Id missing', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/put',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'a', mtime: 1, content: 'YQ==' }),
        headers: { 'Content-Type': 'application/json', 'X-Sync-Folder': SYNC_FOLDER, ...authHeaders() },
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Sync-Folder missing', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/put',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'a', mtime: 1, content: 'YQ==' }),
        headers: { 'Content-Type': 'application/json', 'X-Storage-Id': STORAGE_ID, ...authHeaders() },
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 with specific missing field names', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/put',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'a' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Storage-Id': STORAGE_ID,
          'X-Sync-Folder': SYNC_FOLDER,
          ...authHeaders(),
        },
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const data = await res.json<{ error: string }>();
    expect(data.error).toContain('mtime');
    expect(data.error).toContain('content');
  });

  it('accepts empty file content (0-byte file)', async () => {
    const app = makeApp();
    const env = await makeEnvWithStorage();
    const res = await app.request(
      '/api/put',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'empty.md', fileUuid: '550e8400-e29b-41d4-a716-446655440000', mtime: 1, content: '' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Storage-Id': STORAGE_ID,
          'X-Sync-Folder': SYNC_FOLDER,
          ...authHeaders(),
        },
      },
      env,
    );
    expect(res.status).toBe(201);
  });

  it('returns 401 without auth', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/put',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'a', mtime: 1, content: 'YQ==' }),
        headers: {
          'Content-Type': 'application/json',
          'X-Storage-Id': STORAGE_ID,
          'X-Sync-Folder': SYNC_FOLDER,
        },
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 413 when content exceeds maxFileSize', async () => {
    const app = makeApp();
    // 构造 > 20MB 的 base64 内容（仅校验体积，不必真填 20MB 数据）
    // 20MB = 20 * 1024 * 1024 = 20971520；base64 编码会膨胀 ~1.33 倍
    // 直接构造一个超大字符串：base64 → ArrayBuffer 后 > maxFileSize
    const big = 'A'.repeat(21 * 1024 * 1024); // 21MB 字符串，base64 解码后约 15.75MB... 不够
    // 重新算：maxFileSize = 20MB = 20971520 bytes；base64 4 个字符 → 3 字节
    // 要让解码后 > 20971520，需要 base64 长度 > 27962027；构造 ~28MB 字符串
    const oversized = 'A'.repeat(28 * 1024 * 1024);
    const env = await makeEnvWithStorage();
    const res = await app.request(
      '/api/put',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'big', mtime: 1, content: oversized }),
        headers: {
          'Content-Type': 'application/json',
          'X-Storage-Id': STORAGE_ID,
          'X-Sync-Folder': SYNC_FOLDER,
          ...authHeaders(),
        },
      },
      env,
    );
    expect(res.status).toBe(413);
    const data = await res.json<{ error: string; code?: string }>();
    expect(data.code).toBe('FILE_TOO_LARGE');
  });
});

describe('GET /api/get', () => {
  it('returns 400 when X-Storage-Id missing', async () => {
    const app = makeApp();
    const res = await app.request('/api/get?path=a', { headers: authHeaders() }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when path missing', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/get',
      { headers: { 'X-Storage-Id': STORAGE_ID, 'X-Sync-Folder': SYNC_FOLDER, ...authHeaders() } },
      await makeEnvWithStorage(),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/history', () => {
  it('returns an empty version list when the file has no history', async () => {
    const res = await makeApp().request(
      '/api/history?path=notes%2Fempty.md',
      { headers: { 'X-Storage-Id': STORAGE_ID, 'X-Sync-Folder': SYNC_FOLDER, ...authHeaders() } },
      await makeEnvWithStorage(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: [] });
  });
});
describe('GET /api/list', () => {
  it('returns 400 when X-Storage-Id missing', async () => {
    const app = makeApp();
    const res = await app.request('/api/list', { headers: authHeaders() }, makeEnv());
    expect(res.status).toBe(400);
  });
});


describe('CORS origin allowlist', () => {
  it.each(['capacitor://localhost', 'http://localhost', 'https://unknown.example.com'])('does not allow %s', async (origin) => {
    const res = await makeApp().request(
      '/api/list',
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
        },
      },
      makeEnv(),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
