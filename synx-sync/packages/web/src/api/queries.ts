import type {
  AuthResponse, ApiTokenListResponse, CreateApiTokenRequest, CreateApiTokenResponse,
  FileMeta, MeResponse, RepoChange, RepoCommitsResponse, RepoDiffResponse, RepoFileHistoryResponse, RepoFinalizeRequest,
  RepoFinalizeResponse, RepoGcResponse, RepoHeadResponse, RepoRestoreRequest, RepoRestoreResponse, RepositoryHead,
  PreferencesResponse, StorageListResponse, StorageSummary, UpdatePreferencesRequest,
  ImageGalleryListResponse, ImageGalleryResponse, SaveImageGalleryRequest,
} from '@synx/shared';
import { ApiError, api, clearSession } from './client';

export const authApi = {
  login: (body: { usernameOrEmail: string; password: string }) => api<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  register: (body: { username: string; email: string; password: string }) => api<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  me: () => api<MeResponse>('/api/auth/me'),
  updatePreferences: (body: UpdatePreferencesRequest) => api<PreferencesResponse>('/api/auth/me/preferences', { method: 'PATCH', body: JSON.stringify(body) }),
};

/** GET /api/storage/:id 返回带明文 config 的存储详情 */
export interface StorageDetail {
  id: string;
  name: string;
  type: string;
  config: Record<string, string | number | boolean>;
  createdAt: number;
}

export const storageApi = {
  list: () => api<StorageListResponse>('/api/storage'),
  get: (id: string) => api<{ storage: StorageDetail }>(`/api/storage/${encodeURIComponent(id)}`),
  save: (id: string | undefined, body: unknown) => api<{ storage: StorageSummary }>(id ? `/api/storage/${encodeURIComponent(id)}` : '/api/storage', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }),
  test: (body: unknown) => api<{ ok: boolean; message?: string }>('/api/storage/test', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => api<{ ok: true; remoteFilesPreserved: true }>(`/api/storage/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  purge: (id: string) => api<{ total: number; deleted: number; failed: number }>(`/api/storage/${encodeURIComponent(id)}/purge`, { method: 'POST' }),
};

export const galleryApi = {
  list: () => api<ImageGalleryListResponse>('/api/image-galleries'),
  get: (id: string) => api<ImageGalleryResponse>(`/api/image-galleries/${encodeURIComponent(id)}`),
  save: (id: string | undefined, body: SaveImageGalleryRequest) => api<ImageGalleryResponse>(id ? `/api/image-galleries/${encodeURIComponent(id)}` : '/api/image-galleries', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }),
  test: (body: SaveImageGalleryRequest) => api<{ isPrivate: boolean }>('/api/image-galleries/test', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => api<{ ok: true; remoteImagesPreserved: true }>(`/api/image-galleries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  readImage: async (id: string, path: string) => {
    const token = window.localStorage.getItem('synx-token');
    const response = await fetch(`/api/image-galleries/${encodeURIComponent(id)}/images/content?path=${encodeURIComponent(path)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new ApiError(response.status, '私有图片加载失败');
    return response.blob();
  },
};

export const tokenApi = {
  list: () => api<ApiTokenListResponse>('/api/tokens'),
  create: (body: CreateApiTokenRequest) => api<CreateApiTokenResponse>('/api/tokens', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => api<{ ok: true }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** OneDrive OAuth2 PKCE 流程（后端中转站不存储 token） */
export interface OnedriveAuthStart {
  authUrl: string;
  verifier: string;
  state: string;
  redirectUri: string;
}
export const onedriveApi = {
  start: (body: { clientId: string; authority?: string; remoteBaseDir?: string }) => api<OnedriveAuthStart>('/api/onedrive/auth/start', { method: 'POST', body: JSON.stringify(body) }),
  exchange: (body: { code: string; verifier: string; clientId: string; authority?: string; remoteBaseDir?: string }) => api<{ config: Record<string, string | number | boolean> }>('/api/onedrive/auth/exchange', { method: 'POST', body: JSON.stringify(body) }),
};

export function noteHeaders(storageId: string, syncFolder: string): HeadersInit {
  return { 'X-Storage-Id': storageId, 'X-Sync-Folder': syncFolder };
}

/** repo 树条目 identity（`path:` 前缀或 uuid）→ FileMeta.fileUuid */
function repoIdentityToFileUuid(identity: string): string | null {
  return identity.startsWith('path:') ? null : identity;
}

/** 内容 sha256（hex）——finalize 变更集携带，服务端校验 blob 存在但不做内容寻址校验 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 拉取 repo 二进制接口（GET /content），失败统一转 ApiError */
async function fetchRepoBinary(apiPath: string, params: URLSearchParams, headers: HeadersInit): Promise<ArrayBuffer> {
  const finalHeaders = new Headers(headers);
  const token = window.localStorage.getItem('synx-token');
  if (token) finalHeaders.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${apiPath}?${params}`, { headers: finalHeaders });
  if (response.status === 401) clearSession();
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(response.status, data.error || `请求失败 (${response.status})`, data.code);
  }
  return response.arrayBuffer();
}

export const notesApi = {
  /** 仓库基线：HEAD + 当前完整文件树（替代旧 /api/list 读 current.json） */
  head: (storageId: string, folder: string) => api<RepoHeadResponse>('/api/repository/head', { headers: noteHeaders(storageId, folder) }),

  list: async (storageId: string, folder: string): Promise<{ files: FileMeta[]; head: RepositoryHead | null }> => {
    const resp = await notesApi.head(storageId, folder);
    const files: FileMeta[] = resp.tree.map((f) => ({
      path: f.path,
      fileUuid: repoIdentityToFileUuid(f.identity),
      versionId: f.blobId,
      mtime: f.mtime,
      size: f.size,
      hash: f.hash,
      author: null,
    }));
    return { files, head: resp.head };
  },

  /**
   * 读指定提交下的文件内容（替代旧 /api/get 按版本记录读取）。
   * 不传 commitId 时取当前 HEAD。二进制直传，不 base64。
   */
  get: async (storageId: string, folder: string, path: string, fileUuid?: string | null, commitId?: string): Promise<{ content: ArrayBuffer; version: string | null }> => {
    let cid = commitId ?? null;
    if (!cid) {
      const head = await notesApi.head(storageId, folder);
      cid = head.head?.commitId ?? null;
    }
    if (!cid) throw new ApiError(404, '仓库还没有内容');
    const params = new URLSearchParams({ commitId: cid, path });
    const content = await fetchRepoBinary('/api/repository/content', params, noteHeaders(storageId, folder));
    return { content, version: cid };
  },

  /** 保存/新建：上传不可变 blob + 原子提交。HEAD 已被他人推进时抛 409（ApiError）。 */
  put: async (storageId: string, folder: string, body: { path: string; fileUuid?: string; mtime: number; content: string; author?: string; baseCommitId: string; baseGeneration: number; previousPath?: string }): Promise<{ head: RepositoryHead; blobId: string }> => {
    const bytes = new TextEncoder().encode(body.content);
    const hash = await sha256Hex(bytes);
    const blobHeaders = new Headers(noteHeaders(storageId, folder));
    blobHeaders.set('Content-Type', 'application/octet-stream');
    const token = window.localStorage.getItem('synx-token');
    if (token) blobHeaders.set('Authorization', `Bearer ${token}`);
    const blobParams = new URLSearchParams({ path: body.path, mtime: String(body.mtime) });
    const blobResp = await fetch(`/api/repository/blobs?${blobParams}`, { method: 'POST', headers: blobHeaders, body: bytes });
    if (blobResp.status === 401) clearSession();
    if (!blobResp.ok) {
      const data = await blobResp.json().catch(() => ({})) as { error?: string; code?: string };
      throw new ApiError(blobResp.status, data.error || `上传失败 (${blobResp.status})`, data.code);
    }
    const { blobId } = (await blobResp.json()) as { blobId: string };
    const change: RepoChange = {
      identity: body.fileUuid ?? `path:${body.path}`,
      operation: body.previousPath ? 'rename' : 'modify',
      path: body.path,
      previousPath: body.previousPath,
      blobId,
      hash,
      size: bytes.byteLength,
      mtime: body.mtime,
    };
    const final = await api<RepoFinalizeResponse>('/api/repository/commits/finalize', {
      method: 'POST',
      headers: noteHeaders(storageId, folder),
      body: JSON.stringify({
        baseCommitId: body.baseCommitId,
        baseGeneration: body.baseGeneration,
        author: body.author,
        message: '网页编辑',
        changes: [change],
      } satisfies RepoFinalizeRequest),
    });
    return { head: final.head, blobId };
  },

  /** 删除：以 delete 变更原子提交（git 删除语义，历史版本保留）。 */
  remove: async (storageId: string, folder: string, body: { path: string; fileUuid?: string; baseCommitId: string; baseGeneration: number }): Promise<{ head: RepositoryHead }> => {
    const change: RepoChange = { identity: body.fileUuid ?? `path:${body.path}`, operation: 'delete', path: body.path };
    const final = await api<RepoFinalizeResponse>('/api/repository/commits/finalize', {
      method: 'POST',
      headers: noteHeaders(storageId, folder),
      body: JSON.stringify({
        baseCommitId: body.baseCommitId,
        baseGeneration: body.baseGeneration,
        message: '网页删除',
        changes: [change],
      } satisfies RepoFinalizeRequest),
    });
    return { head: final.head };
  },

  /** 单文件历史：按 identity 从提交链派生（替代旧 /api/history 的版本记录列表） */
  history: (storageId: string, folder: string, path: string, fileUuid?: string | null) => {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    return api<RepoFileHistoryResponse>(`/api/repository/file-history?${params}`, { headers: noteHeaders(storageId, folder) });
  },

  /** 文件级恢复：把历史提交中的内容作为最新版本重新提交，不影响其他文件。 */
  restore: async (storageId: string, folder: string, body: { path: string; fileUuid?: string; commitId: string; author?: string; baseCommitId: string; baseGeneration: number }) => {
    const { content } = await notesApi.get(storageId, folder, body.path, body.fileUuid, body.commitId);
    return notesApi.put(storageId, folder, {
      path: body.path,
      fileUuid: body.fileUuid,
      mtime: Date.now(),
      content: new TextDecoder().decode(content),
      author: body.author,
      baseCommitId: body.baseCommitId,
      baseGeneration: body.baseGeneration,
    });
  },
};

/** 仓库级操作：全库提交时间线、任意两提交 diff、全库恢复、垃圾回收。 */
export const repoApi = {
  /** 提交时间线：从 HEAD 向更早翻页（cursor 从响应带回） */
  commits: (storageId: string, folder: string, cursor?: string) => {
    const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return api<RepoCommitsResponse>(`/api/repository/commits${params}`, { headers: noteHeaders(storageId, folder) });
  },

  /** 任意两提交 diff：返回 from(against) → to(target) 的变更集 */
  diff: (storageId: string, folder: string, to: string, from: string) =>
    api<RepoDiffResponse>(`/api/repository/commits/${encodeURIComponent(to)}/diff?against=${encodeURIComponent(from)}`, { headers: noteHeaders(storageId, folder) }),

  /** 全库恢复到历史提交（dryRun=true 只预览） */
  restore: (storageId: string, folder: string, body: RepoRestoreRequest) =>
    api<RepoRestoreResponse>('/api/repository/restore', { method: 'POST', headers: noteHeaders(storageId, folder), body: JSON.stringify(body) }),

  /** 垃圾回收：清理未引用内容对象与旧版本记录元数据 */
  gc: (storageId: string, folder: string) =>
    api<RepoGcResponse>('/api/repository/gc', { method: 'POST', headers: noteHeaders(storageId, folder), body: JSON.stringify({}) }),
};
