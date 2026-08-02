import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { ArrowLeft, BookOpen, ChevronRight, Clock3, Edit3, FileText, Folder, History, LogOut, Menu, MoreHorizontal, Plus, Save, Search, Settings, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { FileMeta, VersionRecord } from '@synx/shared';
import { authApi, notesApi } from '../api/queries';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Dialog } from '../components/Dialog';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists, { enabled: true, label: true });
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
const encode = (value: string) => { const bytes = new TextEncoder().encode(value); let binary = ''; bytes.forEach(byte => binary += String.fromCharCode(byte)); return btoa(binary); };
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const displayName = (path: string) => path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? path;
const formatSize = (size: number) => size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

export function NotesPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storageId = me.data?.preferences.defaultStorageId ?? '';
  const syncFolder = me.data?.preferences.defaultSyncFolder ?? '';
  const filesQuery = useQuery({ queryKey: ['notes', storageId, syncFolder], queryFn: () => notesApi.list(storageId, syncFolder), enabled: Boolean(storageId && syncFolder) });
  const [folder, setFolder] = useState('');
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<FileMeta | null>(null);
  const [text, setText] = useState('');
  const [openedVersion, setOpenedVersion] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [mobileEditor, setMobileEditor] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const files = useMemo(() => (filesQuery.data?.files ?? []).filter(file => isMarkdown(file.path)), [filesQuery.data]);
  const visible = useMemo(() => files.filter(file => (!folder || file.path.startsWith(`${folder}/`)) && file.path.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.mtime - a.mtime), [files, folder, search]);
  const folders = useMemo(() => [...new Set(files.flatMap(file => { const parts = file.path.split('/'); parts.pop(); return parts.map((_, index) => parts.slice(0, index + 1).join('/')); }))], [files]);

  useEffect(() => { const before = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, [dirty]);

  async function openNote(file: FileMeta) {
    if (dirty && !confirm('当前修改尚未保存，确定切换笔记吗？')) return;
    try { const result = await notesApi.get(storageId, syncFolder, file.path, file.fileUuid); setCurrent(file); setText(decode(result.content)); setOpenedVersion(file.versionId); setEditing(false); setDirty(false); setStatus('已保存'); setMobileEditor(true); }
    catch (error) { setStatus(error instanceof Error ? error.message : '加载失败'); }
  }
  async function save() {
    if (!current) return;
    try { const { version } = await notesApi.put(storageId, syncFolder, { path: current.path, fileUuid: current.fileUuid ?? undefined, mtime: Date.now(), content: encode(text), author: 'web', baseVersionId: openedVersion }); setOpenedVersion(version.versionId); setCurrent({ ...current, ...version }); setDirty(false); setStatus('已保存'); await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] }); }
    catch (error) { setStatus(error instanceof ApiError && error.status === 409 ? '远端已变化，请重新打开后合并修改' : error instanceof Error ? error.message : '保存失败'); }
  }
  async function create(path: string) {
    const finalPath = isMarkdown(path) ? path : `${path}.md`; const uuid = crypto.randomUUID();
    const { version } = await notesApi.put(storageId, syncFolder, { path: finalPath, fileUuid: uuid, mtime: Date.now(), content: encode(`<!-- synx-id:${uuid} -->\n\n`), author: 'web' });
    await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] }); setCreateOpen(false); await openNote({ ...version, path: finalPath, fileUuid: uuid } as FileMeta); setEditing(true);
  }
  async function rename(path: string) {
    if (!current) return; const finalPath = isMarkdown(path) ? path : `${path}.md`;
    const { version } = await notesApi.put(storageId, syncFolder, { path: finalPath, fileUuid: current.fileUuid ?? undefined, mtime: Date.now(), content: encode(text), author: 'web', baseVersionId: openedVersion });
    setCurrent({ ...current, ...version, path: finalPath }); setOpenedVersion(version.versionId); setRenameOpen(false); setDirty(false); await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] });
  }
  async function remove() { if (!current) return; await notesApi.remove(storageId, syncFolder, { path: current.path, fileUuid: current.fileUuid ?? undefined }); setCurrent(null); setText(''); setDeleteOpen(false); setMobileEditor(false); setStatus('笔记已删除，历史版本仍然保留'); await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] }); }

  if (me.isLoading) return <div className="center-state">正在加载笔记…</div>;
  if (!storageId) return <div className="center-state"><BookOpen size={48} /><h1>设置你的默认存储</h1><p>选择一个 WebDAV 作为笔记默认位置后，Synx 会自动载入笔记。</p><Link className="primary-button" to="/settings">前往设置</Link></div>;

  return <div className={`notes-shell ${navOpen ? 'nav-open' : ''} ${mobileEditor ? 'show-editor' : ''}`}>
    <button className="nav-scrim" aria-label="关闭导航" onClick={() => setNavOpen(false)} />
    <aside className="primary-sidebar"><div className="sidebar-logo">Synx</div><button className="new-note-button" onClick={() => setCreateOpen(true)}><Plus size={16} />新建</button><nav className="primary-nav"><button className={!folder ? 'active' : ''} onClick={() => { setFolder(''); setNavOpen(false); }}><Clock3 size={16} />最新</button><div className="nav-label"><Folder size={15} />我的文件夹</div>{folders.map(item => <button className={folder === item ? 'active nested' : 'nested'} key={item} onClick={() => { setFolder(item); setNavOpen(false); }}><ChevronRight size={12} />{item.split('/').pop()}</button>)}</nav>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="account-trigger"><span className="avatar">{user?.username[0].toUpperCase()}</span><span>{user?.username}</span><MoreHorizontal size={16} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="dropdown-content" side="top" align="start"><DropdownMenu.Item onSelect={() => navigate('/settings')}><Settings size={15} />设置</DropdownMenu.Item><DropdownMenu.Item onSelect={() => { logout(); navigate('/login'); }}><LogOut size={15} />退出登录</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    </aside>
    <section className="note-list-pane"><header className="list-toolbar"><button className="menu-button" aria-label="打开导航" onClick={() => setNavOpen(true)}><Menu size={18} /></button><label className="search-box"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索笔记" /></label></header><div className="list-heading"><strong>{folder || '全部笔记'}</strong><span>{visible.length} 篇</span></div><ul className="note-list">{filesQuery.isLoading ? <li className="list-state">正在载入远程笔记…</li> : visible.length ? visible.map(file => <li key={`${file.path}:${file.versionId}`}><button className={current?.path === file.path ? 'note-item active' : 'note-item'} onClick={() => openNote(file)}><FileText size={15} /><span className="note-copy"><strong>{displayName(file.path)}</strong><small>{file.path}</small><span><time>{new Date(file.mtime).toLocaleDateString()}</time><small>{formatSize(file.size)}</small></span></span></button></li>) : <li className="list-state">这里还没有笔记</li>}</ul></section>
    <main className="editor-pane">{current ? <><header className="editor-header"><button className="mobile-back" onClick={() => setMobileEditor(false)}><ArrowLeft size={18} /></button><div className="document-title"><strong>{displayName(current.path)}</strong><span className={dirty ? 'dirty' : ''}>{dirty ? '未保存' : status || '已保存'}</span></div><div className="document-actions"><button onClick={() => setEditing(value => !value)}><Edit3 size={15} />{editing ? '预览' : '编辑'}</button><button onClick={save} disabled={!dirty}><Save size={15} />保存</button><button onClick={() => setHistoryOpen(true)}><History size={15} />历史</button><DropdownMenu.Root><DropdownMenu.Trigger asChild><button aria-label="更多操作"><MoreHorizontal size={18} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="dropdown-content" align="end"><DropdownMenu.Item onSelect={() => setRenameOpen(true)}>重命名</DropdownMenu.Item><DropdownMenu.Item className="danger-text" onSelect={() => setDeleteOpen(true)}>删除</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div></header><div className="format-toolbar"><button onClick={() => setEditing(true)}>正文</button><span />Markdown 笔记<span />{current.path}</div><section className="editor-content">{editing ? <MarkdownEditor value={text} onChange={value => { setText(value); setDirty(true); setStatus('未保存'); }} /> : <article className="markdown-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(md.render(text)) }} />}</section></> : <div className="editor-empty"><FileText size={42} /><h2>选择一篇笔记</h2><p>从左侧列表打开笔记，或新建一篇 Markdown 笔记。</p></div>}</main>
    <PathDialog open={createOpen} title="新建笔记" initial={folder ? `${folder}/未命名.md` : '未命名.md'} onClose={() => setCreateOpen(false)} onSubmit={create} />
    <PathDialog open={renameOpen} title="重命名笔记" initial={current?.path ?? ''} onClose={() => setRenameOpen(false)} onSubmit={rename} />
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen} title="删除笔记"><p>删除“{current?.path}”？历史版本会保留，可以从版本记录恢复。</p><div className="dialog-actions"><button onClick={() => setDeleteOpen(false)}>取消</button><button className="danger-button" onClick={remove}><Trash2 size={15} />删除</button></div></Dialog>
    <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} storageId={storageId} syncFolder={syncFolder} current={current} onRestore={async version => { if (!current) return; await notesApi.rollback(storageId, syncFolder, { path: current.path, fileUuid: current.fileUuid ?? undefined, version: version.versionId }); await openNote(current); setHistoryOpen(false); }} />
  </div>;
}

function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLDivElement>(null); const changeRef = useRef(onChange); changeRef.current = onChange;
  useEffect(() => { if (!ref.current) return; const editor = new EditorView({ doc: value, parent: ref.current, extensions: [basicSetup, markdown(), EditorView.lineWrapping, EditorView.updateListener.of(update => { if (update.docChanged) changeRef.current(update.state.doc.toString()); })] }); editor.focus(); return () => editor.destroy(); }, []);
  return <div className="codemirror-host" ref={ref} />;
}

function PathDialog({ open, title, initial, onClose, onSubmit }: { open: boolean; title: string; initial: string; onClose: () => void; onSubmit: (path: string) => void }) {
  const [path, setPath] = useState(initial); useEffect(() => setPath(initial), [initial, open]);
  return <Dialog open={open} onOpenChange={value => !value && onClose()} title={title}><label className="dialog-field">笔记路径<input value={path} onChange={e => setPath(e.target.value)} autoFocus /></label><div className="dialog-actions"><button onClick={onClose}>取消</button><button className="primary-button" onClick={() => path.trim() && onSubmit(path.trim())}>确认</button></div></Dialog>;
}

function HistoryDrawer({ open, onClose, storageId, syncFolder, current, onRestore }: { open: boolean; onClose: () => void; storageId: string; syncFolder: string; current: FileMeta | null; onRestore: (version: VersionRecord) => void }) {
  const history = useQuery({ queryKey: ['history', current?.path], queryFn: () => notesApi.history(storageId, syncFolder, current!.path, current!.fileUuid), enabled: open && Boolean(current) });
  return <div className={open ? 'history-drawer open' : 'history-drawer'}><header><h2>版本历史</h2><button aria-label="关闭历史" onClick={onClose}><ArrowLeft /></button></header><ul>{history.data?.versions.map(version => <li key={version.versionId}><div><strong>{new Date(version.createdAt).toLocaleString()}</strong><small>{version.author || '未知设备'} · {formatSize(version.size)}</small></div>{version.isCurrent ? <span className="default-tag">当前</span> : <button onClick={() => onRestore(version)}>恢复</button>}</li>)}</ul></div>;
}
