import { conflictCopyPath } from './conflict.js';

export interface SyncStartFileSnapshot {
  exists: boolean;
  mtime?: number;
  size?: number;
  hash?: string;
}

export type LocalWriteProtection = 'safe' | 'changed' | 'active-editor';

export interface MarkdownEditorSnapshot {
  path: string;
  contentHash: string;
}

export function hasChangedMarkdownEditor(
  path: string,
  diskHash: string | undefined,
  editors: readonly MarkdownEditorSnapshot[],
): boolean {
  return editors.some((editor) => editor.path === path && editor.contentHash !== diskHash);
}

export function withoutProtectedPrevSyncEntries<T>(
  entries: Readonly<Record<string, T>>,
  protectedPaths: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([path]) => !protectedPaths.has(path))) as Record<string, T>;
}

export function decideLocalWriteProtection(
  started: SyncStartFileSnapshot,
  current: SyncStartFileSnapshot,
  activeMarkdownEditor: boolean,
): LocalWriteProtection {
  if (activeMarkdownEditor) return 'active-editor';
  if (started.exists !== current.exists) return 'changed';
  if (!started.exists) return 'safe';
  if (started.mtime !== current.mtime || started.size !== current.size || started.hash !== current.hash) return 'changed';
  return 'safe';
}

export function protectedPullConflictPath(
  path: string,
  device: string,
  timestamp: number,
  existing: ReadonlySet<string>,
): string {
  const directory = 'Synx Conflicts/';
  const hiddenExisting = new Set([...existing].map((candidate) => `.synx-conflicts/${candidate.startsWith(directory) ? candidate.slice(directory.length) : candidate}`));
  return directory + conflictCopyPath(path, device, timestamp, hiddenExisting).replace(/^\.synx-conflicts\//, '');
}
