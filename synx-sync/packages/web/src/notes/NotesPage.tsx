import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Clock3, Edit3, FileText, Folder, History, LogOut, Menu, MoreHorizontal, Plus, Save, Search, Settings, Trash2 } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { FileMeta, VersionRecord } from '@synx/shared';
import { authApi, notesApi } from '../api/queries';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Dialog } from '../components/Dialog';
import { buildLineDiff, DiffTooLargeError, type DiffLine } from './lineDiff';

const md = new MarkdownIt({ html: true, linkify: true, breaks: true }).use(taskLists, { enabled: true, label: true }).use(wikilinksPlugin);

/** Obsidian 双向链接/嵌入：[[笔记名]]、[[笔记名|显示文本]]、![[文件]]。
 *  渲染为带 data-wikilink 的链接，点击由 NotesPage 事件委托解析并打开对应笔记。 */
const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/;
function wikilinksPlugin(md: MarkdownIt) {
  md.inline.ruler.before('link', 'synx_wikilink', (state, silent) => {
    const start = state.pos;
    const match = WIKILINK_RE.exec(state.src.slice(start));
    if (!match || match.index !== 0) return false;
    const embed = Boolean(match[1]);
    const target = (match[2] || '').trim();
    const heading = (match[3] || '').trim();
    const label = (match[4] || match[2] || '').trim();
    if (silent) { state.pos = start + match[0].length; return true; }
    const token = state.push('synx_wikilink_open', 'a', 1);
    token.attrs = [['href', '#'], ['data-wikilink', target], ['data-wikilink-heading', heading], ['data-wikilink-embed', embed ? '1' : '0']];
    state.push('text', '', 0).content = label;
    state.push('synx_wikilink_close', 'a', -1);
    state.pos = start + match[0].length;
    return true;
  });
}
const decode = (value: ArrayBuffer) => new TextDecoder().decode(value);
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const displayName = (path: string) => path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? path;
const formatSize = (size: number) => size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

// synx-id 注释由 Obsidian 插件在文件头部维护稳定 ID。web 端编辑时隐藏、
// 保存时原样恢复，避免用户误删导致文件身份丢失。
const UUID_COMMENT = /<!--\s*synx-id\s*:\s*[0-9a-fA-F-]{8,36}\s*-->/i;
const stripUuid = (content: string) => content.replace(new RegExp(`(<!--\\s*synx-id\\s*:\\s*[0-9a-fA-F-]{8,36}\\s*-->\\r?\\n?)`, 'i'), '');
const withUuid = (content: string, uuid?: string | null) => (uuid ? `<!-- synx-id:${uuid} -->\n\n${content}` : content);

interface FolderNodeData { name: string; path: string; children: FolderNodeData[]; }

function buildTree(paths: string[]): FolderNodeData[] {
  const nodes = new Map<string, FolderNodeData>();
  const root: FolderNodeData[] = [];
  for (const path of [...paths].sort()) {
    const parts = path.split('/');
    let parent = root; let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[i] : `${acc}/${parts[i]}`;
      let node = nodes.get(acc);
      if (!node) { node = { name: parts[i], path: acc, children: [] }; nodes.set(acc, node); parent.push(node); }
      parent = node.children;
    }
  }
  return root;
}

export function NotesPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storageId = me.data?.preferences.defaultStorageId ?? '';
  const syncFolder = me.data?.preferences.defaultSyncFolder ?? '';
  const filesQuery = useQuery({ queryKey: ['notes', storageId, syncFolder], queryFn: () => notesApi.list(storageId, syncFolder), enabled: Boolean(storageId && syncFolder) });

  // 定位状态同步到 URL：刷新/分享后仍停留在同一文件夹与打开的笔记
  const [searchParams, setSearchParams] = useSearchParams();
  const folder = searchParams.get('folder') ?? '';
  const openPath = searchParams.get('path');
  const updateParams = (next: Record<string, string | null>) => setSearchParams(prev => {
    const params = new URLSearchParams(prev);
    for (const [key, value] of Object.entries(next)) { if (value) params.set(key, value); else params.delete(key); }
    return params;
  }, { replace: true });
  const setFolder = (value: string) => updateParams({ folder: value });
  const setOpenPath = (value: string | null) => updateParams({ path: value });

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const lastFolders = useRef('');
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<FileMeta | null>(null);
  const [text, setText] = useState('');
  const [hasUuid, setHasUuid] = useState(false);
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
  // vault 根目录下的独立笔记（路径不含斜杠）
  const rootFiles = useMemo(() => files.filter(file => !file.path.includes('/')).sort((a, b) => b.mtime - a.mtime), [files]);
  const visible = useMemo(() => files.filter(file => (!folder || file.path.startsWith(`${folder}/`)) && file.path.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.mtime - a.mtime), [files, folder, search]);
  const folders = useMemo(() => [...new Set(files.flatMap(file => { const parts = file.path.split('/'); parts.pop(); return parts.map((_, index) => parts.slice(0, index + 1).join('/')); }))], [files]);

  // 文件夹集合变化时自动展开全部目录，之后用户可手动收起/展开
  useEffect(() => {
    const key = folders.join('\n');
    if (key && key !== lastFolders.current) { lastFolders.current = key; setExpanded(new Set(folders)); }
  }, [folders]);

  // 刷新/直达 URL 时根据 ?path= 自动恢复打开的笔记。
  // 分享链接可能只含文件名（如 /肝窦毛细血管化.md），故先精确匹配，再按文件名匹配。
  const restoreAttempted = useRef(false);
  useEffect(() => {
    if (restoreAttempted.current || me.isLoading || filesQuery.isLoading || !openPath) return;
    restoreAttempted.current = true;
    const targetName = displayName(openPath);
    const file = files.find(f => f.path === openPath)
      ?? files.find(f => f.path.replace(/\.(md|markdown)$/i, '') === openPath.replace(/\.(md|markdown)$/i, '') || displayName(f.path) === targetName);
    if (file) void openNote(file);
    else setOpenPath(null); // 笔记已被删除/移动，清除定位
  }, [openPath, files, me.isLoading, filesQuery.isLoading]);

  useEffect(() => { const before = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, [dirty]);

  async function openNote(file: FileMeta) {
    if (dirty && !confirm('当前修改尚未保存，确定切换笔记吗？')) return;
    try { const result = await notesApi.get(storageId, syncFolder, file.path, file.fileUuid); const content = decode(result.content); setCurrent(file); setText(stripUuid(content)); setHasUuid(UUID_COMMENT.test(content)); setOpenedVersion(file.versionId); setEditing(false); setDirty(false); setStatus('已保存'); setMobileEditor(true); setNavOpen(false); setOpenPath(file.path); }
    catch (error) { setStatus(error instanceof Error ? error.message : '加载失败'); }
  }
  async function save() {
    if (!current) return;
    try { const { version } = await notesApi.put(storageId, syncFolder, { path: current.path, fileUuid: current.fileUuid ?? undefined, mtime: Date.now(), content: hasUuid ? withUuid(text, current.fileUuid) : text, author: 'web', baseVersionId: openedVersion }); setOpenedVersion(version.versionId); setCurrent({ ...current, ...version }); setDirty(false); setStatus('已保存'); await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] }); }
    catch (error) { setStatus(error instanceof ApiError && error.status === 409 ? '远端已变化，请重新打开后合并修改' : error instanceof Error ? error.message : '保存失败'); }
  }
  async function create(path: string) {
    const finalPath = isMarkdown(path) ? path : `${path}.md`; const uuid = crypto.randomUUID();
    const { version } = await notesApi.put(storageId, syncFolder, { path: finalPath, fileUuid: uuid, mtime: Date.now(), content: `<!-- synx-id:${uuid} -->\n\n`, author: 'web' });
    await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] }); setCreateOpen(false); await openNote({ ...version, path: finalPath, fileUuid: uuid } as FileMeta); setEditing(true);
  }
  async function rename(path: string) {
    if (!current) return; const finalPath = isMarkdown(path) ? path : `${path}.md`;
    const { version } = await notesApi.put(storageId, syncFolder, { path: finalPath, fileUuid: current.fileUuid ?? undefined, mtime: Date.now(), content: hasUuid ? withUuid(text, current.fileUuid) : text, author: 'web', baseVersionId: openedVersion });
    setCurrent({ ...current, ...version, path: finalPath }); setOpenedVersion(version.versionId); setRenameOpen(false); setDirty(false); setOpenPath(finalPath); await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] });
  }
  async function remove() { if (!current) return; await notesApi.remove(storageId, syncFolder, { path: current.path, fileUuid: current.fileUuid ?? undefined }); setCurrent(null); setText(''); setDeleteOpen(false); setMobileEditor(false); setOpenPath(null); setStatus('笔记已删除，历史版本仍然保留'); await client.invalidateQueries({ queryKey: ['notes', storageId, syncFolder] }); }

  // 点击笔记正文中的 [[双向链接]]：按文件名匹配并打开对应笔记
  function onWikiLinkClick(event: ReactMouseEvent<HTMLElement>) {
    const anchor = (event.target as HTMLElement).closest('a[data-wikilink]');
    if (!anchor) return;
    event.preventDefault();
    const name = (anchor.getAttribute('data-wikilink') ?? '').trim();
    if (!name) return;
    const target = files.find(file => displayName(file.path) === name || file.path === name || file.path.replace(/\.(md|markdown)$/i, '') === name);
    if (target) void openNote(target);
  }

  if (me.isLoading) return <div className="center-state">正在加载笔记…</div>;
  if (!storageId) return <div className="center-state"><BookOpen size={48} /><h1>设置你的默认存储</h1><p>选择一个 WebDAV 作为笔记默认位置后，Synx 会自动载入笔记。</p><Link className="primary-button" to="/settings">前往设置</Link></div>;

  return <div className={`notes-shell ${navOpen ? 'nav-open' : ''} ${mobileEditor ? 'show-editor' : ''}`}>
    <button className="nav-scrim" aria-label="关闭导航" onClick={() => setNavOpen(false)} />
    <aside className="primary-sidebar"><div className="sidebar-logo">Synx</div><button className="new-note-button" onClick={() => setCreateOpen(true)}><Plus size={16} />新建</button><nav className="primary-nav"><button className={!folder ? 'active' : ''} onClick={() => { setFolder(''); setNavOpen(false); }}><Clock3 size={16} />最新</button><div className="nav-label"><Folder size={15} />我的文件夹</div><FolderTree folders={folders} rootFiles={rootFiles} currentPath={current?.path ?? ''} onOpenFile={openNote} selected={folder} expanded={expanded} onToggle={path => setExpanded(prev => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); return next; })} onSelect={path => { setFolder(path); setNavOpen(false); }} /></nav>
      <div className="sidebar-account"><span className="avatar">{user?.username[0].toUpperCase()}</span><span className="sidebar-username">{user?.username}</span><div className="sidebar-account-actions"><button className="sidebar-account-action" aria-label="设置" title="设置" onClick={() => navigate('/settings')}><Settings size={19} /></button><button className="sidebar-account-action logout" aria-label="退出" title="退出" onClick={() => { logout(); navigate('/login'); }}><LogOut size={19} /></button></div></div>
    </aside>
    <section className="note-list-pane"><header className="list-toolbar"><button className="menu-button" aria-label="打开导航" onClick={() => setNavOpen(true)}><Menu size={18} /></button><label className="search-box"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索笔记" /></label></header><div className="list-heading"><strong>{folder || '全部笔记'}</strong><span>{visible.length} 篇</span></div><ul className="note-list">{filesQuery.isLoading ? <li className="list-state">正在载入远程笔记…</li> : visible.length ? visible.map(file => <li key={`${file.path}:${file.versionId}`}><button className={current?.path === file.path ? 'note-item active' : 'note-item'} onClick={() => openNote(file)}><FileText size={15} /><span className="note-copy"><strong>{displayName(file.path)}</strong><small>{file.path}</small><span><time>{new Date(file.mtime).toLocaleDateString()}</time><small>{formatSize(file.size)}</small></span></span></button></li>) : <li className="list-state">这里还没有笔记</li>}</ul></section>
    <main className="editor-pane">{current ? <><header className="editor-header"><button className="mobile-back" onClick={() => { setMobileEditor(false); setOpenPath(null); }}><ArrowLeft size={18} /></button><div className="document-title"><strong>{displayName(current.path)}</strong><span className={dirty ? 'dirty' : ''}>{dirty ? '未保存' : status || '已保存'}</span></div><div className="document-actions"><button onClick={() => setEditing(value => !value)}><Edit3 size={15} />{editing ? '预览' : '编辑'}</button><button onClick={save} disabled={!dirty}><Save size={15} />保存</button><button onClick={() => setHistoryOpen(true)}><History size={15} />历史</button><DropdownMenu.Root><DropdownMenu.Trigger asChild><button aria-label="更多操作"><MoreHorizontal size={18} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="dropdown-content" align="end"><DropdownMenu.Item onSelect={() => setRenameOpen(true)}>重命名</DropdownMenu.Item><DropdownMenu.Item className="danger-text" onSelect={() => setDeleteOpen(true)}>删除</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div></header><div className="format-toolbar"><button onClick={() => setEditing(true)}>正文</button><span />Markdown 笔记<span />{current.path}</div><section className="editor-content">{editing ? <MarkdownEditor value={text} onChange={value => { setText(value); setDirty(true); setStatus('未保存'); }} /> : <article className="markdown-body" onClick={onWikiLinkClick} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(md.render(text)) }} />}</section></> : <div className="editor-empty"><FileText size={42} /><h2>选择一篇笔记</h2><p>从左侧列表打开笔记，或新建一篇 Markdown 笔记。</p></div>}</main>
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

function FolderTree({ folders, rootFiles, currentPath, onOpenFile, selected, expanded, onToggle, onSelect }: {
  folders: string[]; rootFiles: FileMeta[]; currentPath: string; onOpenFile: (file: FileMeta) => void;
  selected: string; expanded: Set<string>; onToggle: (path: string) => void; onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  if (!tree.length && !rootFiles.length) return <p className="folder-empty">暂无文件夹</p>;
  return <div className="folder-tree">
    {tree.map(node => <FolderNode key={node.path} node={node} depth={0} selected={selected} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />)}
    {rootFiles.map(file => <button key={file.path} className={currentPath === file.path ? 'root-note active' : 'root-note'} title={file.path} onClick={() => onOpenFile(file)}><FileText size={14} /><span className="folder-name">{displayName(file.path)}</span></button>)}
  </div>;
}

function FolderNode({ node, depth, selected, expanded, onToggle, onSelect }: {
  node: FolderNodeData; depth: number; selected: string; expanded: Set<string>;
  onToggle: (path: string) => void; onSelect: (path: string) => void;
}) {
  const open = expanded.has(node.path);
  const hasChildren = node.children.length > 0;
  return <div>
    <button className={selected === node.path ? 'folder-item active' : 'folder-item'} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => onSelect(node.path)}>
      <span className="folder-caret" role="button" aria-label={open ? '收起' : '展开'} onClick={event => { event.stopPropagation(); onToggle(node.path); }}>
        {hasChildren ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
      </span>
      <Folder size={14} className="folder-icon" />
      <span className="folder-name">{node.name}</span>
    </button>
    {open && hasChildren && <div>{node.children.map(child => <FolderNode key={child.path} node={child} depth={depth + 1} selected={selected} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />)}</div>}
  </div>;
}

function HistoryDrawer({ open, onClose, storageId, syncFolder, current, onRestore }: { open: boolean; onClose: () => void; storageId: string; syncFolder: string; current: FileMeta | null; onRestore: (version: VersionRecord) => void }) {
  const history = useQuery({ queryKey: ['history', current?.path], queryFn: () => notesApi.history(storageId, syncFolder, current!.path, current!.fileUuid), enabled: open && Boolean(current) });
  const versions = history.data?.versions ?? [];

  const [baseVersion, setBaseVersion] = useState<VersionRecord | null>(null);
  const [targetVersion, setTargetVersion] = useState<VersionRecord | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // 抽屉打开/关闭时重置对比状态，避免切换笔记后残留旧对比
  useEffect(() => {
    if (!open) { setBaseVersion(null); setTargetVersion(null); setDiffLines(null); setDiffError(null); setLoadingDiff(false); }
  }, [open]);

  // 版本列表变化后，清掉列表中已不存在的选中项
  useEffect(() => {
    if (!versions.length) return;
    if (baseVersion && !versions.some(v => v.versionId === baseVersion.versionId)) setBaseVersion(null);
    if (targetVersion && !versions.some(v => v.versionId === targetVersion.versionId)) setTargetVersion(null);
  }, [versions, baseVersion, targetVersion]);

  // 对比双方确定后拉取内容并计算行级 diff
  useEffect(() => {
    if (!open || !current || !baseVersion || !targetVersion) return;
    if (baseVersion.versionId === targetVersion.versionId) { setDiffLines([]); setDiffError(null); setLoadingDiff(false); return; }
    let cancelled = false;
    setLoadingDiff(true); setDiffLines(null); setDiffError(null);
    void (async () => {
      try {
        const [oldRes, newRes] = await Promise.all([
          notesApi.get(storageId, syncFolder, current.path, current.fileUuid, baseVersion.versionId),
          notesApi.get(storageId, syncFolder, current.path, current.fileUuid, targetVersion.versionId),
        ]);
        if (cancelled) return;
        setDiffLines(buildLineDiff(decode(oldRes.content), decode(newRes.content)));
      } catch (error) {
        if (cancelled) return;
        setDiffError(error instanceof Error ? error.message : '对比失败');
      } finally {
        if (!cancelled) setLoadingDiff(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, current, baseVersion, targetVersion, storageId, syncFolder]);

  const currentVersion = versions.find(v => v.isCurrent) ?? null;

  const startCompare = (version: VersionRecord) => {
    setBaseVersion(version);
    if (version.isCurrent) {
      setTargetVersion(versions.find(v => !v.isCurrent) ?? null);
    } else {
      setTargetVersion(currentVersion ?? versions.find(v => v.versionId !== version.versionId) ?? null);
    }
  };

  const comparing = Boolean(baseVersion && targetVersion);
  const changed = diffLines !== null && diffLines.some(line => line.type !== 'context');
  const versionLabel = (v: VersionRecord) => `${new Date(v.createdAt).toLocaleString()}${v.isCurrent ? '（当前）' : ''}`;

  return <div className={open ? 'history-drawer open' : 'history-drawer'}><header><h2>版本历史</h2><button aria-label="关闭历史" onClick={onClose}><ArrowLeft /></button></header>
    {comparing && baseVersion && targetVersion ? (
      <div className="history-diff">
        <div className="history-diff-controls">
          <label className="history-diff-select"><span>旧版本</span><select value={baseVersion.versionId} onChange={e => setBaseVersion(versions.find(v => v.versionId === e.target.value) ?? null)}>{versions.map(v => <option key={v.versionId} value={v.versionId}>{versionLabel(v)}</option>)}</select></label>
          <span className="history-diff-arrow">→</span>
          <label className="history-diff-select"><span>新版本</span><select value={targetVersion.versionId} onChange={e => setTargetVersion(versions.find(v => v.versionId === e.target.value) ?? null)}>{versions.map(v => <option key={v.versionId} value={v.versionId}>{versionLabel(v)}</option>)}</select></label>
          <button onClick={() => { setBaseVersion(null); setTargetVersion(null); }}>返回列表</button>
        </div>
        <div className="history-diff-body">
          {loadingDiff ? <div className="history-diff-empty">正在对比…</div>
            : diffError ? <div className="history-diff-empty">{diffError}</div>
            : diffLines === null ? <div className="history-diff-empty">请选择两个不同的版本进行对比</div>
            : !changed ? <div className="history-diff-empty">两个版本内容相同</div>
            : <div className="diff-view">{diffLines.map((line, index) => (
                <div key={index} className={`diff-line is-${line.type}`}>
                  <span className="diff-number">{line.oldLine ?? ''}</span>
                  <span className="diff-number">{line.newLine ?? ''}</span>
                  <span className="diff-marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
                  <code className="diff-text">{line.text || ' '}</code>
                </div>))}</div>}
        </div>
      </div>
    ) : (
      <ul>{versions.map(version => <li key={version.versionId}><div><strong>{new Date(version.createdAt).toLocaleString()}</strong><small>{version.author || '未知设备'} · {formatSize(version.size)}</small></div><div className="history-actions">{version.isCurrent ? <span className="default-tag">当前</span> : <><button onClick={() => startCompare(version)}>对比</button><button onClick={() => onRestore(version)}>恢复</button></>}</div></li>)}</ul>
    )}
  </div>;
}
