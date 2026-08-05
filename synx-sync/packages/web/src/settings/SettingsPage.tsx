import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Cloud, Copy, Images, KeyRound, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { authApi, galleryApi, onedriveApi, repoApi, storageApi, tokenApi } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { Dialog } from '../components/Dialog';
import { buildApiExamples } from './apiGuide';

export function SettingsLayout() {
  const { user } = useAuth();
  const path = useLocation().pathname;
  return <div className="settings-shell"><aside className="settings-sidebar">
    <Link className="settings-back" to="/notes"><ArrowLeft size={17} />返回笔记</Link>
    <div className="settings-account"><span className="avatar">{user?.username.slice(0, 1).toUpperCase()}</span><div><strong>{user?.username}</strong><small>{user?.email}</small></div></div>
    <nav><Link className={path === '/settings' ? 'active' : ''} to="/settings"><Settings size={17} />常规设置</Link><Link className={path.startsWith('/settings/storage') ? 'active' : ''} to="/settings/storage"><Cloud size={17} />存储管理</Link><Link className={path.startsWith('/settings/galleries') ? 'active' : ''} to="/settings/galleries"><Images size={17} />图片图库</Link><Link className={path === '/settings/tokens' ? 'active' : ''} to="/settings/tokens"><KeyRound size={17} />API Token</Link></nav>
  </aside><SettingsContent /></div>;
}

function SettingsContent() {
  const path = useLocation().pathname;
  if (path === '/settings/galleries/new' || /^\/settings\/galleries\/[^/]+$/.test(path)) return <GalleryForm />;
  if (path === '/settings/galleries') return <GalleryList />;
  if (path === '/settings/storage/new' || /^\/settings\/storage\/[^/]+$/.test(path)) return <StorageForm />;
  if (path === '/settings/storage') return <StorageList />;
  if (path === '/settings/tokens') return <TokenSettings />;
  return <GeneralSettings />;
}

function GeneralSettings() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storages = useQuery({ queryKey: ['storages'], queryFn: storageApi.list });
  const [storageId, setStorageId] = useState('');
  const [folder, setFolder] = useState('my-vault/');
  const [status, setStatus] = useState('');
  const [rebuildStatus, setRebuildStatus] = useState('');
  const [rebuildLoading, setRebuildLoading] = useState(false);
  useEffect(() => { if (me.data) { setStorageId(me.data.preferences.defaultStorageId ?? ''); setFolder(me.data.preferences.defaultSyncFolder); } }, [me.data]);
  async function save(event: FormEvent) {
    event.preventDefault();
    try { await authApi.updatePreferences({ defaultStorageId: storageId || null, defaultSyncFolder: folder }); await client.invalidateQueries({ queryKey: ['me'] }); setStatus('默认笔记位置已保存'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
  }
  async function rebuildIndex() {
    if (!storageId) { setRebuildStatus('请先选择默认存储'); return; }
    setRebuildLoading(true); setRebuildStatus('正在重建...');
    try {
      const result = await repoApi.rebuildIndex(storageId, folder);
      setRebuildStatus(`索引重建完成：已索引 ${result.indexed} 个提交`);
      client.invalidateQueries({ queryKey: ['commits'] });
    } catch (error) {
      setRebuildStatus(error instanceof Error ? error.message : '重建失败');
    } finally { setRebuildLoading(false); }
  }
  return <main className="settings-content"><header className="settings-heading"><h1>常规设置</h1><p>设置登录后自动打开的远程笔记位置。</p></header>
    <section className="settings-section"><h2>默认笔记位置</h2><form className="settings-form" onSubmit={save}>
      <label>默认存储<select value={storageId} onChange={e => setStorageId(e.target.value)}><option value="">未选择</option>{storages.data?.storages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>默认同步文件夹<input value={folder} onChange={e => setFolder(e.target.value)} placeholder="my-vault/" /></label>
      <div><button className="primary-button">保存设置</button>{status && <span className="inline-status" role="status">{status}</span>}</div>
    </form></section>
    <section className="settings-section"><h2>历史索引</h2><p className="settings-hint">历史记录加载慢或 D1 索引丢失时，可从存储重新构建索引。重建后历史加载从串行扫描（5-12 秒）降到一次查询（&lt;50ms）。</p>
      <div><button className="primary-button" onClick={rebuildIndex} disabled={rebuildLoading}>{rebuildLoading ? '重建中...' : '重建历史索引'}</button>{rebuildStatus && <span className="inline-status" role="status">{rebuildStatus}</span>}</div>
    </section></main>;
}

const TYPE_LABELS: Record<string, string> = { webdav: 'WebDAV', s3: 'S3 兼容', onedrive: 'OneDrive', dropbox: 'Dropbox' };

function CodeExample({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return <div className="api-code"><header><strong>{title}</strong><button onClick={copy} aria-label={`复制 ${title} 示例`}><Copy size={14} />{copied ? '已复制' : '复制'}</button></header><pre><code>{code}</code></pre></div>;
}

function ApiGuide() {
  const examples = buildApiExamples(window.location.origin);
  return <section className="api-guide" aria-labelledby="api-guide-title">
    <header><h2 id="api-guide-title">API 使用说明</h2><p>通过外部程序将 Markdown 笔记添加到 Token 绑定的文件夹。</p></header>
    <div className="api-guide-section"><h3>1. 准备 Token</h3><ol><li>点击页面上方“创建 Token”。</li><li>选择存储、同步根目录和目标子文件夹。</li><li>立即复制并保存密钥；完整 Token 只显示一次。</li></ol></div>
    <div className="api-guide-section"><h3>2. 请求格式</h3><dl className="api-fields"><div><dt>地址</dt><dd><code>POST /api/inbox/notes</code></dd></div><div><dt>鉴权</dt><dd><code>Authorization: Bearer synx_pat_你的Token</code></dd></div><div><dt>title</dt><dd>必填字符串，用作 Markdown 文件名，不需要填写 <code>.md</code>。</dd></div><div><dt>content</dt><dd>必填字符串，笔记的 Markdown 正文。</dd></div></dl></div>
    <div className="api-guide-section"><h3>3. 调用示例</h3><div className="api-examples"><CodeExample title="cURL" code={examples.curl} /><CodeExample title="PowerShell" code={examples.powershell} /><CodeExample title="JavaScript" code={examples.javascript} /></div></div>
    <div className="api-guide-section"><h3>4. 成功响应</h3><CodeExample title="HTTP 201" code={'{\n  "note": {\n    "path": "收件箱/会议记录.md",\n    "fileUuid": "生成的 UUID",\n    "versionId": "版本 ID",\n    "createdAt": 1785714000000\n  }\n}'} /></div>
    <div className="api-guide-section"><h3>5. 常见错误</h3><div className="api-errors"><span><code>400</code> JSON、标题或正文无效</span><span><code>401</code> Token 无效或已撤销</span><span><code>409</code> 暂时无法分配可用文件名</span><span><code>413</code> 笔记超过存储策略限制</span><span><code>429</code> 超过每分钟 60 次请求</span><span><code>500</code> 服务端写入失败</span></div></div>
    <aside className="api-notes"><strong>行为与安全提示</strong><ul><li>笔记只能写入该 Token 创建时绑定的文件夹。</li><li>服务会自动添加 <code>.md</code> 后缀和 <code>synx-id</code>，不会覆盖同名笔记；同名时按 Windows 风格创建 <code>标题 (2).md</code>、<code>标题 (3).md</code>。</li><li>不要把 Token 放入浏览器前端代码、公开仓库、日志或聊天记录；泄露后请立即撤销。</li></ul></aside>
  </section>;
}

function TokenSettings() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storages = useQuery({ queryKey: ['storages'], queryFn: storageApi.list });
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: tokenApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState('');

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    try {
      const result = await tokenApi.create({ name: data.name.trim(), storageId: data.storageId, syncFolder: data.syncFolder.trim(), targetFolder: data.targetFolder.trim() });
      setSecret(result.token); setCreateOpen(false); await client.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (error) { setStatus(error instanceof Error ? error.message : '创建失败'); }
  }
  async function remove() {
    if (!removeId) return;
    await tokenApi.remove(removeId); setRemoveId(null); await client.invalidateQueries({ queryKey: ['api-tokens'] });
  }

  return <main className="settings-content"><header className="settings-heading row"><div><h1>API Token</h1><p>创建只能向指定文件夹新增笔记的专用密钥。</p></div><button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={16} />创建 Token</button></header>
    {status && <p className="notice" role="status">{status}</p>}
    <section className="storage-grid">{tokens.data?.tokens.length ? tokens.data.tokens.map(token => <article className="storage-card" key={token.id}><div className="storage-icon"><KeyRound /></div><div className="storage-details"><div><h2>{token.name}</h2></div><p>{token.storageName ?? token.storageId} · {token.syncFolder}{token.targetFolder}</p><small>{token.tokenPrefix}… · 创建于 {new Date(token.createdAt).toLocaleDateString()}{token.lastUsedAt ? ` · 最近使用 ${new Date(token.lastUsedAt).toLocaleString()}` : ''}</small></div><div className="storage-actions"><button className="danger-text" onClick={() => setRemoveId(token.id)}><Trash2 size={15} />撤销</button></div></article>) : <div className="empty-settings"><KeyRound size={38} /><h2>还没有 API Token</h2><p>创建后可通过外部程序向绑定文件夹添加 Markdown 笔记。</p></div>}</section>
    <ApiGuide />
    <Dialog open={createOpen} onOpenChange={setCreateOpen} title="创建 API Token"><form className="settings-form" onSubmit={create}><label>名称<input name="name" required maxLength={100} placeholder="例如：快捷指令" /></label><label>存储<select name="storageId" required defaultValue={me.data?.preferences.defaultStorageId ?? ''}><option value="">请选择</option>{storages.data?.storages.map(storage => <option key={storage.id} value={storage.id}>{storage.name}</option>)}</select></label><label>同步根目录<input name="syncFolder" required defaultValue={me.data?.preferences.defaultSyncFolder ?? 'my-vault/'} /></label><label>目标子文件夹<input name="targetFolder" required placeholder="收件箱/API" /></label><div className="dialog-actions"><button type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="primary-button">创建</button></div></form></Dialog>
    <Dialog open={Boolean(secret)} onOpenChange={open => !open && setSecret('')} title="保存 API Token"><p>此 Token 只显示一次，请立即复制并妥善保存。</p><label className="dialog-field">API Token<input value={secret} readOnly /></label><div className="dialog-actions"><button onClick={() => void navigator.clipboard.writeText(secret)}><Copy size={15} />复制</button><button className="primary-button" onClick={() => setSecret('')}>完成</button></div></Dialog>
    <Dialog open={Boolean(removeId)} onOpenChange={open => !open && setRemoveId(null)} title="撤销 API Token"><p>撤销后，使用该 Token 的外部程序将立即无法添加笔记。</p><div className="dialog-actions"><button onClick={() => setRemoveId(null)}>取消</button><button className="danger-button" onClick={remove}>确认撤销</button></div></Dialog>
  </main>;
}

function GalleryList() {
  const client = useQueryClient();
  const galleries = useQuery({ queryKey: ['image-galleries'], queryFn: galleryApi.list });
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  async function remove() {
    if (!removeTarget) return;
    await galleryApi.remove(removeTarget.id);
    await client.invalidateQueries({ queryKey: ['image-galleries'] });
    setRemoveTarget(null);
  }
  return <main className="settings-content"><header className="settings-heading row"><div><h1>图片图库</h1><p>管理粘贴图片使用的 GitHub 仓库。Token 仅在服务器加密保存。</p></div><Link className="primary-button" to="/settings/galleries/new"><Plus size={16} />添加图库</Link></header>
    <section className="storage-grid">{galleries.data?.galleries.length ? galleries.data.galleries.map(gallery => <article className="storage-card" key={gallery.id}><div className="storage-icon"><Images /></div><div className="storage-details"><div><h2>{gallery.name}</h2><span className="default-tag">{gallery.isPrivate ? '私有' : '公开'}</span></div><p>{gallery.owner}/{gallery.repo} · {gallery.branch}</p><small>{gallery.folder}/</small></div><div className="storage-actions"><Link to={`/settings/galleries/${gallery.id}`}><Pencil size={15} />编辑</Link><button className="danger-text" onClick={() => setRemoveTarget(gallery)}><Trash2 size={15} />移除</button></div></article>) : <div className="empty-settings"><Images size={38} /><h2>还没有图片图库</h2><p>添加 GitHub 仓库后，Synx 插件可自动上传粘贴和拖入的图片。</p><Link className="primary-button" to="/settings/galleries/new">添加图库</Link></div>}</section>
    <Dialog open={Boolean(removeTarget)} onOpenChange={open => !open && setRemoveTarget(null)} title="移除图库"><p>仅移除“{removeTarget?.name}”的 Synx 配置，GitHub 中已有图片不会删除。</p><div className="dialog-actions"><button onClick={() => setRemoveTarget(null)}>取消</button><button className="danger-button" onClick={remove}>确认移除</button></div></Dialog>
  </main>;
}

function GalleryForm() {
  const { galleryId } = useParams();
  const navigate = useNavigate();
  const gallery = useQuery({ queryKey: ['image-gallery', galleryId], queryFn: () => galleryApi.get(galleryId!), enabled: Boolean(galleryId) });
  const [status, setStatus] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const values = gallery.data?.gallery;
  const isEdit = Boolean(galleryId);
  function bodyFromForm(): { name: string; owner: string; repo: string; branch: string; folder: string; token?: string } | null {
    if (!formRef.current) return null;
    const data = Object.fromEntries(new FormData(formRef.current)) as Record<string, string>;
    const body = { name: data.name.trim(), owner: data.owner.trim(), repo: data.repo.trim(), branch: data.branch.trim(), folder: data.folder.trim(), token: data.token.trim() || undefined };
    return body;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = bodyFromForm(); if (!body) return;
    try { await galleryApi.save(galleryId, body); navigate('/settings/galleries'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); }
  }
  async function test() {
    const body = bodyFromForm(); if (!body) return;
    if (!body.token) { setStatus('连接测试需要填写 GitHub Token；保存编辑时可留空沿用原 Token'); return; }
    try { const result = await galleryApi.test(body); setStatus(`连接成功：${result.isPrivate ? '私有仓库' : '公开仓库'}`); }
    catch (error) { setStatus(error instanceof Error ? error.message : '连接失败'); }
  }
  return <main className="settings-content narrow"><header className="settings-heading"><Link className="back-link" to="/settings/galleries"><ArrowLeft size={16} />图片图库</Link><h1>{isEdit ? '编辑 GitHub 图库' : '添加 GitHub 图库'}</h1><p>建议使用仅授权该仓库 Contents 读写权限的 fine-grained PAT。公开仓库图片任何人都可访问。</p></header>
    <form className="settings-form storage-form" ref={formRef} onSubmit={submit} key={values?.id ?? 'new'}><label>图库名称<input name="name" defaultValue={values?.name} required /></label><label>GitHub 用户或组织<input name="owner" defaultValue={values?.owner} required /></label><label>仓库名称<input name="repo" defaultValue={values?.repo} required /></label><label>分支<input name="branch" defaultValue={values?.branch ?? 'main'} required /></label><label>图片目录<input name="folder" defaultValue={values?.folder ?? 'images'} required /></label><label>GitHub Token<input name="token" type="password" required={!isEdit} placeholder={isEdit ? '留空则沿用已保存 Token' : 'github_pat_...'} /></label>{status && <p className="notice" role="status">{status}</p>}<div className="dialog-actions"><button type="button" onClick={() => void test()}>测试连接</button><button className="primary-button">保存图库</button></div></form>
  </main>;
}

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
