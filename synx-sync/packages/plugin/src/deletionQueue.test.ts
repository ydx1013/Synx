import { describe, expect, it, vi } from 'vitest';
import type { RepoChange } from '@synx/shared';
import { acknowledgePendingDeletions, acknowledgePendingDeletionsDurably, cancelRevivedPendingDeletions, collectPendingDeletions, enqueueDeletion, pendingForTarget, type PendingDeletion } from './deletionQueue.js';

const target = { storageId: 'storage-1', syncFolder: 'vault' };

describe('deletion queue', () => {
  it('deduplicates a deleted file by target and identity', () => {
    const entry: PendingDeletion = { ...target, path: 'a.md', fileUuid: '550e8400-e29b-41d4-a716-446655440000' };
    expect(enqueueDeletion([entry], entry)).toEqual([entry]);
  });

  it('only returns deletions for the active storage target', () => {
    const matching: PendingDeletion = { ...target, path: 'a.md', fileUuid: '550e8400-e29b-41d4-a716-446655440000' };
    const other: PendingDeletion = { storageId: 'storage-2', syncFolder: 'vault', path: 'b.md' };
    expect(pendingForTarget([matching, other], target)).toEqual([matching]);
  });

  it('规划删除不移除 durable queue，409 重试可重新应用同批且不重复', () => {
    const pending: PendingDeletion[] = [{ ...target, path: 'a.md', fileUuid: 'uuid-a' }];
    const first = new Map<string, string>();
    const second = new Map<string, string>();
    expect(collectPendingDeletions(pending, target, first)).toEqual(pending);
    expect(collectPendingDeletions(pending, target, second)).toEqual(pending);
    collectPendingDeletions(pending, target, second);
    expect(pending).toHaveLength(1);
    expect([...second]).toEqual([['a.md', 'uuid-a']]);
  });

  it('批量删除保护拦截的 pending deletion 不进入本轮 repoDeletes', () => {
    const pending: PendingDeletion[] = [{ ...target, path: 'a.md', fileUuid: 'uuid-a' }];
    const deletes = new Map<string, string>();

    expect(collectPendingDeletions(pending, target, deletes, false)).toEqual([]);
    expect([...deletes]).toEqual([]);
  });

  it('finalize 失败或中止时不确认，成功且包含对应 delete change 才移除', () => {
    const matched: PendingDeletion = { ...target, path: 'a.md', fileUuid: 'uuid-a' };
    const unmatched: PendingDeletion = { ...target, path: 'b.md', fileUuid: 'uuid-b' };
    const other: PendingDeletion = { storageId: 'storage-2', syncFolder: 'vault', path: 'c.md', fileUuid: 'uuid-c' };
    const queue = [matched, unmatched, other];
    const finalizedChanges: RepoChange[] = [{ operation: 'delete', path: 'a.md', identity: 'uuid-a' }];

    expect(acknowledgePendingDeletions(queue, target, [])).toEqual(queue);
    expect(acknowledgePendingDeletions(queue, target, finalizedChanges)).toEqual([unmatched, other]);
  });

  it('路径相同但 delete identity 不对应时不确认', () => {
    const queue: PendingDeletion[] = [{ ...target, path: 'a.md', fileUuid: 'uuid-a' }];
    const changes: RepoChange[] = [{ operation: 'delete', path: 'a.md', identity: 'uuid-other' }];
    expect(acknowledgePendingDeletions(queue, target, changes)).toEqual(queue);
  });

  it('按路径优先取消已重新枚举或计划 push 的复活文件，不受 identity 变化影响', async () => {
    const revivedByEnumeration: PendingDeletion = { ...target, path: 'same-path.md', fileUuid: 'old-uuid' };
    const revivedByPush: PendingDeletion = { ...target, path: 'renamed-target.md', fileUuid: 'another-old-uuid' };
    const missing: PendingDeletion = { ...target, path: 'still-missing.md', fileUuid: 'uuid-missing' };
    const otherTarget: PendingDeletion = { storageId: 'storage-2', syncFolder: 'vault', path: 'same-path.md', fileUuid: 'other' };
    let queue = [revivedByEnumeration, revivedByPush, missing, otherTarget];
    const persisted: PendingDeletion[][] = [];

    await cancelRevivedPendingDeletions(
      queue,
      target,
      new Set(['same-path.md', 'renamed-target.md']),
      (next) => { queue = next; },
      async () => { persisted.push([...queue]); },
    );

    expect(queue).toEqual([missing, otherTarget]);
    expect(persisted).toEqual([[missing, otherTarget]]);
    const deletes = new Map<string, string>();
    collectPendingDeletions(queue, target, deletes);
    expect([...deletes]).toEqual([['still-missing.md', 'uuid-missing']]);
  });

  it('复活取消首次写盘 pending 时并发新增，失败回滚合并旧项并再次写盘', async () => {
    const removed: PendingDeletion = { ...target, path: 'revived.md', fileUuid: 'old-uuid' };
    const concurrent: PendingDeletion = { ...target, path: 'new-delete.md', fileUuid: 'new-uuid' };
    let queue = [removed];
    let rejectFirst!: (error: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const persisted: PendingDeletion[][] = [];
    const persist = vi.fn(async () => {
      persisted.push([...queue]);
      if (persisted.length === 1) await firstWrite;
    });
    const error = new Error('disk full');

    const cancelling = cancelRevivedPendingDeletions(
      queue,
      target,
      new Set(['revived.md']),
      (next) => { queue = next; },
      persist,
      () => queue,
    );
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    queue = enqueueDeletion(queue, concurrent);
    rejectFirst(error);

    await expect(cancelling).rejects.toBe(error);
    expect(queue).toEqual([concurrent, removed]);
    expect(persisted).toEqual([[], [concurrent, removed]]);
  });

  it('确认删除首次写盘 pending 时同 key 新项优先，失败回滚不以旧项覆盖并再次写盘', async () => {
    const removed: PendingDeletion = { ...target, path: 'deleted.md', fileUuid: 'same-uuid' };
    const concurrent: PendingDeletion = { ...removed };
    const changes: RepoChange[] = [{ operation: 'delete', path: removed.path, identity: removed.fileUuid! }];
    let queue = [removed];
    let rejectFirst!: (error: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const persisted: PendingDeletion[][] = [];
    const persist = vi.fn(async () => {
      persisted.push([...queue]);
      if (persisted.length === 1) await firstWrite;
    });
    const error = new Error('disk full');

    const acknowledging = acknowledgePendingDeletionsDurably(
      queue,
      target,
      changes,
      (next) => { queue = next; },
      persist,
      () => queue,
    );
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    queue = enqueueDeletion(queue, concurrent);
    rejectFirst(error);

    await expect(acknowledging).rejects.toBe(error);
    expect(queue).toEqual([concurrent]);
    expect(queue[0]).toBe(concurrent);
    expect(persisted).toEqual([[], [concurrent]]);
  });
});
