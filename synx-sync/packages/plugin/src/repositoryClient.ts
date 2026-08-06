import { HeadConflictError } from '@synx/repo-core';
import type {
  RepoCommit,
  RepoFile,
  RepoFileHistoryResponse,
  RepoFinalizeRequest,
  RepoFinalizeResponse,
  RepoHeadResponse,
  RepoInitResponse,
} from '@synx/shared';
import { WorkerApiError, WorkerClient } from './workerClient.js';

export interface RepositoryClient {
  repoHead(): Promise<RepoHeadResponse>;
  repoInit(author?: string): Promise<RepoInitResponse>;
  repoCommit(commitId: string): Promise<RepoCommit>;
  repoTree(commitId: string): Promise<RepoFile[]>;
  uploadBlob(path: string, content: ArrayBuffer | Uint8Array, mtime: number): Promise<string>;
  finalizeCommit(input: RepoFinalizeRequest): Promise<RepoFinalizeResponse>;
  repoContent(commitId: string, path: string): Promise<ArrayBuffer>;
  repoFileHistory(path: string, fileUuid?: string, from?: string): Promise<RepoFileHistoryResponse>;
}

export async function uploadRepositoryBlob(
  client: RepositoryClient,
  path: string,
  content: ArrayBuffer | Uint8Array,
  mtime: number,
  hash: string,
  directUploadThreshold: number,
): Promise<string> {
  if (client instanceof WorkerClient && content.byteLength > directUploadThreshold) {
    const session = await client.startDirectUpload({ path, size: content.byteLength, hash, mtime });
    await client.uploadDirect(session.uploadUrl, content);
    return session.blobId;
  }
  return client.uploadBlob(path, content, mtime);
}

export function isRepoHeadConflict(error: unknown): boolean {
  return error instanceof HeadConflictError
    || (error instanceof WorkerApiError && error.status === 409);
}
