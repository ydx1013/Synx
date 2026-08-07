import { describe, expect, it, vi } from 'vitest';
import { WorkerApiError } from './workerClient.js';
import {
  decideStorageSelection,
  getRepositoryReadinessNotice,
  getSyncReadinessNotice,
  loadLoginStorages,
  type LoginSession,
} from './connectionReadiness.js';

const storages = [
  { id: 'storage-1', name: 'Primary', type: 's3' as const },
  { id: 'storage-2', name: 'Backup', type: 'webdav' as const },
];

describe('decideStorageSelection', () => {
  it('当前存储仍有效时保留该存储', () => {
    expect(decideStorageSelection('storage-2', storages)).toEqual(storages[1]);
  });

  it('当前选择为空且只有一个存储时自动选择唯一存储', () => {
    expect(decideStorageSelection(null, storages.slice(0, 1))).toEqual(storages[0]);
  });

  it('当前选择失效且只有一个存储时自动选择唯一存储', () => {
    expect(decideStorageSelection('deleted-storage', storages.slice(0, 1))).toEqual(storages[0]);
  });

  it('当前选择为空且有多个存储时不自动选择', () => {
    expect(decideStorageSelection(null, storages)).toBeNull();
  });

  it('当前选择失效且有多个存储时不自动选择', () => {
    expect(decideStorageSelection('deleted-storage', storages)).toBeNull();
  });
});

describe('loadLoginStorages', () => {
  const oldSession: LoginSession = { serverUrl: 'https://old.example', jwt: 'old-jwt', userId: 'old-user' };
  const newSession: LoginSession = { serverUrl: 'https://new.example', jwt: 'new-jwt', userId: 'new-user' };

  it('401 时仅对仍为当前的会话清理登录与存储并提示过期', async () => {
    const saveSettings = vi.fn(async () => undefined);
    const notice = vi.fn();

    await loadLoginStorages(oldSession, {
      getCurrentSession: () => oldSession,
      getCurrentStorage: () => ({ storageId: 'storage-1', storageName: 'Primary' }),
      listStorages: async () => { throw new WorkerApiError(401, 'unauthorized'); },
      saveSettings,
      notice,
    });

    expect(saveSettings).toHaveBeenCalledWith({ jwt: '', userId: null, username: null, storageId: null, storageName: null });
    expect(notice).toHaveBeenCalledWith('Synx: 登录已过期，请重新登录', 5000);
    expect(notice).not.toHaveBeenCalledWith(expect.stringContaining('登录成功'), expect.anything());
  });

  it('401 清理排队期间会话变化时不提示过期', async () => {
    const notice = vi.fn();

    await loadLoginStorages(oldSession, {
      getCurrentSession: () => oldSession,
      getCurrentStorage: () => ({ storageId: 'storage-1', storageName: 'Primary' }),
      listStorages: async () => { throw new WorkerApiError(401, 'unauthorized'); },
      saveSettings: async () => false,
      notice,
    });

    expect(notice).not.toHaveBeenCalled();
  });

  it('非 401 失败保留会话和已有存储并安全提示', async () => {
    const saveSettings = vi.fn(async () => undefined);
    const notice = vi.fn();

    await loadLoginStorages(oldSession, {
      getCurrentSession: () => oldSession,
      getCurrentStorage: () => ({ storageId: 'storage-1', storageName: 'Primary' }),
      listStorages: async () => { throw new TypeError('network details'); },
      saveSettings,
      notice,
    });

    expect(saveSettings).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('Synx: 暂时无法加载存储列表，请稍后重试', 5000);
  });

  it('两个请求乱序时静默丢弃旧账号响应', async () => {
    let releaseOld!: (value: typeof storages) => void;
    const oldResponse = new Promise<typeof storages>((resolve) => { releaseOld = resolve; });
    let currentSession = oldSession;
    const saveSettings = vi.fn(async () => undefined);
    const deps = {
      getCurrentSession: () => currentSession,
      getCurrentStorage: () => ({ storageId: null, storageName: null }),
      listStorages: (session: LoginSession) => session === oldSession ? oldResponse : Promise.resolve([storages[1]]),
      saveSettings,
      notice: vi.fn(),
    };

    const oldRequest = loadLoginStorages(oldSession, deps);
    currentSession = newSession;
    await loadLoginStorages(newSession, deps);
    releaseOld(storages);
    await oldRequest;

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({ storageId: 'storage-2', storageName: 'Backup' });
  });

  it.each([
    ['登出', { serverUrl: oldSession.serverUrl, jwt: '', userId: null }],
    ['换账号', newSession],
  ] as const)('请求期间%s时不保存也不清除新会话设置', async (_label, changedSession) => {
    let release!: (value: typeof storages) => void;
    const response = new Promise<typeof storages>((resolve) => { release = resolve; });
    let currentSession: LoginSession = oldSession;
    const saveSettings = vi.fn(async () => undefined);
    const request = loadLoginStorages(oldSession, {
      getCurrentSession: () => currentSession,
      getCurrentStorage: () => ({ storageId: 'storage-1', storageName: 'Primary' }),
      listStorages: () => response,
      saveSettings,
      notice: vi.fn(),
    });

    currentSession = changedSession;
    release([]);
    await request;

    expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe('getRepositoryReadinessNotice', () => {
  it.each([
    [{ jwt: '', storageId: null, syncFolder: '' }, false, 'Synx: 请先登录'],
    [{ jwt: 'jwt', storageId: null, syncFolder: '' }, false, 'Synx: 请选择主存储'],
    [{ jwt: 'jwt', storageId: 'storage-1', syncFolder: ' ' }, false, 'Synx: 请填写同步文件夹'],
    [{ jwt: 'jwt', storageId: 'storage-1', syncFolder: 'vault/' }, false, 'Synx: 同步客户端尚未就绪，请重试'],
    [{ jwt: 'jwt', storageId: 'storage-1', syncFolder: 'vault/' }, true, null],
  ] as const)('按配置与客户端状态返回准确提示', (settings, clientReady, expected) => {
    expect(getRepositoryReadinessNotice(settings, clientReady)).toBe(expected);
  });
});

describe('getSyncReadinessNotice', () => {
  it('jwt 缺失时提示先登录', () => {
    expect(getSyncReadinessNotice({ jwt: '', storageId: null, syncFolder: '' })).toBe('Synx: 请先登录');
  });

  it('storageId 缺失时提示选择主存储', () => {
    expect(getSyncReadinessNotice({ jwt: 'jwt', storageId: null, syncFolder: '' })).toBe('Synx: 请选择主存储');
  });

  it('同步文件夹为空时提示填写同步文件夹', () => {
    expect(getSyncReadinessNotice({ jwt: 'jwt', storageId: 'storage-1', syncFolder: '  ' })).toBe('Synx: 请填写同步文件夹');
  });

  it('所有前置条件满足时无需提示', () => {
    expect(getSyncReadinessNotice({ jwt: 'jwt', storageId: 'storage-1', syncFolder: 'vault/' })).toBeNull();
  });
});
