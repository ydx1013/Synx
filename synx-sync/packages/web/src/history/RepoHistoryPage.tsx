import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, CornerUpLeft, History as HistoryIcon, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { RepoCommitSummary, RepoDiffResponse, RepoGcResponse, RepoRestorePreview } from '@synx/shared';
import { authApi, notesApi, repoApi } from '../api/queries';
import { ApiError } from '../api/client';
import { Dialog } from '../components/Dialog';
import { buildLineDiff, type DiffLine } from '../notes/lineDiff';

const decode = (value: ArrayBuffer) => new TextDecoder().decode(value);
const fmtTime = (ts: number) => new Date(ts).toLocaleString();
const kindLabel = (kind: RepoCommitSummary['kind']) =>
  kind === 'initial' ? '初始快照' : kind === 'restore' ? '恢复' : '同步';
const opIcon = (op: string) =>
  op === 'add' ? <Plus size={14} /> : op === 'delete' ? <Trash2 size={14} /> : op === 'rename' ? <RefreshCw size={14} /> : <Pencil size={14} />;

// 与插件历史面板一致：仅这些扩展名可显示内容差异，其余按二进制处理
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml', 'csv']);
const isTextPath = (path: string) => TEXT_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');

// ── 时间线分组：年 → 月 → 日 → 提交（allCommits 从 HEAD 倒序） ──

interface DayGroup {
  key: string;
  year: number;
  month: number;
  date: number;
  commits: RepoCommitSummary[];
}
interface MonthGroup {
  key: string;
  year: number;
  month: number;
  days: DayGroup[];
}
interface YearGroup {
  key: string;
  year: number;
  months: MonthGroup[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 超过该时间的年份/月份默认折叠（该折叠的折叠：最近 1 年、最近 30 天完整展开） */
const YEAR_COLLAPSE_MS = 366 * DAY_MS;
const MONTH_COLLAPSE_MS = 30 * DAY_MS;

function buildGroups(commits: RepoCommitSummary[]): YearGroup[] {
  const years: YearGroup[] = [];
  const yearMap = new Map<string, YearGroup>();
  const monthMap = new Map<string, MonthGroup>();
  const dayMap = new Map<string, DayGroup>();
  for (const commit of commits) {
    const d = new Date(commit.createdAt);
    const yk = String(d.getFullYear());
    const mk = `${yk}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dk = `${mk}-${String(d.getDate()).padStart(2, '0')}`;
    let year = yearMap.get(yk);
    if (!year) {
      year = { key: yk, year: d.getFullYear(), months: [] };
      yearMap.set(yk, year);
      years.push(year);
    }
    let month = monthMap.get(mk);
    if (!month) {
      month = { key: mk, year: d.getFullYear(), month: d.getMonth(), days: [] };
      monthMap.set(mk, month);
      year.months.push(month);
    }
    let day = dayMap.get(dk);
    if (!day) {
      day = { key: dk, year: d.getFullYear(), month: d.getMonth(), date: d.getDate(), commits: [] };
      dayMap.set(dk, day);
      month.days.push(day);
    }
    day.commits.push(commit);
  }
  return years;
}

const yearCommitCount = (year: YearGroup) => year.months.reduce((n, m) => n + m.days.reduce((x, d) => x + d.commits.length, 0), 0);
const monthCommitCount = (month: MonthGroup) => month.days.reduce((n, d) => n + d.commits.length, 0);
const dayLabel = (day: DayGroup) => `${day.month + 1}月${day.date}日`;

/** 全库提交时间线（按年月日折叠）+ 任意两提交 diff（GitHub 式行级对比）+ 全库恢复 + 垃圾回收 */
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
  // 对比双方变化时收起已展开的文件 diff，避免展示过时内容
  useEffect(() => { setExpandedPath(null); }, [fromId, toId]);

  // ── 时间线分组与折叠状态 ──
  const groups = useMemo(() => buildGroups(allCommits), [allCommits]);
  /** 未手动切换的分组按时间远近走默认折叠规则（新加载的更早分组自动折叠） */
  const defaultCollapsed = useMemo(() => {
    const map: Record<string, boolean> = {};
    const now = Date.now();
    for (const year of groups) {
      if (now - new Date(year.year, 0, 1).getTime() > YEAR_COLLAPSE_MS) map[year.key] = true;
      for (const month of year.months) {
        if (now - new Date(month.year, month.month, 1).getTime() > MONTH_COLLAPSE_MS) map[month.key] = true;
      }
    }
    return map;
  }, [groups]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) =>
    setCollapsed(prev => ({ ...prev, [key]: !(prev[key] ?? defaultCollapsed[key] ?? false) }));
  const isCollapsed = (key: string) => collapsed[key] ?? defaultCollapsed[key] ?? false;

  // ── 展开文件的行级 diff（GitHub 式） ──
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<{ lines: DiffLine[] | null; error: string | null } | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const d = diff.data as RepoDiffResponse | undefined;
  useEffect(() => {
    if (!expandedPath) { setFileDiff(null); setFileDiffLoading(false); return; }
    const change = d?.changes.find(c => `${c.operation}:${c.path}` === expandedPath);
    if (!change || !fromId || !toId) { setFileDiff(null); return; }
    let cancelled = false;
    setFileDiffLoading(true);
    setFileDiff(null);
    void (async () => {
      try {
        if (!isTextPath(change.path)) {
          setFileDiff({ lines: null, error: '二进制文件，无法显示内容差异' });
          return;
        }
        // add：旧提交无该文件；delete：新提交无该文件；rename：旧路径取 previousPath
        const oldPath = change.operation === 'rename' ? change.previousPath ?? change.path : change.path;
        const [oldRes, newRes] = await Promise.all([
          change.operation === 'add' ? null : notesApi.get(storageId, syncFolder, oldPath, undefined, fromId),
          change.operation === 'delete' ? null : notesApi.get(storageId, syncFolder, change.path, undefined, toId),
        ]);
        if (cancelled) return;
        const oldText = oldRes ? decode(oldRes.content) : '';
        const newText = newRes ? decode(newRes.content) : '';
        setFileDiff({ lines: buildLineDiff(oldText, newText), error: null });
      } catch (error) {
        if (cancelled) return;
        setFileDiff({ lines: null, error: error instanceof Error ? error.message : '对比失败' });
      } finally {
        if (!cancelled) setFileDiffLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [expandedPath, d, fromId, toId, storageId, syncFolder]);

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

  // 重建历史索引
  const [rebuildStatus, setRebuildStatus] = useState('');
  const [rebuildLoading, setRebuildLoading] = useState(false);
  const runRebuild = async () => {
    setRebuildLoading(true);
    setRebuildStatus('正在重建...');
    try {
      const result = await repoApi.rebuildIndex(storageId, syncFolder);
      setRebuildStatus(`索引重建完成：已索引 ${result.indexed} 个提交`);
      firstPage.refetch();
    } catch (e) {
      setRebuildStatus(e instanceof ApiError ? e.message : '重建失败');
    } finally {
      setRebuildLoading(false);
    }
  };

  if (me.isLoading) return <div className="center-state">正在加载…</div>;
  if (!storageId) return <div className="center-state"><HistoryIcon size={48} /><h1>设置默认存储</h1><p>需要先在设置中配置默认存储，才能查看提交历史。</p></div>;

  return <div className="repo-history-page">
    <header className="repo-history-header">
      <Link className="repo-history-back" to="/notes"><ArrowLeft size={17} />返回笔记</Link>
      <div><h1>提交历史</h1><small>{syncFolder} · {allCommits.length} 个提交{firstPage.isLoading ? '（加载中…）' : ''}</small></div>
      <div className="repo-history-actions">
        <button className="secondary-button" onClick={runRebuild} disabled={rebuildLoading}><Loader2 size={15} className={rebuildLoading ? 'spin' : undefined} />重建索引</button>
        <button className="danger-button" onClick={runGc} disabled={gcRunning}><Loader2 size={15} className={gcRunning ? 'spin' : undefined} />清理未引用对象</button>
      </div>
    </header>
    {rebuildStatus ? <div className="repo-history-banner">{rebuildStatus}</div> : null}
    {gcError ? <div className="repo-history-banner error">{gcError}</div> : null}
    {gcResult ? <div className="repo-history-banner">
      {`清理完成：删除内容对象 ${gcResult.deleted}${gcResult.deletedCommits > 0 ? `，裁剪历史提交 ${gcResult.deletedCommits}` : ''}${gcResult.more ? '（尚未处理完，可再次清理）' : ''}`}
    </div> : null}

    <div className="repo-history-layout">
      <aside className="repo-history-timeline">
        {groups.map(year => {
          const yearCollapsed = isCollapsed(year.key);
          return <div className="repo-timeline-group" key={year.key}>
            <button className={`repo-timeline-head year${yearCollapsed ? '' : ' open'}`} onClick={() => toggleGroup(year.key)}>
              {yearCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <strong>{year.year} 年</strong>
              <small>{yearCommitCount(year)} 个提交</small>
            </button>
            {!yearCollapsed ? <div className="repo-timeline-children">
              {year.months.map(month => {
                const monthCollapsed = isCollapsed(month.key);
                return <div className="repo-timeline-group" key={month.key}>
                  <button className={`repo-timeline-head month${monthCollapsed ? '' : ' open'}`} onClick={() => toggleGroup(month.key)}>
                    {monthCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <strong>{month.month + 1} 月</strong>
                    <small>{monthCommitCount(month)} 个提交</small>
                  </button>
                  {!monthCollapsed ? <div className="repo-timeline-children">
                    {month.days.map(day => {
                      const dayCollapsed = isCollapsed(day.key);
                      return <div className="repo-timeline-group" key={day.key}>
                        <button className={`repo-timeline-head day${dayCollapsed ? '' : ' open'}`} onClick={() => toggleGroup(day.key)}>
                          {dayCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                          <strong>{dayLabel(day)}</strong>
                          <small>{day.commits.length} 个提交</small>
                        </button>
                        {!dayCollapsed ? <ul className="repo-commit-list">
                          {day.commits.map(commit => <li key={commit.commitId}>
                            <button className={toId === commit.commitId ? 'active' : ''} onClick={() => { setToId(commit.commitId); setFromId(allCommits[allCommits.findIndex(c => c.commitId === commit.commitId) + 1]?.commitId ?? ''); }}>
                              <span className="repo-commit-dot">{commit === allCommits[0] ? 'HEAD' : ''}</span>
                              <span className="repo-commit-copy">
                                <strong>{fmtTime(commit.createdAt)}</strong>
                                <small>{kindLabel(commit.kind)}{commit.message ? ` · ${commit.message}` : ''} · {commit.author ?? '未知设备'} · {commit.changeCount} 项变更</small>
                              </span>
                            </button>
                          </li>)}
                        </ul> : null}
                      </div>;
                    })}
                  </div> : null}
                </div>;
              })}
            </div> : null}
          </div>;
        })}
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
            : <ul className="repo-diff-list">{d?.changes.map((change, idx) => {
                const key = `${change.operation}:${change.path}`;
                const open = expandedPath === key;
                const displayPath = change.operation === 'rename' ? `${change.previousPath} → ${change.path}` : change.path;
                const adds = fileDiff?.lines?.filter(l => l.type === 'add').length ?? 0;
                const removes = fileDiff?.lines?.filter(l => l.type === 'remove').length ?? 0;
                return <li key={`${change.path}-${idx}`}>
                  <div className={`repo-diff-row${open ? ' expanded' : ''}`} onClick={() => setExpandedPath(open ? null : key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedPath(open ? null : key); } }} role="button" tabIndex={0}>
                    <span className={`diff-op ${change.operation}`}>{opIcon(change.operation)}{change.operation}</span>
                    <span className="diff-path">{displayPath}</span>
                    {change.size != null ? <small>{change.size} B</small> : null}
                    {open ? <ChevronDown size={14} className="repo-diff-caret" /> : <ChevronRight size={14} className="repo-diff-caret" />}
                  </div>
                  {open ? <div className="repo-file-diff">
                    {fileDiffLoading ? <div className="repo-file-diff-empty">正在加载内容差异…</div>
                      : fileDiff?.error ? <div className="repo-file-diff-empty">{fileDiff.error}</div>
                      : fileDiff?.lines ? <>
                          <div className="repo-file-diff-head"><strong>{displayPath}</strong><span className="repo-file-diff-stat">+{adds} −{removes}</span></div>
                          {adds + removes === 0 ? <div className="repo-file-diff-empty">内容相同（仅元数据或移动）</div>
                            : <div className="diff-view">{fileDiff.lines.map((line, li) => (
                                <div key={li} className={`diff-line is-${line.type}`}>
                                  <span className="diff-number">{line.oldLine ?? ''}</span>
                                  <span className="diff-number">{line.newLine ?? ''}</span>
                                  <span className="diff-marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
                                  <code className="diff-text">{line.text || ' '}</code>
                                </div>))}</div>}
                        </>
                      : null}
                  </div> : null}
                </li>;
              })}</ul>}
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
