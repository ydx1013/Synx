import { Hono } from 'hono';
import { hashApiToken } from '../auth/apiToken.js';
import { checkRateLimit } from '../middleware/rateLimit.js';
import { getFs, StorageError } from '../storage/factory.js';
import { enforceMaxFileSize, FileTooLarge, getRetentionPolicy } from '../services/retention.js';
import { listFiles, putVersion } from '../services/versionService.js';
import type { AppVars, Env } from '../types.js';

interface ApiTokenRow {
  id: string;
  user_id: string;
  storage_id: string;
  sync_folder: string;
  target_folder: string;
}

export const inbox = new Hono<{ Bindings: Env; Variables: AppVars }>();

function fileNameFromTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/[. ]+$/g, '');
  if (!title || title.length > 180 || title === '.' || title === '..') return null;
  return `${title}.md`;
}

inbox.post('/notes', async c => {
  const authorization = c.req.header('Authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(synx_pat_[A-Za-z0-9_-]+)$/);
  if (!match) return c.json({ error: 'invalid API token', code: 'INVALID_API_TOKEN' }, 401);

  const tokenHash = await hashApiToken(match[1]);
  const token = await c.env.DB.prepare('SELECT id, user_id, storage_id, sync_folder, target_folder FROM api_tokens WHERE token_hash = ?')
    .bind(tokenHash).first<ApiTokenRow>();
  if (!token) return c.json({ error: 'invalid API token', code: 'INVALID_API_TOKEN' }, 401);

  const { allowed } = await checkRateLimit(c.env.KV, `inbox:token:${token.id}`, 60, 60);
  if (!allowed) return c.json({ error: 'too many requests', code: 'RATE_LIMITED' }, 429);

  let body: { title?: unknown; content?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON', code: 'INVALID_REQUEST' }, 400); }
  const fileName = fileNameFromTitle(body.title);
  if (!fileName) return c.json({ error: 'invalid title', code: 'INVALID_TITLE' }, 400);
  if (typeof body.content !== 'string') return c.json({ error: 'invalid content', code: 'INVALID_CONTENT' }, 400);

  const path = `${token.target_folder}/${fileName}`;
  const fileUuid = crypto.randomUUID();
  const content = new TextEncoder().encode(`<!-- synx-id:${fileUuid} -->\n\n${body.content}`);
  let reserved = false;
  try {
    const { fs } = await getFs(c.env, token.user_id, token.storage_id);
    const policy = await getRetentionPolicy(c.env, token.storage_id);
    enforceMaxFileSize(content.byteLength, policy);
    const existing = await listFiles({ env: c.env, userId: token.user_id, storageId: token.storage_id, syncFolder: token.sync_folder, fs });
    if (existing.some(file => file.path === path)) return c.json({ error: 'note already exists', code: 'NOTE_ALREADY_EXISTS' }, 409);

    const reservation = await c.env.DB.prepare('INSERT OR IGNORE INTO api_note_paths (token_id, storage_id, sync_folder, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(token.id, token.storage_id, token.sync_folder, path, Date.now()).run();
    if (!reservation.meta.changes) return c.json({ error: 'note already exists', code: 'NOTE_ALREADY_EXISTS' }, 409);
    reserved = true;

    const version = await putVersion({
      env: c.env, userId: token.user_id, storageId: token.storage_id, syncFolder: token.sync_folder,
      fs, path, fileUuid, content, mtime: Date.now(), author: `api:${token.id}`,
    });
    try {
      await c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), token.id).run();
    } catch (error) {
      console.error('inbox last-used update failed', error instanceof Error ? error.message : String(error));
    }
    return c.json({ note: { path, fileUuid, versionId: version.versionId, createdAt: version.createdAt } }, 201);
  } catch (error) {
    if (reserved) await c.env.DB.prepare('DELETE FROM api_note_paths WHERE storage_id = ? AND sync_folder = ? AND path = ?').bind(token.storage_id, token.sync_folder, path).run();
    if (error instanceof FileTooLarge) return c.json({ error: error.message, code: 'FILE_TOO_LARGE' }, 413);
    if (error instanceof StorageError) return c.json({ error: error.message, code: 'STORAGE_ERROR' }, error.status as 400 | 403 | 404);
    console.error('inbox note creation failed', error instanceof Error ? error.message : String(error));
    return c.json({ error: 'internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});
