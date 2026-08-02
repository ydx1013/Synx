import { expect, test } from '@playwright/test';

test('添加 S3 兼容存储并显示类型徽标', async ({ page }) => {
  let created = null;

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
      await route.fulfill({ json: { storages: created ? [created] : [] } });
      return;
    }
    if (url.pathname === '/api/storage' && request.method() === 'POST') {
      const body = request.postDataJSON();
      created = { id: 'storage-s3', userId: 'user-1', name: body.name, type: body.type, config: { ...body.config }, createdAt: 1 };
      await route.fulfill({ status: 201, json: { storage: { ...created, config: null } } });
      return;
    }
    if (url.pathname === '/api/storage/test' && request.method() === 'POST') {
      await route.fulfill({ json: { ok: true } });
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

  await page.getByRole('link', { name: '前往设置' }).click();
  await page.getByRole('link', { name: '存储管理' }).click();
  await page.getByRole('link', { name: '添加存储' }).first().click();

  // 选择 S3 兼容类型 → 显示 S3 专属字段
  await page.locator('.type-option:has-text("S3 兼容")').click();
  await expect(page.getByLabel('Endpoint 地址')).toBeVisible();
  await expect(page.getByLabel('HTTPS 地址')).toHaveCount(0);

  await page.getByLabel('名称', { exact: true }).fill('我的 MinIO');
  await page.getByLabel('Endpoint 地址').fill('https://minio.example.com');
  await page.getByLabel('Bucket').fill('notes');
  await page.getByLabel('Region').fill('us-east-1');
  await page.getByLabel('Access Key').fill('minio-user');
  await page.getByLabel('Secret Key').fill('minio-secret');
  await page.locator('.checkbox-field input').check();
  await page.getByRole('button', { name: '保存配置' }).click();

  await expect(page).toHaveURL(/\/settings\/storage$/);
  await expect(page.getByRole('heading', { name: '我的 MinIO' })).toBeVisible();
  await expect(page.locator('.storage-card', { hasText: '我的 MinIO' })).toContainText('S3 兼容');

  // 确认 POST 请求带 type=s3 与 pathStyle
  expect(created.type).toBe('s3');
  expect(created.config.pathStyle).toBe(true);
  expect(created.config.endpoint).toBe('https://minio.example.com');
});
