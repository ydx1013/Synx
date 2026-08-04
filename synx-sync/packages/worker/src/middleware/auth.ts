import type { Context, Next } from 'hono';
import { verifyJwt } from '../auth/jwt.js';
import type { Env, AppVars } from '../types.js';

/** JWT 校验中间件：从 Authorization header 校验，注入 userId。
 *  对图片内容端点（GET /images/content）额外支持 ?token= query 参数，用于 <img src> 场景。 */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: AppVars }>, next: Next) {
  const auth = c.req.header('Authorization') ?? '';
  let match = auth.match(/^Bearer\s+(.+)$/);
  // 图片内容端点支持 query 参数 token（<img src> 无法携带 Authorization 头）
  if (!match && c.req.method === 'GET' && c.req.path.includes('/images/content')) {
    const queryToken = c.req.query('token');
    if (queryToken) match = ['', queryToken];
  }
  if (!match) return c.json({ error: 'missing or malformed Authorization header' }, 401);
  const payload = await verifyJwt(match[1], c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'invalid or expired token' }, 401);
  c.set('userId', payload.sub);
  await next();
}
