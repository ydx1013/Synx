import { describe, expect, it } from 'vitest';
import type { RepoFile } from '@synx/shared';
import { buildRepoChanges, identityToFileUuid, repoTreeToRemote, treeToMap } from './repoSync.js';

function file(path: string, identity: string, hash = 'h', blobId = `b-${path}`): RepoFile {
  return { path, identity, blobId, hash, size: 1, mtime: 100 };
}

const tree: RepoFile[] = [
  file('note.md', 'uuid-note'),
  file('attachments/a.png', 'path:attachments/a.png'),
];

describe('repoTreeToRemote', () => {
  it('映射为 planSync 可用的远端实体（key 带前导 /，hash 同时放 hash/etag）', () => {
    const remote = repoTreeToRemote(tree);
    expect(remote).toHaveLength(2);
    const note = remote.find((e) => e.key === '/note.md')!;
    expect(note.fileUuid).toBe('uuid-note');
    expect(note.hash).toBe('h');
    expect(note.etag).toBe('h');
    const attach = remote.find((e) => e.key === '/attachments/a.png')!;
    expect(attach.fileUuid).toBeUndefined();
  });
});

describe('identityToFileUuid', () => {
  it('uuid 原样返回，path: 前缀返回 undefined', () => {
    expect(identityToFileUuid('uuid-abc')).toBe('uuid-abc');
    expect(identityToFileUuid('path:a/b.md')).toBeUndefined();
  });
});

describe('buildRepoChanges', () => {
  const current = treeToMap(tree);

  it('已上传的新路径 → add，树中已有路径 → modify', () => {
    const changes = buildRepoChanges(
      [
        { path: 'new.md', blobId: 'b-new', hash: 'h', size: 1, mtime: 1, identity: 'uuid-new' },
        { path: 'note.md', blobId: 'b-note2', hash: 'h2', size: 2, mtime: 2, identity: 'uuid-note' },
      ],
      [],
      current,
    );
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.path === 'new.md')).toMatchObject({ operation: 'add' });
    expect(changes.find((c) => c.path === 'note.md')).toMatchObject({ operation: 'modify', blobId: 'b-note2' });
  });

  it('previousPath → rename 变更', () => {
    const changes = buildRepoChanges(
      [{ path: 'renamed.md', previousPath: 'note.md', blobId: 'b-r', hash: 'h', size: 1, mtime: 1, identity: 'uuid-note' }],
      [],
      current,
    );
    expect(changes[0]).toMatchObject({ operation: 'rename', previousPath: 'note.md', path: 'renamed.md' });
  });

  it('delete 变更（identity 直接透传）', () => {
    const changes = buildRepoChanges([], [{ path: 'note.md', identity: 'uuid-note' }], current);
    expect(changes[0]).toMatchObject({ operation: 'delete', path: 'note.md', identity: 'uuid-note' });
  });

  it('add/modify/delete 混合，保持传入顺序', () => {
    const changes = buildRepoChanges(
      [{ path: 'a.md', blobId: 'b', hash: 'h', size: 1, mtime: 1, identity: 'u-a' }],
      [{ path: 'note.md', identity: 'uuid-note' }],
      current,
    );
    expect(changes.map((c) => c.operation)).toEqual(['add', 'delete']);
  });
});
