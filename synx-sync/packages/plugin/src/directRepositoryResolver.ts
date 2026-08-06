import type { StorageCredentialsResponse, WorkerFs } from '@synx/shared';
import type { CreateStorageFsOptions } from '@synx/storage-core';
import { createStorageFs } from './storageFs.js';
import { DirectRepositoryClient } from './directRepositoryClient.js';

export interface DirectRepositoryScope {
  userId: string;
  jwt: string;
  storageId: string;
  syncFolder: string;
  credentialGeneration: number;
}

export type StorageCredentialsProvider = (scope: DirectRepositoryScope) => Promise<StorageCredentialsResponse>;
export type StorageFsFactory = (credentials: StorageCredentialsResponse, options?: CreateStorageFsOptions) => WorkerFs;
export type StorageFsOptionsProvider = (scope: DirectRepositoryScope) => CreateStorageFsOptions;
export type DirectRepositoryClientFactory = (storageId: string, syncFolder: string, fs: WorkerFs) => DirectRepositoryClient;

export interface ResolvedDirectRepository {
  client: DirectRepositoryClient;
  type: StorageCredentialsResponse['type'];
}

interface CacheEntry {
  storageId: string;
  promise: Promise<ResolvedDirectRepository>;
}

export class DirectRepositoryResolver {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly credentialsProvider: StorageCredentialsProvider,
    private readonly storageFsFactory: StorageFsFactory = createStorageFs,
    private readonly clientFactory: DirectRepositoryClientFactory = (storageId, syncFolder, fs) =>
      new DirectRepositoryClient(storageId, syncFolder, fs),
    private readonly storageFsOptionsProvider?: StorageFsOptionsProvider,
  ) {}

  resolve(scope: DirectRepositoryScope): Promise<ResolvedDirectRepository> {
    const key = JSON.stringify([
      scope.userId,
      scope.jwt,
      scope.storageId,
      scope.syncFolder,
      scope.credentialGeneration,
    ]);
    const cached = this.entries.get(key);
    if (cached) return cached.promise;

    const entry: CacheEntry = {
      storageId: scope.storageId,
      promise: Promise.resolve(undefined as never),
    };
    entry.promise = this.createClient(scope).catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  invalidate(storageId?: string): void {
    if (storageId === undefined) {
      this.entries.clear();
      return;
    }
    for (const [key, entry] of this.entries) {
      if (entry.storageId === storageId) this.entries.delete(key);
    }
  }

  private async createClient(scope: DirectRepositoryScope): Promise<ResolvedDirectRepository> {
    const credentials = await this.credentialsProvider(scope);
    if (credentials.storageId !== scope.storageId) {
      throw new Error('凭证 storageId 与请求 scope 不匹配');
    }
    return {
      client: this.clientFactory(
        scope.storageId,
        scope.syncFolder,
        this.storageFsFactory(credentials, this.storageFsOptionsProvider?.(scope)),
      ),
      type: credentials.type,
    };
  }
}
