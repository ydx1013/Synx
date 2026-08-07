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
import { isRepoHeadConflict, uploadRepositoryBlob, type RepositoryClient } from './repositoryClient.js';
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

import { RuntimeBase, STATE_FILE, DIRECT_UPLOAD_THRESHOLD, OBS_DEBUG_FILE, MAX_GC_ROUNDS, dbg, isPersistedData, isStateData, changesRepositoryScope, type PersistedPluginData, type PrevSyncState, type SynxStateData } from './pluginRuntimeBase.js';

import { PluginImageRuntime } from './pluginImageRuntime.js';

export class PluginSettingsRuntime extends PluginImageRuntime {
  async loadSettings(): Promise<void> {
    // data.json 只保存 settings（轻量、稳定；deviceName 已在 persist 时剥离）
    const raw = await this.loadData() as unknown;
    const structured = isPersistedData(raw);
    const settingsSource = structured ? raw.settings : raw;
    this.settings = loadPluginSettings(settingsSource, Platform.isMobile);
    // 报告保留迁移：旧默认只保留 1 份，无法满足「同步详情显示最近 500 条日志」，把旧默认值提升到新默认
    if (this.settings.reportRetention === 1) this.settings.reportRetention = DEFAULT_REPORT_RETENTION;
    // reports / pendingDeletions / knownRemoteFiles / deviceName 从独立状态文件加载
    const state = await this.loadState();
    // deviceName 是每设备独立状态，保存在 state（不同步）。优先取本机保存的设备名；
    // 若 state 还没有（首次拆分或旧版升级），沿用旧版 data.json / 默认随机名，
    // 并随下一次 persist 写入 state 完成迁移。
    if (state.deviceName) this.settings.deviceName = state.deviceName;
    this.reportStore = new SyncReportStore([...state.reports], this.settings.reportRetention);
    this.pendingDeletions = [...(state.pendingDeletions ?? [])];
    this.knownRemoteFiles = [...(state.knownRemoteFiles ?? [])];
    this.prevSync = state.prevSync ?? null;
    this.pendingImageUploads = [...(state.pendingImageUploads ?? [])];
    this.credentialCache = readCredentialCacheFromState(state) ?? createCredentialCache();
    (this.host as { settings?: SynxPluginSettings }).settings = this.settings;
  }

  public async loadState(): Promise<SynxStateData> {
    try {
      const text = await this.app.vault.adapter.read(STATE_FILE);
      const raw = JSON.parse(text) as unknown;
      if (isStateData(raw)) return {
        deviceName: raw.deviceName,
        reports: raw.reports,
        pendingDeletions: raw.pendingDeletions ?? [],
        knownRemoteFiles: raw.knownRemoteFiles ?? [],
        prevSync: raw.prevSync,
        pendingImageUploads: raw.pendingImageUploads ?? [],
        credentialCache: readCredentialCacheFromState(raw),
      };
    } catch { /* 文件不存在或解析失败，返回空状态 */ }
    return { reports: [], pendingDeletions: [], knownRemoteFiles: [] };
  }

  async saveSettings(patch: Partial<SynxPluginSettings>): Promise<void> {
    if (changesRepositoryScope(patch)) {
      return this.repositoryWriteCoordinator.runExclusive(() => this.saveSettingsUnlocked(patch));
    }
    return this.saveSettingsUnlocked(patch);
  }

  public async saveSettingsForLoginSession(
    session: { serverUrl: string; jwt: string; userId: string | null },
    patch: Partial<SynxPluginSettings>,
  ): Promise<boolean> {
    return this.repositoryWriteCoordinator.runExclusive(async () => {
      if (
        session.serverUrl !== this.settings.serverUrl ||
        session.jwt !== this.settings.jwt ||
        session.userId !== this.settings.userId
      ) return false;
      await this.saveSettingsUnlocked(patch);
      return true;
    });
  }

  public async saveSettingsUnlocked(patch: Partial<SynxPluginSettings>): Promise<void> {
    const previousUserId = this.settings.userId;
    const previousSession = { jwt: this.settings.jwt, userId: this.settings.userId };
    this.settings = loadPluginSettings({ ...this.settings, ...patch }, Platform.isMobile);
    (this.host as { settings?: SynxPluginSettings }).settings = this.settings;
    const reconciledCache = reconcileCredentialCacheSession(this.credentialCache, previousSession, {
      jwt: this.settings.jwt,
      userId: this.settings.userId,
    });
    if (reconciledCache !== this.credentialCache) {
      this.credentialCacheGeneration++;
      this.directRepositoryResolver.invalidate();
    }
    this.credentialCache = reconciledCache;
    if (patch.reportRetention !== undefined) this.reportStore = new SyncReportStore([...this.reportStore.reports], this.settings.reportRetention);
    await this.persist();
    if (patch.serverUrl !== undefined || patch.jwt !== undefined || patch.storageId !== undefined || patch.syncFolder !== undefined) {
      this.rebuildClient();
      await this.updateHistoryIndexScope(previousUserId);
    }
    if (patch.showMarkdownUuid !== undefined) this.updateUuidEditorExtension();
    if (patch.historyStyle !== undefined) {
      for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof HistoryPaneView) view.renderCurrentStyle();
      }
    }
    this.scheduler?.updateSettings(this.settings);
    this.updateStatusBar();
  }

  public updateUuidEditorExtension(): void {
    this.uuidEditorExtensions.length = 0;
    if (!this.settings.showMarkdownUuid) this.uuidEditorExtensions.push(hideMarkdownUuidExtension);
    this.app.workspace.updateOptions();
  }

  getWorkerClient(): WorkerClient | null {
    return this.workerClient;
  }

  getRepositoryClient(): RepositoryClient | null {
    return this.repositoryClient;
  }

  async getRepositoryClientAsync(): Promise<RepositoryClient | null> {
    if (!this.workerClient) return null;
    const scope = this.getDirectRepositoryScope();
    return scope ? this.repositoryTransportSelector.getHistory(scope, this.workerClient) : this.workerClient;
  }

  async scanUnusedImages(): Promise<void> {
    if (!this.workerClient || !this.settings.imageGalleryId) {
      new Notice('请先选择默认图库');
      return;
    }
    const referenced = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      for (const path of collectReferencedImagePaths(content, this.settings.imageGalleryId)) referenced.add(path);
    }
    const images = await this.workerClient.scanGalleryOrphans(this.settings.imageGalleryId, [...referenced]);
    new Notice(images.length ? `发现 ${images.length} 张疑似未使用图片。请前往 Synx 网页后台确认删除。` : '未发现超过 30 天的疑似未使用图片', 10000);
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
    const session = {
      serverUrl: this.settings.serverUrl,
      jwt: this.settings.jwt,
      userId: this.settings.userId,
    };
    await loadLoginStorages(session, {
      getCurrentSession: () => ({
        serverUrl: this.settings.serverUrl,
        jwt: this.settings.jwt,
        userId: this.settings.userId,
      }),
      getCurrentStorage: () => ({ storageId: this.settings.storageId, storageName: this.settings.storageName }),
      listStorages: (current) => WorkerClient.listStorages(current.serverUrl, current.jwt),
      saveSettings: (patch) => this.saveSettingsForLoginSession(session, patch),
      notice: (message, timeout) => { new Notice(message, timeout); },
    });
    if (session.serverUrl === this.settings.serverUrl && session.jwt === this.settings.jwt && session.userId === this.settings.userId) {
      this.rebuildClient();
    }
  }

  async onStorageChanged(): Promise<void> {
    this.rebuildClient();
    await this.syncRetentionFromRemote();
    await this.triggerSync();
  }

  /** 从远端拉取当前 storage 的版本保留策略（远端为权威，覆盖本地显示） */
  async getStorageCredentials(): Promise<StorageCredentialsResponse | null> {
    const { jwt, userId, storageId } = this.settings;
    const client = this.workerClient;
    if (!jwt || !userId || !storageId || !client) return null;
    const context = { jwt, userId, storageId };
    const generation = this.credentialCacheGeneration;
    const request = { ...context, client, generation };
    const cached = this.credentialCache.entries[storageId];
    if (cached) {
      try {
        return await decryptStorageCredentials(cached, context, this.credentialCache.salt);
      } catch {
        this.credentialCacheGeneration++;
        delete this.credentialCache.entries[storageId];
        await this.persistState();
      }
    }
    const credentials = await client.getStorageCredentials();
    const current = { jwt: this.settings.jwt, userId: this.settings.userId, storageId: this.settings.storageId, client: this.workerClient, generation: this.credentialCacheGeneration };
    if (!current.userId || !current.storageId || !isCredentialRequestCurrent(request, { ...current, userId: current.userId, storageId: current.storageId })) return null;
    const encrypted = await encryptStorageCredentials(credentials, context, this.credentialCache.salt);
    const afterEncrypt = { jwt: this.settings.jwt, userId: this.settings.userId, storageId: this.settings.storageId, client: this.workerClient, generation: this.credentialCacheGeneration };
    if (!afterEncrypt.userId || !afterEncrypt.storageId || !isCredentialRequestCurrent(request, { ...afterEncrypt, userId: afterEncrypt.userId, storageId: afterEncrypt.storageId })) return null;
    this.credentialCache.entries[storageId] = encrypted;
    await this.persistState();
    return credentials;
  }

  async syncRetentionFromRemote(): Promise<void> {
    if (!this.workerClient || !this.settings.storageId) return;
    try {
      const policy = await this.workerClient.getRetentionPolicy();
      this.settings.retention = policy;
      await this.persist();
    } catch (error) {
      console.warn('synx: failed to fetch remote retention policy', error);
    }
  }

  async triggerSync(): Promise<void> {
    const readinessNotice = getRepositoryReadinessNotice(this.settings, this.repositoryClient !== null);
    if (readinessNotice) {
      new Notice(readinessNotice);
      return;
    }
    const result = await this.scheduler.trigger('manual');
    // 已有同步在进行：明确告知已排队，避免「点按钮没反应」的困惑
    if (result === 'queued') new Notice('Synx: 已有同步正在进行，本次已加入队列，稍后自动执行');
  }

  rescheduleAutoSync(): void {
    this.scheduler?.updateSettings(this.settings);
  }

}
