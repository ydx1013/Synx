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
  /**
   * 探测结果缓存（selectSync 与 getHistory 共享）：
   * 同一 scope 内只 probe 一次，避免「直连失败回退 Worker」在同一次同步窗口内重复触发两次。
   * scope 含 jwt/credentialGeneration，登录态或凭证变更后 key 变化 → 重新探测。
   */
  private selection: { key: string; promise: Promise<RepositoryClient> } | null = null;

  constructor(
    private readonly resolver: DirectResolver,
    private readonly onStorageCredentialError?: (status: 401 | 403, storageId: string, scope: DirectRepositoryScope) => void,
  ) {}

  async selectSync(scope: DirectRepositoryScope, worker: RepositoryClient): Promise<RepositoryClient> {
    return this.getSelection(scope, worker);
  }

  getHistory(scope: DirectRepositoryScope, worker: RepositoryClient): Promise<RepositoryClient> {
    return this.getSelection(scope, worker);
  }

  private getSelection(scope: DirectRepositoryScope, worker: RepositoryClient): Promise<RepositoryClient> {
    const key = JSON.stringify(scope);
    if (this.selection?.key === key) return this.selection.promise;
    const promise = this.probe(scope, worker).catch((error) => {
      if (this.selection?.promise === promise) this.selection = null;
      throw error;
    });
    this.selection = { key, promise };
    return promise;
  }

  invalidate(storageId?: string): void {
    this.selection = null;
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
        this.onStorageCredentialError?.(error.status, scope.storageId, scope);
        throw error;
      }
      if (isDirectTransportIncompatible(error)) {
        // 直连 S3 探测失败（浏览器层 TypeError：CORS 未放行 / TLS 握手失败 / 网络不可达）。
        // 回退 Worker 代理继续同步；给出明确指引，便于用户修复 bucket CORS 后恢复直连。
        console.warn(`[synx] S3 直连不可用，已回退 Worker 代理（storage=${scope.storageId}）：${error instanceof Error ? error.message : String(error)}。若希望恢复直连，请检查对象存储 bucket 的 CORS 规则（允许 Obsidian 来源的 GET/HEAD/PUT/DELETE，放行 Authorization/Content-Type/ETag 请求头）以及网络/TLS 可达性。`);
        return worker;
      }
      throw error;
    }
  }
}
