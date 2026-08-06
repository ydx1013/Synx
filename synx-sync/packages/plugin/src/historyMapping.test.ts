import { describe, expect, it } from 'vitest';
import { mapHistoryEntries } from './historyMapping.js';

it('保留每个版本的历史路径，并标记当前与删除版本', () => {
  const entries = mapHistoryEntries({
    headCommitId: 'c3',
    commits: [
      { commitId: 'c3', parentCommitId: 'c2', kind: 'sync', createdAt: 3000, author: 'a', message: 'rename', changeCount: 1 },
      { commitId: 'c2', parentCommitId: 'c1', kind: 'sync', createdAt: 2000, author: 'a', message: 'modify', changeCount: 1 },
      { commitId: 'c1', parentCommitId: null, kind: 'sync', createdAt: 1000, author: 'a', message: 'delete', changeCount: 1 },
    ],
    changes: [
      { identity: 'u1', operation: 'rename', previousPath: 'old.md', path: 'new.md', blobId: 'b3', size: 3 },
      { identity: 'u1', operation: 'modify', path: 'old.md', blobId: 'b2', size: 2 },
      { identity: 'u1', operation: 'delete', path: 'old.md' },
    ],
  });

  expect(entries.map((entry) => entry.path)).toEqual(['new.md', 'old.md', 'old.md']);
  expect(entries.map((entry) => entry.isCurrent)).toEqual([true, false, false]);
  expect(entries.map((entry) => entry.deleted)).toEqual([false, false, true]);
});
