import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, CornerUpLeft, History as HistoryIcon, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { RepoCommitSummary, RepoDiffResponse, RepoGcResponse, RepoRestorePreview } from '@synx/shared';
import { authApi, repoApi } from '../api/queries';
import { ApiError } from '../api/client';
import { Dialog } from '../components/Dialog';

const fmtTime = (ts: number) => new Date(ts).toLocaleString();
const kindLabel = (kind: RepoCommitSummary['kind']) =>
  kind === 'initial' ? '初始快照' : kind === 'restore' ? '恢复' : '同步';
const opIcon = (op: string) =>
  op === 'add' ? <Plus size={14} /> : op === 'delete' ? <Trash2 size={14} /> : op === 'rename' ? <RefreshCw size={14} /> : <Pencil size={14} />;

/** 全库提交时间线 + 任意两提交 diff + 全库恢复（dryRun 预览确认）+ 垃圾回收 */
export function RepoHistoryPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const storageId = me.data?.preferences.defaultStorageId ?? '';
  const syncFolder = me.data?.preferences.defaultSyncFolder ?? '';

  // 提交时间线：分页累积（HEAD → 更早）
  const [allCommits, setAllCommits] = useState<RepoCommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const firstPage = useQuery({
    queryKey: ['repo-commits', storageId, syncFolder],
    queryFn: async () => {
      const res = await repoApi.commits(storageId, syncFolder);
      setAllCommits(res.commits);
      setCursor(res.cursor);
      return res;
    },
    enabled: Boolean(storageId && syncFolder),
  });
  const loadMore = async () => {
    if (!cursor) return;
    const res = await repoApi.commits(storageId, syncFolder, cursor);
    setAllCommits(prev => [...prev, ...res.commits]);
    setCursor(res.cursor);
  };

  // 任意两提交 diff：默认 HEAD(新) → 父提交(旧)
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  useEffect(() => {
    if (allCommits.length > 0) {
      setToId(allCommits[0].commitId);
      setFromId(allCommits.length > 1 ? allCommits[1].commitId : '');
    }
  }, [allCommits.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const diff = useQuery({
    queryKey: ['repo-diff', storageId, syncFolder, fromId, toId],
    queryFn: () => repoApi.diff(storageId, syncFolder, toId, fromId),
    enabled: Boolean(storageId && syncFolder && fromId && toId && fromId !== toId),
  });

  // 全库恢复：dryRun 预览 → 确认
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [preview, setPreview] = useState<RepoRestorePreview | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const openRestoreConfirm = async () => {
    setRestoreOpen(true);
    setRestoreError(null);
    setPreview(null);
    try {
      const res = await repoApi.restore(storageId, syncFolder, { toCommitId: toId, dryRun: true, author: 'web' });
      setPreview(res.preview ?? null);
    } catch (e) {
      setRestoreError(e instanceof ApiError ? e.message : '恢复预览失败');
    }
  };
  const confirmRestore = async () => {
    setRestoring(true);
    try {
      await repoApi.restore(storageId, syncFolder, { toCommitId: toId, dryRun: false, author: 'web' });
      setRestoreOpen(false);
      void firstPage.refetch();
    } catch (e) {
      setRestoreError(e instanceof ApiError ? e.message : '恢复失败，HEAD 可能已被推进');
    } finally {
      setRestoring(false);
    }
  };

  // 垃圾回收：物理清理未引用对象
  const [gcResult, setGcResult] = useState<RepoGcResponse | null>(null);
  const [gcError, setGcError] = useState<string | null>(null);
  const [gcRunning, setGcRunning] = useState(false);
  const runGc = async () => {
    setGcRunning(true);
    setGcError(null);
    setGcResult(null);
    try {
      setGcResult(await repoApi.gc(storageId, syncFolder));
    } catch (e) {
      setGcError(e instanceof ApiError ? e.message : '清理失败');
    } finally {
      setGcRunning(false);
    }
  };

  if (me.isLoading) return <div className="center-state">正在加载…</div>;
  if (!storageId) return <div className="center-state"><HistoryIcon size={48} /><h1>设置默认存储</h1><p>需要先在设置中配置默认存储，才能查看提交历史。</p></div>;

  const d = diff.data as RepoDiffResponse | undefined;
  return <div className="repo-history-page">
    <header className="repo-history-header">
      <Link className="repo-history-back" to="/notes"><ArrowLeft size={17} />返回笔记</Link>
      <div><h1>提交历史</h1><small>{syncFolder} · {allCommits.length} 个提交{firstPage.isLoading ? '（加载中…）' : ''}</small></div>
      <button className="danger-button" onClick={runGc} disabled={gcRunning}><Loader2 size={15} className={gcRunning ? 'spin' : undefined} />清理未引用对象</button>
    </header>
    {gcError ? <div className="repo-history-banner error">{gcError}</div> : null}
    {gcResult ? <div className="repo-history-banner">
      {`清理完成：删除内容对象 ${gcResult.deleted}${gcResult.deletedCommits > 0 ? `，裁剪历史提交 ${gcResult.deletedCommits}` : ''}${gcResult.more ? '（尚未处理完，可再次清理）' : ''}`}
    </div> : null}

    <div className="repo-history-layout">
      <aside className="repo-history-timeline">
        <ul>
          {allCommits.map((commit, i) => <li key={commit.commitId}>
            <button className={toId === commit.commitId ? 'active' : ''} onClick={() => { setToId(commit.commitId); setFromId(allCommits[i + 1]?.commitId ?? ''); }}>
              <span className="repo-commit-dot">{i === 0 ? 'HEAD' : ''}</span>
              <span className="repo-commit-copy">
                <strong>{fmtTime(commit.createdAt)}</strong>
                <small>{kindLabel(commit.kind)}{commit.message ? ` · ${commit.message}` : ''} · {commit.author ?? '未知设备'} · {commit.changeCount} 项变更</small>
              </span>
            </button>
          </li>)}
        </ul>
        {cursor ? <button className="repo-history-more" onClick={loadMore}>加载更早提交</button> : null}
        {firstPage.isError ? <div className="repo-history-banner error">加载提交列表失败</div> : null}
      </aside>

      <section className="repo-history-diff">
        <div className="repo-diff-controls">
          <label className="repo-diff-select"><span>基线（旧）</span>
            <select value={fromId} onChange={e => setFromId(e.target.value)}>
              {!fromId ? <option value="">（最早加载的提交）</option> : null}
              {allCommits.map(c => <option key={c.commitId} value={c.commitId}>{fmtTime(c.createdAt)}</option>)}
            </select>
          </label>
          <span className="repo-diff-arrow">→</span>
          <label className="repo-diff-select"><span>目标（新）</span>
            <select value={toId} onChange={e => setToId(e.target.value)}>
              {allCommits.map(c => <option key={c.commitId} value={c.commitId}>{fmtTime(c.createdAt)}</option>)}
            </select>
          </label>
          <button onClick={openRestoreConfirm} disabled={!toId}><CornerUpLeft size={14} />恢复到该提交</button>
        </div>
        <div className="repo-diff-stats">
          {d ? <>{d.added > 0 ? <span className="stat add">+{d.added} 新增</span> : null}{d.modified > 0 ? <span className="stat mod">~{d.modified} 修改</span> : null}{d.renamed > 0 ? <span className="stat rename">⇄{d.renamed} 重命名</span> : null}{d.deleted > 0 ? <span className="stat del">-{d.deleted} 删除</span> : null}{d.added + d.modified + d.renamed + d.deleted === 0 ? <span>两个提交内容相同</span> : null}</> : null}
        </div>
        <div className="repo-diff-body">
          {!fromId || !toId ? <div className="repo-diff-empty">加载更多提交后，选择两个提交进行对比</div>
            : fromId === toId ? <div className="repo-diff-empty">请选择两个不同的提交</div>
            : diff.isLoading ? <div className="repo-diff-empty">正在对比…</div>
            : diff.isError ? <div className="repo-diff-empty">{diff.error instanceof ApiError ? diff.error.message : '对比失败'}</div>
            : d && d.changes.length === 0 ? <div className="repo-diff-empty">两个提交之间没有差异</div>
            : <ul className="repo-diff-list">{d?.changes.map((change, idx) => <li key={`${change.path}-${idx}`}>
                <span className={`diff-op ${change.operation}`}>{opIcon(change.operation)}{change.operation}</span>
                <span className="diff-path">{change.operation === 'rename' ? `${change.previousPath} → ${change.path}` : change.path}</span>
                {change.size != null ? <small>{change.size} B</small> : null}
              </li>)}</ul>}
        </div>
      </section>
    </div>

    <Dialog open={restoreOpen} onOpenChange={setRestoreOpen} title="恢复到该提交">
      <p>将把整个仓库恢复到选定的历史提交，生成一个新的「恢复」提交并推进到 HEAD。当前最新内容不会丢失（仍保留在历史中）。</p>
      {preview ? <p>影响 {preview.added + preview.modified + preview.renamed + preview.deleted} 个文件：{preview.added} 新增、{preview.modified} 修改、{preview.renamed} 重命名、{preview.deleted} 删除。</p> : null}
      {restoreError ? <p className="danger-text">{restoreError}</p> : null}
      <div className="dialog-actions"><button onClick={() => setRestoreOpen(false)}>取消</button><button className="danger-button" onClick={confirmRestore} disabled={restoring || !preview}><Loader2 size={15} className={restoring ? 'spin' : undefined} />确认恢复</button></div>
    </Dialog>
  </div>;
}
