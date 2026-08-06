import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ExternalRepositoryLockRequiredError, HeadConflictError, initRepository } from '@synx/repo-core';
import { makeStorageKey, type WorkerFs } from '@synx/shared';
import { DirectRepositoryClient } from './directRepositoryClient.js';
import { isRepoHeadConflict, uploadRepositoryBlob, type RepositoryClient } from './repositoryClient.js';
import { WorkerApiError, WorkerClient } from './workerClient.js';

class MemFs implements WorkerFs {
  readonly objects = new Map<string, Uint8Array>();
  putIfNoneMatch?: WorkerFs['putIfNoneMatch'];
  putIfMatch?: WorkerFs['putIfMatch'];
  getEtag?: WorkerFs['getEtag'];

  constructor(conditional = true) {
    if (conditional) {
      this.putIfNoneMatch = async (key, content) => {
        if (this.objects.has(key)) return false;
        await this.put(key, content);
        return true;
      };
      this.putIfMatch = async (key, content) => {
        if (!this.objects.has(key)) return false;
        await this.put(key, content);
        return true;
      };
      this.getEtag = async (key) => this.objects.has(key) ? 'etag' : null;
    }
  }

  async put(key: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    this.objects.set(key, content instanceof Uint8Array ? content : new Uint8Array(content));
  }

  async get(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`missing: ${key}`);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async head(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

const storageId = 'storage-1';
const syncFolder = 'Vault';

function makeClient() {
  const fs = new MemFs();
  return { fs, client: new DirectRepositoryClient(storageId, syncFolder, fs) };
}

describe('DirectRepositoryClient', () => {
  it('initializes an empty repository and reads its HEAD and commit', async () => {
    const { client } = makeClient();

    expect(await client.repoHead()).toEqual({ head: null, tree: [], storageId, syncFolder });
    const initialized = await client.repoInit('device-a');
    const result = await client.repoHead();

    expect(result.head).toEqual(initialized.head);
    expect(result.tree).toEqual([]);
    expect(await client.repoCommit(initialized.commit.commitId)).toEqual(initialized.commit);
    expect(await client.repoTree(initialized.commit.commitId)).toEqual([]);
  });

  it('uploads a blob, finalizes it, and reads the committed content', async () => {
    const { client, fs } = makeClient();
    const { head } = await client.repoInit();
    const content = new TextEncoder().encode('# hello');
    const blobId = await client.uploadBlob('a.md', content, 1000);

    expect(blobId).toMatch(/^Vault\/a\.md@/);
    expect(await fs.head(blobId)).toBe(true);

    const result = await client.finalizeCommit({
      baseCommitId: head.commitId,
      baseGeneration: head.generation,
      changes: [{
        identity: 'uuid-a', operation: 'add', path: 'a.md', blobId,
        hash: 'hash-a', size: content.byteLength, mtime: 1000,
      }],
    });

    expect(new Uint8Array(await client.repoContent(result.commit.commitId, 'a.md'))).toEqual(content);
    expect(await client.repoTree(result.commit.commitId)).toHaveLength(1);
  });

  it('derives file history with the same response shape as WorkerClient', async () => {
    const { client, fs } = makeClient();
    const { head } = await client.repoInit();
    const blobId = makeStorageKey(syncFolder, 'a.md', 'v1');
    await fs.put(blobId, new TextEncoder().encode('one'));
    const finalized = await client.finalizeCommit({
      baseCommitId: head.commitId,
      baseGeneration: head.generation,
      changes: [{
        identity: 'uuid-a', operation: 'add', path: 'a.md', blobId,
        hash: 'hash-a', size: 3, mtime: 1000,
      }],
    });

    const history = await client.repoFileHistory('a.md', 'uuid-a');
    expect(history.identity).toBe('uuid-a');
    expect(history.headCommitId).toBe(finalized.head.commitId);
    expect(history.commits.map((commit) => commit.commitId)).toEqual([finalized.commit.commitId]);
    expect(history.changes).toHaveLength(1);
    expect(history.nextCursor).toBeNull();
  });

  it('rejects direct init and finalize on a backend without atomic conditional writes', async () => {
    const fs = new MemFs(false);
    const client = new DirectRepositoryClient(storageId, syncFolder, fs);
    await expect(client.repoInit()).rejects.toBeInstanceOf(ExternalRepositoryLockRequiredError);

    const initialized = await initRepository({ storageId, syncFolder, fs, externalLock: true });
    const blobId = makeStorageKey(syncFolder, 'a.md', 'v1');
    await fs.put(blobId, new Uint8Array([1]));
    await expect(client.finalizeCommit({
      baseCommitId: initialized.head.commitId,
      baseGeneration: initialized.head.generation,
      changes: [{ identity: 'uuid-a', operation: 'add', path: 'a.md', blobId, hash: 'h', size: 1, mtime: 1 }],
    })).rejects.toBeInstanceOf(ExternalRepositoryLockRequiredError);
  });

  it('throws HeadConflictError when finalizing from a stale HEAD', async () => {
    const { client, fs } = makeClient();
    const { head } = await client.repoInit();
    const blobId = makeStorageKey(syncFolder, 'a.md', 'v1');
    await fs.put(blobId, new Uint8Array([1]));
    await client.finalizeCommit({
      baseCommitId: head.commitId,
      baseGeneration: head.generation,
      changes: [{ identity: 'uuid-a', operation: 'add', path: 'a.md', blobId, hash: 'h', size: 1, mtime: 1 }],
    });

    await expect(client.finalizeCommit({
      baseCommitId: head.commitId,
      baseGeneration: head.generation,
      changes: [{ identity: 'uuid-a', operation: 'add', path: 'a.md', blobId, hash: 'h', size: 1, mtime: 1 }],
    })).rejects.toBeInstanceOf(HeadConflictError);
  });
});

describe('RepositoryClient contract', () => {
  it('keeps WorkerClient structurally compatible without exposing Worker-only direct upload', () => {
    expectTypeOf<WorkerClient>().toMatchTypeOf<RepositoryClient>();
    expectTypeOf<RepositoryClient>().not.toHaveProperty('startDirectUpload');
    expectTypeOf<RepositoryClient>().not.toHaveProperty('uploadDirect');
  });

  it('uses Worker direct upload only above the threshold', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ blobId: 'direct-id', uploadUrl: 'https://storage.example.com/file', expiresIn: 900 }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const client = new WorkerClient({
      serverUrl: 'https://synx.example.com', jwt: 'token', storageId, syncFolder,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const content = new Uint8Array([1, 2]);

    await expect(uploadRepositoryBlob(client, 'large.bin', content, 1, 'hash', 1)).resolves.toBe('direct-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the RepositoryClient uploadBlob path for non-Worker clients', async () => {
    const client = { uploadBlob: vi.fn().mockResolvedValue('blob-id') } as unknown as RepositoryClient;
    const content = new Uint8Array([1, 2]);

    await expect(uploadRepositoryBlob(client, 'large.bin', content, 1, 'hash', 1)).resolves.toBe('blob-id');
    expect(client.uploadBlob).toHaveBeenCalledWith('large.bin', content, 1);
  });

  it('recognizes HTTP and direct repository HEAD conflicts', () => {
    expect(isRepoHeadConflict(new WorkerApiError(409, 'HEAD_CONFLICT'))).toBe(true);
    expect(isRepoHeadConflict(new WorkerApiError(500, 'failed'))).toBe(false);
    expect(isRepoHeadConflict(new HeadConflictError())).toBe(true);
    expect(isRepoHeadConflict(new Error('HEAD_CONFLICT'))).toBe(false);
  });
});
