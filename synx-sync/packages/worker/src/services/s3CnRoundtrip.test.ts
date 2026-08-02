import { describe, expect, it, beforeEach, vi } from 'vitest';
import { S3Fs } from '../storage/s3Fs.js';
import { getVersion, listFiles, putVersion } from './versionService.js';
import type { Env } from '../types.js';

// 回归测试：非 md 文件（identity = `path:中文路径`）+ S3 存储时，
// 曾因 metadata key 双重 URL 编码导致 ListObjectsV2 匹配不到版本元数据，
// getVersion 抛 "no current for <path>"（404）。修复后 PUT 与 LIST 编码对称。
// 场景文件路径含中文与空格，与线上报错路径同构：
// 编程代码/我的dockers compose/assets/大模型KEY/xxx_MD5.jpeg

const CN_PATH = '编程代码/我的dockers compose/assets/大模型KEY/aa00ca977a70bcb9029f0af6f90b4773_MD5.jpeg';
const SYNC_FOLDER = 'vault';

function makeNoPruneEnv(): Env {
  const noPrune = JSON.stringify({ hourlyWindowHours: 0, dailyWindowDays: 0, monthlyWindowMonths: 0, yearlyWindowYears: 0 });
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ retention_policy: noPrune }) }) }),
    },
  } as unknown as Env;
}

/** 模拟真实 S3 服务端：PUT/HEAD/GET/DELETE 对 URL path 解码一次得到存储 key；
 *  LIST 对 query prefix 解码一次后与存储 key 做前缀匹配。 */
function mockS3Server(store: Map<string, Uint8Array>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    if (url.searchParams.has('list-type')) {
      // URLSearchParams 已对 query 解码一次（等价于 S3 服务端解码 query 参数）。
      // 不能再 decodeURIComponent：否则双重解码会掩盖「编码不对称」的 bug。
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</Key></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (url.pathname.startsWith('/b/')) {
      // URL path 上的 %XX 需要手动解码一次（等价于 S3 服务端解码对象 key）
      const key = decodeURIComponent(url.pathname.slice('/b/'.length));
      if (req.method === 'PUT') {
        store.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (req.method === 'HEAD') return new Response(null, { status: store.has(key) ? 200 : 404 });
      if (req.method === 'DELETE') {
        store.delete(key);
        return new Response(null, { status: 200 });
      }
      const data = store.get(key);
      if (!data) return new Response('not found', { status: 404 });
      return new Response(data);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeS3Fs(): WorkerFsLike {
  const store = new Map<string, Uint8Array>();
  mockS3Server(store);
  return {
    _store: store,
    fs: new S3Fs({ endpoint: 'https://s3.example.com', bucket: 'b', accessKey: 'ak', secretKey: 'sk', region: 'us-east-1', pathStyle: true }),
  };
}

interface WorkerFsLike {
  _store: Map<string, Uint8Array>;
  fs: S3Fs;
}

describe('S3 中文路径非 md 文件同步（回归）', () => {
  it('putVersion → listFiles → getVersion 全链路不抛 404', async () => {
    const { fs, _store } = makeS3Fs();
    const env = makeNoPruneEnv();
    const base = { env, userId: 'user-1', storageId: 'storage-1', syncFolder: SYNC_FOLDER, fs };

    const version = await putVersion({
      ...base,
      path: CN_PATH,
      content: new TextEncoder().encode('jpeg-bytes'),
      mtime: 100,
    });

    // 索引层能看到该文件
    const files = await listFiles(base);
    expect(files.map((f) => f.path)).toContain(CN_PATH);

    // 内容层能取到（修复前 getVersion 抛 VersionNotFound → 404）
    const { content } = await getVersion({ ...base, path: CN_PATH });
    expect(new TextDecoder().decode(content)).toBe('jpeg-bytes');
    expect(version.storageKey).toBeTruthy();
  });

  it('history 中记录的 storageKey 对应对象真实存在', async () => {
    const { fs, _store } = makeS3Fs();
    const env = makeNoPruneEnv();
    const base = { env, userId: 'user-1', storageId: 'storage-1', syncFolder: SYNC_FOLDER, fs };

    const version = await putVersion({
      ...base,
      path: CN_PATH,
      content: new TextEncoder().encode('v1'),
      mtime: 100,
    });

    // S3 上内容对象与元数据对象都按原始路径存储（无 %XX 残留），list 根目录可见
    expect(_store.has(version.storageKey)).toBe(true);
    expect([..._store.keys()].some((k) => k.startsWith(`${SYNC_FOLDER}/.synx/files/path:${CN_PATH}/versions/`))).toBe(true);
  });
});
