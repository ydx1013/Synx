import { describe, expect, it } from 'vitest';
import { loadPluginSettings, maxFileSizeMbToBytes, maxFileSizeBytesToMb } from './settings.js';

describe('保留策略单文件上限换算（UI 用 MB，存储用字节；0=不限）', () => {
  it('MB 转字节：50 -> 52428800', () => {
    expect(maxFileSizeMbToBytes(50)).toBe(50 * 1024 * 1024);
  });
  it('字节转 MB：52428800 -> 50', () => {
    expect(maxFileSizeBytesToMb(50 * 1024 * 1024)).toBe(50);
  });
  it('0 表示不限，双向保持 0', () => {
    expect(maxFileSizeMbToBytes(0)).toBe(0);
    expect(maxFileSizeBytesToMb(0)).toBe(0);
  });
});


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
    expect(settings.reportRetention).toBe(100);
    expect(settings.conflictStrategy).toBe('newer-with-copy');
  });

  it('uses a lower concurrency default on mobile', () => {
    expect(loadPluginSettings({}, true).concurrency).toBe(2);
    expect(loadPluginSettings({}, false).concurrency).toBe(5);
  });

  it('defaults history style to cards and accepts timeline', () => {
    expect(loadPluginSettings({}, false).historyStyle).toBe('cards');
    expect(loadPluginSettings({ historyStyle: 'timeline' }, false).historyStyle).toBe('timeline');
    expect(loadPluginSettings({ historyStyle: 'invalid' }, false).historyStyle).toBe('cards');
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

  it('defaults retention policy to hourly 24 / daily 30 / monthly 12 / yearly 5', () => {
    const settings = loadPluginSettings({}, false);
    expect(settings.retention.hourlyWindowHours).toBe(24);
    expect(settings.retention.dailyWindowDays).toBe(30);
    expect(settings.retention.monthlyWindowMonths).toBe(12);
    expect(settings.retention.yearlyWindowYears).toBe(5);
    expect(settings.retention.maxVersionsPerFile).toBe(1000);
  });

  it('loads a custom retention policy', () => {
    const settings = loadPluginSettings({
      retention: { hourlyWindowHours: 12, dailyWindowDays: 7, monthlyWindowMonths: 2, yearlyWindowYears: 1, maxVersionsPerFile: 50 },
    }, false);
    expect(settings.retention.hourlyWindowHours).toBe(12);
    expect(settings.retention.dailyWindowDays).toBe(7);
    expect(settings.retention.maxVersionsPerFile).toBe(50);
  });

  it('falls back to defaults for invalid retention fields', () => {
    const settings = loadPluginSettings({
      retention: { hourlyWindowHours: -3, dailyWindowDays: 7.5, monthlyWindowMonths: 'x' },
    }, false);
    expect(settings.retention.hourlyWindowHours).toBe(24);
    expect(settings.retention.dailyWindowDays).toBe(7); // 7.5 向下取整为 7
    expect(settings.retention.monthlyWindowMonths).toBe(12);
  });
});
