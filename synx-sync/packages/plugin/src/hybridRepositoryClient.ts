import type { RepoFinalizeRequest } from '@synx/shared';
import type { RepositoryClient } from './repositoryClient.js';

type ScopedRepositoryClient = RepositoryClient & { readonly storageId: string; readonly syncFolder: string };

export class HybridRepositoryClient implements RepositoryClient {
  readonly storageId: string;
  readonly syncFolder: string;

  constructor(
    private readonly worker: ScopedRepositoryClient,
    private readonly direct: ScopedRepositoryClient,
  ) {
    if (worker.storageId !== direct.storageId) throw new Error('Worker 和 direct storageId 不匹配');
    if (worker.syncFolder !== direct.syncFolder) throw new Error('Worker 和 direct syncFolder 不匹配');
    this.storageId = direct.storageId;
    this.syncFolder = direct.syncFolder;
  }

  repoHead() { return this.direct.repoHead(); }
  repoInit(author?: string) { return this.worker.repoInit(author); }
  repoCommit(commitId: string) { return this.direct.repoCommit(commitId); }
  repoTree(commitId: string) { return this.direct.repoTree(commitId); }
  uploadBlob(path: string, content: ArrayBuffer | Uint8Array, mtime: number) { return this.direct.uploadBlob(path, content, mtime); }
  finalizeCommit(input: RepoFinalizeRequest) { return this.worker.finalizeCommit(input); }
  repoContent(commitId: string, path: string) { return this.direct.repoContent(commitId, path); }
  repoFileHistory(path: string, fileUuid?: string, from?: string) { return this.direct.repoFileHistory(path, fileUuid, from); }
}
