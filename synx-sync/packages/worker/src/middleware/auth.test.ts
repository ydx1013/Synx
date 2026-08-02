import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import { authMiddleware } from './auth.js';
import { signJwt } from '../auth/jwt.js';
import type { Env, AppVars } from '../types.js';

const SECRET = 'test-jwt-secret-min-32-characters-pls!';

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
  app.use('*', authMiddleware);
  app.get('/protected', (c) => c.json({ userId: c.get('userId') }));
  return app;
}

const env = { JWT_SECRET: SECRET } as unknown as Env;

describe('authMiddleware', () => {
  it('returns 401 when Authorization header missing', async () => {
    const res = await makeApp().request('/protected', {}, env);
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization not Bearer', async () => {
    const res = await makeApp().request('/protected', { headers: { Authorization: 'Basic abc' } }, env);
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid token', async () => {
    const res = await makeApp().request('/protected', { headers: { Authorization: 'Bearer nope' } }, env);
    expect(res.status).toBe(401);
  });

  it('injects userId and calls downstream on valid token', async () => {
    const token = await signJwt({ sub: 'user-42' }, SECRET);
    const res = await makeApp().request('/protected', { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user-42' });
  });
});
