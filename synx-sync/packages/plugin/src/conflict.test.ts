import { describe, expect, it } from 'vitest';
import { conflictCopyPath, resolveConflict } from './conflict.js';

describe('conflictCopyPath', () => {
  it('creates sanitized stable names and avoids existing paths', () => {
    const first = conflictCopyPath('notes/a.md', 'My Phone!', 1700000000000, new Set());
    expect(first).toBe('.synx-conflicts/notes/a.conflict-my-phone-20231114-221320.md');
    const second = conflictCopyPath('notes/a.md', 'My Phone!', 1700000000000, new Set([first]));
    expect(second).toBe('.synx-conflicts/notes/a.conflict-my-phone-20231114-221320-2.md');
  });
});

describe('resolveConflict', () => {
  it('keeps newer content at the original path and preserves the other side', () => {
    expect(resolveConflict({ path: 'a.md', localMtime: 2000, remoteMtime: 1000, localType: 'file', remoteType: 'file' }, 'newer-with-copy', 'desktop', 1700000000000, new Set())).toEqual({
      outcome: 'keep-local', conflictPath: '.synx-conflicts/a.conflict-desktop-20231114-221320.md', preserve: 'remote', paused: false,
    });
  });

  it('preserves the file when a file conflicts with a folder', () => {
    expect(resolveConflict({ path: 'docs', localMtime: 1, remoteMtime: 2, localType: 'folder', remoteType: 'file' }, 'newer-with-copy', 'desktop', 1700000000000, new Set())).toMatchObject({
      outcome: 'keep-local', preserve: 'remote', conflictPath: '.synx-conflicts/docs.conflict-desktop-20231114-221320', paused: false,
    });
  });

  it('supports explicit keep and pause strategies without deletion', () => {
    const input = { path: 'a.md', localMtime: 1, remoteMtime: 2, localType: 'file' as const, remoteType: 'file' as const };
    expect(resolveConflict(input, 'keep-local', 'd', 1, new Set())).toMatchObject({ outcome: 'keep-local', preserve: 'remote', paused: false });
    expect(resolveConflict(input, 'keep-remote', 'd', 1, new Set())).toMatchObject({ outcome: 'keep-remote', preserve: 'local', paused: false });
    expect(resolveConflict(input, 'pause', 'd', 1, new Set())).toEqual({ outcome: 'pause', preserve: 'both', paused: true });
  });
});
