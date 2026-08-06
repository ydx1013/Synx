import { describe, expect, it, vi } from 'vitest';
import {
  RepositoryLockConflictError,
  RepositoryLockReleaseError,
  forceClearRepositoryLock,
  normalizeRepositoryScope,
  withRepositoryLock,
} from './repositoryLock.js';

function makeLockDb() {
  const locks = new Map<string, string>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          calls.push({ sql, values });
          return statement;
        },
        async run() {
          if (sql.startsWith('INSERT OR IGNORE')) {
            const key = JSON.stringify(statement.values.slice(0, 3));
            if (locks.has(key)) return { success: true, meta: { changes: 0 } };
            locks.set(key, String(statement.values[3]));
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE')) {
            const key = JSON.stringify(statement.values.slice(0, 3));
            if (statement.values.length === 4 && locks.get(key) !== String(statement.values[3])) {
              return { success: true, meta: { changes: 0 } };
            }
            const changed = locks.delete(key) ? 1 : 0;
            return { success: true, meta: { changes: changed } };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
      return statement;
    },
    locks,
    calls,
  } as unknown as D1Database & { locks: Map<string, string>; calls: Array<{ sql: string; values: unknown[] }> };
}

const scope = { userId: 'user-1', storageId: 'storage-1', syncFolder: ' /Vault//Notes/ ' };

describe('repository D1 coordination lock', () => {
  it('normalizes equivalent repository folders to one scope', () => {
    expect(normalizeRepositoryScope('/Vault//Notes/')).toBe('Vault/Notes');
    expect(normalizeRepositoryScope('Vault\\Notes')).toBe('Vault/Notes');
  });

  it('atomically rejects a competing owner and keeps the lock without TTL takeover', async () => {
    const db = makeLockDb();
    let releaseFirst!: () => void;
    const first = withRepositoryLock(db, scope, 'finalize', () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    await vi.waitFor(() => expect(db.locks.size).toBe(1));

    await expect(withRepositoryLock(db, { ...scope, syncFolder: 'Vault/Notes' }, 'gc', async () => undefined))
      .rejects.toBeInstanceOf(RepositoryLockConflictError);
    expect(db.locks.size).toBe(1);
    expect(db.calls.some(({ sql }) => /expires|ttl/i.test(sql))).toBe(false);

    releaseFirst();
    await first;
  });

  it('retries transient owner-token release failures', async () => {
    const db = makeLockDb();
    const originalPrepare = db.prepare.bind(db);
    let deleteAttempts = 0;
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql) as any;
      if (!sql.startsWith('DELETE')) return statement;
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        deleteAttempts++;
        if (deleteAttempts < 3) throw new Error('D1 transient');
        return originalRun();
      };
      return statement;
    }) as D1Database['prepare'];

    await expect(withRepositoryLock(db, scope, 'finalize', async () => 'ok')).resolves.toBe('ok');
    expect(deleteAttempts).toBe(3);
    expect(db.locks.size).toBe(0);
  });

  it('returns a release error when a successful task cannot release its lock', async () => {
    const db = makeLockDb();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql) as any;
      if (sql.startsWith('DELETE')) statement.run = async () => { throw new Error('D1 unavailable'); };
      return statement;
    }) as D1Database['prepare'];
    await expect(withRepositoryLock(db, scope, 'gc', async () => 'ok')).rejects.toBeInstanceOf(RepositoryLockReleaseError);
  });

  it('keeps the original task error when release also fails', async () => {
    const db = makeLockDb();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql) as any;
      if (sql.startsWith('DELETE')) statement.run = async () => { throw new Error('D1 unavailable'); };
      return statement;
    }) as D1Database['prepare'];
    const taskError = new Error('task failed');
    await expect(withRepositoryLock(db, scope, 'gc', async () => { throw taskError; })).rejects.toBe(taskError);
  });

  it('force clears only the exact normalized user-owned scope', async () => {
    const db = makeLockDb();
    let release!: () => void;
    const active = withRepositoryLock(db, scope, 'gc', () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(db.locks.size).toBe(1));
    await expect(forceClearRepositoryLock(db, { ...scope, userId: 'other-user' })).resolves.toBe(false);
    await expect(forceClearRepositoryLock(db, { ...scope, syncFolder: 'Vault\\Notes' })).resolves.toBe(true);
    release();
    await active;
  });

  it('releases only with its owner token and always releases in finally', async () => {
    const db = makeLockDb();
    const failure = new Error('write failed');
    await expect(withRepositoryLock(db, scope, 'restore', async () => { throw failure; })).rejects.toBe(failure);
    expect(db.locks.size).toBe(0);

    await withRepositoryLock(db, scope, 'finalize', async () => {
      const key = [...db.locks.keys()][0];
      db.locks.set(key, 'new-owner');
    });
    expect([...db.locks.values()]).toEqual(['new-owner']);

    const deleteCall = db.calls.find(({ sql }) => sql.startsWith('DELETE'))!;
    expect(deleteCall.sql).toContain('owner_token = ?');
    expect(deleteCall.values[3]).toEqual(expect.any(String));
  });
});
