/**
 * D1 提交索引层：加速 listCommits / fileHistory。
 *
 * 原则：D1 只存投影/缓存，仓库数据本身在用户存储的文本对象里。
 * D1 丢失或不一致时降级到链表扫描，并可从用户存储重建。
 */
import type { RepoChange, RepoCommit, RepoCommitSummary, WorkerFs } from '@synx/shared';

const REPO_DIR = '.synx/repo';

// ── 写入 ──

/**
 * 把一个提交写入 D1 索引。finalizeCommit 成功后调用。
 * 幂等：INSERT OR REPLACE，重复调用安全。
 */
export async function writeCommitIndex(
  db: D1Database,
  userId: string,
  storageId: string,
  syncFolder: string,
  commit: RepoCommit,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT OR REPLACE INTO commit_index
        (user_id, storage_id, sync_folder, commit_id, parent_commit_id, generation, created_at, kind, author, message, change_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId, storageId, syncFolder, commit.commitId,
      commit.parentCommitId, commit.generation, commit.createdAt,
      commit.kind, commit.author, commit.message, commit.changeCount,
    ),
  ];

  // 每个变更的文件写一行 file_history_index
  for (const change of commit.changes) {
    stmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO file_history_index
          (user_id, storage_id, sync_folder, file_identity, commit_id, created_at, change_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId, storageId, syncFolder,
        change.identity, commit.commitId, commit.createdAt,
        JSON.stringify(change),
      ),
    );
  }

  await db.batch(stmts);
}

// ── 查询 ──

interface CommitIndexRow {
  commit_id: string;
  parent_commit_id: string | null;
  generation: number;
  created_at: number;
  kind: string;
  author: string | null;
  message: string;
  change_count: number;
}

function rowToSummary(row: CommitIndexRow): RepoCommitSummary {
  return {
    commitId: row.commit_id,
    parentCommitId: row.parent_commit_id,
    kind: row.kind as RepoCommitSummary['kind'],
    createdAt: row.created_at,
    author: row.author,
    message: row.message,
    changeCount: row.change_count,
  };
}

/**
 * 从 D1 查询提交列表（分页）。
 * cursor 是上一页最后一条的 commit_id；首次不传。
 * 返回 null 表示 D1 查询出错（调用方应降级到链表扫描）；
 * 返回 { commits: [], cursor: null } 表示 D1 可用但无数据（不需要降级）。
 */
export async function listCommitsViaD1(
  db: D1Database,
  userId: string,
  storageId: string,
  syncFolder: string,
  cursor: string | undefined,
  pageSize: number,
): Promise<{ commits: RepoCommitSummary[]; cursor: string | null } | null> {
  try {
    let query: string;
    let binds: unknown[];
    if (cursor) {
      query = `SELECT ci.commit_id, ci.parent_commit_id, ci.generation, ci.created_at, ci.kind, ci.author, ci.message, ci.change_count
               FROM commit_index ci
               WHERE ci.user_id = ? AND ci.storage_id = ? AND ci.sync_folder = ?
                 AND ci.created_at < (SELECT created_at FROM commit_index WHERE user_id = ? AND storage_id = ? AND sync_folder = ? AND commit_id = ?)
               ORDER BY ci.created_at DESC
               LIMIT ?`;
      binds = [userId, storageId, syncFolder, userId, storageId, syncFolder, cursor, pageSize];
    } else {
      query = `SELECT commit_id, parent_commit_id, generation, created_at, kind, author, message, change_count
               FROM commit_index
               WHERE user_id = ? AND storage_id = ? AND sync_folder = ?
               ORDER BY created_at DESC
               LIMIT ?`;
      binds = [userId, storageId, syncFolder, pageSize];
    }
    const result = await db.prepare(query).bind(...binds).all<CommitIndexRow>();
    if (!result.results || result.results.length === 0) return { commits: [], cursor: null };

    const commits = result.results.map(rowToSummary);
    const nextCursor = commits.length === pageSize ? commits[commits.length - 1].commitId : null;
    return { commits, cursor: nextCursor };
  } catch {
    return null;
  }
}

interface FileHistoryRow extends CommitIndexRow {
  change_json: string;
}

/**
 * 从 D1 查询单文件历史（分页）。
 * cursor 是上一页最后一条的 commit_id；首次不传。
 * 返回 null 表示 D1 查询出错（调用方应降级到链表扫描）；
 * 返回 { commits: [], changes: [], nextCursor: null } 表示 D1 可用但该文件无历史（不需要降级）。
 */
export async function fileHistoryViaD1(
  db: D1Database,
  userId: string,
  storageId: string,
  syncFolder: string,
  identity: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ commits: RepoCommitSummary[]; changes: RepoChange[]; nextCursor: string | null } | null> {
  try {
    let query: string;
    let binds: unknown[];
    if (cursor) {
      query = `SELECT ci.commit_id, ci.parent_commit_id, ci.generation, ci.created_at, ci.kind, ci.author, ci.message, ci.change_count,
                      fhi.change_json
               FROM file_history_index fhi
               JOIN commit_index ci ON ci.user_id = fhi.user_id AND ci.storage_id = fhi.storage_id AND ci.sync_folder = fhi.sync_folder AND ci.commit_id = fhi.commit_id
               WHERE fhi.user_id = ? AND fhi.storage_id = ? AND fhi.sync_folder = ? AND fhi.file_identity = ?
                 AND fhi.created_at < (SELECT created_at FROM file_history_index WHERE user_id = ? AND storage_id = ? AND sync_folder = ? AND file_identity = ? AND commit_id = ?)
               ORDER BY fhi.created_at DESC
               LIMIT ?`;
      binds = [userId, storageId, syncFolder, identity, userId, storageId, syncFolder, identity, cursor, limit];
    } else {
      query = `SELECT ci.commit_id, ci.parent_commit_id, ci.generation, ci.created_at, ci.kind, ci.author, ci.message, ci.change_count,
                      fhi.change_json
               FROM file_history_index fhi
               JOIN commit_index ci ON ci.user_id = fhi.user_id AND ci.storage_id = fhi.storage_id AND ci.sync_folder = fhi.sync_folder AND ci.commit_id = fhi.commit_id
               WHERE fhi.user_id = ? AND fhi.storage_id = ? AND fhi.sync_folder = ? AND fhi.file_identity = ?
               ORDER BY fhi.created_at DESC
               LIMIT ?`;
      binds = [userId, storageId, syncFolder, identity, limit];
    }
    const result = await db.prepare(query).bind(...binds).all<FileHistoryRow>();
    if (!result.results || result.results.length === 0) return { commits: [], changes: [], nextCursor: null };

    const commits: RepoCommitSummary[] = [];
    const changes: RepoChange[] = [];
    for (const row of result.results) {
      commits.push(rowToSummary(row));
      changes.push(JSON.parse(row.change_json) as RepoChange);
    }
    const nextCursor = commits.length === limit ? commits[commits.length - 1].commitId : null;
    return { commits, changes, nextCursor };
  } catch {
    return null;
  }
}

// ── 索引检测 ──

/**
 * 检查 D1 索引是否已覆盖当前 HEAD。
 * 返回 true 表示索引可用；false 表示需要重建或降级。
 */
export async function isIndexReady(
  db: D1Database,
  userId: string,
  storageId: string,
  syncFolder: string,
  headCommitId: string,
): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT 1 FROM commit_index WHERE user_id = ? AND storage_id = ? AND sync_folder = ? AND commit_id = ? LIMIT 1`,
    ).bind(userId, storageId, syncFolder, headCommitId).first();
    return !!row;
  } catch {
    return false;
  }
}

// ── 重建 ──

/**
 * 从用户存储重建 D1 索引。
 * 用 fs.list 一次性列出所有提交 key，然后并行 get（不串行），批量写入 D1。
 * 幂等：INSERT OR REPLACE，可安全重复调用。
 */
export async function rebuildCommitIndex(
  fs: WorkerFs,
  db: D1Database,
  userId: string,
  storageId: string,
  syncFolder: string,
): Promise<{ indexed: number }> {
  const prefix = `${syncFolder.replace(/\/+$/, '')}/${REPO_DIR}/commits/`;
  const keys = await fs.list(prefix);
  if (keys.length === 0) return { indexed: 0 };

  // 并行读取所有提交对象（不依赖链表顺序，可全并行）
  const BATCH = 25;
  const commits: RepoCommit[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (key) => {
        try {
          const raw = await fs.get(key);
          return JSON.parse(new TextDecoder().decode(raw)) as RepoCommit;
        } catch {
          return null;
        }
      }),
    );
    for (const c of results) {
      if (c) commits.push(c);
    }
  }

  // 批量写入 D1（每批 50 条 prepared statement，D1 batch 上限）
  const DB_BATCH = 50;
  for (let i = 0; i < commits.length; i += DB_BATCH) {
    const batch = commits.slice(i, i + DB_BATCH);
    const stmts: D1PreparedStatement[] = [];
    for (const commit of batch) {
      stmts.push(
        db.prepare(
          `INSERT OR REPLACE INTO commit_index
            (user_id, storage_id, sync_folder, commit_id, parent_commit_id, generation, created_at, kind, author, message, change_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          userId, storageId, syncFolder, commit.commitId,
          commit.parentCommitId, commit.generation, commit.createdAt,
          commit.kind, commit.author, commit.message, commit.changeCount,
        ),
      );
      for (const change of commit.changes) {
        stmts.push(
          db.prepare(
            `INSERT OR REPLACE INTO file_history_index
              (user_id, storage_id, sync_folder, file_identity, commit_id, created_at, change_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            userId, storageId, syncFolder,
            change.identity, commit.commitId, commit.createdAt,
            JSON.stringify(change),
          ),
        );
      }
      // D1 batch 上限 ~50 语句，超了就先执行这批再继续
      if (stmts.length >= 50) {
        await db.batch(stmts.splice(0, 50));
      }
    }
    if (stmts.length > 0) {
      await db.batch(stmts);
    }
  }

  return { indexed: commits.length };
}
