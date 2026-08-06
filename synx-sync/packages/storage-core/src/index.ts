import type { StorageCredentialsResponse, WorkerFs } from '@synx/shared';
import { OneDriveFs } from './onedriveFs.js';
import { S3Fs } from './s3Fs.js';
import { WebDAVFs } from './webdavFs.js';

export * from './connectivity.js';
export * from './onedriveAuth.js';
export * from './onedriveFs.js';
export * from './s3Fs.js';
export * from './storageRequestError.js';
export * from './webdavFs.js';

export interface CreateStorageFsOptions {
  onCredentialsChanged?: (credentials: StorageCredentialsResponse) => void | Promise<void>;
}

export function createStorageFs(credentials: StorageCredentialsResponse, options: CreateStorageFsOptions = {}): WorkerFs {
  switch (credentials.type) {
    case 's3':
      return new S3Fs(credentials.config);
    case 'webdav':
      return new WebDAVFs(credentials.config);
    case 'onedrive':
      return new OneDriveFs(credentials.config, {
        onConfigChanged: options.onCredentialsChanged
          ? (config) => options.onCredentialsChanged!({ ...credentials, config })
          : undefined,
      });
  }
}
