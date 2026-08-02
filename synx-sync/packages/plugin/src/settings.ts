import type { RetentionPolicy, StorageSummary } from '@synx/shared';

export type ConflictStrategy = 'newer-with-copy' | 'keep-local' | 'keep-remote' | 'pause';
export type HistoryStyle = 'cards' | 'timeline';

export interface SynxPluginSettings {
  serverUrl: string;
  jwt: string;
  userId: string | null;
  username: string | null;
  storageId: string | null;
  storageName: string | null;
  /** 备份存储 ID 列表：主存储同步完成后，本地内容会以仅 push 方式镜像到这些存储 */
  backupStorageIds: string[];
  syncFolder: string;
  deviceName: string;
  periodicSyncEnabled: boolean;
  autoSyncIntervalMin: number;
  startupSyncEnabled: boolean;
  startupDelaySec: number;
  saveSyncDelaySec: number;
  maxFileSizeMb: number;
  concurrency: number;
  syncConfigDir: boolean;
  syncUnderscorePaths: boolean;
  ignorePatterns: string[];
  allowPatterns: string[];
  conflictStrategy: ConflictStrategy;
  showStatusBar: boolean;
  reportRetention: number;
  showMarkdownUuid: boolean;
  historyStyle: HistoryStyle;
  /** 批量删除保护：本地文件数低于上次同步记录该百分比时，视为"骤降"（默认 50） */
  massDeleteProtectPercent: number;
  /** 仅当打开此开关时，骤降保护下才真正执行 delete-remote；否则一律转 pull */
  allowBatchRemoteDelete: boolean;
  /** 生成同步诊断日志（synx-debug-<device>.md）。默认关闭=不生成，调试时才开启 */
  enableDebugLog: boolean;
  /** 版本保留策略（按 storage 独立存储于远端） */
  retention: RetentionPolicy;
}

export const SYNX_LOGIN_URL = 'https://synx.yueyang.eu.org/login';

const deviceName = 'obsidian-' + Math.random().toString(36).slice(2, 8);

export const DEFAULT_SETTINGS: SynxPluginSettings = {
  serverUrl: SYNX_LOGIN_URL,
  jwt: '',
  userId: null,
  username: null,
  storageId: null,
  storageName: null,
  backupStorageIds: [],
  syncFolder: 'my-vault/',
  deviceName,
  periodicSyncEnabled: true,
  autoSyncIntervalMin: 5,
  startupSyncEnabled: true,
  startupDelaySec: 5,
  saveSyncDelaySec: 5,
  maxFileSizeMb: 20,
  concurrency: 2,
  syncConfigDir: false,
  syncUnderscorePaths: false,
  ignorePatterns: [],
  allowPatterns: [],
  conflictStrategy: 'newer-with-copy',
  showStatusBar: true,
  reportRetention: 1,
  showMarkdownUuid: false,
  historyStyle: 'cards',
  massDeleteProtectPercent: 50,
  allowBatchRemoteDelete: false,
  enableDebugLog: false,
  retention: {
    maxFileSize: 20 * 1024 * 1024,
    hourlyWindowHours: 60,
    dailyWindowDays: 24,
    monthlyWindowMonths: 30,
    yearlyWindowYears: 3,
    maxVersionsPerFile: 1000,
  },
};

const conflictStrategies = new Set<ConflictStrategy>(['newer-with-copy', 'keep-local', 'keep-remote', 'pause']);
const historyStyles = new Set<HistoryStyle>(['cards', 'timeline']);
const saveDelays = new Set([0, 5, 10, 30]);
const concurrencyValues = new Set([1, 2, 3, 5, 10]);
const fileSizeValues = new Set([0, 1, 5, 10, 20, 50, 100, 200, 500, 1000]);

export function loadPluginSettings(raw: unknown, isMobile: boolean): SynxPluginSettings {
  const source = isRecord(raw) ? raw : {};
  const defaults = { ...DEFAULT_SETTINGS, concurrency: isMobile ? 2 : 5 };
  const legacyInterval = validPositiveNumber(source.autoSyncIntervalMin) ? source.autoSyncIntervalMin : defaults.autoSyncIntervalMin;
  return {
    serverUrl: SYNX_LOGIN_URL,
    jwt: stringValue(source.jwt, defaults.jwt),
    userId: nullableString(source.userId),
    username: nullableString(source.username),
    storageId: nullableString(source.storageId),
    storageName: nullableString(source.storageName),
    backupStorageIds: normalizeStorageIds(source.backupStorageIds),
    syncFolder: stringValue(source.syncFolder, defaults.syncFolder),
    deviceName: stringValue(source.deviceName, defaults.deviceName),
    periodicSyncEnabled: booleanValue(source.periodicSyncEnabled, legacyInterval > 0),
    autoSyncIntervalMin: legacyInterval,
    startupSyncEnabled: booleanValue(source.startupSyncEnabled, defaults.startupSyncEnabled),
    startupDelaySec: validNonNegativeNumber(source.startupDelaySec) ? source.startupDelaySec : defaults.startupDelaySec,
    saveSyncDelaySec: typeof source.saveSyncDelaySec === 'number' && saveDelays.has(source.saveSyncDelaySec) ? source.saveSyncDelaySec : defaults.saveSyncDelaySec,
    maxFileSizeMb: typeof source.maxFileSizeMb === 'number' && fileSizeValues.has(source.maxFileSizeMb) ? source.maxFileSizeMb : defaults.maxFileSizeMb,
    concurrency: typeof source.concurrency === 'number' && concurrencyValues.has(source.concurrency) ? source.concurrency : defaults.concurrency,
    syncConfigDir: booleanValue(source.syncConfigDir, defaults.syncConfigDir),
    syncUnderscorePaths: booleanValue(source.syncUnderscorePaths, defaults.syncUnderscorePaths),
    ignorePatterns: normalizeRules(source.ignorePatterns),
    allowPatterns: normalizeRules(source.allowPatterns),
    conflictStrategy: typeof source.conflictStrategy === 'string' && conflictStrategies.has(source.conflictStrategy as ConflictStrategy) ? source.conflictStrategy as ConflictStrategy : defaults.conflictStrategy,
    showStatusBar: booleanValue(source.showStatusBar, defaults.showStatusBar),
    reportRetention: validPositiveNumber(source.reportRetention) ? Math.min(100, Math.floor(source.reportRetention)) : defaults.reportRetention,
    showMarkdownUuid: booleanValue(source.showMarkdownUuid, defaults.showMarkdownUuid),
    historyStyle: typeof source.historyStyle === 'string' && historyStyles.has(source.historyStyle as HistoryStyle) ? source.historyStyle as HistoryStyle : defaults.historyStyle,
    massDeleteProtectPercent: validPercentage(source.massDeleteProtectPercent) ? source.massDeleteProtectPercent : defaults.massDeleteProtectPercent,
    allowBatchRemoteDelete: booleanValue(source.allowBatchRemoteDelete, defaults.allowBatchRemoteDelete),
    enableDebugLog: booleanValue(source.enableDebugLog, defaults.enableDebugLog),
    retention: normalizeRetention(source.retention, defaults.retention),
  };
}

/** 校验并归一化保留策略：每层窗口取非负整数，非法字段回退默认 */
function normalizeRetention(value: unknown, fallback: RetentionPolicy): RetentionPolicy {
  const source = isRecord(value) ? value : {};
  const num = (field: string): number => {
    const n = source[field];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback[field as keyof RetentionPolicy] as number;
  };
  return {
    maxFileSize: num('maxFileSize'),
    hourlyWindowHours: num('hourlyWindowHours'),
    dailyWindowDays: num('dailyWindowDays'),
    monthlyWindowMonths: num('monthlyWindowMonths'),
    yearlyWindowYears: num('yearlyWindowYears'),
    maxVersionsPerFile: num('maxVersionsPerFile'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function validPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 百分比校验：1-100 的整数 */
function validPercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeRules(value: unknown): string[] {
  const values = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  return values.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/** 解析备份存储 ID 列表：去重、去空白、过滤空串 */
function normalizeStorageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export type StorageSummaryItem = Pick<StorageSummary, 'id' | 'name' | 'type'>;
