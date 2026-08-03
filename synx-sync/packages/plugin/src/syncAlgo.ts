import type { Entity } from '@synx/shared';

/**
 * 双向同步算法（类 remotely-save V3 决策）：
 *
 * 有 prevSync 快照时走三方比较（优先）：
 * - 本地==prevSync 且 远端==prevSync → skip（挡住 mtime 抖动导致的虚假上传）
 * - 本地!=prevSync 且 远端==prevSync → push（本地改了）
 * - 本地==prevSync 且 远端!=prevSync → pull（远端改了）
 * - 两端都不等于 prevSync → 冲突
 *
 * 无 prevSync（首次同步）退回 mtime+size+hash 两方比较：
 * - 仅本地存在 → push
 * - 仅远端存在 → pull
 * - mtime 较新者覆盖对方；mtime 相同且 hash 一致 → 跳过
 * - mtime 相同但 hash 不同 → 冲突
 *
 * 同步算法不直接 I/O，只产出 SyncPlan，由调用方执行。
 */

export type SyncAction =
  | { type: 'push'; path: string; reason: 'local-only' | 'local-newer' | 'conflict-keep-local' }
  | { type: 'pull'; path: string; reason: 'remote-only' | 'remote-newer'; fileUuid?: string }
  | { type: 'delete-remote'; path: string; reason: 'local-deleted'; fileUuid?: string }
  | { type: 'delete-local'; path: string; reason: 'remote-deleted'; fileUuid?: string }
  | { type: 'skip'; path: string; reason: 'in-sync' | 'same-mtime-diff-hash-skipped' };

export interface SyncPlan {
  actions: SyncAction[];
  /** 统计摘要（用于日志/状态栏） */
  stats: {
    push: number;
    pull: number;
    skip: number;
    conflict: number;
  };
}

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
  /** 内容 sha256（hex），可选；为空则视为未知 */
  hash?: string;
  fileUuid?: string;
}

export interface RemoteEntity extends Entity {}

/** 上次同步快照条目：记录两端内容和远端版本，用于三方比较 */
export interface PrevSyncEntry {
  localMtime: number;
  remoteMtime: number;
  size: number;
  localHash?: string;
  remoteHash?: string;
  remoteVersionId?: string;
  fileUuid?: string;
}

/** prevSync 查找表：key = vault 内相对路径 */
export type PrevSyncMap = Map<string, PrevSyncEntry>;

/**
 * 计算同步计划。
 *
 * @param local 本地文件清单（不含目录）
 * @param remote 远端 current 版本清单（来自 WorkerClient.list()）
 * @param thresholdMs mtime 差异阈值（毫秒），小于此差异视为相同；默认 1000ms
 * @param prevSync 上次同步快照（可选）；提供时启用三方比较，挡住 mtime 抖动
 */
export function planSync(
  local: LocalFile[],
  remote: RemoteEntity[],
  thresholdMs = 1000,
  prevSync?: PrevSyncMap,
): SyncPlan {
  const remoteMap = new Map<string, RemoteEntity>();
  for (const r of remote) {
    // Entity.key 含前导 '/'，归一化为 vault 内相对路径
    const path = r.key.replace(/^\/+/, '');
    remoteMap.set(path, r);
  }

  const remoteUuidMap = new Map<string, { path: string; entity: RemoteEntity }>();
  for (const [path, entity] of remoteMap) {
    if (entity.fileUuid) remoteUuidMap.set(entity.fileUuid, { path, entity });
  }

  // prevSync 查找表：先按 path，再按 fileUuid（与远端查找逻辑一致）
  const prevSyncMap = prevSync ?? new Map<string, PrevSyncEntry>();
  const prevSyncUuidMap = new Map<string, { path: string; entry: PrevSyncEntry }>();
  for (const [path, entry] of prevSyncMap) {
    if (entry.fileUuid) prevSyncUuidMap.set(entry.fileUuid, { path, entry });
  }

  const actions: SyncAction[] = [];
  const stats = { push: 0, pull: 0, skip: 0, conflict: 0 };

  // 1. 遍历本地文件
  for (const l of local) {
    let remotePath = l.path;
    let r = remoteMap.get(l.path);
    if (!r && l.fileUuid) {
      const byUuid = remoteUuidMap.get(l.fileUuid);
      if (byUuid) {
        remotePath = byUuid.path;
        r = byUuid.entity;
      }
    }
    if (!r) {
      let p = prevSyncMap.get(l.path);
      if (!p && l.fileUuid) p = prevSyncUuidMap.get(l.fileUuid)?.entry;
      const localHash = l.hash;
      const localUnchanged = !!p && !!localHash && !!p.localHash && localHash === p.localHash;
      if (localUnchanged) {
        actions.push({ type: 'delete-local', path: l.path, reason: 'remote-deleted', fileUuid: l.fileUuid });
        continue;
      }
      // 没有同步基准说明是本地新建；本地在远端删除后又修改则保留本地并重新上传。
      actions.push({ type: 'push', path: l.path, reason: 'local-only' });
      stats.push++;
      continue;
    }
    remoteMap.delete(remotePath);
    if (remotePath !== l.path) {
      actions.push({ type: 'push', path: l.path, reason: 'local-newer' });
      stats.push++;
      continue;
    }

    // 查找 prevSync（先 path 再 fileUuid）
    let p = prevSyncMap.get(l.path);
    if (!p && l.fileUuid) {
      const byUuid = prevSyncUuidMap.get(l.fileUuid);
      if (byUuid) p = byUuid.entry;
    }

    // 有 prevSync → 三方比较（优先）
    if (p) {
      const remoteHash = r.hash ?? r.etag;
      const localEqualPrev = l.hash && p.localHash
        ? l.hash === p.localHash
        : Math.abs(l.mtime - p.localMtime) < thresholdMs && l.size === p.size;
      const remoteEqualPrev = remoteHash && p.remoteHash
        ? remoteHash === p.remoteHash
        : Math.abs(r.mtime - p.remoteMtime) < thresholdMs && r.size === p.size;
      if (localEqualPrev && remoteEqualPrev) {
        // 两端都没变 → skip（挡住 mtime 抖动）
        actions.push({ type: 'skip', path: l.path, reason: 'in-sync' });
        stats.skip++;
        continue;
      }
      if (!localEqualPrev && remoteEqualPrev) {
        // 本地改了 → push
        actions.push({ type: 'push', path: l.path, reason: 'local-newer' });
        stats.push++;
        continue;
      }
      if (localEqualPrev && !remoteEqualPrev) {
        // 远端改了 → pull
        actions.push({ type: 'pull', path: l.path, reason: 'remote-newer', fileUuid: r.fileUuid ?? undefined });
        stats.pull++;
        continue;
      }
      // 两端都改了 → 冲突，保留本地
      actions.push({ type: 'push', path: l.path, reason: 'conflict-keep-local' });
      stats.push++;
      stats.conflict++;
      continue;
    }

    // 无 prevSync（首次同步）→ 退回 mtime+size+hash 两方比较
    const mtimeDiff = l.mtime - r.mtime;
    const sameMtime = Math.abs(mtimeDiff) < thresholdMs;
    const sameSize = l.size === r.size;
    const hasBothHash = !!l.hash && !!r.etag;
    const sameHash = hasBothHash && l.hash === r.etag;

    // 内容 hash 是最可靠的一致性依据；相同内容不因 mtime 抖动重复上传。
    if (sameSize && sameHash) {
      actions.push({ type: 'skip', path: l.path, reason: 'in-sync' });
      stats.skip++;
      continue;
    }

    // 没有完整 hash 时，只有 mtime 和 size 都一致才允许跳过。
    if (!hasBothHash && sameMtime && sameSize) {
      actions.push({ type: 'skip', path: l.path, reason: 'in-sync' });
      stats.skip++;
      continue;
    }

    // mtime 相同但 size 或 hash 不同 → 冲突；保留本地，上传新版本
    if (sameMtime && (!sameSize || !sameHash)) {
      actions.push({ type: 'push', path: l.path, reason: 'conflict-keep-local' });
      stats.push++;
      stats.conflict++;
      continue;
    }

    // mtime 不同：较新者覆盖对方
    if (mtimeDiff > 0) {
      // 本地更新 → push
      actions.push({ type: 'push', path: l.path, reason: 'local-newer' });
      stats.push++;
    } else {
      // 远端更新 → pull
      actions.push({ type: 'pull', path: l.path, reason: 'remote-newer', fileUuid: r.fileUuid ?? undefined });
      stats.pull++;
    }
  }

  // 2. 剩余的远端文件：有 prevSync 且远端内容未变时，说明本地已删除。
  for (const [path, r] of remoteMap) {
    const p = prevSyncMap.get(path) ?? (r.fileUuid ? prevSyncUuidMap.get(r.fileUuid)?.entry : undefined);
    const remoteHash = r.hash ?? r.etag;
    const remoteUnchanged = !!p && !!remoteHash && !!p.remoteHash && remoteHash === p.remoteHash;
    if (remoteUnchanged) {
      actions.push({ type: 'delete-remote', path, reason: 'local-deleted', fileUuid: r.fileUuid ?? undefined });
      continue;
    }
    actions.push({ type: 'pull', path, reason: 'remote-only', fileUuid: r.fileUuid ?? undefined });
    stats.pull++;
  }

  return { actions, stats };
}

/**
 * 本地文件数骤降保护（防清空 vault 误删远端）：
 * 当有 prevSync 快照且本地文件数比上次同步记录明显减少时，说明本地可能被整体清空/大面积丢失
 * （而非逐个删除）。此时若还按三方比较执行 delete-remote，会把远端数据一并删掉。
 * 返回 true 表示"应保护"：调用方需把 delete-remote 动作转为 pull，并提示用户。
 *
 * @param localCount 本次本地文件数
 * @param prevSyncCount prevSync 记录的条目数（上次同步时两端的并集）
 * @param protectPercent 骤降判定阈值百分比（本地/prevSync × 100 < 此值视为骤降），默认 50
 */
export function shouldProtectAgainstMassDeletion(
  localCount: number,
  prevSyncCount: number,
  protectPercent = 50,
): boolean {
  if (prevSyncCount <= 0) return false;
  return (localCount / prevSyncCount) * 100 < protectPercent;
}

/**
 * delete-local 方向的大面积删除保护（防远端整库丢失误删本地）：
 * 当有 prevSync 快照且本次计划删除的本地文件（delete-local）占上次同步记录的比例
 * 超过 (100 - protectPercent)% 时，说明远端可能整体丢失（清空/存储配置错配/仓库损坏），
 * 此时执行 delete-local 会把本地唯一副本一并删掉。返回 true 表示"应保护"：
 * 调用方需把 delete-local 动作转为 push（把未修改的本地内容重新上传，不删本地）。
 *
 * @param deleteLocalCount 本次计划 delete-local 的动作数
 * @param prevSyncCount prevSync 记录的条目数（上次同步时两端的并集）
 * @param protectPercent 判定阈值百分比（deleteLocal/prevSync × 100 超过 100 - 此值视为大面积删除），默认 50
 */
export function shouldProtectAgainstMassLocalDeletion(
  deleteLocalCount: number,
  prevSyncCount: number,
  protectPercent = 50,
): boolean {
  if (prevSyncCount <= 0) return false;
  return (deleteLocalCount / prevSyncCount) * 100 > 100 - protectPercent;
}

/**
 * 本地文件相对上次同步是否「未变」，用于跳过读取与 hash 重算（快路径）。
 * 要求 prevSync 存在、上次有本地 hash、且 mtime 与 size 均完全一致——
 * 一致即内容未变（mtime 由文件系统写入更新，未写入的文件 mtime 保持不变），
 * 此时可安全复用 prevSync 的 localHash 与 fileUuid，无需再读文件。
 *
 * 注意：这是 mtime+size 启发式。若内容变化但 mtime 与 size 恰好都没变
 * （极端场景，如粗粒度文件系统 + 手动还原 mtime），该变化会被漏检，
 * 与 planSync 无 hash 时的兜底判断处于同一信任级别。
 */
export function isLocalFileUnchangedFromPrev(
  prev: PrevSyncEntry | undefined,
  mtime: number,
  size: number,
): boolean {
  return !!prev && !!prev.localHash && prev.localMtime === mtime && prev.size === size;
}

/** 简单的 sha256 hex 计算（Obsidian 环境下用 SubtleCrypto） */
export async function hashContent(content: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  // 拷贝为独立 ArrayBuffer 以兼容 BufferSource 严格类型（避免 SharedArrayBuffer 不匹配）
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
