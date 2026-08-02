import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AppVars } from './types.js';
import { auth } from './routes/auth.js';
import { history } from './routes/history.js';
import { onedrive } from './routes/onedrive.js';
import { storage } from './routes/storage.js';
import { sync } from './routes/sync.js';

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

app.use('/api/*', cors({
  origin: (origin) => origin === 'app://obsidian.md' ? origin : '',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Storage-Id', 'X-Sync-Folder'],
}));

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/api/auth', auth);
app.route('/api/storage', storage);
app.route('/api/onedrive', onedrive);
app.route('/api', sync);
app.route('/api', history);

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

