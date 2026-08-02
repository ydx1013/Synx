import type { BackupSyncStats, SyncReport } from './syncReport.js';

export function formatStatusBar(connected: boolean, report: SyncReport | null): string {
  if (!connected) return 'Synx 未连接';
  if (!report) return 'Synx 就绪';
  if (report.phase === 'scanning') return 'Synx 扫描中…';
  if (report.phase === 'planning') return 'Synx 规划中…';
  if (report.phase === 'syncing') {
    const uploadDone = report.items.filter((item) => item.operation === 'push' && item.status !== 'skipped').length;
    const downloadDone = report.items.filter((item) => item.operation === 'pull' && item.status !== 'skipped').length;
    const completed = uploadDone + downloadDone;
    const fallbackUpload = completed === 0 ? Math.min(report.stats.success, report.stats.push) : uploadDone;
    const fallbackDownload = completed === 0 ? Math.max(0, report.stats.success - fallbackUpload) : downloadDone;
    const base = `Synx ↑ ${fallbackUpload}/${report.stats.push} ↓ ${fallbackDownload}/${report.stats.pull} 失败 ${report.stats.failed}`;
    return appendBackupStatus(base, report.backups);
  }
  if (report.phase === 'failed') return 'Synx 同步失败';
  const deletions = report.stats.deleteLocal + report.stats.deleteRemote;
  const base = `Synx 完成：成功 ${report.stats.success}，失败 ${report.stats.failed}，跳过 ${report.stats.skipped}${deletions > 0 ? `，删除 ${deletions}` : ''}`;
  return appendBackupStatus(base, report.backups);
}

/** 备份存储镜像进行中或已完成时，追加「备份 N/M」摘要 */
function appendBackupStatus(base: string, backups: BackupSyncStats[]): string {
  if (!backups || backups.length === 0) return base;
  const total = backups.length;
  // 整体失败（有 error）或部分 push 失败 → 视为该备份未完成/失败
  const failed = backups.filter((b) => b.error != null || b.failed > 0).length;
  const ok = total - failed;
  return `${base} · 备份 ${ok}/${total}`;
}
