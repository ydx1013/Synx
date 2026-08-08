export interface RepositoryLockScope {
  userId: string;
  storageId: string;
  syncFolder: string;
}

export class RepositoryLockConflictError extends Error {
  constructor() {
    super('repository operation is already in progress');
    this.name = 'RepositoryLockConflictError';
  }
}

export class RepositoryLockReleaseError extends Error {
  readonly status = 503;

  constructor() {
    super('repository operation completed but its coordination lock could not be released');
    this.name = 'RepositoryLockReleaseError';
  }
}

export function normalizeRepositoryScope(syncFolder: string): string {
  return syncFolder.trim().replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

const RELEASE_ATTEMPTS = 3;
const LOCK_LEASE_MS = 15 * 60_000;

async function releaseRepositoryLock(db: D1Database, scope: RepositoryLockScope, ownerToken: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    try {
      await db.prepare(
        'DELETE FROM repository_locks WHERE user_id = ? AND storage_id = ? AND sync_folder = ? AND owner_token = ?',
      ).bind(scope.userId, scope.storageId, scope.syncFolder, ownerToken).run();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < RELEASE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  console.error('repository lock release failed', lastError);
  throw new RepositoryLockReleaseError();
}

export async function forceClearRepositoryLock(db: D1Database, scope: RepositoryLockScope): Promise<boolean> {
  const result = await db.prepare(
    'DELETE FROM repository_locks WHERE user_id = ? AND storage_id = ? AND sync_folder = ?',
  ).bind(scope.userId, scope.storageId, normalizeRepositoryScope(scope.syncFolder)).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function withRepositoryLock<T>(
  db: D1Database,
  scope: RepositoryLockScope,
  operation: string,
  task: () => Promise<T>,
): Promise<T> {
  const normalizedScope = { ...scope, syncFolder: normalizeRepositoryScope(scope.syncFolder) };
  const ownerToken = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    'DELETE FROM repository_locks WHERE user_id = ? AND storage_id = ? AND sync_folder = ? AND acquired_at < ?',
  ).bind(normalizedScope.userId, normalizedScope.storageId, normalizedScope.syncFolder, now - LOCK_LEASE_MS).run();
  const acquired = await db.prepare(
    'INSERT OR IGNORE INTO repository_locks (user_id, storage_id, sync_folder, owner_token, operation, acquired_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(normalizedScope.userId, normalizedScope.storageId, normalizedScope.syncFolder, ownerToken, operation, Date.now()).run();
  if (!acquired.meta.changes) throw new RepositoryLockConflictError();

  let result: T;
  try {
    result = await task();
  } catch (taskError) {
    try {
      await releaseRepositoryLock(db, normalizedScope, ownerToken);
    } catch {
      // 原 task error 优先；释放失败已明确记录。
    }
    throw taskError;
  }
  await releaseRepositoryLock(db, normalizedScope, ownerToken);
  return result;
}
