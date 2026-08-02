import type {
  AuthResponse, FileMeta, HistoryResponse, ListResponse, MeResponse,
  PreferencesResponse, StorageListResponse, StorageSummary, UpdatePreferencesRequest,
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

export const notesApi = {
  list: (storageId: string, folder: string) => api<ListResponse>('/api/list', { headers: noteHeaders(storageId, folder) }),
  /**
   * GET /api/get 返回「原始二进制 body + X-Synx-Version 头」（worker 不做 base64，
   * 避免大文件 CPU 超限 1102）。这里直接 fetch 读取 arrayBuffer + 解析版本头。
   */
  get: async (storageId: string, folder: string, path: string, fileUuid?: string | null, version?: string): Promise<{ content: ArrayBuffer; version: string | null }> => {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    if (version) params.set('version', version);
    const headers = new Headers(noteHeaders(storageId, folder));
    const token = window.localStorage.getItem('synx-token');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api/get?${params}`, { headers });
    if (response.status === 401) clearSession();
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
      throw new ApiError(response.status, data.error || `请求失败 (${response.status})`, data.code);
    }
    const content = await response.arrayBuffer();
    return { content, version: response.headers.get('X-Synx-Version') };
  },
  /** POST /api/put?path=&mtime=&...  body=原始二进制 */
  put: async (storageId: string, folder: string, body: { path: string; fileUuid?: string; mtime: number; content: string; author?: string; baseVersionId?: string }) => {
    const params = new URLSearchParams({ path: body.path, mtime: String(body.mtime) });
    if (body.fileUuid) params.set('fileUuid', body.fileUuid);
    if (body.author) params.set('author', body.author);
    if (body.baseVersionId) params.set('baseVersionId', body.baseVersionId);
    const headers = new Headers(noteHeaders(storageId, folder));
    headers.set('Content-Type', 'application/octet-stream');
    const token = window.localStorage.getItem('synx-token');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api/put?${params}`, { method: 'POST', headers, body: new TextEncoder().encode(body.content) });
    if (response.status === 401) clearSession();
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
      throw new ApiError(response.status, data.error || `请求失败 (${response.status})`, data.code);
    }
    return response.json() as Promise<{ version: FileMeta }>;
  },
  remove: (storageId: string, folder: string, body: unknown) => api<{ ok: true }>('/api/file', { method: 'DELETE', headers: noteHeaders(storageId, folder), body: JSON.stringify(body) }),
  history: (storageId: string, folder: string, path: string, fileUuid?: string | null) => {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    return api<HistoryResponse>(`/api/history?${params}`, { headers: noteHeaders(storageId, folder) });
  },
  rollback: (storageId: string, folder: string, body: unknown) => api<{ version: FileMeta }>('/api/rollback', { method: 'POST', headers: noteHeaders(storageId, folder), body: JSON.stringify(body) }),
};
