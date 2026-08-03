import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index.js';
import { windowsDuplicateFileName } from './inbox.js';
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

/** 内存 S3 mock：PUT/GET/HEAD/DELETE 写后读，支持 If-None-Match/If-Match 条件写与 ListObjectsV2 */
function makeMemoryS3Fetch(): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</Key></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (url.searchParams.has('delete')) {
      const bodyText = await req.text();
      const keys = [...bodyText.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      for (const key of keys) store.delete(key);
      return new Response('<DeleteResult></DeleteResult>', { status: 200 });
    }
    if (url.pathname.startsWith('/b/')) {
      const key = decodeURIComponent(url.pathname.slice('/b/'.length));
      if (req.method === 'PUT') {
        const ifNoneMatch = req.headers.get('If-None-Match');
        const ifMatch = req.headers.get('If-Match');
        if (ifNoneMatch === '*' && store.has(key)) return new Response('', { status: 412 });
        if (ifMatch && !store.has(key)) return new Response('', { status: 412 });
        store.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response('', { status: 200, headers: { ETag: `"etag-${store.size}"` } });
      }
      if (req.method === 'HEAD') {
        const has = store.has(key);
        return new Response('', { status: has ? 200 : 404, headers: has ? { ETag: '"etag"' } : {} });
      }
      if (req.method === 'GET') {
        const data = store.get(key);
        if (!data) return new Response('not found', { status: 404 });
        return new Response(data, { status: 200 });
      }
      if (req.method === 'DELETE') {
        store.delete(key);
        return new Response('', { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return store;
}

beforeEach(() => {
  makeMemoryS3Fetch();
});

describe('windowsDuplicateFileName', () => {
  it('按 Windows 风格选择第一个可用的同名编号', () => {
    expect(windowsDuplicateFileName('1.md', new Set())).toBe('1.md');
    expect(windowsDuplicateFileName('1.md', new Set(['1.md']))).toBe('1 (2).md');
    expect(windowsDuplicateFileName('1.md', new Set(['1.md', '1 (2).md', '1 (4).md']))).toBe('1 (3).md');
  });
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
    const preparedSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => sql as string);
    expect(preparedSql.some(sql => sql.includes('DELETE FROM api_note_paths') && sql.includes('created_at <'))).toBe(true);
    expect(preparedSql.some(sql => sql.includes('DELETE FROM api_note_paths') && !sql.includes('created_at <'))).toBe(true);
    const staleLockStatement = (db.prepare as ReturnType<typeof vi.fn>).mock.results
      .map(result => result.value as { bind: ReturnType<typeof vi.fn> })
      .find((_, index) => preparedSql[index].includes('created_at <'));
    expect(staleLockStatement?.bind.mock.calls[0][3]).toBeGreaterThan(Date.now() - 11_000);
    expect(staleLockStatement?.bind.mock.calls[0][3]).toBeLessThanOrEqual(Date.now() - 10_000);
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
    expect(await response.json()).toMatchObject({ code: 'NOTE_PATH_UNAVAILABLE' });
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
