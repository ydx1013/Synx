import { Hono } from 'hono';
import type { HistoryResponse, RollbackResponse } from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getFs, StorageError } from '../storage/factory.js';
import { getHistory, rollback, VersionNotFound } from '../services/versionService.js';
import type { Env, AppVars } from '../types.js';

export const history = new Hono<{ Bindings: Env; Variables: AppVars }>();

history.use('*', authMiddleware);

// GET /api/history?path=
history.get('/history', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) return c.json({ error: 'missing X-Storage-Id or X-Sync-Folder' }, 400);
  const path = c.req.query('path');
  const fileUuid = c.req.query('fileUuid');
  if (!path) return c.json({ error: 'missing path' }, 400);

  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const versions = await getHistory({ env: c.env, userId, storageId, syncFolder, fs, path, fileUuid });
    const res: HistoryResponse = { versions };
    return c.json(res);
  } catch (e) {
    return handleError(c, e);
  }
});

// POST /api/rollback  {path, version}
history.post('/rollback', async (c) => {
  const storageId = c.req.header('X-Storage-Id');
  const syncFolder = c.req.header('X-Sync-Folder');
  if (!storageId || !syncFolder) return c.json({ error: 'missing X-Storage-Id or X-Sync-Folder' }, 400);

  const body = await c.req.json<{ path: string; fileUuid?: string; version: string }>();
  if (!body.path || !body.version) return c.json({ error: 'missing fields' }, 400);

  const userId = c.get('userId');
  try {
    const { fs } = await getFs(c.env, userId, storageId);
    const version = await rollback({
      env: c.env,
      userId,
      storageId,
      syncFolder,
      fs,
      path: body.path,
      fileUuid: body.fileUuid,
      versionId: body.version,
    });
    const res: RollbackResponse = { version };
    return c.json(res, 201);
  } catch (e) {
    return handleError(c, e);
  }
});

function handleError(c: any, e: unknown): Response {
  if (e instanceof StorageError) return c.json({ error: e.message }, e.status);
  if (e instanceof VersionNotFound) return c.json({ error: e.message }, 404);
  console.error('history route error:', e);
  return c.json({ error: 'internal error' }, 500);
}
