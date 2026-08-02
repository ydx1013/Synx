import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Cloud, LogOut, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { authApi, storageApi } from '../api/queries';
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

function StorageList() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storages = useQuery({ queryKey: ['storages'], queryFn: storageApi.list });
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [status, setStatus] = useState('');
  async function remove() {
    if (!removeTarget) return;
    await storageApi.remove(removeTarget.id);
    if (me.data?.preferences.defaultStorageId === removeTarget.id) await authApi.updatePreferences({ defaultStorageId: null, defaultSyncFolder: me.data.preferences.defaultSyncFolder });
    await Promise.all([client.invalidateQueries({ queryKey: ['storages'] }), client.invalidateQueries({ queryKey: ['me'] })]);
    setStatus(`已移除“${removeTarget.name}”，WebDAV 文件保持不变`); setRemoveTarget(null);
  }
  async function makeDefault(id: string) { await authApi.updatePreferences({ defaultStorageId: id, defaultSyncFolder: me.data?.preferences.defaultSyncFolder ?? 'my-vault/' }); await client.invalidateQueries({ queryKey: ['me'] }); }
  return <main className="settings-content"><header className="settings-heading row"><div><h1>存储管理</h1><p>管理 Synx 用于读取和同步笔记的远程存储。</p></div><Link className="primary-button" to="/settings/storage/new"><Plus size={16} />添加 WebDAV</Link></header>
    {status && <p className="notice success" role="status">{status}</p>}
    <section className="storage-grid">{storages.data?.storages.length ? storages.data.storages.map(storage => { const isDefault = me.data?.preferences.defaultStorageId === storage.id; return <article className="storage-card" key={storage.id}><div className="storage-icon"><Cloud /></div><div className="storage-details"><div><h2>{storage.name}</h2>{isDefault && <span className="default-tag"><Check size={12} />默认</span>}</div><p>WebDAV · Basic Auth</p></div><div className="storage-actions">{!isDefault && <button onClick={() => makeDefault(storage.id)}>设为默认</button>}<Link to={`/settings/storage/${storage.id}`}><Pencil size={15} />编辑</Link><button className="danger-text" onClick={() => setRemoveTarget(storage)}><Trash2 size={15} />移除</button></div></article>; }) : <div className="empty-settings"><Cloud size={38} /><h2>还没有远程存储</h2><p>添加 WebDAV 后即可在 Synx 中查看笔记。</p><Link className="primary-button" to="/settings/storage/new">添加 WebDAV</Link></div>}</section>
    <Dialog open={Boolean(removeTarget)} onOpenChange={open => !open && setRemoveTarget(null)} title="移除存储"><p>确定从 Synx 移除“{removeTarget?.name}”吗？远程 WebDAV 中的文件不会被删除。</p><div className="dialog-actions"><button onClick={() => setRemoveTarget(null)}>取消</button><button className="danger-button" onClick={remove}>确认移除</button></div></Dialog>
  </main>;
}

function StorageForm() {
  const { storageId } = useParams();
  const navigate = useNavigate();
  const storage = useQuery({ queryKey: ['storage', storageId], queryFn: () => storageApi.get(storageId!), enabled: Boolean(storageId) });
  const [status, setStatus] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const config: Record<string, string> = { address: data.address.trim(), username: data.username.trim(), password: data.password, authType: 'basic', remoteBaseDir: data.remoteBaseDir.trim(), customHeaders: data.customHeaders.trim() };
    if (storageId && !config.password) delete config.password;
    try { await storageApi.save(storageId, storageId ? { name: data.name.trim(), config } : { name: data.name.trim(), type: 'webdav', config }); navigate('/settings/storage'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
  }
  async function test(form: HTMLFormElement) { const data = Object.fromEntries(new FormData(form)) as Record<string, string>; try { await storageApi.test({ type: 'webdav', config: { address: data.address, username: data.username, password: data.password, authType: 'basic', remoteBaseDir: data.remoteBaseDir, customHeaders: data.customHeaders }, storageId }); setStatus('连接测试成功'); } catch (error) { setStatus(error instanceof Error ? error.message : '连接失败'); } }
  const values = storage.data?.storage;
  return <main className="settings-content narrow"><header className="settings-heading"><Link className="back-link" to="/settings/storage"><ArrowLeft size={16} />存储管理</Link><h1>{storageId ? '编辑 WebDAV' : '添加 WebDAV'}</h1><p>凭证会加密保存，文件内容仍存储在你的 WebDAV。</p></header>
    <form className="settings-form storage-form" key={values?.id ?? 'new'} onSubmit={submit} onReset={event => { event.preventDefault(); void test(event.currentTarget); }}>
      <label>名称<input name="name" defaultValue={values?.name} required /></label><label>HTTPS 地址<input name="address" type="url" pattern="https://.*" defaultValue={values?.config.address} required /></label><div className="form-columns"><label>用户名<input name="username" defaultValue={values?.config.username} required /></label><label>应用密码<input name="password" type="password" required={!storageId} placeholder={storageId ? '留空保留原密码' : ''} /></label></div><label>远程目录<input name="remoteBaseDir" defaultValue={values?.config.remoteBaseDir} /></label><label>自定义请求头<textarea name="customHeaders" defaultValue={values?.config.customHeaders} /></label>
      {status && <p className="notice" role="status">{status}</p>}<div className="form-actions"><button type="reset">检查连接</button><button className="primary-button" type="submit">保存配置</button></div>
    </form></main>;
}
