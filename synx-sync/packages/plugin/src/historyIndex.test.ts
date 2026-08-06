import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepoCommit } from '@synx/shared';
import { HistoryIndex } from './historyIndex.js';

const createdDatabases: HistoryIndex[] = [];

function commit(
  generation: number,
  parentCommitId: string | null,
  identity = 'file-1',
  path = 'note.md',
): RepoCommit {
  const commitId = `c${generation}`;
  return {
    commitId,
    parentCommitId,
    generation,
    createdAt: generation * 1000,
    author: 'device-a',
    message: `Sync ${generation}`,
    kind: generation === 1 ? 'initial' : 'sync',
    changeCount: generation === 1 ? 0 : 1,
    checkpointId: generation === 1 ? commitId : null,
    changes: generation === 1
      ? []
      : [{ identity, operation: 'modify', path, blobId: `blob-${generation}`, hash: `h${generation}`, size: generation, mtime: generation * 1000 }],
  };
}

function makeIndex(name: string): HistoryIndex {
  const index = new HistoryIndex(name);
  createdDatabases.push(index);
  return index;
}

afterEach(async () => {
  await Promise.all(createdDatabases.splice(0).map((index) => index.delete()));
});

describe('HistoryIndex', () => {
  it('按账号隔离，并按仓库与 identity 返回从新到旧的文件历史', async () => {
    const index = makeIndex(`history-index-query-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    await index.putCommits([
      commit(1, null),
      commit(2, 'c1'),
      commit(3, 'c2'),
      commit(4, 'c3', 'file-2', 'other.md'),
    ], 'c4');

    const result = await index.getFileHistory('file-1');
    expect(result.commits.map((item) => item.commitId)).toEqual(['c3', 'c2']);
    expect(result.changes.map((item) => item.blobId)).toEqual(['blob-3', 'blob-2']);
    expect(result.headCommitId).toBe('c4');

    await index.setRepository('storage-b', 'Vault');
    expect((await index.getFileHistory('file-1')).commits).toEqual([]);
  });

  it('从 indexedHead 增量补齐新提交，不重复读取旧链', async () => {
    const index = makeIndex(`history-index-incremental-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    await index.putCommits([commit(1, null), commit(2, 'c1')], 'c2');

    const chain = new Map([
      ['c2', commit(2, 'c1')],
      ['c3', commit(3, 'c2')],
      ['c4', commit(4, 'c3')],
    ]);
    const reads: string[] = [];
    const result = await index.syncFromHead('c4', async (commitId) => {
      reads.push(commitId);
      return chain.get(commitId) ?? null;
    });

    expect(result).toEqual({ indexed: 2, rebuilt: false });
    expect(reads).toEqual(['c4', 'c3']);
    expect((await index.getFileHistory('file-1')).commits.map((item) => item.commitId)).toEqual(['c4', 'c3', 'c2']);
  });

  it('索引断链时清空当前仓库并从 HEAD 全量重建', async () => {
    const index = makeIndex(`history-index-rebuild-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    await index.putCommits([commit(9, null, 'stale-file', 'stale.md')], 'missing-head');

    const chain = new Map([
      ['c1', commit(1, null)],
      ['c2', commit(2, 'c1')],
      ['c3', commit(3, 'c2')],
    ]);
    const result = await index.syncFromHead('c3', async (commitId) => chain.get(commitId) ?? null);

    expect(result).toEqual({ indexed: 3, rebuilt: true });
    expect((await index.getFileHistory('stale-file')).commits).toEqual([]);
    expect((await index.getFileHistory('file-1')).commits.map((item) => item.commitId)).toEqual(['c3', 'c2']);
  });

  it('新链在保留边界缺失 parent 时清库并以当前可达链重建', async () => {
    const index = makeIndex(`history-index-retention-rebuild-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    await index.putCommits([commit(9, null, 'stale-file', 'stale.md')], 'c2');

    const chain = new Map([
      ['c4', commit(4, 'c3')],
      ['c5', commit(5, 'c4')],
    ]);
    const reads: string[] = [];
    const result = await index.syncFromHead('c5', async (commitId) => {
      reads.push(commitId);
      return chain.get(commitId) ?? null;
    }, { batchSize: 1 });

    expect(result).toEqual({ indexed: 2, rebuilt: true });
    expect(reads).toEqual(['c5', 'c4', 'c3']);
    expect((await index.getFileHistory('stale-file')).commits).toEqual([]);
    const history = await index.getFileHistory('file-1');
    expect(history.commits.map((item) => item.commitId)).toEqual(['c5', 'c4']);
    expect(history.headCommitId).toBe('c5');
  });

  it('当前 HEAD 本身缺失时仍报告完整性错误', async () => {
    const index = makeIndex(`history-index-missing-head-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');

    await expect(index.syncFromHead('missing-head', async () => null))
      .rejects.toThrow('commit missing-head not found while building history index');
    expect((await index.getFileHistory('file-1')).headCommitId).toBeNull();
  });

  it('后台构建按批次报告进度并可中止', async () => {
    const index = makeIndex(`history-index-progress-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    const chain = new Map<string, RepoCommit>();
    for (let generation = 1; generation <= 5; generation++) {
      chain.set(`c${generation}`, commit(generation, generation === 1 ? null : `c${generation - 1}`));
    }
    const controller = new AbortController();
    const progress: number[] = [];

    await expect(index.syncFromHead(
      'c5',
      async (commitId) => chain.get(commitId) ?? null,
      {
        batchSize: 2,
        signal: controller.signal,
        onProgress: (value) => {
          progress.push(value.indexed);
          if (value.indexed === 2) controller.abort();
        },
      },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([2]);
  });

  it('readCommit pending 期间 abort 后不写入提交或 indexedHead', async () => {
    const index = makeIndex(`history-index-pending-abort-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    const controller = new AbortController();
    let release!: (value: RepoCommit) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const pendingRead = new Promise<RepoCommit>((resolve) => { release = resolve; });

    const syncing = index.syncFromHead('c2', () => {
      markReadStarted();
      return pendingRead;
    }, {
      batchSize: 1,
      signal: controller.signal,
    });
    await readStarted;
    controller.abort();
    release(commit(2, null));

    await expect(syncing).rejects.toMatchObject({ name: 'AbortError' });
    expect(await index.getFileHistory('file-1')).toEqual({ commits: [], changes: [], headCommitId: null });
  });

  it('退出账号时删除该账号的全部本地历史', async () => {
    const index = makeIndex(`history-index-account-${crypto.randomUUID()}`);
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    await index.putCommits([commit(1, null), commit(2, 'c1')], 'c2');

    await index.clearAccount();
    await index.openAccount('user-a');
    await index.setRepository('storage-a', 'Vault');
    expect((await index.getFileHistory('file-1')).commits).toEqual([]);
  });
});
