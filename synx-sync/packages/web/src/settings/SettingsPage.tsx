import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Cloud, LogOut, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { authApi, onedriveApi, storageApi } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { Dialog } from '../components/Dialog';

export function SettingsLayout() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  return <div className="settings-shell"><aside className="settings-sidebar">
    <Link className="settings-back" to="/notes"><ArrowLeft size={17} />返回笔记</Link>
    <div className="settings-account"><span className="avatar">{user?.username.slice(0, 1).toUpperCase()}</span><div><strong>{user?.username}</strong><small>{user?.email}</small></div></div>
    <nav><Link className="active" to="/settings"><Settings size={17} />常规设置</Link><Link to="/settings/storage"><Cloud size={17} />存储管理</Link></nav>
    <button className="sidebar-logout" onClick={() => { logout(); navigate('/login'); }}><LogOut size={17} />退出登录</button>
  </aside><SettingsContent /></div>;
}

function SettingsContent() {
  const path = useLocation().pathname;
  if (path === '/settings/storage/new' || /^\/settings\/storage\/[^/]+$/.test(path)) return <StorageForm />;
  if (path === '/settings/storage') return <StorageList />;
  return <GeneralSettings />;
}

function GeneralSettings() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storages = useQuery({ queryKey: ['storages'], queryFn: storageApi.list });
  const [storageId, setStorageId] = useState('');
  const [folder, setFolder] = useState('my-vault/');
  const [status, setStatus] = useState('');
  useEffect(() => { if (me.data) { setStorageId(me.data.preferences.defaultStorageId ?? ''); setFolder(me.data.preferences.defaultSyncFolder); } }, [me.data]);
  async function save(event: FormEvent) {
    event.preventDefault();
    try { await authApi.updatePreferences({ defaultStorageId: storageId || null, defaultSyncFolder: folder }); await client.invalidateQueries({ queryKey: ['me'] }); setStatus('默认笔记位置已保存'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
  }
  return <main className="settings-content"><header className="settings-heading"><h1>常规设置</h1><p>设置登录后自动打开的远程笔记位置。</p></header>
    <section className="settings-section"><h2>默认笔记位置</h2><form className="settings-form" onSubmit={save}>
      <label>默认存储<select value={storageId} onChange={e => setStorageId(e.target.value)}><option value="">未选择</option>{storages.data?.storages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>默认同步文件夹<input value={folder} onChange={e => setFolder(e.target.value)} placeholder="my-vault/" /></label>
      <div><button className="primary-button">保存设置</button>{status && <span className="inline-status" role="status">{status}</span>}</div>
    </form></section></main>;
}

const TYPE_LABELS: Record<string, string> = { webdav: 'WebDAV', s3: 'S3 兼容', onedrive: 'OneDrive', dropbox: 'Dropbox' };
/** 把 config 值（string|number|boolean）安全转为 input defaultValue 可用的字符串 */
const str = (value: string | number | boolean | undefined) => value == null ? undefined : String(value);

function StorageList() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storages = useQuery({ queryKey: ['storages'], queryFn: storageApi.list });
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string; type: string } | null>(null);
  const [status, setStatus] = useState('');
  async function remove() {
    if (!removeTarget) return;
    await storageApi.remove(removeTarget.id);
    if (me.data?.preferences.defaultStorageId === removeTarget.id) await authApi.updatePreferences({ defaultStorageId: null, defaultSyncFolder: me.data.preferences.defaultSyncFolder });
    await Promise.all([client.invalidateQueries({ queryKey: ['storages'] }), client.invalidateQueries({ queryKey: ['me'] })]);
    setStatus(`已移除“${removeTarget.name}”，远程文件保持不变`); setRemoveTarget(null);
  }
  async function makeDefault(id: string) { await authApi.updatePreferences({ defaultStorageId: id, defaultSyncFolder: me.data?.preferences.defaultSyncFolder ?? 'my-vault/' }); await client.invalidateQueries({ queryKey: ['me'] }); }
  return <main className="settings-content"><header className="settings-heading row"><div><h1>存储管理</h1><p>管理 Synx 用于读取和同步笔记的远程存储。</p></div><Link className="primary-button" to="/settings/storage/new"><Plus size={16} />添加存储</Link></header>
    {status && <p className="notice success" role="status">{status}</p>}
    <section className="storage-grid">{storages.data?.storages.length ? storages.data.storages.map(storage => { const isDefault = me.data?.preferences.defaultStorageId === storage.id; return <article className="storage-card" key={storage.id}><div className="storage-icon"><Cloud /></div><div className="storage-details"><div><h2>{storage.name}</h2>{isDefault && <span className="default-tag"><Check size={12} />默认</span>}</div><p>{TYPE_LABELS[storage.type] ?? storage.type}</p></div><div className="storage-actions">{!isDefault && <button onClick={() => makeDefault(storage.id)}>设为默认</button>}<Link to={`/settings/storage/${storage.id}`}><Pencil size={15} />编辑</Link><button className="danger-text" onClick={() => setRemoveTarget(storage)}><Trash2 size={15} />移除</button></div></article>; }) : <div className="empty-settings"><Cloud size={38} /><h2>还没有远程存储</h2><p>添加 WebDAV、S3 兼容或 OneDrive 后即可在 Synx 中查看笔记。</p><Link className="primary-button" to="/settings/storage/new">添加存储</Link></div>}</section>
    <Dialog open={Boolean(removeTarget)} onOpenChange={open => !open && setRemoveTarget(null)} title="移除存储"><p>确定从 Synx 移除“{removeTarget?.name}”吗？远程 {TYPE_LABELS[removeTarget?.type ?? ''] ?? '存储'} 中的文件不会被删除。</p><div className="dialog-actions"><button onClick={() => setRemoveTarget(null)}>取消</button><button className="danger-button" onClick={remove}>确认移除</button></div></Dialog>
  </main>;
}

const STORAGE_TYPES = [
  { value: 'webdav', label: 'WebDAV', hint: 'Nextcloud / 坚果云 / 群晖' },
  { value: 's3', label: 'S3 兼容', hint: 'MinIO / Cloudflare R2 / 阿里云 OSS' },
  { value: 'onedrive', label: 'OneDrive', hint: 'Microsoft OneDrive（OAuth 授权）' },
] as const;
type StorageTypeValue = (typeof STORAGE_TYPES)[number]['value'];
const DEFAULT_ONEDRIVE_AUTHORITY = 'https://login.microsoftonline.com/consumers';

function StorageForm() {
  const { storageId } = useParams();
  const navigate = useNavigate();
  const storage = useQuery({ queryKey: ['storage', storageId], queryFn: () => storageApi.get(storageId!), enabled: Boolean(storageId) });
  const [status, setStatus] = useState('');
  const [type, setType] = useState<StorageTypeValue>('webdav');
  const [onedriveConfig, setOnedriveConfig] = useState<Record<string, string | number | boolean> | null>(null);
  const [oauth, setOauth] = useState<{ verifier: string; state: string; clientId: string; authority: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const isEdit = Boolean(storageId);
  const values = storage.data?.storage;
  const editType = (values?.type ?? 'webdav') as StorageTypeValue;
  const activeType = isEdit ? editType : type;

  // OneDrive OAuth 回调：Microsoft 授权页通过 postMessage 把 code 传回本窗口
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: string; code?: string; state?: string; error?: string };
      if (data?.type !== 'onedrive-callback' || !oauth) return;
      if (data.error) { setStatus(`授权失败：${data.error}`); return; }
      if (oauth.state && data.state && data.state !== oauth.state) { setStatus('授权状态校验失败，请重试'); return; }
      void (async () => {
        try {
          const { config } = await onedriveApi.exchange({ code: data.code!, verifier: oauth.verifier, clientId: oauth.clientId, authority: oauth.authority });
          setOnedriveConfig(config); setStatus('Microsoft 授权成功，可以保存了');
        } catch (error) { setStatus(error instanceof Error ? error.message : '换取 token 失败'); }
      })();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [oauth]);

  async function startOnedriveAuth() {
    const form = formRef.current; if (!form) return;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const clientId = data.clientId.trim();
    if (!clientId) { setStatus('请先填写 Microsoft 应用 Client ID'); return; }
    const authority = data.authority.trim() || DEFAULT_ONEDRIVE_AUTHORITY;
    try {
      const { authUrl, verifier, state } = await onedriveApi.start({ clientId, authority, remoteBaseDir: data.remoteBaseDir.trim() || undefined });
      setOauth({ verifier, state, clientId, authority });
      window.open(authUrl, '_blank', 'width=560,height=680');
    } catch (error) { setStatus(error instanceof Error ? error.message : '启动授权失败'); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const name = data.name.trim(); if (!name) return;
    let config: Record<string, string | number | boolean>;
    if (activeType === 'webdav') {
      config = { address: data.address.trim(), username: data.username.trim(), password: data.password, authType: 'basic', remoteBaseDir: data.remoteBaseDir.trim(), customHeaders: data.customHeaders.trim() };
      if (isEdit && !config.password) delete config.password;
    } else if (activeType === 's3') {
      config = { endpoint: data.endpoint.trim(), bucket: data.bucket.trim(), accessKey: data.accessKey.trim(), secretKey: data.secretKey, region: data.region.trim(), pathStyle: data.pathStyle === 'on' };
    } else {
      if (!onedriveConfig) { setStatus('请先完成 Microsoft 授权'); return; }
      config = { ...onedriveConfig };
      if (data.remoteBaseDir.trim()) config.remoteBaseDir = data.remoteBaseDir.trim();
    }
    try { await storageApi.save(storageId, isEdit ? { name, config } : { name, type: activeType, config }); navigate('/settings/storage'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
  }

  async function testConnection() {
    const form = formRef.current; if (!form) return;
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    let config: Record<string, string | number | boolean>;
    if (activeType === 'webdav') {
      config = { address: data.address, username: data.username, password: data.password, authType: 'basic', remoteBaseDir: data.remoteBaseDir, customHeaders: data.customHeaders };
    } else if (activeType === 's3') {
      config = { endpoint: data.endpoint, bucket: data.bucket, accessKey: data.accessKey, secretKey: data.secretKey, region: data.region, pathStyle: data.pathStyle === 'on' };
    } else {
      if (!onedriveConfig) { setStatus('请先完成 Microsoft 授权再测试连接'); return; }
      config = { ...onedriveConfig };
      if (data.remoteBaseDir.trim()) config.remoteBaseDir = data.remoteBaseDir.trim();
    }
    try { await storageApi.test({ type: activeType, config, storageId }); setStatus('连接测试成功'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '连接失败'); }
  }

  const typeName = TYPE_LABELS[activeType] ?? activeType;
  return <main className="settings-content narrow"><header className="settings-heading"><Link className="back-link" to="/settings/storage"><ArrowLeft size={16} />存储管理</Link><h1>{isEdit ? `编辑 ${typeName}` : '添加存储'}</h1><p>凭证会加密保存，文件内容仍存储在你的远程服务。</p></header>
    <form className="settings-form storage-form" key={`${values?.id ?? 'new'}-${activeType}`} ref={formRef} onSubmit={submit} onReset={event => { event.preventDefault(); void testConnection(); }}>
      <label>名称<input name="name" defaultValue={values?.name} required /></label>
      {!isEdit && <div className="storage-type-picker">{STORAGE_TYPES.map(t => <button type="button" key={t.value} className={type === t.value ? 'type-option active' : 'type-option'} onClick={() => setType(t.value)}><strong>{t.label}</strong><small>{t.hint}</small></button>)}</div>}
      {activeType === 'webdav' && <>
        <label>HTTPS 地址<input name="address" type="url" pattern="https://.*" defaultValue={str(values?.config.address)} placeholder="https://dav.example.com" required /></label>
        <div className="form-columns"><label>用户名<input name="username" defaultValue={str(values?.config.username)} required /></label><label>应用密码<input name="password" type="password" required={!isEdit} placeholder={isEdit ? '留空保留原密码' : ''} /></label></div>
        <label>远程目录<input name="remoteBaseDir" defaultValue={str(values?.config.remoteBaseDir)} placeholder="my-vault/" /></label>
        <label>自定义请求头<textarea name="customHeaders" defaultValue={str(values?.config.customHeaders)} placeholder="每行一个，如 X-Requested-With: XMLHttpRequest" /></label>
      </>}
      {activeType === 's3' && <>
        <label>Endpoint 地址<input name="endpoint" type="url" pattern="https://.*" defaultValue={str(values?.config.endpoint)} placeholder="https://s3.example.com" required /></label>
        <div className="form-columns"><label>Bucket<input name="bucket" defaultValue={str(values?.config.bucket)} required /></label><label>Region<input name="region" defaultValue={str(values?.config.region)} placeholder="us-east-1" required /></label></div>
        <div className="form-columns"><label>Access Key<input name="accessKey" defaultValue={str(values?.config.accessKey)} required /></label><label>Secret Key<input name="secretKey" type="password" defaultValue={str(values?.config.secretKey)} required /></label></div>
        <label className="checkbox-field"><input name="pathStyle" type="checkbox" defaultChecked={Boolean(values?.config.pathStyle)} />使用 Path Style（MinIO 等需要）</label>
      </>}
      {activeType === 'onedrive' && <>
        <label>Microsoft 应用 Client ID<input name="clientId" defaultValue={str(values?.config.clientId)} placeholder="Azure 应用注册中的 Client ID" required /></label>
        <label>Authority<input name="authority" defaultValue={str(values?.config.authority ?? DEFAULT_ONEDRIVE_AUTHORITY)} placeholder={DEFAULT_ONEDRIVE_AUTHORITY} /></label>
        <label>远程目录<input name="remoteBaseDir" defaultValue={str(values?.config.remoteBaseDir)} placeholder="my-vault/" /></label>
        <div className="form-actions"><button type="button" onClick={() => void startOnedriveAuth()}>{onedriveConfig ? '重新授权 Microsoft' : '使用 Microsoft 授权'}</button>{onedriveConfig && <span className="inline-status success">{String(onedriveConfig.username ?? '') || '已授权，可以保存'}</span>}</div>
      </>}
      {status && <p className="notice" role="status">{status}</p>}
      <div className="form-actions"><button type="reset">检查连接</button><button className="primary-button" type="submit">保存配置</button></div>
    </form></main>;
}
