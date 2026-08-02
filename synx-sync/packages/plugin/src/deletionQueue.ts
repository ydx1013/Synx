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
  return `${entry.storageId}\0${entry.syncFolder}\0${entry.fileUuid ?? entry.path}`;
}

export function enqueueDeletion(queue: readonly PendingDeletion[], entry: PendingDeletion): PendingDeletion[] {
  return queue.some((item) => key(item) === key(entry)) ? [...queue] : [...queue, entry];
}

export function pendingForTarget(queue: readonly PendingDeletion[], target: DeletionTarget): PendingDeletion[] {
  return queue.filter((entry) => entry.storageId === target.storageId && entry.syncFolder === target.syncFolder);
}
