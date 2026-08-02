import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index.js';
import { hashApiToken } from '../auth/apiToken.js';
import { encryptString } from '../auth/crypto.js';
import { makeEnv } from '../test/helpers.js';

const TOKEN = 'synx_pat_test-secret';
const USER_ID = 'user-1';
const STORAGE_ID = 'storage-1';

async function makeInboxDb(options: { collision?: boolean; lastUsedFails?: boolean } = {}) {
  const tokenHash = await hashApiToken(TOKEN);
  const encrypted = await encryptString(JSON.stringify({ endpoint: 'https://s3.example.com', bucket: 'b', accessKey: 'ak', secretKey: 'sk', region: 'us-east-1', pathStyle: true }), 'test-encryption-key');
  const run = vi.fn(async () => ({ success: true, meta: { changes: options.collision ? 0 : 1 } }));
  return {
    prepare: vi.fn((sql: string) => {
      const first = vi.fn(async () => {
        if (sql.includes('FROM api_tokens')) return { id: 'token-1', user_id: USER_ID, token_hash: tokenHash, storage_id: STORAGE_ID, sync_folder: 'my-vault/', target_folder: '收件箱' };
        if (sql.includes('FROM storages')) return { id: STORAGE_ID, user_id: USER_ID, name: 'mine', type: 's3', config: encrypted, created_at: 1, retention_policy: null };
        return null;
      });
      const statementRun = sql.includes('UPDATE api_tokens') && options.lastUsedFails
        ? vi.fn(async () => { throw new Error('D1 unavailable'); })
        : run;
      const statement: any = { first, run: statementRun, all: vi.fn(async () => ({ results: [] })) };
      statement.bind = vi.fn(() => statement);
      return statement;
    }),
    batch: vi.fn(),
    _run: run,
  } as unknown as D1Database & { _run: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    const missingMetadata = (method === 'GET' || method === 'HEAD') && (url.includes('tombstone.json') || url.includes('current.json') || url.includes('manifest.json'));
    return Promise.resolve(new Response('', { status: missingMetadata ? 404 : 200 }));
  }));
});

describe('POST /api/inbox/notes', () => {
  it('creates a markdown note in the token-bound folder', async () => {
    const db = await makeInboxDb();
    const response = await app.request('/api/inbox/notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '会议记录', content: '# 会议记录\n\n正文' }),
    }, makeEnv({ DB: db }));

    expect(response.status).toBe(201);
    const data = await response.json<{ note: { path: string; fileUuid: string } }>();
    expect(data.note.path).toBe('收件箱/会议记录.md');
    expect(data.note.fileUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an unknown API token', async () => {
    const db = await makeInboxDb();
    (db as any).prepare = vi.fn(() => { const statement: any = { first: vi.fn(async () => null) }; statement.bind = vi.fn(() => statement); return statement; });
    const response = await app.request('/api/inbox/notes', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a', content: 'b' }),
    }, makeEnv({ DB: db }));
    expect(response.status).toBe(401);
  });

  it('returns 409 when the generated path is already reserved', async () => {
    const db = await makeInboxDb({ collision: true });
    const response = await app.request('/api/inbox/notes', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '会议记录', content: '正文' }),
    }, makeEnv({ DB: db }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'NOTE_ALREADY_EXISTS' });
  });

  it('still succeeds when updating last-used time fails after the note is written', async () => {
    const response = await app.request('/api/inbox/notes', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '成功笔记', content: '正文' }),
    }, makeEnv({ DB: await makeInboxDb({ lastUsedFails: true }) }));
    expect(response.status).toBe(201);
  });

  it('rejects a title that cannot form a file name', async () => {
    const response = await app.request('/api/inbox/notes', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '///', content: '正文' }),
    }, makeEnv({ DB: await makeInboxDb() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_TITLE' });
  });
});
