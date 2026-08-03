import { expect, test } from '@playwright/test';

// 模拟大量笔记（含根目录 + 多层文件夹），验证三栏各自滚动而非整页滚动
const FILES = Array.from({ length: 80 }, (_, i) => ({
  path: `文件夹${String(i % 40).padStart(2, '0')}/子文件夹${String(Math.floor(i / 40)).padStart(2, '0')}/笔记${String(i).padStart(2, '0')}.md`,
  fileUuid: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
  versionId: `v${i}`,
  mtime: 1700000000000 + i,
  size: 10,
  hash: `h${i}`,
}));
FILES.push({ path: '根目录笔记.md', fileUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', versionId: 'v-root', mtime: 1700000002000, size: 20, hash: 'h-root' });

const LONG_CONTENT = `# 长笔记\n\n${Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 段：这是一段足够长的正文内容，用于验证编辑器区域可以独立滚动。\n`).join('')}`;

test('左侧文件夹树、中栏笔记列表、右侧编辑器内容均可独立滚动', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('synx-token', 'browser-token');
    localStorage.setItem('synx-user', JSON.stringify({ id: 'user-1', username: 'browser-user' }));
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/me' && request.method() === 'GET') {
      await route.fulfill({ json: { user: { id: 'user-1', username: 'browser-user' }, preferences: { defaultStorageId: 's1', defaultSyncFolder: 'my-vault/' } } });
      return;
    }
    if (url.pathname === '/api/list' && request.method() === 'GET') {
      await route.fulfill({ json: { files: FILES } });
      return;
    }
    if (url.pathname === '/api/get' && request.method() === 'GET') {
      await route.fulfill({ body: Buffer.from(LONG_CONTENT, 'utf8'), headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Synx-Version': JSON.stringify({ versionId: 'v1', size: LONG_CONTENT.length, mtime: 1700000000000, hash: 'h1', author: 'web' }) } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  await page.goto('/notes');
  await expect(page.locator('.note-item')).toHaveCount(81);

  // 中栏笔记列表可滚动（内容超出可视区）
  const list = page.locator('.note-list');
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator('.note-item:has-text("笔记59")')).toBeVisible();

  // 左侧根目录笔记入口可见
  await expect(page.locator('.root-note:has-text("根目录笔记")')).toBeVisible();

  // 打开根目录笔记 → 编辑器内容可滚动
  await page.locator('.root-note:has-text("根目录笔记")').click();
  const editor = page.locator('.editor-content');
  await expect(page.locator('.markdown-body h1')).toHaveText('长笔记');
  await expect.poll(() => editor.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await editor.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator('.markdown-body')).toContainText('第 300 段');

  // 左侧导航区域（含文件夹树）可滚动
  const nav = page.locator('.primary-nav');
  await expect.poll(() => nav.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await nav.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator('.folder-item:has-text("文件夹39")')).toBeVisible();
});
