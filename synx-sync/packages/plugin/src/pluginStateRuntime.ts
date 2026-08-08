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

import { RuntimeBase, STATE_FILE, DIRECT_UPLOAD_THRESHOLD, OBS_DEBUG_FILE, MAX_GC_ROUNDS, type PersistedPluginData, type PrevSyncState, type SynxStateData } from './pluginRuntimeBase.js';

import { PluginActionsRuntime } from './pluginActionsRuntime.js';

export class PluginStateRuntime extends PluginActionsRuntime {
  public toReportItem(result: SyncExecutionResult, action?: ExecutableSyncAction): SyncReportItem {
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
  public get obsDebugFile(): string {
    return `synx-debug-${this.settings.deviceName}.md`;
  }

  public async writeObsSyncDebug(
    localFiles: LocalFile[],
    localSkipped: ExecutableSyncAction[],
    remoteSkipped: ExecutableSyncAction[],
    plan: SyncPlan,
    report: SyncReport | null,
  ): Promise<void> {
    // 开关关闭则不生成诊断日志（默认关闭，仅调试时开启）
    if (!this.settings.enableDebugLog) return;
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

  public async persist(): Promise<void> {
    // data.json 只保存账号级 settings（不随同步报告频繁变化）。
    // 每设备独立状态（deviceName + 同步开关）剥离出去存 state，避免 data.json 跨设备同步时
    // 互相覆盖（否则会导致"本地新→push→远端新→pull"的同步抖动）。
    const { deviceName: _deviceName, periodicSyncEnabled: _periodicSyncEnabled, autoSyncIntervalMin: _autoSyncIntervalMin, startupSyncEnabled: _startupSyncEnabled, startupDelaySec: _startupDelaySec, saveSyncDelaySec: _saveSyncDelaySec, ...syncableSettings } = this.settings;
    await this.saveData({ settings: syncableSettings } satisfies PersistedPluginData);
    // 运行时状态 + 设备名 + 同步开关单独存储，永不被同步
    await this.persistState();
  }

  public buildState(): SynxStateData {
    return writeCredentialCacheToState<SynxStateData>({
      deviceName: this.settings.deviceName,
      periodicSyncEnabled: this.settings.periodicSyncEnabled,
      autoSyncIntervalMin: this.settings.autoSyncIntervalMin,
      startupSyncEnabled: this.settings.startupSyncEnabled,
      startupDelaySec: this.settings.startupDelaySec,
      saveSyncDelaySec: this.settings.saveSyncDelaySec,
      reports: this.reportStore.reports,
      pendingDeletions: this.pendingDeletions,
      knownRemoteFiles: this.knownRemoteFiles,
      prevSync: this.prevSync ?? undefined,
      pendingImageUploads: this.pendingImageUploads,
      pendingBlobUploads: this.pendingBlobUploads,
    }, this.credentialCache);
  }

  public async persistState(): Promise<void> {
    try {
      await this.queueStateWrite();
    } catch (error) {
      console.error('synx: failed to persist state', error);
    }
  }

  /** 获取当前存储的 prevSync 查找表；存储不匹配时返回 undefined（首次同步或切换存储） */
  public getPrevSyncMap(): PrevSyncMap | undefined {
    if (!this.prevSync) return undefined;
    if (this.prevSync.storageId !== this.settings.storageId || this.prevSync.syncFolder !== this.settings.syncFolder) {
      return undefined;
    }
    return new Map(Object.entries(this.prevSync.entries));
  }

  public invalidateProtectedPrevSyncEntries(): void {
    if (!this.prevSync || this.protectedLocalPaths.size === 0) return;
    this.prevSync = {
      ...this.prevSync,
      entries: withoutProtectedPrevSyncEntries(this.prevSync.entries, this.protectedLocalPaths),
    };
  }

  /** 同步成功后重建 prevSync 快照：重新枚举本地 + 用最近拉取的仓库树作为远端状态 */
  public async rebuildPrevSync(): Promise<void> {
    if (!this.repositoryClient || !this.settings.storageId) return;
    try {
      const { files } = await this.enumerateLocalFiles(this.getPrevSyncMap());
      const remote = repoTreeToRemote(this.repoTree);
      const remoteMap = new Map<string, Entity>();
      const remoteUuidMap = new Map<string, Entity>();
      for (const r of remote) {
        const path = r.key.replace(/^\/+/, '');
        remoteMap.set(path, r);
        if (r.fileUuid) remoteUuidMap.set(r.fileUuid, r);
      }
      const entries: { [path: string]: PrevSyncEntry } = {};
      const protectedConflictPaths = new Set(this.protectedConflictPaths.values());
      for (const l of files) {
        if (this.protectedLocalPaths.has(l.path) || protectedConflictPaths.has(l.path)) continue;
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
          basePath: r ? r.key.replace(/^\/+/, '') : undefined,
        };
      }
      this.prevSync = {
        version: 3,
        storageId: this.settings.storageId,
        baseCommitId: this.repoHeadCommitId ?? undefined,
        syncFolder: this.settings.syncFolder,
        entries,
      };
    } catch (error) {
      console.error('synx: failed to rebuild prevSync', error);
      if (this.prevSync?.version === 3) {
        this.prevSync = await clearAndQueuePersistSmartMergeBase(
          this.prevSync,
          (state) => { this.prevSync = state; },
          this.queueStateWrite,
        );
      }
    }
  }
}
