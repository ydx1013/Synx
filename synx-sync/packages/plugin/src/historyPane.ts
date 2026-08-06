import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SynxSyncPlugin from './main.js';
import { HistoryPreviewPopover, type HistoryPreviewMode } from './historyPreviewPopover.js';
import { mapHistoryEntries, type HistoryEntry } from './historyMapping.js';
import { WorkerApiError } from './workerClient.js';

export const HISTORY_VIEW_TYPE = 'synx-history-view';
const MAX_PRECACHE_VERSIONS = 3;
const MAX_PRECACHE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml', 'csv']);

/** 两个版本列表是否由同一组 commitId 构成（顺序无关）。用于 silent 刷新时判断是否需要重建 DOM。 */
function sameVersionSet(a: HistoryEntry[], b: HistoryEntry[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((v) => v.commitId));
  return b.every((v) => ids.has(v.commitId));
}

export class HistoryPaneView extends ItemView {
  private currentFile: string | null = null;
  private versions: HistoryEntry[] = [];
  private previewCache = new Map<string, string>();
  private currentTextCache = new Map<string, string>();
  private requestId = 0;
  /** 分页游标：非空表示还有更早的历史可加载 */
  private nextCursor: string | null = null;
  private loadingMore = false;
  private popover: HistoryPreviewPopover;

  constructor(leaf: WorkspaceLeaf, private plugin: SynxSyncPlugin) {
    super(leaf);
    this.popover = new HistoryPreviewPopover(this.app);
    this.addChild(this.popover);
  }

  getViewType() {
    return HISTORY_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Synx 历史';
  }

  getIcon() {
    return 'history';
  }

  async onOpen() {
    this.contentEl.addClass('synx-history-pane');
    this.registerEvent(this.app.workspace.on('file-open', (file) => this.selectFile(file?.path ?? null)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.selectFile(this.app.workspace.getActiveFile()?.path ?? null)));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file.path === this.currentFile) this.currentTextCache.delete(file.path);
    }));
    this.selectFile(this.app.workspace.getActiveFile()?.path ?? null);
  }

  async onClose() {
    this.popover.close();
  }

  renderCurrentStyle(): void {
    if (this.currentFile && this.versions.length > 0) this.renderVersions();
  }

  async refresh(silent = false) {
    const path = this.currentFile;
    const requestId = ++this.requestId;
    if (!path || !this.plugin.getRepositoryClient()) {
      if (!silent) this.renderEmpty();
      return;
    }
    const client = await this.plugin.getRepositoryClientAsync();
    if (!client) {
      if (!silent) this.renderEmpty();
      return;
    }
    // silent（同步后的自动刷新）：不清空、不显示 loading，避免闪烁；
    // 首次打开文件才显示"加载中"反馈
    if (!silent) this.renderLoading(path);
    try {
      const fileUuid = await this.plugin.getFileUuid(path);
      const identity = fileUuid ?? `path:${path}`;
      let history = await this.plugin.getHistoryIndex().getFileHistory(identity);
      // 后台索引尚未写入首批数据时走 Worker 回退，历史功能始终可用。
      if (history.headCommitId === null) {
        const remote = await client.repoFileHistory(path, fileUuid);
        history = {
          commits: remote.commits,
          changes: remote.changes,
          headCommitId: remote.headCommitId,
        };
      }
      if (requestId !== this.requestId || path !== this.currentFile) return;
      const next = mapHistoryEntries(history);
      const merged = next;
      this.nextCursor = null;
      // silent 刷新且版本列表完全没变：不触碰 DOM，视觉零变化
      if (silent && merged.length > 0 && sameVersionSet(this.versions, next)) {
        this.versions = next;
        return;
      }
      this.versions = merged;
      this.renderVersions();
      void this.precache(path, requestId);
    } catch (error) {
      if (requestId === this.requestId && !silent) this.renderError('加载历史失败', error);
    } finally {
      this.loadingMore = false;
    }
  }

  private selectFile(path: string | null) {
    if (path === this.currentFile) return;
    this.currentFile = path;
    this.versions = [];
    this.nextCursor = null;
    this.loadingMore = false;
    this.previewCache.clear();
    this.currentTextCache.clear();
    this.popover.close();
    void this.refresh();
  }

  private renderEmpty() {
    this.contentEl.empty();
    this.contentEl.createEl('h4', { text: 'Synx 版本历史' });
    if (!this.plugin.getRepositoryClient()) this.contentEl.createEl('p', { text: '请先在设置中登录并选择存储。' });
    else this.contentEl.createEl('p', { text: '打开一个文件以查看版本历史。' });
  }

  private renderLoading(path: string) {
    this.contentEl.empty();
    this.contentEl.createEl('h4', { text: 'Synx 版本历史' });
    this.contentEl.createEl('p', { text: `加载 ${path} 的历史...` });
  }

  private renderError(prefix: string, error: unknown) {
    this.contentEl.empty();
    this.contentEl.createEl('h4', { text: 'Synx 版本历史' });
    const message = error instanceof WorkerApiError
      ? `${prefix}: ${error.status} ${error.message}`
      : `${prefix}: ${(error as Error)?.message ?? String(error)}`;
    this.contentEl.createEl('p', { cls: 'synx-error', text: message });
  }

  private renderVersions() {
    this.contentEl.empty();
    this.contentEl.createEl('h4', { text: 'Synx 版本历史' });
    this.contentEl.createEl('p', { text: this.currentFile ?? '' });
    if (this.versions.length === 0) {
      this.contentEl.createEl('p', { text: '无版本记录。' });
      return;
    }
    const timeline = this.plugin.settings.historyStyle === 'timeline';
    const list = this.contentEl.createEl('ul', { cls: `synx-version-list${timeline ? ' synx-version-timeline' : ''}` });
    for (const version of this.versions) {
      const item = list.createEl('li', { cls: `synx-version-item${version.isCurrent ? ' is-current' : ''}` });
      if (timeline) item.createSpan({ cls: 'synx-version-dot', attr: { 'aria-hidden': 'true' } });
      const meta = item.createEl('div', { cls: 'synx-version-meta' });
      meta.createEl('span', { text: this.formatDate(version.createdAt) });
      if (version.isCurrent) meta.createEl('span', { text: '当前', cls: 'synx-tag-current' });
      meta.createEl('span', { text: `${(version.size / 1024).toFixed(1)}KB` });
      if (version.author) meta.createEl('span', { text: version.author, cls: 'synx-author' });
      const versionId = meta.createEl('span', { text: version.commitId.slice(0, 8), cls: 'synx-version-id' });
      versionId.title = version.commitId;
      const actions = item.createEl('div', { cls: 'synx-version-actions' });
      if (this.isTextFile(this.currentFile ?? '')) {
        this.addPreviewButton(actions, item, version, '与当前比较', 'diff');
        if (this.isMarkdownFile(this.currentFile ?? '')) this.addPreviewButton(actions, item, version, '阅读视图', 'render');
        this.addPreviewButton(actions, item, version, '源码', 'source');
      }
      if (!version.isCurrent && !version.deleted) {
        const rollback = actions.createEl('button', { text: '回滚', cls: 'mod-warning' });
        rollback.onclick = () => void this.rollbackTo(version);
      }
    }
    // 还有更早的历史：提供"加载更多"按钮（点击拉取下一页，不截断）
    if (this.nextCursor) {
      const more = this.contentEl.createEl('div', { cls: 'synx-version-more' });
      const button = more.createEl('button', { text: this.loadingMore ? '加载中…' : '加载更多' });
      button.disabled = this.loadingMore;
      button.onclick = () => {
        if (this.loadingMore) return;
        this.loadingMore = true;
        button.disabled = true;
        button.textContent = '加载中…';
        void this.refresh().then(() => {
          // refresh 内 finally 已复位 loadingMore 并重绘
        });
      };
    }
  }

  private addPreviewButton(actions: HTMLElement, anchor: HTMLElement, version: HistoryEntry, label: string, mode: HistoryPreviewMode) {
    const button = actions.createEl('button', { text: label });
    button.onclick = () => void this.openPreview(version, mode, anchor, button);
  }

  private async openPreview(version: HistoryEntry, mode: HistoryPreviewMode, anchor: HTMLElement, button: HTMLButtonElement) {
    const path = this.currentFile;
    if (!path) return;
    button.disabled = true;
    try {
      const [historicalText, currentText] = await Promise.all([
        this.getVersionText(path, version),
        mode === 'diff' ? this.getCurrentText(path) : Promise.resolve(''),
      ]);
      if (path !== this.currentFile) return;
      await this.popover.open({
        mode,
        title: mode === 'diff' ? '与当前版本比较' : mode === 'render' ? '阅读视图' : '源码',
        subtitle: `${this.formatDate(version.createdAt)} · ${version.commitId.slice(0, 8)}`,
        filePath: path,
        historicalText,
        currentText,
        anchor,
      });
    } catch (error) {
      new Notice(`加载历史版本失败：${(error as Error)?.message ?? String(error)}`, 6000);
    } finally {
      button.disabled = false;
    }
  }

  private async precache(path: string, requestId: number) {
    if (!this.isTextFile(path)) return;
    const recent = this.versions
      .filter((version) => version.size <= MAX_PRECACHE_BYTES)
      .slice(0, MAX_PRECACHE_VERSIONS);
    await Promise.all(recent.map(async (version) => {
      try {
        await this.getVersionText(path, version);
      } catch {
        return;
      }
    }));
    if (requestId !== this.requestId || path !== this.currentFile) return;
  }

  private async getVersionText(path: string, version: HistoryEntry): Promise<string> {
    const key = `${path}\0${version.commitId}`;
    const cached = this.previewCache.get(key);
    if (cached !== undefined) return cached;
    const client = await this.plugin.getRepositoryClientAsync();
    if (!client) throw new Error('尚未连接服务器');
    const content = new TextDecoder().decode(await client.repoContent(version.commitId, version.path || path));
    if (path === this.currentFile) this.previewCache.set(key, content);
    return content;
  }

  private async getCurrentText(path: string): Promise<string> {
    const cached = this.currentTextCache.get(path);
    if (cached !== undefined) return cached;
    const content = await this.app.vault.adapter.read(path);
    if (path === this.currentFile) this.currentTextCache.set(path, content);
    return content;
  }

  private isTextFile(path: string): boolean {
    return TEXT_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
  }

  private isMarkdownFile(path: string): boolean {
    const extension = path.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }

  private async rollbackTo(version: HistoryEntry) {
    const path = this.currentFile;
    if (!path) return;
    const targetCommitId = version.commitId;
    const targetPath = version.path || path;
    if (!confirm(`确认回滚到 ${targetCommitId.slice(0, 8)}? 将产生一个新版本作为当前。`)) return;
    try {
      await this.plugin.rollbackFile({ path, targetCommitId, targetPath });
      this.currentTextCache.clear();
      new Notice(`已回滚到 ${targetCommitId.slice(0, 8)}`);
      await this.refresh();
    } catch (error) {
      this.renderError('回滚失败', error);
    }
  }

  private formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }
}
