import { describe, expect, it, vi } from 'vitest';
import { HeadConflictError } from '@synx/repo-core';
import { StorageRequestError } from '@synx/storage-core';
import type { RepositoryClient } from './repositoryClient.js';
import { HybridRepositoryClient } from './hybridRepositoryClient.js';
import { RepositoryTransportSelector } from './repositoryTransportSelector.js';

const scope = {
  userId: 'user-1', jwt: 'jwt-1', storageId: 'storage-1', syncFolder: 'Vault', credentialGeneration: 0,
};

function client(repoHead: () => Promise<any>): RepositoryClient {
  return {
    storageId: 'storage-1', syncFolder: 'Vault', repoHead,
    repoInit: vi.fn(async () => undefined), repoCommit: vi.fn(async () => null), repoTree: vi.fn(async () => null),
    uploadBlob: vi.fn(async () => undefined), finalizeCommit: vi.fn(async () => undefined),
    repoContent: vi.fn(async () => null), repoFileHistory: vi.fn(async () => ({ commits: [], changes: [], nextCursor: null })),
  } as unknown as RepositoryClient;
}

function setup(probe = vi.fn(async () => ({ head: null, tree: [], storageId: 'storage-1', syncFolder: 'Vault' })), type: 's3' | 'webdav' | 'onedrive' = 's3') {
  const direct = client(probe);
  const worker = client(vi.fn());
  const resolver = { resolve: vi.fn(async () => ({ client: direct, type } as any)), invalidate: vi.fn() };
  return { direct, worker, resolver, selector: new RepositoryTransportSelector(resolver) };
}

describe('RepositoryTransportSelector', () => {
  it.each(['s3', 'webdav', 'onedrive'] as const)('selects hybrid for %s so metadata writes use Worker', async (type) => {
    const { selector, direct, worker } = setup(undefined, type);
    const selected = await selector.selectSync(scope, worker);
    expect(selected).toBeInstanceOf(HybridRepositoryClient);

    await selected.repoInit('device');
    await selected.finalizeCommit({} as never);
    await selected.repoHead();
    await selected.uploadBlob('blob', new Uint8Array(), 1);

    expect(worker.repoInit).toHaveBeenCalledOnce();
    expect(worker.finalizeCommit).toHaveBeenCalledOnce();
    expect(direct.repoInit).not.toHaveBeenCalled();
    expect(direct.finalizeCommit).not.toHaveBeenCalled();
    expect(direct.repoHead).toHaveBeenCalledTimes(2);
    expect(direct.uploadBlob).toHaveBeenCalledOnce();
  });

  it('falls back the whole round to Worker on transport incompatibility', async () => {
    const { selector, worker } = setup(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(selector.selectSync(scope, worker)).resolves.toBe(worker);
  });

  it('does not fallback on CAS conflict or repository errors', async () => {
    const conflict = setup(vi.fn().mockRejectedValue(new HeadConflictError()));
    await expect(conflict.selector.selectSync(scope, conflict.worker)).rejects.toBeInstanceOf(HeadConflictError);

    const corruption = setup(vi.fn().mockRejectedValue(new SyntaxError('bad repository json')));
    await expect(corruption.selector.selectSync(scope, corruption.worker)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('invalidates direct credentials and does not fallback on storage auth failure', async () => {
    const auth = new StorageRequestError(403, 'webdav head failed');
    const { selector, resolver, worker } = setup(vi.fn().mockRejectedValue(auth));
    await expect(selector.selectSync(scope, worker)).rejects.toBe(auth);
    expect(resolver.invalidate).toHaveBeenCalledWith('storage-1');
  });

  it('single-flights history selection and probes only once for concurrent consumers', async () => {
    let release!: () => void;
    const probe = vi.fn(() => new Promise<any>((resolve) => { release = () => resolve({ head: null, tree: [], storageId: 'storage-1', syncFolder: 'Vault' }); }));
    const { selector, worker, resolver } = setup(probe);
    const first = selector.getHistory(scope, worker);
    const second = selector.getHistory(scope, worker);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    release();
    const [firstClient, secondClient] = await Promise.all([first, second]);
    expect(firstClient).toBe(secondClient);
    expect(firstClient).toBeInstanceOf(HybridRepositoryClient);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
