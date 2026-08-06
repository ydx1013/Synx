import { describe, expect, it, vi } from 'vitest';
import type { RepositoryClient } from './repositoryClient.js';
import { HybridRepositoryClient } from './hybridRepositoryClient.js';

function client(storageId = 'storage-1', syncFolder = 'Vault') {
  return {
    storageId, syncFolder,
    repoHead: vi.fn(async () => 'direct-head'), repoInit: vi.fn(async () => 'worker-init'),
    repoCommit: vi.fn(async () => 'direct-commit'), repoTree: vi.fn(async () => 'direct-tree'),
    uploadBlob: vi.fn(async () => 'direct-blob'), finalizeCommit: vi.fn(async () => 'worker-finalize'),
    repoContent: vi.fn(async () => 'direct-content'), repoFileHistory: vi.fn(async () => 'direct-history'),
  } as unknown as RepositoryClient & { storageId: string; syncFolder: string };
}

describe('HybridRepositoryClient', () => {
  it('routes init and finalize to Worker and all data-plane methods to direct', async () => {
    const worker = client();
    const direct = client();
    const hybrid = new HybridRepositoryClient(worker, direct);

    await hybrid.repoInit('device'); await hybrid.finalizeCommit({} as never);
    await hybrid.repoHead(); await hybrid.repoCommit('c'); await hybrid.repoTree('c');
    await hybrid.uploadBlob('a', new Uint8Array(), 1); await hybrid.repoContent('c', 'a'); await hybrid.repoFileHistory('a');

    expect(worker.repoInit).toHaveBeenCalledOnce(); expect(worker.finalizeCommit).toHaveBeenCalledOnce();
    expect(worker.repoHead).not.toHaveBeenCalled(); expect(worker.uploadBlob).not.toHaveBeenCalled();
    expect(direct.repoInit).not.toHaveBeenCalled(); expect(direct.finalizeCommit).not.toHaveBeenCalled();
    expect(direct.repoHead).toHaveBeenCalledOnce(); expect(direct.repoCommit).toHaveBeenCalledOnce();
    expect(direct.repoTree).toHaveBeenCalledOnce(); expect(direct.uploadBlob).toHaveBeenCalledOnce();
    expect(direct.repoContent).toHaveBeenCalledOnce(); expect(direct.repoFileHistory).toHaveBeenCalledOnce();
  });

  it('rejects mismatched worker and direct repository scopes', () => {
    expect(() => new HybridRepositoryClient(client('storage-1'), client('storage-2'))).toThrow('storageId');
    expect(() => new HybridRepositoryClient(client('storage-1', 'A'), client('storage-1', 'B'))).toThrow('syncFolder');
  });
});
