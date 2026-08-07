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

import { RuntimeBase, STATE_FILE, DIRECT_UPLOAD_THRESHOLD, OBS_DEBUG_FILE, MAX_GC_ROUNDS, dbg, type PersistedPluginData, type PrevSyncState, type SynxStateData } from './pluginRuntimeBase.js';

import { PluginUiRuntime } from './pluginUiRuntime.js';
export class PluginRuntime extends PluginUiRuntime {
  async load(): Promise<void> {
    await this.loadSettings();
    // 批量删除开关是一次性的：每次启动强制恢复关闭，防止用户开启后忘记关闭
    if (this.settings.allowBatchRemoteDelete) {
      this.settings.allowBatchRemoteDelete = false;
      await this.persist();
    }
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.onclick = () => void this.activateSyncDetails();
    this.addSettingTab(new SynxSettingTab(this.app, this.host as never));
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryPaneView(leaf, this.host as never));
    this.registerView(SYNC_DETAILS_VIEW_TYPE, (leaf) => new SyncDetailsView(leaf, this.host as never));
    this.registerEditorExtension(this.uuidEditorExtensions);
    this.updateUuidEditorExtension();
    this.registerMarkdownPostProcessor((element) => void this.renderPrivateImages(element));
    this.ribbonIcon = this.addRibbonIcon('refresh-cw', 'Synx 同步', () => void this.triggerSync());
    this.addCommand({ id: 'synx-sync-now', name: '立即同步', icon: 'refresh-cw', callback: () => void this.triggerSync() });
    this.addCommand({ id: 'synx-open-history', name: '打开版本历史', icon: 'history', callback: () => void this.activateHistoryPane() });
    this.addCommand({ id: 'synx-open-sync-details', name: '打开同步详情', icon: 'activity', callback: () => void this.activateSyncDetails() });
    this.addCommand({ id: 'synx-migrate-current-note-images', name: '将当前笔记图片迁移到 Synx 图库', icon: 'images', callback: () => void this.previewCurrentNoteImageMigration() });
    this.addCommand({ id: 'synx-migrate-folder-note-images', name: '迁移文件夹内笔记图片到 Synx 图库', icon: 'folder-up', callback: () => this.selectImageMigrationFolder() });
    this.registerDomEvent(document, 'paste', (event) => void this.handleImagePaste(event as ClipboardEvent), true);
    this.registerDomEvent(document, 'drop', (event) => void this.handleImageDrop(event as DragEvent), true);
    this.app.workspace.onLayoutReady(() => {
      void this.retryPendingImageUploads();
    });
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
    await this.updateHistoryIndexScope();
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

  async unload(): Promise<void> {
    this.scheduler?.dispose();
    await this.stopHistoryIndexSync();
    this.historyIndex.close();
  }

  public createCredentialRefreshHandlers(scope: { serverUrl: string; userId: string; jwt: string; storageId: string; syncFolder: string; credentialGeneration: number }) {
    const captured: CredentialRequestIdentity = { ...scope, client: this.workerClient, generation: scope.credentialGeneration };
    return { onCredentialsChanged: (credentials: StorageCredentialsResponse) => persistRefreshedStorageCredentials(
      credentials, captured,
      () => ({ jwt: this.settings.jwt, userId: this.settings.userId ?? '', storageId: this.settings.storageId ?? '', client: this.workerClient, generation: this.credentialCacheGeneration }),
      this.credentialCache, this.queueStateWrite,
    ).then(() => undefined) };
  }

}
