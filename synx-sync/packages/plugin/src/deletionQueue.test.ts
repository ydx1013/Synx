import { describe, expect, it } from 'vitest';
import { enqueueDeletion, pendingForTarget, type PendingDeletion } from './deletionQueue.js';

const target = { storageId: 'storage-1', syncFolder: 'vault' };

describe('deletion queue', () => {
  it('deduplicates a deleted file by target and identity', () => {
    const entry: PendingDeletion = { ...target, path: 'a.md', fileUuid: '550e8400-e29b-41d4-a716-446655440000' };
    expect(enqueueDeletion([entry], entry)).toEqual([entry]);
  });

  it('only returns deletions for the active storage target', () => {
    const matching: PendingDeletion = { ...target, path: 'a.md', fileUuid: '550e8400-e29b-41d4-a716-446655440000' };
    const other: PendingDeletion = { storageId: 'storage-2', syncFolder: 'vault', path: 'b.md' };
    expect(pendingForTarget([matching, other], target)).toEqual([matching]);
  });
});
