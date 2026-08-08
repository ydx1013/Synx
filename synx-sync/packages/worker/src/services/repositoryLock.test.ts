import { describe, expect, it, vi } from 'vitest';
import {
  RepositoryLockConflictError,
  RepositoryLockReleaseError,
  forceClearRepositoryLock,
  normalizeRepositoryScope,
  withRepositoryLock,
} from './repositoryLock.js';

function makeLockDb() {
  const locks = new Map<string, { ownerToken: string; acquiredAt: number }>();
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
            locks.set(key, { ownerToken: String(statement.values[3]), acquiredAt: Number(statement.values[5]) });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE')) {
            const key = JSON.stringify(statement.values.slice(0, 3));
            const current = locks.get(key);
            if (sql.includes('acquired_at < ?')) {
              const changed = current && current.acquiredAt < Number(statement.values[3]) && locks.delete(key) ? 1 : 0;
              return { success: true, meta: { changes: changed } };
            }
            if (statement.values.length === 4 && current?.ownerToken !== String(statement.values[3])) {
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
  } as unknown as D1Database & { locks: Map<string, { ownerToken: string; acquiredAt: number }>; calls: Array<{ sql: string; values: unknown[] }> };
}

const scope = { userId: 'user-1', storageId: 'storage-1', syncFolder: ' /Vault//Notes/ ' };

describe('repository D1 coordination lock', () => {
  it('normalizes equivalent repository folders to one scope', () => {
    expect(normalizeRepositoryScope('/Vault//Notes/')).toBe('Vault/Notes');
    expect(normalizeRepositoryScope('Vault\\Notes')).toBe('Vault/Notes');
  });

  it('atomically rejects a competing owner while the lock is fresh', async () => {
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

  it('removes an abandoned lock after its lease expires', async () => {
    const db = makeLockDb();
    let releaseFirst!: () => void;
    const first = withRepositoryLock(db, scope, 'finalize', () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    await vi.waitFor(() => expect(db.locks.size).toBe(1));
    const key = [...db.locks.keys()][0];
    const lock = db.locks.get(key)!;
    db.locks.set(key, { ...lock, acquiredAt: Date.now() - 20 * 60_000 });

    await expect(withRepositoryLock(db, scope, 'gc', async () => 'recovered')).resolves.toBe('recovered');
    releaseFirst();
    await first;
  });

  it('retries transient owner-token release failures', async () => {
    const db = makeLockDb();
    const originalPrepare = db.prepare.bind(db);
    let deleteAttempts = 0;
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql) as any;
      if (!sql.includes('owner_token = ?')) return statement;
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
      if (sql.includes('owner_token = ?')) statement.run = async () => { throw new Error('D1 unavailable'); };
      return statement;
    }) as D1Database['prepare'];
    await expect(withRepositoryLock(db, scope, 'gc', async () => 'ok')).rejects.toBeInstanceOf(RepositoryLockReleaseError);
  });

  it('keeps the original task error when release also fails', async () => {
    const db = makeLockDb();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql) as any;
      if (sql.includes('owner_token = ?')) statement.run = async () => { throw new Error('D1 unavailable'); };
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
      db.locks.set(key, { ownerToken: 'new-owner', acquiredAt: Date.now() });
    });
    expect([...db.locks.values()].map((lock) => lock.ownerToken)).toEqual(['new-owner']);

    const deleteCall = db.calls.find(({ sql }) => sql.includes('owner_token = ?'))!;
    expect(deleteCall.sql).toContain('owner_token = ?');
    expect(deleteCall.values[3]).toEqual(expect.any(String));
  });
});
