import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import { buildLineDiff } from './lineDiff.js';

export type HistoryPreviewMode = 'diff' | 'render' | 'source';

export interface HistoryPreviewOptions {
  mode: HistoryPreviewMode;
  title: string;
  subtitle: string;
  filePath: string;
  historicalText: string;
  currentText: string;
  anchor: HTMLElement;
}

export class HistoryPreviewPopover extends Component {
  private rootEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private dragCleanup: (() => void) | null = null;
  private renderComponent: Component | null = null;

  constructor(private app: App) {
    super();
  }

  async open(options: HistoryPreviewOptions): Promise<void> {
    this.close();
    this.rootEl = options.anchor.ownerDocument.body.createDiv({ cls: 'synx-history-popover' });
    this.rootEl.setAttribute('role', 'dialog');
    this.rootEl.setAttribute('aria-label', options.title);
    const header = this.rootEl.createDiv({ cls: 'synx-history-popover-header' });
    const titleGroup = header.createDiv({ cls: 'synx-history-popover-title-group' });
    titleGroup.createEl('strong', { text: options.title });
    titleGroup.createEl('span', { text: options.subtitle });
    const closeButton = header.createEl('button', { cls: 'clickable-icon synx-history-popover-close', attr: { 'aria-label': '关闭预览' } });
    setIcon(closeButton, 'x');
    closeButton.onclick = () => this.close();
    this.bodyEl = this.rootEl.createDiv({ cls: 'synx-history-popover-body' });
    this.positionAt(options.anchor);
    this.installDrag(header);
    await this.render(options);
  }

  close(): void {
    this.dragCleanup?.();
    this.dragCleanup = null;
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.rootEl?.remove();
    this.rootEl = null;
    this.bodyEl = null;
  }

  onunload(): void {
    this.close();
  }

  private async render(options: HistoryPreviewOptions): Promise<void> {
    if (!this.bodyEl) return;
    if (options.mode === 'source') {
      this.bodyEl.createEl('pre', { cls: 'synx-history-source' }).setText(options.historicalText);
      return;
    }
    if (options.mode === 'render') {
      this.renderComponent = new Component();
      this.renderComponent.load();
      await MarkdownRenderer.renderMarkdown(options.historicalText, this.bodyEl, options.filePath, this.renderComponent);
      return;
    }
    let lines;
    try {
      lines = buildLineDiff(options.historicalText, options.currentText);
    } catch (error) {
      this.bodyEl.createDiv({ cls: 'synx-history-diff-empty', text: (error as Error).message });
      return;
    }
    const changed = lines.some((line) => line.type !== 'context');
    if (!changed) {
      this.bodyEl.createDiv({ cls: 'synx-history-diff-empty', text: '该历史版本与当前版本内容相同。' });
      return;
    }
    const table = this.bodyEl.createDiv({ cls: 'synx-history-diff' });
    for (const line of lines) {
      const row = table.createDiv({ cls: `synx-history-diff-line is-${line.type}` });
      row.createSpan({ cls: 'synx-history-diff-number', text: line.oldLine?.toString() ?? '' });
      row.createSpan({ cls: 'synx-history-diff-number', text: line.newLine?.toString() ?? '' });
      row.createSpan({ cls: 'synx-history-diff-marker', text: line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ' });
      row.createEl('code', { cls: 'synx-history-diff-text', text: line.text || ' ' });
    }
  }

  private positionAt(anchor: HTMLElement): void {
    if (!this.rootEl) return;
    const view = anchor.ownerDocument.defaultView;
    if (!view) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(280, Math.min(760, view.innerWidth - 24, view.innerWidth * 0.55));
    const height = Math.max(220, Math.min(720, view.innerHeight - 24, view.innerHeight * 0.7));
    const left = Math.max(12, Math.min(rect.left - width - 12, view.innerWidth - width - 12));
    const top = Math.max(12, Math.min(rect.top - 24, view.innerHeight - height - 12));
    this.rootEl.style.width = `${width}px`;
    this.rootEl.style.height = `${height}px`;
    this.rootEl.style.left = `${left}px`;
    this.rootEl.style.top = `${top}px`;
  }

  private installDrag(handle: HTMLElement): void {
    if (!this.rootEl) return;
    const root = this.rootEl;
    const view = handle.ownerDocument.defaultView;
    if (!view) return;
    let sessionCleanup: (() => void) | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const onPointerMove = (moveEvent: PointerEvent) => {
        const maxLeft = Math.max(0, view.innerWidth - root.offsetWidth);
        const maxTop = Math.max(0, view.innerHeight - root.offsetHeight);
        root.style.left = `${Math.min(maxLeft, Math.max(0, moveEvent.clientX - offsetX))}px`;
        root.style.top = `${Math.min(maxTop, Math.max(0, moveEvent.clientY - offsetY))}px`;
      };
      sessionCleanup = () => {
        view.removeEventListener('pointermove', onPointerMove);
        view.removeEventListener('pointerup', sessionCleanup!);
        view.removeEventListener('pointercancel', sessionCleanup!);
        view.removeEventListener('blur', sessionCleanup!);
        sessionCleanup = null;
      };
      view.addEventListener('pointermove', onPointerMove);
      view.addEventListener('pointerup', sessionCleanup);
      view.addEventListener('pointercancel', sessionCleanup);
      view.addEventListener('blur', sessionCleanup);
    };
    handle.addEventListener('pointerdown', onPointerDown);
    this.dragCleanup = () => {
      sessionCleanup?.();
      handle.removeEventListener('pointerdown', onPointerDown);
    };
  }
}
