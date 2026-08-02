import { expect, test } from '@playwright/test';

const FILES = [
  { path: '笔记/会议记录.md', fileUuid: '11111111-1111-4111-8111-111111111111', versionId: 'v1', mtime: 1700000000000, size: 10, hash: 'h1' },
  { path: '未命名.md', fileUuid: '22222222-2222-4222-8222-222222222222', versionId: 'v2', mtime: 1700000001000, size: 10, hash: 'h2' },
];

const CONTENTS = {
  '笔记/会议记录.md': '# 会议记录\n\n- [ ] 待办事项A\n\n```js\nconst a = 1;\n```\n\n![[图片.png]]',
  '未命名.md': '## 备忘\n\n**重要**内容',
};

const HISTORIES = {
  '笔记/会议记录.md': [
    { versionId: 'v1', size: 10, isCurrent: true, author: 'web', createdAt: 1700000000000 },
    { versionId: 'v0', size: 8, isCurrent: false, author: 'obsidian', createdAt: 1699999999000 },
  ],
};

test('笔记应用加载、渲染 Markdown、编辑并携带 baseVersionId 保存', async ({ page }) => {
  const putBodies = [];

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
      await route.fulfill({ json: { content: Buffer.from(content, 'utf8').toString('base64') } });
      return;
    }
    if (pathname === '/api/history' && request.method() === 'GET') {
      const filePath = url.searchParams.get('path') || '';
      await route.fulfill({ json: { versions: HISTORIES[filePath] ?? [] } });
      return;
    }
    if (pathname === '/api/put' && request.method() === 'POST') {
      putBodies.push(request.postDataJSON());
      await route.fulfill({ json: { version: { versionId: 'v-new', size: 16, mtime: Date.now(), hash: 'h-new', author: 'web' } } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  await page.goto('/notes');

  // 笔记列表加载（默认存储已设置为 s1）
  await expect(page.locator('.note-item')).toHaveCount(2);

  // 打开笔记 → 阅读模式渲染 Markdown
  await page.click('.note-item:has-text("会议记录")');
  await expect(page.locator('.markdown-body h1')).toHaveText('会议记录');
  await expect(page.locator('.markdown-body input[type="checkbox"]')).toHaveCount(1);
  await expect(page.locator('.markdown-body pre code')).toContainText('const a = 1');

  // 切换编辑 → CodeMirror 出现并输入
  await page.getByRole('button', { name: '编辑' }).click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('\n补充内容');
  await expect(page.locator('.cm-content')).toContainText('补充内容');
  await expect(page.locator('.document-title')).toContainText('未保存');

  // 保存 → 携带 baseVersionId
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.document-title')).toContainText('已保存');
  expect(putBodies.length).toBeGreaterThan(0);
  const last = putBodies[putBodies.length - 1];
  expect(last.path).toBe('笔记/会议记录.md');
  expect(last.fileUuid).toBe('11111111-1111-4111-8111-111111111111');
  expect(last.baseVersionId).toBe('v1');

  // 历史面板
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.history-drawer li')).toHaveCount(2);
  await expect(page.locator('.history-drawer .default-tag')).toContainText('当前');
});
