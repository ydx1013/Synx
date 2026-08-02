import {
  makeStorageKey,
  makeVersionId,
  type FileMeta,
  type VersionRecord,
  type WorkerFs,
} from '@synx/shared';
import type { Env } from '../types.js';
import { getRetentionPolicy, selectVersionsToKeep } from './retention.js';

function metadataRoot(syncFolder: string): string {
  return `${syncFolder.replace(/\/+$/, '')}/.synx/files/`;
}

function fileIdentity(path: string, fileUuid?: string): string {
  if (path.toLowerCase().endsWith('.md')) {
    if (!fileUuid) throw new VersionNotFound(`note UUID required for ${path}`);
    return fileUuid;
  }
  return fileUuid ?? `path:${path}`;
}

function metadataPrefix(syncFolder: string, identity: string): string {
  return `${metadataRoot(syncFolder)}${encodeURIComponent(identity)}/versions/`;
}

function metadataKey(syncFolder: string, identity: string, versionId: string): string {
  return `${metadataPrefix(syncFolder, identity)}${encodeURIComponent(versionId)}.json`;
}

function tombstoneKey(syncFolder: string, identity: string): string {
  return `${metadataRoot(syncFolder)}${encodeURIComponent(identity)}/tombstone.json`;
}

function currentKey(syncFolder: string, identity: string): string {
  return `${metadataRoot(syncFolder)}${encodeURIComponent(identity)}/current.json`;
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── 惰性 GC：墓碑过期后清理历史对象 ──
// 删除文件时历史版本对象保留 30 天（墓碑 TTL 内可恢复）；墓碑过期后这些对象
// 不再可访问，若不清理会长期积累。GC 在 listFiles 顺带执行，消耗子请求预算，
// 完全存在存储上，不依赖 D1/KV。

/** 每次 GC 最多检查的墓碑数（每个墓碑 1 次 get 子请求，需留预算给 listFiles 本体） */
const GC_TOMBSTONE_CHECK_BUDGET = 15;
/** 每次 GC 最多清理的过期文件数 */
const GC_MAX_SWEEP = 2;

/** 清理过期墓碑对应的历史版本对象与元数据；返回清理的文件数。失败不抛出，仅记日志。 */
export async function gcExpiredTombstones(
  fs: WorkerFs,
  syncFolder: string,
  metadataKeys: string[],
): Promise<number> {
  const root = metadataRoot(syncFolder);
  const tombstoneKeys = metadataKeys
    .filter((key) => key.endsWith('/tombstone.json'))
    .slice(0, GC_TOMBSTONE_CHECK_BUDGET);
  let swept = 0;
  for (const key of tombstoneKeys) {
    if (swept >= GC_MAX_SWEEP) break;
    let expiresAt: number;
    try {
      const tombstone = JSON.parse(new TextDecoder().decode(await fs.get(key))) as { expiresAt: number };
      expiresAt = tombstone.expiresAt;
    } catch {
      continue; // 墓碑不可读，跳过
    }
    if (expiresAt > Date.now()) continue; // 未过期，保留
    const identity = safeDecodeIdentity(key.slice(root.length, -'/tombstone.json'.length));
    try {
      // 从已 list 出的 metadataKeys 过滤该 identity 的版本元数据，避免额外 list 子请求
      const prefix = metadataPrefix(syncFolder, identity);
      const versionKeys = metadataKeys.filter((k) => k.startsWith(prefix) && k.endsWith('.json'));
      const toDelete: string[] = [];
      for (const versionKey of versionKeys) {
        try {
          const record = JSON.parse(new TextDecoder().decode(await fs.get(versionKey))) as VersionRecord;
          if (record.storageKey) toDelete.push(record.storageKey);
        } catch {
          // 元数据不可读，仅删元数据本身
        }
        toDelete.push(versionKey);
      }
      toDelete.push(currentKey(syncFolder, identity), key); // 墓碑也一并删除
      if (fs.deleteMany) {
        await fs.deleteMany(toDelete);
      } else {
        for (const target of toDelete) await fs.delete(target);
      }
      swept++;
    } catch (error) {
      console.error('gc: failed to sweep expired tombstone', identity, error);
    }
  }
  if (swept > 0) console.info('gc: swept expired tombstones', { swept });
  return swept;
}

// ── Manifest：当前版本索引，避免 listFiles 逐个读取版本元数据 ──

interface Manifest {
  version: 1;
  entries: Record<string, VersionRecord>;
}

function manifestKey(syncFolder: string): string {
  return `${metadataRoot(syncFolder)}manifest.json`;
}

async function readManifest(fs: WorkerFs, syncFolder: string): Promise<Map<string, VersionRecord>> {
  try {
    const data = await fs.get(manifestKey(syncFolder));
    const manifest = JSON.parse(new TextDecoder().decode(data)) as Manifest;
    return new Map(Object.entries(manifest.entries));
  } catch {
    return new Map();
  }
}

async function writeManifest(fs: WorkerFs, syncFolder: string, entries: Map<string, VersionRecord>): Promise<void> {
  const manifest: Manifest = { version: 1, entries: Object.fromEntries(entries) };
  await fs.put(manifestKey(syncFolder), new TextEncoder().encode(JSON.stringify(manifest)));
}

const manifestLocks = new Map<string, Promise<void>>();

async function withManifestLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = manifestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  manifestLocks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (manifestLocks.get(key) === current) manifestLocks.delete(key);
  }
}

async function hasActiveTombstone(fs: WorkerFs, syncFolder: string, identity: string): Promise<boolean> {
  const key = tombstoneKey(syncFolder, identity);
  if (!(await fs.head(key))) return false;
  try {
    const tombstone = JSON.parse(new TextDecoder().decode(await fs.get(key))) as { expiresAt: number };
    if (tombstone.expiresAt > Date.now()) return true;
    await fs.delete(key);
  } catch (error) {
    console.error('tombstone unreadable', key, error);
    return true;
  }
  return false;
}

async function readRecords(fs: WorkerFs, prefix: string): Promise<VersionRecord[]> {
  const allKeys = await fs.list(prefix);
  const versionKeys = allKeys.filter((k) => k.endsWith('.json') && k.includes('/versions/'));
  const records: VersionRecord[] = [];

  // 分批并发读取，每批最多 40 个（留 10 个额度给其他请求），避免超过 Workers 50 子请求上限
  const BATCH = 40;
  for (let i = 0; i < versionKeys.length; i += BATCH) {
    const batch = versionKeys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (key) => {
      try {
        const json = new TextDecoder().decode(await fs.get(key));
        if (json) return JSON.parse(json) as VersionRecord;
      } catch (error) {
        console.error('version metadata unreadable', key, error);
      }
      return null;
    }));
    for (const r of results) {
      if (r) records.push(r);
    }
  }
  records.sort((a, b) => b.createdAt - a.createdAt || b.versionId.localeCompare(a.versionId));
  for (let index = 0; index < records.length; index++) records[index].isCurrent = index === 0 ? 1 : 0;
  return records;
}

async function readHistory(
  fs: WorkerFs,
  syncFolder: string,
  path: string,
  fileUuid?: string,
): Promise<VersionRecord[]> {
  if (fileUuid || !path.toLowerCase().endsWith('.md')) {
    return readRecords(fs, metadataPrefix(syncFolder, fileIdentity(path, fileUuid)));
  }
  // 无 UUID 的 .md 文件：先从 manifest 查找 UUID，避免扫描全部记录
  const manifest = await readManifest(fs, syncFolder);
  for (const record of manifest.values()) {
    if (record.path === path && record.fileUuid) {
      return readRecords(fs, metadataPrefix(syncFolder, record.fileUuid));
    }
  }
  // Last resort：manifest 中未找到，扫描全部记录
  const all = await readRecords(fs, metadataRoot(syncFolder));
  const matched = all.filter((record) => record.path === path);
  for (let index = 0; index < matched.length; index++) matched[index].isCurrent = index === 0 ? 1 : 0;
  return matched;
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export interface PutVersionInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
  path: string;
  fileUuid?: string;
  content: ArrayBuffer | Uint8Array;
  mtime: number;
  author?: string;
  /** 并发保护：调用方打开文件时的当前版本；远端已变化则拒绝覆盖 */
  baseVersionId?: string;
}

export async function putVersion(input: PutVersionInput): Promise<VersionRecord> {
  const { env, userId, storageId, syncFolder, fs, path, fileUuid, content, mtime, author, baseVersionId } = input;
  const identity = fileIdentity(path, fileUuid);
  // tombstone 保护的是"已删除文件的身份"：md 笔记用 UUID 唯一标识身份，被删后不应被误恢复；
  // 但 .obsidian/ 等无 UUID 的配置文件用 path 作身份，路径本身可以复用（插件更新/重装=同一路径新文件），
  // 此时 tombstone 会误伤合法上传，因此遇到 path 身份的 tombstone 应视为"路径重新出现"，清除后继续。
  if (await hasActiveTombstone(fs, syncFolder, identity)) {
    if (identity.startsWith('path:')) {
      await fs.delete(tombstoneKey(syncFolder, identity));
      console.info('synx: cleared path-identity tombstone for recreated path', { path });
    } else {
      throw new VersionDeleted(`file ${path} was deleted`);
    }
  }
  const hash = await sha256Hex(content);

  // 权威：每文件独立的 current.json 指针（单对象原子 PUT，跨实例一致）。
  // manifest 仅是缓存——Cloudflare Workers 多实例下内存锁不跨实例，manifest 可能丢条目，
  // 因此 currentVersion 必须以 current.json 为准，保证内容去重短路始终生效（避免 S3 膨胀）。
  let currentVersion: VersionRecord | undefined;
  try {
    currentVersion = JSON.parse(new TextDecoder().decode(await fs.get(currentKey(syncFolder, identity)))) as VersionRecord;
  } catch {
    // 无 current 指针：视为新文件
  }
  if (!currentVersion) {
    // manifest 兜底（异常态：current 被清但 manifest 仍残留）
    const manifest = await readManifest(fs, syncFolder);
    currentVersion = manifest.get(identity);
  }

  // 并发保护：网页版打开笔记后，远端 current 必须仍是打开时的版本
  if (baseVersionId) {
    if (!currentVersion || currentVersion.versionId !== baseVersionId) {
      throw new VersionConflict(
        currentVersion
          ? `remote changed since opened: current ${currentVersion.versionId}, opened ${baseVersionId}`
          : `remote deleted since opened: ${path}`,
      );
    }
  }

  // 内容去重：如果 hash 与当前版本一致且路径未变，直接返回当前版本，不创建重复记录
  // 这是最高频的短路路径——相同内容不触发 readRecords，避免 R2 LIST 一致性问题。
  // 注意：路径变化（网页端重命名）即使内容相同也必须创建新版本以更新 path。
  if (currentVersion && currentVersion.hash === hash && currentVersion.path === path) {
    return currentVersion;
  }

  // hash 不同 → 需要创建新版本。读取完整 history 用于 versionId 冲突检查
  const history = await readRecords(fs, metadataPrefix(syncFolder, identity));
  const latestRecord = currentVersion ?? history[0];

  let createdAt = Math.max(Date.now(), (latestRecord?.createdAt ?? 0) + 1);
  let versionId = makeVersionId(createdAt, hash);
  while (history.some((item) => item.versionId === versionId)) versionId = makeVersionId(++createdAt, hash);
  const storageKey = makeStorageKey(syncFolder, path, versionId);
  const version: VersionRecord = {
    userId,
    storageId,
    fileUuid: fileUuid ?? null,
    path,
    versionId,
    mtime,
    size: content.byteLength,
    hash,
    storageKey,
    isCurrent: 1,
    author: author ?? null,
    createdAt,
  };

  await fs.put(storageKey, content);
  try {
    // 写入前的二次检查：并发场景下 tombstone 可能被重新写入。
    // 对 path 身份（无 UUID 的配置文件）同样视为路径复用，清除后继续。
    if (await hasActiveTombstone(fs, syncFolder, identity)) {
      if (identity.startsWith('path:')) await fs.delete(tombstoneKey(syncFolder, identity));
      else throw new VersionDeleted(`file ${path} was deleted`);
    }
    const encodedVersion = new TextEncoder().encode(JSON.stringify(version));
    await fs.put(metadataKey(syncFolder, identity, versionId), encodedVersion);
    await fs.put(currentKey(syncFolder, identity), encodedVersion);
  } catch (error) {
    try {
      await fs.delete(storageKey);
    } catch {
      console.error('failed to compensate version object', storageKey);
    }
    throw error;
  }

  const policy = await getRetentionPolicy(env, storageId);
  // 时间桶分层保留：每小时/每天/每月/每年各保留桶内最新 1 份，超窗口删除。
  // 仅当策略未禁用（各层窗口不全为 0）时才裁剪。
  const currentHistory = await readRecords(fs, metadataPrefix(syncFolder, identity));
  // .obsidian/ 配置文件（插件、主题、设置）无需版本历史：始终只保留最新 1 份。
  // 配置高频变化且回滚无意义，保留历史只会让存储无限膨胀（对照 remotely-save 的镜像式覆盖）。
  const keep = path.startsWith('.obsidian/')
    ? new Set([currentHistory[0]?.versionId])
    : selectVersionsToKeep(currentHistory, policy);
  if (keep.size < currentHistory.length) {
    for (const old of currentHistory) {
      if (keep.has(old.versionId)) continue;
      const oldMetadataKey = metadataKey(syncFolder, identity, old.versionId);
      try {
        await fs.delete(old.storageKey);
        await fs.delete(oldMetadataKey);
      } catch (error) {
        console.error('prune: failed to delete version', old.versionId, error);
      }
    }
  }

  // 更新 manifest：记录当前版本（1 次写入，替代 listFiles 时的 N 次读取）。
  // 同一 Worker 实例内串行化 read-modify-write，避免并发上传互相覆盖。
  await withManifestLock(`${storageId}:${syncFolder}`, async () => {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const manifest = await readManifest(fs, syncFolder);
        manifest.set(identity, version);
        await writeManifest(fs, syncFolder, manifest);
        break;
      } catch (error) {
        if (retry === 2) {
          console.error('manifest update failed after 3 retries', identity, error);
          throw new Error(`manifest update failed for ${identity}: ${error instanceof Error ? error.message : String(error)}`);
        }
        console.warn('manifest update retry', { identity, retry: retry + 1, error });
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, retry)));
      }
    }
  });

  return version;
}

export interface GetVersionInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
  path: string;
  fileUuid?: string;
  versionId?: string;
}

export async function getVersion(input: GetVersionInput): Promise<{ content: ArrayBuffer; version: VersionRecord }> {
  const history = await readHistory(input.fs, input.syncFolder, input.path, input.fileUuid);
  const candidates = input.versionId
    ? history.filter((item) => item.versionId === input.versionId)
    : history;
  for (const version of candidates) {
    if (await input.fs.head(version.storageKey)) {
      return { content: await input.fs.get(version.storageKey), version };
    }
  }
  throw new VersionNotFound(input.versionId ? `version ${input.versionId} not found` : `no current for ${input.path}`);
}

export interface ListFilesInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
}

/** 解码 R2 key 中的 identity；遇到非法 URI 序列时返回原始串，避免整个 list 请求 500 */
function safeDecodeIdentity(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export async function listFiles(input: ListFilesInput): Promise<FileMeta[]> {
  // 权威：每文件独立的 current.json 指针（单对象原子 PUT，跨实例一致）。
  // manifest 仅是缓存——Cloudflare Workers 多实例下内存锁不跨实例，manifest 可能丢条目，
  // 因此每次 listFiles 都扫描 current.json 目录自愈 manifest，保证已上传文件永远可见。
  const metadataKeys = await input.fs.list(metadataRoot(input.syncFolder));
  // 惰性 GC：墓碑过期的文件，历史版本对象不再可访问，顺带清理避免长期积累
  // （清理前先完成 manifest 读取，避免与 current.json 补齐互相干扰；失败不阻断主流程）
  await gcExpiredTombstones(input.fs, input.syncFolder, metadataKeys);
  const deletedIdentities = new Set(
    metadataKeys
      .filter((key) => key.endsWith('/tombstone.json'))
      .map((key) => key.slice(metadataRoot(input.syncFolder).length, -'/tombstone.json'.length))
      .map((encoded) => safeDecodeIdentity(encoded)),
  );
  const currentByIdentity = new Map<string, VersionRecord>();
  const manifest = await readManifest(input.fs, input.syncFolder);
  // 先合并 manifest（1 次子请求，避免对每个文件逐一读取），
  // 再扫描 current.json 目录补齐 manifest 丢失的条目。
  for (const [identity, record] of manifest) currentByIdentity.set(identity, record);

  const currentKeys = metadataKeys.filter((key) => key.endsWith('/current.json'));
  let changed = false;
  for (const key of currentKeys) {
    const identity = safeDecodeIdentity(key.slice(metadataRoot(input.syncFolder).length, -'/current.json'.length));
    if (currentByIdentity.has(identity)) continue; // manifest 已覆盖，跳过读取
    try {
      const record = JSON.parse(new TextDecoder().decode(await input.fs.get(key))) as VersionRecord;
      currentByIdentity.set(identity, record);
      changed = true; // manifest 缺失条目，已从 current.json 补齐
    } catch (error) {
      console.error('current pointer unreadable', key, error);
    }
  }

  // 信任 current.json / manifest 指针：putVersion 在同一事务内先写内容对象、再写 current.json，
  // 失败有补偿删除，因此指针指向的对象必然存在。不做逐文件 head 校验——
  // 否则文件数超过 50 时会触发 Cloudflare Workers 单请求子请求上限（免费版 50 次，累计）。
  const valid: VersionRecord[] = [];
  for (const [identity, current] of currentByIdentity) {
    if (deletedIdentities.has(identity)) continue;
    valid.push(current);
  }

  // 自愈：manifest 与 current.json 扫描结果合并后回写，供后续 list 快速路径使用
  if (changed) {
    try {
      await withManifestLock(`${input.storageId}:${input.syncFolder}`, async () => {
        await writeManifest(input.fs, input.syncFolder, currentByIdentity);
      });
    } catch (error) {
      console.error('manifest heal failed', error);
    }
  }

  return valid.map((current) => ({
    path: current.path,
    fileUuid: current.fileUuid,
    versionId: current.versionId,
    mtime: current.mtime,
    size: current.size,
    hash: current.hash,
    author: current.author,
  }));
}

export interface GetHistoryInput {
  env: Env;
  userId: string;
  storageId: string;
  syncFolder: string;
  fs: WorkerFs;
  path: string;
  fileUuid?: string;
}

export async function getHistory(input: GetHistoryInput): Promise<VersionRecord[]> {
  return readHistory(input.fs, input.syncFolder, input.path, input.fileUuid);
}

export async function deleteFile(input: GetHistoryInput): Promise<void> {
  const identity = fileIdentity(input.path, input.fileUuid);
  const deletedAt = Date.now();
  await input.fs.put(
    tombstoneKey(input.syncFolder, identity),
    new TextEncoder().encode(JSON.stringify({ version: 1, path: input.path, fileUuid: input.fileUuid ?? null, deletedAt, expiresAt: deletedAt + TOMBSTONE_TTL_MS })),
  );

  // 删除只移除 current；UUID 对应的版本对象和元数据保留用于历史查看与恢复。
  await input.fs.delete(currentKey(input.syncFolder, identity));
  await withManifestLock(`${input.storageId}:${input.syncFolder}`, async () => {
    const manifest = await readManifest(input.fs, input.syncFolder);
    manifest.delete(identity);
    await writeManifest(input.fs, input.syncFolder, manifest);
  });
}

export interface RollbackInput extends GetHistoryInput {
  versionId: string;
  author?: string;
}

export async function rollback(input: RollbackInput): Promise<VersionRecord> {
  const source = (await getHistory(input)).find((version) => version.versionId === input.versionId);
  if (!source) throw new VersionNotFound(`version ${input.versionId} not found`);
  const fileUuid = input.fileUuid ?? source.fileUuid ?? undefined;
  const identity = fileIdentity(input.path, fileUuid);
  await input.fs.delete(tombstoneKey(input.syncFolder, identity));
  return putVersion({
    ...input,
    fileUuid,
    content: await input.fs.get(source.storageKey),
    mtime: Date.now(),
    author: input.author ?? `rollback@${input.versionId}`,
  });
}

export class VersionDeleted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionDeleted';
  }
}

export class VersionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionConflict';
  }
}

export class VersionNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionNotFound';
  }
}
