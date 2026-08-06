import type { RepoChange, RepoCommitSummary } from '@synx/shared';

export interface HistoryEntry {
  commitId: string;
  createdAt: number;
  author: string | null;
  message: string;
  path: string;
  size: number;
  isCurrent: boolean;
  deleted: boolean;
}

export interface HistoryRecords {
  commits: RepoCommitSummary[];
  changes: RepoChange[];
  headCommitId: string | null;
}

export function mapHistoryEntries(history: HistoryRecords): HistoryEntry[] {
  return history.commits
    .map((commit, index) => {
      const change = history.changes[index];
      return {
        commitId: commit.commitId,
        createdAt: commit.createdAt,
        author: commit.author,
        message: commit.message,
        path: change?.path ?? '',
        size: change?.size ?? 0,
        isCurrent: commit.commitId === history.headCommitId,
        deleted: change?.operation === 'delete',
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}
