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

/** 构造一个 DB mock：storages 表有匹配的加密行 */
async function makeEnvWithStorage() {
  const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
  const row = { id: STORAGE_ID, user_id: USER, name: 'mine', type: 's3', config: encrypted, created_at: 1 };
  const db = makeD1Mock({ first: row });
  return makeEnv({ DB: db, ENCRYPTION_KEY });
}

function headers(extras: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Storage-Id': STORAGE_ID,
    'X-Sync-Folder': SYNC_FOLDER,
    ...extras,
  };
}

describe('POST /api/repository/direct-upload/start', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url.includes('retention.json')) return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(new Response('', { status: 200 }));
    }));
  });

  it('返回预签名 PUT 直传 URL 且不接收文件内容', async () => {
    const env = await makeEnvWithStorage();
    const res = await app.request('/api/repository/direct-upload/start', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: 'large.bin', size: 10 * 1024 * 1024, hash: 'a'.repeat(64), mtime: 1700000000000 }),
    }, env);
    expect(res.status).toBe(201);
    const data = await res.json() as { blobId: string; uploadUrl: string; expiresIn: number };
    expect(data.blobId).toContain('my-vault/large.bin@');
    expect(data.uploadUrl).toContain('large.bin');
    expect(data.uploadUrl).toContain('X-Amz-Signature');
    expect(data.expiresIn).toBe(900);
  });

  it('超过服务端保留策略默认 20MB 时返回 413', async () => {
    const env = await makeEnvWithStorage();
    const res = await app.request('/api/repository/direct-upload/start', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: 'big.bin', size: 30 * 1024 * 1024, hash: 'a'.repeat(64), mtime: 1700000000000 }),
    }, env);
    expect(res.status).toBe(413);
  });
});

describe('POST /api/repository/blobs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(new Response('', { status: url.includes('tombstone.json') ? 404 : 200 }));
    }));
  });

  it('未认证返回 401', async () => {
    const res = await app.request(
      '/api/repository/blobs?path=a.md&mtime=1',
      { method: 'POST', body: new Uint8Array([1]) },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('上传二进制 → 201 + blobId（storageKey 格式），并 PUT 到用户存储', async () => {
    const env = await makeEnvWithStorage();
    const content = new TextEncoder().encode('# hello');
    const res = await app.request(
      `/api/repository/blobs?path=a.md&mtime=${1700000000000}`,
      {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/octet-stream' }),
        body: content,
      },
      env,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { blobId: string; size: number; mtime: number };
    expect(data.blobId).toContain(`${SYNC_FOLDER}/a.md@`);
    expect(data.size).toBe(content.byteLength);
    expect(data.mtime).toBe(1700000000000);
  });

  it('缺 path 或 mtime → 400', async () => {
    const env = await makeEnvWithStorage();
    const res = await app.request(
      '/api/repository/blobs?mtime=1',
      { method: 'POST', headers: headers(), body: new Uint8Array([1]) },
      env,
    );
    expect(res.status).toBe(400);
  });
});
