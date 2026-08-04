import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageGalleries } from './imageGalleries.js';
import { signJwt } from '../auth/jwt.js';
import { encryptString } from '../auth/crypto.js';
import { makeD1Mock, makeEnv, makeKvMock } from '../test/helpers.js';
import type { AppVars, Env } from '../types.js';

const SECRET = 'test-jwt-secret-min-32-characters-pls!';
const USER = 'user-1';
const config = { token: 'secret', owner: 'alice', repo: 'images', branch: 'main', folder: 'uploads' };

async function authHeader() {
  return { Authorization: `Bearer ${await signJwt({ sub: USER }, SECRET)}` };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
  app.route('/api/image-galleries', imageGalleries);
  return app;
}

afterEach(() => vi.unstubAllGlobals());

describe('image gallery routes', () => {
  it('creates a gallery without returning its token', async () => {
    const db = makeD1Mock();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ private: false, permissions: { push: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'main' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await makeApp().request('/api/image-galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ name: '公开图库', ...config }),
    }, makeEnv({ DB: db, KV: makeKvMock() }));

    expect(response.status).toBe(201);
    const body = await response.json<any>();
    expect(body.gallery).toMatchObject({ name: '公开图库', owner: 'alice', repo: 'images', isPrivate: false, hasToken: true });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('uploads an image and returns a public raw URL', async () => {
    const encrypted = await encryptString(JSON.stringify(config), 'test-encryption-key');
    const row = { id: 'g1', user_id: USER, name: '图库', provider: 'github', config: encrypted, is_private: 0, created_at: 1, updated_at: 1 };
    const db = makeD1Mock({ first: row });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: { sha: 'abc' } }), { status: 201 })));

    const response = await makeApp().request('/api/image-galleries/g1/images', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Image-Extension': 'png', ...(await authHeader()) },
      body: new Uint8Array([1, 2, 3]),
    }, makeEnv({ DB: db, KV: makeKvMock() }));

    expect(response.status).toBe(201);
    const body = await response.json<any>();
    expect(body.image.visibility).toBe('public');
    expect(body.image.path).toMatch(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
    expect(body.image.markdownUrl).toContain('https://raw.githubusercontent.com/alice/images/main/uploads/');
  });

  it('rejects uploads outside the supported image types', async () => {
    const response = await makeApp().request('/api/image-galleries/g1/images', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Image-Extension': 'txt', ...(await authHeader()) },
      body: 'not image',
    }, makeEnv());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' });
  });
});
