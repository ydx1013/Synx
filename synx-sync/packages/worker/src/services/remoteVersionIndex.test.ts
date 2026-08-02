import { describe, expect, it } from 'vitest';
import type { WorkerFs } from '@synx/shared';
import { deleteFile, getHistory, getVersion, listFiles, putVersion, rollback, VersionConflict, VersionDeleted, VersionNotFound } from './versionService.js';

const USER = 'user-1';
const STORAGE_ID = 'storage-1';
const SYNC_FOLDER = 'vault';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const PATH = 'notes/idea.md';
const META_PREFIX = `vault/.synx/files/${UUID}/versions/`;

function makeMemoryFs(): WorkerFs & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(key, content) {
      store.set(key, content instanceof Uint8Array ? content : new Uint8Array(content));
    },
    async get(key) {
      const value = store.get(key);
      if (!value) throw new Error(`not found: ${key}`);
      return new Uint8Array(value).buffer;
    },
    async delete(key) {
      store.delete(key);
    },
    async list(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    },
    async head(key) {
      return store.has(key);
    },
  };
}

function readMetadata(fs: ReturnType<typeof makeMemoryFs>) {
  return [...fs.store.entries()]
    .filter(([key]) => key.startsWith(META_PREFIX))
    .map(([, content]) => JSON.parse(new TextDecoder().decode(content)));
}

describe('remote version index', () => {
  it('stores note path and versions remotely without using D1', async () => {
    const fs = makeMemoryFs();
    const env = { DB: new Proxy({}, { get: () => { throw new Error('D1 must not be used'); } }) } as any;
    const version = await putVersion({
      env,
      userId: USER,
      storageId: STORAGE_ID,
      syncFolder: SYNC_FOLDER,
      fs,
      path: PATH,
      fileUuid: UUID,
      content: new TextEncoder().encode('hello'),
      mtime: 100,
    });

    const metadata = readMetadata(fs);
    expect(metadata[0].path).toBe(PATH);
    expect(metadata[0].versionId).toBe(version.versionId);
    expect(fs.store.has(version.storageKey)).toBe(true);
  });

  it('uses UUID as note identity and updates path after rename', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, fileUuid: UUID };
    await putVersion({ ...input, path: 'notes/old.md', content: new TextEncoder().encode('old'), mtime: 1 });
    await putVersion({ ...input, path: 'notes/new.md', content: new TextEncoder().encode('new'), mtime: 2 });

    const files = await listFiles({ ...input });
    const history = await getHistory({ ...input, path: 'notes/new.md' });
    expect(readMetadata(fs)).toHaveLength(2);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('notes/new.md');
    expect(history.map((item) => item.path)).toEqual(['notes/new.md', 'notes/old.md']);
  });

  it('keeps independently written file metadata when listing files', async () => {
    const fs = makeMemoryFs();
    const secondUuid = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    const base = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs };
    await putVersion({ ...base, path: PATH, fileUuid: UUID, content: new TextEncoder().encode('one'), mtime: 1 });
    await putVersion({ ...base, path: 'notes/two.md', fileUuid: secondUuid, content: new TextEncoder().encode('two'), mtime: 2 });

    expect((await listFiles(base)).map((file) => file.path).sort()).toEqual([PATH, 'notes/two.md'].sort());
    expect([...fs.store.keys()].some((key) => key.startsWith(`vault/.synx/files/${secondUuid}/versions/`))).toBe(true);
  });

  it('index layer trusts current pointers; content existence is verified by getVersion', async () => {
    // listFiles 是索引层：信任 manifest + current.json 指针，不做逐文件 head 校验。
    // 否则文件数超过 50 时会触发 Cloudflare Workers 单请求子请求上限（累计 50 次）。
    // 内容对象是否存在由 getVersion（内容层）校验并抛 VersionNotFound。
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const version = await putVersion({ ...input, content: new TextEncoder().encode('deleted'), mtime: 1 });
    await fs.delete(version.storageKey);

    // 索引层仍返回指针条目（putVersion 事务保证指针写入时内容对象已存在）
    expect(await listFiles(input)).toHaveLength(1);
    // 内容层在拉取时校验，对象已删除则抛 VersionNotFound
    await expect(getVersion(input)).rejects.toBeInstanceOf(VersionNotFound);
  });

  it('throws VersionNotFound when metadata references a deleted content object', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const version = await putVersion({ ...input, content: new TextEncoder().encode('deleted'), mtime: 1 });
    await fs.delete(version.storageKey);

    await expect(getVersion(input)).rejects.toBeInstanceOf(VersionNotFound);
  });

  it('preserves concurrent writes to the same UUID', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    await Promise.all([
      putVersion({ ...input, content: new TextEncoder().encode('one'), mtime: 1 }),
      putVersion({ ...input, content: new TextEncoder().encode('two'), mtime: 2 }),
    ]);
    expect(await getHistory(input)).toHaveLength(2);
    expect(await listFiles(input)).toHaveLength(1);
  });

  it('rejects an overwrite when the remote current moved since it was opened', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    await putVersion({ ...input, content: new TextEncoder().encode('second'), mtime: 2 });

    // 网页端打开的是 first，远端已被改为 second → 拒绝覆盖
    await expect(
      putVersion({ ...input, content: new TextEncoder().encode('web edit'), mtime: 3, baseVersionId: first.versionId }),
    ).rejects.toBeInstanceOf(VersionConflict);

    // 远端 current 保持 second，未被覆盖
    const current = await getVersion(input);
    expect(new TextDecoder().decode(current.content)).toBe('second');
  });

  it('accepts an overwrite when the base version still matches the remote current', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });

    const saved = await putVersion({ ...input, content: new TextEncoder().encode('web edit'), mtime: 2, baseVersionId: first.versionId });
    expect(saved.versionId).not.toBe(first.versionId);

    const current = await getVersion(input);
    expect(new TextDecoder().decode(current.content)).toBe('web edit');
  });

  it('rejects an overwrite when the remote file was deleted since it was opened', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    await deleteFile(input);

    await expect(
      putVersion({ ...input, content: new TextEncoder().encode('web edit'), mtime: 2, baseVersionId: first.versionId }),
    ).rejects.toBeInstanceOf(VersionDeleted);
  });

  it('reads current and historical content from the remote index', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    await putVersion({ ...input, content: new TextEncoder().encode('second'), mtime: 2 });

    const current = await getVersion(input);
    const historical = await getVersion({ ...input, versionId: first.versionId });
    expect(new TextDecoder().decode(current.content)).toBe('second');
    expect(new TextDecoder().decode(historical.content)).toBe('first');
  });

  it('rolls back from remote metadata and appends a version', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    await putVersion({ ...input, content: new TextEncoder().encode('second'), mtime: 2 });
    await rollback({ ...input, versionId: first.versionId });

    const current = await getVersion(input);
    expect(new TextDecoder().decode(current.content)).toBe('first');
    expect(await getHistory(input)).toHaveLength(3);
  });

  it('removes current but preserves history and keeps a 30 day tombstone', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    const second = await putVersion({ ...input, content: new TextEncoder().encode('second'), mtime: 2 });

    await deleteFile(input);

    expect((await getHistory(input)).map((version) => version.versionId)).toEqual([second.versionId, first.versionId]);
    expect(await listFiles(input)).toEqual([]);
    expect(fs.store.has(first.storageKey)).toBe(true);
    expect(fs.store.has(second.storageKey)).toBe(true);
    expect(fs.store.has(`vault/.synx/files/${UUID}/tombstone.json`)).toBe(true);
    await expect(putVersion({ ...input, content: new TextEncoder().encode('revive'), mtime: 3 })).rejects.toBeInstanceOf(VersionDeleted);
  });

  it('restores a deleted note from preserved history', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    await deleteFile(input);

    const restored = await rollback({ ...input, versionId: first.versionId });

    expect(restored.hash).toBe(first.hash);
    expect(await listFiles(input)).toHaveLength(1);
    expect(fs.store.has(`vault/.synx/files/${UUID}/tombstone.json`)).toBe(false);
    expect(await getHistory(input)).toHaveLength(2);
  });

  it('allows upload after an expired tombstone is removed', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    fs.store.set(`vault/.synx/files/${UUID}/tombstone.json`, new TextEncoder().encode(JSON.stringify({ expiresAt: Date.now() - 1 })));
    await expect(putVersion({ ...input, content: new TextEncoder().encode('new'), mtime: 1 })).resolves.toBeDefined();
    expect(fs.store.has(`vault/.synx/files/${UUID}/tombstone.json`)).toBe(false);
  });

  it('garbage collects history objects once the tombstone expires', async () => {
    const fs = makeMemoryFs();
    const input = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs, path: PATH, fileUuid: UUID };
    const first = await putVersion({ ...input, content: new TextEncoder().encode('first'), mtime: 1 });
    const second = await putVersion({ ...input, content: new TextEncoder().encode('second'), mtime: 2 });
    await deleteFile(input);
    // 删除后墓碑 TTL 内历史对象保留（可恢复）
    expect(fs.store.has(first.storageKey)).toBe(true);
    expect(fs.store.has(second.storageKey)).toBe(true);
    expect(fs.store.has(`vault/.synx/files/${UUID}/tombstone.json`)).toBe(true);

    // 模拟墓碑过期：直接把 expiresAt 改为过去
    fs.store.set(`vault/.synx/files/${UUID}/tombstone.json`, new TextEncoder().encode(JSON.stringify({ expiresAt: Date.now() - 1 })));
    await listFiles(input);

    // 墓碑过期后 listFiles 触发 GC：内容对象、版本元数据、墓碑全部清理
    expect(fs.store.has(first.storageKey)).toBe(false);
    expect(fs.store.has(second.storageKey)).toBe(false);
    expect(fs.store.has(`vault/.synx/files/${UUID}/tombstone.json`)).toBe(false);
    expect([...fs.store.keys()].some((k) => k.includes(`/versions/`))).toBe(false);
  });

  it('rejects markdown notes without UUID', async () => {
    const fs = makeMemoryFs();
    await expect(putVersion({
      env: {} as any,
      userId: USER,
      storageId: STORAGE_ID,
      syncFolder: SYNC_FOLDER,
      fs,
      path: PATH,
      content: new Uint8Array(),
      mtime: 1,
    })).rejects.toBeInstanceOf(VersionNotFound);
  });

  it('heals a manifest that lost entries and still lists those files', async () => {
    const fs = makeMemoryFs();
    const secondUuid = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    const base = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs };
    const first = await putVersion({ ...base, path: PATH, fileUuid: UUID, content: new TextEncoder().encode('one'), mtime: 1 });
    const second = await putVersion({ ...base, path: 'notes/two.md', fileUuid: secondUuid, content: new TextEncoder().encode('two'), mtime: 2 });

    // 模拟跨实例并发写覆盖：manifest 丢失第二个文件的条目（但 current.json 仍在）
    const manifestKey = 'vault/.synx/files/manifest.json';
    const manifest = JSON.parse(new TextDecoder().decode(fs.store.get(manifestKey)!));
    delete manifest.entries[secondUuid];
    fs.store.set(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));

    // listFiles 应从 current.json 目录自愈，两个文件都能列出
    const files = (await listFiles(base)).map((file) => file.path).sort();
    expect(files).toEqual([PATH, 'notes/two.md'].sort());

    // 自愈后 manifest 应重新包含两个条目
    const healed = JSON.parse(new TextDecoder().decode(fs.store.get(manifestKey)!));
    expect(Object.keys(healed.entries)).toContain(UUID);
    expect(Object.keys(healed.entries)).toContain(secondUuid);
    expect(fs.store.has(second.storageKey)).toBe(true);
    expect(fs.store.has(first.storageKey)).toBe(true);
  });

  it('deduplicates content by current.json even when manifest lost the entry', async () => {
    const fs = makeMemoryFs();
    const base = { env: {} as any, userId: USER, storageId: STORAGE_ID, syncFolder: SYNC_FOLDER, fs };
    const first = await putVersion({ ...base, path: PATH, fileUuid: UUID, content: new TextEncoder().encode('same'), mtime: 1 });

    // 模拟 manifest 丢失（内容对象与 current.json 仍在）
    fs.store.delete('vault/.synx/files/manifest.json');

    // 相同内容再次上传：必须以 current.json 为权威去重短路，不产生新版本/新对象
    const dedup = await putVersion({ ...base, path: PATH, fileUuid: UUID, content: new TextEncoder().encode('same'), mtime: 99 });
    expect(dedup.versionId).toBe(first.versionId);
    const history = await getHistory({ ...base, path: PATH });
    expect(history).toHaveLength(1);
  });
});
