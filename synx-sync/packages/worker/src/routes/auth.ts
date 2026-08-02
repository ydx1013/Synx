import { Hono } from 'hono';
import type { User } from '@synx/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signJwt } from '../auth/jwt.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkRateLimit, getClientId } from '../middleware/rateLimit.js';
import type { Env, AppVars } from '../types.js';
import type {
  AuthResponse,
  LoginRequest,
  MeResponse,
  PreferencesResponse,
  RegisterRequest,
  UpdatePreferencesRequest,
  UserPreferences,
} from '@synx/shared';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_RATE_MAX = 5;
const LOGIN_RATE_WINDOW = 60;

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  default_storage_id: string | null;
  default_sync_folder: string | null;
  created_at: number;
  updated_at: number;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPreferences(row: UserRow): UserPreferences {
  return {
    defaultStorageId: row.default_storage_id ?? null,
    defaultSyncFolder: normalizeSyncFolder(row.default_sync_folder),
  };
}

function normalizeSyncFolder(value: unknown): string {
  const folder = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
  return folder ? `${folder}/` : 'my-vault/';
}

export const auth = new Hono<{ Bindings: Env; Variables: AppVars }>();

auth.post('/register', async (c) => {
  const body = await c.req.json<RegisterRequest>();
  const { username, email, password } = body;

  if (!username || !email || !password) return c.json({ error: 'missing fields' }, 400);
  if (username.length < 3) return c.json({ error: 'username too short (min 3)' }, 400);
  if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid email format' }, 400);
  if (password.length < 8) return c.json({ error: 'password too short (min 8)' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .bind(username, email)
    .first();
  if (existing) return c.json({ error: 'username or email already exists' }, 409);

  const hash = await hashPassword(password);
  const now = Date.now();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO users (id, username, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, username, email, hash, now, now)
    .run();

  const user: User = { id, username, email, createdAt: now, updatedAt: now };
  const token = await signJwt({ sub: id }, c.env.JWT_SECRET);
  return c.json<AuthResponse>({ token, user }, 201);
});

auth.post('/login', async (c) => {
  const clientId = getClientId(c);
  const { allowed } = await checkRateLimit(c.env.KV, `login:${clientId}`, LOGIN_RATE_MAX, LOGIN_RATE_WINDOW);
  if (!allowed) return c.json({ error: 'too many login attempts, try later' }, 429);

  const body = await c.req.json<LoginRequest>();
  const { usernameOrEmail, password } = body;
  if (!usernameOrEmail || !password) return c.json({ error: 'missing fields' }, 400);

  const row = await c.env.DB.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .bind(usernameOrEmail, usernameOrEmail)
    .first<UserRow>();
  if (!row) return c.json({ error: 'invalid credentials' }, 401);

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return c.json({ error: 'invalid credentials' }, 401);

  const user = rowToUser(row);
  const token = await signJwt({ sub: user.id }, c.env.JWT_SECRET);
  return c.json<AuthResponse>({ token, user });
});

// 当前用户信息（需登录）
auth.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  if (!row) return c.json({ error: 'user not found' }, 404);
  return c.json<MeResponse>({ user: rowToUser(row), preferences: rowToPreferences(row) });
});

auth.patch('/me/preferences', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<UpdatePreferencesRequest>();
  const defaultStorageId = typeof body.defaultStorageId === 'string' && body.defaultStorageId.trim()
    ? body.defaultStorageId.trim()
    : null;
  const defaultSyncFolder = normalizeSyncFolder(body.defaultSyncFolder);

  if (defaultStorageId) {
    const storage = await c.env.DB.prepare('SELECT id, user_id FROM storages WHERE id = ?')
      .bind(defaultStorageId)
      .first<{ id: string; user_id: string }>();
    if (!storage || storage.user_id !== userId) return c.json({ error: 'invalid default storage' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE users SET default_storage_id = ?, default_sync_folder = ?, updated_at = ? WHERE id = ?',
  )
    .bind(defaultStorageId, defaultSyncFolder, Date.now(), userId)
    .run();

  return c.json<PreferencesResponse>({ preferences: { defaultStorageId, defaultSyncFolder } });
});
