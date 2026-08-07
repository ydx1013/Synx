import type { StorageCredentialsResponse } from '@synx/shared';
import { Plugin } from 'obsidian';
import type { SyncReport, SyncReportItem } from './syncReport.js';
import type { RepositoryClient } from './repositoryClient.js';
import type { WorkerClient } from './workerClient.js';
import type { HistoryIndex } from './historyIndex.js';
import type { SynxPluginSettings } from './settings.js';
import { DirectRepositoryResolver } from './directRepositoryResolver.js';
import { RepositoryTransportSelector } from './repositoryTransportSelector.js';
import { loginSessionFromRepositoryScope } from './loginSessionGuard.js';
import { PluginRuntime } from './pluginRuntime.js';

export default class SynxSyncPlugin extends Plugin {
  private readonly runtime = new PluginRuntime(this as never);
  declare settings: SynxPluginSettings;

  async onload(): Promise<void> {
    const resolver = new DirectRepositoryResolver(
      async () => {
        const credentials = await this.runtime.getStorageCredentials();
        if (!credentials) throw new Error('存储凭证不可用');
        return credentials;
      },
      undefined,
      undefined,
      (scope) => this.runtime.createCredentialRefreshHandlers(scope),
    );
    const selector = new RepositoryTransportSelector(
      resolver,
      (status, storageId, scope) => this.runtime.handleAuthFailure(status, storageId, loginSessionFromRepositoryScope(scope)),
    );
    this.runtime.setRepositoryInfrastructure(resolver, selector);
    await this.runtime.load();
    this.settings = this.runtime.settings;
  }

  async onunload(): Promise<void> { await this.runtime.unload(); }
  async loadSettings(): Promise<void> {
    await this.runtime.loadSettings();
    this.settings = this.runtime.settings;
  }
  async saveSettings(patch: Partial<SynxPluginSettings>): Promise<void> {
    await this.runtime.saveSettings(patch);
    this.settings = this.runtime.settings;
  }
  getWorkerClient(): WorkerClient | null { return this.runtime.getWorkerClient(); }
  getRepositoryClient(): RepositoryClient | null { return this.runtime.getRepositoryClient(); }
  getRepositoryClientAsync(): Promise<RepositoryClient | null> { return this.runtime.getRepositoryClientAsync(); }
  getStorageCredentials(): Promise<StorageCredentialsResponse | null> { return this.runtime.getStorageCredentials(); }
  scanUnusedImages(): Promise<void> { return this.runtime.scanUnusedImages(); }
  getFileUuid(path: string): Promise<string | undefined> { return this.runtime.getFileUuid(path); }
  getSyncReports(): readonly SyncReport[] { return this.runtime.getSyncReports(); }
  getCurrentSyncReport(): SyncReport | null { return this.runtime.getCurrentSyncReport(); }
  onLogin(): Promise<void> { return this.runtime.onLogin(); }
  onStorageChanged(): Promise<void> { return this.runtime.onStorageChanged(); }
  syncRetentionFromRemote(): Promise<void> { return this.runtime.syncRetentionFromRemote(); }
  triggerSync(): Promise<void> { return this.runtime.triggerSync(); }
  rescheduleAutoSync(): void { this.runtime.rescheduleAutoSync(); }
  retryReportItems(items: SyncReportItem[]): Promise<void> { return this.runtime.retryReportItems(items); }
  rollbackFile(request: { path: string; targetCommitId: string; targetPath: string }): Promise<void> { return this.runtime.rollbackFile(request); }
  clearSyncReports(): Promise<void> { return this.runtime.clearSyncReports(); }
  activateHistoryPane(): Promise<void> { return this.runtime.activateHistoryPane(); }
  activateSyncDetails(): Promise<void> { return this.runtime.activateSyncDetails(); }
  getHistoryIndex(): HistoryIndex { return this.runtime.getHistoryIndex(); }
}
