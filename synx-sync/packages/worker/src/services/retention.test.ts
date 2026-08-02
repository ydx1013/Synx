import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, type RetentionPolicy, type VersionRecord } from '@synx/shared';
import { FileTooLarge, enforceMaxFileSize, getRetentionPolicy, normalizePolicy, selectVersionsToKeep } from './retention.js';

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

function makeVersion(id: string, createdAt: number): VersionRecord {
  return {
    userId: 'u',
    storageId: 's',
    path: 'note.md',
    versionId: id,
    mtime: createdAt,
    size: 1,
    hash: id,
    storageKey: `k/${id}`,
    isCurrent: 0,
    author: null,
    createdAt,
  };
}

describe('enforceMaxFileSize', () => {
  it('passes when size does not exceed max', () => {
    const policy = { maxVersionsPerFile: 0, maxFileSize: 100 } as RetentionPolicy;
    expect(() => enforceMaxFileSize(100, policy)).not.toThrow();
  });

  it('throws FileTooLarge when size exceeds max', () => {
    const policy = { maxVersionsPerFile: 0, maxFileSize: 100 } as RetentionPolicy;
    expect(() => enforceMaxFileSize(101, policy)).toThrow(FileTooLarge);
  });

  it('passes when maxFileSize is unlimited', () => {
    const policy = { maxVersionsPerFile: 0, maxFileSize: 0 } as RetentionPolicy;
    expect(() => enforceMaxFileSize(Number.MAX_SAFE_INTEGER, policy)).not.toThrow();
  });
});

describe('getRetentionPolicy', () => {
  it('returns the default retention policy', async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    await expect(getRetentionPolicy({ DB: db } as any, 'storage-1')).resolves.toEqual(DEFAULT_RETENTION);
  });

  it('reads a stored policy from D1', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ retention_policy: JSON.stringify({ hourlyWindowHours: 12, dailyWindowDays: 7 }) }) }),
      }),
    };
    const policy = await getRetentionPolicy({ DB: db } as any, 'storage-1');
    expect(policy.hourlyWindowHours).toBe(12);
    expect(policy.dailyWindowDays).toBe(7);
    expect(policy.maxVersionsPerFile).toBe(DEFAULT_RETENTION.maxVersionsPerFile);
  });

  it('falls back to default when stored policy is invalid JSON', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ retention_policy: 'not-json' }) }),
      }),
    };
    await expect(getRetentionPolicy({ DB: db } as any, 'storage-1')).resolves.toEqual(DEFAULT_RETENTION);
  });
});

describe('normalizePolicy', () => {
  it('clamps negative and non-numeric values to defaults', () => {
    const policy = normalizePolicy({ hourlyWindowHours: -5, maxVersionsPerFile: Number.NaN } as any);
    expect(policy.hourlyWindowHours).toBe(DEFAULT_RETENTION.hourlyWindowHours);
    expect(policy.maxVersionsPerFile).toBe(DEFAULT_RETENTION.maxVersionsPerFile);
  });
});

describe('selectVersionsToKeep', () => {
  // 参考时间设为「整点 + 30 分钟」，保证测试版本做分钟级偏移时不跨桶边界
  const now = 1_700_000_000_000 - (1_700_000_000_000 % MS_HOUR) + 30 * 60 * 1000; // 22:30 整
  const DEFAULT_TEST_POLICY: RetentionPolicy = {
    maxFileSize: 0,
    hourlyWindowHours: 24,
    dailyWindowDays: 7,
    monthlyWindowMonths: 3,
    yearlyWindowYears: 1,
    maxVersionsPerFile: 1000,
  };

  it('keeps one version per hour bucket within the hour window', () => {
    // 3 个版本，跨 3 个不同小时桶（间隔 1 小时）
    const history = [makeVersion('h3', now), makeVersion('h2', now - 1 * MS_HOUR), makeVersion('h1', now - 2 * MS_HOUR)];
    const keep = selectVersionsToKeep(history, { ...DEFAULT_TEST_POLICY, dailyWindowDays: 0, monthlyWindowMonths: 0, yearlyWindowYears: 0 }, now);
    expect(keep.size).toBe(3);
    expect(keep.has('h3')).toBe(true);
    expect(keep.has('h2')).toBe(true);
    expect(keep.has('h1')).toBe(true);
  });

  it('keeps only one version per hour bucket when multiple fall in the same hour', () => {
    // 同一小时内 3 个版本（间隔 10 分钟，都落在 now 所在小时桶）
    const history = [makeVersion('a', now), makeVersion('b', now - 10 * 60 * 1000), makeVersion('c', now - 20 * 60 * 1000)];
    const keep = selectVersionsToKeep(history, { ...DEFAULT_TEST_POLICY, dailyWindowDays: 0, monthlyWindowMonths: 0, yearlyWindowYears: 0 }, now);
    expect(keep.size).toBe(1); // 同一小时桶只保留最新 1 份
    expect(keep.has('a')).toBe(true);
  });

  it('keeps one version per day bucket within the daily window', () => {
    // 3 天每天 2 个版本（间隔 1 天，对齐到天桶边界）
    const history = [
      makeVersion('d3a', now - 1 * MS_DAY),
      makeVersion('d3b', now - 1 * MS_DAY - 30 * 60 * 1000),
      makeVersion('d2a', now - 2 * MS_DAY),
      makeVersion('d2b', now - 2 * MS_DAY - 30 * 60 * 1000),
      makeVersion('d1a', now - 3 * MS_DAY + 60 * 60 * 1000), // age < 3 天，严格在窗口内
      makeVersion('d1b', now - 3 * MS_DAY + 30 * 60 * 1000),
    ];
    const keep = selectVersionsToKeep(history, { ...DEFAULT_TEST_POLICY, hourlyWindowHours: 0, dailyWindowDays: 3, monthlyWindowMonths: 0, yearlyWindowYears: 0 }, now);
    expect(keep.size).toBe(3); // 每天桶 1 份
    expect(keep.has('d3a')).toBe(true);
    expect(keep.has('d2a')).toBe(true);
    expect(keep.has('d1a')).toBe(true);
  });

  it('drops versions older than the yearly window', () => {
    // 超过 1 年：不保留
    const history = [makeVersion('recent', now - 300 * MS_DAY), makeVersion('old', now - 2 * 365 * MS_DAY)];
    const keep = selectVersionsToKeep(history, DEFAULT_TEST_POLICY, now);
    expect(keep.has('recent')).toBe(true);
    expect(keep.has('old')).toBe(false);
  });

  it('respects the maxVersionsPerFile cap', () => {
    const history = [makeVersion('m3', now), makeVersion('m2', now - MS_HOUR), makeVersion('m1', now - 2 * MS_HOUR)];
    const keep = selectVersionsToKeep(history, { ...DEFAULT_TEST_POLICY, maxVersionsPerFile: 2 }, now);
    expect(keep.size).toBe(2); // 只保留最新 2 份
  });

  it('keeps everything when all windows are zero', () => {
    const history = [makeVersion('z1', now), makeVersion('z2', now - MS_DAY), makeVersion('z3', now - 2 * MS_DAY)];
    const keep = selectVersionsToKeep(history, { ...DEFAULT_TEST_POLICY, hourlyWindowHours: 0, dailyWindowDays: 0, monthlyWindowMonths: 0, yearlyWindowYears: 0 }, now);
    expect(keep.size).toBe(3);
  });

  it('keeps one version per year bucket within the yearly window', () => {
    const history = [
      makeVersion('y1', now),
      makeVersion('y2', now - 365 * MS_DAY), // 去年
    ];
    const keep = selectVersionsToKeep(history, { ...DEFAULT_TEST_POLICY, hourlyWindowHours: 0, dailyWindowDays: 0, monthlyWindowMonths: 0, yearlyWindowYears: 2 }, now);
    // 2 年窗口内，两个版本属于不同年桶 → 各保留 1 份
    expect(keep.size).toBe(2);
    expect(keep.has('y1')).toBe(true);
    expect(keep.has('y2')).toBe(true);
  });
});
