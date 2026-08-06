import { describe, expect, it } from 'vitest';
import type { StorageCredentialsResponse } from '@synx/shared';
import { OneDriveFs, S3Fs, WebDAVFs } from '@synx/storage-core';
import { createStorageFs } from './storageFs.js';

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

describe('plugin storageFs entry', () => {
  it.each([
    ['s3', S3Fs],
    ['webdav', WebDAVFs],
    ['onedrive', OneDriveFs],
  ] as const)('constructs the %s driver without Obsidian', (type, Driver) => {
    const input = credentials.find((item) => item.type === type)!;
    expect(createStorageFs(input)).toBeInstanceOf(Driver);
  });
});
