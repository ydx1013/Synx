// @vitest-environment jsdom
// 冒烟测试：验证引擎在浏览器类环境（jsdom）下可用（插件端运行环境）。
import { describe, expect, it } from 'vitest';
import { makeStorageKey, type WorkerFs } from '@synx/shared';
import { finalizeCommit, initRepository, readHead, resolveTree } from './repositoryService.js';

class MemFs implements WorkerFs {
  map = new Map<string, Uint8Array>();
  async put(key: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    this.map.set(key, content instanceof Uint8Array ? content : new Uint8Array(content));
  }
  async get(key: string): Promise<ArrayBuffer> {
    const v = this.map.get(key);
    if (!v) throw new Error(`get missing: ${key}`);
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
  async head(key: string): Promise<boolean> {
    return this.map.has(key);
  }
  putText(key: string, text: string): Promise<void> {
    return this.put(key, new TextEncoder().encode(text));
  }
}

describe('repo-core 浏览器环境（jsdom）可用性', () => {
  it('init + finalize + resolveTree 全流程可用', async () => {
    const fs = new MemFs();
    const syncFolder = 'Vault';
    const { head } = await initRepository({ storageId: 's1', syncFolder, fs, externalLock: true });
    expect(head.generation).toBe(1);

    const blobId = makeStorageKey(syncFolder, 'note.md', 'v1');
    await fs.putText(blobId, 'hello');
    const { commit } = await finalizeCommit({
      storageId: 's1',
      syncFolder,
      fs,
      externalLock: true,
      baseCommitId: head.commitId,
      baseGeneration: head.generation,
      changes: [{ identity: 'uuid-1', operation: 'add', path: 'note.md', blobId, hash: 'h', size: 5, mtime: 1 }],
    });

    const latest = (await readHead(fs, syncFolder))!;
    expect(latest.commitId).toBe(commit.commitId);
    const tree = await resolveTree(fs, syncFolder, commit);
    expect(tree.get('note.md')!.blobId).toBe(blobId);
  });
});
