import { expect, test } from '@playwright/test';

const FILES = [
  { path: '笔记/会议记录.md', fileUuid: '11111111-1111-4111-8111-111111111111', versionId: 'v1', mtime: 1700000000000, size: 10, hash: 'h1' },
  { path: '未命名.md', fileUuid: '22222222-2222-4222-8222-222222222222', versionId: 'v2', mtime: 1700000001000, size: 10, hash: 'h2' },
];

const CONTENTS = {
  '笔记/会议记录.md': '<!-- synx-id:11111111-1111-4111-8111-111111111111 -->\n# 会议记录\n\n[[未命名]]',
  '未命名.md': '## 备忘\n\n**重要**内容',
};

const HISTORIES = {};

async function mockApi(page) {
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
      const content = CONTENTS[filePath] ?? '# 空';
      await route.fulfill({ body: Buffer.from(content, 'utf8'), headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Synx-Version': JSON.stringify({ versionId: 'v1', size: content.length, mtime: 1700000000000, hash: 'h1', author: 'web' }) } });
      return;
    }
    if (pathname === '/api/history' && request.method() === 'GET') {
      await route.fulfill({ json: { versions: HISTORIES[filePath] ?? [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

test.use({ viewport: { width: 375, height: 667 } });

test('移动端：更多菜单不溢出、抽屉跳转正确、删除弹窗为底部面板', async ({ page }) => {
  await mockApi(page);
  await page.goto('/notes');

  // 打开笔记 → 编辑器
  await page.click('.note-item:has-text("会议记录")');
  await expect(page.locator('.editor-pane')).toBeVisible();

  // 更多菜单可见
  await page.getByRole('button', { name: '更多操作' }).click();
  const renameItem = page.getByRole('menuitem', { name: '重命名' });
  const deleteItem = page.getByRole('menuitem', { name: '删除' });
  await expect(renameItem).toBeVisible();
  await expect(deleteItem).toBeVisible();

  // 菜单项不溢出视口右缘
  const deleteBox = await deleteItem.boundingBox();
  expect(deleteBox.x + deleteBox.width).toBeLessThanOrEqual(376);

  // 删除 → 弹窗为手机底部面板
  await deleteItem.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialogBox = await page.getByRole('dialog').boundingBox();
  expect(dialogBox.y + dialogBox.height).toBeGreaterThanOrEqual(665);
  await page.getByRole('button', { name: '取消' }).click();

  // 返回列表
  await page.locator('.mobile-back').click();
  await expect(page.locator('.note-list-pane')).toBeVisible();

  // 抽屉中点击根笔记 → 应关闭抽屉并进入编辑器
  await page.locator('.menu-button').click();
  await expect(page.locator('.primary-sidebar')).toBeVisible();
  await page.locator('.root-note:has-text("未命名")').click();
  await expect(page.locator('.editor-pane')).toBeVisible();
  await expect(page.locator('.nav-open')).not.toBeVisible();
  await expect(page.locator('.document-title')).toContainText('未命名');

  // 返回列表后，?path= 应被清除，从设置返回不会强制打开编辑器
  await page.locator('.mobile-back').click();
  await expect(page.locator('.note-list-pane')).toBeVisible();
  await expect(page).not.toHaveURL(/path=/);
});
