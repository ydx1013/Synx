import { describe, it, expect } from 'vitest';
import app from './index.js';
import { makeEnv } from './test/helpers.js';

// ASSETS mock：未放行的 Origin 会穿过 CORS 中间件落到 app.all('*') 回退
const envWithAssets = {
  ...makeEnv(),
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
} as unknown as Parameters<typeof app.request>[2];

function preflight(origin: string) {
  return {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  };
}

describe('CORS /api/*', () => {
  // 回归：移动端（Obsidian iOS/Android Capacitor）的 Origin 是 capacitor://localhost，
  // 此前只放行桌面端 app://obsidian.md，导致移动端登录被浏览器拦截（iOS 显示 "Load failed"）。
  it.each([
    ['app://obsidian.md', 'app://obsidian.md'],
    ['capacitor://localhost', 'capacitor://localhost'],
    ['http://localhost', 'http://localhost'],
  ])('allows Obsidian origin %s', async (origin, expected) => {
    const res = await app.request('/api/auth/login', preflight(origin), envWithAssets);
    expect(res.headers.get('access-control-allow-origin')).toBe(expected);
    expect(res.status).toBe(204);
  });

  it('does not allow unknown origins', async () => {
    const res = await app.request('/api/auth/login', preflight('https://evil.example.com'), envWithAssets);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
