import type { RepoChange, RepoFile } from '@synx/shared';
import type { RemoteEntity } from './syncAlgo.js';

/**
 * 仓库同步纯逻辑：仓库树 ↔ 计划用远端实体、上传结果组装 finalize 变更集。
 * 不依赖 Obsidian API，可单测。
 */

/** 已上传为不可变 blob 的本地文件（用于组装变更集） */
export interface RepoUploadedFile {
  path: string;
  blobId: string;
  hash: string;
  size: number;
  mtime: number;
  /** Markdown UUID；无 UUID 文件用 `path:<path>` */
  identity: string;
  /** rename 时的原路径（阶段 3 识别 rename 时使用） */
  previousPath?: string;
}

/** 待删除的远端文件（path → identity） */
export type RepoDelete = { path: string; identity: string };

/** 仓库树 → planSync 使用的远端实体列表（key 带前导 /，hash 同时放 hash/etag） */
export function repoTreeToRemote(tree: RepoFile[]): RemoteEntity[] {
  return tree.map((f) => ({
    key: '/' + f.path,
    mtime: f.mtime,
    size: f.size,
    type: 'file',
    hash: f.hash,
    etag: f.hash,
    versionId: f.blobId,
    fileUuid: identityToFileUuid(f.identity),
  }));
}

/** identity → fileUuid：`path:<path>` 表示无 UUID，返回 undefined；否则返回 UUID */
export function identityToFileUuid(identity: string): string | undefined {
  return identity.startsWith('path:') ? undefined : identity;
}

/** 远端树 → path → RepoFile 查找表 */
export function treeToMap(tree: RepoFile[]): Map<string, RepoFile> {
  return new Map(tree.map((f) => [f.path, f]));
}

/**
 * 组装 finalize 变更集：
 * - 已上传 blob 的 path 在远端树中 → modify，否则 add
 * - 有 previousPath → rename（阶段 3 启用）
 * - 待删除文件 → delete
 * 变更集顺序由服务端 normalizeChanges 规范化，客户端无需排序。
 */
export function buildRepoChanges(
  uploads: RepoUploadedFile[],
  deletes: RepoDelete[],
  currentTree: ReadonlyMap<string, RepoFile>,
): RepoChange[] {
  const changes: RepoChange[] = [];
  for (const u of uploads) {
    if (u.previousPath) {
      changes.push({
        identity: u.identity,
        operation: 'rename',
        path: u.path,
        previousPath: u.previousPath,
        blobId: u.blobId,
        hash: u.hash,
        size: u.size,
        mtime: u.mtime,
      });
      continue;
    }
    const exists = currentTree.has(u.path);
    changes.push({
      identity: u.identity,
      operation: exists ? 'modify' : 'add',
      path: u.path,
      blobId: u.blobId,
      hash: u.hash,
      size: u.size,
      mtime: u.mtime,
    });
  }
  for (const d of deletes) {
    changes.push({ identity: d.identity, operation: 'delete', path: d.path });
  }
  return changes;
}
