import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import { auth } from './auth.js';
import { hashPassword } from '../auth/password.js';
import { signJwt } from '../auth/jwt.js';
import { makeD1Mock, makeKvMock, makeEnv } from '../test/helpers.js';
import type { Env, AppVars } from '../types.js';

function makeApp(db: D1Database, kv: KVNamespace) {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
  app.route('/api/auth', auth);
  return app;
}

function postBody(body: unknown) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function authHeader(userId = 'u1') {
  const token = await signJwt({ sub: userId }, 'test-jwt-secret-min-32-characters-pls!');
  return { Authorization: `Bearer ${token}` };
}

const userRow = {
  id: 'u1',
  username: 'alice',
  email: 'alice@example.com',
  password_hash: 'x',
  default_storage_id: 's1',
  default_sync_folder: 'my-vault/',
  created_at: 1,
  updated_at: 1,
};

describe('POST /api/auth/register', () => {
  it('returns 201 with token and user on valid input', async () => {
    const db = makeD1Mock({ first: null });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/register',
      postBody({ username: 'alice', email: 'alice@example.com', password: 'password123' }),
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(201);
    const data = await res.json<any>();
    expect(data.token).toBeTypeOf('string');
    expect(data.user).toMatchObject({ username: 'alice', email: 'alice@example.com' });
    expect(data.user.password_hash).toBeUndefined();
    expect(db._run).toHaveBeenCalledTimes(1);
  });

  it('returns 409 if username/email already exists', async () => {
    const db = makeD1Mock({ first: { id: 'existing' } });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/register',
      postBody({ username: 'alice', email: 'alice@example.com', password: 'password123' }),
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(409);
    expect(db._run).not.toHaveBeenCalled();
  });

  it.each([
    [{ username: 'alice', email: 'not-email', password: 'password123' }, 400],
    [{ username: 'alice', email: 'alice@example.com', password: 'short' }, 400],
    [{ username: 'ab', email: 'ab@example.com', password: 'password123' }, 400],
  ])('validates registration input', async (body, status) => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request('/api/auth/register', postBody(body), makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(status);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 200 with token on valid credentials', async () => {
    const hash = await hashPassword('password123');
    const db = makeD1Mock({ first: { ...userRow, password_hash: hash } });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/login',
      postBody({ usernameOrEmail: 'alice', password: 'password123' }),
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.token).toBeTypeOf('string');
    expect(data.user.id).toBe('u1');
  });

  it('returns 401 if user not found', async () => {
    const db = makeD1Mock({ first: null });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/login',
      postBody({ usernameOrEmail: 'nobody', password: 'password123' }),
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on wrong password', async () => {
    const hash = await hashPassword('correct-password');
    const db = makeD1Mock({ first: { ...userRow, password_hash: hash } });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/login',
      postBody({ usernameOrEmail: 'alice', password: 'wrong-password' }),
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 after 5 login attempts', async () => {
    const db = makeD1Mock({ first: null });
    const kv = makeKvMock();
    const app = makeApp(db, kv);
    const env = makeEnv({ DB: db, KV: kv });
    for (let i = 0; i < 5; i++) {
      await app.request('/api/auth/login', postBody({ usernameOrEmail: 'nobody', password: 'x' }), env);
    }
    const res = await app.request('/api/auth/login', postBody({ usernameOrEmail: 'nobody', password: 'x' }), env);
    expect(res.status).toBe(429);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without token', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request('/api/auth/me', {}, makeEnv({ DB: db, KV: kv }));
    expect(res.status).toBe(401);
  });

  it('returns user and account preferences on valid token', async () => {
    const db = makeD1Mock({ first: userRow });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/me',
      { headers: await authHeader() },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      user: { username: 'alice' },
      preferences: { defaultStorageId: 's1', defaultSyncFolder: 'my-vault/' },
    });
  });
});

describe('PATCH /api/auth/me/preferences', () => {
  it('updates an owned default storage and normalized folder', async () => {
    const db = makeD1Mock({ first: { id: 's1', user_id: 'u1' } });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/me/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ defaultStorageId: 's1', defaultSyncFolder: ' notes/vault ' }),
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      preferences: { defaultStorageId: 's1', defaultSyncFolder: 'notes/vault/' },
    });
    expect(db._run).toHaveBeenCalled();
  });

  it('rejects a storage owned by another user', async () => {
    const db = makeD1Mock({ first: { id: 's1', user_id: 'u2' } });
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/me/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ defaultStorageId: 's1', defaultSyncFolder: 'vault/' }),
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(400);
    expect(db._run).not.toHaveBeenCalled();
  });

  it('allows clearing the default storage', async () => {
    const db = makeD1Mock();
    const kv = makeKvMock();
    const res = await makeApp(db, kv).request(
      '/api/auth/me/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ defaultStorageId: null, defaultSyncFolder: '' }),
      },
      makeEnv({ DB: db, KV: kv }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      preferences: { defaultStorageId: null, defaultSyncFolder: 'my-vault/' },
    });
  });
});
