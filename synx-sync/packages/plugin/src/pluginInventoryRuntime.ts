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

import { PluginSyncRuntime } from './pluginSyncRuntime.js';

export class PluginInventoryRuntime extends PluginSyncRuntime {
  public async enumerateLocalFiles(prevSync?: PrevSyncMap): Promise<{ files: LocalFile[]; skipped: ExecutableSyncAction[] }> {
    const files: LocalFile[] = [];
    const skipped: ExecutableSyncAction[] = [];
    for (const file of this.app.vault.getFiles()) {
      const result = evaluateFile(file.path, file.stat.size, this.settings);
      if (result.sync) {
        // 快路径：文件相对上次同步未变（mtime+size 一致且上次有 hash）时，
        // 复用 prevSync 的 hash 与 uuid，跳过读取与 sha256 重算。
        const prev = prevSync?.get(file.path);
        if (isLocalFileUnchangedFromPrev(prev, file.stat.mtime, file.stat.size)) {
          files.push({ path: file.path, mtime: file.stat.mtime, size: file.stat.size, hash: prev!.localHash, fileUuid: prev!.fileUuid });
          continue;
        }
        // 变化的文件只读一次二进制：hash 用二进制，uuid 从解码文本中提取
        // （避免旧实现 read 文本 + readBinary 两次读取）。
        const content = await this.app.vault.readBinary(file);
        const fileUuid = isMarkdownPath(file.path)
          ? extractMarkdownUuid(new TextDecoder().decode(content)) ?? undefined
          : undefined;
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
          const prev = prevSync?.get(f.path);
          if (isLocalFileUnchangedFromPrev(prev, f.mtime, f.size)) {
            files.push({ path: f.path, mtime: f.mtime, size: f.size, hash: prev!.localHash, fileUuid: prev!.fileUuid });
            continue;
          }
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
  public filterRemoteEntities(entities: Entity[]): { remote: Entity[]; skippedRemote: ExecutableSyncAction[] } {
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

  /**
   * 执行动作列表（仅执行，不负责报告的 start/finish/Notice，由 runSync 统一收尾）。
   * push/delete-remote 只收集变更（blob 上传/删除记录），在 runSync 中一次性 finalize 提交；
   * pull/delete-local 立即执行（从仓库当前提交读内容写本地）。
   */
  public async executeActions(actions: ExecutableSyncAction[], client: RepositoryClient): Promise<void> {
    this.reportStore.setPhase('syncing');
    const push = actions.reduce((count, action) => count + (action.type === 'push' ? 1 : 0), 0);
    const pull = actions.reduce((count, action) => count + (action.type === 'pull' ? 1 : 0), 0);
    this.reportStore.setPlannedCounts(push, pull);
    const executor = new SyncExecutor(this.settings.concurrency, (action) => this.executeAction(action, client), (event) => {
      if ('result' in event) {
        this.reportStore.addItem(this.toReportItem(event.result, event.action));
        this.updateProgress();
      }
    });
    await executor.execute(actions);
  }

  /** 报告收尾：finish + 状态栏 + 通知（runSync / retry 共用） */
  public finishSyncReport(): SyncReport {
    const report = this.reportStore.finish();
    this.updateProgress();
    // 同步完成后仅极短提示，状态栏已显示详情
    if (report.stats.failed > 0) {
      new Notice(`Synx: ${report.stats.failed} 个文件失败`, 3000);
    } else if (this.protectedLocalCount > 0) {
      new Notice(`Synx: 已保护 ${this.protectedLocalCount} 个同步期间编辑的文件`, 2500);
    } else if (report.stats.success > 0) {
      new Notice(`Synx: 同步完成`, 1500);
    }
    return report;
  }

  /**
   * 拉取仓库基线：HEAD + 当前树。
   * 仓库未初始化时先 init（服务端把现有远端状态完整收进 initial 提交）。
   */
  public async ensureRepoBase(client: RepositoryClient): Promise<{ head: { commitId: string; generation: number }; tree: RepoFile[] }> {
    let resp = await client.repoHead();
    if (!resp.head) {
      await commitAndIndex(
        () => client.repoInit(this.settings.deviceName),
        this.historyIndex,
      );
      resp = await client.repoHead();
    }
    if (!resp.head) throw new Error('仓库初始化失败，请重试');
    return { head: { commitId: resp.head.commitId, generation: resp.head.generation }, tree: resp.tree };
  }

  /**
   * 把本地内容镜像到所有备份存储（仅 push，不 pull）。
   * 备份存储之间串行执行：避免本地磁盘读放大，单个失败不阻塞其他。
   * 主存储同步失败时本方法不会被调用。
   */
  public async mirrorToBackupStorages(localFiles: LocalFile[]): Promise<void> {
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

  /** 镜像单个备份存储：仓库树 → filter → planSync → 只取 push → 上传 blob + 原子提交 */
  public async mirrorToBackupStorage(storageId: string, storageName: string | null, localFiles: LocalFile[]): Promise<void> {
    const session = this.getLoginSessionSnapshot();
    const backupClient = new WorkerClient({
      serverUrl: session.serverUrl,
      jwt: session.jwt,
      storageId,
      syncFolder: this.settings.syncFolder,
      abortSignal: this.syncAbort.signal,
      onUnauthorized: () => this.handleUnauthorized(session),
      onAuthFailure: (status, failedStorageId) => this.handleAuthFailure(status, failedStorageId, session),
    });

    let stats: BackupSyncStats;
    try {
      // 拉备份存储仓库基线（未初始化则 init 收现有远端）
      let resp = await backupClient.repoHead();
      if (!resp.head) {
        await backupClient.repoInit(this.settings.deviceName);
        resp = await backupClient.repoHead();
      }
      if (!resp.head) throw new Error('备份仓库初始化失败');

      const tree = resp.tree;
      const { remote } = this.filterRemoteEntities(repoTreeToRemote(tree));
      const plan = planSync(localFiles, remote);
      // ★ 只取 push 动作，丢弃所有 pull——备份存储永不反向覆盖本地
      const pushActions: ExecutableSyncAction[] = plan.actions
        .filter((a): a is Extract<SyncAction, { type: 'push' }> => a.type === 'push')
        .map((a) => ({ type: 'push' as const, path: a.path, reason: a.reason }));
      const skippedCount = plan.actions.filter((a) => a.type === 'skip').length;

      let success = 0;
      let failed = 0;
      // 上传为不可变 blob 并收集（不逐文件提交）
      const uploads = new Map<string, RepoUploadedFile>();
      const executor = new SyncExecutor(this.settings.concurrency, (action) => this.uploadToClient(backupClient, action.path, uploads));
      const results = await executor.execute(pushActions);
      for (const r of results) {
        if (r.status === 'success') success++;
        else if (r.status === 'failed') failed++;
      }
      // 有失败时不产生原子提交（避免「报告失败但备份已部分变更」），下次镜像重试
      if (uploads.size > 0 && failed === 0) {
        const changes = buildRepoChanges([...uploads.values()], [], treeToMap(tree));
        try {
          await backupClient.finalizeCommit({
            baseCommitId: resp.head.commitId,
            baseGeneration: resp.head.generation,
            author: this.settings.deviceName,
            message: `镜像 ${changes.length} 个文件`,
            changes,
          });
          // 备份提交成功后，复用的未提交 blob 已被提交引用，移除对应待提交记录
          this.acknowledgeCommittedBlobUploads(storageId, changes.map((c) => c.path));
        } catch (error) {
          // 复用的未提交 blob 已被服务端 GC 清理（BLOB_MISSING）：作废记录，下次镜像重新上传
          if (isBlobMissingError(error)) this.invalidatePendingBlobUploads(storageId);
          throw error;
        }
      }
      stats = { storageId, storageName, push: pushActions.length, success, failed, skipped: skippedCount };
    } catch (error) {
      // 整个备份存储阶段失败（如 list/init 失败）：记录错误，不抛出，不阻塞其他备份
      stats = { storageId, storageName, push: 0, success: 0, failed: 0, skipped: 0, error: normalizeSyncError(error) };
    }
    this.reportStore.recordBackup(stats);
    this.updateProgress();
  }
}
