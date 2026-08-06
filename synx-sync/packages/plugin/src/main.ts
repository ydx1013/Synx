import { App, FuzzySuggestModal, MarkdownView, Notice, Platform, Plugin, requestUrl, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import type { Extension } from '@codemirror/state';
import type { Entity } from '@synx/shared';
import type { RepoChange, RepoFile, RepoFinalizeRequest, RepoFinalizeResponse, StorageCredentialsResponse } from '@synx/shared';
import { evaluateFile } from './fileFilter.js';
import { conflictCopyPath, resolveConflict } from './conflict.js';
import { HistoryPaneView, HISTORY_VIEW_TYPE } from './historyPane.js';
import { HistoryIndex } from './historyIndex.js';
import { syncHistoryIndex } from './historyIndexSync.js';
import { ensureMarkdownUuid, extractMarkdownUuid, isMarkdownPath, replaceMarkdownUuid } from './markdownUuid.js';
import { hideMarkdownUuidExtension } from './markdownUuidEditor.js';
import { listObsConfigFiles } from './obsConfigLister.js';
import { loadPluginSettings, DEFAULT_REPORT_RETENTION, type SynxPluginSettings } from './settings.js';
import { SynxSettingTab } from './settingsTab.js';
import { hashContent, isLocalFileUnchangedFromPrev, planSync, shouldProtectAgainstMassDeletion, shouldProtectAgainstMassLocalDeletion, type LocalFile, type PrevSyncEntry, type PrevSyncMap, type SyncAction, type SyncPlan } from './syncAlgo.js';
import { enqueueDeletion, pendingForTarget, type PendingDeletion } from './deletionQueue.js';
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
import { buildRepoChanges, commitAndIndex, repoTreeToRemote, treeToMap, type RepoDelete, type RepoUploadedFile } from './repoSync.js';
import { uploadImageWithRetry } from './imageUpload.js';
import { applyImageReplacements, buildFolderMigrationPlan, containsAttachmentReference, findImageCandidates, isCurrentGalleryUrl, isSafeExternalImageUrl, type ImageCandidate } from './imageMigration.js';
import { collectReferencedImagePaths, pendingUploadKey, replaceExactEmbed, type PendingImageUpload } from './pendingImageUploads.js';
import { parsePrivateImageUrl } from './privateImage.js';
import { ConfirmModal } from './settingsTab.js';
import { clearCredentialCacheForAuthFailure, createCredentialCache, createSerialStateWriter, decryptStorageCredentials, encryptStorageCredentials, handleStorageAuthFailures, isCredentialRequestCurrent, persistRefreshedStorageCredentials, readCredentialCacheFromState, reconcileCredentialCacheSession, writeCredentialCacheToState, type CredentialCacheState, type CredentialRequestIdentity } from './credentialCache.js';
import { decideLocalWriteProtection, hasChangedMarkdownEditor, protectedPullConflictPath, withoutProtectedPrevSyncEntries, type LocalWriteProtection, type MarkdownEditorSnapshot, type SyncStartFileSnapshot } from './syncWriteGuard.js';

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly folders: TFolder[], private readonly select: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder('选择要迁移图片的文件夹');
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path || '/';
  }

  onChooseItem(folder: TFolder): void {
    this.select(folder);
  }
}

interface PersistedPluginData {
  /** data.json 中不含 deviceName：它属于每设备独立状态，存 synx-state.json（不同步） */
  settings: Omit<SynxPluginSettings, 'deviceName'>;
}

interface PrevSyncState {
  version: 2;
  storageId: string;
  syncFolder: string;
  entries: { [path: string]: PrevSyncEntry };
}

interface SynxStateData {
  /** 每设备独立的设备名：存 state（不同步），避免 data.json 跨设备互相覆盖设备名 */
  deviceName?: string;
  reports: readonly SyncReport[];
  pendingDeletions?: readonly PendingDeletion[];
  knownRemoteFiles?: readonly { storageId: string; syncFolder: string; path: string; fileUuid?: string }[];
  prevSync?: PrevSyncState;
  pendingImageUploads?: readonly PendingImageUpload[];
  credentialCache?: CredentialCacheState;
}

function isPersistedData(raw: unknown): raw is PersistedPluginData {
  return typeof raw === 'object' && raw !== null && 'settings' in raw;
}

function isStateData(raw: unknown): raw is SynxStateData {
  return typeof raw === 'object' && raw !== null && 'reports' in raw;
}

function changesRepositoryScope(patch: Partial<SynxPluginSettings>): boolean {
  return patch.serverUrl !== undefined || patch.jwt !== undefined || patch.userId !== undefined
    || patch.storageId !== undefined || patch.syncFolder !== undefined;
}

const STATE_FILE = '.obsidian/plugins/synx-sync/synx-state.json';
/** 大文件直传阈值：超过该大小（字节）的文件走预签名 PUT 直传对象存储（不经过 Worker） */
const DIRECT_UPLOAD_THRESHOLD = 20 * 1024 * 1024;
// .obsidian 同步诊断日志：每次同步后写入 vault 根目录。
// 注意：必须写成 .md 后缀——iOS 文件 App / Obsidian 内只显示 .md 文件，
// .log 等附件后缀在移动端不可见（实测 iOS 只能看到 .md）。
// 文件名带设备名，避免两端同写 synx-debug.md 互相覆盖、看不出是谁写的。
// 该文件在 fileFilter 中被排除，不会被同步到远端。
// 说明：早期版本用固定名 synx-debug.md，现在用 getter 动态生成带设备名的文件名。
const OBS_DEBUG_FILE = 'synx-debug.md'; // 兼容旧版本号（用于事件忽略判断）
// 同步后自动 GC 的单次驱动轮数上限：服务端受单请求子请求预算限制，
// 长提交链一次跑不完（more=true），循环多轮驱动同一批清理收敛；
// 仍跑不完时进度持久化在服务端 .synx/gc-state.json，下次同步继续，不会卡死。
const MAX_GC_ROUNDS = 8;

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
  private workerClient: WorkerClient | null = null;
  private repositoryClient: RepositoryClient | null = null;
  private readonly repositoryWriteCoordinator = new RepositoryWriteCoordinator(() => this.selectSyncRepositoryClient());
  private readonly directRepositoryResolver = new DirectRepositoryResolver(
    async () => {
      const credentials = await this.getStorageCredentials();
      if (!credentials) throw new Error('存储凭证不可用');
      return credentials;
    },
    undefined,
    undefined,
    (scope) => {
      const captured: CredentialRequestIdentity = { ...scope, client: this.workerClient, generation: scope.credentialGeneration };
      return {
        onCredentialsChanged: (credentials) => persistRefreshedStorageCredentials(
          credentials,
          captured,
          () => ({
            jwt: this.settings.jwt,
            userId: this.settings.userId ?? '',
            storageId: this.settings.storageId ?? '',
            client: this.workerClient,
            generation: this.credentialCacheGeneration,
          }),
          this.credentialCache,
          this.queueStateWrite,
        ).then(() => undefined),
      };
    },
  );
  private readonly repositoryTransportSelector = new RepositoryTransportSelector(
    this.directRepositoryResolver,
    (status, storageId) => this.handleAuthFailure(status, storageId),
  );
  private readonly historyIndex = new HistoryIndex();
  private historyIndexAbort: AbortController | null = null;
  private historyIndexSyncTask: Promise<void> | null = null;
  private indexedUserId: string | null = null;
  private scheduler!: SyncScheduler;
  private reportStore!: SyncReportStore;
  private statusBarItem: HTMLElement | null = null;
  private ribbonIcon: HTMLElement | null = null;
  private remoteEntities: Entity[] = [];
  private pendingDeletions: PendingDeletion[] = [];
  private knownRemoteFiles: { storageId: string; syncFolder: string; path: string; fileUuid?: string }[] = [];
  private prevSync: PrevSyncState | null = null;
  private pendingImageUploads: PendingImageUpload[] = [];
  private credentialCache: CredentialCacheState = createCredentialCache();
  private credentialCacheGeneration = 0;
  private readonly queueStateWrite = createSerialStateWriter(
    () => this.buildState(),
    async (state) => this.app.vault.adapter.write(STATE_FILE, JSON.stringify(state)),
  );
  private internalDeletes = new Set<string>();
  private folderImageMigrationRunning = false;
  private folderImageMigrationPreparing = false;

  // Git 式仓库同步状态（本次同步内累积，runSync 结束/失败时清理）
  private repoUploads = new Map<string, RepoUploadedFile>();
  private repoDeletes = new Map<string, string>(); // path → identity
  private repoTree: RepoFile[] = [];
  /** 提交时的基线 HEAD（用于 pull 内容与 finalize CAS） */
  private repoHeadCommitId: string | null = null;
  private repoHeadGeneration: number | null = null;
  private syncStartSnapshot = new Map<string, SyncStartFileSnapshot>();
  private protectedLocalPaths = new Set<string>();
  private protectedConflictPaths = new Map<string, string>();
  private protectedLocalCount = 0;

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
    this.registerMarkdownPostProcessor((element) => void this.renderPrivateImages(element));
    this.ribbonIcon = this.addRibbonIcon('refresh-cw', 'Synx 同步', () => void this.triggerSync());
    this.addCommand({ id: 'synx-sync-now', name: '立即同步', icon: 'refresh-cw', callback: () => void this.triggerSync() });
    this.addCommand({ id: 'synx-open-history', name: '打开版本历史', icon: 'history', callback: () => void this.activateHistoryPane() });
    this.addCommand({ id: 'synx-open-sync-details', name: '打开同步详情', icon: 'activity', callback: () => void this.activateSyncDetails() });
    this.addCommand({ id: 'synx-migrate-current-note-images', name: '将当前笔记图片迁移到 Synx 图库', icon: 'images', callback: () => void this.previewCurrentNoteImageMigration() });
    this.addCommand({ id: 'synx-migrate-folder-note-images', name: '迁移文件夹内笔记图片到 Synx 图库', icon: 'folder-up', callback: () => this.selectImageMigrationFolder() });
    this.registerDomEvent(document, 'paste', (event) => void this.handleImagePaste(event), true);
    this.registerDomEvent(document, 'drop', (event) => void this.handleImageDrop(event), true);
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

  async onunload(): Promise<void> {
    this.scheduler?.dispose();
    await this.stopHistoryIndexSync();
    this.historyIndex.close();
  }

  private renderPrivateImages(element: HTMLElement): void {
    // 旧笔记中可能存在 synx-image:// 链接，用 access_token 转换为永久 HTTPS URL
    const token = this.settings.imageGalleryAccessToken;
    const galleryId = this.settings.imageGalleryId;
    if (!token || !galleryId) return;
    const base = this.settings.serverUrl.replace(/\/+$/, '');
    for (const img of Array.from(element.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? '';
      if (!src.startsWith('synx-image://')) continue;
      const reference = parsePrivateImageUrl(src);
      if (!reference || reference.galleryId !== galleryId) continue;
      const encodedPath = reference.path.split('/').map(encodeURIComponent).join('/');
      img.src = `${base}/api/image-galleries/${encodeURIComponent(galleryId)}/images/content?path=${encodedPath}&key=${token}`;
    }
  }

  private imageUploadReady(): boolean {
    return Boolean(this.settings.imageHostingEnabled && this.settings.imageGalleryId && this.settings.jwt && this.workerClient);
  }

  private selectImageMigrationFolder(): void {
    if (this.folderImageMigrationRunning || this.folderImageMigrationPreparing) {
      new Notice('已有文件夹图片迁移任务正在准备或运行');
      return;
    }
    if (!this.imageUploadReady()) {
      new Notice('请先启用图片托管并选择默认图库');
      return;
    }
    new FolderSuggestModal(this.app, this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder), (folder) => {
      void this.previewFolderImageMigration(folder);
    }).open();
  }

  private async previewFolderImageMigration(folder: TFolder): Promise<void> {
    if (this.folderImageMigrationPreparing || this.folderImageMigrationRunning) return;
    this.folderImageMigrationPreparing = true;
    try {
      const gallery = (await WorkerClient.listImageGalleries(this.settings.serverUrl, this.settings.jwt))
        .find((item) => item.id === this.settings.imageGalleryId);
      if (!gallery) throw new Error('默认图库不存在，请重新选择');
      const prefix = folder.path ? `${folder.path}/` : '';
      const files = this.app.vault.getMarkdownFiles().filter((file) => !folder.path || file.path.startsWith(prefix));
      const notes = await Promise.all(files.map(async (file) => ({ path: file.path, content: await this.app.vault.cachedRead(file) })));
      const plan = buildFolderMigrationPlan(notes, this.settings.serverUrl, gallery, (source, notePath) => {
        const linked = this.app.metadataCache.getFirstLinkpathDest(this.safeDecodeImageSource(source), notePath);
        return linked instanceof TFile ? linked.path : null;
      });
      const total = plan.externalSources.size + plan.localSources.size;
      if (total === 0) {
        new Notice(plan.skippedGalleryImages ? `文件夹中的 ${plan.skippedGalleryImages} 张图片已属于 Synx 图库` : '文件夹内没有可迁移的图片');
        return;
      }
      new ConfirmModal(this.app, `扫描完成：共 ${files.length} 篇笔记，${plan.notesWithImages} 篇含图片；唯一外链 ${plan.externalSources.size} 张，本地附件 ${plan.localSources.size} 张，已在当前图库 ${plan.skippedGalleryImages} 张。确认迁移 ${total} 张图片？`, () => {
        this.folderImageMigrationPreparing = false;
        void this.migrateFolderImages(notes, plan);
      }, () => {
        this.folderImageMigrationPreparing = false;
      }).open();
      return;
    } catch (error) {
      this.folderImageMigrationPreparing = false;
      new Notice(`扫描文件夹失败：${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  private async migrateFolderImages(notes: Array<{ path: string; content: string }>, plan: ReturnType<typeof buildFolderMigrationPlan>): Promise<void> {
    const client = this.workerClient;
    if (!client || this.folderImageMigrationRunning) return;
    this.folderImageMigrationRunning = true;
    const uploadedUrls = new Map<string, string>();
    const migratedLocalFiles: TFile[] = [];
    let uploaded = 0;
    let failed = 0;
    try {
      new Notice('正在迁移文件夹内笔记图片…');
      for (const url of plan.externalSources) {
        try {
          const source = await this.readImageCandidate({ raw: '', source: url, alt: '', kind: 'external' }, this.app.vault.getMarkdownFiles()[0]);
          if (source.bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB');
          const image = await uploadImageWithRetry(() => client.uploadGalleryImage(this.settings.imageGalleryId, source.bytes, source.mimeType));
          uploadedUrls.set(`external:${url}`, image.markdownUrl);
          uploaded++;
        } catch (error) {
          failed++;
          console.warn('synx: folder external image migration failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const path of plan.localSources) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          failed++;
          continue;
        }
        try {
          const mimeType = this.mimeTypeForExtension(file.extension);
          this.assertSupportedImageType(mimeType);
          const bytes = await this.app.vault.readBinary(file);
          if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB');
          const image = await uploadImageWithRetry(() => client.uploadGalleryImage(this.settings.imageGalleryId, bytes, mimeType));
          uploadedUrls.set(`local:${path}`, image.markdownUrl);
          migratedLocalFiles.push(file);
          uploaded++;
        } catch (error) {
          failed++;
          console.warn('synx: folder local image migration failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }

      let modifiedNotes = 0;
      let writeFailures = 0;
      for (const note of notes) {
        const mappings = plan.notes.get(note.path);
        if (!mappings) continue;
        const replacements = new Map<string, string>();
        for (const [source, key] of mappings) {
          const url = uploadedUrls.get(key);
          if (url) replacements.set(source, url);
        }
        const file = this.app.vault.getAbstractFileByPath(note.path);
        if (!(file instanceof TFile)) continue;
        try {
          const currentContent = await this.app.vault.cachedRead(file);
          const updated = applyImageReplacements(currentContent, replacements);
          if (updated === currentContent) continue;
          await this.app.vault.modify(file, updated);
          modifiedNotes++;
        } catch (error) {
          writeFailures++;
          console.warn('synx: folder note rewrite failed', { path: note.path, error: error instanceof Error ? error.message : String(error) });
        }
      }
      failed += writeFailures;
      new Notice(`文件夹图片迁移完成：成功 ${uploaded} 张，失败 ${failed} 张，修改 ${modifiedNotes} 篇笔记`, 10000);
      if (migratedLocalFiles.length > 0) await this.confirmFolderAttachmentCleanup(migratedLocalFiles);
    } finally {
      this.folderImageMigrationRunning = false;
    }
  }

  private async confirmFolderAttachmentCleanup(files: TFile[]): Promise<void> {
    const deletable: TFile[] = [];
    for (const file of files) {
      if (!(await this.isAttachmentReferenced(file.path))) deletable.push(file);
    }
    if (deletable.length === 0) return;
    new ConfirmModal(this.app, `发现 ${deletable.length} 个已无任何笔记引用的本地附件，确认删除？`, () => {
      void this.deleteMigratedAttachments(deletable);
    }).open();
  }

  private safeDecodeImageSource(source: string): string {
    try {
      return decodeURIComponent(source);
    } catch {
      return source;
    }
  }

  private async previewCurrentNoteImageMigration(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const note = view?.file;
    if (!view || !note) {
      new Notice('请先打开一篇 Markdown 笔记');
      return;
    }
    if (!this.imageUploadReady()) {
      new Notice('请先启用图片托管并选择默认图库');
      return;
    }
    try {
      const gallery = (await WorkerClient.listImageGalleries(this.settings.serverUrl, this.settings.jwt))
        .find((item) => item.id === this.settings.imageGalleryId);
      if (!gallery) throw new Error('默认图库不存在，请重新选择');
      const candidates = findImageCandidates(view.editor.getValue());
      const skipped = candidates.filter((item) => item.kind === 'external' && isCurrentGalleryUrl(item.source, this.settings.serverUrl, gallery));
      const pending = candidates.filter((item) => !skipped.includes(item));
      const skippedCount = new Set(skipped.map((item) => item.source)).size;
      const unique = new Set(pending.map((item) => item.source)).size;
      if (unique === 0) {
        new Notice(skippedCount ? `当前笔记中的 ${skippedCount} 张图片已属于 Synx 图库` : '当前笔记中没有可迁移的图片');
        return;
      }
      const external = new Set(pending.filter((item) => item.kind === 'external').map((item) => item.source)).size;
      const local = new Set(pending.filter((item) => item.kind === 'local').map((item) => item.source)).size;
      new ConfirmModal(this.app, `扫描完成：外链图片 ${external} 张，本地附件 ${local} 张，已在当前图库 ${skippedCount} 张。确认迁移 ${unique} 张图片？`, () => {
        void this.migrateCurrentNoteImages(view, note, pending);
      }).open();
    } catch (error) {
      new Notice(`扫描图片失败：${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  private async migrateCurrentNoteImages(view: MarkdownView, note: TFile, candidates: ImageCandidate[]): Promise<void> {
    const client = this.workerClient;
    if (!client) return;
    if (view.file?.path !== note.path) {
      new Notice('当前笔记已切换，已取消图片迁移');
      return;
    }
    const replacements = new Map<string, string>();
    const uploadedLocalFiles = new Map<string, TFile>();
    let failed = 0;
    let uploaded = 0;
    new Notice('正在迁移当前笔记中的图片…');
    for (const candidate of new Map(candidates.map((item) => [item.source, item])).values()) {
      try {
        const source = await this.readImageCandidate(candidate, note);
        if (source.bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB');
        const image = await uploadImageWithRetry(() => client.uploadGalleryImage(this.settings.imageGalleryId, source.bytes, source.mimeType));
        replacements.set(candidate.source, image.markdownUrl);
        if (source.localFile) uploadedLocalFiles.set(source.localFile.path, source.localFile);
        uploaded++;
      } catch (error) {
        failed++;
        console.warn('synx: image migration failed', { kind: candidate.kind, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (view.file?.path !== note.path) {
      new Notice(`图片已上传 ${uploaded} 张，但当前笔记已切换，未替换任何链接`, 10000);
      return;
    }
    const originalContent = view.editor.getValue();
    const updated = applyImageReplacements(originalContent, replacements);
    if (updated !== originalContent) view.editor.setValue(updated);
    new Notice(`图片迁移完成：成功 ${uploaded} 张，失败 ${failed} 张`, 10000);
    if (uploadedLocalFiles.size === 0) return;

    const deletable: TFile[] = [];
    for (const file of uploadedLocalFiles.values()) {
      if (!(await this.isAttachmentReferenced(file.path, note.path, updated))) deletable.push(file);
    }
    if (deletable.length === 0) return;
    new ConfirmModal(this.app, `发现 ${deletable.length} 个已无任何笔记引用的本地附件，确认删除？`, () => {
      void this.deleteMigratedAttachments(deletable);
    }).open();
  }

  private async readImageCandidate(candidate: ImageCandidate, note: TFile): Promise<{ bytes: ArrayBuffer; mimeType: string; localFile?: TFile }> {
    if (candidate.kind === 'external') {
      if (!isSafeExternalImageUrl(candidate.source)) throw new Error('出于安全原因，不下载本机或局域网地址');
      const response = await requestUrl({ url: candidate.source, method: 'GET', throw: false });
      if (response.status < 200 || response.status >= 300) throw new Error(`下载失败：HTTP ${response.status}`);
      const contentLength = Number(response.headers['content-length'] ?? 0);
      if (contentLength > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB');
      const mimeType = (response.headers['content-type'] ?? '').split(';')[0].toLowerCase();
      this.assertSupportedImageType(mimeType);
      return { bytes: response.arrayBuffer, mimeType };
    }
    const decodedSource = decodeURIComponent(candidate.source);
    const file = this.app.metadataCache.getFirstLinkpathDest(decodedSource, note.path);
    if (!(file instanceof TFile)) throw new Error('找不到本地附件');
    const mimeType = this.mimeTypeForExtension(file.extension);
    this.assertSupportedImageType(mimeType);
    return { bytes: await this.app.vault.readBinary(file), mimeType, localFile: file };
  }

  private assertSupportedImageType(mimeType: string): void {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'].includes(mimeType)) {
      throw new Error(`不支持的图片类型：${mimeType || '未知'}`);
    }
  }

  private mimeTypeForExtension(extension: string): string {
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' } as Record<string, string>)[extension.toLowerCase()] ?? '';
  }

  private async isAttachmentReferenced(attachmentPath: string, currentNotePath?: string, currentContent?: string): Promise<boolean> {
    const referenceFiles = this.app.vault.getFiles().filter((file) => file.extension === 'md' || file.extension === 'canvas');
    for (const note of referenceFiles) {
      const content = note.path === currentNotePath && currentContent !== undefined
        ? currentContent
        : await this.app.vault.cachedRead(note);
      if (containsAttachmentReference(content, attachmentPath)) return true;
      for (const candidate of findImageCandidates(content)) {
        if (candidate.kind !== 'local') continue;
        const linked = this.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(candidate.source), note.path);
        if (linked?.path === attachmentPath) return true;
      }
    }
    return false;
  }

  private async deleteMigratedAttachments(files: TFile[]): Promise<void> {
    let deleted = 0;
    for (const file of files) {
      if (await this.isAttachmentReferenced(file.path)) continue;
      await this.app.vault.trash(file, true);
      deleted++;
    }
    new Notice(`已删除 ${deleted} 个未被引用的本地附件`);
  }

  private async handleImagePaste(event: ClipboardEvent): Promise<void> {
    if (!this.imageUploadReady()) return;
    const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    await this.uploadImageIntoEditor(file, view);
  }

  private async handleImageDrop(event: DragEvent): Promise<void> {
    if (!this.imageUploadReady()) return;
    const file = Array.from(event.dataTransfer?.files ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    await this.uploadImageIntoEditor(file, view);
  }

  private async uploadImageIntoEditor(file: File, view: MarkdownView): Promise<void> {
    const client = this.workerClient;
    if (!client) return;
    const placeholder = `![上传中](synx-uploading://${crypto.randomUUID()})`;
    view.editor.replaceSelection(placeholder);
    try {
      const bytes = await file.arrayBuffer();
      const image = await uploadImageWithRetry(() => client.uploadGalleryImage(this.settings.imageGalleryId, bytes, file.type));
      this.replaceEditorText(view, placeholder, `![](${image.markdownUrl})`);
    } catch (error) {
      await this.saveFailedImageLocally(file, view, placeholder, error);
    }
  }

  private async saveFailedImageLocally(file: File, view: MarkdownView, placeholder: string, error: unknown): Promise<void> {
    const note = view.file;
    if (!note) {
      this.replaceEditorText(view, placeholder, '');
      new Notice('图片上传失败，当前笔记尚未保存，无法暂存本地', 10000);
      return;
    }
    const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(file.name || `image-${Date.now()}.png`, note.path);
    await this.app.vault.createBinary(attachmentPath, await file.arrayBuffer());
    const attachment = this.app.vault.getAbstractFileByPath(attachmentPath);
    if (!(attachment instanceof TFile)) throw new Error('本地附件保存失败');
    const embed = this.app.fileManager.generateMarkdownLink(attachment, note.path);
    if (!this.replaceEditorText(view, placeholder, embed)) return;
    const item: PendingImageUpload = { id: crypto.randomUUID(), localPath: attachmentPath, notePath: note.path, originalEmbed: embed, galleryId: this.settings.imageGalleryId, mimeType: file.type, createdAt: Date.now(), startupAttempts: 0, lastError: error instanceof Error ? error.message : String(error) };
    const key = pendingUploadKey(item.localPath, item.notePath);
    this.pendingImageUploads = [...this.pendingImageUploads.filter((entry) => pendingUploadKey(entry.localPath, entry.notePath) !== key), item];
    await this.persistState();
    new Notice('图片上传失败，已暂存本地，将在下次启动重试', 10000);
  }

  private async retryPendingImageUploads(): Promise<void> {
    if (!this.workerClient || !this.settings.jwt || this.pendingImageUploads.length === 0) return;
    let changed = false;
    for (const item of [...this.pendingImageUploads]) {
      const local = this.app.vault.getAbstractFileByPath(item.localPath);
      const note = this.app.vault.getAbstractFileByPath(item.notePath);
      if (!(local instanceof TFile) || !(note instanceof TFile)) continue;
      try {
        const bytes = await this.app.vault.readBinary(local);
        const image = await uploadImageWithRetry(() => this.workerClient!.uploadGalleryImage(item.galleryId, bytes, item.mimeType));
        const content = await this.app.vault.read(note);
        const updated = replaceExactEmbed(content, item.originalEmbed, `![](${image.markdownUrl})`);
        if (updated === null) continue;
        await this.app.vault.modify(note, updated);
        const referencedElsewhere = await this.localImageReferenced(item.localPath, note.path);
        if (!referencedElsewhere) await this.app.vault.delete(local);
        this.pendingImageUploads = this.pendingImageUploads.filter((entry) => entry.id !== item.id);
        changed = true;
      } catch (error) {
        item.startupAttempts += 1;
        item.lastError = error instanceof Error ? error.message : String(error);
        changed = true;
        new Notice(`暂存图片重传失败：${item.localPath}，请在设置中检查图库`, 10000);
      }
    }
    if (changed) await this.persistState();
  }

  private async localImageReferenced(localPath: string, replacedNotePath: string): Promise<boolean> {
    const fileName = localPath.split('/').pop() ?? localPath;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === replacedNotePath) continue;
      const content = await this.app.vault.cachedRead(file);
      if (content.includes(localPath) || content.includes(fileName)) return true;
    }
    return false;
  }

  private replaceEditorText(view: MarkdownView, search: string, replacement: string): boolean {
    const value = view.editor.getValue();
    const offset = value.indexOf(search);
    if (offset < 0) return false;
    const from = view.editor.offsetToPos(offset);
    const to = view.editor.offsetToPos(offset + search.length);
    view.editor.replaceRange(replacement, from, to);
    return true;
  }

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
  }

  private async loadState(): Promise<SynxStateData> {
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

  private async saveSettingsUnlocked(patch: Partial<SynxPluginSettings>): Promise<void> {
    const previousUserId = this.settings.userId;
    const previousSession = { jwt: this.settings.jwt, userId: this.settings.userId };
    this.settings = loadPluginSettings({ ...this.settings, ...patch }, Platform.isMobile);
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

  private updateUuidEditorExtension(): void {
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
    this.rebuildClient();
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
    if (!this.repositoryClient) {
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
    if (!this.workerClient) {
      new Notice('Synx: 请先登录并选择存储');
      return;
    }
    return this.repositoryWriteCoordinator.run((client) => this.retryReportItemsUnlocked(items, client));
  }

  private async retryReportItemsUnlocked(items: SyncReportItem[], client: RepositoryClient): Promise<void> {
    // 拉仓库树作为远端状态（未初始化时先 init）
    const repo = await this.ensureRepoBase(client);
    const { files: retryFiles } = await this.enumerateLocalFiles(this.getPrevSyncMap());
    this.syncStartSnapshot = new Map(retryFiles.map((file) => [file.path, {
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
      this.repoHeadCommitId = result.head.commitId;
      this.repoHeadGeneration = result.head.generation;
      this.refreshHistoryPanes(true);
    }
    this.finishSyncReport();
    this.invalidateProtectedPrevSyncEntries();
    await this.persist();
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

  private async finalizeMainCommit(input: RepoFinalizeRequest, client: RepositoryClient): Promise<RepoFinalizeResponse> {
    return commitAndIndex(
      () => client.finalizeCommit(input),
      this.historyIndex,
    );
  }

  private async updateHistoryIndexScope(previousUserId?: string | null): Promise<void> {
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

  private startHistoryIndexSync(): void {
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

  private async stopHistoryIndexSync(): Promise<void> {
    this.historyIndexAbort?.abort();
    const task = this.historyIndexSyncTask;
    if (task) await task;
  }

  private getDirectRepositoryScope() {
    const { userId, jwt, storageId, syncFolder } = this.settings;
    if (!userId || !jwt || !storageId || !syncFolder) return null;
    return { userId, jwt, storageId, syncFolder, credentialGeneration: this.credentialCacheGeneration };
  }

  private async selectSyncRepositoryClient(): Promise<RepositoryClient> {
    if (!this.workerClient) throw new Error('Synx 客户端未就绪');
    const scope = this.getDirectRepositoryScope();
    return scope ? this.repositoryTransportSelector.selectSync(scope, this.workerClient) : this.workerClient;
  }

  private rebuildClient(): void {
    this.directRepositoryResolver.invalidate();
    this.repositoryTransportSelector.invalidate();
    const settings = this.settings;
    this.workerClient = settings.serverUrl && settings.jwt && settings.storageId && settings.syncFolder ? new WorkerClient({
      serverUrl: settings.serverUrl,
      jwt: settings.jwt,
      storageId: settings.storageId,
      syncFolder: settings.syncFolder,
      onUnauthorized: () => this.handleUnauthorized(),
      onAuthFailure: (status, storageId) => this.handleAuthFailure(status, storageId),
    }) : null;
    this.repositoryClient = this.workerClient;
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
    if (!this.repositoryClient || !this.settings.storageId) return;
    const target = { storageId: this.settings.storageId, syncFolder: this.settings.syncFolder };
    for (const entry of pendingForTarget(this.pendingDeletions, target)) {
      // git 模型下删除 = 提交中的 delete 变更（原子），不再单独 deleteFile
      this.repoDeletes.set(entry.path, entry.fileUuid ?? `path:${entry.path}`);
      this.pendingDeletions = this.pendingDeletions.filter((item) => item !== entry);
    }
    await this.persist();
  }

  private handleAuthFailure(status: 401 | 403, storageId: string): void {
    this.credentialCacheGeneration++;
    this.directRepositoryResolver.invalidate(status === 403 ? storageId : undefined);
    this.credentialCache = clearCredentialCacheForAuthFailure(this.credentialCache, status, storageId);
    void this.persistState();
  }

  private handleUnauthorized(): void {
    new Notice('Synx: 登录已过期，请重新登录', 5000);
    void this.saveSettings({ jwt: '', userId: null, username: null, storageId: null, storageName: null });
  }

  private async runSync(trigger: SyncTrigger): Promise<void> {
    if (!this.workerClient) return;
    return this.repositoryWriteCoordinator.run((client) => {
      const worker = this.workerClient;
      if (!worker || worker.storageId !== this.settings.storageId || worker.syncFolder !== this.settings.syncFolder) {
        throw new Error('repository scope changed before sync started');
      }
      return this.runSyncUnlocked(trigger, client, worker);
    });
  }

  private async runSyncUnlocked(trigger: SyncTrigger, client: RepositoryClient, roundWorker: WorkerClient): Promise<void> {
    this.reportStore.start(trigger);
    this.updateProgress();
    try {
      const prevSyncMap = this.getPrevSyncMap();
      const { files, skipped } = await this.enumerateLocalFiles(prevSyncMap);
      this.syncStartSnapshot = new Map(files.map((file) => [file.path, {
        exists: true,
        mtime: file.mtime,
        size: file.size,
        hash: file.hash,
      }]));
      this.protectedLocalPaths.clear();
      this.protectedConflictPaths.clear();
      this.protectedLocalCount = 0;

      // 拉取仓库基线：HEAD + 当前树。仓库未初始化时先 init（把现有远端收进 initial 提交）。
      let repo = await this.ensureRepoBase(client);

      let plan: SyncPlan | null = null;
      let skippedRemote: ExecutableSyncAction[] = [];
      let attempt = 0;
      for (; attempt < 2; attempt++) {
        this.repoUploads.clear();
        this.repoDeletes.clear();
        this.repoTree = repo.tree;
        this.repoHeadCommitId = repo.head.commitId;
        this.repoHeadGeneration = repo.head.generation;
        // 消化本地删除队列 → 收集进本次提交的 delete 变更
        await this.flushPendingDeletions();

        // 远端树 → 过滤（被过滤的远端文件不参与同步计划，保留现有行为）
        const remoteEntities = repoTreeToRemote(repo.tree);
        const { remote, skippedRemote: sr } = this.filterRemoteEntities(remoteEntities);
        skippedRemote = sr;
        this.remoteEntities = remote;
        // knownRemoteFiles 缓存：本地删除时判断"远端是否有该文件"
        const targetFiles = remote.map((entity) => ({
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
        plan = planSync(files, this.remoteEntities, 1000, prevSyncMap);
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
        const prevSyncCount = prevSyncMap?.size ?? 0;
        const protectMass = !!prevSyncMap && !this.settings.allowBatchRemoteDelete;
        if (protectMass && shouldProtectAgainstMassDeletion(files.length, prevSyncCount, protectPercent)) {
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
        if (guardedDeletes > 0 || guardedLocalDeletes > 0) {
          console.warn('synx: mass deletion detected, protected data from deletion', { local: files.length, prevSync: prevSyncCount, guardedRemoteDeletes: guardedDeletes, guardedLocalDeletes, protectPercent });
          // #region debug-point B:mass-deletion-guard
          dbg('B', 'main.ts:runSync', 'MASS DELETION GUARDED', { localCount: files.length, prevSyncCount, guardedRemoteDeletes: guardedDeletes, guardedLocalDeletes, protectPercent });
          // #endregion
        }
        const actions: ExecutableSyncAction[] = [
          ...skipped,
          ...skippedRemote,
          ...guardedActions.map((action) => ({ ...action })) as ExecutableSyncAction[],
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
          this.repoHeadCommitId = result.head.commitId;
          this.repoHeadGeneration = result.head.generation;
          break;
        } catch (error) {
          if (isRepoHeadConflict(error)) {
            repo = await this.ensureRepoBase(client);
            continue;
          }
          throw error;
        }
      }
      if (attempt >= 2) throw new Error('同步冲突过多（远端提交被其他设备持续推进），请稍后重试');
      // 提交成功后顺带触发一次垃圾回收：清理"任何提交都未引用"的孤儿内容对象 +
      // 按保留策略做时间机器式历史裁剪。服务端单请求受子请求预算限制，长提交链
      // 一次跑不完（返回 more=true）→ 循环多轮驱动同一批清理收敛；受上限保护，
      // 剩余进度持久化在服务端，下次同步继续，不会卡死。静默执行，失败只记日志，
      // 绝不影响同步结果。
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
      // 同步完成后静默刷新历史面板（不显示 loading、不清空，避免闪烁），
      // 让当前笔记的历史记录立即反映最新版本（含本次 pull 下来的内容）
      this.refreshHistoryPanes(true);
      const report = this.finishSyncReport();
      // 写 .obsidian 同步诊断日志（移动端排查用）
      if (plan) await this.writeObsSyncDebug(files, skipped, skippedRemote, plan, report);
      // 主存储同步完成后，把本地内容镜像到备份存储（仅 push，不 pull）
      await this.mirrorToBackupStorages(files);
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

  private async enumerateLocalFiles(prevSync?: PrevSyncMap): Promise<{ files: LocalFile[]; skipped: ExecutableSyncAction[] }> {
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

  /**
   * 执行动作列表（仅执行，不负责报告的 start/finish/Notice，由 runSync 统一收尾）。
   * push/delete-remote 只收集变更（blob 上传/删除记录），在 runSync 中一次性 finalize 提交；
   * pull/delete-local 立即执行（从仓库当前提交读内容写本地）。
   */
  private async executeActions(actions: ExecutableSyncAction[], client: RepositoryClient): Promise<void> {
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
    const results = await executor.execute(actions);
    const storageId = this.settings.storageId;
    if (storageId) {
      await handleStorageAuthFailures(
        results,
        storageId,
        this.credentialCache,
        (cache) => {
          this.credentialCacheGeneration++;
          this.credentialCache = cache;
        },
        (id) => this.repositoryTransportSelector.invalidate(id),
        this.queueStateWrite,
      );
    }
  }

  /** 报告收尾：finish + 状态栏 + 通知（runSync / retry 共用） */
  private finishSyncReport(): SyncReport {
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
  private async ensureRepoBase(client: RepositoryClient): Promise<{ head: { commitId: string; generation: number }; tree: RepoFile[] }> {
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

  /** 镜像单个备份存储：仓库树 → filter → planSync → 只取 push → 上传 blob + 原子提交 */
  private async mirrorToBackupStorage(storageId: string, storageName: string | null, localFiles: LocalFile[]): Promise<void> {
    const backupClient = new WorkerClient({
      serverUrl: this.settings.serverUrl,
      jwt: this.settings.jwt,
      storageId,
      syncFolder: this.settings.syncFolder,
      onUnauthorized: () => this.handleUnauthorized(),
      onAuthFailure: (status, failedStorageId) => this.handleAuthFailure(status, failedStorageId),
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
        await backupClient.finalizeCommit({
          baseCommitId: resp.head.commitId,
          baseGeneration: resp.head.generation,
          author: this.settings.deviceName,
          message: `镜像 ${changes.length} 个文件`,
          changes,
        });
      }
      stats = { storageId, storageName, push: pushActions.length, success, failed, skipped: skippedCount };
    } catch (error) {
      // 整个备份存储阶段失败（如 list/init 失败）：记录错误，不抛出，不阻塞其他备份
      stats = { storageId, storageName, push: 0, success: 0, failed: 0, skipped: 0, error: normalizeSyncError(error) };
    }
    this.reportStore.recordBackup(stats);
    this.updateProgress();
  }

  private async executeAction(action: Exclude<ExecutableSyncAction, { type: 'skip' }>, client: RepositoryClient): Promise<void | 'protected'> {
    if (action.type === 'push') {
      const original = action as SyncAction;
      if (original.reason === 'conflict-keep-local') await this.executeOrdinaryConflict(action.path, client);
      else await this.executePush(action.path, client);
    } else if (action.type === 'pull') {
      return this.executePull(action.path, client, action.fileUuid);
    } else if (action.type === 'delete-remote') {
      // git 模型下删除 = 提交中的 delete 变更（原子，不再单独 deleteFile）
      this.repoDeletes.set(action.path, action.fileUuid ?? `path:${action.path}`);
    } else {
      return this.deleteLocalFile(action.path);
    }
  }

  private async deleteLocalFile(path: string): Promise<void | 'protected'> {
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

  private async executeOrdinaryConflict(path: string, client: RepositoryClient): Promise<void> {
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
          if (!this.repoHeadCommitId) throw new Error('仓库基线未就绪');
          const remoteContent = await client.repoContent(this.repoHeadCommitId, path);
          await this.writeLocalViaAdapter(resolution.conflictPath, remoteContent);
        } catch {
          // 远端内容拉不到（提交被清理等），退化为直接推送本地
        }
        await this.executePush(path, client);
      } else {
        try {
          const localContent = await this.app.vault.adapter.readBinary(path);
          await this.writeLocalViaAdapter(resolution.conflictPath, localContent);
          await this.executePull(path, client);
          return;
        } catch {
          // 远端内容拉不到时，退化为推送本地，避免冲突处理阻塞同步
        }
        await this.executePush(path, client);
      }
      return;
    }

    const local = this.app.vault.getAbstractFileByPath(path);
    if (!(local instanceof TFile)) return;
    const resolution = resolveConflict({ path, localMtime: local.stat.mtime, remoteMtime: remote.mtime, localType: 'file', remoteType: 'file' }, this.settings.conflictStrategy, this.settings.deviceName, Date.now(), new Set(this.app.vault.getFiles().map((file) => file.path)));
    if (resolution.paused) throw new Error('冲突策略要求暂停并报告');
    if (resolution.outcome === 'keep-local') {
      try {
        if (!this.repoHeadCommitId) throw new Error('仓库基线未就绪');
        const remoteContent = await client.repoContent(this.repoHeadCommitId, path);
        await this.writeLocal(resolution.conflictPath, remoteContent);
      } catch {
        // 远端内容拉不到（提交被清理等），退化为直接推送本地
      }
      await this.executePush(path, client);
    } else {
      try {
        const localContent = await this.app.vault.readBinary(local);
        await this.writeLocal(resolution.conflictPath, localContent);
        await this.executePull(path, client);
        return;
      } catch {
        // 远端内容拉不到时，退化为推送本地
      }
      await this.executePush(path, client);
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

  private async executePush(path: string, client: RepositoryClient): Promise<void> {
    await this.uploadToClient(client, path, this.repoUploads);
  }

  /**
   * 把本地 path 上传为不可变 blob 并收集到 target（主同步/镜像共用）。
   * .obsidian/ 内的文件用底层 adapter 读取；其余用 vault API。
   * 不立即提交：变更集由调用方汇总后一次性 finalize。
   */
  private async uploadToClient(client: RepositoryClient, path: string, target: Map<string, RepoUploadedFile>): Promise<void> {
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
    try {
      const blobId = await uploadRepositoryBlob(client, path, content, mtime, hash, DIRECT_UPLOAD_THRESHOLD);
      target.set(path, {
        path,
        blobId,
        hash,
        size: content.byteLength,
        mtime,
        identity: fileUuid ?? `path:${path}`,
      });
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

  private async findDuplicateUuid(path: string, uuid: string): Promise<boolean> {
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === path) continue;
      if (extractMarkdownUuid(await this.app.vault.read(candidate)) === uuid) return true;
    }
    return false;
  }

  /** .obsidian 写入后回读的实际 mtime（诊断 iOS 写 mtime 是否生效） */
  private obsWriteBackMtimes: Record<string, { expected: number; actual: number | null }> = {};

  private async executePull(path: string, client: RepositoryClient, _fileUuid?: string): Promise<void | 'protected'> {
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

  private async inspectLocalWriteProtection(path: string): Promise<LocalWriteProtection> {
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

  private async readCurrentFileSnapshot(path: string): Promise<SyncStartFileSnapshot> {
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

  private recordProtectedLocalPath(path: string): void {
    if (!this.protectedLocalPaths.has(path)) this.protectedLocalCount++;
    this.protectedLocalPaths.add(path);
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

  private async persist(): Promise<void> {
    // #region debug-point A:persist
    dbg('A', 'main.ts:persist', 'persist (saveData + state)', {
      ts: Date.now(),
      settingsJsonLen: JSON.stringify(this.settings).length,
    });
    // #endregion
    // data.json 只保存 settings（不随同步报告频繁变化）。
    // deviceName 是每设备独立状态，剥离出去存 state，避免 data.json 跨设备同步时
    // 互相覆盖设备名（否则会导致"本地新→push→远端新→pull"的同步抖动）。
    const { deviceName: _deviceName, ...syncableSettings } = this.settings;
    await this.saveData({ settings: syncableSettings } satisfies PersistedPluginData);
    // 运行时状态 + 设备名单独存储，永不被同步
    await this.persistState();
  }

  private buildState(): SynxStateData {
    return writeCredentialCacheToState<SynxStateData>({
      deviceName: this.settings.deviceName,
      reports: this.reportStore.reports,
      pendingDeletions: this.pendingDeletions,
      knownRemoteFiles: this.knownRemoteFiles,
      prevSync: this.prevSync ?? undefined,
      pendingImageUploads: this.pendingImageUploads,
    }, this.credentialCache);
  }

  private async persistState(): Promise<void> {
    try {
      await this.queueStateWrite();
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

  private invalidateProtectedPrevSyncEntries(): void {
    if (!this.prevSync || this.protectedLocalPaths.size === 0) return;
    this.prevSync = {
      ...this.prevSync,
      entries: withoutProtectedPrevSyncEntries(this.prevSync.entries, this.protectedLocalPaths),
    };
  }

  /** 同步成功后重建 prevSync 快照：重新枚举本地 + 用最近拉取的仓库树作为远端状态 */
  private async rebuildPrevSync(): Promise<void> {
    if (!this.repositoryClient || !this.settings.storageId) return;
    // #region debug-point B:rebuild-prevsync
    const dbgT0 = Date.now();
    // #endregion
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
    this.statusBarItem.setText(formatStatusBar(!!this.workerClient, this.reportStore.current));
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
    else if (!this.workerClient) this.ribbonIcon.setAttribute('aria-label', 'Synx 未连接');
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

  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType)[0];
    const leaf = existing ?? workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: viewType, active: true });
    workspace.revealLeaf(leaf);
  }
}