import { Hono, type Context } from 'hono';
import type { GitHubGalleryConfig, ImageGallery, SaveImageGalleryRequest } from '@synx/shared';
import { authMiddleware } from '../middleware/auth.js';
import { decryptString, encryptString } from '../auth/crypto.js';
import { checkGitHubGallery, deleteGitHubGalleryFile, GitHubGalleryError, listGitHubGalleryFiles, readGitHubImage, uploadGitHubImage } from '../services/githubGallery.js';
import type { AppVars, Env } from '../types.js';

interface GalleryRow {
  id: string;
  user_id: string;
  name: string;
  provider: 'github';
  config: string;
  is_private: number;
  created_at: number;
  updated_at: number;
}

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

export const imageGalleries = new Hono<{ Bindings: Env; Variables: AppVars }>();
imageGalleries.use('*', authMiddleware);

function normalizeFolder(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

function validSegment(value: string): boolean {
  return Boolean(value.trim()) && !/[\\/?#]/.test(value);
}

function validate(body: Partial<SaveImageGalleryRequest>, requireToken: boolean): string | null {
  if (!body.name?.trim() || !validSegment(body.owner ?? '') || !validSegment(body.repo ?? '') || !body.branch?.trim()) return '图库配置不完整';
  if (requireToken && !body.token?.trim()) return 'GitHub Token 不能为空';
  const folder = normalizeFolder(body.folder ?? '');
  if (!folder || folder.split('/').some((part) => part === '.' || part === '..')) return '图库目录无效';
  return null;
}

function publicConfig(config: GitHubGalleryConfig): Omit<GitHubGalleryConfig, 'token'> {
  const { token: _, ...rest } = config;
  return rest;
}

function toGallery(row: GalleryRow, config: GitHubGalleryConfig): ImageGallery {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    provider: 'github',
    ...publicConfig(config),
    isPrivate: row.is_private === 1,
    hasToken: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type GalleryContext = Context<{ Bindings: Env; Variables: AppVars }>;

async function loadOwnedGallery(c: GalleryContext, id: string): Promise<{ row: GalleryRow; config: GitHubGalleryConfig } | null> {
  const row = await c.env.DB.prepare('SELECT * FROM image_galleries WHERE id = ?').bind(id).first<GalleryRow>();
  if (!row || row.user_id !== c.get('userId')) return null;
  const config = JSON.parse(await decryptString(row.config, c.env.ENCRYPTION_KEY)) as GitHubGalleryConfig;
  return { row, config };
}

function githubError(c: GalleryContext, error: unknown) {
  if (error instanceof GitHubGalleryError) return c.json({ error: error.message, code: error.code }, error.status as 401 | 403 | 404 | 429 | 502);
  return c.json({ error: 'GitHub 图库操作失败', code: 'GITHUB_UPSTREAM_FAILED' }, 502);
}

imageGalleries.get('/', async (c) => {
  const result = await c.env.DB.prepare('SELECT * FROM image_galleries WHERE user_id = ? ORDER BY created_at DESC').bind(c.get('userId')).all<GalleryRow>();
  const galleries = await Promise.all((result.results ?? []).map(async (row) => {
    const config = JSON.parse(await decryptString(row.config, c.env.ENCRYPTION_KEY)) as GitHubGalleryConfig;
    return toGallery(row, config);
  }));
  return c.json({ galleries });
});

imageGalleries.post('/test', async (c) => {
  const body = await c.req.json<SaveImageGalleryRequest>();
  const error = validate(body, true);
  if (error) return c.json({ error, code: 'INVALID_GALLERY_CONFIG' }, 400);
  try {
    const config: GitHubGalleryConfig = { token: body.token!.trim(), owner: body.owner.trim(), repo: body.repo.trim(), branch: body.branch.trim(), folder: normalizeFolder(body.folder) };
    return c.json(await checkGitHubGallery(config));
  } catch (err) {
    return githubError(c, err);
  }
});

imageGalleries.post('/', async (c) => {
  const body = await c.req.json<SaveImageGalleryRequest>();
  const error = validate(body, true);
  if (error) return c.json({ error, code: 'INVALID_GALLERY_CONFIG' }, 400);
  const config: GitHubGalleryConfig = { token: body.token!.trim(), owner: body.owner.trim(), repo: body.repo.trim(), branch: body.branch.trim(), folder: normalizeFolder(body.folder) };
  try {
    const check = await checkGitHubGallery(config);
    const now = Date.now();
    const row: GalleryRow = { id: crypto.randomUUID(), user_id: c.get('userId'), name: body.name.trim(), provider: 'github', config: await encryptString(JSON.stringify(config), c.env.ENCRYPTION_KEY), is_private: check.isPrivate ? 1 : 0, created_at: now, updated_at: now };
    await c.env.DB.prepare('INSERT INTO image_galleries (id, user_id, name, provider, config, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.user_id, row.name, row.provider, row.config, row.is_private, row.created_at, row.updated_at).run();
    return c.json({ gallery: toGallery(row, config) }, 201);
  } catch (err) {
    return githubError(c, err);
  }
});

imageGalleries.get('/:id', async (c) => {
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  return c.json({ gallery: toGallery(gallery.row, gallery.config) });
});

imageGalleries.patch('/:id', async (c) => {
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  const body = await c.req.json<Partial<SaveImageGalleryRequest>>();
  const merged = { ...publicConfig(gallery.config), ...body, name: body.name ?? gallery.row.name } as SaveImageGalleryRequest;
  const error = validate(merged, false);
  if (error) return c.json({ error, code: 'INVALID_GALLERY_CONFIG' }, 400);
  const config: GitHubGalleryConfig = { token: body.token?.trim() || gallery.config.token, owner: merged.owner.trim(), repo: merged.repo.trim(), branch: merged.branch.trim(), folder: normalizeFolder(merged.folder) };
  try {
    const check = await checkGitHubGallery(config);
    const updated: GalleryRow = { ...gallery.row, name: merged.name.trim(), config: await encryptString(JSON.stringify(config), c.env.ENCRYPTION_KEY), is_private: check.isPrivate ? 1 : 0, updated_at: Date.now() };
    await c.env.DB.prepare('UPDATE image_galleries SET name = ?, config = ?, is_private = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(updated.name, updated.config, updated.is_private, updated.updated_at, updated.id, updated.user_id).run();
    return c.json({ gallery: toGallery(updated, config) });
  } catch (err) {
    return githubError(c, err);
  }
});

imageGalleries.delete('/:id', async (c) => {
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  await c.env.DB.prepare('DELETE FROM image_galleries WHERE id = ? AND user_id = ?').bind(gallery.row.id, gallery.row.user_id).run();
  return c.json({ ok: true, remoteImagesPreserved: true });
});

imageGalleries.post('/:id/images', async (c) => {
  const contentType = (c.req.header('content-type') ?? '').split(';')[0].toLowerCase();
  const extension = IMAGE_TYPES[contentType];
  if (!extension) return c.json({ error: '不支持的图片类型', code: 'UNSUPPORTED_IMAGE_TYPE' }, 400);
  const declaredLength = Number(c.req.header('content-length') ?? 0);
  if (declaredLength > MAX_IMAGE_SIZE) return c.json({ error: '图片超过 20 MiB', code: 'IMAGE_TOO_LARGE' }, 413);
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  const content = new Uint8Array(await c.req.arrayBuffer());
  if (content.byteLength > MAX_IMAGE_SIZE) return c.json({ error: '图片超过 20 MiB', code: 'IMAGE_TOO_LARGE' }, 413);
  const now = new Date();
  const path = `${gallery.config.folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${extension}`;
  try {
    await uploadGitHubImage(gallery.config, path, content);
    const isPrivate = gallery.row.is_private === 1;
    const markdownUrl = isPrivate
      ? `synx-image://${gallery.row.id}/${path.split('/').map(encodeURIComponent).join('/')}`
      : `https://raw.githubusercontent.com/${encodeURIComponent(gallery.config.owner)}/${encodeURIComponent(gallery.config.repo)}/${encodeURIComponent(gallery.config.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    return c.json({ image: { galleryId: gallery.row.id, path, visibility: isPrivate ? 'private' : 'public', markdownUrl } }, 201);
  } catch (err) {
    return githubError(c, err);
  }
});

imageGalleries.post('/:id/orphans/scan', async (c) => {
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  const body = await c.req.json<{ referencedPaths?: string[] }>();
  const referenced = new Set(body.referencedPaths ?? []);
  try {
    const files = await listGitHubGalleryFiles(gallery.config);
    const protectedAfter = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const images = files.flatMap((file) => {
      const match = file.path.match(/\/(\d{4})\/(\d{2})\/([0-9a-f-]+)\.(png|jpg|gif|webp|svg|avif)$/i);
      if (!match || referenced.has(file.path)) return [];
      const uploadedAt = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
      return uploadedAt >= protectedAfter ? [] : [{ ...file, uploadedAt }];
    });
    return c.json({ images });
  } catch (err) { return githubError(c, err); }
});

imageGalleries.post('/:id/orphans/delete', async (c) => {
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  const body = await c.req.json<{ images?: Array<{ path: string; sha: string }> }>();
  try {
    const latest = new Map((await listGitHubGalleryFiles(gallery.config)).map((file) => [file.path, file]));
    for (const image of body.images ?? []) {
      const synxPath = image.path.match(/\/(\d{4})\/(\d{2})\/([0-9a-f-]+)\.(png|jpg|gif|webp|svg|avif)$/i);
      if (!image.path.startsWith(`${gallery.config.folder}/`) || !synxPath || latest.get(image.path)?.sha !== image.sha) return c.json({ error: '图片已变化，请重新扫描', code: 'IMAGE_CHANGED' }, 409);
    }
    for (const image of body.images ?? []) await deleteGitHubGalleryFile(gallery.config, image.path, image.sha);
    return c.json({ deleted: (body.images ?? []).map((image) => image.path) });
  } catch (err) { return githubError(c, err); }
});

imageGalleries.get('/:id/images/content', async (c) => {
  const gallery = await loadOwnedGallery(c, c.req.param('id'));
  if (!gallery) return c.json({ error: '图库不存在', code: 'GALLERY_NOT_FOUND' }, 404);
  const path = c.req.query('path') ?? '';
  if (!path.startsWith(`${gallery.config.folder}/`) || path.split('/').some((part) => part === '..')) return c.json({ error: '图片路径无效', code: 'INVALID_IMAGE_PATH' }, 400);
  try {
    const response = await readGitHubImage(gallery.config, path);
    return new Response(response.body, { status: 200, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=300' } });
  } catch (err) {
    return githubError(c, err);
  }
});
