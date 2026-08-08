import { describe, expect, it } from 'vitest';
import { formatStatusBar } from './syncPresentation.js';
import type { BackupSyncStats, SyncReport } from './syncReport.js';

function report(phase: SyncReport['phase'], stats: Partial<SyncReport['stats']> = {}, backups: BackupSyncStats[] = []): SyncReport {
  return {
    id: '1', trigger: 'manual', startedAt: 1, phase, items: [],
    stats: { success: 0, failed: 0, skipped: 0, protected: 0, conflicts: 0, push: 0, pull: 0, deleteLocal: 0, deleteRemote: 0, ...stats },
    backups,
  };
}

describe('formatStatusBar', () => {
  it('covers disconnected and idle states', () => {
    expect(formatStatusBar(false, null)).toBe('Synx 未连接');
    expect(formatStatusBar(true, null)).toBe('Synx 就绪');
  });

  it('shows phases and per-direction progress', () => {
    expect(formatStatusBar(true, report('scanning'))).toBe('Synx 扫描中…');
    expect(formatStatusBar(true, report('planning'))).toBe('Synx 规划中…');
    expect(formatStatusBar(true, report('syncing', { success: 9, failed: 1, push: 12, pull: 4 }))).toBe('Synx ↑ 9/12 ↓ 0/4 失败 1');
  });

  it('明确区分已解决冲突和失败，并显示原子提交结果', () => {
    const committed = report('completed', { success: 14, skipped: 3, protected: 2, conflicts: 4 });
    committed.commitStatus = 'committed';
    expect(formatStatusBar(true, committed)).toBe('Synx 成功：远端原子提交已确认，成功 14，已自动处理冲突 4，跳过 3，保护 2');
    const noChanges = report('completed', { skipped: 10 });
    noChanges.commitStatus = 'not-needed';
    expect(formatStatusBar(true, noChanges)).toBe('Synx 成功：无需远端提交，成功 0，跳过 10');
    expect(formatStatusBar(true, report('partial-failure', { success: 14, failed: 2, skipped: 3 }))).toBe('Synx 部分失败：成功 14，失败 2，跳过 3');
    expect(formatStatusBar(true, report('failed'))).toBe('Synx 同步失败');
  });

  it('appends backup summary when backups are present', () => {
    const okBackup: BackupSyncStats = { storageId: 'b1', storageName: 'B1', push: 5, success: 5, failed: 0, skipped: 0 };
    expect(formatStatusBar(true, report('completed', { success: 10 }, [okBackup]))).toBe('Synx 成功：同步已完成，成功 10，跳过 0 · 备份 1/1');
    const failedBackup: BackupSyncStats = { storageId: 'b2', storageName: 'B2', push: 0, success: 0, failed: 0, skipped: 0, error: { category: 'server', message: '服务器异常' } };
    expect(formatStatusBar(true, report('completed', { success: 10 }, [okBackup, failedBackup]))).toBe('Synx 成功：同步已完成，成功 10，跳过 0 · 备份 1/2');
    const partialBackup: BackupSyncStats = { storageId: 'b3', storageName: 'B3', push: 3, success: 2, failed: 1, skipped: 0 };
    expect(formatStatusBar(true, report('completed', { success: 10 }, [okBackup, partialBackup]))).toBe('Synx 成功：同步已完成，成功 10，跳过 0 · 备份 1/2');
  });
});
