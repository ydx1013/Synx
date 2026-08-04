import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AppVars } from './types.js';
import { auth } from './routes/auth.js';
import { inbox } from './routes/inbox.js';
import { onedrive } from './routes/onedrive.js';
import { repository } from './routes/repository.js';
import { storage } from './routes/storage.js';
import { tokens } from './routes/tokens.js';

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

// Obsidian 各端点的请求 Origin：
// - 桌面端 app://obsidian.md
// - 移动端（iOS/Android Capacitor）capacitor://localhost，部分 Android 环境为 http://localhost
// 只放行这些受信 Origin；其他来源一律不加 CORS 头（浏览器会拦截响应）。
const OBSIDIAN_ORIGINS = new Set(['app://obsidian.md', 'capacitor://localhost', 'http://localhost']);

// 请求日志：为每个 API 请求生成关联 ID，记录方法/路径/状态码/耗时（结构化单行 JSON）。
// 刻意不记录请求体、Authorization 头等敏感信息，避免 token 泄露进日志。
app.use('/api/*', async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('requestId', requestId);
  const startedAt = Date.now();
  await next();
  // 响应头回传 requestId，便于客户端在日志中按 ID 精确关联错误
  c.header('x-request-id', requestId);
  console.log(JSON.stringify({
    event: 'http_request',
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    elapsedMs: Date.now() - startedAt,
  }));
});

// 全局错误处理：任何路由/中间件未捕获的异常统一转 500，
// 并记录完整堆栈（结构化），便于用 wrangler tail 定位生产错误。
app.onError((err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  c.header('x-request-id', requestId);
  console.error(JSON.stringify({
    event: 'http_error',
    requestId,
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }));
  return c.json({ error: 'internal error', code: 'INTERNAL_ERROR' }, 500);
});

app.use('/api/*', cors({
  origin: (origin) => (origin && OBSIDIAN_ORIGINS.has(origin) ? origin : ''),
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Storage-Id', 'X-Sync-Folder'],
  exposeHeaders: ['X-Synx-Version', 'X-Request-Id', 'Content-Length'],
}));

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/api/auth', auth);
app.route('/api/storage', storage);
app.route('/api/tokens', tokens);
app.route('/api/onedrive', onedrive);
app.route('/api/inbox', inbox);
app.route('/api/repository', repository);

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

