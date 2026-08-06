import {
  fileHistory,
  finalizeCommit,
  gcRepository,
  getCommitDetail,
  initRepository,
  readContent,
  readHead,
  readTree,
} from '@synx/repo-core';
import {
  makeStorageKey,
  type RepoFileHistoryResponse,
  type RepoFinalizeRequest,
  type RepoFinalizeResponse,
  type RepoHeadResponse,
  type RepoInitResponse,
  type RetentionPolicy,
  type WorkerFs,
} from '@synx/shared';
import type { RepositoryClient } from './repositoryClient.js';

export class DirectRepositoryClient implements RepositoryClient {
  constructor(
    readonly storageId: string,
    readonly syncFolder: string,
    private readonly fs: WorkerFs,
  ) {}

  async repoHead(): Promise<RepoHeadResponse> {
    const head = await readHead(this.fs, this.syncFolder);
    const tree = head ? (await readTree(this.fs, this.syncFolder, head.commitId)).files : [];
    return { head, tree, storageId: this.storageId, syncFolder: this.syncFolder };
  }

  repoInit(author?: string): Promise<RepoInitResponse> {
    return initRepository({ storageId: this.storageId, syncFolder: this.syncFolder, fs: this.fs, author });
  }

  repoCommit(commitId: string) {
    return getCommitDetail(this.fs, this.syncFolder, commitId);
  }

  async repoTree(commitId: string) {
    return (await readTree(this.fs, this.syncFolder, commitId)).files;
  }

  async uploadBlob(path: string, content: ArrayBuffer | Uint8Array, _mtime: number): Promise<string> {
    const blobId = makeStorageKey(this.syncFolder, path, crypto.randomUUID());
    await this.fs.put(blobId, content);
    return blobId;
  }

  finalizeCommit(input: RepoFinalizeRequest): Promise<RepoFinalizeResponse> {
    return finalizeCommit({ ...input, storageId: this.storageId, syncFolder: this.syncFolder, fs: this.fs });
  }

  async repoContent(commitId: string, path: string): Promise<ArrayBuffer> {
    return (await readContent(this.fs, this.syncFolder, commitId, path)).content;
  }

  async repoFileHistory(path: string, fileUuid?: string, from?: string): Promise<RepoFileHistoryResponse> {
    const head = await readHead(this.fs, this.syncFolder);
    const identity = fileUuid ?? `path:${path}`;
    if (!head) return { identity, commits: [], changes: [], headCommitId: null, nextCursor: null };
    const result = await fileHistory(this.fs, this.syncFolder, head, identity, 15, from);
    return { identity, ...result, headCommitId: head.commitId };
  }

  repoGc(policy: RetentionPolicy) {
    return gcRepository({ fs: this.fs, syncFolder: this.syncFolder, policy });
  }
}
