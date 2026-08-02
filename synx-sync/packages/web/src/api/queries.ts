import type {
  AuthResponse, FileMeta, GetResponse, HistoryResponse, ListResponse, MeResponse,
  PreferencesResponse, StorageListResponse, StorageSummary, UpdatePreferencesRequest,
} from '@synx/shared';
import { api } from './client';

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
  config: Record<string, string>;
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

export function noteHeaders(storageId: string, syncFolder: string): HeadersInit {
  return { 'X-Storage-Id': storageId, 'X-Sync-Folder': syncFolder };
}

export const notesApi = {
  list: (storageId: string, folder: string) => api<ListResponse>('/api/list', { headers: noteHeaders(storageId, folder) }),
  get: (storageId: string, folder: string, path: string, fileUuid?: string | null, version?: string) => {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    if (version) params.set('version', version);
    return api<GetResponse>(`/api/get?${params}`, { headers: noteHeaders(storageId, folder) });
  },
  put: (storageId: string, folder: string, body: unknown) => api<{ version: FileMeta }>('/api/put', { method: 'POST', headers: noteHeaders(storageId, folder), body: JSON.stringify(body) }),
  remove: (storageId: string, folder: string, body: unknown) => api<{ ok: true }>('/api/file', { method: 'DELETE', headers: noteHeaders(storageId, folder), body: JSON.stringify(body) }),
  history: (storageId: string, folder: string, path: string, fileUuid?: string | null) => {
    const params = new URLSearchParams({ path });
    if (fileUuid) params.set('fileUuid', fileUuid);
    return api<HistoryResponse>(`/api/history?${params}`, { headers: noteHeaders(storageId, folder) });
  },
  rollback: (storageId: string, folder: string, body: unknown) => api<{ version: FileMeta }>('/api/rollback', { method: 'POST', headers: noteHeaders(storageId, folder), body: JSON.stringify(body) }),
};
