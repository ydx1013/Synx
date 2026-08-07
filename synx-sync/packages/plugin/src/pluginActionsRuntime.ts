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

import { PluginInventoryRuntime } from './pluginInventoryRuntime.js';

export class PluginActionsRuntime extends PluginInventoryRuntime {
  public async executeAction(action: Exclude<ExecutableSyncAction, { type: 'skip' }>, client: RepositoryClient): Promise<void | 'protected'> {
    if (action.type === 'push') {
      const original = action as SyncAction;
      if (original.reason === 'conflict-keep-local') {
        if (this.settings.conflictStrategy === 'smart-merge') return this.executeSmartConflict(original, client);
        await this.executeOrdinaryConflict(action.path, client);
      } else await this.executePush(action.path, client);
    } else if (action.type === 'pull') {
      return this.executePull(action.path, client, action.fileUuid);
    } else if (action.type === 'delete-remote') {
      // git 模型下删除 = 提交中的 delete 变更（原子，不再单独 deleteFile）
      this.repoDeletes.set(action.path, action.fileUuid ?? `path:${action.path}`);
    } else {
      return this.deleteLocalFile(action.path);
    }
  }

  public async deleteLocalFile(path: string): Promise<void | 'protected'> {
    const protection = await this.inspectLocalWriteProtection(path);
    if (protection !== 'safe') {
      this.recordProtectedLocalPath(path);
      return 'protected';
    }
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

  public async executeSmartConflict(action: Extract<SyncAction, { type: 'push' }>, client: RepositoryClient): Promise<void | 'protected'> {
    const path = action.path;
    const local = this.app.vault.getAbstractFileByPath(path);
    if (!(local instanceof TFile) || !this.repoHeadCommitId) {
      await this.executeOrdinaryConflict(path, client);
      return;
    }
    const existingPaths = new Set(this.app.vault.getFiles().map((file) => file.path));
    const conflictPath = conflictCopyPath(path, this.settings.deviceName, Date.now(), existingPaths);
    const protectedPath = protectedPullConflictPath(path, this.settings.deviceName, Date.now(), existingPaths);
    const result = await attemptSmartMarkdownMerge({
      path,
      baseCommitId: this.prevSync?.version === 3 ? this.prevSync.baseCommitId : undefined,
      basePath: action.basePath,
      readBase: (commitId, basePath) => client.repoContent(commitId, basePath),
      readLocal: () => this.app.vault.readBinary(local),
      readRemote: () => client.repoContent(this.repoHeadCommitId!, path),
      inspectProtection: () => this.inspectLocalWriteProtection(path),
      writeMerged: (content) => this.app.vault.modifyBinary(local, content),
      writeConflictCopy: (content) => this.writeLocal(conflictPath, content),
      writeProtectedCopy: (content) => this.writeLocal(protectedPath, content),
    });
    if (result.outcome === 'unavailable') {
      await this.executeOrdinaryConflict(path, client);
      return;
    }
    if (result.outcome === 'protected') {
      this.protectedConflictPaths.set(path, protectedPath);
      this.recordProtectedLocalPath(path);
      return 'protected';
    }
    if (result.outcome === 'conflicted') throw new Error(`Markdown 智能合并存在重叠冲突，候选内容已保存到 ${conflictPath}`);
    await this.executePush(path, client);
  }

  public async executeOrdinaryConflict(path: string, client: RepositoryClient): Promise<void> {
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
        if (this.repoHeadCommitId) {
          await preserveRemoteConflictCopy(
            () => client.repoContent(this.repoHeadCommitId!, path),
            (content) => this.writeLocalViaAdapter(resolution.conflictPath, content),
          );
        }
        await this.executePush(path, client);
      } else {
        const localContent = await this.app.vault.adapter.readBinary(path);
        await this.writeLocalViaAdapter(resolution.conflictPath, localContent);
        await this.executePull(path, client);
      }
      return;
    }

    const local = this.app.vault.getAbstractFileByPath(path);
    if (!(local instanceof TFile)) return;
    const resolution = resolveConflict({ path, localMtime: local.stat.mtime, remoteMtime: remote.mtime, localType: 'file', remoteType: 'file' }, this.settings.conflictStrategy, this.settings.deviceName, Date.now(), new Set(this.app.vault.getFiles().map((file) => file.path)));
    if (resolution.paused) throw new Error('冲突策略要求暂停并报告');
    if (resolution.outcome === 'keep-local') {
      if (this.repoHeadCommitId) {
        await preserveRemoteConflictCopy(
          () => client.repoContent(this.repoHeadCommitId!, path),
          (content) => this.writeLocal(resolution.conflictPath, content),
        );
      }
      await this.executePush(path, client);
    } else {
      const localContent = await this.app.vault.readBinary(local);
      await this.writeLocal(resolution.conflictPath, localContent);
      await this.executePull(path, client);
    }
  }

  /** 缓存 .obsidian/ 路径列表，用于冲突路径命名避免覆盖 */
  public obsPathsCache: Set<string> | null = null;
  public async listObsPathsSafe(): Promise<string[]> {
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

  public async executePush(path: string, client: RepositoryClient): Promise<void> {
    await this.uploadToClient(client, path, this.repoUploads);
  }

  /**
   * 把本地 path 上传为不可变 blob 并收集到 target（主同步/镜像共用）。
   * .obsidian/ 内的文件用底层 adapter 读取；其余用 vault API。
   * 不立即提交：变更集由调用方汇总后一次性 finalize。
   */
  public async uploadToClient(client: RepositoryClient, path: string, target: Map<string, RepoUploadedFile>): Promise<void> {
    console.log('synx push start', { path });
    let content: ArrayBuffer;
    let mtime: number;
    let fileUuid: string | undefined;
    // .obsidian/ 内的文件不在 vault 文件追踪范围，需用底层 adapter 读取
    if (path.startsWith('.obsidian/')) {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.type !== 'file') throw Object.assign(new Error('本地文件已不存在'), { code: 'ENOENT' });
      content = await this.app.vault.adapter.readBinary(path);
      mtime = stat.mtime > 0 ? stat.mtime : stat.ctime;
      console.log('synx push .obsidian file', { path, size: content.byteLength });
    } else {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw Object.assign(new Error('本地文件已不存在'), { code: 'ENOENT' });
      mtime = file.stat.mtime;
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
        console.log('synx push markdown', { path, uuid: fileUuid, size: content.byteLength });
      } else {
        content = await this.app.vault.readBinary(file);
        console.log('synx push binary', { path, size: content.byteLength });
      }
    }
    const hash = await hashContent(content);
    // 复用未提交 blob：同一存储 + 路径 + 内容 hash 已上传过（上次整批同步失败残留）则直接引用，避免重复上传。
    // hash 一致保证内容相同；若 blob 已被服务端 GC 清理，finalize 会返回 BLOB_MISSING → 作废记录后重新上传。
    const storageId = (client as { storageId?: string }).storageId ?? this.settings.storageId ?? '';
    if (storageId) {
      const pending = this.findPendingBlobUpload(storageId, path, hash);
      if (pending) {
        target.set(path, {
          path,
          blobId: pending.blobId,
          hash,
          size: pending.size,
          mtime: pending.mtime,
          identity: pending.identity,
        });
        console.log('synx push reuse pending blob', { path, blobId: pending.blobId });
        return;
      }
    }
    try {
      const blobId = await this.uploadWorkerBlob(client, path, content, mtime, hash);
      target.set(path, {
        path,
        blobId,
        hash,
        size: content.byteLength,
        mtime,
        identity: fileUuid ?? `path:${path}`,
      });
      if (storageId) this.recordPendingBlobUpload({ storageId, path, hash, blobId, size: content.byteLength, mtime, identity: fileUuid ?? `path:${path}` });
      console.log('synx push done', { path, blobId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // "Failed to fetch" 通常是服务端 503/CORS 被浏览器拦截，给用户更明确的提示
      if (/Failed to fetch/i.test(msg)) {
        throw new Error('服务端不可用或网络中断（可能为 503/CORS），请检查 Worker 部署状态');
      }
      // 非 S3 存储不支持大文件直传，给出明确提示而非静默失败
      if (/unsupported storage type/i.test(msg)) {
        throw new Error('当前存储不支持大文件直传（仅 S3/R2/MinIO），请降低单文件大小限制或更换存储');
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

  /**
   * 上传 blob 并应用 Worker 代理并发限流：仅限 Worker 代理模式的二进制 POST（并发 ≤ WORKER_PROXY_MAX_CONCURRENCY），
   * 超过阈值走预签名直传、以及 S3 直连路由，均保持原有并发不受限。
   */
  private async uploadWorkerBlob(client: RepositoryClient, path: string, content: ArrayBuffer, mtime: number, hash: string): Promise<string> {
    const workerProxyRoute = client instanceof WorkerClient && content.byteLength <= DIRECT_UPLOAD_THRESHOLD;
    if (!workerProxyRoute) return uploadRepositoryBlob(client, path, content, mtime, hash, DIRECT_UPLOAD_THRESHOLD);
    await this.acquireWorkerProxyUploadSlot();
    try {
      return await uploadRepositoryBlob(client, path, content, mtime, hash, DIRECT_UPLOAD_THRESHOLD);
    } finally {
      this.releaseWorkerProxyUploadSlot();
    }
  }

  public async findDuplicateUuid(path: string, uuid: string): Promise<boolean> {
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === path) continue;
      if (extractMarkdownUuid(await this.app.vault.read(candidate)) === uuid) return true;
    }
    return false;
  }

  /** .obsidian 写入后回读的实际 mtime（诊断 iOS 写 mtime 是否生效） */
  public obsWriteBackMtimes: Record<string, { expected: number; actual: number | null }> = {};

  public async executePull(path: string, client: RepositoryClient, _fileUuid?: string): Promise<void | 'protected'> {
    if (!this.repoHeadCommitId) throw new Error('仓库基线未就绪');
    const remote = this.remoteEntities.find((entity) => entity.key.replace(/^\/+/, '') === path);
    // 从仓库当前提交读取内容（git 模型下内容对象不可变，路径解引用）
    const content = await client.repoContent(this.repoHeadCommitId, path);
    const protection = await this.inspectLocalWriteProtection(path);
    if (protection !== 'safe') {
      const existingPaths = new Set(this.app.vault.getFiles().map((file) => file.path));
      const copyPath = this.protectedConflictPaths.get(path)
        ?? protectedPullConflictPath(path, this.settings.deviceName, Date.now(), existingPaths);
      await this.writeLocal(copyPath, content);
      this.protectedConflictPaths.set(path, copyPath);
      this.recordProtectedLocalPath(path);
      return 'protected';
    }
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

  public async inspectLocalWriteProtection(path: string): Promise<LocalWriteProtection> {
    const started = this.syncStartSnapshot.get(path) ?? { exists: false };
    const current = await this.readCurrentFileSnapshot(path);
    const editors: MarkdownEditorSnapshot[] = [];
    if (!path.startsWith('.obsidian/')) {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) continue;
        editors.push({
          path: leaf.view.file.path,
          contentHash: await hashContent(new TextEncoder().encode(leaf.view.editor.getValue())),
        });
      }
    }
    return decideLocalWriteProtection(started, current, hasChangedMarkdownEditor(path, current.hash, editors));
  }

  public async readCurrentFileSnapshot(path: string): Promise<SyncStartFileSnapshot> {
    if (path.startsWith('.obsidian/')) {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.type !== 'file') return { exists: false };
      const content = await this.app.vault.adapter.readBinary(path);
      return { exists: true, mtime: stat.mtime > 0 ? stat.mtime : stat.ctime, size: stat.size, hash: await hashContent(content) };
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { exists: false };
    const content = await this.app.vault.readBinary(file);
    return { exists: true, mtime: file.stat.mtime, size: file.stat.size, hash: await hashContent(content) };
  }

  public recordProtectedLocalPath(path: string): void {
    if (!this.protectedLocalPaths.has(path)) this.protectedLocalCount++;
    this.protectedLocalPaths.add(path);
  }

  public async writeLocal(path: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParentDir(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, content);
    else await this.app.vault.createBinary(path, content);
  }

  /** 写入 .obsidian/ 等非 vault 追踪路径，使用底层 adapter；mtime>0 时显式设置写入时间戳 */
  public async writeLocalViaAdapter(path: string, content: ArrayBuffer, mtime = 0): Promise<void> {
    await this.ensureParentDirViaAdapter(path);
    if (mtime > 0) {
      await this.app.vault.adapter.writeBinary(path, content, { mtime, ctime: mtime });
    } else {
      await this.app.vault.adapter.writeBinary(path, content);
    }
  }

  public async ensureParentDir(path: string): Promise<void> {
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
  public async ensureParentDirViaAdapter(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }
}
