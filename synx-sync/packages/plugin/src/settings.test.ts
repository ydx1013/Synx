import { describe, expect, it } from 'vitest';
import { loadPluginSettings } from './settings.js';

describe('loadPluginSettings', () => {
  it('always uses the fixed Synx login URL', () => {
    expect(loadPluginSettings(undefined, false).serverUrl).toBe('https://synx.yueyang.eu.org/login');
    expect(loadPluginSettings({ serverUrl: 'https://other.example.com' }, false).serverUrl).toBe('https://synx.yueyang.eu.org/login');
  });
  it('migrates legacy settings without losing account and storage data', () => {
    const settings = loadPluginSettings({
      serverUrl: 'https://synx.yueyang.eu.org/login',
      jwt: 'token',
      userId: 'user-1',
      username: 'alice',
      storageId: 'storage-1',
      storageName: 'Primary',
      syncFolder: 'vault/',
      deviceName: 'desktop',
      autoSyncIntervalMin: 15,
    }, false);

    expect(settings).toMatchObject({
      serverUrl: 'https://synx.yueyang.eu.org/login',
      jwt: 'token',
      userId: 'user-1',
      username: 'alice',
      storageId: 'storage-1',
      storageName: 'Primary',
      syncFolder: 'vault/',
      deviceName: 'desktop',
      periodicSyncEnabled: true,
      autoSyncIntervalMin: 15,
    });
  });

  it('uses safe defaults for invalid persisted values', () => {
    const settings = loadPluginSettings({
      autoSyncIntervalMin: -4,
      startupDelaySec: Number.NaN,
      saveSyncDelaySec: 12,
      maxFileSizeMb: -1,
      concurrency: 99,
      reportRetention: 0,
      conflictStrategy: 'delete-both',
    }, false);

    expect(settings.autoSyncIntervalMin).toBe(5);
    expect(settings.startupDelaySec).toBe(5);
    expect(settings.saveSyncDelaySec).toBe(5);
    expect(settings.maxFileSizeMb).toBe(20);
    expect(settings.concurrency).toBe(5);
    expect(settings.reportRetention).toBe(1);
    expect(settings.conflictStrategy).toBe('newer-with-copy');
  });

  it('uses a lower concurrency default on mobile', () => {
    expect(loadPluginSettings({}, true).concurrency).toBe(2);
    expect(loadPluginSettings({}, false).concurrency).toBe(5);
  });

  it('normalizes backup storage ids (dedupe, trim, drop empty)', () => {
    const settings = loadPluginSettings({
      backupStorageIds: [' s1 ', 's2', 's1', '', '  ', 's3'],
    }, false);
    expect(settings.backupStorageIds).toEqual(['s1', 's2', 's3']);
  });

  it('defaults backup storage ids to empty array', () => {
    expect(loadPluginSettings({}, false).backupStorageIds).toEqual([]);
    expect(loadPluginSettings({ backupStorageIds: 'not-an-array' }, false).backupStorageIds).toEqual([]);
  });

  it('normalizes path rules and accepts supported custom timings', () => {
    const settings = loadPluginSettings({
      autoSyncIntervalMin: 7,
      startupDelaySec: 12,
      saveSyncDelaySec: 0,
      ignorePatterns: ' tmp/**\n\n*.bak ',
      allowPatterns: ['notes/**', '', ' docs/** '],
    }, false);

    expect(settings.autoSyncIntervalMin).toBe(7);
    expect(settings.startupDelaySec).toBe(12);
    expect(settings.saveSyncDelaySec).toBe(0);
    expect(settings.ignorePatterns).toEqual(['tmp/**', '*.bak']);
    expect(settings.allowPatterns).toEqual(['notes/**', 'docs/**']);
  });

  it('defaults deletion guard to 50% threshold with batch delete disabled', () => {
    expect(loadPluginSettings({}, false).massDeleteProtectPercent).toBe(50);
    expect(loadPluginSettings({}, false).allowBatchRemoteDelete).toBe(false);
  });

  it('loads and validates deletion guard settings', () => {
    const settings = loadPluginSettings({
      massDeleteProtectPercent: 30,
      allowBatchRemoteDelete: true,
    }, false);
    expect(settings.massDeleteProtectPercent).toBe(30);
    expect(settings.allowBatchRemoteDelete).toBe(true);
  });

  it('falls back to defaults for invalid deletion guard values', () => {
    expect(loadPluginSettings({ massDeleteProtectPercent: 0 }, false).massDeleteProtectPercent).toBe(50);
    expect(loadPluginSettings({ massDeleteProtectPercent: 101 }, false).massDeleteProtectPercent).toBe(50);
    expect(loadPluginSettings({ massDeleteProtectPercent: 55.5 }, false).massDeleteProtectPercent).toBe(50);
  });
});
