import type { Context, Next } from 'hono';
import { verifyJwt } from '../auth/jwt.js';
import type { Env, AppVars } from '../types.js';

/** JWT 校验中间件：从 Authorization header 校验，注入 userId */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: AppVars }>, next: Next) {
  const auth = c.req.header('Authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return c.json({ error: 'missing or malformed Authorization header' }, 401);
  const payload = await verifyJwt(match[1], c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'invalid or expired token' }, 401);
  c.set('userId', payload.sub);
  await next();
}
