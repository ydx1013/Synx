import { beforeAll, describe, expect, it } from 'vitest';
import app from '../index.js';
import { signJwt } from '../auth/jwt.js';
import { makeD1Mock, makeEnv } from '../test/helpers.js';

const USER_ID = 'user-1';
const STORAGE_ID = 'storage-1';
const SECRET = 'test-jwt-secret-min-32-characters-pls!';
let jwt: string;

beforeAll(async () => {
  jwt = await signJwt({ sub: USER_ID }, SECRET);
});

const headers = () => ({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' });

describe('API token management', () => {
  it('creates a token bound to an owned storage and returns its secret once', async () => {
    const db = makeD1Mock({ first: { id: STORAGE_ID, user_id: USER_ID } });
    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: '快捷指令', storageId: STORAGE_ID, syncFolder: 'my-vault/', targetFolder: '收件箱/API' }),
    }, makeEnv({ DB: db }));

    expect(response.status).toBe(201);
    const data = await response.json<{ token: string; apiToken: { name: string; targetFolder: string } }>();
    expect(data.token).toMatch(/^synx_pat_[A-Za-z0-9_-]+$/);
    expect(data.apiToken).toMatchObject({ name: '快捷指令', targetFolder: '收件箱/API' });
    expect(db._run).toHaveBeenCalledOnce();
    const insertCall = (db as any)._stmt.bind.mock.calls.at(-1) as unknown[];
    expect(insertCall.join(' ')).not.toContain(data.token);
  });

  it('rejects traversal in a bound folder', async () => {
    const db = makeD1Mock({ first: { id: STORAGE_ID, user_id: USER_ID } });
    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'bad', storageId: STORAGE_ID, syncFolder: '../vault', targetFolder: 'notes' }),
    }, makeEnv({ DB: db }));

    expect(response.status).toBe(400);
  });

  it('lists only the current user token metadata', async () => {
    const db = makeD1Mock({ all: [{
      id: 'token-1', name: '快捷指令', token_prefix: 'synx_pat_abcd', storage_id: STORAGE_ID,
      storage_name: '我的存储', sync_folder: 'my-vault/', target_folder: '收件箱', created_at: 1, last_used_at: null,
    }] });
    const response = await app.request('/api/tokens', { headers: headers() }, makeEnv({ DB: db }));

    expect(response.status).toBe(200);
    const data = await response.json<{ tokens: unknown[] }>();
    expect(data.tokens).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('token_hash');
  });

  it('revokes only a token owned by the current user', async () => {
    const db = makeD1Mock();
    const response = await app.request('/api/tokens/token-1', { method: 'DELETE', headers: headers() }, makeEnv({ DB: db }));

    expect(response.status).toBe(200);
    expect(db._run).toHaveBeenCalledOnce();
  });
});
