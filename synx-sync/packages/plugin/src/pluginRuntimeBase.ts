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

export interface PersistedPluginData {
  /** data.json 中不含 deviceName：它属于每设备独立状态，存 synx-state.json（不同步） */
  settings: Omit<SynxPluginSettings, 'deviceName'>;
}

export interface PrevSyncState {
  version: 2 | 3;
  storageId: string;
  /** version 3 起保存用于智能三方合并的准确共同基线提交 */
  baseCommitId?: string;
  syncFolder: string;
  entries: { [path: string]: PrevSyncEntry };
}

export interface SynxStateData {
  /** 每设备独立的设备名：存 state（不同步），避免 data.json 跨设备互相覆盖设备名 */
  deviceName?: string;
  reports: readonly SyncReport[];
  pendingDeletions?: readonly PendingDeletion[];
  knownRemoteFiles?: readonly { storageId: string; syncFolder: string; path: string; fileUuid?: string }[];
  prevSync?: PrevSyncState;
  pendingImageUploads?: readonly PendingImageUpload[];
  pendingBlobUploads?: readonly PendingBlobUpload[];
  credentialCache?: CredentialCacheState;
}

/**
 * 已上传到对象存储、但尚未被任何提交引用的不可变 blob。
 * 持久化于 synx-state.json：整批同步因部分文件失败而未 finalize 时，
 * 下次同步按 storageId+path+hash 复用，避免把已成功上传的文件重新上传一遍。
 * 若 blob 已被 GC 清理（服务端返回 BLOB_MISSING），作废该存储全部记录并重新上传。
 */
export interface PendingBlobUpload {
  storageId: string;
  path: string;
  hash: string;
  blobId: string;
  size: number;
  mtime: number;
  identity: string;
}

export function isPersistedData(raw: unknown): raw is PersistedPluginData {
  return typeof raw === 'object' && raw !== null && 'settings' in raw;
}

export function isStateData(raw: unknown): raw is SynxStateData {
  return typeof raw === 'object' && raw !== null && 'reports' in raw;
}

export function changesRepositoryScope(patch: Partial<SynxPluginSettings>): boolean {
  return patch.serverUrl !== undefined || patch.jwt !== undefined || patch.userId !== undefined
    || patch.storageId !== undefined || patch.syncFolder !== undefined;
}

export const STATE_FILE = '.obsidian/plugins/synx-sync/synx-state.json';
/** 大文件直传阈值：超过该大小（字节）的文件走预签名 PUT 直传对象存储（不经过 Worker） */
export const DIRECT_UPLOAD_THRESHOLD = 20 * 1024 * 1024;
/** Worker 代理模式下二进制上传的最大并发数：大量 POST 共享同一条 HTTP/2 连接时容易触发连接重置，需收紧 */
export const WORKER_PROXY_MAX_CONCURRENCY = 3;
/** 未提交 blob 记录的持久化上限（超出丢弃最旧，避免 synx-state.json 无限膨胀） */
export const MAX_PENDING_BLOB_UPLOADS = 2000;
// .obsidian 同步诊断日志：每次同步后写入 vault 根目录。
// 注意：必须写成 .md 后缀——iOS 文件 App / Obsidian 内只显示 .md 文件，
// .log 等附件后缀在移动端不可见（实测 iOS 只能看到 .md）。
// 文件名带设备名，避免两端同写 synx-debug.md 互相覆盖、看不出是谁写的。
// 该文件在 fileFilter 中被排除，不会被同步到远端。
// 说明：早期版本用固定名 synx-debug.md，现在用 getter 动态生成带设备名的文件名。
export const OBS_DEBUG_FILE = 'synx-debug.md'; // 兼容旧版本号（用于事件忽略判断）
// 同步后自动 GC 的单次驱动轮数上限：服务端受单请求子请求预算限制，
// 长提交链一次跑不完（more=true），循环多轮驱动同一批清理收敛；
// 仍跑不完时进度持久化在服务端 .synx/gc-state.json，下次同步继续，不会卡死。
export const MAX_GC_ROUNDS = 8;

export class RuntimeBase {
  settings!: SynxPluginSettings;
  protected workerClient: WorkerClient | null = null;
  protected repositoryClient: RepositoryClient | null = null;
  protected readonly repositoryWriteCoordinator: RepositoryWriteCoordinator;
  protected directRepositoryResolver!: DirectRepositoryResolver;
  protected repositoryTransportSelector!: RepositoryTransportSelector;
  protected readonly historyIndex = new HistoryIndex();
  protected historyIndexAbort: AbortController | null = null;
  protected historyIndexSyncTask: Promise<void> | null = null;
  protected indexedUserId: string | null = null;
  protected scheduler!: SyncScheduler;
  protected reportStore!: SyncReportStore;
  protected statusBarItem: HTMLElement | null = null;
  protected ribbonIcon: HTMLElement | null = null;
  protected remoteEntities: Entity[] = [];
  protected pendingDeletions: PendingDeletion[] = [];
  protected knownRemoteFiles: { storageId: string; syncFolder: string; path: string; fileUuid?: string }[] = [];
  protected prevSync: PrevSyncState | null = null;
  protected pendingImageUploads: PendingImageUpload[] = [];
  protected pendingBlobUploads: PendingBlobUpload[] = [];
  protected credentialCache: CredentialCacheState = createCredentialCache();
  /** 插件卸载/重载时中止所有在途同步请求，避免旧 Runtime 与新 Runtime 同时上传 */
  protected syncAbort = new AbortController();
  protected credentialCacheGeneration = 0;
  protected readonly queueStateWrite = createSerialStateWriter(
    () => this.buildState(),
    async (state) => this.app.vault.adapter.write(STATE_FILE, JSON.stringify(state)),
  );
  protected internalDeletes = new Set<string>();
  protected folderImageMigrationRunning = false;
  protected folderImageMigrationPreparing = false;

  // Git 式仓库同步状态（本次同步内累积，runSync 结束/失败时清理）
  protected repoUploads = new Map<string, RepoUploadedFile>();
  protected repoDeletes = new Map<string, string>(); // path → identity
  protected repoTree: RepoFile[] = [];
  /** 提交时的基线 HEAD（用于 pull 内容与 finalize CAS） */
  protected repoHeadCommitId: string | null = null;
  protected repoHeadGeneration: number | null = null;
  protected syncStartSnapshot = new Map<string, SyncStartFileSnapshot>();
  protected protectedLocalPaths = new Set<string>();
  protected protectedConflictPaths = new Map<string, string>();
  protected protectedLocalCount = 0;

  protected uuidEditorExtensions: Extension[] = [];

  constructor(protected readonly host: RuntimeHost) {
    this.repositoryWriteCoordinator = new RepositoryWriteCoordinator(() => this.selectSyncRepositoryClient());
  }
  setRepositoryInfrastructure(resolver: DirectRepositoryResolver, selector: RepositoryTransportSelector): void {
    this.directRepositoryResolver = resolver;
    this.repositoryTransportSelector = selector;
  }
  get app(): App { return this.host.app; }
  get manifest(): { id: string } { return this.host.manifest; }
  protected loadData(): Promise<unknown> { return this.host.loadData(); }
  protected saveData(data: unknown): Promise<void> { return this.host.saveData(data); }
  protected addStatusBarItem(): HTMLElement { return this.host.addStatusBarItem(); }
  protected addSettingTab(tab: unknown): void { this.host.addSettingTab(tab); }
  protected registerView(type: string, creator: (leaf: WorkspaceLeaf) => unknown): void { this.host.registerView(type, creator); }
  protected registerEditorExtension(extension: Extension[]): void { this.host.registerEditorExtension(extension); }
  protected registerMarkdownPostProcessor(processor: (element: HTMLElement) => void): void { this.host.registerMarkdownPostProcessor(processor); }
  protected addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement { return this.host.addRibbonIcon(icon, title, callback); }
  protected addCommand(command: unknown): void { this.host.addCommand(command); }
  protected registerDomEvent(target: Document, type: string, callback: EventListenerOrEventListenerObject, capture?: boolean): void { this.host.registerDomEvent(target, type, callback, capture); }
  protected registerEvent(event: unknown): void { this.host.registerEvent(event); }

  /** 查找可复用的未提交 blob：同一存储、同一路径、内容 hash 一致才复用（hash 保证内容相同） */
  protected findPendingBlobUpload(storageId: string, path: string, hash: string): PendingBlobUpload | undefined {
    return this.pendingBlobUploads.find(
      (entry) => entry.storageId === storageId && entry.path === path && entry.hash === hash,
    );
  }

  /** 记录一次成功上传的未提交 blob；同 path+hash 覆盖旧记录；超出上限丢弃最旧 */
  protected recordPendingBlobUpload(entry: PendingBlobUpload): void {
    const index = this.pendingBlobUploads.findIndex(
      (existing) => existing.storageId === entry.storageId && existing.path === entry.path && existing.hash === entry.hash,
    );
    if (index >= 0) this.pendingBlobUploads[index] = entry;
    else this.pendingBlobUploads.push(entry);
    if (this.pendingBlobUploads.length > MAX_PENDING_BLOB_UPLOADS) {
      this.pendingBlobUploads = this.pendingBlobUploads.slice(-MAX_PENDING_BLOB_UPLOADS);
    }
  }

  /** 原子提交成功后，移除已被提交引用的未提交 blob 记录 */
  protected acknowledgeCommittedBlobUploads(storageId: string, paths: Iterable<string>): void {
    const committed = new Set(paths);
    this.pendingBlobUploads = this.pendingBlobUploads.filter(
      (entry) => !(entry.storageId === storageId && committed.has(entry.path)),
    );
  }

  /** 该存储的 blob 已缺失（可能被 GC 清理）时作废全部记录，下次同步重新上传，避免反复复用已删除的对象 */
  protected invalidatePendingBlobUploads(storageId: string): void {
    this.pendingBlobUploads = this.pendingBlobUploads.filter((entry) => entry.storageId !== storageId);
  }

  // ===== Worker 代理二进制上传并发信号量 =====
  // 大量二进制 POST 共享同一条 HTTP/2 连接，并发过高会触发连接重置（ERR_HTTP2_PROTOCOL_ERROR）。
  // 仅对 Worker 代理路由（uploadBlob 走 Worker）限流；S3 直连 / 预签名直传不受限。
  private workerProxyUploadPermits = WORKER_PROXY_MAX_CONCURRENCY;
  private readonly workerProxyUploadWaiters: Array<() => void> = [];

  /** 获取一个 Worker 代理上传并发位；无空位时排队等待（许可证由 release 直接移交） */
  protected async acquireWorkerProxyUploadSlot(): Promise<void> {
    if (this.workerProxyUploadPermits > 0) {
      this.workerProxyUploadPermits--;
      return;
    }
    await new Promise<void>((resolve) => this.workerProxyUploadWaiters.push(resolve));
  }

  /** 释放并发位：先唤醒等待者移交许可证；无等待者时归还许可计数 */
  protected releaseWorkerProxyUploadSlot(): void {
    const next = this.workerProxyUploadWaiters.shift();
    if (next) next();
    else this.workerProxyUploadPermits++;
  }
}
export interface RuntimeBase { [key: string]: any; }
export interface RuntimeHost {
  app: App; manifest: { id: string };
  loadData(): Promise<unknown>; saveData(data: unknown): Promise<void>;
  addStatusBarItem(): HTMLElement; addSettingTab(tab: unknown): void;
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => unknown): void;
  registerEditorExtension(extension: Extension[]): void;
  registerMarkdownPostProcessor(processor: (element: HTMLElement) => void): void;
  addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement;
  addCommand(command: unknown): void;
  registerDomEvent(target: Document, type: string, callback: EventListenerOrEventListenerObject, capture?: boolean): void;
  registerEvent(event: unknown): void;
}
