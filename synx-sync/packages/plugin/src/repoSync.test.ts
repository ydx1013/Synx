import { describe, expect, it, vi } from 'vitest';
import type { RepoCommit, RepoFile, RepositoryHead } from '@synx/shared';
import { createSerialStateWriter } from './credentialCache.js';
import {
  buildRepoChanges,
  clearAndQueuePersistSmartMergeBase,
  commitAndIndex,
  identityToFileUuid,
  repoTreeToRemote,
  treeToMap,
  updateRepoBaseAfterFinalize,
  refreshLocalSyncState,
  clearSmartMergeBase,
  clearAndPersistSmartMergeBase,
} from './repoSync.js';

function file(path: string, identity: string, hash = 'h', blobId = `b-${path}`): RepoFile {
  return { path, identity, blobId, hash, size: 1, mtime: 100 };
}

const tree: RepoFile[] = [
  file('note.md', 'uuid-note'),
  file('attachments/a.png', 'path:attachments/a.png'),
];

describe('commitAndIndex', () => {
  const commit: RepoCommit = {
    commitId: 'c2',
    parentCommitId: 'c1',
    generation: 2,
    createdAt: 2,
    author: null,
    message: 'Sync',
    kind: 'sync',
    changeCount: 0,
    checkpointId: null,
    changes: [],
  };
  const head: RepositoryHead = {
    version: 1,
    commitId: 'c2',
    generation: 2,
    updatedAt: 2,
  };
  const result = { commit, head };

  it('成功提交后把返回的 commit 和 HEAD 写入本地索引', async () => {
    const operation = vi.fn().mockResolvedValue(result);
    const index = { putCommits: vi.fn().mockResolvedValue(undefined) };

    await expect(commitAndIndex(operation, index)).resolves.toBe(result);
    expect(index.putCommits).toHaveBeenCalledWith([commit], 'c2');
  });

  it('索引失败不改变成功提交结果', async () => {
    const operation = vi.fn().mockResolvedValue(result);
    const index = { putCommits: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(commitAndIndex(operation, index)).resolves.toBe(result);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('提交失败时不写索引', async () => {
    const error = new Error('commit failed');
    const operation = vi.fn().mockRejectedValue(error);
    const index = { putCommits: vi.fn() };

    await expect(commitAndIndex(operation, index)).rejects.toBe(error);
    expect(index.putCommits).not.toHaveBeenCalled();
  });
});

describe('updateRepoBaseAfterFinalize', () => {
  it('成功 finalize 后读取最终 HEAD 对应的树，避免继续使用旧树', async () => {
    const repoTree = vi.fn().mockResolvedValue([file('new.md', 'uuid-new')]);
    await expect(updateRepoBaseAfterFinalize({ commitId: 'c2', generation: 2 }, repoTree)).resolves.toEqual({
      head: { commitId: 'c2', generation: 2 },
      tree: [file('new.md', 'uuid-new')],
    });
    expect(repoTree).toHaveBeenCalledWith('c2');
  });
});

describe('clearSmartMergeBase', () => {
  it('重建失败时保留 entries 元数据但清除旧共同祖先和所有 basePath', () => {
    expect(clearSmartMergeBase({
      version: 3,
      storageId: 's',
      syncFolder: 'vault/',
      baseCommitId: 'stale-commit',
      entries: {
        'a.md': { localMtime: 1, remoteMtime: 1, size: 1, basePath: 'old/a.md' },
      },
    })).toEqual({
      version: 3,
      storageId: 's',
      syncFolder: 'vault/',
      entries: {
        'a.md': { localMtime: 1, remoteMtime: 1, size: 1 },
      },
    });
  });

  it('清除后的状态必须持久化', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const state = { version: 3, baseCommitId: 'stale', entries: {} };
    const cleared = await clearAndPersistSmartMergeBase(state, persist);
    expect(cleared).toEqual({ version: 3, entries: {} });
    expect(persist).toHaveBeenCalledWith(cleared);
  });

  it('关键清理通过实际队列 writer 写盘并向上传播失败', async () => {
    let current = { version: 3, baseCommitId: 'stale', entries: {} };
    const writerError = new Error('disk full');
    const diskWrite = vi.fn(async () => { throw writerError; });
    const queueStateWrite = createSerialStateWriter(() => current, diskWrite);

    await expect(clearAndQueuePersistSmartMergeBase(current, (state) => { current = state; }, queueStateWrite)).rejects.toBe(writerError);
    expect(diskWrite).toHaveBeenCalledWith({ version: 3, entries: {} });
  });
});

describe('refreshLocalSyncState', () => {
  it('CAS 重试重新枚举第一轮写入后的本地实体并重建保护快照', async () => {
    const current = [{ path: 'pulled.md', mtime: 200, size: 3, hash: 'new-hash', fileUuid: 'uuid-pulled' }];
    const enumerate = vi.fn().mockResolvedValue({ files: current, skipped: [] });

    await expect(refreshLocalSyncState(enumerate)).resolves.toEqual({
      files: current,
      skipped: [],
      snapshot: new Map([['pulled.md', { exists: true, mtime: 200, size: 3, hash: 'new-hash' }]]),
    });
    expect(enumerate).toHaveBeenCalledOnce();
  });
});

describe('repoTreeToRemote', () => {
  it('映射为 planSync 可用的远端实体（key 带前导 /，hash 同时放 hash/etag）', () => {
    const remote = repoTreeToRemote(tree);
    expect(remote).toHaveLength(2);
    const note = remote.find((e) => e.key === '/note.md')!;
    expect(note.fileUuid).toBe('uuid-note');
    expect(note.hash).toBe('h');
    expect(note.etag).toBe('h');
    const attach = remote.find((e) => e.key === '/attachments/a.png')!;
    expect(attach.fileUuid).toBeUndefined();
  });
});

describe('identityToFileUuid', () => {
  it('uuid 原样返回，path: 前缀返回 undefined', () => {
    expect(identityToFileUuid('uuid-abc')).toBe('uuid-abc');
    expect(identityToFileUuid('path:a/b.md')).toBeUndefined();
  });
});

describe('buildRepoChanges', () => {
  const current = treeToMap(tree);

  it('已上传的新路径 → add，树中已有路径 → modify', () => {
    const changes = buildRepoChanges(
      [
        { path: 'new.md', blobId: 'b-new', hash: 'h', size: 1, mtime: 1, identity: 'uuid-new' },
        { path: 'note.md', blobId: 'b-note2', hash: 'h2', size: 2, mtime: 2, identity: 'uuid-note' },
      ],
      [],
      current,
    );
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.path === 'new.md')).toMatchObject({ operation: 'add' });
    expect(changes.find((c) => c.path === 'note.md')).toMatchObject({ operation: 'modify', blobId: 'b-note2' });
  });

  it('previousPath → rename 变更', () => {
    const changes = buildRepoChanges(
      [{ path: 'renamed.md', previousPath: 'note.md', blobId: 'b-r', hash: 'h', size: 1, mtime: 1, identity: 'uuid-note' }],
      [],
      current,
    );
    expect(changes[0]).toMatchObject({ operation: 'rename', previousPath: 'note.md', path: 'renamed.md' });
  });

  it('delete 变更（identity 直接透传）', () => {
    const changes = buildRepoChanges([], [{ path: 'note.md', identity: 'uuid-note' }], current);
    expect(changes[0]).toMatchObject({ operation: 'delete', path: 'note.md', identity: 'uuid-note' });
  });

  it('add/modify/delete 混合，保持传入顺序', () => {
    const changes = buildRepoChanges(
      [{ path: 'a.md', blobId: 'b', hash: 'h', size: 1, mtime: 1, identity: 'u-a' }],
      [{ path: 'note.md', identity: 'uuid-note' }],
      current,
    );
    expect(changes.map((c) => c.operation)).toEqual(['add', 'delete']);
  });

  it.each([
    ['add', { path: 'revived.md', blobId: 'b', hash: 'h', size: 1, mtime: 1, identity: 'new-id' }],
    ['modify', { path: 'note.md', blobId: 'b', hash: 'h', size: 1, mtime: 1, identity: 'uuid-note' }],
    ['rename target', { path: 'revived.md', previousPath: 'old.md', blobId: 'b', hash: 'h', size: 1, mtime: 1, identity: 'new-id' }],
  ])('同一路径不得同时输出 %s 与 delete', (_kind, upload) => {
    expect(() => buildRepoChanges(
      [upload],
      [{ path: upload.path, identity: 'deleted-id' }],
      current,
    )).toThrow(`同一路径不能同时上传和删除: ${upload.path}`);
  });
});
