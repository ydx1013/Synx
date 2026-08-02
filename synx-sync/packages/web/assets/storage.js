import { api, requireSession, showStatus } from './app.js';

export function buildWebdavConfig(fields, omitEmptyPassword = false) {
  const config = {
    address: fields.address.trim(),
    username: fields.username.trim(),
    password: fields.password,
    authType: 'basic',
    remoteBaseDir: fields.remoteBaseDir.trim(),
    customHeaders: fields.customHeaders.trim(),
  };
  if (omitEmptyPassword && !config.password) delete config.password;
  return config;
}

export function buildStorageRequest(fields, storageId) {
  const config = buildWebdavConfig(fields, Boolean(storageId));
  if (storageId) {
    return { method: 'PATCH', body: { name: fields.name.trim(), config } };
  }
  return { method: 'POST', body: { name: fields.name.trim(), type: 'webdav', config } };
}

export function buildConnectivityRequest(fields, storageId) {
  const config = buildWebdavConfig(fields, Boolean(storageId));
  return storageId ? { id: storageId, config } : { type: 'webdav', config };
}

export function describeConnectivityResult(result) {
  return result.ok
    ? { kind: 'success', message: '连接测试通过' }
    : { kind: 'error', message: result.error || '连接测试失败' };
}

export function describeStorageDeletion(value) {
  if (typeof value === 'string') return `从 Synx 中移除存储“${value}”？WebDAV 中的文件不会被删除。`;
  return `存储已从 Synx 移除，WebDAV 文件已保留；已删除 ${value.deletedVersions} 条版本元数据`;
}

function formFields(form) {
  const data = Object.fromEntries(new FormData(form));
  return {
    name: String(data.name || ''),
    address: String(data.address || ''),
    username: String(data.username || ''),
    password: String(data.password || ''),
    remoteBaseDir: String(data.remoteBaseDir || ''),
    customHeaders: String(data.customHeaders || ''),
  };
}

async function loadDashboard() {
  if (!requireSession()) return;
  const list = document.querySelector('#storage-list');
  if (!list) return;
  const status = document.querySelector('[data-status]');
  try {
    const { storages } = await api('/api/storage');
    list.replaceChildren();
    if (storages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有存储账号。添加 WebDAV 后即可在插件中选择。';
      list.append(empty);
      return;
    }
    for (const storage of storages) {
      const item = document.createElement('article');
      item.className = 'storage-item';
      const details = document.createElement('div');
      const title = document.createElement('h2');
      title.textContent = storage.name;
      const type = document.createElement('p');
      type.textContent = storage.type === 'webdav' ? 'WebDAV · Basic Auth' : storage.type.toUpperCase();
      details.append(title, type);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const edit = document.createElement('a');
      edit.href = `storage_new.html?id=${encodeURIComponent(storage.id)}`;
      edit.textContent = '编辑';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger secondary';
      remove.textContent = '移除';
      remove.addEventListener('click', async () => {
        if (!confirm(describeStorageDeletion(storage.name))) return;
        try {
          const result = await api(`/api/storage/${encodeURIComponent(storage.id)}`, { method: 'DELETE' });
          item.remove();
          showStatus(status, describeStorageDeletion(result), 'success');
        } catch (error) {
          showStatus(status, error instanceof Error ? error.message : '删除失败', 'error');
        }
      });
      const purge = document.createElement('button');
      purge.type = 'button';
      purge.className = 'danger secondary';
      purge.textContent = '清空数据';
      purge.addEventListener('click', async () => {
        if (!confirm(`确定清空存储"${storage.name}"中的所有同步数据？此操作不可恢复。`)) return;
        purge.disabled = true;
        showStatus(status, '正在清空数据…');
        try {
          const result = await api(`/api/storage/${encodeURIComponent(storage.id)}/purge`, { method: 'POST' });
          showStatus(status, `已清空：删除 ${result.deleted}/${result.total} 个对象${result.failed ? `，${result.failed} 个失败` : ''}`, 'success');
        } catch (error) {
          showStatus(status, error instanceof Error ? error.message : '清空失败', 'error');
        } finally {
          purge.disabled = false;
        }
      });
      actions.append(edit, purge, remove);
      item.append(details, actions);
      list.append(item);
    }
  } catch (error) {
    showStatus(status, error instanceof Error ? error.message : '加载失败', 'error');
  }
}

async function initializeStorageForm() {
  if (!requireSession()) return;
  const form = document.querySelector('#storage-form');
  if (!form) return;
  const params = new URLSearchParams(location.search);
  const storageId = params.get('id');
  const status = document.querySelector('[data-status]');
  const title = document.querySelector('h1');
  if (storageId) {
    title.textContent = '编辑 WebDAV';
    form.elements.password.required = false;
    document.querySelector('[data-password-help]').textContent = '留空将保留已保存的应用密码。';
    try {
      const { storage } = await api(`/api/storage/${encodeURIComponent(storageId)}`);
      if (storage.type !== 'webdav') throw new Error('此页面仅支持 WebDAV 存储');
      form.elements.name.value = storage.name;
      form.elements.address.value = storage.config.address || '';
      form.elements.username.value = storage.config.username || '';
      form.elements.remoteBaseDir.value = storage.config.remoteBaseDir || '';
      form.elements.customHeaders.value = storage.config.customHeaders || '';
      form.elements.password.value = '';
    } catch (error) {
      showStatus(status, error instanceof Error ? error.message : '加载失败', 'error');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const request = buildStorageRequest(formFields(form), storageId);
      const path = storageId ? `/api/storage/${encodeURIComponent(storageId)}` : '/api/storage';
      await api(path, { method: request.method, body: JSON.stringify(request.body) });
      showStatus(status, '配置已保存，尚未验证连接', 'success');
    } catch (error) {
      showStatus(status, error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelector('#test-connection').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    showStatus(status, '正在检查 WebDAV 连接…');
    try {
      const body = buildConnectivityRequest(formFields(form), storageId);
      const result = await api('/api/storage/test', { method: 'POST', body: JSON.stringify(body) });
      const display = describeConnectivityResult(result);
      showStatus(status, display.message, display.kind);
    } catch (error) {
      showStatus(status, error instanceof Error ? error.message : '连接测试失败', 'error');
    } finally {
      button.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') {
  loadDashboard();
  initializeStorageForm();
}
