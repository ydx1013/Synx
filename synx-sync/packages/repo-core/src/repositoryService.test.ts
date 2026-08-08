import { describe, expect, it, vi } from 'vitest';
import {
  makeStorageKey,
  type RepoChange,
  type RepoCommit,
  type WorkerFs,
} from '@synx/shared';
import {
  BlobMissingError,
  EmptyChangesError,
  ExternalRepositoryLockRequiredError,
  HeadConflictError,
  RepoExistsError,
  RepoIntegrityError,
  canonicalJson,
  diffCommits,
  diffTrees,
  fileHistory,
  finalizeCommit,
  gcRepository,
  getCommitDetail,
  initRepository,
  listCommits,
  normalizeChanges,
  readHead,
  resolveTree,
  restoreRepository,
} from './repositoryService.js';

const SYNC_FOLDER = 'Vault';

/** 内存 WorkerFs：支持可选条件写；supportsConditional=false 时走锁对象降级路径 */
class MemFs implements WorkerFs {
  map = new Map<string, Uint8Array>();
  etags = new Map<string, string>();
  private counter = 0;
  // 可选条件写：不支持时保持 undefined（触发锁对象降级路径）
  putIfMatch?: WorkerFs['putIfMatch'];
  putIfNoneMatch?: WorkerFs['putIfNoneMatch'];
  getEtag?: WorkerFs['getEtag'];

  constructor(private supportsConditional = true, private ifMatchFlaky = false) {
    // 模拟真实后端：不支持条件写时方法保持 undefined，触发锁对象降级路径。
    // ifMatchFlaky=true 模拟「If-Match 恒失配」的后端：etag 匹配也返回 false（假冲突 412）。
    if (this.supportsConditional) {
      this.putIfMatch = async (key, content, etag) => {
        if (this.etags.get(key) !== etag) return false;
        if (this.ifMatchFlaky) return false;
        await this.put(key, content);
        return true;
      };
      this.putIfNoneMatch = async (key, content) => {
        if (this.map.has(key)) return false;
        await this.put(key, content);
        return true;
      };
      this.getEtag = async (key) => this.etags.get(key) ?? null;
    }
  }

  async put(key: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    this.map.set(key, bytes);
    this.etags.set(key, `"e-${++this.counter}-${key}"`);
  }
  async get(key: string): Promise<ArrayBuffer> {
    const v = this.map.get(key);
    if (!v) throw new Error(`get missing: ${key}`);
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
    this.etags.delete(key);
  }
  async deleteMany(keys: string[]): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    for (const k of keys) if (this.map.delete(k)) deleted++;
    return { deleted, failed: 0 };
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
  async head(key: string): Promise<boolean> {
    return this.map.has(key);
  }
  /** 测试辅助：把任意文本写入指定 key */
  putText(key: string, text: string): Promise<void> {
    return this.put(key, new TextEncoder().encode(text));
  }
  getText(key: string): Promise<string> {
    return this.get(key).then((buf) => new TextDecoder().decode(buf));
  }
}

interface FileSeed {
  path: string;
  fileUuid?: string;
  versionId: string;
  content: string;
  mtime: number;
}

/** 建仓：init 空提交后，把给定文件作为首个同步提交加入（真实流程：init → 首次同步 add 全部）。 */
async function createRepoWithFiles(files: FileSeed[], supportsConditional = true): Promise<MemFs> {
  const fs = new MemFs(supportsConditional);
  const { head } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
  const changes: RepoChange[] = files.map((f) => {
    const blobId = makeStorageKey(SYNC_FOLDER, f.path, f.versionId);
    fs.putText(blobId, f.content);
    return {
      identity: f.fileUuid ?? `path:${f.path}`,
      operation: 'add',
      path: f.path,
      blobId,
      hash: `hash-${f.versionId}`,
      size: f.content.length,
      mtime: f.mtime,
    };
  });
  await finalizeCommit({
    storageId: 's1', syncFolder: SYNC_FOLDER, fs,
    baseCommitId: head.commitId, baseGeneration: head.generation, changes,
  });
  return fs;
}

describe('canonicalJson / normalizeChanges', () => {
  it('稳定序列化与规范化排序，语义相同则字符串相同', () => {
    const a: RepoChange = { identity: 'u1', operation: 'modify', path: 'b.md', blobId: 'b1' };
    const b: RepoChange = { blobId: 'b1', path: 'b.md', operation: 'modify', identity: 'u1' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));

    const unsorted: RepoChange[] = [
      { identity: 'u2', operation: 'add', path: 'a.md', blobId: 'a1' },
      { identity: 'u1', operation: 'modify', path: 'b.md', blobId: 'b1' },
    ];
    const sorted = normalizeChanges(unsorted);
    // 规范化后按 canonicalJson 升序稳定排序（确定性可复现）
    expect(sorted.map((c) => canonicalJson(c))).toEqual([...sorted].map((c) => canonicalJson(c)).sort());
    expect(sorted.map((c) => c.identity)).toEqual([...sorted].map((c) => c.identity));
    expect(normalizeChanges([...unsorted].reverse()).map((c) => canonicalJson(c))).toEqual(sorted.map((c) => canonicalJson(c)));
  });

  it('过滤非法条目（缺 identity / 非法 operation / rename 缺 previousPath）', () => {
    const changes = normalizeChanges([
      { identity: '', operation: 'add', path: 'x.md', blobId: 'x' },
      { identity: 'u1', operation: 'bogus' as never, path: 'y.md' },
      { identity: 'u2', operation: 'rename', path: 'new.md' }, // 缺 previousPath
      { identity: 'u3', operation: 'add', path: 'ok.md', blobId: 'ok' },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].identity).toBe('u3');
  });
});

describe('readHead', () => {
  it.each([401, 403])('fs.get 的认证状态 %i 原样传播', async (status) => {
    const fs = new MemFs();
    await fs.putText('Vault/.synx/repo/HEAD.json', '{}');
    const authError = Object.assign(new Error('credential rejected'), { status });
    fs.get = vi.fn().mockRejectedValue(authError);

    await expect(readHead(fs, SYNC_FOLDER)).rejects.toBe(authError);
  });

  it('fs.get 的原始 TypeError 原样传播', async () => {
    const fs = new MemFs();
    await fs.putText('Vault/.synx/repo/HEAD.json', '{}');
    const networkError = new TypeError('ConnectTimeout');
    fs.get = vi.fn().mockRejectedValue(networkError);

    await expect(readHead(fs, SYNC_FOLDER)).rejects.toBe(networkError);
  });

  it('GET 成功但 JSON 损坏时转为 RepoIntegrityError', async () => {
    const fs = new MemFs();
    await fs.putText('Vault/.synx/repo/HEAD.json', '{broken');

    await expect(readHead(fs, SYNC_FOLDER)).rejects.toBeInstanceOf(RepoIntegrityError);
  });
});

describe('initRepository', () => {
  it('resolveTree 读取检查点时 fs.get 的网络异常原样传播', async () => {
    const fs = new MemFs();
    const { commit } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const networkError = new TypeError('ConnectTimeout');
    const originalGet = fs.get.bind(fs);
    fs.get = async (key) => key.includes('/checkpoints/') ? Promise.reject(networkError) : originalGet(key);

    await expect(resolveTree(fs, SYNC_FOLDER, commit)).rejects.toBe(networkError);
  });

  it('resolveTree 读取到损坏检查点 JSON 时转为 RepoIntegrityError', async () => {
    const fs = new MemFs();
    const { commit } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    await fs.putText(`Vault/.synx/repo/checkpoints/${commit.commitId}.json`, '{broken');

    await expect(resolveTree(fs, SYNC_FOLDER, commit)).rejects.toBeInstanceOf(RepoIntegrityError);
  });

  it('创建空初始提交（含检查点与 HEAD），重复 init 报 REPO_EXISTS', async () => {
    const fs = new MemFs();
    const { head, commit } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });

    expect(head.generation).toBe(1);
    expect(commit.kind).toBe('initial');
    expect(commit.parentCommitId).toBeNull();
    expect(commit.checkpointId).toBe(commit.commitId);
    expect(commit.changeCount).toBe(0);

    // HEAD 与提交、检查点都已落盘
    expect(await fs.head(`Vault/.synx/repo/HEAD.json`)).toBe(true);
    expect(await fs.head(`Vault/.synx/repo/commits/${commit.commitId}.json`)).toBe(true);
    expect(await fs.head(`Vault/.synx/repo/checkpoints/${commit.commitId}.json`)).toBe(true);

    // 初始树为空（首次同步时由客户端把文件 add 进来）
    const tree = await resolveTree(fs, SYNC_FOLDER, commit);
    expect(tree.size).toBe(0);

    // 重复 init 报 REPO_EXISTS
    await expect(initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs })).rejects.toThrow(RepoExistsError);
  });

  it('无条件写后端必须由调用方显式证明已有外部串行化', async () => {
    const fs = new MemFs(false);
    await expect(initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs }))
      .rejects.toThrow(ExternalRepositoryLockRequiredError);

    const { head, commit } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true });
    expect(head.commitId).toBe(commit.commitId);
  });

  it('首次条件创建 HEAD 的认证错误原样传播', async () => {
    const fs = new MemFs();
    const authError = Object.assign(new Error('unauthorized'), { status: 401 as const });
    fs.putIfNoneMatch = vi.fn().mockRejectedValue(authError);

    await expect(initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs })).rejects.toBe(authError);
  });
});

describe('finalizeCommit（原子提交）', () => {
  async function setup(): Promise<{ fs: MemFs; initialHead: { commitId: string; generation: number }; initialCommitId: string }> {
    const fs = await createRepoWithFiles([{ path: 'note.md', fileUuid: 'uuid-note', versionId: 'v1', content: 'v1', mtime: 1000 }]);
    const head = (await readHead(fs, SYNC_FOLDER))!;
    return { fs, initialHead: { commitId: head.commitId, generation: head.generation }, initialCommitId: head.commitId };
  }

  it('成功后形成线性提交链，HEAD 推进，树正确', async () => {
    const { fs, initialHead, initialCommitId } = await setup();

    // 上传新内容对象（blob）
    const newBlob = makeStorageKey(SYNC_FOLDER, 'note.md', 'v2');
    await fs.putText(newBlob, 'v2-content');
    const addBlob = makeStorageKey(SYNC_FOLDER, 'new.md', 'v3');
    await fs.putText(addBlob, 'new-content');

    const { commit, head } = await finalizeCommit({
      storageId: 's1',
      syncFolder: SYNC_FOLDER,
      fs,
      baseCommitId: initialHead.commitId,
      baseGeneration: initialHead.generation,
      author: 'device-b',
      changes: [
        { identity: 'uuid-note', operation: 'modify', path: 'note.md', blobId: newBlob, hash: 'h2', size: 9, mtime: 2000 },
        { identity: 'uuid-new', operation: 'add', path: 'new.md', blobId: addBlob, hash: 'h3', size: 11, mtime: 3000 },
      ],
    });

    expect(commit.parentCommitId).toBe(initialCommitId);
    expect(commit.generation).toBe(3);
    expect(commit.kind).toBe('sync');
    expect(head.generation).toBe(3);
    expect(head.commitId).toBe(commit.commitId);

    const tree = await resolveTree(fs, SYNC_FOLDER, commit);
    expect(tree.get('note.md')!.blobId).toBe(newBlob);
    expect(tree.get('new.md')!.blobId).toBe(addBlob);

    const readHeadResult = await readHead(fs, SYNC_FOLDER);
    expect(readHeadResult!.commitId).toBe(commit.commitId);
  });

  it('大变更集（超过逐个 HEAD 上限）走单次 list 校验，提交成功且树完整', async () => {
    const { fs, initialHead, initialCommitId } = await setup();

    const changes: RepoChange[] = [];
    for (let i = 0; i < 60; i++) {
      const path = `bulk/${i}.md`;
      const blobId = makeStorageKey(SYNC_FOLDER, path, `v${i}`);
      await fs.putText(blobId, `content-${i}`);
      changes.push({ identity: `path:${path}`, operation: 'add', path, blobId, hash: `h${i}`, size: 9, mtime: 1000 + i });
    }

    const { commit, head } = await finalizeCommit({
      storageId: 's1',
      syncFolder: SYNC_FOLDER,
      fs,
      baseCommitId: initialHead.commitId,
      baseGeneration: initialHead.generation,
      changes,
    });

    expect(commit.parentCommitId).toBe(initialCommitId);
    expect(commit.generation).toBe(3);
    expect(commit.changeCount).toBe(60);
    expect(head.commitId).toBe(commit.commitId);

    const tree = await resolveTree(fs, SYNC_FOLDER, commit);
    expect(tree.size).toBe(61); // note.md + 60 bulk 文件
    expect(tree.get('bulk/59.md')!.blobId).toBe(makeStorageKey(SYNC_FOLDER, 'bulk/59.md', 'v59'));
  });

  it.each([
    ['getEtag', 401, (fs: MemFs, error: Error) => { fs.getEtag = vi.fn().mockRejectedValue(error); }],
    ['putIfMatch', 403, (fs: MemFs, error: Error) => { fs.putIfMatch = vi.fn().mockRejectedValue(error); }],
  ] as const)('%s 的认证错误在 finalize 中原样传播', async (_operation, status, inject) => {
    const fs = new MemFs();
    const { head } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const blobId = makeStorageKey(SYNC_FOLDER, 'note.md', 'auth');
    await fs.putText(blobId, 'content');
    const authError = Object.assign(new Error('authentication failed'), { status });
    inject(fs, authError);

    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-note', operation: 'add', path: 'note.md', blobId, hash: 'h', size: 7, mtime: 1 }],
    })).rejects.toBe(authError);
  });

  it.each([
    ['head', 401, (fs: MemFs, error: Error) => {
      const original = fs.head.bind(fs);
      fs.head = async (key) => key.endsWith('lock.json') ? Promise.reject(error) : original(key);
    }],
    ['head', 403, (fs: MemFs, error: Error) => {
      const original = fs.head.bind(fs);
      fs.head = async (key) => key.endsWith('lock.json') ? Promise.reject(error) : original(key);
    }],
    ['get', 401, (fs: MemFs, error: Error) => {
      const originalHead = fs.head.bind(fs);
      const originalGet = fs.get.bind(fs);
      fs.head = async (key) => key.endsWith('lock.json') ? true : originalHead(key);
      fs.get = async (key) => key.endsWith('lock.json') ? Promise.reject(error) : originalGet(key);
    }],
    ['get', 403, (fs: MemFs, error: Error) => {
      const originalHead = fs.head.bind(fs);
      const originalGet = fs.get.bind(fs);
      fs.head = async (key) => key.endsWith('lock.json') ? true : originalHead(key);
      fs.get = async (key) => key.endsWith('lock.json') ? Promise.reject(error) : originalGet(key);
    }],
    ['put', 401, (fs: MemFs, error: Error) => {
      const original = fs.put.bind(fs);
      fs.putIfNoneMatch = undefined;
      fs.put = async (key, content) => key.endsWith('lock.json')
        ? Promise.reject(error)
        : original(key, content);
    }],
    ['put', 403, (fs: MemFs, error: Error) => {
      const original = fs.put.bind(fs);
      fs.putIfNoneMatch = undefined;
      fs.put = async (key, content) => key.endsWith('lock.json')
        ? Promise.reject(error)
        : original(key, content);
    }],
  ] as const)('锁路径 %s 的认证错误不转为 HeadConflictError', async (_operation, status, inject) => {
    const fs = new MemFs(true, true);
    const { head } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const blobId = makeStorageKey(SYNC_FOLDER, 'note.md', 'lock-auth');
    await fs.putText(blobId, 'content');
    const authError = Object.assign(new Error('authentication failed'), { status });
    inject(fs, authError);

    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-note', operation: 'add', path: 'note.md', blobId, hash: 'h', size: 7, mtime: 1 }],
    })).rejects.toBe(authError);
  });

  it('If-Match 恒失配的后端（假冲突）→ 降级锁路径写入，提交成功', async () => {
    const fs = new MemFs(true, true); // 支持条件写但 putIfMatch 恒返回 false（模拟不稳定的 S3 If-Match）
    const { head: initialHead } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });

    const blobId = makeStorageKey(SYNC_FOLDER, 'note.md', 'v2');
    await fs.putText(blobId, 'v2-content');
    const { commit, head } = await finalizeCommit({
      storageId: 's1',
      syncFolder: SYNC_FOLDER,
      fs,
      baseCommitId: initialHead.commitId,
      baseGeneration: initialHead.generation,
      changes: [
        { identity: 'uuid-note', operation: 'add', path: 'note.md', blobId, hash: 'h2', size: 11, mtime: 2000 },
      ],
    });

    expect(commit.generation).toBe(2);
    expect(head.commitId).toBe(commit.commitId);
    expect(await readHead(fs, SYNC_FOLDER)).toMatchObject({ commitId: commit.commitId, generation: 2 });
  });

  it('基于过期基线提交 → HEAD_CONFLICT，HEAD 不变', async () => {
    const { fs, initialHead } = await setup();
    const blob = makeStorageKey(SYNC_FOLDER, 'note.md', 'v2');
    await fs.putText(blob, 'v2-content');

    const first = await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: initialHead.commitId, baseGeneration: initialHead.generation, changes: [
        { identity: 'uuid-note', operation: 'modify', path: 'note.md', blobId: blob, hash: 'h2', size: 9, mtime: 2000 },
      ],
    });

    // 两个设备基于同一基线，只有一个能成功
    await expect(
      finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: initialHead.commitId, baseGeneration: initialHead.generation, changes: [
          { identity: 'uuid-note', operation: 'modify', path: 'note.md', blobId: blob, hash: 'h2', size: 9, mtime: 2000 },
        ],
      }),
    ).rejects.toThrow(HeadConflictError);

    // HEAD 仍是第一个提交
    const head = await readHead(fs, SYNC_FOLDER);
    expect(head!.commitId).toBe(first.commit.commitId);
  });

  it('引用缺失的内容对象 → BLOB_MISSING，不产生提交', async () => {
    const { fs, initialHead } = await setup();
    await expect(
      finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: initialHead.commitId, baseGeneration: initialHead.generation, changes: [
          { identity: 'uuid-note', operation: 'modify', path: 'note.md', blobId: 'Vault/note.md@missing', hash: 'h', size: 1, mtime: 1 },
        ],
      }),
    ).rejects.toThrow(BlobMissingError);
    expect((await readHead(fs, SYNC_FOLDER))!.commitId).toBe(initialHead.commitId);
  });

  it('空变更 → EMPTY_CHANGES', async () => {
    const { fs, initialHead } = await setup();
    await expect(
      finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: initialHead.commitId, baseGeneration: initialHead.generation, changes: [],
      }),
    ).rejects.toThrow(EmptyChangesError);
  });

  it('已有外部锁时 If-Match 假冲突不依赖对象锁', async () => {
    const fs = new MemFs(true, true);
    const initial = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true });
    const blob = makeStorageKey(SYNC_FOLDER, 'a.md', 'v1');
    await fs.putText(blob, 'a');
    fs.putIfNoneMatch = async () => false;

    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true,
      baseCommitId: initial.head.commitId, baseGeneration: initial.head.generation,
      changes: [{ identity: 'u1', operation: 'add', path: 'a.md', blobId: blob, hash: 'h1', size: 1, mtime: 1 }],
    })).resolves.toMatchObject({ head: { generation: 2 } });
  });

  it('无条件写后端没有外部锁时拒绝 finalize，显式外部锁下仍检查基线', async () => {
    const fs = new MemFs(false);
    const initial = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true });
    const initialBlob = makeStorageKey(SYNC_FOLDER, 'a.md', 'v1');
    await fs.putText(initialBlob, 'a');
    await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true,
      baseCommitId: initial.head.commitId, baseGeneration: initial.head.generation,
      changes: [{ identity: 'u1', operation: 'add', path: 'a.md', blobId: initialBlob, hash: 'h1', size: 1, mtime: 1 }],
    });
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const blob = makeStorageKey(SYNC_FOLDER, 'a.md', 'v2');
    await fs.putText(blob, 'b');

    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'u1', operation: 'modify', path: 'a.md', blobId: blob, hash: 'h', size: 1, mtime: 2 }],
    })).rejects.toThrow(ExternalRepositoryLockRequiredError);

    const { commit } = await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'u1', operation: 'modify', path: 'a.md', blobId: blob, hash: 'h', size: 1, mtime: 2 }],
    });
    expect(commit.generation).toBe(3);

    await expect(
      finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs, externalLock: true,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        changes: [{ identity: 'u1', operation: 'modify', path: 'a.md', blobId: blob, hash: 'h', size: 1, mtime: 2 }],
      }),
    ).rejects.toThrow(HeadConflictError);
  });
});

describe('提交历史 / diff / 单文件历史', () => {
  async function setup(): Promise<{ fs: MemFs; initialCommitId: string; syncCommitId: string }> {
    const fs = await createRepoWithFiles([{ path: 'note.md', fileUuid: 'uuid-note', versionId: 'v1', content: 'v1', mtime: 1000 }]);
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const blob = makeStorageKey(SYNC_FOLDER, 'note.md', 'v2');
    await fs.putText(blob, 'v2-content');
    const { commit } = await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-note', operation: 'modify', path: 'note.md', blobId: blob, hash: 'h2', size: 9, mtime: 2000 }],
    });
    return { fs, initialCommitId: head.commitId, syncCommitId: commit.commitId };
  }

  it('listCommits 从 HEAD 向父链分页', async () => {
    const { fs, initialCommitId, syncCommitId } = await setup();
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const page1 = await listCommits(fs, SYNC_FOLDER, head);
    // 提交链：modify → add(initialCommitId) → 空 initial
    expect(page1.commits.map((c) => c.commitId)).toEqual([syncCommitId, initialCommitId, expect.any(String)]);
    expect(page1.commits[2].kind).toBe('initial');
    expect(page1.cursor).toBeNull();
  });

  it('listCommits 的 fs.get 网络异常原样传播而非伪装链尾', async () => {
    const { fs } = await setup();
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const networkError = new TypeError('ConnectTimeout');
    fs.get = vi.fn().mockRejectedValue(networkError);

    await expect(listCommits(fs, SYNC_FOLDER, head)).rejects.toBe(networkError);
  });

  it('listCommits 遇到损坏 JSON 时按现有语义保守停止', async () => {
    const { fs } = await setup();
    const head = (await readHead(fs, SYNC_FOLDER))!;
    await fs.putText(`Vault/.synx/repo/commits/${head.commitId}.json`, '{broken');

    await expect(listCommits(fs, SYNC_FOLDER, head)).resolves.toEqual({ commits: [], cursor: head.commitId });
  });

  it.each([401, 403])('getCommitDetail 的 fs.get 认证状态 %i 原样传播', async (status) => {
    const { fs, syncCommitId } = await setup();
    const authError = Object.assign(new Error('credential rejected'), { status });
    fs.get = vi.fn().mockRejectedValue(authError);

    await expect(getCommitDetail(fs, SYNC_FOLDER, syncCommitId)).rejects.toBe(authError);
  });

  it('getCommitDetail 的 fs.get 原始 TypeError 原样传播', async () => {
    const { fs, syncCommitId } = await setup();
    const networkError = new TypeError('ConnectTimeout');
    fs.get = vi.fn().mockRejectedValue(networkError);

    await expect(getCommitDetail(fs, SYNC_FOLDER, syncCommitId)).rejects.toBe(networkError);
  });

  it('getCommitDetail GET 成功但 JSON 损坏时转为 RepoIntegrityError', async () => {
    const { fs, syncCommitId } = await setup();
    await fs.putText(`Vault/.synx/repo/commits/${syncCommitId}.json`, '{broken');

    await expect(getCommitDetail(fs, SYNC_FOLDER, syncCommitId)).rejects.toBeInstanceOf(RepoIntegrityError);
  });

  it('diff：初始提交 → 同步提交显示 modify', async () => {
    const { fs, initialCommitId, syncCommitId } = await setup();
    const initial = await getCommitDetail(fs, SYNC_FOLDER, initialCommitId);
    const sync = await getCommitDetail(fs, SYNC_FOLDER, syncCommitId);
    const result = await diffCommits(fs, SYNC_FOLDER, sync, initial);
    expect(result.modified).toBe(1);
    expect(result.changes[0]).toMatchObject({ operation: 'modify', path: 'note.md' });
  });

  it('fileHistory 从提交链按 identity 派生', async () => {
    const { fs, initialCommitId, syncCommitId } = await setup();
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const { commits, changes, nextCursor } = await fileHistory(fs, SYNC_FOLDER, head, 'uuid-note');
    expect(commits.map((c) => c.commitId)).toEqual([initialCommitId, syncCommitId]);
    expect(changes.map((c) => c.operation)).toEqual(['add', 'modify']);
    // 链已扫尽 → 无下一页
    expect(nextCursor).toBeNull();
  });

  it('fileHistory 的 fs.get 网络异常原样传播而非伪装链尾', async () => {
    const { fs } = await setup();
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const networkError = new TypeError('ConnectTimeout');
    fs.get = vi.fn().mockRejectedValue(networkError);

    await expect(fileHistory(fs, SYNC_FOLDER, head, 'uuid-note')).rejects.toBe(networkError);
  });

  it('fileHistory 支持 from 游标分页，不截断', async () => {
    const { fs, initialCommitId, syncCommitId } = await setup();
    const head = (await readHead(fs, SYNC_FOLDER))!;
    // 上限 1：只返回最新一条，并返回游标（下一个待扫的 initial）
    const page1 = await fileHistory(fs, SYNC_FOLDER, head, 'uuid-note', 1);
    expect(page1.commits.map((c) => c.commitId)).toEqual([syncCommitId]);
    expect(page1.changes.map((c) => c.operation)).toEqual(['modify']);
    expect(page1.nextCursor).toBe(initialCommitId);
    // 从游标续扫：返回更早的一条（initial 的 add）
    const page2 = await fileHistory(fs, SYNC_FOLDER, head, 'uuid-note', 1, page1.nextCursor!);
    expect(page2.commits.map((c) => c.commitId)).toEqual([initialCommitId]);
    expect(page2.changes.map((c) => c.operation)).toEqual(['add']);
    // 游标指向空 initial 提交（不含匹配变更）→ 再扫一页为空并扫尽
    expect(page2.nextCursor).not.toBeNull();
    const page3 = await fileHistory(fs, SYNC_FOLDER, head, 'uuid-note', 1, page2.nextCursor!);
    expect(page3.commits).toHaveLength(0);
    expect(page3.nextCursor).toBeNull();
  });

  it('diffTrees 识别身份级 rename', () => {
    const current = new Map([
      ['old.md', { path: 'old.md', identity: 'u1', blobId: 'b1', hash: 'h', size: 1, mtime: 1 }],
    ]);
    const target = new Map([
      ['new.md', { path: 'new.md', identity: 'u1', blobId: 'b1', hash: 'h', size: 1, mtime: 1 }],
    ]);
    const changes = diffTrees(current, target);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ operation: 'rename', previousPath: 'old.md', path: 'new.md' });
  });
});

describe('restoreRepository（全库恢复，revert 语义）', () => {
  it('恢复创建新提交（内容树等于目标提交），且可反悔', async () => {
    const fs = await createRepoWithFiles([{ path: 'note.md', fileUuid: 'uuid-note', versionId: 'v1', content: 'v1', mtime: 1000 }]);
    const initHead = (await readHead(fs, SYNC_FOLDER))!;

    const blob = makeStorageKey(SYNC_FOLDER, 'note.md', 'v2');
    await fs.putText(blob, 'v2-content');
    const { commit: syncCommit, head: syncHead } = await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: initHead.commitId, baseGeneration: initHead.generation,
      changes: [{ identity: 'uuid-note', operation: 'modify', path: 'note.md', blobId: blob, hash: 'h2', size: 9, mtime: 2000 }],
    });

    // dryRun 预览：应显示把 note.md 改回 v1
    const preview = await restoreRepository({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      toCommitId: initHead.commitId, dryRun: true,
    });
    expect(preview.preview!.modified).toBe(1);

    // 应用恢复
    const result = await restoreRepository({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      toCommitId: initHead.commitId, dryRun: false, author: 'device-c',
    });
    const restoreCommit = result.commit!;
    expect(restoreCommit.kind).toBe('restore');
    expect(restoreCommit.parentCommitId).toBe(syncCommit.commitId);
    expect(restoreCommit.generation).toBe(syncHead.generation + 1);

    // 恢复提交的内容树与初始提交一致（blob 复用 v1，不复制内容）
    const restoredTree = await resolveTree(fs, SYNC_FOLDER, restoreCommit);
    expect(restoredTree.get('note.md')!.blobId).toBe(makeStorageKey(SYNC_FOLDER, 'note.md', 'v1'));

    // 可反悔：再恢复回同步后的提交
    const undo = await restoreRepository({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      toCommitId: syncCommit.commitId, dryRun: false,
    });
    const undoTree = await resolveTree(fs, SYNC_FOLDER, undo.commit!);
    expect(undoTree.get('note.md')!.blobId).toBe(blob);
  });
});

describe('gcRepository', () => {
  it('扫描提交时 fs.get 的网络异常原样传播且不删除对象', async () => {
    const fs = await createRepoWithFiles([{ path: 'kept.md', versionId: 'kept', content: 'kept', mtime: 1 }]);
    const orphan = makeStorageKey(SYNC_FOLDER, 'orphan.md', 'v1');
    await fs.putText(orphan, 'orphan');
    const networkError = new TypeError('ConnectTimeout');
    const originalGet = fs.get.bind(fs);
    fs.get = async (key) => key.includes('/commits/') ? Promise.reject(networkError) : originalGet(key);

    await expect(gcRepository({ fs, syncFolder: SYNC_FOLDER })).rejects.toBe(networkError);
    expect(fs.map.has(orphan)).toBe(true);
  });

  it('损坏提交按现有保守语义视为链断裂且不删除对象', async () => {
    const fs = await createRepoWithFiles([{ path: 'kept.md', versionId: 'kept', content: 'kept', mtime: 1 }]);
    const head = (await readHead(fs, SYNC_FOLDER))!;
    const orphan = makeStorageKey(SYNC_FOLDER, 'orphan.md', 'v1');
    await fs.putText(orphan, 'orphan');
    await fs.putText(`Vault/.synx/repo/commits/${head.commitId}.json`, '{broken');

    const result = await gcRepository({ fs, syncFolder: SYNC_FOLDER });

    expect(result).toMatchObject({ deleted: 0, deletedCommits: 0, more: false });
    expect(fs.map.has(orphan)).toBe(true);
  });

  it('删除未引用孤儿对象，保留被提交引用的内容对象', async () => {
    const fs = await createRepoWithFiles([
      { path: 'a.md', fileUuid: 'uuid-a', versionId: 'v1', content: 'aaa', mtime: 1000 },
      { path: 'b.md', versionId: 'v2', content: 'bbb', mtime: 2000 },
    ]);

    // 孤儿对象：未被任何提交引用（模拟已删除文件的历史内容或中断上传残留）
    fs.putText(makeStorageKey(SYNC_FOLDER, 'orphan.md', 'v9'), 'orphan');
    // 仓库本体与保留策略对象必须保留
    fs.putText('Vault/.synx/retention.json', '{"version":1}');

    const result = await gcRepository({ fs, syncFolder: SYNC_FOLDER });
    expect(result.scanned).toBeGreaterThanOrEqual(3); // 2 内容 + 1 孤儿 + 1 retention
    expect(result.deleted).toBe(1); // 只有孤儿被删
    expect(result.more).toBe(false);

    // 被引用的内容对象保留
    expect(fs.map.has(makeStorageKey(SYNC_FOLDER, 'a.md', 'v1'))).toBe(true);
    expect(fs.map.has(makeStorageKey(SYNC_FOLDER, 'b.md', 'v2'))).toBe(true);
    // 孤儿已删，仓库本体与保留策略保留
    expect(fs.map.has(makeStorageKey(SYNC_FOLDER, 'orphan.md', 'v9'))).toBe(false);
    expect(fs.map.has('Vault/.synx/repo/HEAD.json')).toBe(true);
    expect(fs.map.has('Vault/.synx/retention.json')).toBe(true);
  });

  it('逐对象删除失败会保留待删清单，后续调用继续处理', async () => {
    const fs = await createRepoWithFiles([{ path: 'kept.md', versionId: 'kept', content: 'kept', mtime: 1 }]);
    Object.defineProperty(fs, 'deleteMany', { value: undefined, configurable: true });
    const orphan = makeStorageKey(SYNC_FOLDER, 'orphan.md', 'v1');
    await fs.putText(orphan, 'orphan');
    const originalDelete = fs.delete.bind(fs);
    let failOnce = true;
    fs.delete = async (key) => {
      if (key === orphan && failOnce) {
        failOnce = false;
        throw Object.assign(new Error('temporary failure'), { status: 503 });
      }
      await originalDelete(key);
    };

    const first = await gcRepository({ fs, syncFolder: SYNC_FOLDER });
    expect(first.more).toBe(true);
    expect(fs.map.has(orphan)).toBe(true);
    expect(JSON.parse(await fs.getText('Vault/.synx/gc-state.json')).pending).toContain(orphan);

    const second = await gcRepository({ fs, syncFolder: SYNC_FOLDER });
    expect(second.more).toBe(false);
    expect(fs.map.has(orphan)).toBe(false);
  });

  it.each([401, 403])('逐对象删除遇到认证状态 %i 时重抛且不清 GC state', async (status) => {
    const fs = await createRepoWithFiles([{ path: 'kept.md', versionId: 'kept', content: 'kept', mtime: 1 }]);
    Object.defineProperty(fs, 'deleteMany', { value: undefined, configurable: true });
    const orphan = makeStorageKey(SYNC_FOLDER, 'orphan.md', 'v1');
    await fs.putText(orphan, 'orphan');
    const originalDelete = fs.delete.bind(fs);
    fs.delete = async (key) => {
      if (key === orphan) throw Object.assign(new Error('credential rejected'), { status });
      await originalDelete(key);
    };

    await expect(gcRepository({ fs, syncFolder: SYNC_FOLDER })).rejects.toMatchObject({ status });
    expect(fs.map.has(orphan)).toBe(true);
  });

  it.each([401, 403])('读取 GC state 遇到认证状态 %i 时原样重抛', async (status) => {
    const fs = await createRepoWithFiles([{ path: 'kept.md', versionId: 'kept', content: 'kept', mtime: 1 }]);
    const authError = Object.assign(new Error('credential rejected'), { status });
    const originalGet = fs.get.bind(fs);
    fs.get = async (key) => {
      if (key === 'Vault/.synx/gc-state.json') throw authError;
      return originalGet(key);
    };

    await expect(gcRepository({ fs, syncFolder: SYNC_FOLDER })).rejects.toBe(authError);
  });

  it.each([401, 403])('删除 GC state 遇到认证状态 %i 时原样重抛且不报告完成', async (status) => {
    const fs = new MemFs();
    const authError = Object.assign(new Error('credential rejected'), { status });
    fs.delete = async (key) => {
      if (key === 'Vault/.synx/gc-state.json') throw authError;
    };
    let reported: Awaited<ReturnType<typeof gcRepository>> | undefined;

    await expect(gcRepository({ fs, syncFolder: SYNC_FOLDER }).then((result) => {
      reported = result;
    })).rejects.toBe(authError);
    expect(reported).toBeUndefined();
  });

  it('maxCommits 限制遍历时标记 more=true，且不会误删未遍历提交引用的对象', async () => {
    const fs = await createRepoWithFiles([{ path: 'a.md', fileUuid: 'uuid-a', versionId: 'v1', content: 'aaa', mtime: 1000 }]);
    const head1 = (await readHead(fs, SYNC_FOLDER))!;
    // 第二个提交：把 a.md 改成新内容
    const blob2 = makeStorageKey(SYNC_FOLDER, 'a.md', 'v2');
    fs.putText(blob2, 'aaa2');
    const { commit: c2 } = await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head1.commitId, baseGeneration: head1.generation,
      changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob2, hash: 'h2', size: 4, mtime: 2000 }],
    });
    expect(c2.parentCommitId).toBe(head1.commitId);

    // 只遍历 1 个提交：v1 属于更早的 add 提交，未被遍历到 → 保守保留（不会误删）
    const result = await gcRepository({ fs, syncFolder: SYNC_FOLDER, maxCommits: 1 });
    expect(result.more).toBe(true); // 提交链未遍历完
    expect(fs.map.has(makeStorageKey(SYNC_FOLDER, 'a.md', 'v1'))).toBe(true);
    expect(fs.map.has(blob2)).toBe(true);

    // 补齐遍历后：v1 仍被 add 提交引用 → 保留
    const full = await gcRepository({ fs, syncFolder: SYNC_FOLDER });
    expect(full.more).toBe(false);
    expect(fs.map.has(makeStorageKey(SYNC_FOLDER, 'a.md', 'v1'))).toBe(true);
    expect(fs.map.has(blob2)).toBe(true);
  });

  it('按保留策略做时间机器式裁剪：淘汰超窗提交及其独有对象，边界对齐到 checkpoint', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const base = Date.now();
    const fs = await createRepoWithFiles([{ path: 'a.md', fileUuid: 'uuid-a', versionId: 'v1', content: 'v1', mtime: 1000 }]);
    let head = (await readHead(fs, SYNC_FOLDER))!;
    const headCommits: RepoCommit[] = []; // 新→旧：headCommits[0] = HEAD(gen20)
    const blobOf = new Map<number, string>(); // generation → blobId
    blobOf.set(1, makeStorageKey(SYNC_FOLDER, 'a.md', 'v1'));
    for (let gen = 2; gen <= 20; gen++) {
      const blob = makeStorageKey(SYNC_FOLDER, 'a.md', `v${gen}`);
      fs.putText(blob, `v${gen}`);
      blobOf.set(gen, blob);
      const { commit, head: nextHead } = await finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        now: base - (20 - gen) * DAY, // gen20 最新，越旧越靠前
        changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob, hash: `h${gen}`, size: 2, mtime: 1000 * gen }],
      });
      headCommits.push(commit);
      head = nextHead;
    }
    // headCommits 当前顺序 = gen2..gen20（旧→新），倒转为新→旧
    const newestFirst = [...headCommits].reverse(); // newestFirst[0] = gen20

    // 保留策略：3 天窗口。最近 3 天提交保留，更旧的按天桶保留 1 份 → 实际仅近 3 天；
    // checkpoint 对齐后边界落到 gen10（CHECKPOINT_INTERVAL=10，gen10/gen20 有完整快照）
    const result = await gcRepository({
      fs,
      syncFolder: SYNC_FOLDER,
      policy: { maxFileSize: 0, hourlyWindowHours: 0, dailyWindowDays: 3, monthlyWindowMonths: 0, yearlyWindowYears: 0, maxVersionsPerFile: 0 },
    });

    // gen10..gen20 保留（11 个），gen1..gen9 淘汰（9 个）
    expect(result.deletedCommits).toBe(9);
    expect(result.more).toBe(false);
    expect(result.deleted).toBeGreaterThanOrEqual(18); // 9 blob + 9 commit + initial checkpoint

    const genOf = (commit: RepoCommit): number => commit.generation;
    const idxOf = (gen: number): number => newestFirst.findIndex((c) => genOf(c) === gen);
    const key = (commitId: string): string => `Vault/.synx/repo/commits/${commitId}.json`;
    const ckey = (commitId: string): string => `Vault/.synx/repo/checkpoints/${commitId}.json`;

    // gen10 提交与 checkpoint 保留；gen9 及更旧提交淘汰
    expect(fs.map.has(key(newestFirst[idxOf(10)].commitId))).toBe(true);
    expect(fs.map.has(ckey(newestFirst[idxOf(10)].commitId))).toBe(true);
    expect(fs.map.has(key(newestFirst[idxOf(9)].commitId))).toBe(false);

    // 内容对象：v10 blob 保留（gen11 引用）；v9 blob 保留（边界提交 gen10 引用）；
    // v8/v1 blob 仅被已淘汰提交引用 → 删除
    expect(fs.map.has(blobOf.get(10)!)).toBe(true);
    expect(fs.map.has(blobOf.get(9)!)).toBe(true);
    expect(fs.map.has(blobOf.get(8)!)).toBe(false);
    expect(fs.map.has(blobOf.get(1)!)).toBe(false);

    // HEAD 不变
    const headAfter = (await readHead(fs, SYNC_FOLDER))!;
    expect(headAfter.commitId).toBe(newestFirst[0].commitId);

    // 保留提交内容树仍可解析（checkpoint 对齐保证不依赖已删提交）；gen10 引用 v9
    const tree = await resolveTree(fs, SYNC_FOLDER, newestFirst[idxOf(10)]);
    expect(tree.get('a.md')?.blobId).toBe(blobOf.get(9)!);
  });

  it('裁剪后保留仍被边界检查点树引用的 blob（长期未修改文件不被误删）', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const base = Date.now();
    const fs = new MemFs();
    const { head: initHead } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });

    // 第一个同步提交：a.md 与 b.md 都加入（b.md 此后不再变动）
    const a1 = makeStorageKey(SYNC_FOLDER, 'a.md', 'a1');
    const b1 = makeStorageKey(SYNC_FOLDER, 'b.md', 'b1');
    fs.putText(a1, 'a1');
    fs.putText(b1, 'b1');
    let head = initHead;
    await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      now: base - 18 * DAY,
      changes: [
        { identity: 'uuid-a', operation: 'add', path: 'a.md', blobId: a1, hash: 'ha1', size: 2, mtime: 1000 },
        { identity: 'uuid-b', operation: 'add', path: 'b.md', blobId: b1, hash: 'hb1', size: 2, mtime: 1000 },
      ],
    });
    head = (await readHead(fs, SYNC_FOLDER))!;

    // gen3..gen12：只改 a.md（每隔一天）。b.md 自 gen2 后不再变动。
    for (let gen = 3; gen <= 12; gen++) {
      const blob = makeStorageKey(SYNC_FOLDER, 'a.md', `a${gen}`);
      fs.putText(blob, `a${gen}`);
      ({ head } = await finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        now: base - (12 - gen) * DAY,
        changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob, hash: `ha${gen}`, size: 2, mtime: 1000 * gen }],
      }));
    }

    // 3 天窗口：淘汰 gen1..gen9，边界对齐到 gen10 checkpoint
    const result = await gcRepository({
      fs, syncFolder: SYNC_FOLDER,
      policy: { maxFileSize: 0, hourlyWindowHours: 0, dailyWindowDays: 3, monthlyWindowMonths: 0, yearlyWindowYears: 0, maxVersionsPerFile: 0 },
    });

    // 前置条件：确实发生了裁剪（否则测试场景不成立）
    expect(result.deletedCommits).toBeGreaterThan(0);
    // b.md 的 blob 只被 gen2 提交（已淘汰）与 gen10 检查点树引用，
    // 而 gen10 是保留边界 → b1 必须保留，否则「保留提交的完整状态」无法重建
    expect(fs.map.has(b1)).toBe(true);
    // 仅被淘汰提交引用的 a.md 旧版本可删（a1 由 gen2 引用）
    expect(fs.map.has(a1)).toBe(false);
  });

  it('长链（>40 提交）可跨多次调用渐进收敛：链未遍历完时不删，到链尾才裁剪+清理', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const base = Date.now();
    const N = 65; // init(gen1) + gen2..gen65 = 65 个提交，超过默认单次遍历上限 40
    const fs = new MemFs();
    const { head: initHead } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const idOf = new Map<number, string>();
    const commitOf = new Map<number, RepoCommit>();
    const blobOf = new Map<number, string>();
    idOf.set(1, initHead.commitId);
    let head = initHead;
    for (let gen = 2; gen <= N; gen++) {
      const blob = makeStorageKey(SYNC_FOLDER, 'a.md', `v${gen}`);
      fs.putText(blob, `v${gen}`);
      blobOf.set(gen, blob);
      const { commit, head: nextHead } = await finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        now: base - (N - gen) * DAY, // gen65 最新，越旧越靠前
        changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob, hash: `h${gen}`, size: 2, mtime: 1000 * gen }],
      });
      idOf.set(gen, commit.commitId);
      commitOf.set(gen, commit);
      head = nextHead;
    }
    const policy = { maxFileSize: 0, hourlyWindowHours: 0, dailyWindowDays: 3, monthlyWindowMonths: 0, yearlyWindowYears: 0, maxVersionsPerFile: 0 };

    // 首轮只扫 10 个提交：链未遍历完 → more=true 且不删任何对象（保守）
    const first = await gcRepository({ fs, syncFolder: SYNC_FOLDER, maxCommits: 10, policy });
    expect(first.more).toBe(true);
    expect(first.deleted).toBe(0);
    expect(first.deletedCommits).toBe(0);

    // 持续以小步长调用（每轮 10 提交扫描 + 15 删除预算），直到 more=false 收敛
    let result = first;
    let totalDeletedCommits = 0;
    let totalDeleted = 0;
    let rounds = 0;
    while (result.more && rounds < 30) {
      result = await gcRepository({ fs, syncFolder: SYNC_FOLDER, maxCommits: 10, maxDeletes: 15, policy });
      totalDeleted += result.deleted;
      totalDeletedCommits += result.deletedCommits;
      rounds++;
    }
    expect(result.more).toBe(false);
    expect(rounds).toBeLessThan(30);

    // 3 天窗口下长链确实被裁剪：>50 个提交被淘汰，边界 checkpoint（gen60）保留
    expect(totalDeletedCommits).toBeGreaterThanOrEqual(50);
    expect(totalDeleted).toBeGreaterThan(0);

    const key = (id: string): string => `Vault/.synx/repo/commits/${id}.json`;
    const ckey = (id: string): string => `Vault/.synx/repo/checkpoints/${id}.json`;
    // HEAD 与边界提交（含其 checkpoint）保留；更旧提交淘汰
    expect(fs.map.has(key(idOf.get(N)!))).toBe(true);
    expect(fs.map.has(key(idOf.get(60)!))).toBe(true);
    expect(fs.map.has(ckey(idOf.get(60)!))).toBe(true);
    expect(fs.map.has(key(idOf.get(59)!))).toBe(false);
    // 内容对象：边界提交引用的 v60 保留；仅被已淘汰提交引用的 v2 删除
    expect(fs.map.has(blobOf.get(60)!)).toBe(true);
    expect(fs.map.has(blobOf.get(2)!)).toBe(false);

    // HEAD 不变，边界提交内容树仍可解析（checkpoint 对齐）
    const headAfter = (await readHead(fs, SYNC_FOLDER))!;
    expect(headAfter.commitId).toBe(idOf.get(N));
    const tree = await resolveTree(fs, SYNC_FOLDER, commitOf.get(60)!);
    expect(tree.get('a.md')?.blobId).toBe(blobOf.get(60)!);
  });

  it('GC 进行中 HEAD 被推进时补扫新提交并续扫，不误删新提交引用的对象', async () => {
    const fs = await createRepoWithFiles([{ path: 'a.md', fileUuid: 'uuid-a', versionId: 'v1', content: 'v1', mtime: 1000 }]);
    let head = (await readHead(fs, SYNC_FOLDER))!;
    for (let gen = 2; gen <= 5; gen++) {
      const blob = makeStorageKey(SYNC_FOLDER, 'a.md', `v${gen}`);
      fs.putText(blob, `v${gen}`);
      ({ head } = await finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob, hash: `h${gen}`, size: 2, mtime: 1000 * gen }],
      }));
    }

    // 两轮小步扫描建立进度（head=gen5，cursor 停在旧链中间）
    let r = await gcRepository({ fs, syncFolder: SYNC_FOLDER, maxCommits: 1 });
    expect(r.more).toBe(true);
    r = await gcRepository({ fs, syncFolder: SYNC_FOLDER, maxCommits: 1 });
    expect(r.more).toBe(true);
    // 进度已持久化（否则 HEAD 推进时无从丢弃，长链也永远无法续扫）
    expect(fs.map.has('Vault/.synx/gc-state.json')).toBe(true);

    // 另一设备推进 HEAD → 新增 gen6（引用新 blob v6）
    const v6 = makeStorageKey(SYNC_FOLDER, 'a.md', 'v6');
    fs.putText(v6, 'v6');
    const { commit: gen6Commit, head: gen6Head } = await finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: v6, hash: 'h6', size: 2, mtime: 6000 }],
    });

    // 旧进度基于 gen5 → HEAD 推进后应把 gen6 补扫进进度头部（而非丢弃重扫），
    // 否则长链在多次同步之间永远无法推进到链尾
    r = await gcRepository({ fs, syncFolder: SYNC_FOLDER, maxCommits: 1 });
    expect(r.more).toBe(true); // 链仍未遍历完
    const stateAfter = JSON.parse(await fs.getText('Vault/.synx/gc-state.json'));
    expect(stateAfter.head).toBe(gen6Head.commitId);
    // 补扫合并：进度含 gen6 + 旧进度(gen5/gen4)；若是丢弃重扫则只有 gen6 一条
    expect(stateAfter.commits.length).toBeGreaterThanOrEqual(2);
    expect(stateAfter.commits[0].id).toBe(gen6Commit.commitId);

    let result = r;
    let guard = 0;
    while (result.more && guard++ < 10) {
      result = await gcRepository({ fs, syncFolder: SYNC_FOLDER });
    }
    expect(result.more).toBe(false);
    // 新提交与其 blob 绝不能被误删
    expect(fs.map.has(v6)).toBe(true);
    expect(fs.map.has(makeStorageKey(SYNC_FOLDER, 'a.md', 'v5'))).toBe(true);
    const headAfter = (await readHead(fs, SYNC_FOLDER))!;
    expect(headAfter.commitId).toBe(gen6Head.commitId);
    const tree = await resolveTree(fs, SYNC_FOLDER, gen6Commit);
    expect(tree.get('a.md')?.blobId).toBe(v6);
  });

  it('链深超过单次同步预算(8轮×40)且同步间持续追加提交时，补扫续扫跨同步收敛', async () => {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const base = Date.now();
    const RET_POLICY = { maxFileSize: 0, hourlyWindowHours: 0, dailyWindowDays: 3, monthlyWindowMonths: 0, yearlyWindowYears: 0, maxVersionsPerFile: 0 };
    const N_A = 351; // init(gen1) + gen2..gen351 = 351 个提交，超过单次同步预算 320
    const fs = new MemFs();
    const { head: initHead } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const idOf = new Map<number, string>();
    const blobOf = new Map<number, string>();
    idOf.set(1, initHead.commitId);
    let head = initHead;
    // 批 A：350 条提交，时间覆盖约 87 天（远超 3 天保留窗口）——模拟仓库历史积累超深
    for (let gen = 2; gen <= N_A; gen++) {
      const blob = makeStorageKey(SYNC_FOLDER, 'a.md', `v${gen}`);
      fs.putText(blob, `v${gen}`);
      blobOf.set(gen, blob);
      const { commit, head: nextHead } = await finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        now: base - (N_A - gen) * SIX_HOURS, // gen351 最新，越旧越靠前
        changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob, hash: `h${gen}`, size: 2, mtime: 1000 * gen }],
      });
      idOf.set(gen, commit.commitId);
      head = nextHead;
    }
    expect(head.generation).toBe(N_A);

    // 第一次同步的自动 GC：默认 8 轮 × 40 = 320 条预算扫不完 350 条链 → 始终 more=true 且不删任何对象
    let result = await gcRepository({ fs, syncFolder: SYNC_FOLDER, policy: RET_POLICY });
    for (let i = 0; i < 7; i++) {
      expect(result.more).toBe(true);
      expect(result.deleted).toBe(0); // 链未扫完 → 保守不删
      result = await gcRepository({ fs, syncFolder: SYNC_FOLDER, policy: RET_POLICY });
    }
    // 8 轮后进度正好 320 条，游标停在链中部，仍有 31 条未扫（链深超预算，本次同步无法收敛）
    const stateAfter8 = JSON.parse(await fs.getText('Vault/.synx/gc-state.json'));
    expect(stateAfter8.commits.length).toBe(320);
    expect(stateAfter8.cursor).not.toBeNull();

    // 第二次同步：批 B 追加 30 条提交（gen352..gen381，最近 1 分钟），HEAD 推进
    for (let gen = N_A + 1; gen <= N_A + 30; gen++) {
      const blob = makeStorageKey(SYNC_FOLDER, 'a.md', `v${gen}`);
      fs.putText(blob, `v${gen}`);
      blobOf.set(gen, blob);
      const { commit, head: nextHead } = await finalizeCommit({
        storageId: 's1', syncFolder: SYNC_FOLDER, fs,
        baseCommitId: head.commitId, baseGeneration: head.generation,
        now: base + (gen - N_A) * 1000,
        changes: [{ identity: 'uuid-a', operation: 'modify', path: 'a.md', blobId: blob, hash: `h${gen}`, size: 2, mtime: 1000 * gen }],
      });
      idOf.set(gen, commit.commitId);
      head = nextHead;
    }
    const N = N_A + 30; // 381
    expect(head.generation).toBe(N);

    // 第二次同步的自动 GC：补扫 30 条新提交进进度头部，再沿旧游标向链尾推进
    let checkedMerge = false;
    let guard = 0;
    while (result.more && guard < 20) {
      result = await gcRepository({ fs, syncFolder: SYNC_FOLDER, policy: RET_POLICY });
      if (!checkedMerge) {
        // 补扫合并生效：进度头部是批 B 最新提交，且旧进度(320)保留——而非丢弃重扫
        const st = JSON.parse(await fs.getText('Vault/.synx/gc-state.json'));
        expect(st.commits[0].id).toBe(idOf.get(N));
        expect(st.commits.length).toBeGreaterThan(320);
        checkedMerge = true;
      }
      guard++;
    }
    expect(result.more).toBe(false);
    expect(guard).toBeLessThan(20);
    expect(8 + guard).toBeGreaterThan(8); // 单次同步 8 轮预算内无法收敛，必须跨同步继续

    // 时间机器裁剪确实发生：3 天窗口，批 B 同一天仅保留 HEAD，边界对齐到 gen380 checkpoint
    expect(result.deletedCommits).toBeGreaterThan(0);
    expect(result.deleted).toBeGreaterThan(0);
    const ckey = (id: string): string => `Vault/.synx/repo/checkpoints/${id}.json`;
    // HEAD 与边界 checkpoint（gen380）保留；早期提交 blob 按保留策略淘汰
    expect(fs.map.has(blobOf.get(N)!)).toBe(true);
    expect(fs.map.has(ckey(idOf.get(380)!))).toBe(true);
    expect(fs.map.has(blobOf.get(2)!)).toBe(false);
    // HEAD 不变，且内容树经边界 checkpoint 仍完整可解析
    const headAfter = (await readHead(fs, SYNC_FOLDER))!;
    expect(headAfter.commitId).toBe(idOf.get(N));
    const headCommit = await getCommitDetail(fs, SYNC_FOLDER, headAfter.commitId);
    const tree = await resolveTree(fs, SYNC_FOLDER, headCommit);
    expect(tree.get('a.md')?.blobId).toBe(blobOf.get(N)!);
  });
});

describe('withRepoLock（原子建锁）', () => {
  it.each([401, 403])('任务成功后删除自己的锁遇到认证状态 %i 时原样传播', async (status) => {
    const fs = new MemFs(true, true);
    const { head } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const blob = makeStorageKey(SYNC_FOLDER, 'a.md', 'delete-lock-auth');
    await fs.putText(blob, 'content');
    const authError = Object.assign(new Error('credential rejected'), { status });
    const originalDelete = fs.delete.bind(fs);
    fs.delete = async (key) => {
      if (key.endsWith('lock.json')) throw authError;
      await originalDelete(key);
    };

    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-a', operation: 'add', path: 'a.md', blobId: blob, hash: 'h1', size: 7, mtime: 1000 }],
    })).rejects.toBe(authError);
  });

  it.each([401, 403])('清理过期锁遇到认证状态 %i 时原样传播而非 HeadConflictError', async (status) => {
    const fs = new MemFs(true, true);
    const { head } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const blob = makeStorageKey(SYNC_FOLDER, 'a.md', 'expired-lock-auth');
    await fs.putText(blob, 'content');
    await fs.putText('Vault/.synx/repo/lock.json', JSON.stringify({ token: 'expired', expiresAt: Date.now() - 1 }));
    const authError = Object.assign(new Error('credential rejected'), { status });
    const originalDelete = fs.delete.bind(fs);
    fs.delete = async (key) => {
      if (key.endsWith('lock.json')) throw authError;
      await originalDelete(key);
    };

    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-a', operation: 'add', path: 'a.md', blobId: blob, hash: 'h1', size: 7, mtime: 1000 }],
    })).rejects.toBe(authError);
  });

  it('读锁后建锁窗口内被他人抢占时不再并发进入，提交抛 HeadConflictError', async () => {
    // 模拟：另一 Worker 在我们读锁之后、写锁之前抢先写入了锁对象。
    // 旧实现用无条件 put 覆盖他人锁 → 两个任务同时持锁进入（同一 generation、不同
    // commitId 的 HEAD 互相覆盖，后写者胜出，先写者变更丢失）；
    // 新实现用 putIfNoneMatch 原子建锁 → 发现锁已被占用 → 重试失败 → HeadConflictError。
    const fs = new MemFs(true, true); // 条件写可用但 If-Match 恒失配 → casWriteHead 走锁路径
    const originalPutIfNoneMatch = fs.putIfNoneMatch!;
    let injected = false;
    // MemFs 构造器把 putIfNoneMatch 作为自身属性赋值，需在构造后包装才能拦截
    fs.putIfNoneMatch = async (key, content) => {
      if (key.endsWith('lock.json') && !injected) {
        injected = true;
        fs.map.set(key, new TextEncoder().encode(JSON.stringify({ token: 'foreign', expiresAt: Date.now() + 15_000 })));
      }
      return originalPutIfNoneMatch(key, content);
    };

    const { head } = await initRepository({ storageId: 's1', syncFolder: SYNC_FOLDER, fs });
    const blob = makeStorageKey(SYNC_FOLDER, 'a.md', 'v1');
    fs.putText(blob, 'content');
    // 锁被他人持有时绝不应推进 HEAD（否则并发提交会互相覆盖）
    await expect(finalizeCommit({
      storageId: 's1', syncFolder: SYNC_FOLDER, fs,
      baseCommitId: head.commitId, baseGeneration: head.generation,
      changes: [{ identity: 'uuid-a', operation: 'add', path: 'a.md', blobId: blob, hash: 'h1', size: 7, mtime: 1000 }],
    })).rejects.toThrow(HeadConflictError);
  });
});
