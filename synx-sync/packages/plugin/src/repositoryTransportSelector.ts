import { StorageRequestError } from '@synx/storage-core';
import type { DirectRepositoryScope, ResolvedDirectRepository } from './directRepositoryResolver.js';
import { HybridRepositoryClient } from './hybridRepositoryClient.js';
import type { RepositoryClient } from './repositoryClient.js';

interface DirectResolver {
  resolve(scope: DirectRepositoryScope): Promise<ResolvedDirectRepository>;
  invalidate(storageId?: string): void;
}

export function isStorageCredentialError(error: unknown): error is StorageRequestError & { status: 401 | 403 } {
  return error instanceof StorageRequestError && (error.status === 401 || error.status === 403);
}

export function isDirectTransportIncompatible(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(error.message);
}

export class RepositoryTransportSelector {
  private historySelection: { key: string; promise: Promise<RepositoryClient> } | null = null;

  constructor(
    private readonly resolver: DirectResolver,
    private readonly onStorageCredentialError?: (status: 401 | 403, storageId: string) => void,
  ) {}

  async selectSync(scope: DirectRepositoryScope, worker: RepositoryClient): Promise<RepositoryClient> {
    return this.probe(scope, worker);
  }

  getHistory(scope: DirectRepositoryScope, worker: RepositoryClient): Promise<RepositoryClient> {
    const key = JSON.stringify(scope);
    if (this.historySelection?.key === key) return this.historySelection.promise;
    const promise = this.probe(scope, worker).catch((error) => {
      if (this.historySelection?.promise === promise) this.historySelection = null;
      throw error;
    });
    this.historySelection = { key, promise };
    return promise;
  }

  invalidate(storageId?: string): void {
    this.historySelection = null;
    this.resolver.invalidate(storageId);
  }

  private async probe(scope: DirectRepositoryScope, worker: RepositoryClient, fallbackOnAnyProbeFailure = false): Promise<RepositoryClient> {
    try {
      const resolved = await this.resolver.resolve(scope);
      await resolved.client.repoHead();
      return new HybridRepositoryClient(
        worker as RepositoryClient & { readonly storageId: string; readonly syncFolder: string },
        resolved.client,
      );
    } catch (error) {
      if (isStorageCredentialError(error)) {
        this.resolver.invalidate(error.status === 403 ? scope.storageId : undefined);
        this.onStorageCredentialError?.(error.status, scope.storageId);
        throw error;
      }
      if (isDirectTransportIncompatible(error)) return worker;
      throw error;
    }
  }
}
