import Dexie, { type Table } from 'dexie';
import type { RepoChange, RepoCommit, RepoCommitSummary } from '@synx/shared';

interface CommitRecord extends RepoCommitSummary {
  id: string;
  repository: string;
  generation: number;
  checkpointId: string | null;
}

interface ChangeRecord extends RepoChange {
  id: string;
  repository: string;
  commitId: string;
  generation: number;
}

interface MetaRecord {
  id: string;
  repository: string;
  key: 'indexedHead';
  value: string;
}

export interface FileHistoryResult {
  commits: RepoCommitSummary[];
  changes: RepoChange[];
  headCommitId: string | null;
}

export interface HistoryIndexProgress {
  indexed: number;
}

export interface HistorySyncOptions {
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: HistoryIndexProgress) => void;
}

class HistoryDatabase extends Dexie {
  commits!: Table<CommitRecord, string>;
  changes!: Table<ChangeRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      commits: 'id, repository, [repository+generation], commitId',
      changes: 'id, repository, [repository+identity+generation], commitId',
      meta: 'id, repository',
    });
  }
}

export class HistoryIndex {
  private db: HistoryDatabase | null = null;
  private repository: string | null = null;

  constructor(private readonly databasePrefix = 'synx-history') {}

  async openAccount(userId: string): Promise<void> {
    this.db?.close();
    this.db = new HistoryDatabase(`${this.databasePrefix}-${encodeURIComponent(userId)}`);
    await this.db.open();
    this.repository = null;
  }

  async setRepository(storageId: string, syncFolder: string): Promise<void> {
    this.requireDb();
    this.repository = `${storageId}\0${syncFolder}`;
  }

  async putCommits(commits: RepoCommit[], headCommitId: string): Promise<void> {
    const db = this.requireDb();
    const repository = this.requireRepository();
    await db.transaction('rw', db.commits, db.changes, db.meta, async () => {
      await this.putCommitBatch(db, repository, commits);
      await db.meta.put({
        id: this.metaId(repository),
        repository,
        key: 'indexedHead',
        value: headCommitId,
      });
    });
  }

  async getFileHistory(identity: string, limit = 200): Promise<FileHistoryResult> {
    const db = this.requireDb();
    const repository = this.requireRepository();
    const rows = await db.changes
      .where('[repository+identity+generation]')
      .between(
        [repository, identity, Dexie.minKey],
        [repository, identity, Dexie.maxKey],
      )
      .reverse()
      .limit(limit)
      .toArray();
    const commitRows = await db.commits.bulkGet(rows.map((row) => this.commitId(repository, row.commitId)));
    const commits: RepoCommitSummary[] = [];
    const changes: RepoChange[] = [];
    for (let i = 0; i < rows.length; i++) {
      const record = commitRows[i];
      if (!record) continue;
      commits.push(this.toSummary(record));
      changes.push(this.toChange(rows[i]));
    }
    const meta = await db.meta.get(this.metaId(repository));
    return { commits, changes, headCommitId: meta?.value ?? null };
  }

  async syncFromHead(
    headCommitId: string,
    readCommit: (commitId: string) => Promise<RepoCommit | null>,
    options: HistorySyncOptions = {},
  ): Promise<{ indexed: number; rebuilt: boolean }> {
    const db = this.requireDb();
    const repository = this.requireRepository();
    const batchSize = Math.max(1, options.batchSize ?? 100);
    const oldHead = (await db.meta.get(this.metaId(repository)))?.value ?? null;
    if (oldHead === headCommitId) return { indexed: 0, rebuilt: false };

    const collected: RepoCommit[] = [];
    let pending: RepoCommit[] = [];
    let cursor: string | null = headCommitId;
    while (cursor && cursor !== oldHead) {
      this.throwIfAborted(options.signal);
      const current = await readCommit(cursor);
      this.throwIfAborted(options.signal);
      if (!current) {
        if (collected.length === 0) throw new Error(`commit ${cursor} not found while building history index`);
        break;
      }
      collected.push(current);
      pending.push(current);
      cursor = current.parentCommitId;
      if (pending.length >= batchSize) {
        this.throwIfAborted(options.signal);
        await this.putCommitBatch(db, repository, pending);
        pending = [];
        options.onProgress?.({ indexed: collected.length });
        this.throwIfAborted(options.signal);
      }
    }
    if (pending.length > 0) {
      this.throwIfAborted(options.signal);
      await this.putCommitBatch(db, repository, pending);
      options.onProgress?.({ indexed: collected.length });
      this.throwIfAborted(options.signal);
    }

    const rebuilt = oldHead !== null && cursor !== oldHead;
    if (rebuilt) {
      this.throwIfAborted(options.signal);
      await this.clearRepository(db, repository);
      this.throwIfAborted(options.signal);
      await this.putCommitBatch(db, repository, collected);
    }
    this.throwIfAborted(options.signal);
    await db.meta.put({
      id: this.metaId(repository),
      repository,
      key: 'indexedHead',
      value: headCommitId,
    });
    return { indexed: collected.length, rebuilt };
  }

  async clearAccount(): Promise<void> {
    const db = this.db;
    if (!db) return;
    this.db = null;
    this.repository = null;
    db.close();
    await Dexie.delete(db.name);
  }

  /**
   * 清除本地缓存的历史索引（IndexedDB）。优先清除当前仓库作用域；
   * 未选择仓库时清空整个账号的历史缓存。下次同步会从云端 HEAD 重新建立。
   */
  async clearCurrentRepositoryHistory(): Promise<void> {
    const db = this.requireDb();
    const repository = this.repository;
    if (repository) {
      await this.clearRepository(db, repository);
      return;
    }
    await db.transaction('rw', db.commits, db.changes, db.meta, async () => {
      await db.commits.clear();
      await db.changes.clear();
      await db.meta.clear();
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.repository = null;
  }

  async delete(): Promise<void> {
    await this.clearAccount();
  }

  private async putCommitBatch(db: HistoryDatabase, repository: string, commits: RepoCommit[]): Promise<void> {
    if (commits.length === 0) return;
    const commitRows: CommitRecord[] = commits.map((commit) => ({
      id: this.commitId(repository, commit.commitId),
      repository,
      commitId: commit.commitId,
      parentCommitId: commit.parentCommitId,
      generation: commit.generation,
      createdAt: commit.createdAt,
      author: commit.author,
      message: commit.message,
      kind: commit.kind,
      changeCount: commit.changeCount,
      checkpointId: commit.checkpointId,
    }));
    const changeRows: ChangeRecord[] = commits.flatMap((commit) =>
      commit.changes.map((change, index) => ({
        ...change,
        id: `${repository}\0${commit.commitId}\0${index}`,
        repository,
        commitId: commit.commitId,
        generation: commit.generation,
      })),
    );
    await db.transaction('rw', db.commits, db.changes, async () => {
      await db.commits.bulkPut(commitRows);
      if (changeRows.length > 0) await db.changes.bulkPut(changeRows);
    });
  }

  private async clearRepository(db: HistoryDatabase, repository: string): Promise<void> {
    await db.transaction('rw', db.commits, db.changes, db.meta, async () => {
      await db.commits.where('repository').equals(repository).delete();
      await db.changes.where('repository').equals(repository).delete();
      await db.meta.where('repository').equals(repository).delete();
    });
  }

  private toSummary(record: CommitRecord): RepoCommitSummary {
    return {
      commitId: record.commitId,
      parentCommitId: record.parentCommitId,
      kind: record.kind,
      createdAt: record.createdAt,
      author: record.author,
      message: record.message,
      changeCount: record.changeCount,
    };
  }

  private toChange(record: ChangeRecord): RepoChange {
    return {
      identity: record.identity,
      operation: record.operation,
      path: record.path,
      previousPath: record.previousPath,
      blobId: record.blobId,
      hash: record.hash,
      size: record.size,
      mtime: record.mtime,
    };
  }

  private commitId(repository: string, commitId: string): string {
    return `${repository}\0${commitId}`;
  }

  private metaId(repository: string): string {
    return `${repository}\0indexedHead`;
  }

  private requireDb(): HistoryDatabase {
    if (!this.db) throw new Error('history index account is not open');
    return this.db;
  }

  private requireRepository(): string {
    if (!this.repository) throw new Error('history index repository is not selected');
    return this.repository;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('History indexing aborted', 'AbortError');
  }
}
