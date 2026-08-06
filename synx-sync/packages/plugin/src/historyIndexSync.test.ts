import { describe, expect, it, vi } from 'vitest';
import type { RepoCommit } from '@synx/shared';
import type { RepositoryClient } from './repositoryClient.js';
import { syncHistoryIndex } from './historyIndexSync.js';

function commit(commitId: string, parentCommitId: string | null): RepoCommit {
  return {
    commitId,
    parentCommitId,
    generation: Number(commitId.slice(1)),
    createdAt: 1,
    author: 'device',
    message: 'sync',
    kind: 'sync',
    changeCount: 0,
    checkpointId: null,
    changes: [],
  };
}

function client(head: string | null, read: (commitId: string) => Promise<RepoCommit | null>) {
  return {
    repoHead: vi.fn().mockResolvedValue({ head: head ? { commitId: head } : null, tree: [] }),
    repoCommit: vi.fn(read),
  } as unknown as RepositoryClient;
}

function writer(reads: string[]) {
  return {
    syncFromHead: vi.fn(async (head: string, readCommit: (commitId: string) => Promise<RepoCommit | null>) => {
      let cursor: string | null = head;
      while (cursor) {
        reads.push(cursor);
        const current = await readCommit(cursor);
        if (!current) throw new Error('missing commit');
        cursor = current.parentCommitId;
      }
      return { indexed: reads.length, rebuilt: false };
    }),
  };
}

describe('syncHistoryIndex', () => {
  it('preferred 整轮成功时 HEAD 和 commit 链都不调用 Worker', async () => {
    const chain = new Map([['c2', commit('c2', 'c1')], ['c1', commit('c1', null)]]);
    const preferred = client('c2', async (id) => chain.get(id) ?? null);
    const worker = client('c2', async (id) => chain.get(id) ?? null);
    const reads: string[] = [];

    await syncHistoryIndex(preferred, worker, writer(reads), new AbortController().signal);

    expect(reads).toEqual(['c2', 'c1']);
    expect(preferred.repoHead).toHaveBeenCalledOnce();
    expect(preferred.repoCommit).toHaveBeenCalledTimes(2);
    expect(worker.repoHead).not.toHaveBeenCalled();
    expect(worker.repoCommit).not.toHaveBeenCalled();
  });

  it('preferred 中途网络不兼容时从 Worker repoHead 重跑整轮', async () => {
    const chain = new Map([['c3', commit('c3', 'c2')], ['c2', commit('c2', 'c1')], ['c1', commit('c1', null)]]);
    const preferred = client('c3', async (id) => {
      if (id === 'c2') throw new TypeError('Failed to fetch');
      return chain.get(id) ?? null;
    });
    const worker = client('c3', async (id) => chain.get(id) ?? null);
    const reads: string[] = [];

    await syncHistoryIndex(preferred, worker, writer(reads), new AbortController().signal);

    expect(reads).toEqual(['c3', 'c2', 'c3', 'c2', 'c1']);
    expect(worker.repoHead).toHaveBeenCalledOnce();
    expect(worker.repoCommit).toHaveBeenCalledTimes(3);
  });

  it('非 transport 错误不 fallback', async () => {
    const corruption = new Error('commit corrupt');
    const preferred = client('c1', async () => { throw corruption; });
    const worker = client('c1', async () => commit('c1', null));

    await expect(syncHistoryIndex(preferred, worker, writer([]), new AbortController().signal)).rejects.toBe(corruption);
    expect(worker.repoHead).not.toHaveBeenCalled();
  });

  it('abort 后不启动 fallback', async () => {
    const controller = new AbortController();
    const preferred = client('c1', async () => {
      controller.abort();
      throw new TypeError('NetworkError');
    });
    const worker = client('c1', async () => commit('c1', null));

    await expect(syncHistoryIndex(preferred, worker, writer([]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.repoHead).not.toHaveBeenCalled();
  });
});
