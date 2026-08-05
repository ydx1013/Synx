import { describe, it, expect } from 'vitest';
import { isLocalFileUnchangedFromPrev, isLocalVersionUnchanged, planSync, shouldProtectAgainstMassDeletion, shouldProtectAgainstMassLocalDeletion, type LocalFile, type PrevSyncEntry, type RemoteEntity } from './syncAlgo.js';

function localFile(path: string, mtime: number, hash?: string): LocalFile {
  return { path, mtime, size: 10, hash };
}

function remoteEntity(path: string, mtime: number, etag?: string): RemoteEntity {
  return { key: '/' + path, mtime, size: 10, type: 'file' as const, etag };
}

function prevEntry(path: string, localMtime: number, remoteMtime: number, size = 10): [string, PrevSyncEntry] {
  return [path, { localMtime, remoteMtime, size }];
}

describe('planSync - basic decisions', () => {
  it('matches a renamed note by UUID without pulling the old path', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const plan = planSync(
      [{ path: 'new.md', mtime: 2, size: 10, fileUuid: uuid }],
      [{ key: '/old.md', mtime: 1, size: 10, type: 'file', fileUuid: uuid }],
    );
    expect(plan.actions).toEqual([{ type: 'push', path: 'new.md', reason: 'local-newer' }]);
  });

  it('pushes local-only files', () => {
    const plan = planSync([localFile('a.md', 100)], []);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: 'push', path: 'a.md', reason: 'local-only' });
    expect(plan.stats.push).toBe(1);
  });

  it('pulls remote-only files and records that local did not exist', () => {
    const plan = planSync([], [remoteEntity('b.md', 100)]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      type: 'pull',
      path: 'b.md',
      reason: 'remote-only',
      expectedLocal: { exists: false },
    });
    expect(plan.stats.pull).toBe(1);
  });

  it('records the planned local version on pull', () => {
    const plan = planSync(
      [{ path: 'a.md', mtime: 1000, size: 10, hash: 'local' }],
      [remoteEntity('a.md', 5000, 'remote')],
    );
    expect(plan.actions[0]).toMatchObject({
      type: 'pull',
      expectedLocal: { exists: true, mtime: 1000, size: 10, hash: 'local' },
    });
  });

  it('skips when mtime same and hash same', () => {
    const plan = planSync([localFile('a.md', 100, 'h1')], [remoteEntity('a.md', 100, 'h1')]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
    expect(plan.stats.skip).toBe(1);
  });

  it('skips identical content even when mtime differs', () => {
    const plan = planSync([localFile('a.md', 5000, 'h1')], [remoteEntity('a.md', 1000, 'h1')]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
    expect(plan.stats.skip).toBe(1);
  });

  it('skips identical content when remote mtime is newer', () => {
    const plan = planSync([localFile('a.md', 1000, 'h1')], [remoteEntity('a.md', 5000, 'h1')]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
    expect(plan.stats.skip).toBe(1);
  });

  it('conflict: same mtime, different hash → push conflict-keep-local', () => {
    const plan = planSync([localFile('a.md', 100, 'local')], [remoteEntity('a.md', 100, 'remote')]);
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'conflict-keep-local' });
    expect(plan.stats.conflict).toBe(1);
    expect(plan.stats.push).toBe(1);
  });

  it('treats missing hash as in-sync when mtime same', () => {
    // 本地无 hash、远端无 etag → sameHash=true
    const plan = planSync([localFile('a.md', 100)], [remoteEntity('a.md', 100)]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });
});

describe('planSync - threshold', () => {
  it('treats mtime diff < threshold as same', () => {
    // diff=500ms < 1000ms 阈值 → 视为相同 mtime
    const plan = planSync([localFile('a.md', 100500, 'h1')], [remoteEntity('a.md', 100000, 'h1')]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });

  it('does not upload identical content when mtime diff exceeds threshold', () => {
    const plan = planSync([localFile('a.md', 102000, 'h1')], [remoteEntity('a.md', 100000, 'h1')]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });
});

describe('planSync - mixed scenarios', () => {
  it('handles mixed set correctly', () => {
    const local = [
      localFile('local-only.md', 1000, 'h1'), // push local-only
      localFile('local-newer.md', 5000, 'h2'), // push local-newer (diff 4000 > 1000)
      localFile('in-sync.md', 1000, 'h3'), // skip
      localFile('conflict.md', 1000, 'local-h'), // conflict
    ];
    const remote = [
      remoteEntity('local-newer.md', 1000, 'h2'),
      remoteEntity('in-sync.md', 1000, 'h3'),
      remoteEntity('conflict.md', 1000, 'remote-h'),
      remoteEntity('remote-only.md', 1000, 'h5'), // pull remote-only
    ];
    const plan = planSync(local, remote);

    expect(plan.stats).toEqual({ push: 2, pull: 1, skip: 2, conflict: 1 });
    expect(plan.actions).toHaveLength(5);
  });

  it('normalizes remote key leading slash', () => {
    // Entity.key 是 '/path'，应被归一化为 'path'
    const plan = planSync([localFile('a.md', 100, 'h1')], [
      { key: '/a.md', mtime: 100, size: 10, type: 'file', etag: 'h1' },
    ]);
    expect(plan.actions[0]).toMatchObject({ type: 'skip' });
  });

  it('empty both sides → empty plan', () => {
    const plan = planSync([], []);
    expect(plan.actions).toHaveLength(0);
    expect(plan.stats).toEqual({ push: 0, pull: 0, skip: 0, conflict: 0 });
  });
});

describe('planSync - size-aware equality (aligned with remotely-save)', () => {
  it('skips when mtime same and size same (no hash)', () => {
    const local = [{ path: 'a.md', mtime: 1000, size: 50 }];
    const remote = [{ key: '/a.md', mtime: 1000, size: 50, type: 'file' as const }];
    const plan = planSync(local, remote);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });

  it('conflicts when mtime same but size differs', () => {
    const local = [{ path: 'a.md', mtime: 1000, size: 50, hash: 'h1' }];
    const remote = [{ key: '/a.md', mtime: 1000, size: 99, type: 'file' as const, etag: 'h1' }];
    // mtime 相同、hash 相同但 size 不同 → 冲突（与仅看 hash 的旧逻辑不同）
    const plan = planSync(local, remote);
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'conflict-keep-local' });
    expect(plan.stats.conflict).toBe(1);
  });

  it('skips when mtime same, size same, and hash matches', () => {
    const local = [{ path: 'a.md', mtime: 1000, size: 50, hash: 'h1' }];
    const remote = [{ key: '/a.md', mtime: 1000, size: 50, type: 'file' as const, etag: 'h1' }];
    const plan = planSync(local, remote);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });

  it('conflicts when mtime same, size same, but hash differs', () => {
    const local = [{ path: 'a.md', mtime: 1000, size: 50, hash: 'local' }];
    const remote = [{ key: '/a.md', mtime: 1000, size: 50, type: 'file' as const, etag: 'remote' }];
    const plan = planSync(local, remote);
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'conflict-keep-local' });
    expect(plan.stats.conflict).toBe(1);
  });
});

describe('planSync - prevSync 三方比较', () => {
  it('两端都没变（==prevSync）→ skip，挡住 mtime 抖动', () => {
    // 本地 mtime 从 1000 抖到 1050（< 1000ms 阈值），远端不变
    // 无 prevSync 时会 skip；有 prevSync 时也 skip
    const prev = new Map([prevEntry('a.md', 1000, 1000)]);
    const plan = planSync([localFile('a.md', 1050)], [remoteEntity('a.md', 1000)], 1000, prev);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
    expect(plan.stats.skip).toBe(1);
  });

  it('本地 mtime 抖动超阈值但 ==prevSync → skip（核心场景）', () => {
    // 本地 mtime 从 1000 变到 3000（> 1000ms 阈值），但 size 没变
    // 无 prevSync 时会判 push（local-newer）；有 prevSync 时 skip
    const prev = new Map([prevEntry('a.md', 3000, 3000)]);
    const plan = planSync([localFile('a.md', 3000)], [remoteEntity('a.md', 3000)], 1000, prev);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });

  it('本地改了（!=prevSync），远端没变（==prevSync）→ push', () => {
    const prev = new Map([prevEntry('a.md', 1000, 1000)]);
    const plan = planSync([localFile('a.md', 5000)], [remoteEntity('a.md', 1000)], 1000, prev);
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'local-newer' });
    expect(plan.stats.push).toBe(1);
  });

  it('远端改了（!=prevSync），本地没变（==prevSync）→ pull', () => {
    const prev = new Map([prevEntry('a.md', 1000, 1000)]);
    const plan = planSync([localFile('a.md', 1000)], [remoteEntity('a.md', 5000)], 1000, prev);
    expect(plan.actions[0]).toMatchObject({ type: 'pull', reason: 'remote-newer' });
    expect(plan.stats.pull).toBe(1);
  });

  it('两端都改了（!=prevSync）→ 冲突', () => {
    const prev = new Map([prevEntry('a.md', 1000, 1000)]);
    const plan = planSync([localFile('a.md', 5000)], [remoteEntity('a.md', 6000)], 1000, prev);
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'conflict-keep-local' });
    expect(plan.stats.conflict).toBe(1);
  });

  it('本地 size 变了但 mtime 没变 → 本地改了 → push', () => {
    const prev = new Map([prevEntry('a.md', 1000, 1000, 10)]);
    const plan = planSync(
      [{ path: 'a.md', mtime: 1000, size: 99 }],
      [remoteEntity('a.md', 1000)],
      1000,
      prev,
    );
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'local-newer' });
  });

  it('prevSync 按 fileUuid 匹配（重命名后）', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    // prevSync 存的是旧路径 old.md，本地已重命名为 new.md
    const prev = new Map<string, PrevSyncEntry>([
      ['old.md', { localMtime: 1000, remoteMtime: 1000, size: 10, fileUuid: uuid }],
    ]);
    // 远端也通过 UUID 匹配到 old.md → 先走重命名 push 分支，不会到三方比较
    const plan = planSync(
      [{ path: 'new.md', mtime: 1000, size: 10, fileUuid: uuid }],
      [{ key: '/old.md', mtime: 1000, size: 10, type: 'file' as const, fileUuid: uuid }],
      1000,
      prev,
    );
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'local-newer' });
  });

  it('无 prevSync 时相同 hash 仍然跳过', () => {
    const plan = planSync([localFile('a.md', 5000, 'h1')], [remoteEntity('a.md', 1000, 'h1')], 1000, undefined);
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });

  it('空 prevSync Map 且相同 hash 时跳过', () => {
    const plan = planSync([localFile('a.md', 5000, 'h1')], [remoteEntity('a.md', 1000, 'h1')], 1000, new Map());
    expect(plan.actions[0]).toMatchObject({ type: 'skip', reason: 'in-sync' });
  });
});

describe('planSync - stable three-way states', () => {
  it('deletes remote when local was deleted after the previous sync', () => {
    const prev = new Map<string, PrevSyncEntry>([
      ['a.md', { localMtime: 1, remoteMtime: 1, size: 10, localHash: 'h1', remoteHash: 'h1' }],
    ]);
    const plan = planSync([], [remoteEntity('a.md', 2, 'h1')], 1000, prev);
    expect(plan.actions).toEqual([{ type: 'delete-remote', path: 'a.md', reason: 'local-deleted' }]);
  });

  it('deletes local when remote was deleted after the previous sync', () => {
    const prev = new Map<string, PrevSyncEntry>([
      ['a.md', { localMtime: 1, remoteMtime: 1, size: 10, localHash: 'h1', remoteHash: 'h1' }],
    ]);
    const plan = planSync([localFile('a.md', 2, 'h1')], [], 1000, prev);
    expect(plan.actions).toEqual([{ type: 'delete-local', path: 'a.md', reason: 'remote-deleted' }]);
  });

  it('uses hashes instead of mtime to detect which side changed', () => {
    const prev = new Map<string, PrevSyncEntry>([
      ['a.md', { localMtime: 1, remoteMtime: 1, size: 10, localHash: 'base', remoteHash: 'base' }],
    ]);
    const plan = planSync([localFile('a.md', 1, 'local-new')], [remoteEntity('a.md', 5000, 'base')], 1000, prev);
    expect(plan.actions[0]).toMatchObject({ type: 'push', reason: 'local-newer' });
  });
});

describe('shouldProtectAgainstMassDeletion', () => {
  it('does not protect when prevSync is empty', () => {
    expect(shouldProtectAgainstMassDeletion(0, 0)).toBe(false);
    expect(shouldProtectAgainstMassDeletion(50, 0)).toBe(false);
  });

  it('does not protect when local count is not drastically reduced', () => {
    expect(shouldProtectAgainstMassDeletion(451, 451)).toBe(false);
    expect(shouldProtectAgainstMassDeletion(300, 451)).toBe(false); // 66% 保留，安全
  });

  it('protects when local dropped below half of prevSync', () => {
    expect(shouldProtectAgainstMassDeletion(200, 451)).toBe(true);
    expect(shouldProtectAgainstMassDeletion(0, 451)).toBe(true); // 本地完全清空
  });

  it('protects with custom threshold', () => {
    expect(shouldProtectAgainstMassDeletion(440, 500, 90)).toBe(true);   // 88% < 90%
    expect(shouldProtectAgainstMassDeletion(460, 500, 90)).toBe(false);  // 92% ≥ 90%
    expect(shouldProtectAgainstMassDeletion(200, 400, 50)).toBe(false);  // 恰为 50%，不触发（严格小于）
    expect(shouldProtectAgainstMassDeletion(199, 400, 50)).toBe(true);   // 49.75% < 50%
  });
});

describe('shouldProtectAgainstMassLocalDeletion', () => {
  it('does not protect when prevSync is empty', () => {
    expect(shouldProtectAgainstMassLocalDeletion(50, 0)).toBe(false);
  });

  it('does not protect when delete-local count is not mass', () => {
    expect(shouldProtectAgainstMassLocalDeletion(0, 451)).toBe(false);
    expect(shouldProtectAgainstMassLocalDeletion(200, 451)).toBe(false); // 44% < 50%
    expect(shouldProtectAgainstMassLocalDeletion(225, 450)).toBe(false); // 恰为 50%，不触发（严格大于）
  });

  it('protects when remote mass-loss would delete most local files', () => {
    expect(shouldProtectAgainstMassLocalDeletion(226, 450)).toBe(true); // 50.2% > 50%
    expect(shouldProtectAgainstMassLocalDeletion(451, 451)).toBe(true); // 整库将被删除
  });

  it('protects with custom threshold', () => {
    expect(shouldProtectAgainstMassLocalDeletion(40, 500, 90)).toBe(false);  // 8% ≤ 10%，不触发
    expect(shouldProtectAgainstMassLocalDeletion(60, 500, 90)).toBe(true);   // 12% > 10%
    expect(shouldProtectAgainstMassLocalDeletion(226, 450, 50)).toBe(true);  // 50.2% > 50%
  });
});

describe('isLocalVersionUnchanged（pull 覆盖保护）', () => {
  const expected = { exists: true as const, mtime: 1000, size: 10, hash: 'h1' };

  it('hash 变化时判定已变化', () => {
    expect(isLocalVersionUnchanged(expected, { exists: true, mtime: 1000, size: 10, hash: 'h2' })).toBe(false);
  });

  it('计划时不存在、执行时新建则判定已变化', () => {
    expect(isLocalVersionUnchanged({ exists: false }, { exists: true, mtime: 1000, size: 10, hash: 'h1' })).toBe(false);
  });

  it('计划时存在、执行时删除则判定已变化', () => {
    expect(isLocalVersionUnchanged(expected, { exists: false })).toBe(false);
  });

  it('hash、mtime、size 均未变化时保持一致', () => {
    expect(isLocalVersionUnchanged(expected, { exists: true, mtime: 1000, size: 10, hash: 'h1' })).toBe(true);
  });

  it('mtime 或 size 变化时即使 hash 缺失也拒绝覆盖', () => {
    const withoutHash = { exists: true as const, mtime: 1000, size: 10 };
    expect(isLocalVersionUnchanged(withoutHash, { exists: true, mtime: 1001, size: 10 })).toBe(false);
    expect(isLocalVersionUnchanged(withoutHash, { exists: true, mtime: 1000, size: 11 })).toBe(false);
  });
});

describe('isLocalFileUnchangedFromPrev（hash 快路径）', () => {
  it('mtime 与 size 均一致且上次有 hash → 可复用', () => {
    const prev: PrevSyncEntry = { localMtime: 1000, remoteMtime: 1000, size: 10, localHash: 'h1', remoteHash: 'h1' };
    expect(isLocalFileUnchangedFromPrev(prev, 1000, 10)).toBe(true);
  });

  it('mtime 变了 → 不能复用', () => {
    const prev: PrevSyncEntry = { localMtime: 1000, remoteMtime: 1000, size: 10, localHash: 'h1' };
    expect(isLocalFileUnchangedFromPrev(prev, 5000, 10)).toBe(false);
  });

  it('size 变了 → 不能复用', () => {
    const prev: PrevSyncEntry = { localMtime: 1000, remoteMtime: 1000, size: 10, localHash: 'h1' };
    expect(isLocalFileUnchangedFromPrev(prev, 1000, 99)).toBe(false);
  });

  it('上次没有本地 hash → 不能复用（需重算）', () => {
    const prev: PrevSyncEntry = { localMtime: 1000, remoteMtime: 1000, size: 10 };
    expect(isLocalFileUnchangedFromPrev(prev, 1000, 10)).toBe(false);
  });

  it('无 prevSync 条目 → 不能复用', () => {
    expect(isLocalFileUnchangedFromPrev(undefined, 1000, 10)).toBe(false);
  });
});
