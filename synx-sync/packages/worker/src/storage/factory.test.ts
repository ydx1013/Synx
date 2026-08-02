import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptString } from '../auth/crypto.js';
import { getFs, getStorageRow, decryptS3Config, decryptStorageConfig, StorageError } from './factory.js';
import { makeD1Mock, makeKvMock, makeEnv } from '../test/helpers.js';

const ENCRYPTION_KEY = 'test-encryption-key';
const USER = 'user-1';
const OTHER = 'user-2';
const STORAGE_ID = 's-1';

const s3Config = {
  endpoint: 'https://s3.example.com',
  bucket: 'b',
  accessKey: 'ak',
  secretKey: 'sk',
  region: 'us-east-1',
  pathStyle: true,
};

const webdavConfig = {
  address: 'https://dav.example.com',
  username: 'user',
  password: 'pass',
  authType: 'basic' as const,
  remoteBaseDir: 'my-vault',
};

const onedriveConfig = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  accessTokenExpiresAt: Date.now() + 3600_000,
  clientId: 'test-client-id',
  authority: 'https://login.microsoftonline.com/consumers',
  remoteBaseDir: 'my-vault',
};

function makeStorageRow(overrides: Partial<{
  id: string;
  user_id: string;
  name: string;
  type: string;
  config: string;
  created_at: number;
}> = {}) {
  return {
    id: STORAGE_ID,
    user_id: USER,
    name: 'mine',
    type: 's3',
    config: '',
    created_at: 1,
    ...overrides,
  };
}

describe('getStorageRow', () => {
  it('returns row when storage exists and belongs to user', async () => {
    const db = makeD1Mock({ first: makeStorageRow() });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });
    const row = await getStorageRow(env, USER, STORAGE_ID);
    expect(row.id).toBe(STORAGE_ID);
  });

  it('throws StorageError(404) when not found', async () => {
    const db = makeD1Mock({ first: null });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });
    await expect(getStorageRow(env, USER, 'nope')).rejects.toMatchObject({
      status: 404,
      name: 'StorageError',
    });
  });

  it('throws StorageError(403) when belongs to other user', async () => {
    const db = makeD1Mock({ first: makeStorageRow({ user_id: OTHER }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });
    await expect(getStorageRow(env, USER, STORAGE_ID)).rejects.toMatchObject({
      status: 403,
      name: 'StorageError',
    });
  });
});

describe('decryptS3Config', () => {
  it('decrypts encrypted s3 config', async () => {
    const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
    const row = makeStorageRow({ config: encrypted });
    const cfg = await decryptS3Config(row, ENCRYPTION_KEY);
    expect(cfg).toEqual(s3Config);
  });

  it('throws StorageError(400) when type is not s3', async () => {
    const row = makeStorageRow({ type: 'onedrive', config: 'x' });
    await expect(decryptS3Config(row, ENCRYPTION_KEY)).rejects.toMatchObject({
      status: 400,
      name: 'StorageError',
    });
  });
});

describe('getFs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
  });

  it('returns S3Fs instance with decrypted config', async () => {
    const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
    const db = makeD1Mock({ first: makeStorageRow({ config: encrypted }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });

    const { fs, row, type } = await getFs(env, USER, STORAGE_ID);
    expect(type).toBe('s3');
    expect(row.id).toBe(STORAGE_ID);
    // S3Fs 内部 base 已正确构造（path-style）
    // 通过执行一次 head 调用确认 fs 可用
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    );
    const exists = await fs.head('any-key');
    expect(exists).toBe(true);
  });

  it('throws 403 when storage belongs to other user', async () => {
    const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
    const db = makeD1Mock({ first: makeStorageRow({ user_id: OTHER, config: encrypted }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });

    await expect(getFs(env, USER, STORAGE_ID)).rejects.toBeInstanceOf(StorageError);
    await expect(getFs(env, USER, STORAGE_ID)).rejects.toMatchObject({ status: 403 });
  });

  it('throws 404 when storage not found', async () => {
    const db = makeD1Mock({ first: null });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });
    await expect(getFs(env, USER, 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('throws when config cannot be decrypted (wrong key)', async () => {
    const encrypted = await encryptString(JSON.stringify(s3Config), 'other-key');
    const db = makeD1Mock({ first: makeStorageRow({ config: encrypted }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });

    await expect(getFs(env, USER, STORAGE_ID)).rejects.toThrow();
  });
});

describe('decryptStorageConfig', () => {
  it('decrypts encrypted s3 config', async () => {
    const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
    const row = makeStorageRow({ config: encrypted, type: 's3' });
    const cfg = await decryptStorageConfig(row, ENCRYPTION_KEY);
    expect(cfg).toEqual(s3Config);
  });

  it('decrypts encrypted webdav config', async () => {
    const encrypted = await encryptString(JSON.stringify(webdavConfig), ENCRYPTION_KEY);
    const row = makeStorageRow({ config: encrypted, type: 'webdav' });
    const cfg = await decryptStorageConfig(row, ENCRYPTION_KEY);
    expect(cfg).toEqual(webdavConfig);
  });

  it('decrypts encrypted onedrive config', async () => {
    const encrypted = await encryptString(JSON.stringify(onedriveConfig), ENCRYPTION_KEY);
    const row = makeStorageRow({ config: encrypted, type: 'onedrive' });
    const cfg = await decryptStorageConfig(row, ENCRYPTION_KEY);
    expect(cfg).toEqual(onedriveConfig);
  });
});

describe('getFs (webdav)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
  });

  it('returns WebDAVFs instance with decrypted config', async () => {
    const encrypted = await encryptString(JSON.stringify(webdavConfig), ENCRYPTION_KEY);
    const db = makeD1Mock({ first: makeStorageRow({ config: encrypted, type: 'webdav' }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });

    const { fs, row, type } = await getFs(env, USER, STORAGE_ID);
    expect(type).toBe('webdav');
    expect(row.id).toBe(STORAGE_ID);

    // WebDAVFs head 调用确认实例可用
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const exists = await fs.head('any-key');
    expect(exists).toBe(true);
  });

  it('throws 400 for unsupported storage type', async () => {
    const encrypted = await encryptString(JSON.stringify(s3Config), ENCRYPTION_KEY);
    const db = makeD1Mock({ first: makeStorageRow({ config: encrypted, type: 'dropbox' }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });

    await expect(getFs(env, USER, STORAGE_ID)).rejects.toMatchObject({
      status: 400,
      name: 'StorageError',
    });
  });
});

describe('getFs (onedrive)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
  });

  it('returns OneDriveFs instance with decrypted config', async () => {
    const encrypted = await encryptString(JSON.stringify(onedriveConfig), ENCRYPTION_KEY);
    const db = makeD1Mock({ first: makeStorageRow({ config: encrypted, type: 'onedrive' }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });

    const { fs, row, type } = await getFs(env, USER, STORAGE_ID);
    expect(type).toBe('onedrive');
    expect(row.id).toBe(STORAGE_ID);

    // OneDriveFs head 调用确认实例可用
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const exists = await fs.head('any-key');
    expect(exists).toBe(true);
  });

  it('throws 404 when storage not found', async () => {
    const db = makeD1Mock({ first: null });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });
    await expect(getFs(env, USER, 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('throws 403 when storage belongs to other user', async () => {
    const encrypted = await encryptString(JSON.stringify(onedriveConfig), ENCRYPTION_KEY);
    const db = makeD1Mock({ first: makeStorageRow({ user_id: OTHER, config: encrypted, type: 'onedrive' }) });
    const env = makeEnv({ DB: db, ENCRYPTION_KEY });
    await expect(getFs(env, USER, STORAGE_ID)).rejects.toMatchObject({ status: 403 });
  });
});
