import { StorageRequestError } from '@synx/storage-core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { StorageError } from '../storage/factory.js';

export interface CanonicalStorageHttpError {
  status: ContentfulStatusCode;
  body: { error: string; code: 'STORAGE_ERROR' };
}

export function mapStorageHttpError(error: unknown): CanonicalStorageHttpError | null {
  if (error instanceof StorageError) {
    return { status: error.status as ContentfulStatusCode, body: { error: error.message, code: 'STORAGE_ERROR' } };
  }
  if (error instanceof StorageRequestError) {
    const status = (error.status >= 400 && error.status <= 599 ? error.status : 502) as ContentfulStatusCode;
    return { status, body: { error: 'storage request failed', code: 'STORAGE_ERROR' } };
  }
  return null;
}
