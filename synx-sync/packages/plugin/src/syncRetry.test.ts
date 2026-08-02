import { describe, expect, it } from 'vitest';
import { buildRetryActions } from './syncRetry.js';
import type { SyncReportItem } from './syncReport.js';

const failed = (path: string, operation: 'push' | 'pull'): SyncReportItem => ({
  path, operation, status: 'failed', startedAt: 1, endedAt: 2, attempts: 3,
});

describe('buildRetryActions', () => {
  it('revalidates push files and filters before retrying', async () => {
    const actions = await buildRetryActions([failed('a.md', 'push'), failed('missing.md', 'push')], {
      inspectLocal: async (path) => path === 'a.md' ? { exists: true, size: 5 } : { exists: false, size: 0 },
      inspectRemote: async () => false,
      evaluate: (_path, size) => size > 4 ? { sync: false, reason: 'too large', rule: 'size', size } : { sync: true },
    });

    expect(actions).toEqual([
      { type: 'skip', path: 'a.md', reason: 'too large', rule: 'size', size: 5 },
      { type: 'skip', path: 'missing.md', reason: '本地文件已不存在', rule: 'local-missing', size: 0 },
    ]);
  });

  it('rechecks remote state and only recreates valid actions', async () => {
    const actions = await buildRetryActions([failed('upload.md', 'push'), failed('download.md', 'pull'), failed('gone.md', 'pull')], {
      inspectLocal: async () => ({ exists: true, size: 1 }),
      inspectRemote: async (path) => path !== 'gone.md',
      evaluate: () => ({ sync: true }),
    });

    expect(actions).toEqual([
      { type: 'push', path: 'upload.md', reason: 'retry-revalidated' },
      { type: 'pull', path: 'download.md', reason: 'retry-revalidated' },
      { type: 'skip', path: 'gone.md', reason: '远端文件已不存在', rule: 'remote-missing', size: 0 },
    ]);
  });

  it('ignores non-failed report items', async () => {
    const item: SyncReportItem = { ...failed('a.md', 'push'), status: 'success' };
    const actions = await buildRetryActions([item], {
      inspectLocal: async () => ({ exists: true, size: 1 }), inspectRemote: async () => true, evaluate: () => ({ sync: true }),
    });
    expect(actions).toEqual([]);
  });
});
