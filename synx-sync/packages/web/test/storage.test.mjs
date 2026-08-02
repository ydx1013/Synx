import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConnectivityRequest,
  buildWebdavConfig,
  buildStorageRequest,
  describeConnectivityResult,
  describeStorageDeletion,
} from '../assets/storage.js';

const fields = {
  name: '我的 WebDAV',
  address: 'https://dav.example.com/',
  username: 'user',
  password: 'app-password',
  remoteBaseDir: 'notes',
  customHeaders: 'X-Tenant: demo',
};

test('构造只使用 Basic Auth 的 WebDAV 配置', () => {
  assert.deepEqual(buildWebdavConfig(fields), {
    address: 'https://dav.example.com/',
    username: 'user',
    password: 'app-password',
    authType: 'basic',
    remoteBaseDir: 'notes',
    customHeaders: 'X-Tenant: demo',
  });
});

test('新增和编辑请求保持存储类型固定', () => {
  assert.equal(buildStorageRequest(fields, null).method, 'POST');
  assert.equal(buildStorageRequest(fields, null).body.type, 'webdav');
  assert.equal(buildStorageRequest(fields, 'storage-1').method, 'PATCH');
  assert.equal('type' in buildStorageRequest(fields, 'storage-1').body, false);
});

test('编辑时空密码不会进入更新请求', () => {
  const request = buildStorageRequest({ ...fields, password: '' }, 'storage-1');
  assert.equal('password' in request.body.config, false);
});

test('保存和连接测试使用互不依赖的请求契约', () => {
  assert.deepEqual(buildConnectivityRequest(fields, null), {
    type: 'webdav',
    config: buildWebdavConfig(fields),
  });
  assert.deepEqual(buildConnectivityRequest({ ...fields, password: '' }, 'storage-1'), {
    id: 'storage-1',
    config: {
      address: fields.address,
      username: fields.username,
      authType: 'basic',
      remoteBaseDir: fields.remoteBaseDir,
      customHeaders: fields.customHeaders,
    },
  });
});

test('连接结果转换为安全、明确的页面状态', () => {
  assert.deepEqual(describeConnectivityResult({ ok: true }), { kind: 'success', message: '连接测试通过' });
  assert.deepEqual(describeConnectivityResult({ error: '上传阶段失败', code: 'WEBDAV_CONNECTION_FAILED' }), {
    kind: 'error',
    message: '上传阶段失败',
  });
});

test('删除存储说明仅移除 Synx 配置和元数据并保留远端文件', () => {
  assert.equal(describeStorageDeletion('我的 WebDAV'), '从 Synx 中移除存储“我的 WebDAV”？WebDAV 中的文件不会被删除。');
  assert.equal(describeStorageDeletion({ remoteFilesPreserved: true, deletedVersions: 3 }), '存储已从 Synx 移除，WebDAV 文件已保留；已删除 3 条版本元数据');
});
