import { describe, it, expect, vi } from 'vitest';
import { WorkerClient } from './workerClient.js';

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

function emptyRepoHead(): unknown {
  return { head: null, tree: [], storageId: STORAGE_ID, syncFolder: SYNC_FOLDER };
}

describe('WorkerClient headers', () => {
  it('sends Authorization, X-Storage-Id, X-Sync-Folder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock);
    await client.repoHead();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${JWT}`);
    expect(headers['X-Storage-Id']).toBe(STORAGE_ID);
    expect(headers['X-Sync-Folder']).toBe(SYNC_FOLDER);
  });

  it('builds URL by joining base + path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock);
    await client.repoHead();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/repository/head`);
  });

  it('normalizes the fixed login URL before joining API paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock, { serverUrl: `${SERVER}/login` });
    await client.repoHead();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/repository/head`);
  });

  it.each(['/dashboard', '/dashboard/', '/dashboard.html?from=plugin#storage'])('normalizes a pasted %s URL before joining API paths', async (dashboardPath) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock, { serverUrl: `${SERVER}${dashboardPath}` });
    await client.repoHead();
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/repository/head`);
  });
});

describe('repoHead', () => {
  it('returns head + tree', async () => {
    const head = { commitId: 'c1', generation: 1, createdAt: 1, author: 'dev', message: 'init' };
    const tree = [{ path: 'a.md', identity: 'uuid-a', blobId: 'k', mtime: 1, size: 1, hash: 'h' }];
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ head, tree, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER }));
    const client = makeClient(fetchMock);
    const res = await client.repoHead();
    expect(res.head?.commitId).toBe('c1');
    expect(res.tree.length).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/repository/head');
  });
});

describe('repoFileHistory', () => {
  it('passes path and fileUuid query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ identity: 'uuid-a', commits: [], changes: [] }));
    const client = makeClient(fetchMock);
    await client.repoFileHistory('a.md', '550e8400-e29b-41d4-a716-446655440000');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/repository/file-history');
    expect(url).toContain('path=a.md');
    expect(url).toContain('fileUuid=550e8400-e29b-41d4-a716-446655440000');
  });
});

describe('repoGc', () => {
  it('POSTs to /api/repository/gc and returns scan result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ scanned: 5, deleted: 1, more: false }));
    const client = makeClient(fetchMock);
    const res = await client.repoGc();
    expect(res).toEqual({ scanned: 5, deleted: 1, more: false });
    const url = String(fetchMock.mock.calls[0][0]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/api/repository/gc');
    expect(init.method).toBe('POST');
  });
});

describe('uploadBlob', () => {
  it('sends binary body and returns blobId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ blobId: 'my-vault/a.md@v1' }, 201));
    const client = makeClient(fetchMock);
    const content = new TextEncoder().encode('hello');
    const blobId = await client.uploadBlob('a.md', content, 1700000000);
    expect(blobId).toBe('my-vault/a.md@v1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/repository/blobs?');
    expect(url).toContain('path=a.md');
    expect(url).toContain('mtime=1700000000');
    expect(init.method).toBe('POST');
    expect(init.body).toEqual(content);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
  });
});

describe('multipart upload', () => {
  it('creates a session then uploads a part directly without Worker headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ blobId: 'my-vault/a.bin@id', uploadId: 'u1', partSize: 16, partCount: 1, uploadedParts: [] }, 201))
      .mockResolvedValueOnce(new Response('', { status: 200, headers: { ETag: '"etag-1"' } }));
    const client = makeClient(fetchMock);
    const session = await client.startMultipart({ path: 'a.bin', size: 5, hash: 'a'.repeat(64), mtime: 1 });
    const etag = await client.uploadMultipartPart('https://storage.example.com/a?signature=x', new Uint8Array([1, 2]));
    expect(session.uploadId).toBe('u1');
    expect(etag).toBe('"etag-1"');
    const directInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(directInit.method).toBe('PUT');
    expect(directInit.headers).toBeUndefined();
  });
});

describe('error handling', () => {
  it('throws WorkerApiError on 4xx (non-401)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }));
    const client = makeClient(fetchMock);
    await expect(client.repoHead()).rejects.toMatchObject({ status: 403 });
  });

  it('triggers onUnauthorized on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const onUnauthorized = vi.fn();
    const client = makeClient(fetchMock, { onUnauthorized });
    await expect(client.repoHead()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock, { maxRetries: 2 });
    const promise = client.repoHead();
    // 推进 fake timers（500 + 1000 ms 退避）
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.head).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does NOT retry on 413', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"too large"}', { status: 413 }));
    const client = makeClient(fetchMock);
    await expect(client.uploadBlob('a', new Uint8Array(1), 1)).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 未重试
  });

  it('does NOT retry on 400 (client error)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"missing fields: path"}', { status: 400 }));
    const client = makeClient(fetchMock);
    await expect(client.uploadBlob('a', new Uint8Array(1), 1)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock, { maxRetries: 1 });
    const promise = client.repoHead();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.head).toBeNull();
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
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock);
    client.setJwt('new-jwt');
    await client.repoHead();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer new-jwt');
  });

  it('updates storageId + syncFolder after construction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyRepoHead()));
    const client = makeClient(fetchMock);
    client.setStorage('s-new', 'folder-new');
    await client.repoHead();
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
