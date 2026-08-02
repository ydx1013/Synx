import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import type { Extension } from '@codemirror/state';
import type { Entity } from '@synx/shared';
import { evaluateFile } from './fileFilter.js';
import { conflictCopyPath, resolveConflict } from './conflict.js';
import { HistoryPaneView, HISTORY_VIEW_TYPE } from './historyPane.js';
import { ensureMarkdownUuid, extractMarkdownUuid, isMarkdownPath, replaceMarkdownUuid } from './markdownUuid.js';
import { hideMarkdownUuidExtension } from './markdownUuidEditor.js';
import { listObsConfigFiles } from './obsConfigLister.js';
import { loadPluginSettings, type SynxPluginSettings } from './settings.js';
import { SynxSettingTab } from './settingsTab.js';
import { hashContent, planSync, shouldProtectAgainstMassDeletion, type LocalFile, type PrevSyncEntry, type PrevSyncMap, type SyncAction, type SyncPlan } from './syncAlgo.js';
import { enqueueDeletion, pendingForTarget, type PendingDeletion } from './deletionQueue.js';
import { SyncDetailsView, SYNC_DETAILS_VIEW_TYPE } from './syncDetailsView.js';
import { SyncExecutor, type ExecutableSyncAction, type SyncExecutionResult } from './syncExecutor.js';
import { formatStatusBar } from './syncPresentation.js';
import { SyncReportStore, labelSyncReason, normalizeSyncError, type BackupSyncStats, type SyncReport, type SyncReportItem, type SyncTrigger } from './syncReport.js';
import { buildRetryActions } from './syncRetry.js';
import { SyncScheduler } from './syncScheduler.js';
import { WorkerClient } from './workerClient.js';

interface PersistedPluginData {
  settings: SynxPluginSettings;
}

interface PrevSyncState {
  version: 2;
  storageId: string;
  syncFolder: string;
  entries: { [path: string]: PrevSyncEntry };
}

interface SynxStateData {
  reports: readonly SyncReport[];
  pendingDeletions?: readonly PendingDeletion[];
  knownRemoteFiles?: readonly { storageId: string; syncFolder: string; path: string; fileUuid?: string }[];
  prevSync?: PrevSyncState;
}

function isPersistedData(raw: unknown): raw is PersistedPluginData {
  return typeof raw === 'object' && raw !== null && 'settings' in raw;
}

function isStateData(raw: unknown): raw is SynxStateData {
  return typeof raw === 'object' && raw !== null && 'reports' in raw;
}

const STATE_FILE = '.obsidian/plugins/synx-sync/synx-state.json';
// .obsidian 同步诊断日志：每次同步后写入 vault 根目录。
// 注意：必须写成 .md 后缀——iOS 文件 App / Obsidian 内只显示 .md 文件，
// .log 等附件后缀在移动端不可见（实测 iOS 只能看到 .md）。
// 文件名带设备名，避免两端同写 synx-debug.md 互相覆盖、看不出是谁写的。
// 该文件在 fileFilter 中被排除，不会被同步到远端。
// 说明：早期版本用固定名 synx-debug.md，现在用 getter 动态生成带设备名的文件名。
const OBS_DEBUG_FILE = 'synx-debug.md'; // 兼容旧版本号（用于事件忽略判断）

// #region debug-point Z:helper
// 之前版本把日志 POST 到 http://127.0.0.1:7777/event（本地调试服务器），
// 手机上该地址无人监听，日志全部丢失 → 排查 .obsidian 同步问题时"没有日志"。
// 改为 console.log：Obsidian 移动端开发者控制台 / 桌面端控制台可见。
function dbg(hyp: string, location: string, msg: string, data?: Record<string, unknown>): void {
  try {
    console.log(`[synx:dbg] [${hyp}] ${location}: ${msg}`, data ?? '');
  } catch { /* ignore */ }
}
// #endregion

export default class SynxSyncPlugin extends Plugin {
  settings!: SynxPluginSettings;
  private client: WorkerClient | null = null;
  private scheduler!: SyncScheduler;
  private reportStore!: SyncReportStore;
  private statusBarItem: HTMLElement | null = null;
  private ribbonIcon: HTMLElement | null = null;
  private remoteEntities: Entity[] = [];
  private pendingDeletions: PendingDeletion[] = [];
  private knownRemoteFiles: { storageId: string; syncFolder: string; path: string; fileUuid?: string }[] = [];
  private prevSync: PrevSyncState | null = null;
  private internalDeletes = new Set<string>();

  private uuidEditorExtensions: Extension[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    // 批量删除开关是一次性的：每次启动强制恢复关闭，防止用户开启后忘记关闭
    if (this.settings.allowBatchRemoteDelete) {
      this.settings.allowBatchRemoteDelete = false;
      await this.persist();
    }
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.onclick = () => void this.activateSyncDetails();
    this.addSettingTab(new SynxSettingTab(this.app, this));
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryPaneView(leaf, this));
    this.registerView(SYNC_DETAILS_VIEW_TYPE, (leaf) => new SyncDetailsView(leaf, this));
    this.registerEditorExtension(this.uuidEditorExtensions);
    this.updateUuidEditorExtension();
    this.ribbonIcon = this.addRibbonIcon('refresh-cw', 'Synx 同步', () => void this.triggerSync());
    this.addCommand({ id: 'synx-sync-now', name: '立即同步', icon: 'refresh-cw', callback: () => void this.triggerSync() });
    this.addCommand({ id: 'synx-open-history', name: '打开版本历史', icon: 'history', callback: () => void this.activateHistoryPane() });
    this.addCommand({ id: 'synx-open-sync-details', name: '打开同步详情', icon: 'activity', callback: () => void this.activateSyncDetails() });
    this.app.workspace.onLayoutReady(() => void this.ensureHistoryPane());
    for (const event of ['modify', 'create', 'rename'] as const) {
      this.registerEvent(this.app.vault.on(event as 'rename', (file) => {
        // 诊断日志写入 vault 根目录会触发 modify/create 事件，
        // 必须忽略，否则每次同步写日志 → 触发同步 → 再写日志，无限循环
        if (file?.path && (file.path === OBS_DEBUG_FILE || file.path.startsWith('synx-debug-'))) return;
        // #region debug-point A:vault-event
        dbg('A', 'main.ts:onload', `${event} vault event`, {
          path: file?.path ?? null,
          mtime: file instanceof TFile ? file.stat.mtime : null,
          size: file instanceof TFile ? file.stat.size : null,
          now: Date.now(),
        });
        // #endregion
        this.scheduler.notifySave();
      }));
    }
    this.registerEvent(this.app.vault.on('delete', (file) => void this.onLocalDelete(file)));
    this.rebuildClient();
    this.scheduler = new SyncScheduler(this.settings, async (trigger) => {
      // #region debug-point E:sync-timing
      const t0 = Date.now();
      dbg('E', 'main.ts:onload', 'runSync START', { trigger, ts: t0 });
      // #endregion
      await this.runSync(trigger);
      // #region debug-point E:sync-timing
      dbg('E', 'main.ts:onload', 'runSync END', { trigger, elapsedMs: Date.now() - t0, ts: Date.now() });
      // #endregion
    });
    this.scheduler.start();
    this.updateStatusBar();
  }

  onunload(): void {
    this.scheduler?.dispose();
  }

  async loadSettings(): Promise<void> {
    // data.json 只保存 settings（轻量、稳定）
    const raw = await this.loadData() as unknown;
    const structured = isPersistedData(raw);
    const settingsSource = structured ? raw.settings : raw;
    this.settings = loadPluginSettings(settingsSource, Platform.isMobile);
    // reports / pendingDeletions / knownRemoteFiles 从独立状态文件加载
    const state = await this.loadState();
    this.reportStore = new SyncReportStore([...state.reports], this.settings.reportRetention);
    this.pendingDeletions = [...(state.pendingDeletions ?? [])];
    this.knownRemoteFiles = [...(state.knownRemoteFiles ?? [])];
    this.prevSync = state.prevSync ?? null;
  }

  private async loadState(): Promise<SynxStateData> {
    try {
      const text = await this.app.vault.adapter.read(STATE_FILE);
      const raw = JSON.parse(text) as unknown;
      if (isStateData(raw)) return { reports: raw.reports, pendingDeletions: raw.pendingDeletions ?? [], knownRemoteFiles: raw.knownRemoteFiles ?? [], prevSync: raw.prevSync };
    } catch { /* 文件不存在或解析失败，返回空状态 */ }
    return { reports: [], pendingDeletions: [], knownRemoteFiles: [] };
  }

  async saveSettings(patch: Partial<SynxPluginSettings>): Promise<void> {
    this.settings = loadPluginSettings({ ...this.settings, ...patch }, Platform.isMobile);
    if (patch.reportRetention !== undefined) this.reportStore = new SyncReportStore([...this.reportStore.reports], this.settings.reportRetention);
    await this.persist();
    if (patch.serverUrl !== undefined || patch.jwt !== undefined || patch.storageId !== undefined || patch.syncFolder !== undefined) this.rebuildClient();
    if (patch.showMarkdownUuid !== undefined) this.updateUuidEditorExtension();
    this.scheduler?.updateSettings(this.settings);
    this.updateStatusBar();
  }

  private updateUuidEditorExtension(): void {
    this.uuidEditorExtensions.length = 0;
    if (!this.settings.showMarkdownUuid) this.uuidEditorExtensions.push(hideMarkdownUuidExtension);
    this.app.workspace.updateOptions();
  }

  getWorkerClient(): WorkerClient | null {
    return this.client;
  }

  async getFileUuid(path: string): Promise<string | undefined> {
    if (!isMarkdownPath(path)) return undefined;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    return extractMarkdownUuid(await this.app.vault.read(file)) ?? undefined;
  }

  getSyncReports(): readonly SyncReport[] {
    return this.reportStore.reports;
  }

  getCurrentSyncReport(): SyncReport | null {
    return this.reportStore.current;
  }

  async onLogin(): Promise<void> {
    this.rebuildClient();
  }

  async onStorageChanged(): Promise<void> {
    this.rebuildClient();
    await this.syncRetentionFromRemote();
    await this.triggerSync();
  }

  /** 从远端拉取当前 storage 的版本保留策略（远端为权威，覆盖本地显示） */
  async syncRetentionFromRemote(): Promise<void> {
    if (!this.client || !this.settings.storageId) return;
    try {
      const policy = await this.client.getRetentionPolicy();
      this.settings.retention = policy;
      await this.persist();
    } catch (error) {
      console.warn('synx: failed to fetch remote retention policy', error);
    }
  }

  async triggerSync(): Promise<void> {
    if (!this.client) {
      new Notice('Synx: 请先登录并选择存储');
      return;
    }
    const result = await this.scheduler.trigger('manual');
    // 已有同步在进行：明确告知已排队，避免「点按钮没反应」的困惑
    if (result === 'queued') new Notice('Synx: 已有同步正在进行，本次已加入队列，稍后自动执行');
  }

  rescheduleAutoSync(): void {
    this.scheduler?.updateSettings(this.settings);
  }

  async retryReportItems(items: SyncReportItem[]): Promise<void> {
    if (!this.client) {
      new Notice('Synx: 请先登录并选择存储');
      return;
    }
    this.remoteEntities = await this.client.list();
    const remotePaths = new Set(this.remoteEntities.map((entity) => entity.key.replace(/^\/+/, '')));
    const actions = await buildRetryActions(items, {
      inspectLocal: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? { exists: true, size: file.stat.size } : { exists: false, size: 0 };
      },
      inspectRemote: async (path) => remotePaths.has(path),
      evaluate: (path, size) => evaluateFile(path, size, this.settings),
    });
    await this.executeActions(actions, 'retry');
  }

  async clearSyncReports(): Promise<void> {
    this.reportStore.clear();
    await this.persist();
    this.updateViews();
    this.updateStatusBar();
  }

  async activateHistoryPane(): Promise<void> {
    await this.activateView(HISTORY_VIEW_TYPE);
  }

  async activateSyncDetails(): Promise<void> {
    await this.activateView(SYNC_DETAILS_VIEW_TYPE);
  }

  private rebuildClient(): void {
    const settings = this.settings;
    this.client = settings.serverUrl && settings.jwt && settings.storageId && settings.syncFolder ? new WorkerClient({
      serverUrl: settings.serverUrl,
      jwt: settings.jwt,
      storageId: settings.storageId,
      syncFolder: settings.syncFolder,
      onUnauthorized: () => this.handleUnauthorized(),
    }) : null;
    this.updateStatusBar();
    this.updateRibbonIcon();
    this.refreshHistoryPanes();
  }

  /** 刷新所有打开的历史面板。silent=true 时不显示 loading、不清空已有列表（用于同步后的静默刷新，避免闪烁） */
  private refreshHistoryPanes(silent = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof HistoryPaneView) void view.refresh(silent);
    }
  }

  private async onLocalDelete(file: TAbstractFile): Promise<void> {
    if (this.internalDeletes.delete(file.path)) return;
    // 诊断日志删除不触发同步
    if (file.path === OBS_DEBUG_FILE || file.path.startsWith('synx-debug-')) return;
    const storageId = this.settings.storageId;
    if (!(file instanceof TFile) || !storageId || !this.settings.syncFolder) {
      this.scheduler.notifySave();
      return;
    }
    const remote = this.knownRemoteFiles.find((item) =>
      item.storageId === storageId && item.syncFolder === this.settings.syncFolder && item.path === file.path,
    );
    if (remote) {
      this.pendingDeletions = enqueueDeletion(this.pendingDeletions, {
        storageId,
        syncFolder: this.settings.syncFolder,
        path: file.path,
        fileUuid: remote.fileUuid,
      });
      await this.persist();
    }
    this.scheduler.notifySave();
  }

  private async flushPendingDeletions(): Promise<void> {
    if (!this.client || !this.settings.storageId) return;
    const target = { storageId: this.settings.storageId, syncFolder: this.settings.syncFolder };
    for (const entry of pendingForTarget(this.pendingDeletions, target)) {
      await this.client.deleteFile(entry.path, entry.fileUuid);
      this.pendingDeletions = this.pendingDeletions.filter((item) => item !== entry);
      await this.persist();
    }
  }

  private handleUnauthorized(): void {
    new Notice('Synx: 登录已过期，请重新登录', 5000);
    void this.saveSettings({ jwt: '', userId: null, username: null, storageId: null, storageName: null });
  }

  private async runSync(trigger: SyncTrigger): Promise<void> {
    if (!this.client) return;
    this.reportStore.start(trigger);
    this.updateProgress();
    try {
      await this.flushPendingDeletions();
      const { files, skipped } = await this.enumerateLocalFiles();
      const rawRemote = await this.client.list();
      const targetFiles = rawRemote.map((entity) => ({
        storageId: this.settings.storageId!,
        syncFolder: this.settings.syncFolder,
        path: entity.key.replace(/^\/+/, ''),
        fileUuid: entity.fileUuid ?? undefined,
      }));
      this.knownRemoteFiles = [
        ...this.knownRemoteFiles.filter((item) => item.storageId !== this.settings.storageId || item.syncFolder !== this.settings.syncFolder),
        ...targetFiles,
      ];
      await this.persist();
      // 对远端列表同样应用过滤规则：被过滤掉的远端文件不参与同步计划，
      // 避免"关闭 syncConfigDir 后远端的 .obsidian/ 被拉回本地"的问题。
      // 与 remotely-save 行为一致：过滤后从 finalMappings 中删除。
      const { remote, skippedRemote } = this.filterRemoteEntities(rawRemote);
      this.remoteEntities = remote;
      this.reportStore.setPhase('planning');
      this.updateProgress();
      const prevSyncMap = this.getPrevSyncMap();
      // #region debug-point B:plan-inputs
      dbg('B', 'main.ts:runSync', 'plan inputs', {
        trigger,
        localCount: files.length,
        remoteCount: this.remoteEntities.length,
        hasPrevSync: !!prevSyncMap,
        prevSyncCount: prevSyncMap ? prevSyncMap.size : 0,
        storageId: this.settings.storageId,
        prevStorageId: this.prevSync?.storageId ?? null,
        syncFolder: this.settings.syncFolder,
        prevSyncFolder: this.prevSync?.syncFolder ?? null,
        syncConfigDir: this.settings.syncConfigDir,
      });
      // #endregion
      const plan = planSync(files, this.remoteEntities, 1000, prevSyncMap);
      // #region debug-point C:plan-per-file
      {
        const localByPath = new Map(files.map((f) => [f.path, f]));
        const remoteByPath = new Map(this.remoteEntities.map((e) => [e.key.replace(/^\/+/, ''), e]));
        for (const a of plan.actions) {
          if (a.type === 'skip') continue;
          const l = localByPath.get(a.path);
          const r = remoteByPath.get(a.path);
          const p = prevSyncMap?.get(a.path);
          dbg('C', 'main.ts:runSync', `plan ${a.type} ${a.reason}`, {
            path: a.path,
            lHash: l?.hash ?? null, lMtime: l?.mtime ?? null, lSize: l?.size ?? null, lUuid: l?.fileUuid ?? null,
            rHash: r?.hash ?? r?.etag ?? null, rMtime: r?.mtime ?? null, rSize: r?.size ?? null,
            pLocalHash: p?.localHash ?? null, pRemoteHash: p?.remoteHash ?? null,
            pLocalMtime: p?.localMtime ?? null, pRemoteMtime: p?.remoteMtime ?? null,
          });
        }
      }
      // #endregion
      // 防清空 vault 误删远端：本地文件数比上次同步骤降（低于设置阈值）时，
      // 默认把所有 delete-remote 转为 pull（拉回，不删）。只有用户在设置中打开
      // 「允许批量删除远端」开关，才真正执行 delete-remote。
      let guardedDeletes = 0;
      let guardedActions = plan.actions;
      const protectPercent = this.settings.massDeleteProtectPercent;
      if (
        prevSyncMap &&
        !this.settings.allowBatchRemoteDelete &&
        shouldProtectAgainstMassDeletion(files.length, prevSyncMap.size, protectPercent)
      ) {
        guardedActions = plan.actions.map((a) => {
          if (a.type !== 'delete-remote') return a;
          guardedDeletes++;
          return { type: 'pull', path: a.path, reason: 'remote-only', fileUuid: a.fileUuid };
        });
      }
      if (guardedDeletes > 0) {
        console.warn('synx: mass local deletion detected, protected remote files from delete', { local: files.length, prevSync: prevSyncMap?.size ?? 0, guarded: guardedDeletes, protectPercent });
        // #region debug-point B:mass-deletion-guard
        dbg('B', 'main.ts:runSync', 'MASS DELETION GUARDED', { localCount: files.length, prevSyncCount: prevSyncMap?.size ?? 0, guardedDeletes, protectPercent });
        // #endregion
      }
      const actions: ExecutableSyncAction[] = [
        ...skipped,
        ...skippedRemote,
        ...guardedActions.map((action) => ({ ...action })) as ExecutableSyncAction[],
      ];
      this.reportStore.setPlannedCounts(plan.stats.push, plan.stats.pull);
      await this.executeActions(actions, trigger, false);
      // 同步完成后静默刷新历史面板（不显示 loading、不清空，避免闪烁），
      // 让当前笔记的历史记录立即反映最新版本（含本次 pull 下来的内容）
      this.refreshHistoryPanes(true);
      const report = this.reportStore.current;
      if (report && report.stats.push === 0 && report.stats.pull === 0 && report.stats.failed === 0) new Notice('Synx: 已是最新，无需同步');
      // 写 .obsidian 同步诊断日志（移动端排查用）
      await this.writeObsSyncDebug(files, skipped, skippedRemote, plan, report);
      // 主存储同步完成后，把本地内容镜像到备份存储（仅 push，不 pull）
      await this.mirrorToBackupStorages(files);
      // 同步全部成功后重建 prevSync 快照（失败时不重建，下次同步重试）
      if (report?.stats.failed === 0) {
        await this.rebuildPrevSync();
      }
      // 备份结果写入持久化报告
      await this.persist();
    } catch (error) {
      const now = Date.now();
      const normalized = normalizeSyncError(error);
      // #region debug-point B:sync-error
      dbg('B', 'main.ts:runSync', 'runSync FAILED', {
        trigger,
        category: normalized.category,
        message: normalized.message,
        detail: normalized.detail ?? null,
        status: (normalized as { status?: number }).status ?? null,
        attempts: (normalized as { attempts?: number }).attempts ?? null,
        raw: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      // #endregion
      this.reportStore.setPhase('failed');
      this.reportStore.addItem({ path: '', operation: 'skip', status: 'failed', startedAt: now, endedAt: now, attempts: 1, error: normalized });
      this.reportStore.finish();
      if (this.reportStore.current) this.reportStore.current.phase = 'failed';
      new Notice(`Synx 同步失败：${normalized.message}`, 8000);
      await this.persist();
      this.updateProgress();
    }
  }

  private async enumerateLocalFiles(): Promise<{ files: LocalFile[]; skipped: ExecutableSyncAction[] }> {
    const files: LocalFile[] = [];
    const skipped: ExecutableSyncAction[] = [];
    for (const file of this.app.vault.getFiles()) {
      const result = evaluateFile(file.path, file.stat.size, this.settings);
      if (result.sync) {
        const fileUuid = isMarkdownPath(file.path)
          ? extractMarkdownUuid(await this.app.vault.read(file)) ?? undefined
          : undefined;
        const content = await this.app.vault.readBinary(file);
        files.push({ path: file.path, mtime: file.stat.mtime, size: file.stat.size, hash: await hashContent(content), fileUuid });
      }
      else skipped.push({ type: 'skip', path: file.path, reason: result.reason, rule: result.rule, size: result.size });
    }
    // .obsidian/ 配置目录：vault.getFiles() 不返回其中的文件，
    // 必须用 vault.adapter.list() 递归枚举
    if (this.settings.syncConfigDir) {
      const obsFiles = await listObsConfigFiles(this.app.vault, {
        configDir: '.obsidian',
        pluginId: this.manifest.id,
      });
      for (const f of obsFiles) {
        const result = evaluateFile(f.path, f.size, this.settings);
        if (result.sync) {
          const content = await this.app.vault.adapter.readBinary(f.path);
          files.push({ ...f, hash: await hashContent(content) });
        }
        else skipped.push({ type: 'skip', path: f.path, reason: result.reason, rule: result.rule, size: result.size });
      }
    }
    return { files, skipped };
  }

  /**
   * 对远端实体列表应用 evaluateFile 过滤。
   * 被过滤掉的远端文件不参与同步决策——既不 pull，也不删除，也不 push。
   * 这模仿了 remotely-save 从 finalMappings 中 delete 被过滤 key 的行为。
   */
  private filterRemoteEntities(entities: Entity[]): { remote: Entity[]; skippedRemote: ExecutableSyncAction[] } {
    const remote: Entity[] = [];
    const skippedRemote: ExecutableSyncAction[] = [];
    for (const entity of entities) {
      const path = entity.key.replace(/^\/+/, '');
      const result = evaluateFile(path, entity.size, this.settings);
      if (result.sync) remote.push(entity);
      else skippedRemote.push({ type: 'skip', path, reason: result.reason, rule: result.rule, size: result.size });
    }
    return { remote, skippedRemote };
  }

  private async executeActions(actions: ExecutableSyncAction[], trigger: SyncTrigger, startReport = true): Promise<void> {
    if (startReport) this.reportStore.start(trigger);
    this.reportStore.setPhase('syncing');
    const push = actions.reduce((count, action) => count + (action.type === 'push' ? 1 : 0), 0);
    const pull = actions.reduce((count, action) => count + (action.type === 'pull' ? 1 : 0), 0);
    if (startReport) this.reportStore.setPlannedCounts(push, pull);
    const executor = new SyncExecutor(this.settings.concurrency, (action) => this.executeAction(action), (event) => {
      if ('result' in event) {
        this.reportStore.addItem(this.toReportItem(event.result, event.action));
        this.updateProgress();
      }
    });
    await executor.execute(actions);
    const report = this.reportStore.finish();
    await this.persist();
    this.updateProgress();
    new Notice(`Synx 完成：成功 ${report.stats.success}，失败 ${report.stats.failed}，跳过 ${report.stats.skipped}`, 4000);
  }

  /**
   * 把本地内容镜像到所有备份存储（仅 push，不 pull）。
   * 备份存储之间串行执行：避免本地磁盘读放大，单个失败不阻塞其他。
   * 主存储同步失败时本方法不会被调用。
   */
  private async mirrorToBackupStorages(localFiles: LocalFile[]): Promise<void> {
    const ids = this.settings.backupStorageIds.filter((id) => id && id !== this.settings.storageId);
    if (ids.length === 0) return;
    if (!this.settings.serverUrl || !this.settings.jwt || !this.settings.syncFolder) return;

    // 拉一次存储列表拿名字（失败则名字留空，不阻塞镜像）
    const nameMap = new Map<string, string>();
    try {
      const storages = await WorkerClient.listStorages(this.settings.serverUrl, this.settings.jwt);
      for (const s of storages) nameMap.set(s.id, s.name);
    } catch {
      // 名字拿不到不影响镜像
    }

    for (const storageId of ids) {
      await this.mirrorToBackupStorage(storageId, nameMap.get(storageId) ?? null, localFiles);
    }
  }

  /** 镜像单个备份存储：list → filter → planSync → 只取 push → execute */
  private async mirrorToBackupStorage(storageId: string, storageName: string | null, localFiles: LocalFile[]): Promise<void> {
    const backupClient = new WorkerClient({
      serverUrl: this.settings.serverUrl,
      jwt: this.settings.jwt,
      storageId,
      syncFolder: this.settings.syncFolder,
      onUnauthorized: () => this.handleUnauthorized(),
    });

    let stats: BackupSyncStats;
    try {
      const rawRemote = await backupClient.list();
      const { remote } = this.filterRemoteEntities(rawRemote);
      const plan = planSync(localFiles, remote);
      // ★ 只取 push 动作，丢弃所有 pull——备份存储永不反向覆盖本地
      const pushActions: ExecutableSyncAction[] = plan.actions
        .filter((a): a is Extract<SyncAction, { type: 'push' }> => a.type === 'push')
        .map((a) => ({ type: 'push' as const, path: a.path, reason: a.reason }));
      const skippedCount = plan.actions.filter((a) => a.type === 'skip').length;

      let success = 0;
      let failed = 0;
      const executor = new SyncExecutor(this.settings.concurrency, (action) => this.pushToClient(backupClient, action.path));
      const results = await executor.execute(pushActions);
      for (const r of results) {
        if (r.status === 'success') success++;
        else if (r.status === 'failed') failed++;
      }
      stats = { storageId, storageName, push: pushActions.length, success, failed, skipped: skippedCount };
    } catch (error) {
      // 整个备份存储阶段失败（如 list 失败）：记录错误，不抛出，不阻塞其他备份
      stats = { storageId, storageName, push: 0, success: 0, failed: 0, skipped: 0, error: normalizeSyncError(error) };
    }
    this.reportStore.recordBackup(stats);
    this.updateProgress();
  }

  private async executeAction(action: Exclude<ExecutableSyncAction, { type: 'skip' }>): Promise<void> {
    if (action.type === 'push') {
      const original = action as SyncAction;
      if (original.reason === 'conflict-keep-local') await this.executeOrdinaryConflict(action.path);
      else await this.executePush(action.path);
    } else if (action.type === 'pull') {
      await this.executePull(action.path, action.fileUuid);
    } else if (action.type === 'delete-remote') {
      if (!this.client) return;
      await this.client.deleteFile(action.path, action.fileUuid);
    } else {
      await this.deleteLocalFile(action.path);
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    if (path.startsWith('.obsidian/')) {
      this.internalDeletes.add(path);
      if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.internalDeletes.add(path);
      await this.app.vault.delete(file);
    }
  }

  private async executeOrdinaryConflict(path: string): Promise<void> {
    if (!this.client) return;
    const remote = this.remoteEntities.find((entity) => entity.key.replace(/^\/+/, '') === path);
    if (!remote) return;

    // .obsidian/ 内的文件不在 vault 追踪范围，用 adapter 获取 stat
    if (path.startsWith('.obsidian/')) {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.type !== 'file') return;
      const localMtime = stat.mtime > 0 ? stat.mtime : stat.ctime;
      const existingPaths = new Set<string>([
        ...this.app.vault.getFiles().map((file) => file.path),
        ...(await this.listObsPathsSafe()),
      ]);
      const resolution = resolveConflict({ path, localMtime, remoteMtime: remote.mtime, localType: 'file', remoteType: 'file' }, this.settings.conflictStrategy, this.settings.deviceName, Date.now(), existingPaths);
      if (resolution.paused) throw new Error('冲突策略要求暂停并报告');
      if (resolution.outcome === 'keep-local') {
        try {
          const remoteContent = await this.client.readFile(path);
          await this.writeLocalViaAdapter(resolution.conflictPath, remoteContent);
        } catch {
          // 远端 current 已丢失（版本被清理/manifest 不一致），退化为直接推送本地
        }
        await this.executePush(path);
      } else {
        try {
          const localContent = await this.app.vault.adapter.readBinary(path);
          await this.writeLocalViaAdapter(resolution.conflictPath, localContent);
          await this.executePull(path);
          return;
        } catch {
          // 远端内容拉不到时，退化为推送本地，避免冲突处理阻塞同步
        }
        await this.executePush(path);
      }
      return;
    }

    const local = this.app.vault.getAbstractFileByPath(path);
    if (!(local instanceof TFile)) return;
    const resolution = resolveConflict({ path, localMtime: local.stat.mtime, remoteMtime: remote.mtime, localType: 'file', remoteType: 'file' }, this.settings.conflictStrategy, this.settings.deviceName, Date.now(), new Set(this.app.vault.getFiles().map((file) => file.path)));
    if (resolution.paused) throw new Error('冲突策略要求暂停并报告');
    if (resolution.outcome === 'keep-local') {
      try {
        const remoteContent = await this.client.readFile(path);
        await this.writeLocal(resolution.conflictPath, remoteContent);
      } catch {
        // 远端 current 已丢失，退化为直接推送本地
      }
      await this.executePush(path);
    } else {
      try {
        const localContent = await this.app.vault.readBinary(local);
        await this.writeLocal(resolution.conflictPath, localContent);
        await this.executePull(path);
        return;
      } catch {
        // 远端内容拉不到时，退化为推送本地
      }
      await this.executePush(path);
    }
  }

  /** 缓存 .obsidian/ 路径列表，用于冲突路径命名避免覆盖 */
  private obsPathsCache: Set<string> | null = null;
  private async listObsPathsSafe(): Promise<string[]> {
    if (this.obsPathsCache) return [...this.obsPathsCache];
    if (!this.settings.syncConfigDir) return [];
    try {
      const files = await listObsConfigFiles(this.app.vault, {
        configDir: '.obsidian',
        pluginId: this.manifest.id,
      });
      this.obsPathsCache = new Set(files.map((f) => f.path));
      return [...this.obsPathsCache];
    } catch {
      return [];
    }
  }

  private async executePush(path: string): Promise<void> {
    if (!this.client) return;
    await this.pushToClient(this.client, path);
  }

  /**
   * 把本地 path 推送到指定 client（主存储或备份存储共用）。
   * .obsidian/ 内的文件用底层 adapter 读取；其余用 vault API。
   */
  private async pushToClient(client: WorkerClient, path: string): Promise<void> {
    console.log('synx push start', { path });
    // .obsidian/ 内的文件不在 vault 文件追踪范围，需用底层 adapter 读取
    if (path.startsWith('.obsidian/')) {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.type !== 'file') throw Object.assign(new Error('本地文件已不存在'), { code: 'ENOENT' });
      const content = await this.app.vault.adapter.readBinary(path);
      console.log('synx push .obsidian file', { path, size: content.byteLength });
      await client.writeFile(path, content, stat.mtime > 0 ? stat.mtime : stat.ctime, this.settings.deviceName);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw Object.assign(new Error('本地文件已不存在'), { code: 'ENOENT' });
    let content: ArrayBuffer;
    let fileUuid: string | undefined;
    if (isMarkdownPath(path)) {
      const text = await this.app.vault.read(file);
      const result = ensureMarkdownUuid(text);
      let finalText = result.text;
      // 仅当 UUID 来自已有注释（可能因复制笔记而重复）时才检测；
      // 新生成的 crypto.randomUUID 碰撞概率为零，跳过 O(N) 全文遍历
      const duplicate = result.changed ? false : await this.findDuplicateUuid(path, result.uuid);
      if (duplicate) {
        fileUuid = crypto.randomUUID();
        finalText = replaceMarkdownUuid(finalText, fileUuid);
      } else {
        fileUuid = result.uuid;
      }
      if (finalText !== text) await this.app.vault.modify(file, finalText);
      content = new TextEncoder().encode(finalText).buffer;
      // #region debug-point C:push-markdown
      dbg('C', 'main.ts:pushToClient', 'push markdown bytes', {
        path, uuid: fileUuid,
        textLen: text.length,
        finalTextLen: finalText.length,
        modified: finalText !== text,
        pushedHash: await hashContent(content),
        pushedSize: content.byteLength,
        mtime: file.stat.mtime,
        now: Date.now(),
      });
      // #endregion
      console.log('synx push markdown', { path, uuid: fileUuid, size: content.byteLength });
    } else {
      content = await this.app.vault.readBinary(file);
      console.log('synx push binary', { path, size: content.byteLength });
    }
    try {
      await client.writeFile(path, content, file.stat.mtime, this.settings.deviceName, fileUuid);
      console.log('synx push done', { path });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // "Failed to fetch" 通常是服务端 503/CORS 被浏览器拦截，给用户更明确的提示
      if (/Failed to fetch/i.test(msg)) {
        throw new Error('服务端不可用或网络中断（可能为 503/CORS），请检查 Worker 部署状态');
      }
      console.error('synx push failed', {
        path,
        fileSize: content.byteLength,
        base64Size: Math.ceil(content.byteLength * 4 / 3),
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: msg,
        errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 8).join('\n') : undefined,
      });
      throw error;
    }
  }

  private async findDuplicateUuid(path: string, uuid: string): Promise<boolean> {
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === path) continue;
      if (extractMarkdownUuid(await this.app.vault.read(candidate)) === uuid) return true;
    }
    return false;
  }

  /** .obsidian 写入后回读的实际 mtime（诊断 iOS 写 mtime 是否生效） */
  private obsWriteBackMtimes: Record<string, { expected: number; actual: number | null }> = {};

  private async executePull(path: string, fileUuid?: string): Promise<void> {
    if (!this.client) return;
    const remote = this.remoteEntities.find((entity) => entity.key.replace(/^\/+/, '') === path);
    const content = await this.client.readFile(path, undefined, fileUuid);
    // .obsidian/ 内的文件用 adapter 写入
    if (path.startsWith('.obsidian/')) {
      // 显式设置 mtime（模仿 remotely-save 的 adapter.writeBinary(key, content, { mtime, ctime })）。
      // 若不设置，iOS 上写入后 mtime=当前时间，下次同步会误判"本地更新"，
      // 反复 push/pull，且 Obsidian 检测到插件文件变化会热加载到写一半的文件 → 插件"打不开"。
      const expected = remote?.mtime ?? 0;
      await this.writeLocalViaAdapter(path, content, expected);
      // 回读 stat，诊断 iOS 是否真的写入了指定 mtime
      try {
        const st = await this.app.vault.adapter.stat(path);
        this.obsWriteBackMtimes[path] = { expected, actual: st?.mtime ?? null };
      } catch {
        this.obsWriteBackMtimes[path] = { expected, actual: null };
      }
      return;
    }
    const target = this.app.vault.getAbstractFileByPath(path);
    if (target instanceof TFolder) {
      const copyPath = conflictCopyPath(path, this.settings.deviceName, Date.now(), new Set(this.app.vault.getFiles().map((file) => file.path)));
      await this.writeLocal(copyPath, content);
      return;
    }
    if (target instanceof TFile) await this.app.vault.modifyBinary(target, content);
    else await this.writeLocal(path, content);
  }

  private async writeLocal(path: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParentDir(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, content);
    else await this.app.vault.createBinary(path, content);
  }

  /** 写入 .obsidian/ 等非 vault 追踪路径，使用底层 adapter；mtime>0 时显式设置写入时间戳 */
  private async writeLocalViaAdapter(path: string, content: ArrayBuffer, mtime = 0): Promise<void> {
    await this.ensureParentDirViaAdapter(path);
    if (mtime > 0) {
      await this.app.vault.adapter.writeBinary(path, content, { mtime, ctime: mtime });
    } else {
      await this.app.vault.adapter.writeBinary(path, content);
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  /** 为 .obsidian/ 等路径递归创建父目录，使用底层 adapter */
  private async ensureParentDirViaAdapter(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }

  private toReportItem(result: SyncExecutionResult, action?: ExecutableSyncAction): SyncReportItem {
    const isConflict = action && action.type === 'push' && (action as SyncAction).reason === 'conflict-keep-local';
    return {
      path: result.path,
      operation: isConflict ? 'conflict' : result.operation,
      status: isConflict && result.status === 'success' ? 'conflict' : result.status,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      attempts: result.attempts,
      size: result.size,
      rule: result.rule,
      reason: action ? labelSyncReason(action.reason) : undefined,
      error: result.error,
    };
  }

  /**
   * 写 .obsidian 同步诊断日志（每次同步后调用），便于移动端排查：
   * 本地/远端 .obsidian 文件数、被过滤的文件及原因、计划动作分布、执行失败项。
   * 文件位于插件目录，不会被同步到远端。
   */
  /** 带设备名的诊断文件名，如 synx-debug-obsidian-k9kpib.md（旧版固定 synx-debug.md 不再写入） */
  private get obsDebugFile(): string {
    return `synx-debug-${this.settings.deviceName}.md`;
  }

  private async writeObsSyncDebug(
    localFiles: LocalFile[],
    localSkipped: ExecutableSyncAction[],
    remoteSkipped: ExecutableSyncAction[],
    plan: SyncPlan,
    report: SyncReport | null,
  ): Promise<void> {
    try {
      const isObs = (p: string) => p.startsWith('.obsidian/');
      const localByPath = new Map(localFiles.map((f) => [f.path, f]));
      const remoteByPath = new Map(this.remoteEntities.map((e) => [e.key.replace(/^\/+/, ''), e]));
      // 记录每个 .obsidian 动作的明细（路径/原因/两端 hash·mtime·size），
      // 用于定位"反复 pull/push 抖动"——抖动会导致 Obsidian 热加载到写一半的插件文件。
      const planObs: Record<string, Array<Record<string, unknown>>> = {};
      for (const a of plan.actions) {
        if (!isObs(a.path)) continue;
        const l = localByPath.get(a.path);
        const r = remoteByPath.get(a.path);
        (planObs[a.type] ??= []).push({
          path: a.path,
          reason: (a as { reason?: string }).reason,
          lHash: l?.hash ?? null,
          lMtime: l?.mtime ?? null,
          lSize: l?.size ?? null,
          rHash: r?.hash ?? r?.etag ?? null,
          rMtime: r?.mtime ?? null,
          rSize: r?.size ?? null,
        });
      }
      const failedObs = (report?.items ?? [])
        .filter((item) => item.status === 'failed' && isObs(item.path))
        .map((item) => `${item.path}${item.error ? ` (${item.error.message})` : ''}`);
      const diag = {
        ts: new Date().toISOString(),
        device: this.settings.deviceName,
        syncConfigDir: this.settings.syncConfigDir,
        localObsCount: localFiles.filter((f) => isObs(f.path)).length,
        localObsSkipped: localSkipped.filter((a) => isObs(a.path)).map((a) => ({ path: a.path, reason: (a as { reason?: string }).reason })),
        remoteObsCount: this.remoteEntities.filter((e) => isObs(e.key.replace(/^\/+/, ''))).length,
        remoteObsSkipped: remoteSkipped.filter((a) => isObs(a.path)).map((a) => ({ path: a.path, reason: (a as { reason?: string }).reason })),
        planObs,
        executedObsFailed: failedObs,
        obsWriteBackMtimes: this.obsWriteBackMtimes,
      };
      await this.app.vault.adapter.write(
        this.obsDebugFile,
        `> [!note] Synx 同步诊断（.obsidian 配置目录）\n> 将本文件内容发给作者排查移动端看不到插件/主题的问题。\n\n\`\`\`json\n${JSON.stringify(diag, null, 2)}\n\`\`\`\n`,
      );
      console.log('[synx] .obsidian 同步诊断已写入', this.obsDebugFile, diag);
    } catch (error) {
      console.warn('[synx] 写 .obsidian 诊断日志失败', error instanceof Error ? error.message : String(error));
    }
  }

  private async persist(): Promise<void> {
    // #region debug-point A:persist
    dbg('A', 'main.ts:persist', 'persist (saveData + state)', {
      ts: Date.now(),
      settingsJsonLen: JSON.stringify(this.settings).length,
    });
    // #endregion
    // data.json 只保存 settings（不随同步报告频繁变化）
    await this.saveData({ settings: this.settings } satisfies PersistedPluginData);
    // 运行时状态单独存储，永不被同步
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    const state: SynxStateData = {
      reports: this.reportStore.reports,
      pendingDeletions: this.pendingDeletions,
      knownRemoteFiles: this.knownRemoteFiles,
      prevSync: this.prevSync ?? undefined,
    };
    try {
      await this.app.vault.adapter.write(STATE_FILE, JSON.stringify(state));
    } catch (error) {
      console.error('synx: failed to persist state', error);
    }
  }

  /** 获取当前存储的 prevSync 查找表；存储不匹配时返回 undefined（首次同步或切换存储） */
  private getPrevSyncMap(): PrevSyncMap | undefined {
    if (!this.prevSync) return undefined;
    if (this.prevSync.storageId !== this.settings.storageId || this.prevSync.syncFolder !== this.settings.syncFolder) {
      return undefined;
    }
    return new Map(Object.entries(this.prevSync.entries));
  }

  /** 同步成功后重建 prevSync 快照：重新枚举本地 + 重新 list 远端 */
  private async rebuildPrevSync(): Promise<void> {
    if (!this.client || !this.settings.storageId) return;
    // #region debug-point B:rebuild-prevsync
    const dbgT0 = Date.now();
    // #endregion
    try {
      const { files } = await this.enumerateLocalFiles();
      const remote = await this.client.list();
      const remoteMap = new Map<string, Entity>();
      const remoteUuidMap = new Map<string, Entity>();
      for (const r of remote) {
        const path = r.key.replace(/^\/+/, '');
        remoteMap.set(path, r);
        if (r.fileUuid) remoteUuidMap.set(r.fileUuid, r);
      }
      const entries: { [path: string]: PrevSyncEntry } = {};
      for (const l of files) {
        let r = remoteMap.get(l.path);
        if (!r && l.fileUuid) r = remoteUuidMap.get(l.fileUuid);
        entries[l.path] = {
          localMtime: l.mtime,
          remoteMtime: r ? r.mtime : l.mtime,
          size: l.size,
          localHash: l.hash,
          remoteHash: r?.hash ?? r?.etag ?? l.hash,
          remoteVersionId: r?.versionId,
          fileUuid: l.fileUuid,
        };
      }
      this.prevSync = {
        version: 2,
        storageId: this.settings.storageId,
        syncFolder: this.settings.syncFolder,
        entries,
      };
      // #region debug-point B:rebuild-prevsync
      dbg('B', 'main.ts:rebuildPrevSync', 'prevSync REBUILT', { entryCount: Object.keys(entries).length, elapsedMs: Date.now() - dbgT0 });
      // #endregion
    } catch (error) {
      console.error('synx: failed to rebuild prevSync', error);
      // #region debug-point B:rebuild-prevsync
      dbg('B', 'main.ts:rebuildPrevSync', 'prevSync REBUILD FAILED', { error: error instanceof Error ? error.message : String(error) });
      // #endregion
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarItem) return;
    if (!this.settings.showStatusBar) {
      this.statusBarItem.hide();
      return;
    }
    this.statusBarItem.show();
    this.statusBarItem.setText(formatStatusBar(!!this.client, this.reportStore.current));
  }

  private updateRibbonIcon(): void {
    if (!this.ribbonIcon) return;
    const report = this.reportStore.current;
    const isSyncing = report !== null && (report.phase === 'scanning' || report.phase === 'planning' || report.phase === 'syncing');
    if (isSyncing) {
      this.ribbonIcon.setAttribute('aria-label', 'Synx 同步中…');
      this.ribbonIcon.addClass('synx-ribbon-running');
      return;
    }
    this.ribbonIcon.removeClass('synx-ribbon-running');
    if (report?.phase === 'failed') this.ribbonIcon.setAttribute('aria-label', 'Synx 同步错误，点击重试');
    else if (!this.client) this.ribbonIcon.setAttribute('aria-label', 'Synx 未连接');
    else this.ribbonIcon.setAttribute('aria-label', 'Synx 就绪');
  }

  private updateProgress(): void {
    this.updateStatusBar();
    this.updateRibbonIcon();
    this.updateViews();
  }

  private updateViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_DETAILS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SyncDetailsView) view.render();
    }
  }

  private async ensureHistoryPane(): Promise<void> {
    const { workspace } = this.app;
    for (const leaf of workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) leaf.detach();
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType)[0];
    const leaf = existing ?? workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: viewType, active: true });
    workspace.revealLeaf(leaf);
  }
}