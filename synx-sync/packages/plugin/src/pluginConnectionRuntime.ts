import { App, FuzzySuggestModal, MarkdownView, Notice, Platform, Plugin, requestUrl, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import type { Extension } from '@codemirror/state';
import type { Entity } from '@synx/shared';
import type { RepoChange, RepoFile, RepoFinalizeRequest, RepoFinalizeResponse, StorageCredentialsResponse } from '@synx/shared';
import { evaluateFile } from './fileFilter.js';
import { conflictCopyPath, preserveRemoteConflictCopy, resolveConflict } from './conflict.js';
import { HistoryPaneView, HISTORY_VIEW_TYPE } from './historyPane.js';
import { HistoryIndex } from './historyIndex.js';
import { syncHistoryIndex } from './historyIndexSync.js';
import { ensureMarkdownUuid, extractMarkdownUuid, isMarkdownPath, replaceMarkdownUuid } from './markdownUuid.js';
import { hideMarkdownUuidExtension } from './markdownUuidEditor.js';
import { listObsConfigFiles } from './obsConfigLister.js';
import { loadPluginSettings, DEFAULT_REPORT_RETENTION, type SynxPluginSettings } from './settings.js';
import { SynxSettingTab } from './settingsTab.js';
import { hashContent, isLocalFileUnchangedFromPrev, planSync, shouldProtectAgainstMassDeletion, shouldProtectAgainstMassLocalDeletion, type LocalFile, type PrevSyncEntry, type PrevSyncMap, type SyncAction, type SyncPlan } from './syncAlgo.js';
import { acknowledgePendingDeletionsDurably, cancelRevivedPendingDeletions, collectPendingDeletions, enqueueDeletion, type PendingDeletion } from './deletionQueue.js';
import { SyncDetailsView, SYNC_DETAILS_VIEW_TYPE } from './syncDetailsView.js';
import { SyncExecutor, type ExecutableSyncAction, type SyncExecutionResult } from './syncExecutor.js';
import { formatStatusBar } from './syncPresentation.js';
import { SyncReportStore, labelSyncReason, normalizeSyncError, type BackupSyncStats, type SyncReport, type SyncReportItem, type SyncTrigger } from './syncReport.js';
import { buildRetryActions } from './syncRetry.js';
import { SyncScheduler } from './syncScheduler.js';
import { WorkerClient } from './workerClient.js';
import { isBlobMissingError, isRepoHeadConflict, uploadRepositoryBlob, type RepositoryClient } from './repositoryClient.js';
import { isStorageCredentialError, RepositoryTransportSelector } from './repositoryTransportSelector.js';
import { DirectRepositoryResolver } from './directRepositoryResolver.js';
import { RepositoryWriteCoordinator } from './repositoryWriteCoordinator.js';
import { buildRepoChanges, clearAndQueuePersistSmartMergeBase, commitAndIndex, refreshLocalSyncState, repoTreeToRemote, treeToMap, updateRepoBaseAfterFinalize, type RepoDelete, type RepoUploadedFile } from './repoSync.js';
import { uploadImageWithRetry } from './imageUpload.js';
import { applyImageReplacements, buildFolderMigrationPlan, containsAttachmentReference, findImageCandidates, isCurrentGalleryUrl, isSafeExternalImageUrl, type ImageCandidate } from './imageMigration.js';
import { collectReferencedImagePaths, pendingUploadKey, replaceExactEmbed, type PendingImageUpload } from './pendingImageUploads.js';
import { parsePrivateImageUrl } from './privateImage.js';
import { ConfirmModal } from './settingsTab.js';
import { clearCredentialCacheForAuthFailure, createCredentialCache, createSerialStateWriter, decryptStorageCredentials, encryptStorageCredentials, isCredentialRequestCurrent, persistRefreshedStorageCredentials, readCredentialCacheFromState, reconcileCredentialCacheSession, writeCredentialCacheToState, type CredentialCacheState, type CredentialRequestIdentity } from './credentialCache.js';
import { decideLocalWriteProtection, hasChangedMarkdownEditor, protectedPullConflictPath, withoutProtectedPrevSyncEntries, type LocalWriteProtection, type MarkdownEditorSnapshot, type SyncStartFileSnapshot } from './syncWriteGuard.js';
import { attemptSmartMarkdownMerge } from './smartMergeOrchestration.js';
import { getRepositoryReadinessNotice, loadLoginStorages } from './connectionReadiness.js';
import { loginSessionFromRepositoryScope, runForLoginSession, type LoginSessionSnapshot } from './loginSessionGuard.js';

import { RuntimeBase, STATE_FILE, DIRECT_UPLOAD_THRESHOLD, OBS_DEBUG_FILE, MAX_GC_ROUNDS, PLUGIN_DATA_FILE, isPersistedData, type PersistedPluginData, type PrevSyncState, type SynxStateData } from './pluginRuntimeBase.js';

import { PluginSettingsRuntime } from './pluginSettingsRuntime.js';
import type { RuntimeHost } from './pluginRuntimeBase.js';
export class PluginConnectionRuntime extends PluginSettingsRuntime {
  async retryReportItems(items: SyncReportItem[]): Promise<void> {
    const readinessNotice = getRepositoryReadinessNotice(this.settings, this.workerClient !== null);
    if (readinessNotice) {
      new Notice(readinessNotice);
      return;
    }
    return this.repositoryWriteCoordinator.run((client) => this.retryReportItemsUnlocked(items, client));
  }

  public async retryReportItemsUnlocked(items: SyncReportItem[], client: RepositoryClient): Promise<void> {
    // 拉仓库树作为远端状态（未初始化时先 init）
    const repo = await this.ensureRepoBase(client);
    const { files: retryFiles } = await this.enumerateLocalFiles(this.getPrevSyncMap());
    this.syncStartSnapshot = new Map(retryFiles.map((file: LocalFile) => [file.path, {
      exists: true,
      mtime: file.mtime,
      size: file.size,
      hash: file.hash,
    }]));
    this.protectedLocalPaths.clear();
    this.protectedConflictPaths.clear();
    this.protectedLocalCount = 0;
    this.repoTree = repo.tree;
    this.repoHeadCommitId = repo.head.commitId;
    this.repoHeadGeneration = repo.head.generation;
    this.repoUploads.clear();
    this.repoDeletes.clear();
    this.remoteEntities = repoTreeToRemote(repo.tree);
    const remotePaths = new Set(this.remoteEntities.map((entity) => entity.key.replace(/^\/+/, '')));
    const actions = await buildRetryActions(items, {
      inspectLocal: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? { exists: true, size: file.stat.size } : { exists: false, size: 0 };
      },
      inspectRemote: async (path) => remotePaths.has(path),
      evaluate: (path, size) => evaluateFile(path, size, this.settings),
    });
    this.reportStore.start('retry');
    await this.executeActions(actions, client);
    // 部分动作再次失败时不产生原子提交（避免「报告失败但远端已部分变更」）
    const syncFailed = this.reportStore.current?.stats.failed ?? 0;
    // 重试产生的变更也走原子提交
    const changes = buildRepoChanges(
      [...this.repoUploads.values()],
      [...this.repoDeletes.entries()].map(([path, identity]) => ({ path, identity }) as RepoDelete),
      treeToMap(this.repoTree),
    );
    if (syncFailed === 0 && changes.length > 0) {
      const result = await this.finalizeMainCommit({
        baseCommitId: repo.head.commitId,
        baseGeneration: repo.head.generation,
        author: this.settings.deviceName,
        message: `重试同步 ${changes.length} 个文件`,
        changes,
      }, client);
      this.reportStore.setCommitStatus('committed');
      // 原子提交成功后，复用的未提交 blob 已被提交引用，移除对应待提交记录
      if (this.settings.storageId) this.acknowledgeCommittedBlobUploads(this.settings.storageId, changes.map((c) => c.path));
      this.repoHeadCommitId = result.head.commitId;
      this.repoHeadGeneration = result.head.generation;
      this.refreshHistoryPanes(true);
    } else if (syncFailed === 0) {
      this.reportStore.setCommitStatus('not-needed');
    }
    this.finishSyncReport();
    this.invalidateProtectedPrevSyncEntries();
    // 拉取可能更新了 data.json（账号级配置同步）：重新加载设置，避免 persist() 覆盖刚拉取的配置
    if (this.wasDataFilePulled()) await this.reloadAccountSettingsFromDisk();
    await this.persist();
  }

  /** 本次同步是否拉取了插件数据文件（data.json）：拉取后需重新加载设置，避免内存旧值写回覆盖 */
  protected wasDataFilePulled(): boolean {
    const items = this.reportStore.current?.items ?? [];
    return items.some((item) => item.path === PLUGIN_DATA_FILE && item.operation === 'pull' && item.status === 'success');
  }

  /** 重新从磁盘读取 data.json 的账号级设置（保留每设备独立状态），使内存与磁盘一致。
   *  用于同步拉取更新了 data.json 之后，避免 persist() 把内存里的旧设置写回，
   *  覆盖刚拉取的配置（否则会形成"拉取→写回→互相覆盖"的死循环）。 */
  protected async reloadAccountSettingsFromDisk(): Promise<void> {
    try {
      const raw = await this.loadData() as unknown;
      const structured = isPersistedData(raw);
      const fresh = loadPluginSettings(structured ? raw.settings : raw, Platform.isMobile);
      // 每设备独立状态以内存（state 来源）为权威：data.json 不含这些字段
      fresh.deviceName = this.settings.deviceName;
      fresh.periodicSyncEnabled = this.settings.periodicSyncEnabled;
      fresh.autoSyncIntervalMin = this.settings.autoSyncIntervalMin;
      fresh.startupSyncEnabled = this.settings.startupSyncEnabled;
      fresh.startupDelaySec = this.settings.startupDelaySec;
      fresh.saveSyncDelaySec = this.settings.saveSyncDelaySec;
      const scopeChanged = fresh.serverUrl !== this.settings.serverUrl || fresh.jwt !== this.settings.jwt
        || fresh.userId !== this.settings.userId || fresh.storageId !== this.settings.storageId
        || fresh.syncFolder !== this.settings.syncFolder;
      this.settings = fresh;
      (this.host as { settings?: SynxPluginSettings }).settings = this.settings;
      this.scheduler?.updateSettings(this.settings);
      // 拉取到的配置切换了仓库作用域：重建客户端，让后续同步/历史使用新作用域
      if (scopeChanged) this.rebuildClient();
    } catch (error) {
      console.warn('synx: failed to reload settings after data.json pull', error);
    }
  }

  async rollbackFile(request: { path: string; targetCommitId: string; targetPath: string }): Promise<void> {
    return this.repositoryWriteCoordinator.run(async (client) => {
      const content = await client.repoContent(request.targetCommitId, request.targetPath);
      const repo = await this.ensureRepoBase(client);
      const mtime = Date.now();
      const hash = await hashContent(content);
      const blobId = await uploadRepositoryBlob(client, request.path, content, mtime, hash, DIRECT_UPLOAD_THRESHOLD);
      await this.finalizeMainCommit({
        baseCommitId: repo.head.commitId,
        baseGeneration: repo.head.generation,
        author: this.settings.deviceName,
        message: `回滚到 ${request.targetCommitId.slice(0, 8)}`,
        changes: [{
          identity: await this.getFileUuid(request.path) ?? `path:${request.path}`,
          operation: 'modify', path: request.path, blobId, hash, size: content.byteLength, mtime,
        }],
      }, client);
      const file = this.app.vault.getAbstractFileByPath(request.path);
      if (file instanceof TFile) await this.app.vault.modifyBinary(file, content);
    });
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

  getHistoryIndex(): HistoryIndex {
    return this.historyIndex;
  }

  public async finalizeMainCommit(input: RepoFinalizeRequest, client: RepositoryClient): Promise<RepoFinalizeResponse> {
    try {
      return await commitAndIndex(
        () => client.finalizeCommit(input),
        this.historyIndex,
      );
    } catch (error) {
      // 复用的未提交 blob 已被服务端 GC 清理（BLOB_MISSING）：
      // 作废该存储的待提交记录，让调用方重新规划并重新上传，而不是直接失败。
      if (isBlobMissingError(error)) {
        const storageId = (client as { storageId?: string }).storageId ?? this.settings.storageId;
        if (storageId) this.invalidatePendingBlobUploads(storageId);
      }
      throw error;
    }
  }

  public async updateHistoryIndexScope(previousUserId?: string | null): Promise<void> {
    await this.stopHistoryIndexSync();
    const userId = this.settings.userId;
    const accountChanged = previousUserId !== undefined && previousUserId !== userId;
    if (accountChanged && this.indexedUserId) {
      await this.historyIndex.clearAccount();
      this.indexedUserId = null;
    }
    if (!userId || !this.settings.jwt) {
      if (this.indexedUserId) await this.historyIndex.clearAccount();
      this.indexedUserId = null;
      return;
    }
    if (this.indexedUserId !== userId) {
      await this.historyIndex.openAccount(userId);
      this.indexedUserId = userId;
    }
    if (!this.settings.storageId || !this.settings.syncFolder || !this.workerClient) return;
    await this.historyIndex.setRepository(this.settings.storageId, this.settings.syncFolder);
    this.startHistoryIndexSync();
  }

  public startHistoryIndexSync(): void {
    const worker = this.workerClient;
    const scope = this.getDirectRepositoryScope();
    if (!worker || !scope || worker.storageId !== scope.storageId || worker.syncFolder !== scope.syncFolder) return;
    const controller = new AbortController();
    this.historyIndexAbort = controller;
    const task = (async () => {
      try {
        const preferred = await this.repositoryTransportSelector.getHistory(scope, worker);
        if (
          controller.signal.aborted
          || this.historyIndexAbort !== controller
          || this.workerClient !== worker
          || JSON.stringify(this.getDirectRepositoryScope()) !== JSON.stringify(scope)
        ) return;
        await syncHistoryIndex(preferred, worker, this.historyIndex, controller.signal);
        if (!controller.signal.aborted && this.historyIndexAbort === controller) this.refreshHistoryPanes(true);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('synx: history index update failed', error);
        }
      } finally {
        if (this.historyIndexAbort === controller) this.historyIndexAbort = null;
      }
    })();
    this.historyIndexSyncTask = task;
    void task.finally(() => {
      if (this.historyIndexSyncTask === task) this.historyIndexSyncTask = null;
    });
  }

  public async stopHistoryIndexSync(): Promise<void> {
    this.historyIndexAbort?.abort();
    const task = this.historyIndexSyncTask;
    if (task) await task;
  }

  public getDirectRepositoryScope() {
    const { serverUrl, userId, jwt, storageId, syncFolder } = this.settings;
    if (!serverUrl || !userId || !jwt || !storageId || !syncFolder) return null;
    return { serverUrl, userId, jwt, storageId, syncFolder, credentialGeneration: this.credentialCacheGeneration };
  }

  public async selectSyncRepositoryClient(): Promise<RepositoryClient> {
    if (!this.workerClient) throw new Error('Synx 客户端未就绪');
    const scope = this.getDirectRepositoryScope();
    return scope ? this.repositoryTransportSelector.selectSync(scope, this.workerClient) : this.workerClient;
  }

  public rebuildClient(): void {
    this.directRepositoryResolver.invalidate();
    this.repositoryTransportSelector.invalidate();
    const settings = this.settings;
    const session = this.getLoginSessionSnapshot();
    this.workerClient = settings.serverUrl && settings.jwt && settings.storageId && settings.syncFolder ? new WorkerClient({
      serverUrl: settings.serverUrl,
      jwt: settings.jwt,
      storageId: settings.storageId,
      syncFolder: settings.syncFolder,
      abortSignal: this.syncAbort.signal,
      onUnauthorized: () => this.handleUnauthorized(session),
      onAuthFailure: (status, storageId) => this.handleAuthFailure(status, storageId, session),
    }) : null;
    this.repositoryClient = this.workerClient;
    this.updateStatusBar();
    this.updateRibbonIcon();
    this.refreshHistoryPanes();
  }

  /** 刷新所有打开的历史面板。silent=true 时不显示 loading、不清空已有列表（用于同步后的静默刷新，避免闪烁） */
  public refreshHistoryPanes(silent = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof HistoryPaneView) void view.refresh(silent);
    }
  }

  public async onLocalDelete(file: TAbstractFile): Promise<void> {
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

  public flushPendingDeletions(allowed: boolean): PendingDeletion[] {
    if (!this.repositoryClient || !this.settings.storageId) return [];
    return collectPendingDeletions(
      this.pendingDeletions,
      { storageId: this.settings.storageId, syncFolder: this.settings.syncFolder },
      this.repoDeletes,
      allowed,
    );
  }

  public async acknowledgePendingDeletions(changes: readonly RepoChange[]): Promise<void> {
    if (!this.settings.storageId) return;
    await acknowledgePendingDeletionsDurably(
      this.pendingDeletions,
      { storageId: this.settings.storageId, syncFolder: this.settings.syncFolder },
      changes,
      (queue) => { this.pendingDeletions = queue; },
      this.queueStateWrite,
      () => this.pendingDeletions,
    );
  }

  public getLoginSessionSnapshot(): LoginSessionSnapshot {
    return {
      serverUrl: this.settings.serverUrl,
      jwt: this.settings.jwt,
      userId: this.settings.userId,
    };
  }

  public handleAuthFailure(status: 401 | 403, storageId: string, session: LoginSessionSnapshot = this.getLoginSessionSnapshot()): void {
    void this.repositoryWriteCoordinator.runExclusive(() => runForLoginSession(session, () => this.getLoginSessionSnapshot(), async () => {
      this.credentialCacheGeneration++;
      this.directRepositoryResolver.invalidate(status === 403 ? storageId : undefined);
      this.credentialCache = clearCredentialCacheForAuthFailure(this.credentialCache, status, storageId);
      await this.queueStateWrite();
    })).catch((error) => console.error('synx: failed to persist auth failure state', error));
  }

  public handleUnauthorized(session: LoginSessionSnapshot): void {
    void this.repositoryWriteCoordinator.runExclusive(() => runForLoginSession(session, () => this.getLoginSessionSnapshot(), async () => {
      await this.saveSettingsUnlocked({ jwt: '', userId: null, username: null, storageId: null, storageName: null });
      new Notice('Synx: 登录已过期，请重新登录', 5000);
    })).catch((error) => console.error('synx: failed to clear expired login session', error));
  }

}
