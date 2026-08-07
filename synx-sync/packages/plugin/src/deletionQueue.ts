import type { RepoChange } from '@synx/shared';

export interface PendingDeletion {
  storageId: string;
  syncFolder: string;
  path: string;
  fileUuid?: string;
}

export interface DeletionTarget {
  storageId: string;
  syncFolder: string;
}

function key(entry: PendingDeletion): string {
  return `${entry.storageId}\0${entry.syncFolder}\0${entry.path}\0${entry.fileUuid ?? ''}`;
}

function mergeRollback(current: readonly PendingDeletion[], removed: readonly PendingDeletion[]): PendingDeletion[] {
  const merged: PendingDeletion[] = [];
  const keys = new Set<string>();
  for (const entry of current) {
    const entryKey = key(entry);
    if (!keys.has(entryKey)) {
      merged.push(entry);
      keys.add(entryKey);
    }
  }
  for (const entry of removed) {
    const samePathExists = merged.some((currentEntry) =>
      currentEntry.storageId === entry.storageId
      && currentEntry.syncFolder === entry.syncFolder
      && currentEntry.path === entry.path);
    if (!samePathExists && !keys.has(key(entry))) {
      merged.push(entry);
      keys.add(key(entry));
    }
  }
  return merged;
}

export function enqueueDeletion(queue: readonly PendingDeletion[], entry: PendingDeletion): PendingDeletion[] {
  return queue.some((item) => key(item) === key(entry)) ? [...queue] : [...queue, entry];
}

export function pendingForTarget(queue: readonly PendingDeletion[], target: DeletionTarget): PendingDeletion[] {
  return queue.filter((entry) => entry.storageId === target.storageId && entry.syncFolder === target.syncFolder);
}

export async function cancelRevivedPendingDeletions(
  queue: PendingDeletion[],
  target: DeletionTarget,
  revivedPaths: ReadonlySet<string>,
  update: (queue: PendingDeletion[]) => void,
  persist: () => Promise<void>,
  current: () => readonly PendingDeletion[] = () => queue,
): Promise<void> {
  const next = queue.filter((entry) =>
    entry.storageId !== target.storageId
    || entry.syncFolder !== target.syncFolder
    || !revivedPaths.has(entry.path));
  if (next.length === queue.length) return;
  const removed = queue.filter((entry) => !next.includes(entry));
  update(next);
  try {
    await persist();
  } catch (error) {
    update(mergeRollback(current(), removed));
    await persist();
    throw error;
  }
}

export function collectPendingDeletions(
  queue: readonly PendingDeletion[],
  target: DeletionTarget,
  deletes: Map<string, string>,
  allowed = true,
): PendingDeletion[] {
  if (!allowed) return [];
  const pending = pendingForTarget(queue, target);
  for (const entry of pending) deletes.set(entry.path, entry.fileUuid ?? `path:${entry.path}`);
  return pending;
}

export function acknowledgePendingDeletions(
  queue: readonly PendingDeletion[],
  target: DeletionTarget,
  finalizedChanges: readonly RepoChange[],
): PendingDeletion[] {
  const confirmed = new Set(finalizedChanges
    .filter((change) => change.operation === 'delete')
    .map((change) => `${change.path}\0${change.identity}`));
  return queue.filter((entry) =>
    entry.storageId !== target.storageId
    || entry.syncFolder !== target.syncFolder
    || !confirmed.has(`${entry.path}\0${entry.fileUuid ?? `path:${entry.path}`}`));
}

export async function acknowledgePendingDeletionsDurably(
  queue: PendingDeletion[],
  target: DeletionTarget,
  finalizedChanges: readonly RepoChange[],
  update: (queue: PendingDeletion[]) => void,
  persist: () => Promise<void>,
  current: () => readonly PendingDeletion[],
): Promise<void> {
  const next = acknowledgePendingDeletions(queue, target, finalizedChanges);
  if (next.length === queue.length) return;
  const removed = queue.filter((entry) => !next.includes(entry));
  update(next);
  try {
    await persist();
  } catch (error) {
    update(mergeRollback(current(), removed));
    await persist();
    throw error;
  }
}
