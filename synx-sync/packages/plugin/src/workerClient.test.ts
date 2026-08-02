import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerClient, WorkerApiError } from './workerClient.js';

const SERVER = 'https://synx.example.com';
const JWT = 'jwt-token';
const STORAGE_ID = 's-1';
const SYNC_FOLDER = 'my-vault';

function makeClient(fetchMock: ReturnType<typeof vi.fn>, opts: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}) {
  return new WorkerClient({
    serverUrl: SERVER,
    jwt: JWT,
    storageId: STORAGE_ID,
    syncFolder: SYNC_FOLDER,
    fetchImpl: fetchMock as unknown as typeof fetch,
    maxRetries: 2,
    ...opts,
  });
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WorkerClient headers', () => {
  it('sends Authorization, X-Storage-Id, X-Sync-Folder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock);
    await client.list();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${JWT}`);
    expect(headers['X-Storage-Id']).toBe(STORAGE_ID);
    expect(headers['X-Sync-Folder']).toBe(SYNC_FOLDER);
  });

  it('builds URL by joining base + path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock);
    await client.list();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/list`);
  });

  it('normalizes the fixed login URL before joining API paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock, { serverUrl: `${SERVER}/login` });
    await client.list();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/list`);
  });

  it.each(['/dashboard', '/dashboard/'])('normalizes a pasted %s URL before joining API paths', async (dashboardPath) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock, {
      serverUrl: `${SERVER}${dashboardPath}`,
    });
    await client.list();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/list`);
  });

  it('normalizes a pasted dashboard URL before joining API paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock, {
      serverUrl: `${SERVER}/dashboard.html?from=plugin#storage`,
    });
    await client.list();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/list`);
  });
});

describe('list', () => {
  it('returns Entity[] mapped from FileMeta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        files: [
          { path: 'a.md', versionId: 'v1', mtime: 1, size: 10, hash: 'h1', author: null },
          { path: 'b.md', versionId: 'v2', mtime: 2, size: 20, hash: 'h2', author: 'dev' },
        ],
      }),
    );
    const client = makeClient(fetchMock);
    const entities = await client.list();
    expect(entities.length).toBe(2);
    expect(entities[0].key).toBe('/a.md');
    expect(entities[0].size).toBe(10);
    expect(entities[0].etag).toBe('h1');
    expect(entities[0].type).toBe('file');
  });
});

describe('readFile', () => {
  it('returns ArrayBuffer decoded from base64', async () => {
    const text = 'hello world';
    const b64 = btoa(text);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ content: b64, version: { userId: 'u', storageId: STORAGE_ID, path: 'a.md', versionId: 'v', mtime: 1, size: 11, hash: 'h', storageKey: 'k', isCurrent: 1, author: null, createdAt: 1 } }),
    );
    const client = makeClient(fetchMock);
    const buf = await client.readFile('a.md');
    expect(new TextDecoder().decode(buf)).toBe(text);
  });

  it('passes version query param when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ content: 'YQ==', version: { userId: 'u', storageId: STORAGE_ID, path: 'a.md', versionId: 'v1', mtime: 1, size: 1, hash: 'h', storageKey: 'k', isCurrent: 0, author: null, createdAt: 1 } }),
    );
    const client = makeClient(fetchMock);
    await client.readFile('a.md', 'v1');
    expect(fetchMock.mock.calls[0][0]).toContain('version=v1');
  });
});

describe('writeFile', () => {
  it('sends PUT with base64 content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ version: { userId: 'u', storageId: STORAGE_ID, path: 'a.md', versionId: 'v', mtime: 1, size: 5, hash: 'h', storageKey: 'k', isCurrent: 1, author: null, createdAt: 1 } }, 201),
    );
    const client = makeClient(fetchMock);
    const content = new TextEncoder().encode('hello');
    const version = await client.writeFile('a.md', content, 1700000000, 'device-a');
    expect(version.versionId).toBe('v');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.path).toBe('a.md');
    expect(body.mtime).toBe(1700000000);
    expect(body.content).toBe(btoa('hello'));
    expect(body.author).toBe('device-a');
  });
});

describe('deleteFile', () => {
  it('sends UUID and path to the delete endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ deleted: true }));
    const client = makeClient(fetchMock);
    await client.deleteFile('notes/a.md', '550e8400-e29b-41d4-a716-446655440000');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toContain('/api/file');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ path: 'notes/a.md', fileUuid: '550e8400-e29b-41d4-a716-446655440000' });
  });
});

describe('history', () => {
  it('returns versions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ versions: [{ userId: 'u', storageId: STORAGE_ID, path: 'a.md', versionId: 'v1', mtime: 1, size: 1, hash: 'h', storageKey: 'k', isCurrent: 1, author: null, createdAt: 1 }] }),
    );
    const client = makeClient(fetchMock);
    const versions = await client.history('a.md');
    expect(versions.length).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toContain('?path=a.md');
  });
});

describe('rollback', () => {
  it('posts path + version, returns new version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ version: { userId: 'u', storageId: STORAGE_ID, path: 'a.md', versionId: 'v-new', mtime: 1, size: 1, hash: 'h', storageKey: 'k', isCurrent: 1, author: 'rollback@v-old', createdAt: 1 } }, 201),
    );
    const client = makeClient(fetchMock);
    const version = await client.rollback('a.md', 'v-old');
    expect(version.versionId).toBe('v-new');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ path: 'a.md', version: 'v-old' });
  });
});

describe('error handling', () => {
  it('throws WorkerApiError on 4xx (non-401)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }));
    const client = makeClient(fetchMock);
    await expect(client.list()).rejects.toMatchObject({ status: 403 });
  });

  it('triggers onUnauthorized on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const onUnauthorized = vi.fn();
    const client = makeClient(fetchMock, { onUnauthorized });
    await expect(client.list()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(jsonRes({ files: [] }));
    const client = makeClient(fetchMock, { maxRetries: 2 });
    const promise = client.list();
    // 推进 fake timers（500 + 1000 ms 退避）
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does NOT retry on 413', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"too large"}', { status: 413 }));
    const client = makeClient(fetchMock);
    await expect(client.writeFile('a', new Uint8Array(1), 1)).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 未重试
  });

  it('does NOT retry on 400 (client error)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"missing fields: content"}', { status: 400 }));
    const client = makeClient(fetchMock);
    await expect(client.writeFile('a', new Uint8Array(1), 1)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonRes({ files: [] }));
    const client = makeClient(fetchMock, { maxRetries: 1 });
    const promise = client.list();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('static methods', () => {
  it.each(['/dashboard', '/dashboard/', '/dashboard.html'])('login normalizes a pasted %s URL to the origin', async (dashboardPath) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ token: 'tok', user: { id: 'u', username: 'alice', email: 'a@b', createdAt: 1, updatedAt: 1 } }));
    await WorkerClient.login(`${SERVER}${dashboardPath}`, 'alice', 'pw', fetchMock as unknown as typeof fetch);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/auth/login`);
  });

  it('login posts credentials and returns AuthResponse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ token: 'tok', user: { id: 'u', username: 'alice', email: 'a@b', createdAt: 1, updatedAt: 1 } }));
    const res = await WorkerClient.login(SERVER, 'alice', 'pw', fetchMock as unknown as typeof fetch);
    expect(res.token).toBe('tok');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ usernameOrEmail: 'alice', password: 'pw' });
  });

  it('listStorages sends JWT header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ storages: [{ id: 's1', userId: 'u', name: 'mine', type: 's3', config: null, createdAt: 1 }] }));
    const storages = await WorkerClient.listStorages(SERVER, 'tok', fetchMock as unknown as typeof fetch);
    expect(storages.length).toBe(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });
});

describe('setJwt / setStorage', () => {
  it('updates jwt after construction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock);
    client.setJwt('new-jwt');
    await client.list();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer new-jwt');
  });

  it('updates storageId + syncFolder after construction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ files: [] }));
    const client = makeClient(fetchMock);
    client.setStorage('s-new', 'folder-new');
    await client.list();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Storage-Id']).toBe('s-new');
    expect(headers['X-Sync-Folder']).toBe('folder-new');
  });
});

describe('static URL security', () => {
  it.each([
    ['login', (fetchMock: typeof fetch) => WorkerClient.login('http://synx.example.com', 'alice', 'pw', fetchMock)],
    ['listStorages', (fetchMock: typeof fetch) => WorkerClient.listStorages('http://synx.example.com', 'tok', fetchMock)],
  ])('%s rejects non-local HTTP before fetch', async (_name, request) => {
    const fetchMock = vi.fn();
    await expect(request(fetchMock as unknown as typeof fetch)).rejects.toThrow('服务器地址必须使用 HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes URL components with URL semantics before login', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ token: 'tok', user: { id: 'u', username: 'alice', email: 'a@b', createdAt: 1, updatedAt: 1 } }));
    await WorkerClient.login('HTTPS://SYNX.EXAMPLE.COM:443/dashboard.html?from=plugin#storage', 'alice', 'pw', fetchMock as unknown as typeof fetch);
    expect(fetchMock.mock.calls[0][0]).toBe('https://synx.example.com/api/auth/login');
  });
});
