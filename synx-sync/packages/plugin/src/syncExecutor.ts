import type { LocalVersionSnapshot } from './syncAlgo.js';
import { normalizeSyncError, type SyncErrorInfo } from './syncReport.js';

export type ExecutableSyncAction =
  | { type: 'push' | 'delete-remote' | 'delete-local'; path: string; reason: string; fileUuid?: string }
  | { type: 'pull'; path: string; reason: string; fileUuid?: string; expectedLocal?: LocalVersionSnapshot }
  | { type: 'skip'; path: string; reason: string; size?: number; rule?: string };

export interface SyncExecutionResult {
  path: string;
  operation: 'push' | 'pull' | 'delete-remote' | 'delete-local' | 'skip';
  status: 'success' | 'failed' | 'skipped';
  startedAt: number;
  endedAt: number;
  attempts: number;
  size?: number;
  rule?: string;
  error?: SyncErrorInfo;
}

export type SyncExecutorEvent =
  | { type: 'started'; action: ExecutableSyncAction }
  | { type: 'success' | 'failed' | 'skipped'; action: ExecutableSyncAction; result: SyncExecutionResult };

export class SyncExecutor {
  constructor(
    private concurrency: number,
    private runAction: (action: Exclude<ExecutableSyncAction, { type: 'skip' }>) => Promise<void>,
    private onEvent?: (event: SyncExecutorEvent) => void,
  ) {}

  async execute(actions: ExecutableSyncAction[]): Promise<SyncExecutionResult[]> {
    const results = new Array<SyncExecutionResult>(actions.length);
    const pathLocks = new Map<string, Promise<void>>();
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= actions.length) return;
        const action = actions[index];
        if (action.type === 'skip') {
          const now = Date.now();
          const result: SyncExecutionResult = { path: action.path, operation: 'skip', status: 'skipped', startedAt: now, endedAt: now, attempts: 0, size: action.size, rule: action.rule };
          results[index] = result;
          this.onEvent?.({ type: 'skipped', action, result });
          continue;
        }
        const previous = pathLocks.get(action.path) ?? Promise.resolve();
        let release!: () => void;
        const lock = new Promise<void>((resolve) => { release = resolve; });
        pathLocks.set(action.path, previous.then(() => lock));
        await previous;
        try {
          results[index] = await this.executeOne(action);
        } finally {
          release();
          if (pathLocks.get(action.path) === lock) pathLocks.delete(action.path);
        }
      }
    };
    const count = Math.max(1, Math.min(10, Math.floor(this.concurrency)));
    await Promise.all(Array.from({ length: Math.min(count, Math.max(1, actions.length)) }, worker));
    return results;
  }

  private async executeOne(action: Exclude<ExecutableSyncAction, { type: 'skip' }>): Promise<SyncExecutionResult> {
    const startedAt = Date.now();
    this.onEvent?.({ type: 'started', action });
    try {
      await this.runAction(action);
      const result: SyncExecutionResult = { path: action.path, operation: action.type, status: 'success', startedAt, endedAt: Date.now(), attempts: 1 };
      this.onEvent?.({ type: 'success', action, result });
      return result;
    } catch (error) {
      const normalized = normalizeSyncError(error);
      const result: SyncExecutionResult = { path: action.path, operation: action.type, status: 'failed', startedAt, endedAt: Date.now(), attempts: normalized.attempts ?? 1, error: normalized };
      this.onEvent?.({ type: 'failed', action, result });
      return result;
    }
  }
}
