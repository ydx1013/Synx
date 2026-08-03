import { DEFAULT_RETENTION, type RetentionPolicy, type WorkerFs } from '@synx/shared';
import type { Env } from '../types.js';

export class FileTooLarge extends Error {
  constructor(public maxSize: number, public actualSize: number) {
    super(`file size ${actualSize} exceeds max ${maxSize}`);
    this.name = 'FileTooLarge';
  }
}

/** 保留策略文件：存放在用户自己的存储根目录（与 .synx/files 元数据同一命名空间） */
const RETENTION_KEY = '.synx/retention.json';

// 策略内存缓存：策略极少变化，一次同步的连续请求命中同一 isolate，避免每请求读存储/D1。
const policyCache = new Map<string, { policy: RetentionPolicy; expiresAt: number }>();
const POLICY_CACHE_TTL = 5 * 60 * 1000;

/** 策略变更后调用，避免缓存过期前读到旧值 */
export function invalidateRetentionPolicy(storageId: string): void {
  policyCache.delete(storageId);
}

/** 仅供测试：清空全部缓存，避免用例间污染 */
export function resetRetentionPolicyCache(): void {
  policyCache.clear();
}

/** D1 storages 表行（含可选的保留策略列） */
interface StorageRow {
  id: string;
  retention_policy: string | null;
}

/**
 * 读取 storage 的保留策略，优先级：
 * 1. 用户存储里的 .synx/retention.json（持久事实源，不依赖 D1）
 * 2. D1 storages.retention_policy（存量迁移源；读到旧值会懒写入用户存储）
 * 3. 默认策略
 * 任一步骤失败都不影响同步（回退下一级 / 默认）。
 */
export async function getRetentionPolicy(env: Env, storageId: string, fs?: WorkerFs): Promise<RetentionPolicy> {
  const now = Date.now();
  const cached = policyCache.get(storageId);
  if (cached && cached.expiresAt > now) return cached.policy;

  let policy: RetentionPolicy = DEFAULT_RETENTION;
  if (fs) {
    const stored = await readPolicyFromStorage(fs);
    if (stored) {
      policy = stored;
    } else {
      const legacy = await readPolicyFromD1(env, storageId);
      policy = legacy ?? DEFAULT_RETENTION;
      if (legacy) {
        // 存量迁移：存储里还没有策略文件 → 把 D1 旧值补写进用户存储（失败不阻塞）
        try {
          await fs.put(RETENTION_KEY, new TextEncoder().encode(JSON.stringify(policy)));
        } catch (error) {
          console.error('failed to migrate retention policy to storage', storageId, error);
        }
      }
    }
  } else {
    policy = (await readPolicyFromD1(env, storageId)) ?? DEFAULT_RETENTION;
  }

  policyCache.set(storageId, { policy, expiresAt: now + POLICY_CACHE_TTL });
  return policy;
}

/**
 * 保存保留策略：写入用户存储（权威，失败即报错）；D1 列仅作回退源（尽力更新）。
 * 策略属于用户数据，存自己的存储里，D1 不承担持久事实源。
 */
export async function saveRetentionPolicy(
  env: Env,
  storageId: string,
  fs: WorkerFs | undefined,
  policy: RetentionPolicy,
): Promise<RetentionPolicy> {
  if (fs) {
    await fs.put(RETENTION_KEY, new TextEncoder().encode(JSON.stringify(policy)));
  }
  if (env.DB) {
    try {
      await env.DB.prepare('UPDATE storages SET retention_policy = ? WHERE id = ?')
        .bind(JSON.stringify(policy), storageId)
        .run();
    } catch (error) {
      console.error('failed to save retention policy to D1 (fallback only)', storageId, error);
    }
  }
  invalidateRetentionPolicy(storageId);
  policyCache.set(storageId, { policy, expiresAt: Date.now() + POLICY_CACHE_TTL });
  return policy;
}

/** 从用户存储读取策略文件；不存在/读取失败/解析失败 → null（回退下一级） */
async function readPolicyFromStorage(fs: WorkerFs): Promise<RetentionPolicy | null> {
  try {
    const raw = await fs.get(RETENTION_KEY);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<RetentionPolicy>;
    return normalizePolicy(parsed);
  } catch {
    return null;
  }
}

async function readPolicyFromD1(env: Env, storageId: string): Promise<RetentionPolicy | null> {
  try {
    const row = await env.DB.prepare('SELECT retention_policy FROM storages WHERE id = ?')
      .bind(storageId)
      .first<StorageRow>();
    if (!row?.retention_policy) return null;
    return normalizePolicy(JSON.parse(row.retention_policy) as Partial<RetentionPolicy>);
  } catch {
    return null;
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
