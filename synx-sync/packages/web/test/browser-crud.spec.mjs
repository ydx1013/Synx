import { expect, test } from '@playwright/test';

test('浏览器完成注册、新增、编辑和删除 WebDAV', async ({ page }) => {
  const storage = {
    id: 'storage-1',
    userId: 'user-1',
    name: '浏览器 WebDAV',
    type: 'webdav',
    config: {
      address: 'https://dav.example.com/',
      username: 'browser-user',
      authType: 'basic',
      remoteBaseDir: 'notes',
    },
    createdAt: 1,
  };
  let created = false;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/register') {
      await route.fulfill({ status: 201, json: { token: 'browser-token', user: { id: 'user-1', username: 'browser-user' } } });
      return;
    }
    if (url.pathname === '/api/auth/me' && request.method() === 'GET') {
      await route.fulfill({ json: { user: { id: 'user-1', username: 'browser-user' }, preferences: { defaultStorageId: null, defaultSyncFolder: 'my-vault/' } } });
      return;
    }
    if (url.pathname === '/api/storage' && request.method() === 'GET') {
      await route.fulfill({ json: { storages: created ? [storage] : [] } });
      return;
    }
    if (url.pathname === '/api/storage' && request.method() === 'POST') {
      const body = request.postDataJSON();
      storage.name = body.name;
      storage.config = { ...body.config };
      delete storage.config.password;
      created = true;
      await route.fulfill({ status: 201, json: { storage: { ...storage, config: null } } });
      return;
    }
    if (url.pathname === `/api/storage/${storage.id}` && request.method() === 'GET') {
      await route.fulfill({ json: { storage } });
      return;
    }
    if (url.pathname === `/api/storage/${storage.id}` && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      storage.name = body.name;
      storage.config = { ...storage.config, ...body.config };
      await route.fulfill({ json: { storage } });
      return;
    }
    if (url.pathname === `/api/storage/${storage.id}` && request.method() === 'DELETE') {
      created = false;
      await route.fulfill({ json: { ok: true, deletedVersions: 0, remoteFilesPreserved: true } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  await page.goto('/register');
  await page.getByLabel('用户名').fill('browser-user');
  await page.getByLabel('邮箱').fill('browser@example.com');
  await page.getByLabel('密码').fill('browser-password');
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.locator('.center-state')).toContainText('设置你的默认存储');

  // 从笔记页进入设置 → 存储管理
  await page.getByRole('link', { name: '前往设置' }).click();
  await page.getByRole('link', { name: '存储管理' }).click();
  await expect(page.getByRole('heading', { name: '存储管理' })).toBeVisible();
  await expect(page.locator('.empty-settings')).toContainText('还没有远程存储');

  // 新增 WebDAV（默认存储类型）
  await page.getByRole('link', { name: '添加存储' }).first().click();
  await expect(page.getByRole('heading', { name: '添加存储' })).toBeVisible();
  await expect(page.locator('.storage-type-picker .type-option')).toHaveCount(3);
  await page.getByLabel('名称', { exact: true }).fill(storage.name);
  await page.getByLabel('HTTPS 地址').fill(storage.config.address);
  await page.getByLabel('用户名', { exact: true }).fill(storage.config.username);
  await page.getByLabel('应用密码').fill('browser-app-password');
  await page.getByLabel('远程目录').fill(storage.config.remoteBaseDir);
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page).toHaveURL(/\/settings\/storage$/);
  await expect(page.getByRole('heading', { name: storage.name })).toBeVisible();

  // 编辑
  await page.getByRole('link', { name: '编辑' }).click();
  await expect(page.getByRole('heading', { name: '编辑 WebDAV' })).toBeVisible();
  await page.getByLabel('名称', { exact: true }).fill('浏览器 WebDAV 已编辑');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page).toHaveURL(/\/settings\/storage$/);
  await expect(page.getByRole('heading', { name: '浏览器 WebDAV 已编辑' })).toBeVisible();

  // 移除
  await page.getByRole('button', { name: '移除' }).click();
  await expect(page.getByRole('dialog')).toContainText('WebDAV 中的文件不会被删除');
  await page.getByRole('button', { name: '确认移除' }).click();
  await expect(page.locator('.empty-settings')).toContainText('还没有远程存储');
});
