import { describe, expect, it } from 'vitest';
import { decideLocalWriteProtection, hasChangedMarkdownEditor, protectedPullConflictPath, withoutProtectedPrevSyncEntries, type SyncStartFileSnapshot } from './syncWriteGuard.js';

const original: SyncStartFileSnapshot = { exists: true, mtime: 1000, size: 4, hash: 'hash-before' };

describe('decideLocalWriteProtection', () => {
  it('protects a file created after sync started', () => {
    expect(decideLocalWriteProtection(
      { exists: false },
      { exists: true, mtime: 2000, size: 4, hash: 'hash-new' },
      false,
    )).toBe('changed');
  });

  it('protects a file modified after sync started', () => {
    expect(decideLocalWriteProtection(
      original,
      { exists: true, mtime: 2000, size: 5, hash: 'hash-after' },
      false,
    )).toBe('changed');
  });

  it('protects same-length content changes even when mtime is unchanged', () => {
    expect(decideLocalWriteProtection(
      original,
      { exists: true, mtime: 1000, size: 4, hash: 'hash-after' },
      false,
    )).toBe('changed');
  });

  it('protects an active Markdown editor', () => {
    expect(decideLocalWriteProtection(original, original, true)).toBe('active-editor');
  });

  it('allows an unchanged file to be pulled or deleted', () => {
    expect(decideLocalWriteProtection(original, original, false)).toBe('safe');
  });
});

describe('hasChangedMarkdownEditor', () => {
  it('protects when any Markdown pane for the target path differs from disk', () => {
    expect(hasChangedMarkdownEditor('notes/a.md', 'disk hash', [
      { path: 'notes/a.md', contentHash: 'disk hash' },
      { path: 'notes/b.md', contentHash: 'other hash' },
      { path: 'notes/a.md', contentHash: 'unsaved hash' },
    ])).toBe(true);
  });

  it('does not protect when target panes all match disk', () => {
    expect(hasChangedMarkdownEditor('notes/a.md', 'disk hash', [
      { path: 'notes/a.md', contentHash: 'disk hash' },
      { path: 'notes/b.md', contentHash: 'unsaved hash' },
    ])).toBe(false);
  });
});

describe('withoutProtectedPrevSyncEntries', () => {
  it('invalidates only protected paths so retry persistence plans a later push', () => {
    const entries = { 'edited.md': { localHash: 'old' }, 'safe.md': { localHash: 'safe' } };
    expect(withoutProtectedPrevSyncEntries(entries, new Set(['edited.md']))).toEqual({
      'safe.md': { localHash: 'safe' },
    });
    expect(entries).toHaveProperty('edited.md');
  });
});

describe('protectedPullConflictPath', () => {
  it('creates a normal vault path for remote content and avoids existing copies', () => {
    const first = protectedPullConflictPath('notes/a.md', 'My Phone!', 1700000000000, new Set());
    expect(first).toBe('Synx Conflicts/notes/a.conflict-my-phone-20231114-221320.md');
    expect(protectedPullConflictPath('notes/a.md', 'My Phone!', 1700000000000, new Set([first])))
      .toBe('Synx Conflicts/notes/a.conflict-my-phone-20231114-221320-2.md');
  });
});
