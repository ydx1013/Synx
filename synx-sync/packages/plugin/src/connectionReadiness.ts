import type { StorageSummaryItem, SynxPluginSettings } from './settings.js';
import { WorkerApiError } from './workerClient.js';

export interface LoginSession {
  serverUrl: string;
  jwt: string;
  userId: string | null;
}

interface LoginStorageDependencies {
  getCurrentSession: () => LoginSession;
  getCurrentStorage: () => Pick<SynxPluginSettings, 'storageId' | 'storageName'>;
  listStorages: (session: LoginSession) => Promise<StorageSummaryItem[]>;
  saveSettings: (patch: Partial<SynxPluginSettings>) => Promise<boolean | void>;
  notice: (message: string, timeout: number) => void;
}

function isSameLoginSession(left: LoginSession, right: LoginSession): boolean {
  return left.serverUrl === right.serverUrl && left.jwt === right.jwt && left.userId === right.userId;
}

export async function loadLoginStorages(session: LoginSession, deps: LoginStorageDependencies): Promise<void> {
  try {
    const storages = await deps.listStorages(session);
    if (!isSameLoginSession(session, deps.getCurrentSession())) return;
    const currentStorage = deps.getCurrentStorage();
    const selected = decideStorageSelection(currentStorage.storageId, storages);
    if (!isSameLoginSession(session, deps.getCurrentSession())) return;
    if (
      selected &&
      (currentStorage.storageId !== selected.id || currentStorage.storageName !== selected.name)
    ) {
      if (await deps.saveSettings({ storageId: selected.id, storageName: selected.name }) === false) return;
    } else if (
      !selected &&
      (currentStorage.storageId !== null || currentStorage.storageName !== null)
    ) {
      if (await deps.saveSettings({ storageId: null, storageName: null }) === false) return;
    }
  } catch (error) {
    if (!isSameLoginSession(session, deps.getCurrentSession())) return;
    if (error instanceof WorkerApiError && error.status === 401) {
      const saved = await deps.saveSettings({ jwt: '', userId: null, username: null, storageId: null, storageName: null });
      if (saved !== false) deps.notice('Synx: 登录已过期，请重新登录', 5000);
      return;
    }
    deps.notice('Synx: 暂时无法加载存储列表，请稍后重试', 5000);
  }
}

export function decideStorageSelection(
  currentStorageId: string | null,
  storages: readonly StorageSummaryItem[],
): StorageSummaryItem | null {
  const current = storages.find((storage) => storage.id === currentStorageId);
  if (current) return current;
  return storages.length === 1 ? storages[0] : null;
}

export function getSyncReadinessNotice(settings: {
  jwt: string;
  storageId: string | null;
  syncFolder: string;
}): string | null {
  if (!settings.jwt) return 'Synx: 请先登录';
  if (!settings.storageId) return 'Synx: 请选择主存储';
  if (!settings.syncFolder.trim()) return 'Synx: 请填写同步文件夹';
  return null;
}

export function getRepositoryReadinessNotice(
  settings: Parameters<typeof getSyncReadinessNotice>[0],
  clientReady: boolean,
): string | null {
  return getSyncReadinessNotice(settings) ?? (clientReady ? null : 'Synx: 同步客户端尚未就绪，请重试');
}
