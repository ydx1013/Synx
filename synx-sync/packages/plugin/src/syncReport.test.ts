import { describe, expect, it } from 'vitest';
import { SyncReportStore, normalizeSyncError, sanitizeDetail, type SyncReport } from './syncReport.js';
import { WorkerApiError } from './workerClient.js';

describe('normalizeSyncError', () => {
  it.each([
    [401, 'auth'], [403, 'permission'], [404, 'not-found'], [409, 'conflict'], [413, 'too-large'], [429, 'rate-limit'], [503, 'server'],
  ] as const)('maps HTTP %s to %s', (status, category) => {
    expect(normalizeSyncError(new WorkerApiError(status, 'failure', 3))).toMatchObject({ category, status, attempts: 3 });
  });

  it('maps network and local errors with actionable messages', () => {
    expect(normalizeSyncError(new TypeError('Failed to fetch')).category).toBe('network');
    expect(normalizeSyncError(Object.assign(new Error('denied'), { code: 'EACCES' })).category).toBe('local-permission');
  });
});

describe('sanitizeDetail', () => {
  it('redacts secrets and truncates long details', () => {
    const detail = sanitizeDetail('Authorization: Bearer abc.def.ghi password=secret accessKeyId=AKIA123 ' + 'x'.repeat(3000));
    expect(detail).not.toContain('abc.def.ghi');
    expect(detail).not.toContain('secret');
    expect(detail).not.toContain('AKIA123');
    expect(detail.length).toBeLessThanOrEqual(2000);
  });
});

describe('SyncReportStore', () => {
  it('keeps only the newest reports and updates the current report', () => {
    const saved: SyncReport[] = [];
    const store = new SyncReportStore(saved, 2);
    const first = store.start('manual', 1);
    store.addItem({ path: 'a.md', operation: 'push', status: 'success', startedAt: 1, endedAt: 2, attempts: 1 });
    store.finish(2);
    store.start('timer', 3);
    store.finish(4);
    const third = store.start('save', 5);
    store.finish(6);

    expect(store.current?.id).toBe(third.id);
    expect(store.reports).toHaveLength(2);
    expect(store.reports.some((report) => report.id === first.id)).toBe(false);
  });

  it('sanitizes report items before persistence and supports clearing', () => {
    const store = new SyncReportStore([], 20);
    store.start('manual', 1);
    store.addItem({
      path: 'a.md', operation: 'push', status: 'failed', startedAt: 1, endedAt: 2, attempts: 1,
      error: { category: 'unknown', message: 'password=hunter2', detail: 'Bearer abc.def.ghi' },
    });
    store.finish(2);

    expect(JSON.stringify(store.reports)).not.toContain('hunter2');
    expect(JSON.stringify(store.reports)).not.toContain('abc.def.ghi');
    store.clear();
    expect(store.reports).toEqual([]);
    expect(store.current).toBeNull();
  });

  it('counts successful local and remote deletions separately', () => {
    const store = new SyncReportStore([], 20);
    store.start('manual', 1);
    store.addItem({ path: 'local.md', operation: 'delete-local', status: 'success', startedAt: 1, endedAt: 2, attempts: 1 });
    store.addItem({ path: 'remote.md', operation: 'delete-remote', status: 'success', startedAt: 1, endedAt: 2, attempts: 1 });
    expect(store.current?.stats.deleteLocal).toBe(1);
    expect(store.current?.stats.deleteRemote).toBe(1);
  });

  it('records backup storage results and replaces duplicates', () => {
    const store = new SyncReportStore([], 20);
    store.start('manual', 1);
    expect(store.current!.backups).toEqual([]);
    store.recordBackup({ storageId: 'b1', storageName: 'B1', push: 3, success: 3, failed: 0, skipped: 0 });
    store.recordBackup({ storageId: 'b2', storageName: 'B2', push: 2, success: 1, failed: 1, skipped: 0 });
    expect(store.current!.backups).toHaveLength(2);
    // 同一 storageId 再次记录应替换
    store.recordBackup({ storageId: 'b1', storageName: 'B1', push: 3, success: 3, failed: 0, skipped: 0, error: { category: 'network', message: '网络失败' } });
    expect(store.current!.backups).toHaveLength(2);
    const b1 = store.current!.backups.find((b) => b.storageId === 'b1');
    expect(b1?.error?.category).toBe('network');
  });
});
