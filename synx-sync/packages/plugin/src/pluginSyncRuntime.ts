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

import { RuntimeBase, STATE_FILE, DIRECT_UPLOAD_THRESHOLD, OBS_DEBUG_FILE, MAX_GC_ROUNDS, type PersistedPluginData, type PrevSyncState, type SynxStateData } from './pluginRuntimeBase.js';

import { PluginConnectionRuntime } from './pluginConnectionRuntime.js';

export class PluginSyncRuntime extends PluginConnectionRuntime {
  public async runSync(trigger: SyncTrigger): Promise<void> {
    if (!this.workerClient) return;
    return this.repositoryWriteCoordinator.run((client) => {
      const worker = this.workerClient;
      if (!worker || worker.storageId !== this.settings.storageId || worker.syncFolder !== this.settings.syncFolder) {
        throw new Error('repository scope changed before sync started');
      }
      return this.runSyncUnlocked(trigger, client, worker);
    });
  }

  public async runSyncUnlocked(trigger: SyncTrigger, client: RepositoryClient, roundWorker: WorkerClient): Promise<void> {
    this.reportStore.start(trigger);
    this.updateProgress();
    try {
      const prevSyncMap = this.getPrevSyncMap();
      let { files, skipped, snapshot } = await refreshLocalSyncState(() => this.enumerateLocalFiles(prevSyncMap));
      this.syncStartSnapshot = snapshot;
      this.protectedLocalPaths.clear();
      this.protectedConflictPaths.clear();
      this.protectedLocalCount = 0;

      // 拉取仓库基线：HEAD + 当前树。仓库未初始化时先 init（把现有远端收进 initial 提交）。
      let repo = await this.ensureRepoBase(client);

      let plan: SyncPlan | null = null;
      let skippedRemote: ExecutableSyncAction[] = [];
      let attempt = 0;
      for (; attempt < 2; attempt++) {
        if (attempt > 0) {
          ({ files, skipped, snapshot } = await refreshLocalSyncState(() => this.enumerateLocalFiles(prevSyncMap)));
          this.syncStartSnapshot = snapshot;
        }
        this.repoUploads.clear();
        this.repoDeletes.clear();
        this.repoTree = repo.tree;
        this.repoHeadCommitId = repo.head.commitId;
        this.repoHeadGeneration = repo.head.generation;

        // 远端树 → 过滤（被过滤的远端文件不参与同步计划，保留现有行为）
        const remoteEntities = repoTreeToRemote(repo.tree);
        const { remote, skippedRemote: sr } = this.filterRemoteEntities(remoteEntities);
        skippedRemote = sr;
        this.remoteEntities = remote;
        // knownRemoteFiles 缓存：本地删除时判断"远端是否有该文件"
        const targetFiles = remote.map((entity: Entity) => ({
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

        this.reportStore.setPhase('planning');
        this.updateProgress();
        plan = planSync(files, this.remoteEntities, 1000, prevSyncMap);
        // 防清空 vault 误删远端：本地文件数比上次同步骤降（低于设置阈值）时，
        // 默认把所有 delete-remote 转为 pull（拉回，不删）。只有用户在设置中打开
        // 「允许批量删除远端」开关，才真正执行 delete-remote。
        let guardedDeletes = 0;
        let guardedActions = plan.actions;
        const protectPercent = this.settings.massDeleteProtectPercent;
        const prevSyncCount = prevSyncMap?.size ?? 0;
        const protectMass = !!prevSyncMap && !this.settings.allowBatchRemoteDelete;
        const remoteDeletionProtected = protectMass
          && shouldProtectAgainstMassDeletion(files.length, prevSyncCount, protectPercent);
        if (remoteDeletionProtected) {
          guardedActions = plan.actions.map((a) => {
            if (a.type !== 'delete-remote') return a;
            guardedDeletes++;
            return { type: 'pull', path: a.path, reason: 'remote-only', fileUuid: a.fileUuid };
          });
        }
        // delete-local 方向：远端可能整体丢失（清空/配置错配/仓库损坏）时，
        // 把所有 delete-local 转为 push（重新上传本地未变内容，不删本地）。
        let guardedLocalDeletes = 0;
        if (protectMass) {
          const deleteLocalCount = guardedActions.filter((a) => a.type === 'delete-local').length;
          if (shouldProtectAgainstMassLocalDeletion(deleteLocalCount, prevSyncCount, protectPercent)) {
            guardedActions = guardedActions.map((a) => {
              if (a.type !== 'delete-local') return a;
              guardedLocalDeletes++;
              return { type: 'push', path: a.path, reason: 'local-only' };
            });
          }
        }
        const revivedPaths = new Set(files.map((file) => file.path));
        for (const action of guardedActions) {
          if (action.type === 'push') revivedPaths.add(action.path);
        }
        await cancelRevivedPendingDeletions(
          this.pendingDeletions,
          { storageId: this.settings.storageId!, syncFolder: this.settings.syncFolder },
          revivedPaths,
          (queue) => { this.pendingDeletions = queue; },
          this.queueStateWrite,
          () => this.pendingDeletions,
        );
        // durable pending deletions 与计划 delete-remote 使用同一批量删除保护；
        // 受保护时不加入本轮提交，finalize 后自然也不会被确认移除。
        this.flushPendingDeletions(!remoteDeletionProtected);
        if (guardedDeletes > 0 || guardedLocalDeletes > 0) {
          console.warn('synx: mass deletion detected, protected data from deletion', { local: files.length, prevSync: prevSyncCount, guardedRemoteDeletes: guardedDeletes, guardedLocalDeletes, protectPercent });
        }
        const actions: ExecutableSyncAction[] = [
          ...(skipped as ExecutableSyncAction[]),
          ...skippedRemote,
          ...(guardedActions as SyncAction[]).map((action) => ({ ...action }) as ExecutableSyncAction),
        ];
        this.reportStore.setPlannedCounts(plan.stats.push, plan.stats.pull);
        await this.executeActions(actions, client);

        // 部分动作失败时不产生原子提交：成功的 push 会残留孤儿 blob（由 GC 清理），
        // 远端保持原状，避免「报告同步失败但远端已部分变更」的误判；下次同步会重试。
        const syncFailed = this.reportStore.current?.stats.failed ?? 0;
        if (syncFailed > 0) break;

        // 组装变更集：push 已上传为 blob、delete 已收集；pull/skip 不产生提交
        const changes = buildRepoChanges(
          [...this.repoUploads.values()],
          [...this.repoDeletes.entries()].map(([path, identity]) => ({ path, identity }) as RepoDelete),
          treeToMap(this.repoTree),
        );
        if (changes.length === 0) break;

        // CAS 原子提交；HEAD 已被其他设备推进（409）→ 重拉基线重新计划
        try {
          const result = await this.finalizeMainCommit({
            baseCommitId: repo.head.commitId,
            baseGeneration: repo.head.generation,
            author: this.settings.deviceName,
            message: `同步 ${changes.length} 个文件`,
            changes,
          }, client);
          await this.acknowledgePendingDeletions(changes);
          // 原子提交成功后，复用的未提交 blob 已被提交引用，移除对应待提交记录
          if (this.settings.storageId) this.acknowledgeCommittedBlobUploads(this.settings.storageId, changes.map((c) => c.path));
          repo = await updateRepoBaseAfterFinalize(result.head, this.repoTree, changes);
          this.repoHeadCommitId = repo.head.commitId;
          this.repoHeadGeneration = repo.head.generation;
          this.repoTree = repo.tree;
          break;
        } catch (error) {
          if (isRepoHeadConflict(error)) {
            repo = await this.ensureRepoBase(client);
            continue;
          }
          if (isBlobMissingError(error)) {
            // 复用的未提交 blob 已被服务端 GC 清理：finalizeMainCommit 已作废记录，
            // 这里重新拉基线并重新规划（重新上传），而不是让本次同步直接失败。
            repo = await this.ensureRepoBase(client);
            continue;
          }
          throw error;
        }
      }
      if (attempt >= 2) throw new Error('同步冲突过多（远端提交被其他设备持续推进），请稍后重试');
      // 同步完成后静默刷新历史面板（不显示 loading、不清空，避免闪烁），
      // 让当前笔记的历史记录立即反映最新版本（含本次 pull 下来的内容）
      this.refreshHistoryPanes(true);
      const report = this.finishSyncReport();
      // 写 .obsidian 同步诊断日志（移动端排查用）
      if (plan) await this.writeObsSyncDebug(files, skipped, skippedRemote, plan, report);
      // 收尾任务互不依赖，并行执行，缩短"最后一个文件后"的等待：
      // - 顺带触发一次垃圾回收：清理"任何提交都未引用"的孤儿内容对象 + 按保留
      //   策略做时间机器式历史裁剪。服务端单请求受子请求预算限制，长提交链一次
      //   跑不完（返回 more=true）→ 循环多轮驱动同一批清理收敛；受上限保护，
      //   剩余进度持久化在服务端，下次同步继续，不会卡死。静默执行，失败只记日志。
      // - 把本地内容镜像到备份存储（仅 push，不 pull）；多个备份存储之间仍串行，
      //   避免本地磁盘读放大，单个失败不阻塞其他。
      // 两者均为网络 IO 且失败都不影响主同步结果，故并行以缩短收尾等待。
      await Promise.all([
        (async () => {
          try {
            for (let i = 0; i < MAX_GC_ROUNDS; i++) {
              const gc = await roundWorker.repoGc();
              if (gc.deleted > 0 || gc.deletedCommits > 0 || gc.more) {
                console.info('synx: gc progress', gc);
              }
              if (!gc.more) break;
            }
          } catch (error) {
            console.warn('synx: gc after sync failed', error);
          }
        })(),
        this.mirrorToBackupStorages(files),
      ]);
      // 同步全部成功后重建 prevSync 快照（失败时不重建，下次同步重试）
      if (report?.stats.failed === 0) {
        await this.rebuildPrevSync();
      }
      // 备份结果写入持久化报告
      await this.persist();
    } catch (error) {
      if (isStorageCredentialError(error) && this.settings.storageId) {
        this.handleAuthFailure(error.status, this.settings.storageId);
      }
      const now = Date.now();
      const normalized = normalizeSyncError(error);
      this.reportStore.setPhase('failed');
      this.reportStore.addItem({ path: '', operation: 'skip', status: 'failed', startedAt: now, endedAt: now, attempts: 1, error: normalized });
      this.reportStore.finish();
      if (this.reportStore.current) this.reportStore.current.phase = 'failed';
      // 失败原因写入 vault 根部的诊断文件（synx-debug-* 被 fileFilter 排除，不会同步回传），
      // 便于排查"同步失败但 Notice 一闪而过"的情况。
      try {
        await this.app.vault.adapter.write(
          this.obsDebugFile,
          `> [!note] Synx 同步失败诊断（生成时间 ${new Date().toISOString()}）\n> 将本文件内容发给作者排查同步失败问题。\n\n\`\`\`json\n${JSON.stringify({ trigger, category: normalized.category, message: normalized.message, detail: normalized.detail ?? null, status: (normalized as { status?: number }).status ?? null, attempts: (normalized as { attempts?: number }).attempts ?? null, raw: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2)}\n\`\`\`\n`,
        );
      } catch (writeError) {
        console.warn('synx: failed to write sync failure log', writeError);
      }
      new Notice(`Synx 同步失败：${normalized.message}`, 5000);
      await this.persist();
      this.updateProgress();
    }
  }
}
