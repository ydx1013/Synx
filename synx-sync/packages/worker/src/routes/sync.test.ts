import { describe, it, expect } from 'vitest';
import app from '../index.js';
import { makeEnv } from '../test/helpers.js';

// CORS 配置回归：Obsidian 各端点的请求 Origin：
// - 桌面端 app://obsidian.md
// - 移动端（iOS/Android Capacitor）capacitor://localhost，部分 Android 环境为 http://localhost
// 只放行这些受信 Origin；其他来源一律不加 CORS 头（浏览器会拦截响应）。
describe('CORS / OPTIONS /api/*', () => {
  it('responds to Obsidian preflight without authentication', async () => {
    const res = await app.request(
      '/api/repository/head',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'app://obsidian.md',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization, X-Storage-Id, X-Sync-Folder',
        },
      },
      makeEnv(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('app://obsidian.md');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Storage-Id');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Sync-Folder');
  });

  // 回归：移动端 Origin 此前未放行导致登录被 CORS 拦截（iOS 显示 "Load failed"）
  it.each(['app://obsidian.md', 'capacitor://localhost', 'http://localhost'])('allows %s', async (origin) => {
    const res = await app.request(
      '/api/repository/head',
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
        },
      },
      makeEnv(),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it('does not allow unknown origins', async () => {
    const res = await app.request(
      '/api/repository/head',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://unknown.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      },
      makeEnv(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
