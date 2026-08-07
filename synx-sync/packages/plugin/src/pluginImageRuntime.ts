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

export class PluginImageRuntime extends RuntimeBase {
  public renderPrivateImages(element: HTMLElement): void {
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

  public imageUploadReady(): boolean {
    return Boolean(this.settings.imageHostingEnabled && this.settings.imageGalleryId && this.settings.jwt && this.workerClient);
  }

  public selectImageMigrationFolder(): void {
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

  public async previewFolderImageMigration(folder: TFolder): Promise<void> {
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

  public async migrateFolderImages(notes: Array<{ path: string; content: string }>, plan: ReturnType<typeof buildFolderMigrationPlan>): Promise<void> {
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

  public async confirmFolderAttachmentCleanup(files: TFile[]): Promise<void> {
    const deletable: TFile[] = [];
    for (const file of files) {
      if (!(await this.isAttachmentReferenced(file.path))) deletable.push(file);
    }
    if (deletable.length === 0) return;
    new ConfirmModal(this.app, `发现 ${deletable.length} 个已无任何笔记引用的本地附件，确认删除？`, () => {
      void this.deleteMigratedAttachments(deletable);
    }).open();
  }

  public safeDecodeImageSource(source: string): string {
    try {
      return decodeURIComponent(source);
    } catch {
      return source;
    }
  }

  public async previewCurrentNoteImageMigration(): Promise<void> {
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

  public async migrateCurrentNoteImages(view: MarkdownView, note: TFile, candidates: ImageCandidate[]): Promise<void> {
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

  public async readImageCandidate(candidate: ImageCandidate, note: TFile): Promise<{ bytes: ArrayBuffer; mimeType: string; localFile?: TFile }> {
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

  public assertSupportedImageType(mimeType: string): void {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'].includes(mimeType)) {
      throw new Error(`不支持的图片类型：${mimeType || '未知'}`);
    }
  }

  public mimeTypeForExtension(extension: string): string {
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' } as Record<string, string>)[extension.toLowerCase()] ?? '';
  }

  public async isAttachmentReferenced(attachmentPath: string, currentNotePath?: string, currentContent?: string): Promise<boolean> {
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

  public async deleteMigratedAttachments(files: TFile[]): Promise<void> {
    let deleted = 0;
    for (const file of files) {
      if (await this.isAttachmentReferenced(file.path)) continue;
      await this.app.vault.trash(file, true);
      deleted++;
    }
    new Notice(`已删除 ${deleted} 个未被引用的本地附件`);
  }

  public async handleImagePaste(event: ClipboardEvent): Promise<void> {
    if (!this.imageUploadReady()) return;
    const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    await this.uploadImageIntoEditor(file, view);
  }

  public async handleImageDrop(event: DragEvent): Promise<void> {
    if (!this.imageUploadReady()) return;
    const file = Array.from(event.dataTransfer?.files ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    await this.uploadImageIntoEditor(file, view);
  }

  public async uploadImageIntoEditor(file: File, view: MarkdownView): Promise<void> {
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

  public async saveFailedImageLocally(file: File, view: MarkdownView, placeholder: string, error: unknown): Promise<void> {
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

  public async retryPendingImageUploads(): Promise<void> {
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

  public async localImageReferenced(localPath: string, replacedNotePath: string): Promise<boolean> {
    const fileName = localPath.split('/').pop() ?? localPath;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === replacedNotePath) continue;
      const content = await this.app.vault.cachedRead(file);
      if (content.includes(localPath) || content.includes(fileName)) return true;
    }
    return false;
  }

  public replaceEditorText(view: MarkdownView, search: string, replacement: string): boolean {
    const value = view.editor.getValue();
    const offset = value.indexOf(search);
    if (offset < 0) return false;
    const from = view.editor.offsetToPos(offset);
    const to = view.editor.offsetToPos(offset + search.length);
    view.editor.replaceRange(replacement, from, to);
    return true;
  }

}
