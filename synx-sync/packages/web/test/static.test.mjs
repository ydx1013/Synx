import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function page(name) {
  return readFile(new URL(name, root), 'utf8');
}

test('提供计划要求的纯 HTML 页面和共享静态资源', async () => {
  for (const name of ['index.html', 'register.html', 'login.html', 'dashboard.html', 'storage_new.html']) {
    const html = await page(name);
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /assets\/styles\.css/);
  }

  await readFile(new URL('assets/app.js', root), 'utf8');
  await readFile(new URL('assets/storage.js', root), 'utf8');
});

test('认证页面具有可访问表单和页面脚本入口', async () => {
  const register = await page('register.html');
  assert.match(register, /<form[^>]+id="register-form"/);
  assert.match(register, /name="username"/);
  assert.match(register, /name="email"/);
  assert.match(register, /name="password"/);

  const login = await page('login.html');
  assert.match(login, /<form[^>]+id="login-form"/);
  assert.match(login, /name="usernameOrEmail"/);
  assert.match(login, /name="password"/);
});

test('WebDAV 页面区分保存与连接测试并固定 Basic 认证', async () => {
  const storage = await page('storage_new.html');
  for (const name of ['name', 'address', 'username', 'password', 'remoteBaseDir', 'customHeaders']) {
    assert.match(storage, new RegExp(`name="${name}"`));
  }
  assert.match(storage, /type="submit">保存配置/);
  assert.match(storage, /id="test-connection"[^>]+type="button">检查连接/);
  assert.doesNotMatch(storage, /Digest/i);
});

test('控制台提供新增、编辑和仅移除 Synx 元数据的入口', async () => {
  const dashboard = await page('dashboard.html');
  const storageScript = await page('assets/storage.js');
  assert.match(dashboard, /href="storage_new\.html"/);
  assert.match(dashboard, /id="storage-list"/);
  assert.match(storageScript, /method: 'DELETE'/);
  assert.match(storageScript, /WebDAV 文件已保留/);
  assert.match(storageScript, /deletedVersions/);
  assert.doesNotMatch(storageScript, /deletedObjects/);
});

test('提供可运行的浏览器 CRUD 验收资产', async () => {
  const packageJson = JSON.parse(await page('package.json'));
  assert.equal(packageJson.scripts['test:browser'], 'playwright test');
  await readFile(new URL('playwright.config.mjs', root), 'utf8');
  const spec = await page('test/browser-crud.spec.mjs');
  assert.match(spec, /注册/);
  assert.match(spec, /新增/);
  assert.match(spec, /编辑/);
  assert.match(spec, /删除/);
});

test('笔记应用提供印象笔记风格三栏布局并引用已构建的 bundle', async () => {
  const notes = await page('notes.html');
  assert.match(notes, /<!doctype html>/i);
  assert.match(notes, /assets\/styles\.css/);
  assert.match(notes, /id="folder-tree"/);
  assert.match(notes, /id="note-list"/);
  assert.match(notes, /id="editor-container"/);
  assert.match(notes, /id="history-panel"/);
  assert.match(notes, /assets\/dist\/notes\.bundle\.js/);

  const bundle = await readFile(new URL('assets/dist/notes.bundle.js', root), 'utf8');
  assert.match(bundle, /markdown-it/i);
  assert.ok(bundle.includes('markdown-body'), 'bundle 应包含 Markdown 渲染逻辑');
  assert.ok(bundle.includes('/api/put'), 'bundle 应包含保存接口调用');
  assert.ok(bundle.includes('baseVersionId'), 'bundle 应携带并发保护版本号');
  assert.ok(bundle.includes('/api/history'), 'bundle 应包含历史接口调用');
  assert.ok(bundle.includes('/api/rollback'), 'bundle 应包含回滚接口调用');
});
