import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signJwt } from '../auth/jwt.js';
import { makeEnv } from '../test/helpers.js';

const calls = vi.hoisted(() => ({ operations: [] as string[], clearScopes: [] as Array<{ userId: string; storageId: string; syncFolder: string }> }));

vi.mock('../services/repositoryLock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/repositoryLock.js')>();
  return {
    ...actual,
    withRepositoryLock: vi.fn(async (_db, _scope, operation: string, task: () => Promise<unknown>) => {
      calls.operations.push(operation);
      return task();
    }),
    forceClearRepositoryLock: vi.fn(async (_db, scope) => {
      calls.clearScopes.push(scope);
      return true;
    }),
  };
});

vi.mock('../storage/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/factory.js')>();
  return { ...actual, getFs: vi.fn(async () => ({ fs: {}, type: 'webdav' })) };
});

vi.mock('../services/retention.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/retention.js')>();
  return { ...actual, getRetentionPolicy: vi.fn(async () => ({ keepAllDays: 30, dailyDays: 90, weeklyDays: 365, maxFileSizeBytes: 20_971_520 })) };
});

vi.mock('../services/repositoryService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/repositoryService.js')>();
  const head = { version: 1 as const, commitId: 'c1', generation: 1, updatedAt: 1 };
  const commit = { commitId: 'c1', parentCommitId: null, generation: 1, createdAt: 1, kind: 'initial' as const, changes: [], checkpointId: 'c1' };
  return {
    ...actual,
    initRepository: vi.fn(async () => ({ head, commit })),
    finalizeCommit: vi.fn(async () => ({ head, commit })),
    restoreRepository: vi.fn(async (input: { dryRun?: boolean }) => input.dryRun ? { preview: { added: 0, modified: 0, renamed: 0, deleted: 0, changes: [] } } : { head, commit }),
    gcRepository: vi.fn(async () => ({ scannedCommits: 0, referencedBlobs: 0, candidates: 0, deleted: 0, failed: 0, deletedCommits: 0, more: false })),
  };
});

import app from '../index.js';

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-Storage-Id': 'storage-1',
  'X-Sync-Folder': '/Vault//',
});

let token: string;
beforeAll(async () => { token = await signJwt({ sub: 'user-1' }, 'test-jwt-secret-min-32-characters-pls!'); });
beforeEach(() => { calls.operations.length = 0; calls.clearScopes.length = 0; });

describe('repository mutation route coordination', () => {
  it.each([
    ['/api/repository/init', {}, 'init'],
    ['/api/repository/commits/finalize', { baseCommitId: 'c0', baseGeneration: 0, changes: [{}] }, 'finalize'],
    ['/api/repository/restore', { toCommitId: 'c0' }, 'restore'],
    ['/api/repository/gc', {}, 'gc'],
  ])('locks %s as %s', async (path, body, operation) => {
    const response = await app.request(path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) }, makeEnv());
    expect(response.status).toBeLessThan(400);
    expect(calls.operations).toEqual([operation]);
  });

  it('requires exact force confirmation before clearing a normalized owned scope', async () => {
    const rejected = await app.request('/api/repository/lock/clear', {
      method: 'POST', headers: headers(token), body: JSON.stringify({ force: true, confirm: 'wrong' }),
    }, makeEnv());
    expect(rejected.status).toBe(400);
    expect(calls.clearScopes).toEqual([]);

    const cleared = await app.request('/api/repository/lock/clear', {
      method: 'POST', headers: headers(token), body: JSON.stringify({ force: true, confirm: 'CLEAR storage-1/Vault' }),
    }, makeEnv());
    expect(cleared.status).toBe(200);
    expect(calls.clearScopes).toEqual([{ userId: 'user-1', storageId: 'storage-1', syncFolder: 'Vault' }]);
  });

  it('does not lock dry-run restore because it cannot mutate the repository', async () => {
    const response = await app.request('/api/repository/restore', {
      method: 'POST', headers: headers(token), body: JSON.stringify({ toCommitId: 'c0', dryRun: true }),
    }, makeEnv());
    expect(response.status).toBe(200);
    expect(calls.operations).toEqual([]);
  });
});
