import { Hono } from 'hono';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  type PutResponse,
  type GetResponse,
  type ListResponse,
} from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getFs, StorageError } from '../storage/factory.js';
import { deleteFile, putVersion, getVersion, listFiles, VersionConflict } from '../services/versionService.js';
import { enforceMaxFileSize, FileTooLarge, getRetentionPolicy } from '../services/retention.js';
import type { Env, AppVars } from '../types.js';

export const sync = new Hono<{ Bindings: Env; Variables: AppVars }>();

sync.use('*', authMiddleware);

// POST /api/put  {path, mtime, content(base64), author?}
sync.post('/put', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) return c.json({ error: 'missing X-Storage-Id or X-Sync-Folder' }, 400);

  const body = await c.req.json<{ path: string; fileUuid?: string; mtime: number; content: string; author?: string; baseVersionId?: string }>();
  const missing: string[] = [];
  if (!body.path) missing.push('path');
  if (body.mtime == null) missing.push('mtime');
  if (body.content == null) missing.push('content');
  if (missing.length > 0) return c.json({ error: `missing fields: ${missing.join(', ')}` }, 400);

  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const content = base64ToArrayBuffer(body.content);
    // put 前校验文件大小
    const policy = await getRetentionPolicy(c.env, storageId);
    enforceMaxFileSize(content.byteLength, policy);
    const version = await putVersion({
      env: c.env,
      userId,
      storageId,
      syncFolder,
      fs,
      path: body.path,
      fileUuid: body.fileUuid,
      content,
      mtime: body.mtime,
      author: body.author,
      baseVersionId: body.baseVersionId,
    });
    const res: PutResponse = { version };
    return c.json(res, 201);
  } catch (e) {
    return handleStorageError(c, e);
  }
});

// GET /api/get?path=&version=
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
    const res: GetResponse = { content: arrayBufferToBase64(content), version: ver };
    return c.json(res);
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
