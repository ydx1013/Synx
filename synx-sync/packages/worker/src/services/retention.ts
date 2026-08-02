import { DEFAULT_RETENTION, type RetentionPolicy, type VersionRecord } from '@synx/shared';
import type { Env } from '../types.js';

export class FileTooLarge extends Error {
  constructor(public maxSize: number, public actualSize: number) {
    super(`file size ${actualSize} exceeds max ${maxSize}`);
    this.name = 'FileTooLarge';
  }
}

/** D1 storages 表行（含可选的保留策略列） */
interface StorageRow {
  id: string;
  retention_policy: string | null;
}

/**
 * 读取 storage 的保留策略。
 * - 数据库无该列或值为 NULL → 使用默认策略
 * - 值非法（解析失败/字段越界）→ 使用默认策略，不影响同步
 */
export async function getRetentionPolicy(env: Env, storageId: string): Promise<RetentionPolicy> {
  try {
    const row = await env.DB.prepare('SELECT retention_policy FROM storages WHERE id = ?')
      .bind(storageId)
      .first<StorageRow>();
    if (!row?.retention_policy) return DEFAULT_RETENTION;
    const parsed = JSON.parse(row.retention_policy) as Partial<RetentionPolicy>;
    return normalizePolicy(parsed);
  } catch {
    return DEFAULT_RETENTION;
  }
}

/** 校验并归一化策略：非法值回退默认，负数/NaN 回退默认，全 0（各层都 0）等价于不裁剪 */
export function normalizePolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
  const num = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return n >= 0 ? n : fallback;
  };
  return {
    maxFileSize: num(input.maxFileSize, DEFAULT_RETENTION.maxFileSize),
    hourlyWindowHours: num(input.hourlyWindowHours, DEFAULT_RETENTION.hourlyWindowHours),
    dailyWindowDays: num(input.dailyWindowDays, DEFAULT_RETENTION.dailyWindowDays),
    monthlyWindowMonths: num(input.monthlyWindowMonths, DEFAULT_RETENTION.monthlyWindowMonths),
    yearlyWindowYears: num(input.yearlyWindowYears, DEFAULT_RETENTION.yearlyWindowYears),
    maxVersionsPerFile: num(input.maxVersionsPerFile, DEFAULT_RETENTION.maxVersionsPerFile),
  };
}

export function enforceMaxFileSize(size: number, policy: RetentionPolicy): void {
  if (policy.maxFileSize > 0 && size > policy.maxFileSize) {
    throw new FileTooLarge(policy.maxFileSize, size);
  }
}

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

/**
 * 时间桶分层保留算法。
 *
 * 每个版本按其「年龄」归入某一层，每层只在各自的时间桶内保留最新 1 份：
 * - 最近 hourlyWindowHours 小时内  → 每小时桶（hour）
 * - 最近 dailyWindowDays 天内      → 每天桶（day）
 * - 最近 monthlyWindowMonths 月内  → 每月桶（month）
 * - 最近 yearlyWindowYears 年内    → 每年桶（year）
 * - 更早的                         → 删除
 *
 * 输入 history 需按 createdAt 降序（新 → 旧）。返回应保留的版本集合。
 * 同时受 maxVersionsPerFile 总上限约束（保留最新的 N 份）。
 * 各层窗口全为 0 时不做裁剪（返回全部）。
 */
export function selectVersionsToKeep(history: VersionRecord[], policy: RetentionPolicy, now = Date.now()): Set<string> {
  if (history.length === 0) return new Set();
  const allZero =
    policy.hourlyWindowHours === 0 &&
    policy.dailyWindowDays === 0 &&
    policy.monthlyWindowMonths === 0 &&
    policy.yearlyWindowYears === 0;
  if (allZero) return new Set(history.map((v) => v.versionId));

  const keep = new Set<string>();
  const seenHour = new Set<number>();
  const seenDay = new Set<number>();
  const seenMonth = new Set<number>();
  const seenYear = new Set<number>();

  for (const version of history) {
    if (policy.maxVersionsPerFile > 0 && keep.size >= policy.maxVersionsPerFile) break;
    const age = now - version.createdAt;

    // 最内层（小时）优先：越近的层越先占用该版本，保证就近保留密度最高
    if (policy.hourlyWindowHours > 0 && age < policy.hourlyWindowHours * MS_HOUR) {
      const bucket = Math.floor(version.createdAt / MS_HOUR);
      if (!seenHour.has(bucket)) {
        seenHour.add(bucket);
        keep.add(version.versionId);
      }
      continue;
    }
    if (policy.dailyWindowDays > 0 && age < policy.dailyWindowDays * MS_DAY) {
      const bucket = Math.floor(version.createdAt / MS_DAY);
      if (!seenDay.has(bucket)) {
        seenDay.add(bucket);
        keep.add(version.versionId);
      }
      continue;
    }
    if (policy.monthlyWindowMonths > 0 && age < policy.monthlyWindowMonths * 30.44 * MS_DAY) {
      const bucket = Math.floor(version.createdAt / MS_DAY / 30.44); // 近似月
      if (!seenMonth.has(bucket)) {
        seenMonth.add(bucket);
        keep.add(version.versionId);
      }
      continue;
    }
    if (policy.yearlyWindowYears > 0 && age < policy.yearlyWindowYears * 365 * MS_DAY) {
      const bucket = Math.floor(version.createdAt / (365 * MS_DAY));
      if (!seenYear.has(bucket)) {
        seenYear.add(bucket);
        keep.add(version.versionId);
      }
      // 超过年窗口：不保留（落到这里且不满足条件即删除）
    }
  }
  return keep;
}
