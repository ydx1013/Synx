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
  credentialCache?: CredentialCacheState;
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

// #region debug-point Z:helper
// 之前版本把日志 POST 到 http://127.0.0.1:7777/event（本地调试服务器），
// 手机上该地址无人监听，日志全部丢失 → 排查 .obsidian 同步问题时"没有日志"。
// 改为 console.log：Obsidian 移动端开发者控制台 / 桌面端控制台可见。
export function dbg(hyp: string, location: string, msg: string, data?: Record<string, unknown>): void {
  try {
    console.log(`[synx:dbg] [${hyp}] ${location}: ${msg}`, data ?? '');
  } catch { /* ignore */ }
}
// #endregion
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
  protected credentialCache: CredentialCacheState = createCredentialCache();
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
