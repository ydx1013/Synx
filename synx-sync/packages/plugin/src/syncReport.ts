import { WorkerApiError } from './workerClient.js';

export type SyncTrigger = 'manual' | 'timer' | 'startup' | 'save' | 'retry';
export type SyncOperation = 'push' | 'pull' | 'delete-remote' | 'delete-local' | 'skip' | 'conflict';
export type SyncItemStatus = 'success' | 'failed' | 'skipped' | 'conflict';
export type SyncPhase = 'scanning' | 'planning' | 'syncing' | 'completed' | 'partial-failure' | 'failed';
export type SyncErrorCategory = 'auth' | 'permission' | 'not-found' | 'conflict' | 'too-large' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'local-read' | 'local-write' | 'local-missing' | 'local-permission' | 'unknown';

export interface SyncErrorInfo {
  category: SyncErrorCategory;
  message: string;
  detail?: string;
  status?: number;
  attempts?: number;
}

export interface SyncReportItem {
  path: string;
  operation: SyncOperation;
  status: SyncItemStatus;
  startedAt: number;
  endedAt: number;
  attempts: number;
  size?: number;
  rule?: string;
  /** 同步决策原因（中文，用于诊断为何该文件被 push/pull/skip） */
  reason?: string;
  conflictPath?: string;
  error?: SyncErrorInfo;
}

export interface BackupSyncStats {
  storageId: string;
  storageName: string | null;
  /** 计划推送数（已剔除 pull/skip） */
  push: number;
  success: number;
  failed: number;
  skipped: number;
  /** 整个备份存储阶段失败时的错误信息（如 list 失败） */
  error?: SyncErrorInfo;
}

export interface SyncReport {
  id: string;
  trigger: SyncTrigger;
  startedAt: number;
  endedAt?: number;
  phase: SyncPhase;
  items: SyncReportItem[];
  stats: { success: number; failed: number; skipped: number; conflicts: number; push: number; pull: number; deleteLocal: number; deleteRemote: number };
  /** 备份存储镜像结果（主存储同步完成后填充） */
  backups: BackupSyncStats[];
}

export class SyncReportStore {
  private active: SyncReport | null = null;
  private history: SyncReport[];

  constructor(saved: SyncReport[], private retention: number) {
    this.history = saved.slice(0, retention);
    this.active = this.history[0] ?? null;
  }

  get current(): SyncReport | null {
    return this.active;
  }

  get reports(): readonly SyncReport[] {
    return this.history;
  }

  start(trigger: SyncTrigger, startedAt = Date.now()): SyncReport {
    this.active = {
      id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
      trigger,
      startedAt,
      phase: 'scanning',
      items: [],
      stats: { success: 0, failed: 0, skipped: 0, conflicts: 0, push: 0, pull: 0, deleteLocal: 0, deleteRemote: 0 },
      backups: [],
    };
    return this.active;
  }

  setPhase(phase: SyncPhase): void {
    if (this.active) this.active.phase = phase;
  }

  setPlannedCounts(push: number, pull: number): void {
    if (!this.active) return;
    this.active.stats.push = push;
    this.active.stats.pull = pull;
  }

  /** 记录一个备份存储的镜像结果（成功或整体失败） */
  recordBackup(stats: BackupSyncStats): void {
    if (!this.active) return;
    // 同一备份存储重复记录时替换（保留最后一次）
    this.active.backups = [...this.active.backups.filter((b) => b.storageId !== stats.storageId), stats];
  }

  addItem(item: SyncReportItem): void {
    if (!this.active) throw new Error('没有进行中的同步报告');
    const sanitized = sanitizeItem(item);
    this.active.items.push(sanitized);
    if (sanitized.status === 'success') this.active.stats.success++;
    if (sanitized.status === 'failed') this.active.stats.failed++;
    if (sanitized.status === 'skipped') this.active.stats.skipped++;
    if (sanitized.status === 'conflict') this.active.stats.conflicts++;
    if (sanitized.status === 'success' && sanitized.operation === 'delete-local') this.active.stats.deleteLocal++;
    if (sanitized.status === 'success' && sanitized.operation === 'delete-remote') this.active.stats.deleteRemote++;
  }

  finish(endedAt = Date.now()): SyncReport {
    if (!this.active) throw new Error('没有进行中的同步报告');
    this.active.endedAt = endedAt;
    this.active.phase = this.active.stats.failed > 0 ? 'partial-failure' : 'completed';
    this.history = [this.active, ...this.history.filter((report) => report.id !== this.active?.id)].slice(0, this.retention);
    return this.active;
  }

  clear(): void {
    this.history = [];
    this.active = null;
  }
}

/** syncAlgo 决策原因 → 中文标签（evaluateFile 的 reason 已是中文，原样返回） */
const SYNC_REASON_LABELS: Record<string, string> = {
  'local-only': '仅本地存在',
  'local-newer': '本地较新',
  'remote-only': '仅远端存在',
  'remote-newer': '远端较新',
  'in-sync': '两端一致',
  'conflict-keep-local': '冲突·保留本地',
  'same-mtime-diff-hash-skipped': '时间相同·内容不同',
  'local-deleted': '本地已删除',
  'remote-deleted': '远端已删除',
};

export function labelSyncReason(reason: string): string {
  return SYNC_REASON_LABELS[reason] ?? reason;
}

export function normalizeSyncError(error: unknown): SyncErrorInfo {
  if (error instanceof WorkerApiError) {
    const category = httpCategory(error.status);
    return { category, message: categoryMessage(category), detail: sanitizeDetail(error.message), status: error.status, attempts: error.attempts };
  }
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof record.code === 'string' ? record.code : '';
  if (code === 'ENOENT') return localError('local-missing', message);
  if (code === 'EACCES' || code === 'EPERM') return localError('local-permission', message);
  if (/timeout|timed out|abort/i.test(message)) return localError('timeout', message);
  if (error instanceof TypeError || /failed to fetch|network|offline/i.test(message)) return localError('network', message);
  return { category: 'unknown', message: categoryMessage('unknown'), detail: sanitizeDetail(message), attempts: 1 };
}

export function sanitizeDetail(detail: string): string {
  return detail
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|secret|token|accessKeyId|secretAccessKey|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}

function sanitizeItem(item: SyncReportItem): SyncReportItem {
  return {
    ...item,
    error: item.error ? {
      ...item.error,
      message: sanitizeDetail(item.error.message),
      detail: item.error.detail ? sanitizeDetail(item.error.detail) : undefined,
    } : undefined,
  };
}

function httpCategory(status: number): SyncErrorCategory {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too-large';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

function categoryMessage(category: SyncErrorCategory): string {
  const messages: Record<SyncErrorCategory, string> = {
    auth: '登录状态已过期，请重新登录', permission: '无权访问当前存储，请检查权限', 'not-found': '远端文件或版本不存在', conflict: '远端内容已变化，请重新同步', 'too-large': '文件超过服务端限制', 'rate-limit': '请求过于频繁，请稍后重试', server: '服务器或对象存储暂时异常', network: '网络连接失败，请检查网络', timeout: '请求超时，请稍后重试', 'local-read': '读取本地文件失败', 'local-write': '写入本地文件失败', 'local-missing': '本地文件已不存在', 'local-permission': '没有本地文件访问权限', unknown: '发生未知同步错误',
  };
  return messages[category];
}

function localError(category: SyncErrorCategory, detail: string): SyncErrorInfo {
  return { category, message: categoryMessage(category), detail: sanitizeDetail(detail), attempts: 1 };
}
