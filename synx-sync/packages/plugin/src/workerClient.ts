import {
  API,
  HEADERS,
  type AuthResponse,
  type StorageSummary,
  type StorageListResponse,
  type StorageCredentialsResponse,
  type RetentionPolicy,
  type RetentionPolicyResponse,
  type RepoHeadResponse,
  type RepoInitResponse,
  type RepoCommit,
  type RepoCommitResponse,
  type RepoTreeResponse,
  type RepoFinalizeRequest,
  type RepoFinalizeResponse,
  type RepoFile,
  type RepoFileHistoryResponse,
  type RepoGcResponse,
  type DirectUploadStartRequest,
  type DirectUploadSessionResponse,
  type ImageGallery,
  type ImageGalleryListResponse,
  type ImageUploadResponse,
  type OrphanScanResponse,
  type RepoLockClearResponse,
} from '@synx/shared';
import { parseStorageCredentialsResponse } from './credentialCache.js';

/**
 * WorkerClient：插件端通过 HTTP 调 Workers API 的传输层。
 *
 * 通过 Git 式仓库 API（repoHead/repoBlobs/repoFinalize/repoContent/repoFileHistory）
 * 与远端同步；失败重试（指数退避 3 次）；401 时触发 onUnauthorized 回调（让 UI 提示重登）。
 */
export interface WorkerClientOptions {
  serverUrl: string;
  jwt: string;
  storageId: string;
  syncFolder: string;
  /** 401 时回调（由 UI 层提示重登录） */
  onUnauthorized?: () => void;
  /** 401/403 时回调；用于按状态清理凭证缓存 */
  onAuthFailure?: (status: 401 | 403, storageId: string) => void;
  /** fetch 实现（默认全局 fetch；测试时可注入） */
  fetchImpl?: typeof fetch;
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
}

export function normalizeServerUrl(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('服务器地址无效');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error('服务器地址必须使用 HTTPS');
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/(?:dashboard(?:\.html)?|login(?:\.html)?)\/?$/i, '').replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

export function assertSecureServerUrl(serverUrl: string): void {
  normalizeServerUrl(serverUrl);
}

export class WorkerClient {
  private fetchImpl: typeof fetch;
  private maxRetries: number;

  constructor(private opts: WorkerClientOptions) {
    assertSecureServerUrl(opts.serverUrl);
    // 不能用 fetch.bind(globalThis) —— Obsidian/Electron 环境下会 "Illegal invocation"
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.maxRetries = opts.maxRetries ?? 3;
  }

  /** 更新 JWT（登录后调用） */
  setJwt(jwt: string) {
    this.opts.jwt = jwt;
  }

  /** 更新 storageId + syncFolder（用户切换存储后调用） */
  setStorage(storageId: string, syncFolder: string) {
    this.opts.storageId = storageId;
    this.opts.syncFolder = syncFolder;
  }

  /** 当前请求标识的存储 */
  get storageId(): string {
    return this.opts.storageId;
  }

  /** 当前请求标识的仓库目录 */
  get syncFolder(): string {
    return this.opts.syncFolder;
  }

  // ===== Git 式仓库 API（同步走全库原子提交） =====

  /** 读取仓库 HEAD + 当前完整树（替代旧 list() 作为远端状态来源） */
  async repoHead(): Promise<RepoHeadResponse> {
    return this.request<RepoHeadResponse>('GET', API.repoHead);
  }

  /** 初始化仓库：把当前远端状态完整收进 initial 提交。已存在时报 409 REPO_EXISTS。 */
  async repoInit(author?: string): Promise<RepoInitResponse> {
    return this.request<RepoInitResponse>('POST', API.repoInit, { author });
  }

  /** 按 commitId 读取完整提交（本地历史索引增量补齐用）。 */
  async repoCommit(commitId: string): Promise<RepoCommit> {
    const res = await this.request<RepoCommitResponse>('GET', `${API.repoCommits}/${encodeURIComponent(commitId)}`);
    return res.commit;
  }

  /** 读取某提交下的文件树 */
  async repoTree(commitId: string): Promise<RepoFile[]> {
    const res = await this.request<RepoTreeResponse>('GET', `${API.repoTree}?commitId=${encodeURIComponent(commitId)}`);
    return res.files;
  }

  /** 上传不可变内容对象（二进制直传），返回 blobId 供 finalize 变更集引用 */
  async uploadBlob(path: string, content: ArrayBuffer | Uint8Array, mtime: number): Promise<string> {
    const params = new URLSearchParams({ path, mtime: String(mtime) });
    const res = await this.requestResponse('POST', `${API.repoBlobs}?${params.toString()}`, content, true);
    const data = (await res.json()) as { blobId: string };
    return data.blobId;
  }

  /** 大文件直传：向 Worker 申请预签名 PUT URL（服务端生成 blobId） */
  async startDirectUpload(input: DirectUploadStartRequest): Promise<DirectUploadSessionResponse> {
    return this.request<DirectUploadSessionResponse>('POST', API.repoDirectUpload, input);
  }

  /** 把整个文件内容直接 PUT 到对象存储（不带 Worker 的 JWT/仓库头），由 finalize 时校验 blob 存在 */
  async uploadDirect(url: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    const res = await this.fetchImpl(url, { method: 'PUT', body: content as BodyInit });
    if (!res.ok) throw new WorkerApiError(res.status, await safeErrorText(res));
  }

  /** 原子提交变更集（CAS）。HEAD 已被推进时抛 WorkerApiError(409) */
  async finalizeCommit(input: RepoFinalizeRequest): Promise<RepoFinalizeResponse> {
    return this.request<RepoFinalizeResponse>('POST', API.repoFinalize, input);
  }

  /** 读取某提交下的文件内容（二进制，路径与 blob 解引用） */
  async repoContent(commitId: string, path: string): Promise<ArrayBuffer> {
    const params = new URLSearchParams({ commitId, path });
    const res = await this.requestResponse('GET', `${API.repoContent}?${params.toString()}`);
    return res.arrayBuffer();
  }

  /** 单文件历史：按 identity 从提交链派生；from 提供后返回其后的更早历史（分页游标） */
  async repoFileHistory(path: string, fileUuid?: string, from?: string): Promise<RepoFileHistoryResponse> {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    if (from) params.set('from', from);
    return this.request<RepoFileHistoryResponse>('GET', `${API.repoFileHistory}?${params.toString()}`);
  }

  /** 垃圾回收：清理孤儿内容对象 + 按保留策略裁剪历史提交（静默调用，失败不影响同步） */
  async repoGc(): Promise<RepoGcResponse> {
    return this.request<RepoGcResponse>('POST', API.repoGc, {});
  }

  async forceClearRepositoryLock(confirm: string): Promise<RepoLockClearResponse> {
    return this.request<RepoLockClearResponse>('POST', API.repoLockClear, { force: true, confirm });
  }

  // ===== 静态方法：登录、列出存储（不依赖 storageId/syncFolder） =====

  /** 登录：返回 JWT + user */
  static async login(
    serverUrl: string,
    usernameOrEmail: string,
    password: string,
    fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
  ): Promise<AuthResponse> {
    const res = await fetchImpl(joinUrl(normalizeServerUrl(serverUrl), API.login), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernameOrEmail, password }),
    });
    if (!res.ok) {
      throw new WorkerApiError(res.status, await safeErrorText(res));
    }
    return res.json();
  }

  /** 列出当前用户的存储（登录后） */
  static async listStorages(
    serverUrl: string,
    jwt: string,
    fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
  ): Promise<StorageSummary[]> {
    const res = await fetchImpl(joinUrl(normalizeServerUrl(serverUrl), API.storageList), {
      headers: { [HEADERS.authorization]: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new WorkerApiError(res.status, await safeErrorText(res));
    const data = (await res.json()) as StorageListResponse;
    return data.storages;
  }

  static async listImageGalleries(
    serverUrl: string,
    jwt: string,
    fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
  ): Promise<ImageGallery[]> {
    const res = await fetchImpl(joinUrl(normalizeServerUrl(serverUrl), API.imageGalleryList), {
      headers: { [HEADERS.authorization]: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new WorkerApiError(res.status, await safeErrorText(res));
    return ((await res.json()) as ImageGalleryListResponse).galleries;
  }

  async uploadGalleryImage(galleryId: string, content: ArrayBuffer | Uint8Array, mimeType: string): Promise<ImageUploadResponse['image']> {
    const path = API.imageGalleryImages.replace(':id', encodeURIComponent(galleryId));
    const res = await this.requestResponse('POST', path, content, true, mimeType, 0);
    return ((await res.json()) as ImageUploadResponse).image;
  }

  async readGalleryImage(galleryId: string, path: string): Promise<Blob> {
    const endpoint = API.imageGalleryContent.replace(':id', encodeURIComponent(galleryId));
    const res = await this.requestResponse('GET', `${endpoint}?path=${encodeURIComponent(path)}`);
    return res.blob();
  }

  async scanGalleryOrphans(galleryId: string, referencedPaths: string[]): Promise<OrphanScanResponse['images']> {
    const endpoint = API.imageGalleryOrphanScan.replace(':id', encodeURIComponent(galleryId));
    return (await this.request<OrphanScanResponse>('POST', endpoint, { referencedPaths })).images;
  }

  /** 读取当前 storage 的直连凭证（调用方仅可在内存中使用或加密缓存） */
  async getStorageCredentials(): Promise<StorageCredentialsResponse> {
    const storageId = this.opts.storageId;
    const path = API.storageCredentials.replace(':id', encodeURIComponent(storageId));
    return parseStorageCredentialsResponse(await this.request<unknown>('GET', path), storageId);
  }

  /** 读取当前 storage 的保留策略（未配置时返回服务端默认） */
  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const storageId = this.opts.storageId;
    const res = await this.request<RetentionPolicyResponse>('GET', API.storageRetention.replace(':id', encodeURIComponent(storageId)));
    return res.policy;
  }

  /** 保存当前 storage 的保留策略（服务端会归一化非法字段） */
  async setRetentionPolicy(policy: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
    const storageId = this.opts.storageId;
    const res = await this.request<RetentionPolicyResponse>('PUT', API.storageRetention.replace(':id', encodeURIComponent(storageId)), policy);
    return res.policy;
  }

  // ===== 内部：带重试的请求 =====

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.requestResponse(method, path, body);
    return res.json() as Promise<T>;
  }

  /**
   * 带重试的原始请求：返回 Response（调用方决定读 json 还是 arrayBuffer）。
   * @param body 普通对象（JSON）或 ArrayBuffer/Uint8Array（二进制直传）
   * @param isBinary body 为二进制时置 true（Content-Type 用 octet-stream）
   */
  private async requestResponse(method: string, path: string, body?: unknown, isBinary = false, binaryContentType = 'application/octet-stream', maxRetries = this.maxRetries): Promise<Response> {
    let lastErr: unknown;
    const url = joinUrl(this.opts.serverUrl, path);
    const isUpload = method === 'POST' && body !== undefined;
    // 大文件上传给 120s，其他请求 30s
    const timeoutMs = isUpload ? 120_000 : 30_000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const headers = this.headers(body !== undefined, isBinary, binaryContentType);
        const bodyData = body !== undefined && !isBinary ? JSON.stringify(body) : body;
        const bodyLen = typeof bodyData === 'string' ? bodyData.length : bodyData instanceof ArrayBuffer ? bodyData.byteLength : 0;
        console.log('synx request', { method, url, attempt: attempt + 1, bodyLen, timeoutMs });
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyData as BodyInit | undefined,
          signal: controller.signal,
        });
        const elapsed = Date.now() - startedAt;
        console.log('synx response', { status: res.status, attempt: attempt + 1, elapsedMs: elapsed });
        if (res.status === 401) {
          this.opts.onAuthFailure?.(401, this.opts.storageId);
          this.opts.onUnauthorized?.();
          throw new WorkerApiError(401, 'unauthorized', attempt + 1);
        }
        if (res.status === 403) this.opts.onAuthFailure?.(403, this.opts.storageId);
        if (res.status === 413) {
          const errBody = await safeErrorText(res);
          throw new WorkerApiError(413, errBody || 'file too large', attempt + 1);
        }
        if (res.status >= 500 && attempt < maxRetries) {
          // 5xx：指数退避重试
          const backoff = 500 * Math.pow(2, attempt);
          console.warn('synx 5xx retry', { status: res.status, attempt: attempt + 1, elapsedMs: elapsed, backoffMs: backoff });
          await sleep(backoff);
          continue;
        }
        if (!res.ok) {
          throw new WorkerApiError(res.status, await safeErrorText(res), attempt + 1);
        }
        return res;
      } catch (e) {
        const elapsed = Date.now() - startedAt;
        const isTimeout = e instanceof DOMException && e.name === 'AbortError';
        console.error('synx request error', {
          method, url, attempt: attempt + 1, elapsedMs: elapsed,
          isTimeout,
          errorName: e instanceof Error ? e.name : typeof e,
          errorMessage: e instanceof Error ? e.message : String(e),
          errorStack: e instanceof Error ? e.stack?.split('\n').slice(0, 5).join('\n') : undefined,
        });
        if (e instanceof WorkerApiError) {
          // 客户端错误（除 429 限流）不重试
          if (e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
        }
        // 超时错误包装为可读消息
        if (isTimeout) {
          lastErr = new Error(`请求超时 (${elapsed}ms, 限制 ${timeoutMs}ms)`);
        } else {
          lastErr = e;
        }
        if (attempt < maxRetries) {
          // 退避：500ms, 1000ms, 2000ms（给间歇性 503 足够恢复时间）
          const backoff = 500 * Math.pow(2, attempt);
          console.warn('synx retry backoff', { attempt: attempt + 1, backoffMs: backoff });
          await sleep(backoff);
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new Error('request failed');
  }

  private headers(hasBody: boolean, isBinary = false, binaryContentType = 'application/octet-stream'): Record<string, string> {
    const h: Record<string, string> = {
      [HEADERS.authorization]: `Bearer ${this.opts.jwt}`,
      [HEADERS.storageId]: this.opts.storageId,
      [HEADERS.syncFolder]: this.opts.syncFolder,
    };
    if (hasBody) h[HEADERS.contentType] = isBinary ? binaryContentType : 'application/json';
    return h;
  }
}

/** HTTP 错误：路由层抛出，UI 显示 status + message */
export class WorkerApiError extends Error {
  constructor(public status: number, message: string, public attempts = 1) {
    super(message);
    this.name = 'WorkerApiError';
  }
}

// ===== 辅助函数 =====

function joinUrl(base: string, path: string): string {
  return `${normalizeServerUrl(base)}${path}`;
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


