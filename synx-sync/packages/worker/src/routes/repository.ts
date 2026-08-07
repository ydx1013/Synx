import { Hono } from 'hono';
import type {
  RepoCommitsResponse,
  RepoCommitResponse,
  RepoDiffResponse,
  RepoFileHistoryResponse,
  RepoFinalizeRequest,
  RepoFinalizeResponse,
  RepoGcResponse,
  RepoHeadResponse,
  RepoInitRequest,
  RepoInitResponse,
  RepoRestoreRequest,
  RepoRestoreResponse,
  RepoTreeResponse,
  DirectUploadStartRequest,
  DirectUploadSessionResponse,
  RepoLockClearRequest,
  RepoLockClearResponse,
} from '@synx/shared';
import { makeStorageKey } from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getFs, StorageError } from '../storage/factory.js';
import { S3Fs } from '../storage/s3Fs.js';
import { enforceMaxFileSize, FileTooLarge, getRetentionPolicy } from '../services/retention.js';
import {
  BlobMissingError,
  CommitNotFoundError,
  EmptyChangesError,
  HeadConflictError,
  RepoExistsError,
  RepoIntegrityError,
  RepoNotInitializedError,
  diffCommits,
  fileHistory,
  finalizeCommit,
  gcRepository,
  getCommitDetail,
  initRepository,
  listCommits,
  readContent,
  readHead,
  readTree,
  restoreRepository,
} from '../services/repositoryService.js';
import {
  fileHistoryViaD1,
  isIndexReady,
  listCommitsViaD1,
  rebuildCommitIndex,
  writeCommitIndex,
} from '../services/commitIndex.js';
import type { AppVars, Env } from '../types.js';
import { logError } from '../logger.js';
import { forceClearRepositoryLock, normalizeRepositoryScope, RepositoryLockConflictError, RepositoryLockReleaseError, withRepositoryLock } from '../services/repositoryLock.js';
import { mapStorageHttpError } from './storageError.js';

export const repository = new Hono<{ Bindings: Env; Variables: AppVars }>();

repository.use('*', authMiddleware);

const DIRECT_UPLOAD_MAX_SIZE = 5 * 1024 * 1024 * 1024; // S3 单次 PUT 上限 5GiB
const DIRECT_UPLOAD_URL_EXPIRES_SECONDS = 15 * 60;

/** 取请求头中的仓库定位信息 */
function repoScope(c: { req: { header: (name: string) => string | undefined } }): { storageId: string; syncFolder: string } {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) {
    throw new StorageError(400, 'missing X-Storage-Id or X-Sync-Folder');
  }
  return { storageId, syncFolder };
}

// GET /api/repository/head
repository.get('/head', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const head = await readHead(fs, syncFolder);
    // 仓库数据只存在用户存储的文本对象中，绝不用 KV/D1 存仓库数据。
    // 树解析沿提交链回溯到最近 checkpoint，串行读取存储对象。
    const tree = head ? (await readTree(fs, syncFolder, head.commitId)).files : [];
    const res: RepoHeadResponse = { head, tree, storageId, syncFolder };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/repository/init
repository.post('/init', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const body = await c.req.json<RepoInitRequest>().catch(() => ({} as RepoInitRequest));
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const { head, commit } = await withRepositoryLock(
      c.env.DB,
      { userId: c.get('userId'), storageId, syncFolder },
      'init',
      () => initRepository({ storageId, syncFolder, fs, author: body.author, externalLock: true }),
    );
    const res: RepoInitResponse = { head, commit };
    return c.json(res, 201);
  } catch (e) {
    return handleError(c, e);
  }
});

// GET /api/repository/commits?cursor=
repository.get('/commits', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const head = await readHead(fs, syncFolder);
    if (!head) throw new RepoNotInitializedError();
    const cursor = c.req.query('cursor') || undefined;
    // 优先走 D1 索引（<50ms），降级到链表扫描
    const fromD1 = await listCommitsViaD1(c.env.DB, userId, storageId, syncFolder, cursor, 40);
    if (fromD1) {
      const res: RepoCommitsResponse = { commits: fromD1.commits, cursor: fromD1.cursor };
      return c.json(res);
    }
    // 降级：链表扫描（D1 不可用或索引为空）
    const { commits, cursor: next } = await listCommits(fs, syncFolder, head, cursor);
    const res: RepoCommitsResponse = { commits, cursor: next };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/repository/commits/finalize
repository.post('/commits/finalize', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const body = await c.req.json<RepoFinalizeRequest>();
  if (!Array.isArray(body.changes)) throw new StorageError(400, 'missing changes');
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const { commit, head } = await withRepositoryLock(
      c.env.DB,
      { userId: c.get('userId'), storageId, syncFolder },
      'finalize',
      () => finalizeCommit({
        storageId, syncFolder, fs, externalLock: true,
        baseCommitId: body.baseCommitId,
        baseGeneration: body.baseGeneration,
        author: body.author,
        message: body.message,
        changes: body.changes,
      }),
    );
    // 同步写 D1 索引（失败不影响提交结果，下次读会触发降级/重建）
    await writeCommitIndex(c.env.DB, c.get('userId'), storageId, syncFolder, commit).catch(() => {});
    const res: RepoFinalizeResponse = { commit, head };
    return c.json(res, 201);
  } catch (e) {
    return handleError(c, e);
  }
});

// GET /api/repository/commits/:id
repository.get('/commits/:id', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const commit = await getCommitDetail(fs, syncFolder, c.req.param('id'));
    const res: RepoCommitResponse = { commit };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// GET /api/repository/commits/:id/diff?against=
repository.get('/commits/:id/diff', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const target = await getCommitDetail(fs, syncFolder, c.req.param('id'));
    const againstId = c.req.query('against');
    const against = againstId
      ? await getCommitDetail(fs, syncFolder, againstId)
      : await (async () => {
          const head = await readHead(fs, syncFolder);
          if (!head) throw new RepoNotInitializedError();
          return getCommitDetail(fs, syncFolder, head.commitId);
        })();
    const { changes, added, modified, renamed, deleted } = await diffCommits(fs, syncFolder, target, against);
    const res: RepoDiffResponse = { against: against.commitId, target: target.commitId, changes, added, modified, renamed, deleted };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/repository/restore  {toCommitId, dryRun?, author?}
repository.post('/restore', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const body = await c.req.json<RepoRestoreRequest>();
  if (!body.toCommitId) throw new StorageError(400, 'missing toCommitId');
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const restore = () => restoreRepository({
      storageId, syncFolder, fs,
      toCommitId: body.toCommitId,
      dryRun: body.dryRun === true,
      author: body.author,
      externalLock: body.dryRun === true ? undefined : true,
    });
    const result = body.dryRun === true
      ? await restore()
      : await withRepositoryLock(c.env.DB, { userId: c.get('userId'), storageId, syncFolder }, 'restore', restore);
    const res: RepoRestoreResponse = { preview: result.preview, commit: result.commit, head: result.head };
    return c.json(res, result.commit ? 201 : 200);
  } catch (e) {
    return handleError(c, e);
  }
});

// GET /api/repository/tree?commitId=
repository.get('/tree', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const commitId = c.req.query('commitId');
  if (!commitId) throw new StorageError(400, 'missing commitId');
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const { commitId: id, files } = await readTree(fs, syncFolder, commitId);
    const res: RepoTreeResponse = { commitId: id, files };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/repository/direct-upload/start  body: { path, size, hash, mtime }
// 大文件直传：服务端生成对象键 + 预签名 PUT URL，插件把整个文件内容直接 PUT 到对象存储（不经过 Worker）。
// 客户端负责算内容 hash（finalize 变更集携带），服务端在 finalize 时仅校验 blob 存在。
repository.post('/direct-upload/start', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const body = await c.req.json<DirectUploadStartRequest>();
  try {
    validateDirectUploadFile(body.path, body.size, body.hash, body.mtime);
    const { fs, type } = await getFs(c.env, c.get('userId'), storageId);
    const s3 = requireS3(fs, type);
    const policy = await getRetentionPolicy(c.env, storageId, fs);
    enforceMaxFileSize(body.size, policy);
    const blobId = makeStorageKey(syncFolder, body.path, crypto.randomUUID());
    const uploadUrl = await s3.presignPut(blobId, DIRECT_UPLOAD_URL_EXPIRES_SECONDS);
    const res: DirectUploadSessionResponse = { blobId, uploadUrl, expiresIn: DIRECT_UPLOAD_URL_EXPIRES_SECONDS };
    return c.json(res, 201);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/repository/blobs?path=&mtime=  body=原始二进制
// 上传不可变内容对象：服务端生成 blobId（= 版本对象 storageKey），不写版本记录/current/manifest。
// 二进制直传（不做 base64/hash），避免大文件在 Workers 免费版 CPU 超限（1102）。
// 客户端负责算内容 hash（finalize 变更集携带），服务端在 finalize 时仅校验 blob 存在。
repository.post('/blobs', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  try {
    const path = c.req.query('path');
    const mtimeStr = c.req.query('mtime');
    if (!path || mtimeStr == null) throw new StorageError(400, 'missing path or mtime');
    const mtime = Number(mtimeStr);
    if (Number.isNaN(mtime)) throw new StorageError(400, 'invalid mtime');
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const content = await c.req.arrayBuffer();
    const policy = await getRetentionPolicy(c.env, storageId, fs);
    enforceMaxFileSize(content.byteLength, policy);
    const blobId = makeStorageKey(syncFolder, path, crypto.randomUUID());
    await fs.put(blobId, content);
    return c.json({ blobId, size: content.byteLength, mtime }, 201);
  } catch (e) {
    return handleError(c, e);
  }
});

// GET /api/repository/content?commitId=&path=  → 原始二进制
repository.get('/content', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const commitId = c.req.query('commitId');
  const path = c.req.query('path');
  if (!commitId || !path) throw new StorageError(400, 'missing commitId or path');
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const { content, file } = await readContent(fs, syncFolder, commitId, path);
    return c.body(content as ArrayBuffer, 200, {
      'Content-Type': file.path.toLowerCase().endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream',
      'X-Synx-Repo-File-Hash': file.hash,
    });
  } catch (e) {
    return handleError(c, e);
  }
});

// GET /api/repository/file-history?path=&fileUuid=&from=
repository.get('/file-history', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const userId = c.get('userId');
  const path = c.req.query('path');
  const fileUuid = c.req.query('fileUuid') || undefined;
  const from = c.req.query('from') || undefined;
  if (!path) throw new StorageError(400, 'missing path');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const head = await readHead(fs, syncFolder);
    if (!head) throw new RepoNotInitializedError();
    const identity = fileUuid ?? `path:${path}`;
    // 优先走 D1 索引（<50ms），降级到链表扫描
    const fromD1 = await fileHistoryViaD1(c.env.DB, userId, storageId, syncFolder, identity, from, 20);
    if (fromD1) {
      const res: RepoFileHistoryResponse = { identity, commits: fromD1.commits, changes: fromD1.changes, headCommitId: head.commitId, nextCursor: fromD1.nextCursor };
      return c.json(res);
    }
    // 降级：链表扫描
    const { commits, changes, nextCursor } = await fileHistory(fs, syncFolder, head, identity, 15, from);
    const res: RepoFileHistoryResponse = { identity, commits, changes, headCommitId: head.commitId, nextCursor };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/repository/gc  body: { maxCommits?, maxDeletes?, maxRepoCommits? }
// 清理任何提交都未引用的内容对象；并按该存储的保留策略做时间机器式历史裁剪
// （淘汰超出保留窗口的旧提交及其独有内容对象）。
// 受 Workers 子请求预算限制分批执行；more=true 表示可再次调用继续。
repository.post('/gc', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const body = await c.req.json<{ maxCommits?: number; maxDeletes?: number; maxRepoCommits?: number }>().catch(() => ({} as { maxCommits?: number; maxDeletes?: number; maxRepoCommits?: number }));
  try {
    const { fs } = await getFs(c.env, c.get('userId'), storageId);
    const policy = await getRetentionPolicy(c.env, storageId, fs);
    const result = await withRepositoryLock(
      c.env.DB,
      { userId: c.get('userId'), storageId, syncFolder },
      'gc',
      () => gcRepository({
        fs, syncFolder,
        maxCommits: body.maxCommits,
        maxDeletes: body.maxDeletes,
        maxRepoCommits: body.maxRepoCommits,
        policy,
      }),
    );
    const res: RepoGcResponse = result;
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

repository.post('/lock/clear', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const body = await c.req.json<RepoLockClearRequest>().catch(() => null);
  const normalized = normalizeRepositoryScope(syncFolder);
  if (!body || body.force !== true || body.confirm !== `CLEAR ${storageId}/${normalized}`) {
    return c.json({ error: 'explicit force confirmation required', code: 'CONFIRMATION_REQUIRED' }, 400);
  }
  try {
    await getFs(c.env, c.get('userId'), storageId);
    const cleared = await forceClearRepositoryLock(c.env.DB, {
      userId: c.get('userId'), storageId, syncFolder: normalized,
    });
    const response: RepoLockClearResponse = { cleared, storageId, syncFolder: normalized };
    return c.json(response);
  } catch (error) {
    return handleError(c, error);
  }
});

// POST /api/repository/rebuild-index
// 从用户存储重建 D1 提交索引。D1 丢失或索引不一致时手动调用。
repository.post('/rebuild-index', async (c) => {
  const { storageId, syncFolder } = repoScope(c);
  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const head = await readHead(fs, syncFolder);
    if (!head) throw new RepoNotInitializedError();
    const result = await rebuildCommitIndex(fs, c.env.DB, userId, storageId, syncFolder);
    return c.json({ ok: true, indexed: result.indexed, headCommitId: head.commitId });
  } catch (e) {
    return handleError(c, e);
  }
});

function requireS3(fs: unknown, type: string): S3Fs {
  if (type !== 's3' || !(fs instanceof S3Fs)) throw new StorageError(400, 'unsupported storage type');
  return fs;
}

function validateDirectUploadFile(path: string, size: number, hash: string, mtime: number): void {
  if (!path || path.startsWith('/') || path.includes('..') || !Number.isInteger(size) || size <= 0 || size > DIRECT_UPLOAD_MAX_SIZE
    || !/^[0-9a-f]{64}$/i.test(hash) || !Number.isFinite(mtime) || mtime <= 0) {
    throw new StorageError(size > DIRECT_UPLOAD_MAX_SIZE ? 413 : 400, 'invalid direct upload file');
  }
}

function handleError(c: any, e: unknown): Response {
  const storageError = mapStorageHttpError(e);
  if (storageError) return c.json(storageError.body, storageError.status);
  if (e instanceof FileTooLarge) return c.json({ error: e.message, code: 'FILE_TOO_LARGE' }, 413);
  if (e instanceof RepositoryLockConflictError) return c.json({ error: e.message, code: 'REPOSITORY_LOCKED' }, 409);
  if (e instanceof RepositoryLockReleaseError) return c.json({ error: e.message, code: 'REPOSITORY_LOCK_RELEASE_FAILED' }, 503);
  if (e instanceof HeadConflictError) return c.json({ error: e.message, code: 'HEAD_CONFLICT' }, 409);
  if (e instanceof RepoExistsError) return c.json({ error: e.message, code: 'REPO_EXISTS' }, 409);
  if (e instanceof RepoNotInitializedError) return c.json({ error: e.message, code: 'REPO_NOT_INITIALIZED' }, 404);
  if (e instanceof CommitNotFoundError) return c.json({ error: e.message, code: 'COMMIT_NOT_FOUND' }, 404);
  if (e instanceof BlobMissingError) return c.json({ error: e.message, code: 'BLOB_MISSING' }, 422);
  if (e instanceof EmptyChangesError) return c.json({ error: e.message, code: 'EMPTY_CHANGES' }, 400);
  if (e instanceof RepoIntegrityError) {
    logError(c, 'repository_integrity_error', e);
    return c.json({ error: e.message, code: 'REPO_INTEGRITY' }, 500);
  }
  logError(c, 'repository_route_error', e);
  return c.json({ error: 'internal error' }, 500);
}
