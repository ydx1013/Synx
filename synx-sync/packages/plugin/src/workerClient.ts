import {
  API,
  HEADERS,
  type Entity,
  type FileMeta,
  type PutResponse,
  type ListResponse,
  type HistoryResponse,
  type RollbackResponse,
  type VersionRecord,
  type AuthResponse,
  type StorageSummary,
  type StorageListResponse,
  type RetentionPolicy,
  type RetentionPolicyResponse,
} from '@synx/shared';

/**
 * WorkerClient：插件端通过 HTTP 调 Workers API 的传输层。
 *
 * 实现 SyncFs 子集（list/readFile/writeFile），并提供 history/rollback/storage 等高级 API。
 * 失败重试（指数退避 3 次）；401 时触发 onUnauthorized 回调（让 UI 提示重登）。
 */
export interface WorkerClientOptions {
  serverUrl: string;
  jwt: string;
  storageId: string;
  syncFolder: string;
  /** 401 时回调（由 UI 层提示重登录） */
  onUnauthorized?: () => void;
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

  // ===== SyncFs 接口实现 =====

  /** 列举远端 current 版本（返回 Entity 列表） */
  async list(_path = ''): Promise<Entity[]> {
    const res = await this.request<ListResponse>('GET', API.list);
    return res.files.map(fileToEntity);
  }

  /** 读取文件内容（二进制直传，不经 base64；version 元数据通过 X-Synx-Version 响应头返回） */
  async readFile(path: string, versionId?: string, fileUuid?: string): Promise<ArrayBuffer> {
    const params = new URLSearchParams({ path });
    if (versionId) params.set('version', versionId);
    if (fileUuid) params.set('fileUuid', fileUuid);
    const res = await this.requestResponse('GET', `${API.get}?${params.toString()}`);
    return res.arrayBuffer();
  }

  /** 写入新版本（二进制直传，产生新 VersionRecord） */
  async writeFile(path: string, content: ArrayBuffer | Uint8Array, mtime: number, author?: string, fileUuid?: string): Promise<VersionRecord> {
    const params = new URLSearchParams({ path, mtime: String(mtime) });
    if (fileUuid) params.set('fileUuid', fileUuid);
    if (author) params.set('author', author);
    const res = await this.requestResponse('POST', `${API.put}?${params.toString()}`, content, true);
    const data = (await res.json()) as PutResponse;
    return data.version;
  }

  async deleteFile(path: string, fileUuid?: string): Promise<void> {
    await this.request<{ deleted: boolean }>('DELETE', API.file, { path, fileUuid });
  }

  // ===== 版本历史 API（Task 16 历史侧栏使用） =====

  async history(path: string, fileUuid?: string): Promise<VersionRecord[]> {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    const res = await this.request<HistoryResponse>('GET', `${API.history}?${params.toString()}`);
    return res.versions;
  }

  async rollback(path: string, versionId: string, fileUuid?: string): Promise<VersionRecord> {
    const res = await this.request<RollbackResponse>('POST', '/api/rollback', {
      path,
      fileUuid,
      version: versionId,
    });
    return res.version;
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
  private async requestResponse(method: string, path: string, body?: unknown, isBinary = false): Promise<Response> {
    let lastErr: unknown;
    const url = joinUrl(this.opts.serverUrl, path);
    const isUpload = method === 'POST' && body !== undefined;
    // 大文件上传给 120s，其他请求 30s
    const timeoutMs = isUpload ? 120_000 : 30_000;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const headers = this.headers(body !== undefined, isBinary);
        const bodyData = body !== undefined && !isBinary ? JSON.stringify(body) : body;
        console.log('synx request', { method, url, attempt: attempt + 1, bodyLen: bodyData?.length ?? 0, timeoutMs });
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyData as BodyInit | undefined,
          signal: controller.signal,
        });
        const elapsed = Date.now() - startedAt;
        console.log('synx response', { status: res.status, attempt: attempt + 1, elapsedMs: elapsed });
        if (res.status === 401) {
          this.opts.onUnauthorized?.();
          throw new WorkerApiError(401, 'unauthorized', attempt + 1);
        }
        if (res.status === 413) {
          const errBody = await safeErrorText(res);
          throw new WorkerApiError(413, errBody || 'file too large', attempt + 1);
        }
        if (res.status >= 500 && attempt < this.maxRetries) {
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
        if (attempt < this.maxRetries) {
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

  private headers(hasBody: boolean, isBinary = false): Record<string, string> {
    const h: Record<string, string> = {
      [HEADERS.authorization]: `Bearer ${this.opts.jwt}`,
      [HEADERS.storageId]: this.opts.storageId,
      [HEADERS.syncFolder]: this.opts.syncFolder,
    };
    if (hasBody) h[HEADERS.contentType] = isBinary ? 'application/octet-stream' : 'application/json';
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

function fileToEntity(f: FileMeta): Entity {
  return {
    key: '/' + f.path.replace(/^\/+/, ''),
    mtime: f.mtime,
    size: f.size,
    type: 'file',
    hash: f.hash,
    etag: f.hash,
    versionId: f.versionId,
    fileUuid: f.fileUuid,
  };
}

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


