import { describe, expect, it, vi } from 'vitest';
import type { StorageCredentialsResponse } from '@synx/shared';
import { OneDriveFs, S3Fs, WebDAVFs, createStorageFs } from './index.js';

const credentials: StorageCredentialsResponse[] = [
  {
    storageId: 's3-id',
    type: 's3',
    config: {
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      accessKey: 'access-key',
      secretKey: 'secret-key',
      region: 'us-east-1',
      pathStyle: true,
    },
  },
  {
    storageId: 'webdav-id',
    type: 'webdav',
    config: {
      address: 'https://dav.example.com',
      username: 'user',
      password: 'password',
      authType: 'basic',
      remoteBaseDir: 'vault',
    },
  },
  {
    storageId: 'onedrive-id',
    type: 'onedrive',
    config: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: Date.now() + 3_600_000,
      clientId: 'client-id',
      authority: 'https://login.microsoftonline.com/consumers',
      remoteBaseDir: 'vault',
    },
  },
];

describe('createStorageFs', () => {
  it.each([
    ['s3', S3Fs],
    ['webdav', WebDAVFs],
    ['onedrive', OneDriveFs],
  ] as const)('constructs the %s driver from credentials', (type, Driver) => {
    const input = credentials.find((item) => item.type === type)!;
    expect(createStorageFs(input)).toBeInstanceOf(Driver);
  });

  it('passes a full updated credentials response to the OneDrive callback', async () => {
    const input = credentials.find((item) => item.type === 'onedrive')!;
    input.config.accessTokenExpiresAt = Date.now() - 1;
    const onCredentialsChanged = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 }));

    await createStorageFs(input, { onCredentialsChanged }).head('file');

    expect(onCredentialsChanged).toHaveBeenCalledWith(expect.objectContaining({
      storageId: 'onedrive-id',
      type: 'onedrive',
      config: expect.objectContaining({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
    }));
  });

  it.each(['s3', 'webdav'] as const)('accepts options without changing the %s factory behavior', (type) => {
    const input = credentials.find((item) => item.type === type)!;
    expect(createStorageFs(input, { onCredentialsChanged: vi.fn() })).toBeInstanceOf(type === 's3' ? S3Fs : WebDAVFs);
  });
});
