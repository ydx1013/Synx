import { expect, test } from '@playwright/test';

const FILES = [
  { path: '笔记/会议记录.md', fileUuid: '11111111-1111-4111-8111-111111111111', versionId: 'v1', mtime: 1700000000000, size: 10, hash: 'h1' },
  { path: '未命名.md', fileUuid: '22222222-2222-4222-8222-222222222222', versionId: 'v2', mtime: 1700000001000, size: 10, hash: 'h2' },
];

const CONTENTS = {
  '笔记/会议记录.md': '<!-- synx-id:11111111-1111-4111-8111-111111111111 -->\n# 会议记录\n\n- [ ] 待办事项A\n\n```js\nconst a = 1;\n```\n\n![[图片.png]]\n\n[[未命名]]\n\n<span style="color:red">红色文本</span>',
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

  // 目录树展示层级文件夹（仅一个顶层文件夹 笔记）
  await expect(page.locator('.folder-item')).toContainText('笔记');

  // 打开笔记 → 阅读模式渲染 Markdown
  await page.click('.note-item:has-text("会议记录")');
  await expect(page.locator('.markdown-body h1')).toHaveText('会议记录');
  await expect(page.locator('.markdown-body input[type="checkbox"]')).toHaveCount(1);
  await expect(page.locator('.markdown-body pre code')).toContainText('const a = 1');

  // 笔记中的 HTML 被正确解析渲染（span 保留样式）
  await expect(page.locator('.markdown-body span[style]')).toContainText('红色文本');

  // [[双向链接]] 渲染为可点击链接
  await expect(page.locator('.markdown-body a[data-wikilink]:has-text("未命名")')).toHaveText('未命名');

  // 切换编辑 → CodeMirror 出现并输入
  await page.getByRole('button', { name: '编辑' }).click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('\n补充内容');
  await expect(page.locator('.cm-content')).toContainText('补充内容');
  await expect(page.locator('.cm-content')).not.toContainText('synx-id');
  await expect(page.locator('.document-title')).toContainText('未保存');

  // 保存 → 携带 baseVersionId，且 UUID 标记写回远端内容
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.document-title')).toContainText('已保存');
  expect(putBodies.length).toBeGreaterThan(0);
  const last = putBodies[putBodies.length - 1];
  expect(last.path).toBe('笔记/会议记录.md');
  expect(last.fileUuid).toBe('11111111-1111-4111-8111-111111111111');
  expect(last.baseVersionId).toBe('v1');
  expect(Buffer.from(last.content, 'base64').toString('utf8')).toContain('synx-id:11111111-1111-4111-8111-111111111111');

  // 历史面板
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.history-drawer li')).toHaveCount(2);
  await expect(page.locator('.history-drawer .default-tag')).toContainText('当前');

  // URL 定位：打开笔记后 ?path= 已写入
  await expect(page).toHaveURL(/path=%E7%AC%94%E8%AE%B0%2F%E4%BC%9A%E8%AE%AE%E8%AE%B0%E5%BD%95\.md/);

  // 刷新后仍停留在同一篇笔记（无需重新查找）
  await page.reload();
  await expect(page.locator('.markdown-body h1')).toHaveText('会议记录');
  await expect(page.locator('.note-item.active')).toContainText('会议记录');

  // [[双向链接]] 点击跳转到对应笔记
  await page.locator('.markdown-body a[data-wikilink]:has-text("未命名")').click();
  await expect(page.locator('.markdown-body h2')).toHaveText('备忘');
  await expect(page.locator('.document-title')).toContainText('未命名');

  // ?path= 直达：根目录精确匹配（Obsidian 分享链接被 CatchAll 转成该形式）
  await page.goto('/notes?path=' + encodeURIComponent('未命名.md'));
  await expect(page.locator('.markdown-body h2')).toHaveText('备忘');
  await expect(page.locator('.note-item.active')).toContainText('未命名');

  // ?path= 只有文件名、实际路径在 笔记/ 下 → 按文件名匹配打开
  await page.goto('/notes?path=' + encodeURIComponent('会议记录.md'));
  await expect(page.locator('.markdown-body h1')).toHaveText('会议记录');
  await expect(page.locator('.note-item.active')).toContainText('会议记录');
});
