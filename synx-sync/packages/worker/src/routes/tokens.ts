import { Hono } from 'hono';
import { apiTokenPrefix, generateApiToken, hashApiToken } from '../auth/apiToken.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AppVars, Env } from '../types.js';

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  storage_id: string;
  storage_name?: string;
  sync_folder: string;
  target_folder: string;
  created_at: number;
  last_used_at: number | null;
}

export const tokens = new Hono<{ Bindings: Env; Variables: AppVars }>();
tokens.use('*', authMiddleware);

function normalizeFolder(value: unknown, trailingSlash: boolean): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.includes('\\') || raw.startsWith('/') || raw.split('/').some(part => part === '..' || part === '.')) return null;
  const normalized = raw.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return trailingSlash ? `${normalized}/` : normalized;
}

function serialize(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    storageId: row.storage_id,
    storageName: row.storage_name,
    syncFolder: row.sync_folder,
    targetFolder: row.target_folder,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

tokens.post('/', async c => {
  const body = await c.req.json<{ name?: string; storageId?: string; syncFolder?: string; targetFolder?: string }>();
  const name = body.name?.trim();
  const storageId = body.storageId?.trim();
  const syncFolder = normalizeFolder(body.syncFolder, true);
  const targetFolder = normalizeFolder(body.targetFolder, false);
  if (!name || name.length > 100 || !storageId || !syncFolder || !targetFolder) {
    return c.json({ error: 'invalid token configuration', code: 'INVALID_TOKEN_CONFIG' }, 400);
  }

  const userId = c.get('userId');
  const storage = await c.env.DB.prepare('SELECT id, user_id FROM storages WHERE id = ?').bind(storageId).first<{ id: string; user_id: string }>();
  if (!storage || storage.user_id !== userId) return c.json({ error: 'invalid storage', code: 'INVALID_STORAGE' }, 400);

  const token = generateApiToken();
  const row: TokenRow = {
    id: crypto.randomUUID(), name, token_prefix: apiTokenPrefix(token), storage_id: storageId,
    sync_folder: syncFolder, target_folder: targetFolder, created_at: Date.now(), last_used_at: null,
  };
  await c.env.DB.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, storage_id, sync_folder, target_folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, userId, row.name, await hashApiToken(token), row.token_prefix, row.storage_id, row.sync_folder, row.target_folder, row.created_at)
    .run();
  return c.json({ token, apiToken: serialize(row) }, 201);
});

tokens.get('/', async c => {
  const result = await c.env.DB.prepare('SELECT t.id, t.name, t.token_prefix, t.storage_id, s.name AS storage_name, t.sync_folder, t.target_folder, t.created_at, t.last_used_at FROM api_tokens t JOIN storages s ON s.id = t.storage_id WHERE t.user_id = ? ORDER BY t.created_at DESC')
    .bind(c.get('userId')).all<TokenRow>();
  return c.json({ tokens: (result.results ?? []).map(serialize) });
});

tokens.delete('/:id', async c => {
  await c.env.DB.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('userId')).run();
  return c.json({ ok: true });
});
