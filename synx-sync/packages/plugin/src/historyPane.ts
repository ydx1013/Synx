import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type { VersionRecord } from '@synx/shared';
import type SynxSyncPlugin from './main.js';
import { HistoryPreviewPopover, type HistoryPreviewMode } from './historyPreviewPopover.js';
import { WorkerApiError } from './workerClient.js';

export const HISTORY_VIEW_TYPE = 'synx-history-view';
const MAX_PRECACHE_VERSIONS = 3;
const MAX_PRECACHE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml', 'csv']);

/** 两个版本列表是否由同一组 versionId 构成（顺序无关）。用于 silent 刷新时判断是否需要重建 DOM。 */
function sameVersionSet(a: VersionRecord[], b: VersionRecord[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((v) => v.versionId));
  return b.every((v) => ids.has(v.versionId));
}

export class HistoryPaneView extends ItemView {
  private currentFile: string | null = null;
  private versions: VersionRecord[] = [];
  private previewCache = new Map<string, string>();
  private currentTextCache = new Map<string, string>();
  private requestId = 0;
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

  async refresh(silent = false) {
    const path = this.currentFile;
    const client = this.plugin.getWorkerClient();
    const requestId = ++this.requestId;
    if (!path || !client) {
      if (!silent) this.renderEmpty();
      return;
    }
    // silent（同步后的自动刷新）：不清空、不显示 loading，避免闪烁；
    // 首次打开文件才显示"加载中"反馈
    if (!silent) this.renderLoading(path);
    try {
      const fileUuid = await this.plugin.getFileUuid(path);
      const versions = await client.history(path, fileUuid);
      if (requestId !== this.requestId || path !== this.currentFile) return;
      const next = [...versions].sort((a, b) => b.createdAt - a.createdAt);
      // silent 刷新且版本列表完全没变：不触碰 DOM，视觉零变化
      if (silent && this.versions.length > 0 && sameVersionSet(this.versions, next)) {
        this.versions = next;
        return;
      }
      this.versions = next;
      this.renderVersions();
      void this.precache(path, requestId);
    } catch (error) {
      if (requestId === this.requestId && !silent) this.renderError('加载历史失败', error);
    }
  }

  private selectFile(path: string | null) {
    if (path === this.currentFile) return;
    this.currentFile = path;
    this.versions = [];
    this.previewCache.clear();
    this.currentTextCache.clear();
    this.popover.close();
    void this.refresh();
  }

  private renderEmpty() {
    this.contentEl.empty();
    this.contentEl.createEl('h4', { text: 'Synx 版本历史' });
    if (!this.plugin.getWorkerClient()) this.contentEl.createEl('p', { text: '请先在设置中登录并选择存储。' });
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
    const list = this.contentEl.createEl('ul', { cls: 'synx-version-list' });
    for (const version of this.versions) {
      const item = list.createEl('li', { cls: `synx-version-item${version.isCurrent ? ' is-current' : ''}` });
      const meta = item.createEl('div', { cls: 'synx-version-meta' });
      meta.createEl('span', { text: this.formatDate(version.createdAt) });
      if (version.isCurrent) meta.createEl('span', { text: '当前', cls: 'synx-tag-current' });
      meta.createEl('span', { text: `${(version.size / 1024).toFixed(1)}KB` });
      if (version.author) meta.createEl('span', { text: version.author, cls: 'synx-author' });
      const versionId = meta.createEl('span', { text: version.versionId, cls: 'synx-version-id' });
      versionId.title = version.versionId;
      const actions = item.createEl('div', { cls: 'synx-version-actions' });
      if (this.isTextFile(this.currentFile ?? '')) {
        this.addPreviewButton(actions, item, version, '与当前比较', 'diff');
        if (this.isMarkdownFile(this.currentFile ?? '')) this.addPreviewButton(actions, item, version, '阅读视图', 'render');
        this.addPreviewButton(actions, item, version, '源码', 'source');
      }
      if (!version.isCurrent) {
        const rollback = actions.createEl('button', { text: '回滚', cls: 'mod-warning' });
        rollback.onclick = () => void this.rollbackTo(version);
      }
    }
  }

  private addPreviewButton(actions: HTMLElement, anchor: HTMLElement, version: VersionRecord, label: string, mode: HistoryPreviewMode) {
    const button = actions.createEl('button', { text: label });
    button.onclick = () => void this.openPreview(version, mode, anchor, button);
  }

  private async openPreview(version: VersionRecord, mode: HistoryPreviewMode, anchor: HTMLElement, button: HTMLButtonElement) {
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
        subtitle: `${this.formatDate(version.createdAt)} · ${version.versionId}`,
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

  private async getVersionText(path: string, version: VersionRecord): Promise<string> {
    const key = `${path}\0${version.versionId}`;
    const cached = this.previewCache.get(key);
    if (cached !== undefined) return cached;
    const client = this.plugin.getWorkerClient();
    if (!client) throw new Error('尚未连接服务器');
    const content = new TextDecoder().decode(await client.readFile(path, version.versionId, version.fileUuid ?? undefined));
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

  private async rollbackTo(version: VersionRecord) {
    const client = this.plugin.getWorkerClient();
    if (!client || !this.currentFile) return;
    if (!confirm(`确认回滚到 ${version.versionId}? 将产生一个新版本作为当前。`)) return;
    try {
      const fileUuid = await this.plugin.getFileUuid(this.currentFile);
      const newVersion = await client.rollback(this.currentFile, version.versionId, fileUuid);
      const content = await client.readFile(this.currentFile, newVersion.versionId, fileUuid);
      const file = this.plugin.app.vault.getAbstractFileByPath(this.currentFile);
      if (file instanceof TFile) await this.plugin.app.vault.modifyBinary(file, content);
      this.currentTextCache.clear();
      new Notice(`已回滚到 ${version.versionId}，新版本: ${newVersion.versionId}`);
      await this.refresh();
    } catch (error) {
      this.renderError('回滚失败', error);
    }
  }

  private formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }
}
