// 笔记应用：印象笔记风格的远程 Markdown 阅读 / 编辑 / 版本管理。
// 由 scripts/build.mjs 使用 esbuild 打包为 assets/dist/notes.bundle.js。
import { api, requireSession } from './app.js';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import DOMPurify from 'dompurify';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

const state = {
  storageId: '',
  syncFolder: '',
  files: [],
  current: null,
  currentText: '',
  openedVersionId: '',
  dirty: false,
  editMode: false,
  activeFolder: '',
  historyVisible: false,
  history: [],
  preview: null,
};

function $id(id) {
  return document.getElementById(id);
}

const els = {
  storageSelect: $id('storage-select'),
  syncFolder: $id('sync-folder'),
  loadFiles: $id('load-files'),
  newNote: $id('new-note'),
  folderTree: $id('folder-tree'),
  folderTitle: $id('folder-title'),
  noteList: $id('note-list'),
  editorPath: $id('editor-path'),
  toggleMode: $id('toggle-mode'),
  saveNote: $id('save-note'),
  historyToggle: $id('history-toggle'),
  renameNote: $id('rename-note'),
  deleteNote: $id('delete-note'),
  status: $id('status'),
  editorContainer: $id('editor-container'),
  historyPanel: $id('history-panel'),
  historyList: $id('history-list'),
  historyClose: $id('history-close'),
};

let editor = null;

// ── 工具 ──

function storageHeaders() {
  return { 'X-Storage-Id': state.storageId, 'X-Sync-Folder': state.syncFolder };
}

function decodeBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function isMarkdown(path) {
  return /\.(?:md|markdown)$/i.test(path);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

function span(text, cls) {
  const el = document.createElement('span');
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function loadingItem(text) {
  const li = document.createElement('li');
  li.className = 'loading-item';
  li.textContent = text;
  return li;
}

function showStatus(message, kind = 'info') {
  els.status.textContent = message;
  els.status.dataset.kind = kind;
  els.status.hidden = false;
}

// ── 存储与文件加载 ──

async function loadStorages() {
  try {
    const { storages } = await api('/api/storage');
    els.storageSelect.replaceChildren();
    if (storages.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '请先在控制台添加存储';
      opt.disabled = true;
      els.storageSelect.append(opt);
      return;
    }
    for (const s of storages) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.type.toUpperCase()})`;
      els.storageSelect.append(opt);
    }
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '加载存储失败', 'error');
  }
}

async function loadFiles() {
  state.storageId = els.storageSelect.value;
  state.syncFolder = els.syncFolder.value.trim().replace(/\/+$/, '') + '/';
  if (!state.storageId || !state.syncFolder || state.syncFolder === '/') {
    showStatus('请选择存储并填写同步文件夹', 'error');
    return;
  }
  els.noteList.replaceChildren(loadingItem('加载文件…'));
  try {
    const { files } = await api('/api/list', { headers: storageHeaders() });
    state.files = files;
    renderTree();
    renderNoteList();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '加载文件列表失败', 'error');
  }
}

// ── 目录树 ──

function buildTree() {
  const root = { name: '', path: '', children: new Map(), notes: [] };
  for (const f of state.files) {
    if (!isMarkdown(f.path)) continue;
    const parts = f.path.split('/');
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, path: part, children: new Map(), notes: [] });
      }
      node = node.children.get(part);
    }
    node.notes.push(f);
  }
  // 填充子节点 path
  const fill = (node) => {
    for (const child of node.children.values()) {
      child.path = node.path ? `${node.path}/${child.name}` : child.name;
      fill(child);
    }
  };
  fill(root);
  return root;
}

function renderTree() {
  const root = buildTree();
  els.folderTree.replaceChildren();
  const allItem = document.createElement('div');
  allItem.className = 'tree-item tree-root';
  allItem.textContent = '全部笔记';
  allItem.dataset.folder = '';
  allItem.addEventListener('click', () => selectFolder(''));
  els.folderTree.append(allItem);
  for (const child of root.children.values()) els.folderTree.append(renderTreeNode(child));
  markActiveFolder();
}

function renderTreeNode(node) {
  const wrapper = document.createElement('div');
  const item = document.createElement('div');
  item.className = 'tree-item';
  item.textContent = `▸ ${node.name}`;
  item.dataset.folder = node.path;
  item.addEventListener('click', () => selectFolder(node.path));
  wrapper.append(item);
  const children = [...node.children.values()];
  if (children.length > 0) {
    const sub = document.createElement('div');
    sub.className = 'tree-children';
    for (const child of children) sub.append(renderTreeNode(child));
    wrapper.append(sub);
  }
  return wrapper;
}

function markActiveFolder() {
  document.querySelectorAll('.tree-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.folder === state.activeFolder);
  });
}

function selectFolder(path) {
  state.activeFolder = path;
  renderNoteList();
  markActiveFolder();
}

// ── 笔记列表 ──

function notesInFolder(folderPath) {
  const prefix = folderPath ? `${folderPath}/` : '';
  return state.files
    .filter((f) => isMarkdown(f.path) && f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function renderNoteList() {
  const notes = notesInFolder(state.activeFolder);
  els.folderTitle.textContent = state.activeFolder ? `笔记 · ${state.activeFolder}` : '全部笔记';
  els.noteList.replaceChildren();
  if (notes.length === 0) {
    els.noteList.append(loadingItem('没有笔记。'));
    return;
  }
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'note-item';
    li.dataset.path = note.path;
    const name = document.createElement('span');
    name.className = 'note-name';
    name.textContent = note.path.split('/').pop();
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = formatDate(note.mtime);
    li.append(name, meta);
    li.addEventListener('click', () => openNote(note));
    els.noteList.append(li);
  }
}

// ── 打开 / 渲染 ──

async function openNote(file) {
  state.current = file;
  state.openedVersionId = file.versionId;
  state.dirty = false;
  state.preview = null;
  setEditMode(false);
  setToolbar(true);
  els.editorPath.value = file.path;
  try {
    const params = new URLSearchParams({ path: file.path });
    if (file.fileUuid) params.set('fileUuid', file.fileUuid);
    const { content } = await api(`/api/get?${params.toString()}`, { headers: storageHeaders() });
    state.currentText = decodeBase64(content);
    renderEditor();
    loadHistory();
    els.status.hidden = true;
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '加载笔记失败', 'error');
  }
}

function renderEditor() {
  destroyEditor();
  if (state.preview) {
    renderReadonly(state.preview.content);
    return;
  }
  if (state.editMode) createEditor(state.currentText);
  else renderReadonly(state.currentText);
}

function renderEmpty() {
  destroyEditor();
  const template = document.getElementById('empty-editor-template');
  els.editorContainer.replaceChildren(template.content.cloneNode(true));
}

function setToolbar(visible) {
  for (const id of ['toggle-mode', 'save-note', 'history-toggle', 'rename-note', 'delete-note']) {
    $id(id).hidden = !visible;
  }
  if (!visible) {
    els.toggleMode.hidden = true;
    els.saveNote.hidden = true;
    els.renameNote.hidden = true;
    els.deleteNote.hidden = true;
    els.historyToggle.hidden = true;
  }
}

function setToolbarPreview(preview) {
  els.toggleMode.hidden = preview;
  els.saveNote.hidden = preview;
  els.renameNote.hidden = preview;
  els.deleteNote.hidden = preview;
  els.historyToggle.hidden = false;
}

// ── Markdown 渲染 ──

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
}).use(taskLists, { enabled: true, label: true });

function renderMarkdown(text) {
  const html = md.render(preprocessWiki(text));
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    ADD_TAGS: ['input'],
  });
}

function preprocessWiki(text) {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line
        .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g, (_m, target) => `![](${target.trim()})`)
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => `[${label || target.trim()}](${target.trim()})`);
    })
    .join('\n');
}

function renderReadonly(text) {
  els.editorContainer.replaceChildren();
  const article = document.createElement('article');
  article.className = 'markdown-body';
  article.innerHTML = renderMarkdown(text);
  els.editorContainer.append(article);
  hydrateImages(article);
}

// ── 图片资源 ──

function resolveResource(src) {
  if (!state.current) return src;
  const slash = state.current.path.lastIndexOf('/');
  const dir = slash >= 0 ? state.current.path.slice(0, slash + 1) : '';
  const parts = [];
  for (const seg of (dir + src).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function mimeFor(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

async function loadResource(path) {
  const params = new URLSearchParams({ path });
  const headers = storageHeaders();
  const token = localStorage.getItem('synx-token');
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/get?${params.toString()}`, { headers });
  if (!res.ok) throw new Error(`资源加载失败 (${res.status})`);
  const data = await res.json();
  const binary = atob(data.content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeFor(path) });
}

async function hydrateImages(root) {
  const images = root.querySelectorAll('img');
  for (const img of images) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:|blob:)/.test(src)) continue;
    const rel = resolveResource(src);
    try {
      const blob = await loadResource(rel);
      img.src = URL.createObjectURL(blob);
    } catch {
      const fallback = document.createElement('span');
      fallback.className = 'img-fallback';
      fallback.textContent = `（图片加载失败：${rel}）`;
      img.replaceWith(fallback);
    }
  }
}

// ── CodeMirror 编辑 ──

function createEditor(text) {
  els.editorContainer.replaceChildren();
  const container = document.createElement('div');
  container.className = 'cm-wrap';
  els.editorContainer.append(container);
  editor = new EditorView({
    doc: text,
    parent: container,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) markDirty();
      }),
    ],
  });
  editor.focus();
}

function destroyEditor() {
  if (editor) {
    editor.destroy();
    editor = null;
  }
}

function syncFromEditor() {
  if (editor) state.currentText = editor.state.doc.toString();
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    showStatus('有未保存的修改', 'info');
  }
}

function setEditMode(edit) {
  state.editMode = edit;
  els.toggleMode.textContent = edit ? '阅读' : '编辑';
}

function toggleMode() {
  if (state.preview) return;
  if (state.editMode) {
    syncFromEditor();
    setEditMode(false);
    renderEditor();
  } else {
    setEditMode(true);
    renderEditor();
  }
}

// ── 保存 ──

async function saveNote() {
  if (!state.current) return;
  syncFromEditor();
  const body = {
    path: state.current.path,
    fileUuid: state.current.fileUuid ?? undefined,
    mtime: Date.now(),
    content: encodeBase64(state.currentText),
    author: 'web',
    baseVersionId: state.openedVersionId,
  };
  els.saveNote.disabled = true;
  try {
    const { version } = await api('/api/put', { method: 'POST', body: JSON.stringify(body), headers: storageHeaders() });
    state.openedVersionId = version.versionId;
    state.current = { ...state.current, versionId: version.versionId, size: version.size, mtime: version.mtime, hash: version.hash };
    state.dirty = false;
    showStatus('已保存', 'success');
    loadHistory();
    refreshFiles();
  } catch (error) {
    if (error.status === 409) showStatus('远端已被其他设备修改，保存被拒绝。请重新打开后合并你的更改。', 'error');
    else if (error.status === 410) showStatus('该笔记已在其他设备被删除，保存被拒绝。', 'error');
    else showStatus(error instanceof Error ? error.message : '保存失败', 'error');
  } finally {
    els.saveNote.disabled = false;
  }
}

// ── 新建 / 重命名 / 删除 ──

async function createNote() {
  const defaultPath = state.activeFolder ? `${state.activeFolder}/未命名.md` : '未命名.md';
  const rel = prompt('新笔记路径（.md）', defaultPath);
  if (!rel) return;
  const path = rel.trim().replace(/^\/+/, '');
  if (!path) return;
  const finalPath = isMarkdown(path) ? path : `${path}.md`;
  if (state.files.some((f) => f.path === finalPath)) {
    showStatus('该路径已存在', 'error');
    return;
  }
  const uuid = crypto.randomUUID();
  const content = encodeBase64(`<!-- synx-id:${uuid} -->\n\n`);
  const body = { path: finalPath, fileUuid: uuid, mtime: Date.now(), content, author: 'web' };
  try {
    const { version } = await api('/api/put', { method: 'POST', body: JSON.stringify(body), headers: storageHeaders() });
    await refreshFiles();
    const dir = finalPath.includes('/') ? finalPath.slice(0, finalPath.lastIndexOf('/')) : '';
    selectFolder(dir);
    await openNote({ path: finalPath, fileUuid: uuid, versionId: version.versionId, mtime: version.mtime, size: version.size, hash: version.hash, author: version.author });
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '新建失败', 'error');
  }
}

async function renameNote() {
  if (!state.current) return;
  const rel = prompt('新路径（.md）', state.current.path);
  if (!rel) return;
  const newPath = rel.trim().replace(/^\/+/, '');
  if (!newPath || newPath === state.current.path) return;
  if (state.files.some((f) => f.path === newPath && f.path !== state.current.path)) {
    showStatus('目标路径已存在', 'error');
    return;
  }
  syncFromEditor();
  const body = {
    path: newPath,
    fileUuid: state.current.fileUuid ?? undefined,
    mtime: Date.now(),
    content: encodeBase64(state.currentText),
    author: 'web',
    baseVersionId: state.openedVersionId,
  };
  try {
    const { version } = await api('/api/put', { method: 'POST', body: JSON.stringify(body), headers: storageHeaders() });
    state.current = { ...state.current, path: newPath, versionId: version.versionId, size: version.size, mtime: version.mtime, hash: version.hash };
    state.openedVersionId = version.versionId;
    state.dirty = false;
    els.editorPath.value = newPath;
    showStatus('已重命名', 'success');
    loadHistory();
    await refreshFiles();
  } catch (error) {
    if (error.status === 409) showStatus('远端已被其他设备修改，重命名被拒绝。', 'error');
    else showStatus(error instanceof Error ? error.message : '重命名失败', 'error');
  }
}

async function deleteNote() {
  if (!state.current) return;
  if (!confirm(`删除笔记「${state.current.path}」？历史版本会保留，可回滚。`)) return;
  const body = JSON.stringify({ path: state.current.path, fileUuid: state.current.fileUuid ?? undefined });
  try {
    await api('/api/file', { method: 'DELETE', body, headers: storageHeaders() });
    state.current = null;
    state.openedVersionId = '';
    state.preview = null;
    state.historyVisible = false;
    els.historyPanel.hidden = true;
    els.editorPath.value = '';
    setToolbar(false);
    renderEmpty();
    showStatus('已删除（历史已保留）', 'success');
    await refreshFiles();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '删除失败', 'error');
  }
}

// ── 历史与回滚 ──

async function loadHistory() {
  if (!state.current) return;
  try {
    const params = new URLSearchParams({ path: state.current.path });
    if (state.current.fileUuid) params.set('fileUuid', state.current.fileUuid);
    const { versions } = await api(`/api/history?${params.toString()}`, { headers: storageHeaders() });
    state.history = versions;
    if (state.historyVisible) renderHistory();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '加载历史失败', 'error');
  }
}

function renderHistory() {
  els.historyList.replaceChildren();
  if (!state.history || state.history.length === 0) {
    els.historyList.append(loadingItem('无历史版本。'));
    return;
  }
  for (const version of state.history) {
    const li = document.createElement('li');
    li.className = `version-item${version.isCurrent ? ' is-current' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'version-meta';
    meta.append(span(formatDate(version.createdAt)));
    if (version.isCurrent) meta.append(span('当前', 'tag-current'));
    meta.append(span(formatSize(version.size)));
    if (version.author) meta.append(span(version.author, 'version-author'));
    li.append(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.textContent = '预览';
    previewBtn.addEventListener('click', () => previewVersion(version));
    actions.append(previewBtn);
    if (!version.isCurrent) {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'secondary';
      restoreBtn.textContent = '恢复';
      restoreBtn.addEventListener('click', () => restoreVersion(version));
      actions.append(restoreBtn);
    }
    li.append(actions);
    els.historyList.append(li);
  }
}

async function previewVersion(version) {
  if (!state.current) return;
  try {
    const params = new URLSearchParams({ path: state.current.path, version: version.versionId });
    if (state.current.fileUuid) params.set('fileUuid', state.current.fileUuid);
    const { content } = await api(`/api/get?${params.toString()}`, { headers: storageHeaders() });
    state.preview = { content: decodeBase64(content), version };
    setToolbarPreview(true);
    els.editorPath.value = `${state.current.path} · 历史 ${formatDate(version.createdAt)}`;
    renderEditor();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '加载历史版本失败', 'error');
  }
}

async function restoreVersion(version) {
  if (!state.current) return;
  if (!confirm(`恢复 ${formatDate(version.createdAt)} 的版本为当前版本？`)) return;
  const body = JSON.stringify({ path: state.current.path, fileUuid: state.current.fileUuid ?? undefined, version: version.versionId });
  try {
    const { version: restored } = await api('/api/rollback', { method: 'POST', body, headers: storageHeaders() });
    state.openedVersionId = restored.versionId;
    state.current = { ...state.current, versionId: restored.versionId, size: restored.size, mtime: restored.mtime, hash: restored.hash };
    const params = new URLSearchParams({ path: state.current.path });
    if (state.current.fileUuid) params.set('fileUuid', state.current.fileUuid);
    const { content } = await api(`/api/get?${params.toString()}`, { headers: storageHeaders() });
    state.currentText = decodeBase64(content);
    state.preview = null;
    state.dirty = false;
    setEditMode(false);
    setToolbar(true);
    els.editorPath.value = state.current.path;
    renderEditor();
    loadHistory();
    refreshFiles();
    showStatus('已恢复', 'success');
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '恢复失败', 'error');
  }
}

function toggleHistory() {
  state.historyVisible = !state.historyVisible;
  els.historyPanel.hidden = !state.historyVisible;
  if (state.historyVisible) {
    loadHistory();
  } else {
    closeHistoryPreview();
  }
}

function closeHistoryPreview() {
  if (state.preview && state.current) {
    state.preview = null;
    setToolbar(true);
    els.editorPath.value = state.current.path;
    renderEditor();
  }
}

// ── 刷新 ──

async function refreshFiles() {
  try {
    const { files } = await api('/api/list', { headers: storageHeaders() });
    state.files = files;
    renderTree();
    renderNoteList();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '刷新文件失败', 'error');
  }
}

// ── 初始化 ──

function bindEvents() {
  els.loadFiles.addEventListener('click', loadFiles);
  els.newNote.addEventListener('click', createNote);
  els.toggleMode.addEventListener('click', toggleMode);
  els.saveNote.addEventListener('click', saveNote);
  els.historyToggle.addEventListener('click', toggleHistory);
  els.historyClose.addEventListener('click', toggleHistory);
  els.renameNote.addEventListener('click', renameNote);
  els.deleteNote.addEventListener('click', deleteNote);
}

if (typeof document !== 'undefined') {
  requireSession();
  loadStorages();
  bindEvents();
  renderEmpty();

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
