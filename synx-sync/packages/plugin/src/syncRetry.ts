import type { FileFilterResult } from './fileFilter.js';
import type { ExecutableSyncAction } from './syncExecutor.js';
import type { SyncReportItem } from './syncReport.js';

export interface RetryValidation {
  inspectLocal(path: string): Promise<{ exists: boolean; size: number }>;
  inspectRemote(path: string): Promise<boolean>;
  evaluate(path: string, size: number): FileFilterResult;
}

export async function buildRetryActions(items: SyncReportItem[], validation: RetryValidation): Promise<ExecutableSyncAction[]> {
  const actions: ExecutableSyncAction[] = [];
  for (const item of items) {
    if (item.status !== 'failed' || (item.operation !== 'push' && item.operation !== 'pull')) continue;
    if (item.operation === 'push') {
      const local = await validation.inspectLocal(item.path);
      if (!local.exists) {
        actions.push({ type: 'skip', path: item.path, reason: '本地文件已不存在', rule: 'local-missing', size: 0 });
        continue;
      }
      const filter = validation.evaluate(item.path, local.size);
      if (!filter.sync) {
        actions.push({ type: 'skip', path: item.path, reason: filter.reason, rule: filter.rule, size: filter.size });
        continue;
      }
      actions.push({ type: 'push', path: item.path, reason: 'retry-revalidated' });
      continue;
    }
    if (!await validation.inspectRemote(item.path)) {
      actions.push({ type: 'skip', path: item.path, reason: '远端文件已不存在', rule: 'remote-missing', size: 0 });
      continue;
    }
    actions.push({ type: 'pull', path: item.path, reason: 'retry-revalidated' });
  }
  return actions;
}
