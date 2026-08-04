import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SynxSyncPlugin from './main.js';
import type { SyncReport, SyncReportItem } from './syncReport.js';

export const SYNC_DETAILS_VIEW_TYPE = 'synx-sync-details';

/** 同步详情日志最多显示条数：跨所有保留报告合并后取最近 N 条（不含跳过） */
const MAX_LOG_ENTRIES = 500;

type ReportFilter = 'all' | 'failed' | 'success' | 'conflict';

/** 日志条目 + 所属报告（跨报告合并后仍能定位到报告，用于重试/复制错误） */
interface LogEntry {
  report: SyncReport;
  item: SyncReportItem;
}

export class SyncDetailsView extends ItemView {
  private filter: ReportFilter = 'all';

  constructor(leaf: WorkspaceLeaf, private plugin: SynxSyncPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_DETAILS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Synx 同步详情';
  }

  getIcon(): string {
    return 'activity';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.createEl('h3', { text: 'Synx 同步详情' });
    const reports = this.plugin.getSyncReports();
    const current = this.plugin.getCurrentSyncReport();
    const selected = current ?? reports[0] ?? null;
    const entries = this.collectLogEntries(reports);
    this.renderToolbar(container, entries);
    if (!selected) {
      container.createEl('p', { text: '暂无同步报告' });
      return;
    }
    const visible = entries.filter((entry) => this.matchesFilter(entry.item));
    container.createEl('p', { text: this.summary(reports, visible) });
    this.renderBackups(container, selected);
    if (visible.length === 0) container.createEl('p', { text: '当前筛选没有项目' });
    for (const entry of visible) this.renderItem(container, entry.report, entry.item);
  }

  /**
   * 跨所有保留报告合并日志条目：只保留成功/失败/冲突（不显示跳过），
   * 按结束时间倒序取最近 MAX_LOG_ENTRIES 条。
   */
  private collectLogEntries(reports: readonly SyncReport[]): LogEntry[] {
    return reports
      .flatMap((report) => report.items.map((item) => ({ report, item })))
      .filter((entry) => entry.item.status !== 'skipped')
      .sort((a, b) => b.item.endedAt - a.item.endedAt)
      .slice(0, MAX_LOG_ENTRIES);
  }

  private renderToolbar(container: HTMLElement, entries: LogEntry[]): void {
    const toolbar = container.createDiv({ cls: 'synx-report-toolbar' });
    const filters: Array<[ReportFilter, string]> = [['all', '全部'], ['failed', '失败'], ['success', '成功'], ['conflict', '冲突']];
    for (const [value, label] of filters) {
      const button = toolbar.createEl('button', { text: label });
      if (this.filter === value) button.addClass('mod-cta');
      button.onclick = () => {
        this.filter = value;
        this.render();
      };
    }
    const retryAll = toolbar.createEl('button', { text: '重试全部失败项' });
    const failedItems = entries.filter((entry) => entry.item.status === 'failed').map((entry) => entry.item);
    retryAll.disabled = failedItems.length === 0;
    retryAll.onclick = async () => {
      if (failedItems.length > 0) await this.plugin.retryReportItems(failedItems);
    };
    const clear = toolbar.createEl('button', { text: '清除报告' });
    clear.onclick = async () => {
      await this.plugin.clearSyncReports();
      this.render();
    };
  }

  private renderItem(container: HTMLElement, report: SyncReport, item: SyncReportItem): void {
    const row = container.createDiv({ cls: `synx-report-item synx-report-${item.status}` });
    row.createEl('strong', { text: item.path });
    const meta = [item.operation, item.status, `尝试 ${item.attempts} 次`];
    if (item.reason) meta.unshift(item.reason);
    row.createEl('div', { text: meta.join(' · ') });
    if (item.rule) row.createEl('div', { text: `规则：${item.rule}${item.size !== undefined ? ` · ${item.size} 字节` : ''}` });
    if (item.conflictPath) row.createEl('div', { text: `冲突副本：${item.conflictPath}` });
    if (item.error) {
      row.createEl('div', { text: `${item.error.message}${item.error.detail ? `（${item.error.detail}）` : ''}${item.error.status ? ` · HTTP ${item.error.status}` : ''}` });
    }
    const actions = row.createDiv({ cls: 'synx-report-actions' });
    if (item.status === 'failed') {
      actions.createEl('button', { text: '重试' }).onclick = async () => this.plugin.retryReportItems([item]);
    }
    actions.createEl('button', { text: '打开文件' }).onclick = async () => {
      await this.plugin.app.workspace.openLinkText(item.path, '', false);
    };
    if (item.error) {
      actions.createEl('button', { text: '复制错误' }).onclick = async () => {
        const detail = JSON.stringify({ reportId: report.id, path: item.path, operation: item.operation, error: item.error }, null, 2);
        await navigator.clipboard.writeText(detail);
        new Notice('错误详情已复制');
      };
    }
  }

  private matchesFilter(item: SyncReportItem): boolean {
    if (this.filter === 'all') return true;
    if (this.filter === 'conflict') return item.status === 'conflict' || item.operation === 'conflict';
    return item.status === this.filter;
  }

  private summary(reports: readonly SyncReport[], visible: LogEntry[]): string {
    let success = 0, failed = 0, conflicts = 0, deletions = 0;
    // 按原因聚合已执行项（push/pull/conflict，不含 skip），帮助诊断"为什么有这么多文件被同步"
    const reasonCounts = new Map<string, number>();
    for (const { item } of visible) {
      if (item.status === 'success') success++;
      if (item.status === 'failed') failed++;
      if (item.status === 'conflict') conflicts++;
      if (item.status === 'success' && (item.operation === 'delete-local' || item.operation === 'delete-remote')) deletions++;
      if (item.status === 'skipped') continue;
      const r = item.reason ?? '其他';
      reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    }
    const reasonStr = [...reasonCounts.entries()].map(([r, n]) => `${r} ${n}`).join(' · ');
    const phase = reports[0]?.phase;
    const head = phase ? `${phase} · ` : '';
    const base = `${head}日志 ${visible.length} 条 · 成功 ${success} · 失败 ${failed} · 冲突 ${conflicts}${deletions > 0 ? ` · 删除 ${deletions}` : ''}`;
    return reasonStr ? `${base} | ${reasonStr}` : base;
  }

  /** 渲染备份存储镜像结果段（主存储之外的容灾副本） */
  private renderBackups(container: HTMLElement, report: SyncReport): void {
    if (!report.backups || report.backups.length === 0) return;
    const section = container.createDiv({ cls: 'synx-backup-section' });
    section.createEl('h4', { text: '备份存储镜像' });
    for (const b of report.backups) {
      const row = section.createDiv({ cls: `synx-backup-row ${b.error ? 'synx-backup-failed' : (b.failed > 0 ? 'synx-backup-partial' : 'synx-backup-ok')}` });
      const name = b.storageName ?? b.storageId.slice(0, 8);
      const status = b.error ? `失败：${b.error.message}` : `推送 ${b.success}/${b.push}${b.failed > 0 ? `（失败 ${b.failed}）` : ''} · 跳过 ${b.skipped}`;
      row.createEl('div', { text: `${name} · ${status}` });
    }
  }
}
