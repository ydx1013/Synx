import {
  type RepoChange,
  type RepoCommit,
  type RepoCommitSummary,
  type RepoDiffEntry,
  type RepoFile,
  type RepositoryHead,
  type RetentionPolicy,
  type WorkerFs,
} from '@synx/shared';
import type { Env } from '../types.js';

// ===== Git 式仓库层：全部状态保存在用户存储的对象上，零 D1 / 零 KV =====
// 布局（<syncFolder>/.synx/repo/）：
//   HEAD.json                    HEAD 指针 {version, commitId, generation}
//   commits/{commitId}.json      提交（含规范化变更集）
//   checkpoints/{commitId}.json  完整内容树快照（checkpointId === 该提交 commitId）
// blobId 复用不可变内容对象的 storageKey（makeStorageKey），
// 首次初始化从空提交开始，后续每次同步作为一个新提交原子加入。

const REPO_DIR = '.synx/repo';
const CHECKPOINT_INTERVAL = 10;
const COMMIT_PAGE_SIZE = 50;
const FILE_HISTORY_LIMIT = 200;
const LOCK_TTL_MS = 15_000;
const LOCK_ACQUIRE_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 100;
/** 逐个 fs.head 校验 blob 的变更集上限：超出改用单次 list，避免 Workers 免费版 50 子请求限额。 */
const MAX_BLOB_HEAD_CHECKS = 40;

function repoRoot(syncFolder: string): string {
  return `${syncFolder.replace(/\/+$/, '')}/${REPO_DIR}/`;
}
function headKey(syncFolder: string): string {
  return `${repoRoot(syncFolder)}HEAD.json`;
}
function commitKey(syncFolder: string, commitId: string): string {
  return `${repoRoot(syncFolder)}commits/${commitId}.json`;
}
function checkpointKey(syncFolder: string, commitId: string): string {
  return `${repoRoot(syncFolder)}checkpoints/${commitId}.json`;
}

// ── 错误类型（路由层映射 HTTP 状态码与错误码） ──

export class HeadConflictError extends Error {
  constructor() {
    super('HEAD has been advanced by another device');
    this.name = 'HeadConflictError';
  }
}
export class RepoExistsError extends Error {
  constructor() {
    super('repository already initialized');
    this.name = 'RepoExistsError';
  }
}
export class RepoNotInitializedError extends Error {
  constructor() {
    super('repository not initialized');
    this.name = 'RepoNotInitializedError';
  }
}
export class CommitNotFoundError extends Error {
  constructor(commitId: string) {
    super(`commit ${commitId} not found`);
    this.name = 'CommitNotFoundError';
  }
}
export class BlobMissingError extends Error {
  constructor(path: string) {
    super(`content object missing for ${path}`);
    this.name = 'BlobMissingError';
  }
}
export class EmptyChangesError extends Error {
  constructor() {
    super('no changes to commit');
    this.name = 'EmptyChangesError';
  }
}
export class InvalidChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChangeError';
  }
}
export class RepoIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoIntegrityError';
  }
}

// ── 基础工具 ──

const textDecoder = new TextDecoder();
const VALID_OPERATIONS = new Set(['add', 'modify', 'rename', 'delete']);

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** 稳定序列化：对象键递归排序，保证语义相同的变更产生相同的字符串（commitId 可复现） */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 规范化变更集：过滤非法条目 + 稳定排序（commitId 可复现的基础） */
export function normalizeChanges(changes: RepoChange[]): RepoChange[] {
  const valid = changes.filter(
    (c) =>
      c &&
      typeof c.identity === 'string' &&
      c.identity !== '' &&
      typeof c.path === 'string' &&
      c.path !== '' &&
      VALID_OPERATIONS.has(c.operation) &&
      (c.operation !== 'rename' || typeof c.previousPath === 'string'),
  );
  valid.sort((a, b) => {
    const ka = canonicalJson(a);
    const kb = canonicalJson(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return valid;
}

function toSummary(commit: RepoCommit): RepoCommitSummary {
  return {
    commitId: commit.commitId,
    parentCommitId: commit.parentCommitId,
    kind: commit.kind,
    createdAt: commit.createdAt,
    author: commit.author,
    message: commit.message,
    changeCount: commit.changeCount,
  };
}

// ── HEAD 读取 / CAS 更新 ──

async function readHead(fs: WorkerFs, syncFolder: string): Promise<RepositoryHead | null> {
  const key = headKey(syncFolder);
  if (!(await fs.head(key))) return null;
  try {
    const raw = await fs.get(key);
    return JSON.parse(textDecoder.decode(raw)) as RepositoryHead;
  } catch (error) {
    throw new RepoIntegrityError(`HEAD unreadable: ${key}`);
  }
}

export { readHead };

/**
 * 原子推进 HEAD（比较并交换）。
 * - 首次设置（expected === null）：优先 putIfNoneMatch；否则 head 检查 + put（best-effort）。
 * - 更新：优先「验证读 + putIfMatch(etag)」实现 CAS；后端不支持条件写时降级为锁对象。
 * 任何失配都返回 false，且绝不在失配时写入。
 */
async function casWriteHead(
  fs: WorkerFs,
  syncFolder: string,
  expected: RepositoryHead | null,
  next: RepositoryHead,
): Promise<boolean> {
  const key = headKey(syncFolder);
  const encoded = new TextEncoder().encode(JSON.stringify(next));

  if (expected === null) {
    if (fs.putIfNoneMatch) return fs.putIfNoneMatch(key, encoded);
    if (await fs.head(key)) return false;
    await fs.put(key, encoded);
    return true;
  }

  // 验证读：HEAD 内容已变化（generation/commitId 不同）→ 直接冲突
  const current = await readHead(fs, syncFolder);
  if (!current || current.generation !== expected.generation || current.commitId !== expected.commitId) {
    return false;
  }

  if (fs.putIfMatch && fs.getEtag) {
    let matched = false;
    try {
      const etag = await fs.getEtag(key);
      if (etag) matched = await fs.putIfMatch(key, encoded, etag);
    } catch {
      // 后端不支持 If-Match（400/501/网络错误等）→ 视为条件写不可用，走降级
      matched = false;
    }
    if (matched) return true;

    // 条件写失配（412）：可能是真冲突（HEAD 被并发推进），也可能是后端 If-Match
    // 语义不稳导致的假冲突（HEAD 内容其实没变）。重读 HEAD 区分：
    // 内容未变 → 假冲突，降级到锁路径安全写入；内容已变 → 真冲突，返回 false。
    // 锁路径内部会再次校验，仍可保证并发下不覆盖他人提交。
    const latest = await readHead(fs, syncFolder);
    if (latest && latest.generation === expected.generation && latest.commitId === expected.commitId) {
      return withRepoLock(fs, syncFolder, async () => {
        const again = await readHead(fs, syncFolder);
        if (!again || again.generation !== expected.generation || again.commitId !== expected.commitId) return false;
        await fs.put(key, encoded);
        return true;
      });
    }
    return false;
  }

  // 降级：锁对象串行化（WebDAV / OneDrive 等无条件写后端）。best-effort。
  return withRepoLock(fs, syncFolder, async () => {
    const latest = await readHead(fs, syncFolder);
    if (!latest || latest.generation !== expected.generation || latest.commitId !== expected.commitId) return false;
    await fs.put(key, encoded);
    return true;
  });
}

async function withRepoLock<T>(fs: WorkerFs, syncFolder: string, task: () => Promise<T>): Promise<T> {
  const lockKey = `${repoRoot(syncFolder)}lock.json`;
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + LOCK_TTL_MS;
  for (let attempt = 0; attempt < LOCK_ACQUIRE_RETRIES; attempt++) {
    try {
      const held = await readLock(fs, lockKey);
      if (held) {
        await sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }
      await fs.put(lockKey, new TextEncoder().encode(JSON.stringify({ token, expiresAt })));
      const verify = await readLock(fs, lockKey);
      if (verify === token) {
        try {
          return await task();
        } finally {
          const now = await readLock(fs, lockKey);
          if (now === token) await fs.delete(lockKey).catch(() => undefined);
        }
      }
    } catch {
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new HeadConflictError();
}

async function readLock(fs: WorkerFs, lockKey: string): Promise<string | null> {
  if (!(await fs.head(lockKey))) return null;
  try {
    const lock = JSON.parse(textDecoder.decode(await fs.get(lockKey))) as { token: string; expiresAt: number };
    if (lock.expiresAt < Date.now()) return null;
    return lock.token;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 提交 / 检查点 / 内容树 ──

async function readCommit(fs: WorkerFs, syncFolder: string, commitId: string): Promise<RepoCommit | null> {
  const key = commitKey(syncFolder, commitId);
  if (!(await fs.head(key))) return null;
  try {
    return JSON.parse(textDecoder.decode(await fs.get(key))) as RepoCommit;
  } catch (error) {
    throw new RepoIntegrityError(`commit unreadable: ${commitId}`);
  }
}

async function loadCheckpoint(fs: WorkerFs, syncFolder: string, commitId: string): Promise<Map<string, RepoFile>> {
  const key = checkpointKey(syncFolder, commitId);
  if (!(await fs.head(key))) throw new RepoIntegrityError(`checkpoint missing for ${commitId}`);
  try {
    const parsed = JSON.parse(textDecoder.decode(await fs.get(key))) as { files: RepoFile[] };
    return new Map(parsed.files.map((f) => [f.path, f]));
  } catch (error) {
    throw new RepoIntegrityError(`checkpoint unreadable for ${commitId}`);
  }
}

async function writeCheckpoint(fs: WorkerFs, syncFolder: string, commitId: string, tree: Map<string, RepoFile>): Promise<void> {
  const payload = { version: 1, commitId, files: [...tree.values()] };
  await fs.put(checkpointKey(syncFolder, commitId), new TextEncoder().encode(JSON.stringify(payload)));
}

/** 解析某提交的完整内容树：最近祖先检查点 + 沿提交链前向重放变更。 */
export async function resolveTree(fs: WorkerFs, syncFolder: string, commit: RepoCommit): Promise<Map<string, RepoFile>> {
  const chain: RepoCommit[] = [];
  let cursor: RepoCommit | null = commit;
  while (cursor && !cursor.checkpointId) {
    chain.push(cursor);
    const parent: RepoCommit | null = cursor.parentCommitId
      ? await readCommit(fs, syncFolder, cursor.parentCommitId)
      : null;
    if (!parent) throw new RepoIntegrityError(`parent commit missing for ${cursor.commitId}`);
    cursor = parent;
  }
  const tree = cursor?.checkpointId ? await loadCheckpoint(fs, syncFolder, cursor.checkpointId) : new Map<string, RepoFile>();
  for (let i = chain.length - 1; i >= 0; i--) applyChanges(tree, chain[i].changes);
  return tree;
}

function applyChanges(tree: Map<string, RepoFile>, changes: RepoChange[]): void {
  for (const change of changes) {
    if (change.operation === 'delete') {
      tree.delete(change.path);
    } else if (change.operation === 'rename') {
      tree.delete(change.previousPath!);
      tree.set(change.path, toRepoFile(change));
    } else {
      tree.set(change.path, toRepoFile(change));
    }
  }
}

function toRepoFile(change: RepoChange): RepoFile {
  return {
    path: change.path,
    identity: change.identity,
    blobId: change.blobId!,
    hash: change.hash ?? '',
    size: change.size ?? 0,
    mtime: change.mtime ?? 0,
  };
}

/**
 * 计算把 current 树变成 target 树所需的变更集（提交 diff 与恢复反向 diff 共用）。
 * 重命名检测：身份（Markdown UUID）相同但路径不同 → rename；其余按 path 比较。
 */
export function diffTrees(current: Map<string, RepoFile>, target: Map<string, RepoFile>): RepoChange[] {
  const changes: RepoChange[] = [];

  const identityPathCurrent = new Map<string, string>();
  for (const [path, file] of current) identityPathCurrent.set(file.identity, path);
  const identityPathTarget = new Map<string, string>();
  for (const [path, file] of target) identityPathTarget.set(file.identity, path);

  // 身份级 rename：同 identity、不同 path
  const renamedPaths = new Set<string>();
  for (const [identity, targetPath] of identityPathTarget) {
    const currentPath = identityPathCurrent.get(identity);
    if (currentPath && currentPath !== targetPath && target.has(targetPath)) {
      const file = target.get(targetPath)!;
      changes.push({
        identity,
        operation: 'rename',
        previousPath: currentPath,
        path: targetPath,
        blobId: file.blobId,
        hash: file.hash,
        size: file.size,
        mtime: file.mtime,
      });
      renamedPaths.add(currentPath);
      renamedPaths.add(targetPath);
    }
  }

  const currentRemaining = new Map(current);
  const targetRemaining = new Map(target);
  for (const path of renamedPaths) {
    currentRemaining.delete(path);
    targetRemaining.delete(path);
  }

  // 剩余 path 级比较
  for (const [path, file] of targetRemaining) {
    if (!currentRemaining.has(path)) {
      changes.push({ identity: file.identity, operation: 'add', path, blobId: file.blobId, hash: file.hash, size: file.size, mtime: file.mtime });
    }
  }
  for (const [path, file] of currentRemaining) {
    if (!targetRemaining.has(path)) {
      changes.push({ identity: file.identity, operation: 'delete', path });
    }
  }
  for (const [path, file] of targetRemaining) {
    const cur = currentRemaining.get(path);
    if (cur && cur.blobId !== file.blobId) {
      changes.push({ identity: file.identity, operation: 'modify', path, blobId: file.blobId, hash: file.hash, size: file.size, mtime: file.mtime });
    }
  }

  return normalizeChanges(changes);
}

function countDiff(changes: RepoChange[]): { added: number; modified: number; renamed: number; deleted: number } {
  const counts = { added: 0, modified: 0, renamed: 0, deleted: 0 };
  for (const c of changes) {
    if (c.operation === 'add') counts.added++;
    else if (c.operation === 'modify') counts.modified++;
    else if (c.operation === 'rename') counts.renamed++;
    else counts.deleted++;
  }
  return counts;
}

function toDiffEntries(changes: RepoChange[]): RepoDiffEntry[] {
  return changes.map((c) => ({
    operation: c.operation,
    path: c.path,
    previousPath: c.previousPath,
    blobId: c.blobId,
    size: c.size,
  }));
}

async function makeCommitId(scope: { storageId: string; syncFolder: string }, commit: Omit<RepoCommit, 'commitId'>): Promise<string> {
  const digest = await sha256Hex(
    new TextEncoder().encode(
      canonicalJson({
        repo: `${scope.storageId}:${scope.syncFolder}`,
        parent: commit.parentCommitId,
        generation: commit.generation,
        kind: commit.kind,
        author: commit.author,
        message: commit.message,
        createdAt: commit.createdAt,
        changes: commit.changes,
      }),
    ),
  );
  return digest.slice(0, 24);
}

// ── 初始化：把现有远端状态完整收进 initial 提交 ──

export interface InitRepositoryInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
  author?: string;
}

export async function initRepository(input: InitRepositoryInput): Promise<{ head: RepositoryHead; commit: RepoCommit }> {
  const { env, userId, storageId, syncFolder, fs, author } = input;
  if (await readHead(fs, syncFolder)) throw new RepoExistsError();

  // 空初始提交：仓库从零开始，不读取任何历史布局数据。
  // 首次同步时由客户端把所有文件作为变更提交加入。
  const tree = new Map<string, RepoFile>();
  const createdAt = Date.now();
  const commitBase: Omit<RepoCommit, 'commitId'> = {
    parentCommitId: null,
    generation: 1,
    createdAt,
    author: author ?? null,
    message: 'Initial snapshot',
    kind: 'initial',
    changeCount: 0,
    checkpointId: null, // 占位：提交本身即带检查点
    changes: [],
  };
  const commitId = await makeCommitId({ storageId, syncFolder }, commitBase);
  const commit: RepoCommit = { ...commitBase, commitId, checkpointId: commitId };

  await writeCheckpoint(fs, syncFolder, commitId, tree);
  await fs.put(commitKey(syncFolder, commitId), new TextEncoder().encode(JSON.stringify(commit)));

  const head: RepositoryHead = { version: 1, commitId, generation: 1, updatedAt: createdAt };
  const ok = await casWriteHead(fs, syncFolder, null, head);
  if (!ok) throw new RepoExistsError();
  return { head, commit };
}

// ── 原子提交（finalize） ──

export interface FinalizeCommitInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
  baseCommitId: string;
  baseGeneration: number;
  author?: string;
  message?: string;
  changes: RepoChange[];
  /** 提交时间（毫秒）；缺省取当前时间。测试注入用 */
  now?: number;
}

export async function finalizeCommit(input: FinalizeCommitInput): Promise<{ commit: RepoCommit; head: RepositoryHead }> {
  const { env, userId, storageId, syncFolder, fs, baseCommitId, baseGeneration, author, message } = input;
  const head = await readHead(fs, syncFolder);
  if (!head) throw new RepoNotInitializedError();
  if (head.commitId !== baseCommitId || head.generation !== baseGeneration) throw new HeadConflictError();

  const changes = normalizeChanges(input.changes);
  if (changes.length === 0) throw new EmptyChangesError();

  const parent = await readCommit(fs, syncFolder, head.commitId);
  if (!parent) throw new RepoIntegrityError(`parent commit missing: ${head.commitId}`);

  // 校验引用的内容对象存在（缺失则拒绝提交，HEAD 不变）。
  // 注意：不能对大变更集逐个 fs.head —— Workers 免费版单请求子请求上限 50，
  // 首次全量同步（数百个文件）会因逐个 HEAD 超额被平台中断 → 500。
  // 变更集较小时逐个 HEAD（少几次往返、可精确定位缺失文件）；
  // 变更集大时改为单次 list + 内存 Set 判断（1 次子请求校验全部 blob）。
  const blobChanges = changes.filter((c) => c.operation !== 'delete' && c.blobId);
  if (blobChanges.length > 0) {
    if (blobChanges.length <= MAX_BLOB_HEAD_CHECKS) {
      for (const change of blobChanges) {
        if (!(await fs.head(change.blobId!))) throw new BlobMissingError(change.path);
      }
    } else {
      const keys = new Set(await fs.list(`${syncFolder.replace(/\/+$/, '')}/`));
      for (const change of blobChanges) {
        if (!keys.has(change.blobId!)) throw new BlobMissingError(change.path);
      }
    }
  }

  // 计算下一棵内容树（检查点需要）
  const nextTree = applyChangesToTree(await resolveTree(fs, syncFolder, parent), changes);

  const generation = head.generation + 1;
  const createdAt = input.now ?? Date.now();
  const commitBase: Omit<RepoCommit, 'commitId'> = {
    parentCommitId: head.commitId,
    generation,
    createdAt,
    author: author ?? null,
    message: message ?? 'Sync',
    kind: 'sync',
    changeCount: changes.length,
    checkpointId: null,
    changes,
  };
  const commitId = await makeCommitId({ storageId, syncFolder }, commitBase);

  // 分层检查点：每 CHECKPOINT_INTERVAL 个提交写一次完整树快照，控制历史重建成本
  const withCheckpoint = generation % CHECKPOINT_INTERVAL === 0;
  const commit: RepoCommit = { ...commitBase, commitId, checkpointId: withCheckpoint ? commitId : null };
  if (withCheckpoint) await writeCheckpoint(fs, syncFolder, commitId, nextTree);
  await fs.put(commitKey(syncFolder, commitId), new TextEncoder().encode(JSON.stringify(commit)));

  const nextHead: RepositoryHead = { version: 1, commitId, generation, updatedAt: createdAt };
  const ok = await casWriteHead(fs, syncFolder, head, nextHead);
  if (!ok) throw new HeadConflictError();
  return { commit, head: nextHead };
}

function applyChangesToTree(tree: Map<string, RepoFile>, changes: RepoChange[]): Map<string, RepoFile> {
  const next = new Map(tree);
  applyChanges(next, changes);
  return next;
}

// ── 提交历史 / diff / 单文件历史 ──

export async function listCommits(
  fs: WorkerFs,
  syncFolder: string,
  head: RepositoryHead,
  cursor?: string,
  pageSize: number = COMMIT_PAGE_SIZE,
): Promise<{ commits: RepoCommitSummary[]; cursor: string | null }> {
  const commits: RepoCommitSummary[] = [];
  let commitId: string | null = cursor ?? head.commitId;
  while (commitId && commits.length < pageSize) {
    const commit = await readCommit(fs, syncFolder, commitId);
    if (!commit) break;
    commits.push(toSummary(commit));
    commitId = commit.parentCommitId;
  }
  return { commits, cursor: commitId };
}

export async function getCommitDetail(fs: WorkerFs, syncFolder: string, commitId: string): Promise<RepoCommit> {
  const commit = await readCommit(fs, syncFolder, commitId);
  if (!commit) throw new CommitNotFoundError(commitId);
  return commit;
}

export async function diffCommits(
  fs: WorkerFs,
  syncFolder: string,
  targetCommit: RepoCommit,
  againstCommit: RepoCommit,
): Promise<{ changes: RepoDiffEntry[]; added: number; modified: number; renamed: number; deleted: number }> {
  const target = await resolveTree(fs, syncFolder, targetCommit);
  const against = await resolveTree(fs, syncFolder, againstCommit);
  const changes = diffTrees(against, target);
  return { changes: toDiffEntries(changes), ...countDiff(changes) };
}

export async function fileHistory(
  fs: WorkerFs,
  syncFolder: string,
  head: RepositoryHead,
  identity: string,
  limit: number = FILE_HISTORY_LIMIT,
): Promise<{ commits: RepoCommitSummary[]; changes: RepoChange[] }> {
  const commits: RepoCommitSummary[] = [];
  const changes: RepoChange[] = [];
  let commitId: string | null = head.commitId;
  while (commitId && commits.length < limit) {
    const commit = await readCommit(fs, syncFolder, commitId);
    if (!commit) break;
    const matched = commit.changes.filter((c) => c.identity === identity);
    if (matched.length > 0) {
      commits.push(toSummary(commit));
      changes.push(...matched);
    }
    commitId = commit.parentCommitId;
  }
  commits.reverse();
  changes.reverse();
  return { commits, changes };
}

// ── 全库恢复（revert 语义） ──

export interface RestoreInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
  toCommitId: string;
  dryRun: boolean;
  author?: string;
}

export async function restoreRepository(input: RestoreInput): Promise<{ preview?: RepoRestorePreviewData; commit?: RepoCommit; head?: RepositoryHead }> {
  const { env, userId, storageId, syncFolder, fs, toCommitId, dryRun, author } = input;
  const head = await readHead(fs, syncFolder);
  if (!head) throw new RepoNotInitializedError();
  if (head.commitId === toCommitId) throw new EmptyChangesError();

  const target = await readCommit(fs, syncFolder, toCommitId);
  if (!target) throw new CommitNotFoundError(toCommitId);

  const current = await readCommit(fs, syncFolder, head.commitId);
  if (!current) throw new RepoIntegrityError(`HEAD commit missing: ${head.commitId}`);

  // 反向变更集：把当前树变成目标树（restore 不做内容复制，仅改引用）
  const currentTree = await resolveTree(fs, syncFolder, current);
  const targetTree = await resolveTree(fs, syncFolder, target);
  const changes = diffTrees(currentTree, targetTree);
  const preview: RepoRestorePreviewData = { changes: toDiffEntries(changes), ...countDiff(changes) };

  if (dryRun) return { preview };

  for (const change of changes) {
    if (change.operation !== 'delete' && change.blobId) {
      if (!(await fs.head(change.blobId))) throw new BlobMissingError(change.path);
    }
  }

  const generation = head.generation + 1;
  const createdAt = Date.now();
  const commitBase: Omit<RepoCommit, 'commitId'> = {
    parentCommitId: head.commitId,
    generation,
    createdAt,
    author: author ?? null,
    message: `Restore to ${toCommitId.slice(0, 8)}`,
    kind: 'restore',
    changeCount: changes.length,
    checkpointId: null,
    changes,
  };
  const commitId = await makeCommitId({ storageId, syncFolder }, commitBase);
  const commit: RepoCommit = { ...commitBase, commitId, checkpointId: commitId };

  await writeCheckpoint(fs, syncFolder, commitId, targetTree);
  await fs.put(commitKey(syncFolder, commitId), new TextEncoder().encode(JSON.stringify(commit)));

  const nextHead: RepositoryHead = { version: 1, commitId, generation, updatedAt: createdAt };
  const ok = await casWriteHead(fs, syncFolder, head, nextHead);
  if (!ok) throw new HeadConflictError();
  return { commit, head: nextHead };
}

export interface RepoRestorePreviewData {
  changes: RepoDiffEntry[];
  added: number;
  modified: number;
  renamed: number;
  deleted: number;
}

// ── 读取：树 / 内容 ──

export async function readTree(
  fs: WorkerFs,
  syncFolder: string,
  commitId: string,
): Promise<{ commitId: string; files: RepoFile[] }> {
  const commit = await readCommit(fs, syncFolder, commitId);
  if (!commit) throw new CommitNotFoundError(commitId);
  const tree = await resolveTree(fs, syncFolder, commit);
  return { commitId, files: [...tree.values()] };
}

export async function readContent(
  fs: WorkerFs,
  syncFolder: string,
  commitId: string,
  path: string,
): Promise<{ content: ArrayBuffer; file: RepoFile }> {
  const commit = await readCommit(fs, syncFolder, commitId);
  if (!commit) throw new CommitNotFoundError(commitId);
  const tree = await resolveTree(fs, syncFolder, commit);
  const file = tree.get(path);
  if (!file) throw new BlobMissingError(path);
  const content = await fs.get(file.blobId);
  return { content, file };
}

// ===== 垃圾回收 =====
// 删除"任何提交都未引用"的不可变内容对象。内容对象只在 commit 变更集中被引用，
// 被引用对象必须保留，否则历史读取会失败；.synx/ 下仓库本体与保留策略整体保留。
// Workers 子请求预算有限：按 maxCommits 分批遍历提交链（每批串行读），
// 一次跑不完时返回 more=true，可再次调用继续。

export interface GcRepositoryInput {
  fs: WorkerFs;
  syncFolder: string;
  /** 本次最多遍历的提交数（每提交 1 次 get 子请求） */
  maxCommits?: number;
  /** 本次最多删除的对象数 */
  maxDeletes?: number;
  /** 时间机器式保留策略：按时间窗口分层裁剪历史提交（各层桶保留最新 1 份）。缺省不裁剪历史。 */
  policy?: RetentionPolicy;
  /** 全局提交上限兜底（0 = 不限）：限制保留的提交总数，防止策略窗口过大导致历史无限增长 */
  maxRepoCommits?: number;
}

export interface GcRepositoryResult {
  /** 本次列出并检查的对象数 */
  scanned: number;
  /** 本次删除的未引用内容对象数 */
  deleted: number;
  /** 本次因时间机器策略淘汰而删除的历史提交数 */
  deletedCommits: number;
  /** true = 受预算限制未处理完，可再次调用 */
  more: boolean;
}

const GC_DEFAULT_MAX_COMMITS = 40;
const GC_DEFAULT_MAX_DELETES = 500;

// 时间机器分层窗口：各层内的时间桶（UTC），从新到旧逐层收紧。
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** 轻量读提交（跳过 head 校验）：commitId 来自 HEAD 链，必然存在。 */
async function readCommitFast(fs: WorkerFs, syncFolder: string, commitId: string): Promise<RepoCommit | null> {
  try {
    return JSON.parse(textDecoder.decode(await fs.get(commitKey(syncFolder, commitId)))) as RepoCommit;
  } catch {
    return null;
  }
}

interface RetentionLayer {
  within: (t: number) => boolean;
  bucket: (t: number) => string;
}

/** 按保留策略构造分层（策略关闭的层跳过；全部关闭 → 空，不裁剪历史）。 */
function buildRetentionLayers(policy: RetentionPolicy): RetentionLayer[] {
  const layers: RetentionLayer[] = [];
  if ((policy.hourlyWindowHours ?? 0) > 0) {
    layers.push({ within: (t) => t >= Date.now() - (policy.hourlyWindowHours ?? 0) * HOUR_MS, bucket: (t) => `h${Math.floor(t / HOUR_MS)}` });
  }
  if ((policy.dailyWindowDays ?? 0) > 0) {
    layers.push({ within: (t) => t >= Date.now() - (policy.dailyWindowDays ?? 0) * DAY_MS, bucket: (t) => `d${Math.floor(t / DAY_MS)}` });
  }
  if ((policy.monthlyWindowMonths ?? 0) > 0) {
    layers.push({
      within: (t) => t >= Date.now() - (policy.monthlyWindowMonths ?? 0) * MONTH_MS,
      bucket: (t) => {
        const d = new Date(t);
        return `m${d.getUTCFullYear() * 12 + d.getUTCMonth()}`;
      },
    });
  }
  if ((policy.yearlyWindowYears ?? 0) > 0) {
    layers.push({
      within: (t) => t >= Date.now() - (policy.yearlyWindowYears ?? 0) * YEAR_MS,
      bucket: (t) => `y${new Date(t).getUTCFullYear()}`,
    });
  }
  return layers;
}

/**
 * 时间机器式裁剪：从新到旧逐层扫描（hour → day → month → year），
 * 各层窗口内按时间桶保留最新 1 份；首次遇到「该桶已保留」或「超出全部窗口」时，
 * 其后的提交（更旧）全部淘汰。返回保留的连续提交数（commits[0..keep-1]）。
 *
 * 注意：为保证裁剪后历史链可解析，调用方还需把保留边界对齐到带 checkpoint 的提交。
 */
function computeKeepBoundary(commits: RepoCommit[], layers: RetentionLayer[]): number {
  if (layers.length === 0) return commits.length;
  let layerIdx = 0;
  const buckets = new Set<string>();
  let keep = 0;
  for (const commit of commits) {
    const t = commit.createdAt ?? 0;
    while (layerIdx < layers.length && !layers[layerIdx].within(t)) {
      layerIdx++; // 超出当前层窗口 → 进入更粗粒度层
      buckets.clear();
    }
    if (layerIdx >= layers.length) break; // 超出全部窗口 → 更旧的全部淘汰
    const bucket = layers[layerIdx].bucket(t);
    if (buckets.has(bucket)) break; // 该时间桶已保留过最新 → 更旧的全部淘汰
    buckets.add(bucket);
    keep++;
  }
  return keep;
}

export async function gcRepository(input: GcRepositoryInput): Promise<GcRepositoryResult> {
  const { fs, syncFolder, policy } = input;
  const maxCommits = input.maxCommits ?? GC_DEFAULT_MAX_COMMITS;
  const maxDeletes = input.maxDeletes ?? GC_DEFAULT_MAX_DELETES;
  const maxRepoCommits = input.maxRepoCommits ?? 0;
  const head = await readHead(fs, syncFolder);
  if (!head) return { scanned: 0, deleted: 0, deletedCommits: 0, more: false };

  // 1) 沿提交链收集提交（分批串行，避免超子请求预算）
  const commits: RepoCommit[] = [];
  let cursor: string | null = head.commitId;
  while (cursor && commits.length < maxCommits) {
    const commit = await readCommitFast(fs, syncFolder, cursor);
    if (!commit) break; // 提交链断裂（异常数据）：停止遍历，保守不删
    commits.push(commit);
    cursor = commit.parentCommitId;
  }
  const moreCommits = cursor !== null;

  // 2) 时间机器式历史裁剪（仅当提交链完整遍历时执行，避免误删未遍历提交引用的对象）
  //    从最旧端淘汰超出保留策略的提交及其独有的内容对象。
  let deletedCommits = 0;
  let keep = commits.length;
  if (!moreCommits && commits.length > 0 && policy) {
    const layers = buildRetentionLayers(policy);
    keep = computeKeepBoundary(commits, layers);
    if (maxRepoCommits > 0 && keep > maxRepoCommits) keep = maxRepoCommits;
    // 保留边界对齐到 checkpoint：最旧保留提交必须自带完整树快照，
    // 否则裁剪后从保留提交 resolveTree 会沿父链访问已删除提交。
    while (keep < commits.length && commits[keep - 1].checkpointId !== commits[keep - 1].commitId) keep++;
    deletedCommits = commits.length - keep;
  }

  // 只统计「保留提交」引用的 blob：同一 blob 可能被保留与淘汰提交同时引用
  // （如 restore 复用历史内容对象），淘汰提交不能带走仍被保留提交引用的对象。
  const keepReferenced = new Set<string>();
  for (let i = 0; i < keep; i++) {
    for (const change of commits[i].changes) if (change.blobId) keepReferenced.add(change.blobId);
  }

  // 3) 列出全部内容对象；.synx/（仓库本体 + 保留策略）整体保留，其余按引用清理
  const prefix = `${syncFolder.replace(/\/+$/, '')}/`;
  const allKeys = await fs.list(prefix);
  const orphanBlobs: string[] = [];
  for (const key of allKeys) {
    const rel = key.slice(prefix.length);
    if (rel.startsWith('.synx')) continue;
    if (!keepReferenced.has(key)) orphanBlobs.push(key);
  }

  // 4) 分批删除：内容对象 + 被淘汰提交的 commit/checkpoint 对象。
  // 提交链未完整遍历（moreCommits）时，未遍历提交可能引用当前判定为孤儿的对象，
  // 必须保守跳过删除（历史裁剪同理）。
  const toDelete: string[] = moreCommits ? [] : orphanBlobs.slice(0, maxDeletes);
  if (!moreCommits && deletedCommits > 0) {
    for (let i = keep; i < commits.length; i++) {
      toDelete.push(commitKey(syncFolder, commits[i].commitId));
      toDelete.push(checkpointKey(syncFolder, commits[i].commitId));
    }
  }
  let deleted = 0;
  if (toDelete.length > 0) {
    if (fs.deleteMany) {
      deleted = (await fs.deleteMany(toDelete)).deleted;
    } else {
      for (const key of toDelete) {
        try {
          await fs.delete(key);
          deleted++;
        } catch {
          // 单个删除失败不影响其余
        }
      }
    }
  }

  const more = moreCommits || orphanBlobs.length > toDelete.length;
  return { scanned: allKeys.length, deleted, deletedCommits, more };
}
