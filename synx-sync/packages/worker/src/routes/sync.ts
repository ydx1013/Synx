import { Hono } from 'hono';
import { type PutResponse, type ListResponse } from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getFs, StorageError } from '../storage/factory.js';
import { deleteFile, putVersion, getVersion, listFiles, VersionConflict } from '../services/versionService.js';
import { enforceMaxFileSize, FileTooLarge, getRetentionPolicy } from '../services/retention.js';
import type { Env, AppVars } from '../types.js';

export const sync = new Hono<{ Bindings: Env; Variables: AppVars }>();

sync.use('*', authMiddleware);

// POST /api/put?path=&mtime=&fileUuid=&author=&baseVersionId=  body=原始二进制
// 上传大文件不做 base64 编码：Cloudflare Workers 免费版 CPU 配额仅 10ms/请求，
// base64 编码/解码 8MB+ 内容必然超限（错误 1102）。改为二进制流传输（同 remotely-save 直连 S3 的做法）。
sync.post('/put', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) return c.json({ error: 'missing X-Storage-Id or X-Sync-Folder' }, 400);

  const path = c.req.query('path');
  const fileUuid = c.req.query('fileUuid') || undefined;
  const mtimeStr = c.req.query('mtime');
  const author = c.req.query('author') || undefined;
  const baseVersionId = c.req.query('baseVersionId') || undefined;
  if (!path || mtimeStr == null) {
    const missing = [!path ? 'path' : null, mtimeStr == null ? 'mtime' : null].filter(Boolean);
    return c.json({ error: `missing fields: ${missing.join(', ')}` }, 400);
  }
  const mtime = Number(mtimeStr);
  if (Number.isNaN(mtime)) return c.json({ error: 'invalid mtime' }, 400);

  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const content = await c.req.arrayBuffer();
    // put 前校验文件大小
    const policy = await getRetentionPolicy(c.env, storageId, fs);
    enforceMaxFileSize(content.byteLength, policy);
    const version = await putVersion({
      env: c.env,
      userId,
      storageId,
      syncFolder,
      fs,
      path,
      fileUuid,
      content,
      mtime,
      author,
      baseVersionId,
    });
    const res: PutResponse = { version };
    return c.json(res, 201);
  } catch (e) {
    return handleStorageError(c, e);
  }
});

// GET /api/get?path=&version=&fileUuid=  → 返回原始二进制 + X-Synx-Version 头
// 不在 worker 内 base64 编码，避免大文件 CPU 超限（1102）。
sync.get('/get', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  if (!storageId) return c.json({ error: 'missing X-Storage-Id' }, 400);
  const path = c.req.query('path');
  const version = c.req.query('version');
  const fileUuid = c.req.query('fileUuid');
  if (!path) return c.json({ error: 'missing path' }, 400);

  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const syncFolder = c.req.header('X-Sync-Folder');
    if (!syncFolder) return c.json({ error: 'missing X-Sync-Folder' }, 400);
    const { content, version: ver } = await getVersion({
      env: c.env,
      userId,
      storageId,
      syncFolder,
      fs,
      path,
      fileUuid,
      versionId: version,
    });
    // 二进制透传；version 元数据放响应头，避免 JSON 包装引入 base64
    return c.body(content, 200, {
      'Content-Type': 'application/octet-stream',
      'X-Synx-Version': JSON.stringify(ver),
    });
  } catch (e) {
    return handleStorageError(c, e);
  }
});

sync.delete('/file', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) return c.json({ error: 'missing X-Storage-Id or X-Sync-Folder' }, 400);
  const body = await c.req.json<{ path: string; fileUuid?: string }>();
  if (!body.path) return c.json({ error: 'missing path' }, 400);
  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    await deleteFile({ env: c.env, userId, storageId, syncFolder, fs, path: body.path, fileUuid: body.fileUuid });
    return c.json({ deleted: true });
  } catch (e) {
    return handleStorageError(c, e);
  }
});

// GET /api/list
sync.get('/list', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) return c.json({ error: 'missing X-Storage-Id or X-Sync-Folder' }, 400);

  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const files = await listFiles({ env: c.env, userId, storageId, syncFolder, fs });
    const res: ListResponse = { files };
    return c.json(res);
  } catch (e) {
    return handleStorageError(c, e);
  }
});

function handleStorageError(c: any, e: unknown): Response {
  if (e instanceof StorageError) return c.json({ error: e.message }, e.status);
  if (e instanceof FileTooLarge) return c.json({ error: e.message, code: 'FILE_TOO_LARGE' }, 413);
  if (e instanceof VersionConflict) return c.json({ error: e.message, code: 'VERSION_CONFLICT' }, 409);
  if (e instanceof Error && e.name === 'VersionNotFound') return c.json({ error: e.message }, 404);
  if (e instanceof Error && e.name === 'VersionDeleted') return c.json({ error: e.message, code: 'FILE_DELETED' }, 410);
  // 未知错误：日志（Workers 控制台）+ 500
  const detail = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}` : String(e);
  console.error('sync route error:', detail);
  return c.json({ error: 'internal error', detail }, 500);
}
