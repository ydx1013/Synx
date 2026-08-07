import type { RepoChange, RepoCommit, RepoFile } from '@synx/shared';
import type { LocalFile, PrevSyncEntry, RemoteEntity } from './syncAlgo.js';
import type { SyncStartFileSnapshot } from './syncWriteGuard.js';

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

interface CommitResult {
  commit: RepoCommit;
  head: { commitId: string };
}

interface CommitIndexWriter {
  putCommits(commits: RepoCommit[], headCommitId: string): Promise<void>;
}

/** 主仓库操作成功后即时更新本地索引；索引故障不能反向破坏已成功的远端提交。 */
export async function commitAndIndex<T extends CommitResult>(
  operation: () => Promise<T>,
  index: CommitIndexWriter,
): Promise<T> {
  const result = await operation();
  try {
    await index.putCommits([result.commit], result.head.commitId);
  } catch (error) {
    console.warn('synx: failed to update local history index', error);
  }
  return result;
}

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

/** 变更集 → 树条目（与服务端 toRepoFile 语义一致，供本地应用变更构造新树） */
function toRepoFileFromChange(change: RepoChange): RepoFile {
  return {
    path: change.path,
    identity: change.identity,
    blobId: change.blobId ?? '',
    hash: change.hash ?? '',
    size: change.size ?? 0,
    mtime: change.mtime ?? 0,
  };
}

/** 把提交变更应用到现有树（与服务端 applyChanges 语义一致）。 */
export function applyRepoChanges(tree: RepoFile[], changes: RepoChange[]): RepoFile[] {
  const map = treeToMap(tree);
  for (const change of changes) {
    if (change.operation === 'delete') {
      map.delete(change.path);
    } else if (change.operation === 'rename') {
      map.delete(change.previousPath!);
      map.set(change.path, toRepoFileFromChange(change));
    } else {
      map.set(change.path, toRepoFileFromChange(change));
    }
  }
  return [...map.values()];
}

/** finalize 成功后本地应用变更得到新基线树，避免整树网络拉取 */
export async function updateRepoBaseAfterFinalize(
  head: { commitId: string; generation: number },
  baseTree: RepoFile[],
  changes: RepoChange[],
): Promise<{ head: { commitId: string; generation: number }; tree: RepoFile[] }> {
  return { head, tree: applyRepoChanges(baseTree, changes) };
}

export function clearSmartMergeBase<T extends {
  baseCommitId?: string;
  entries: Record<string, PrevSyncEntry>;
}>(state: T): T {
  const { baseCommitId: _baseCommitId, ...withoutBase } = state;
  return {
    ...withoutBase,
    entries: Object.fromEntries(Object.entries(state.entries).map(([path, entry]) => {
      const { basePath: _basePath, ...metadata } = entry;
      return [path, metadata];
    })),
  } as T;
}

export async function clearAndPersistSmartMergeBase<T extends {
  baseCommitId?: string;
  entries: Record<string, PrevSyncEntry>;
}>(state: T, persist: (state: T) => Promise<void>): Promise<T> {
  const cleared = clearSmartMergeBase(state);
  await persist(cleared);
  return cleared;
}

export async function clearAndQueuePersistSmartMergeBase<T extends {
  baseCommitId?: string;
  entries: Record<string, PrevSyncEntry>;
}>(state: T, update: (state: T) => void, queueStateWrite: () => Promise<void>): Promise<T> {
  return clearAndPersistSmartMergeBase(state, async (cleared) => {
    update(cleared);
    await queueStateWrite();
  });
}

export async function refreshLocalSyncState<TSkipped>(
  enumerate: () => Promise<{ files: LocalFile[]; skipped: TSkipped[] }>,
): Promise<{ files: LocalFile[]; skipped: TSkipped[]; snapshot: Map<string, SyncStartFileSnapshot> }> {
  const { files, skipped } = await enumerate();
  return {
    files,
    skipped,
    snapshot: new Map(files.map((file) => [file.path, {
      exists: true,
      mtime: file.mtime,
      size: file.size,
      hash: file.hash,
    }])),
  };
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
  const uploadPaths = new Set(uploads.map((upload) => upload.path));
  for (const deletion of deletes) {
    if (uploadPaths.has(deletion.path)) throw new Error(`同一路径不能同时上传和删除: ${deletion.path}`);
  }
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
