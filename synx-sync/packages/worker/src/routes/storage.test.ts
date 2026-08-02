import { Hono } from 'hono';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { DEFAULT_RETENTION } from '@synx/shared';
import { storage } from './storage.js';
import { signJwt } from '../auth/jwt.js';
import { decryptString, encryptString } from '../auth/crypto.js';
import { makeD1Mock, makeKvMock, makeEnv } from '../test/helpers.js';
import type { Env, AppVars } from '../types.js';

const SECRET = 'test-jwt-secret-min-32-characters-pls!';
const USER = 'user-1';
const OTHER = 'user-2';

const tokenCache: Record<string, string> = {};
async function tokenFor(userId: string) {
  if (!tokenCache[userId]) tokenCache[userId] = await signJwt({ sub: userId }, SECRET);
  return tokenCache[userId];
}

async function authHeader(userId = USER) {
  return { Authorization: `Bearer ${await tokenFor(userId)}` };
}

function makeApp(db: D1Database, kv: KVNamespace) {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
  app.route('/api/storage', storage);
  return app;
}

const validS3 = {
  endpoint: 'https://s3.example.com',
  bucket: 'my-bucket',
  accessKey: 'AKIA...',
  secretKey: 'secret',
  region: 'us-east-1',
};

const validWebdav = {
  address: 'https://dav.example.com',
  username: 'user',
  password: 'pass',
  authType: 'basic',
  remoteBaseDir: 'my-vault',
};

function post(body: unknown) {
  return { method: 'POST', body: JSON.stringify(body) };
}

describe('POST /api/storage', () => {
  it('returns 201 with storage (config null) on valid input', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      { ...post({ name: 'my-s3', type: 's3', config: validS3 }), headers: { 'Content-Type': 'application/json', ...(await authHeader()) } },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(201);
    const data = await res.json<any>();
    expect(data.storage.name).toBe('my-s3');
    expect(data.storage.config).toBeNull();
    expect(db._run).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when type is not supported', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      { ...post({ name: 'od', type: 'onedrive', config: validS3 }), headers: { 'Content-Type': 'application/json', ...(await authHeader()) } },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 201 on valid webdav config', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      { ...post({ name: 'my-webdav', type: 'webdav', config: validWebdav }), headers: { 'Content-Type': 'application/json', ...(await authHeader()) } },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(201);
    const data = await res.json<any>();
    expect(data.storage.name).toBe('my-webdav');
    expect(data.storage.type).toBe('webdav');
    expect(data.storage.config).toBeNull();
  });

  it('returns 400 when webdav requests Digest authentication', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      {
        ...post({ name: 'x', type: 'webdav', config: { ...validWebdav, authType: 'digest' } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid auth type' });
  });

  it('returns 400 when webdav config incomplete', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      {
        ...post({ name: 'x', type: 'webdav', config: { ...validWebdav, password: '' } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when s3 config incomplete', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      {
        ...post({ name: 'x', type: 's3', config: { ...validS3, secretKey: '' } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage',
      { ...post({ name: 'x', type: 's3', config: validS3 }), headers: { 'Content-Type': 'application/json' } },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/storage/test', () => {
  it('runs the Remotely Save compatible read/write connectivity flow without saving', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<ListBucketResult></ListBucketResult>', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('synx-connectivity-check-overwrite', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 's3', config: validS3 }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(db._run).not.toHaveBeenCalled();
  });

  it('returns a safe stage-specific error without echoing credentials', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret upstream detail', { status: 403 })));
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 's3', config: validS3 }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(422);
    const data = await res.json<any>();
    expect(data.code).toBe('S3_CONNECTION_FAILED');
    expect(data.error).toContain('凭证');
    expect(JSON.stringify(data)).not.toContain(validS3.secretKey);
    expect(JSON.stringify(data)).not.toContain('secret upstream detail');
  });

  it('rejects insecure non-local endpoints before making a request', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 's3', config: { ...validS3, endpoint: 'https://169.254.169.254/latest/meta-data' } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs webdav connectivity flow: PROPFIND → MKCOL → PUT → overwrite → GET → DELETE', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    // Sequence (remoteBaseDir='my-vault' → ensureBaseDir makes 1 MKCOL per put):
    // 1. PROPFIND → 404 (list, dir doesn't exist yet)
    // 2. MKCOL → 201 (ensureBaseDir: create 'my-vault')       [put #1]
    // 3. MKCOL → 201 (ensureParentDirs: create '.synx-connectivity-test')  [put #1]
    // 4. PUT → 200 (first put)
    // 5. MKCOL → 405 (ensureBaseDir: 'my-vault' already exists)  [put #2]
    // 6. MKCOL → 405 (ensureParentDirs: dir already exists)      [put #2]
    // 7. PUT → 200 (overwrite put)
    // 8. GET → 200 with content
    // 9. DELETE → 204 (cleanup)
    const emptyPropfind = new Response('', { status: 404 });
    const mkcolCreated = new Response('', { status: 201 });
    const putOk = new Response('', { status: 200 });
    const mkcolExists = new Response('', { status: 405 });
    const getContent = new Response('synx-connectivity-check-overwrite', { status: 200 });
    const deleteOk = new Response(null, { status: 204 });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyPropfind)
      .mockResolvedValueOnce(mkcolCreated)
      .mockResolvedValueOnce(mkcolCreated)
      .mockResolvedValueOnce(putOk)
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(mkcolExists)
      .mockResolvedValueOnce(mkcolExists)
      .mockResolvedValueOnce(putOk)
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(getContent)
      .mockResolvedValueOnce(deleteOk)
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 'webdav', config: validWebdav }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(db._run).not.toHaveBeenCalled();
  });

  it('tests an existing WebDAV storage with the preserved password', async () => {
    const encrypted = await encryptString(JSON.stringify(validWebdav), 'test-encryption-key');
    const db = makeD1Mock({ first: { id: 's1', user_id: USER, name: 'dav', type: 'webdav', config: encrypted, created_at: 1 } });
    const kv = makeKvMock();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('synx-connectivity-check-overwrite', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ id: 's1', config: { address: 'https://dav2.example.com', password: '' } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Basic ${btoa('user:pass')}` });
  });

  it('returns WEBDAV_CONNECTION_FAILED without echoing credentials', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 'webdav', config: validWebdav }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(422);
    const data = await res.json<any>();
    expect(data.code).toBe('WEBDAV_CONNECTION_FAILED');
    expect(data.error).toContain('WebDAV');
    expect(JSON.stringify(data)).not.toContain(validWebdav.password);
    expect(JSON.stringify(data)).not.toContain('forbidden');
  });

  it.each([
    'Authorization: Bearer upstream-secret',
    'Cookie: session=secret',
    'Host: internal.example',
    'Proxy-Authorization: Basic secret',
    'Connection: keep-alive',
    'Content-Length: 1',
    'Transfer-Encoding: chunked',
    'CF-Connecting-IP: 127.0.0.1',
    'X-Forwarded-For: 127.0.0.1',
    'X-Real-IP: 127.0.0.1',
  ])('rejects sensitive custom WebDAV header %s before making a request', async (customHeaders) => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 'webdav', config: { ...validWebdav, customHeaders } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://169.254.169.254/dav',
    'https://2130706433/dav',
    'https://0x7f000001/dav',
    'https://[::ffff:127.0.0.1]/dav',
  ])('rejects insecure webdav address %s before making a request', async (address) => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/test',
      {
        ...post({ type: 'webdav', config: { ...validWebdav, address } }),
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/storage', () => {
  it('returns storages (config null)', async () => {
    const db = makeD1Mock({
      all: [
        { id: 's1', user_id: USER, name: 'mine', type: 's3', config: 'enc', created_at: 1 },
        { id: 's2', user_id: OTHER, name: 'other', type: 's3', config: 'enc', created_at: 2 },
      ],
    });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage', { headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.storages.length).toBe(2);
    expect(data.storages[0].config).toBeNull();
  });
});

describe('DELETE /api/storage/:id', () => {
  it('returns 200 on deleting own storage', async () => {
    const db = makeD1Mock({ first: { id: 's1', user_id: USER, name: 'empty', type: 'webdav', config: 'unused', created_at: 1 } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/s1', { method: 'DELETE', headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(200);
    expect((db as any).prepare).toHaveBeenCalledWith('DELETE FROM storages WHERE id = ? AND user_id = ?');
  });

  it('removes only the D1 storage config and preserves remote metadata and objects', async () => {
    const db = makeD1Mock({
      first: { id: 's1', user_id: USER, name: 'dav', type: 'webdav', config: 'unused', created_at: 1 },
    });
    const kv = makeKvMock();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, kv);

    const res = await app.request('/api/storage/s1', { method: 'DELETE', headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, remoteFilesPreserved: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((db as any).prepare).not.toHaveBeenCalledWith(expect.stringContaining('versions'));
    expect((db as any).prepare).toHaveBeenCalledWith('DELETE FROM storages WHERE id = ? AND user_id = ?');
  });

  it('returns 404 when storage not found', async () => {
    const db = makeD1Mock({ first: null });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/none', { method: 'DELETE', headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when deleting other user storage', async () => {
    const db = makeD1Mock({ first: { user_id: OTHER } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/s2', { method: 'DELETE', headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(403);
    expect(db._run).not.toHaveBeenCalled();
  });
});


describe('GET /api/storage/:id', () => {
  it('returns editable WebDAV details without password or custom Authorization header', async () => {
    const encrypted = await encryptString(JSON.stringify({
      ...validWebdav,
      customHeaders: 'X-Tenant: demo\nAuthorization: Bearer upstream-secret',
    }), 'test-encryption-key');
    const db = makeD1Mock({ first: { id: 's1', user_id: USER, name: 'dav', type: 'webdav', config: encrypted, created_at: 1 } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);

    const res = await app.request('/api/storage/s1', { headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));

    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.storage.config).toEqual({
      address: validWebdav.address,
      username: validWebdav.username,
      authType: 'basic',
      remoteBaseDir: validWebdav.remoteBaseDir,
      customHeaders: 'X-Tenant: demo',
    });
    expect(JSON.stringify(data)).not.toContain(validWebdav.password);
    expect(JSON.stringify(data)).not.toContain('upstream-secret');
  });

  it('returns 403 for another user storage', async () => {
    const db = makeD1Mock({ first: { id: 's1', user_id: OTHER, name: 'dav', type: 'webdav', config: 'encrypted', created_at: 1 } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/s1', { headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/storage/:id', () => {
  it('updates editable WebDAV fields while preserving the stored password', async () => {
    const encrypted = await encryptString(JSON.stringify(validWebdav), 'test-encryption-key');
    const db = makeD1Mock({ first: { id: 's1', user_id: USER, name: 'dav', type: 'webdav', config: encrypted, created_at: 1 } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);

    const res = await app.request(
      '/api/storage/s1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ name: 'dav updated', config: { address: 'https://dav2.example.com', password: '' } }),
      },
      makeEnv({ DB: db, KV: kv }),
    );

    expect(res.status).toBe(200);
    const bindArgs = (db as any)._stmt.bind.mock.calls.at(-1);
    expect(bindArgs[0]).toBe('dav updated');
    const updated = JSON.parse(await decryptString(bindArgs[1], 'test-encryption-key'));
    expect(updated.address).toBe('https://dav2.example.com');
    expect(updated.password).toBe(validWebdav.password);
    expect(updated.authType).toBe('basic');
  });

  it('does not allow changing storage type', async () => {
    const encrypted = await encryptString(JSON.stringify(validWebdav), 'test-encryption-key');
    const db = makeD1Mock({ first: { id: 's1', user_id: USER, name: 'dav', type: 'webdav', config: encrypted, created_at: 1 } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage/s1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ type: 's3', name: 'x', config: {} }),
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET/PUT /api/storage/:id/retention', () => {
  it('returns the default policy when no custom policy is stored', async () => {
    const db = makeD1Mock({ first: { retention_policy: null } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/s1/retention', { headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.policy.hourlyWindowHours).toBe(60);
  });

  it('returns the stored policy', async () => {
    const stored = JSON.stringify({ hourlyWindowHours: 12, dailyWindowDays: 7, monthlyWindowMonths: 2, yearlyWindowYears: 1, maxVersionsPerFile: 200 });
    const db = makeD1Mock({ first: { retention_policy: stored } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/s1/retention', { headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.policy.hourlyWindowHours).toBe(12);
    expect(data.policy.maxVersionsPerFile).toBe(200);
  });

  it('saves a normalized policy', async () => {
    const db = makeD1Mock({ first: { id: 's1', user_id: USER, retention_policy: null } });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request(
      '/api/storage/s1/retention',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ hourlyWindowHours: 24, dailyWindowDays: 5 }),
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(200);
    const bindArgs = (db as any)._stmt.bind.mock.calls.at(-1);
    const saved = JSON.parse(bindArgs[0]);
    expect(saved.hourlyWindowHours).toBe(24);
    expect(saved.dailyWindowDays).toBe(5);
    expect(saved.monthlyWindowMonths).toBe(DEFAULT_RETENTION.monthlyWindowMonths);
    expect(saved.maxFileSize).toBe(DEFAULT_RETENTION.maxFileSize);
  });

  it('returns 404 when storage not found', async () => {
    const db = makeD1Mock({ first: null });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const res = await app.request('/api/storage/none/retention', { headers: await authHeader() }, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(404);
  });
});

