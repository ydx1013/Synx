import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// 模拟生产环境：带扩展名的路径（如 Obsidian 分享链接 /会议记录.md）由
// Cloudflare Assets SPA 回退返回 index.html，浏览器加载后由 CatchAll 转为 /notes?path=…
const indexHtml = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

const FILES = [
  { path: '笔记/会议记录.md', fileUuid: '11111111-1111-4111-8111-111111111111', versionId: 'v1', mtime: 1700000000000, size: 10, hash: 'h1' },
  { path: '未命名.md', fileUuid: '22222222-2222-4222-8222-222222222222', versionId: 'v2', mtime: 1700000001000, size: 10, hash: 'h2' },
];

const CONTENTS = {
  '笔记/会议记录.md': '# 会议记录',
  '未命名.md': '## 备忘',
};

test('Obsidian 发布链接（/笔记名.md）能重定向并打开对应笔记', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('synx-token', 'browser-token');
    localStorage.setItem('synx-user', JSON.stringify({ id: 'user-1', username: 'browser-user' }));
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/auth/me' && request.method() === 'GET') {
      await route.fulfill({ json: { user: { id: 'user-1', username: 'browser-user' }, preferences: { defaultStorageId: 's1', defaultSyncFolder: 'my-vault/' } } });
      return;
    }
    if (pathname === '/api/list' && request.method() === 'GET') {
      await route.fulfill({ json: { files: FILES } });
      return;
    }
    if (pathname === '/api/get' && request.method() === 'GET') {
      const filePath = url.searchParams.get('path') || '';
      await route.fulfill({ json: { content: Buffer.from(CONTENTS[filePath] ?? '# 空', 'utf8').toString('base64') } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  // 模拟 Cloudflare Assets SPA 回退：所有 .md 路径都返回 index.html
  await page.route(/\.md$/, route => route.fulfill({ status: 200, contentType: 'text/html', body: indexHtml }));

  // 1) 根目录笔记 /未命名.md：精确匹配
  await page.goto('/未命名.md');
  await expect(page).toHaveURL(/\/notes\?path=/);
  await expect(page.locator('.markdown-body h2')).toHaveText('备忘');

  // 2) 只有文件名、实际在子文件夹的笔记 /会议记录.md：按文件名匹配
  await page.goto('/会议记录.md');
  await expect(page).toHaveURL(/\/notes\?path=/);
  await expect(page.locator('.markdown-body h1')).toHaveText('会议记录');
  await expect(page.locator('.note-item.active')).toContainText('会议记录');
});
