import { Hono } from 'hono';
import { DEFAULT_RETENTION, type CreateStorageRequest, type OnedriveConfig, type RetentionPolicy, type StorageSummary, type S3Config, type StorageConfig, type StorageType, type WebdavConfig, type WorkerFs } from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import { decryptString, encryptString } from '../auth/crypto.js';
import { ConnectivityError, checkConnectivity } from '../storage/connectivity.js';
import { getFs, StorageError } from '../storage/factory.js';
import { normalizePolicy } from '../services/retention.js';
import { OneDriveFs } from '../storage/onedriveFs.js';
import { S3Fs } from '../storage/s3Fs.js';
import { WebDAVFs } from '../storage/webdavFs.js';
import type { Env, AppVars } from '../types.js';

interface StorageRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  config: string;
  created_at: number;
}

function rowToSummary(row: StorageRow): StorageSummary {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type as StorageType,
    config: null,
    createdAt: row.created_at,
  };
}

// ── 验证函数 ──────────────────────────────────────────

const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'connection',
  'content-length', 'transfer-encoding', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip',
]);

function hasSensitiveCustomHeader(raw?: string): boolean {
  if (!raw) return false;
  return raw.split('\n').some((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) return false;
    return FORBIDDEN_CUSTOM_HEADERS.has(line.slice(0, separator).trim().toLowerCase());
  });
}

function validateS3Config(config: Partial<S3Config>): string | null {
  const { endpoint, bucket, accessKey, secretKey, region } = config;
  if (!endpoint || !bucket || !accessKey || !secretKey || !region) return 'incomplete s3 config';
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return 'endpoint must use https';
    if (url.username || url.password || url.search || url.hash) return 'invalid endpoint';
    if (isBlockedHostname(url.hostname)) return 'endpoint host is not allowed';
  } catch {
    return 'invalid endpoint';
  }
  return null;
}

function validateWebdavConfig(config: Partial<WebdavConfig>): string | null {
  const { address, username, password, authType, customHeaders } = config;
  if (!address || !username || !password) return 'incomplete webdav config';
  if (authType && authType !== 'basic') return 'invalid auth type';
  if (hasSensitiveCustomHeader(customHeaders)) return 'custom headers contain a forbidden header';
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:') return 'address must use https';
    if (url.username || url.password || url.search || url.hash) return 'invalid address';
    if (isBlockedHostname(url.hostname)) return 'address host is not allowed';
  } catch {
    return 'invalid address';
  }
  return null;
}

function validateOnedriveConfig(config: Partial<OnedriveConfig>): string | null {
  const { accessToken, refreshToken, clientId, authority } = config;
  if (!accessToken || !refreshToken || !clientId || !authority) return 'incomplete onedrive config';
  try {
    const url = new URL(authority);
    if (url.protocol !== 'https:') return 'authority must use https';
    if (url.hostname.toLowerCase() !== 'login.microsoftonline.com' || url.username || url.password || url.search || url.hash) {
      return 'invalid authority';
    }
  } catch {
    return 'invalid authority';
  }
  return null;
}

function validateConfig(type: StorageType, config: unknown): string | null {
  switch (type) {
    case 's3': return validateS3Config(config as Partial<S3Config>);
    case 'webdav': return validateWebdavConfig(config as Partial<WebdavConfig>);
    case 'onedrive': return validateOnedriveConfig(config as Partial<OnedriveConfig>);
    default: return `unsupported storage type: ${type}`;
  }
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '::') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) {
    const mappedDotted = host.match(/:ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
    if (mappedDotted) return isBlockedIpv4(mappedDotted.slice(1).map(Number));
    const mappedHex = host.match(/:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isBlockedIpv4([(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255]);
    }
    return host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host);
  }
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? isBlockedIpv4(parts)
    : false;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

// ── FS 工厂 ──────────────────────────────────────────

function createFs(type: StorageType, config: StorageConfig): WorkerFs {
  switch (type) {
    case 's3': return new S3Fs(config as S3Config);
    case 'webdav': return new WebDAVFs(config as WebdavConfig);
    case 'onedrive': return new OneDriveFs(config as OnedriveConfig);
    default: throw new Error(`unsupported storage type: ${type}`);
  }
}

// ── 错误消息 ──────────────────────────────────────────

function connectivityErrorMessage(error: unknown, type: StorageType): string {
  const message = error instanceof Error ? error.message : '';
  if (type === 's3') {
    if (/list failed \(401|list failed \(403/.test(message)) return '无法列出存储桶，请检查凭证、Bucket 和读取权限';
    if (/put failed/.test(message)) return '无法写入测试文件，请检查写入权限';
    if (/get failed|content mismatch/.test(message)) return '无法正确下载测试文件，请检查读取权限和服务兼容性';
    if (/cleanup failed/.test(message)) return '连接测试失败，并且临时测试文件可能未清理，请检查权限后删除 .synx-connectivity-test 中的残留对象';
    if (/delete failed/.test(message)) return '测试文件无法删除，请检查删除权限';
    return '无法连接存储，请检查 Endpoint、Region、Bucket、凭证和 Path Style';
  }
  if (type === 'webdav') {
    if (error instanceof ConnectivityError) {
      const messages: Record<string, string> = {
        list: '列目录阶段失败，请检查 WebDAV 地址、用户名、密码和读取权限',
        upload: '上传阶段失败，请检查建目录和写入权限',
        overwrite: '覆盖写入阶段失败，请检查服务器是否允许更新已有文件',
        download: '下载阶段失败，请检查读取权限和服务兼容性',
        verify: '内容校验失败，服务器返回的数据与上传内容不一致',
        delete: '删除阶段失败，临时测试文件可能未清理',
      };
      const message = messages[error.stage] || 'WebDAV 连接测试失败';
      return error.cleanupFailed ? `${message}；清理也失败，.synx-connectivity-test 中可能存在残留文件` : message;
    }
    if (/list failed \(401|list failed \(403/.test(message)) return '无法连接 WebDAV 服务器，请检查地址、用户名和密码';
    if (/mkdir failed/.test(message)) return '无法创建目录，请检查写入权限和服务器配置';
    if (/put failed/.test(message)) return '无法写入测试文件，请检查写入权限';
    if (/get failed|content mismatch/.test(message)) return '无法正确下载测试文件，请检查读取权限和服务器兼容性';
    if (/cleanup failed/.test(message)) return '连接测试失败，并且临时测试文件可能未清理，请检查权限后删除 .synx-connectivity-test 中的残留文件';
    if (/delete failed/.test(message)) return '测试文件无法删除，请检查删除权限';
    return '无法连接 WebDAV 服务器，请检查地址、凭证和权限';
  }
  if (type === 'onedrive') {
    if (/list failed \(401|list failed \(403|token refresh failed|token exchange failed/.test(message)) return 'OneDrive 认证失败，请重新授权获取新的 token';
    if (/put failed/.test(message)) return '无法写入 OneDrive，请检查 App Folder 写入权限';
    if (/get failed|download failed|content mismatch/.test(message)) return '无法读取 OneDrive 文件，请检查 App Folder 读取权限';
    if (/cleanup failed/.test(message)) return '连接测试失败，并且临时测试文件可能未清理，请检查权限后删除 .synx-connectivity-test 中的残留文件';
    if (/delete failed/.test(message)) return '测试文件无法删除，请检查 App Folder 删除权限';
    return '无法连接 OneDrive，请检查 token 有效性和 App Folder 权限';
  }
  return '连接测试失败';
}

// ── 路由 ──────────────────────────────────────────────

export const storage = new Hono<{ Bindings: Env; Variables: AppVars }>();

storage.use('*', authMiddleware);

storage.post('/test', async (c) => {
  const body = await c.req.json<{ id?: string; type?: StorageType; config?: Partial<StorageConfig> }>();
  let type = body.type;
  let config = body.config as StorageConfig | undefined;
  if (body.id) {
    const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?')
      .bind(body.id)
      .first<StorageRow>();
    if (!row) return c.json({ error: 'storage not found' }, 404);
    if (row.user_id !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);
    type = row.type as StorageType;
    const current = JSON.parse(await decryptString(row.config, c.env.ENCRYPTION_KEY)) as StorageConfig;
    config = { ...current, ...(body.config || {}) } as StorageConfig;
    if ('password' in config && !config.password) config.password = (current as WebdavConfig).password;
    if (type === 'webdav') (config as WebdavConfig).authType = 'basic';
  }
  if (!type || !config) return c.json({ error: 'missing fields' }, 400);

  const err = validateConfig(type, config);
  if (err) return c.json({ error: err }, 400);

  try {
    const fs = createFs(type, config);
    await checkConnectivity(fs);
    return c.json({ ok: true });
  } catch (error) {
    const codes: Record<StorageType, string> = {
      s3: 'S3_CONNECTION_FAILED',
      webdav: 'WEBDAV_CONNECTION_FAILED',
      onedrive: 'ONEDRIVE_CONNECTION_FAILED',
      dropbox: 'DROPBOX_CONNECTION_FAILED',
    };
    console.error('storage/test failed', { type, stage: error instanceof ConnectivityError ? error.stage : 'unknown' });
    return c.json({ error: connectivityErrorMessage(error, type), code: codes[type] || 'CONNECTION_FAILED' }, 422);
  }
});

// 创建存储（AES 加密凭证存 D1）
storage.post('/', async (c) => {
  const body = await c.req.json<CreateStorageRequest>();
  const { name, type, config } = body;
  if (!name || !type || !config) return c.json({ error: 'missing fields' }, 400);

  const err = validateConfig(type, config);
  if (err) return c.json({ error: err }, 400);

  const userId = c.get('userId');
  const encrypted = await encryptString(JSON.stringify(config), c.env.ENCRYPTION_KEY);
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO storages (id, user_id, name, type, config, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, name, type, encrypted, now)
    .run();

  const summary: StorageSummary = { id, userId, name, type, config: null, createdAt: now };
  return c.json({ storage: summary }, 201);
});

// 列出当前用户的存储（不返回明文凭证）
storage.get('/', async (c) => {
  const userId = c.get('userId');
  const result = await c.env.DB.prepare('SELECT * FROM storages WHERE user_id = ?')
    .bind(userId)
    .all<StorageRow>();
  const storages = (result.results ?? []).map(rowToSummary);
  return c.json({ storages });
});

function sanitizeCustomHeaders(raw?: string): string | undefined {
  if (!raw) return undefined;
  const sanitized = raw.split('\n').filter((line) => {
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    return name !== 'authorization' && name !== 'proxy-authorization' && name !== 'cookie' && name !== 'set-cookie';
  }).join('\n').trim();
  return sanitized || undefined;
}

function redactConfig(type: StorageType, config: StorageConfig): Record<string, unknown> {
  if (type === 'webdav') {
    const webdav = config as WebdavConfig;
    return {
      address: webdav.address,
      username: webdav.username,
      authType: 'basic',
      ...(webdav.remoteBaseDir ? { remoteBaseDir: webdav.remoteBaseDir } : {}),
      ...(sanitizeCustomHeaders(webdav.customHeaders) ? { customHeaders: sanitizeCustomHeaders(webdav.customHeaders) } : {}),
    };
  }
  if (type === 's3') {
    const s3 = config as S3Config;
    return { endpoint: s3.endpoint, bucket: s3.bucket, region: s3.region, pathStyle: s3.pathStyle ?? false };
  }
  const onedrive = config as OnedriveConfig;
  return { clientId: onedrive.clientId, authority: onedrive.authority, remoteBaseDir: onedrive.remoteBaseDir, username: onedrive.username };
}

storage.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<StorageRow>();
  if (!row) return c.json({ error: 'storage not found' }, 404);
  if (row.user_id !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);
  const config = JSON.parse(await decryptString(row.config, c.env.ENCRYPTION_KEY)) as StorageConfig;
  return c.json({ storage: { ...rowToSummary(row), config: redactConfig(row.type as StorageType, config) } });
});

storage.patch('/:id', async (c) => {
  const body = await c.req.json<{ name?: string; type?: StorageType; config?: Partial<StorageConfig> }>();
  if (body.type) return c.json({ error: 'storage type cannot be changed' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<StorageRow>();
  if (!row) return c.json({ error: 'storage not found' }, 404);
  if (row.user_id !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);
  const current = JSON.parse(await decryptString(row.config, c.env.ENCRYPTION_KEY)) as StorageConfig;
  const next = { ...current, ...(body.config || {}) } as StorageConfig;
  if ('password' in next && !next.password) next.password = (current as WebdavConfig).password;
  if (row.type === 'webdav') (next as WebdavConfig).authType = 'basic';
  const err = validateConfig(row.type as StorageType, next);
  if (err) return c.json({ error: err }, 400);
  const name = body.name?.trim() || row.name;
  const encrypted = await encryptString(JSON.stringify(next), c.env.ENCRYPTION_KEY);
  await c.env.DB.prepare('UPDATE storages SET name = ?, config = ? WHERE id = ? AND user_id = ?')
    .bind(name, encrypted, row.id, row.user_id)
    .run();
  return c.json({ storage: { ...rowToSummary({ ...row, name }), config: redactConfig(row.type as StorageType, next) } });
});

// GET /api/storage/:id/retention —— 读取保留策略
storage.get('/:id/retention', async (c) => {
  const row = await c.env.DB.prepare('SELECT retention_policy FROM storages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ retention_policy: string | null }>();
  if (!row) return c.json({ error: 'storage not found' }, 404);
  if (row.retention_policy === undefined) return c.json({ error: 'retention column unavailable; run migrations' }, 500);
  let policy: RetentionPolicy;
  try {
    policy = row.retention_policy ? (JSON.parse(row.retention_policy) as RetentionPolicy) : DEFAULT_RETENTION;
  } catch {
    policy = DEFAULT_RETENTION;
  }
  return c.json({ policy });
});

// PUT /api/storage/:id/retention —— 保存保留策略
storage.put('/:id/retention', async (c) => {
  const body = await c.req.json<Partial<RetentionPolicy>>();
  const row = await c.env.DB.prepare('SELECT id, user_id, retention_policy FROM storages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; user_id: string; retention_policy: string | null }>();
  if (!row) return c.json({ error: 'storage not found' }, 404);
  if (row.user_id !== c.get('userId')) return c.json({ error: 'forbidden' }, 403);
  const policy = normalizePolicy(body);
  await c.env.DB.prepare('UPDATE storages SET retention_policy = ? WHERE id = ? AND user_id = ?')
    .bind(JSON.stringify(policy), row.id, row.user_id)
    .run();
  return c.json({ policy });
});

storage.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?')
    .bind(id)
    .first<StorageRow>();
  if (!row) return c.json({ error: 'storage not found' }, 404);
  if (row.user_id !== userId) return c.json({ error: 'forbidden' }, 403);

  await c.env.DB.prepare('DELETE FROM storages WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run();
  return c.json({ ok: true, remoteFilesPreserved: true });
});

// 清空存储中所有同步数据（文件内容 + 版本元数据 + tombstone）
storage.post('/:id/purge', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { fs } = await getFs(c.env, userId, id);
    const keys = await fs.list('');
    let deleted = 0;
    let failed = 0;
    if (fs.deleteMany) {
      const result = await fs.deleteMany(keys);
      deleted = result.deleted;
      failed = result.failed;
    } else {
      for (const key of keys) {
        try {
          await fs.delete(key);
          deleted++;
        } catch {
          failed++;
        }
      }
    }
    return c.json({ ok: true, total: keys.length, deleted, failed });
  } catch (e) {
    if (e instanceof StorageError) return c.json({ error: e.message }, e.status as 400 | 403 | 404);
    console.error('purge error:', e);
    return c.json({ error: 'internal error' }, 500);
  }
});



