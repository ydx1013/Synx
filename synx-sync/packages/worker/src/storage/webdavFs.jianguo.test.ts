import { describe, it, expect } from 'vitest';
import type { WebdavConfig } from '@synx/shared';
import { WebDAVFs } from './webdavFs.js';
import { checkConnectivity } from './connectivity.js';

declare const process: { env: Record<string, string | undefined> };

/**
 * 坚果云 WebDAV 真实联调集成测试。
 *
 * 默认跳过；仅当环境变量 SYNX_E2E_WEBDAV=1 时运行：
 *   SYNX_E2E_WEBDAV=1
 *   SYNX_WEBDAV_ADDRESS=https://dav.jianguoyun.com/dav/
 *   SYNX_WEBDAV_USER=<账号>
 *   SYNX_WEBDAV_PASS=<应用密码>
 *
 * 用独立 remoteBaseDir=synx-e2e-test 隔离，结束后清理。
 * 不 mock fetch，直接打真实坚果云。
 */
const enabled = process.env.SYNX_E2E_WEBDAV === '1';

describe.skipIf(!enabled)('WebDAVFs 真实坚果云联调', () => {
  const address = process.env.SYNX_WEBDAV_ADDRESS || '';
  const username = process.env.SYNX_WEBDAV_USER || '';
  const password = process.env.SYNX_WEBDAV_PASS || '';
  const remoteBaseDir = `synx-e2e-test-${Date.now()}-${crypto.randomUUID()}`;

  const config: WebdavConfig = {
    address,
    username,
    password,
    authType: 'basic',
    remoteBaseDir,
  };

  // 共享一份 Fs 实例；测试间状态可见
  let fs: WebDAVFs;
  let basicAuth: string;

  it('构建 Fs 实例与 Basic auth 头', () => {
    expect(address).toBeTruthy();
    expect(username).toBeTruthy();
    expect(password).toBeTruthy();
    fs = new WebDAVFs(config);
    basicAuth = `Basic ${btoa(`${username}:${password}`)}`;
    expect(fs).toBeDefined();
  });

  it('跑通 checkConnectivity 五段式（list→put→overwrite→get→校验→delete）', async () => {
    const result = await checkConnectivity(fs);
    expect(result).toEqual({ ok: true });
  });

  it('PUT 一个已知文件后，PROPFIND 能在坚果云侧看到它', async () => {
    const key = 'landing-check.md';
    const content = new TextEncoder().encode('hello jianguoyun e2e');
    await fs.put(key, content);

    // 直接 PROPFIND 坚果云，确认对象真的落地（不经 D1，纯 WebDAV）
    const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:resourcetype/></D:prop>
</D:propfind>`;
    const url = `${address.replace(/\/+$/, '')}/${remoteBaseDir}/`;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: basicAuth,
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: propfindBody,
    });
    expect(res.ok).toBe(true);
    const xml = await res.text();
    expect(xml).toContain('landing-check.md');

    // 清理
    await fs.delete(key);
  });

  it('DELETE 后 PROPFIND 不再含该文件', async () => {
    const key = 'cleanup-check.md';
    await fs.put(key, new TextEncoder().encode('to be deleted'));
    await fs.delete(key);

    const url = `${address.replace(/\/+$/, '')}/${remoteBaseDir}/`;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: basicAuth,
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
    });
    const xml = await res.text();
    expect(xml).not.toContain('cleanup-check.md');
  });
});

