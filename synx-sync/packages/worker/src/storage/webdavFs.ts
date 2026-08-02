import type { WebdavConfig, WorkerFs } from '@synx/shared';
import { checkConnectivity } from './connectivity.js';

/** 向后兼容别名 */
export const checkWebdavConnectivity = checkConnectivity;

// ── 工具函数 ──────────────────────────────────────────

/**
 * 将自定义请求头文本解析为键值对。
 * 每行一个，格式 `Key: Value`。
 * 参考 Remotely Save 的 parseCustomHeaders。
 */
function parseCustomHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.trim().split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** 仅 ASCII 字符检测（参考 Remotely Save） */
function onlyAscii(str: string): boolean {
  return !/[^\u0000-\u00ff]/g.test(str);
}

/** 对非 ASCII 的用户名/密码做 UTF-8 → Latin1 转换 */
function tryEncodeUsernamePassword(x: string): string {
  if (onlyAscii(x)) return x;
  return unescape(encodeURIComponent(x));
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function pathSegments(path: string, allowEmpty: boolean): string[] {
  if ((!allowEmpty && !path) || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('invalid webdav path');
  }
  const segments = path ? path.split('/') : [];
  if (segments.some((segment) => !segment || isUnsafeSegment(segment))) {
    throw new Error('invalid webdav path');
  }
  return segments;
}

function isUnsafeSegment(segment: string): boolean {
  let decoded = segment;
  for (let i = 0; i < 3; i++) {
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return false;
      decoded = next;
    } catch {
      return true;
    }
  }
  return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || /%[0-9a-f]{2}/i.test(decoded);
}

function encodePath(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

// ── PROPFIND XML 解析 ────────────────────────────────

interface PropfindEntry {
  href: string;
  isCollection: boolean;
}

/**
 * 解析 WebDAV PROPFIND multistatus XML。
 * 用正则而非 DOMParser（Workers 中不可用），参考 s3Fs.ts 的 XML 解析方式。
 * 兼容不同命名空间前缀（D:, d:, lp1:, 无前缀）。
 */
function parsePropfind(xml: string): PropfindEntry[] {
  const entries: PropfindEntry[] = [];
  const responseRe = /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let m: RegExpExecArray | null;
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1];
    const href = extractTag(block, 'href');
    if (!href) continue;
    const isCollection = /<(?:\w+:)?collection\b/i.test(block);
    entries.push({ href: decodeXml(href.trim()), isCollection });
  }
  return entries;
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([^<]*)</(?:\\w+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

// ── WebDAV 适配器 ─────────────────────────────────────

/**
 * WebDAV 存储适配器。
 *
 * 设计参考 Remotely Save 的 FakeFsWebdav，适配 Cloudflare Workers 环境：
 * - 使用原生 fetch（不能用 webdav npm 包，它依赖 Node.js API）
 * - Basic auth（Digest 需 MD5，Workers 原生不支持，留待后续扩展）
 * - PUT 前自动创建父目录（MKCOL），因为 WebDAV 有层级目录结构
 * - list 用 PROPFIND + BFS 递归（兼容不支持 Depth: infinity 的服务器）
 * - 路径编码：每个 path segment 独立 encodeURIComponent
 */
interface WebDAVFsOptions {
  sleep?: (milliseconds: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504, 520]);
const MAX_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 2000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class WebDAVFs implements WorkerFs {
  private readonly base: string;
  private readonly basePath: string;
  private readonly address: string;
  private readonly remoteBaseDirSegments: string[];
  private readonly customHeaders: Record<string, string>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(config: WebdavConfig, options: WebDAVFsOptions = {}) {
    const addressUrl = new URL(config.address);
    addressUrl.pathname = addressUrl.pathname.replace(/\/+$/, '');
    const address = addressUrl.toString().replace(/\/+$/, '');
    const remoteBaseDir = (config.remoteBaseDir || '').replace(/^\/+|\/+$/g, '');
    this.address = address;
    this.remoteBaseDirSegments = pathSegments(remoteBaseDir, true);
    const encodedBaseDir = encodePath(this.remoteBaseDirSegments);
    this.base = encodedBaseDir ? `${address}/${encodedBaseDir}` : address;

    // basePath 用于从 PROPFIND href 中提取相对 key
    // e.g. base = https://dav.example.com/synx → basePath = /synx
    try {
      this.basePath = new URL(this.base).pathname.replace(/\/+$/, '');
    } catch {
      this.basePath = '';
    }

    const headers: Record<string, string> = { ...parseCustomHeaders(config.customHeaders || '') };
    // 坚果云等 WebDAV 服务器对缺少 User-Agent 的请求可能返回 520（尤其 Cloudflare Workers fetch 不带默认 UA）
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'Synx-Sync/0.1 (Obsidian plugin; +https://github.com/synx)';
    }
    if (config.username && config.password) {
      const user = tryEncodeUsernamePassword(config.username);
      const pass = tryEncodeUsernamePassword(config.password);
      headers['Authorization'] = `Basic ${btoa(`${user}:${pass}`)}`;
    }
    this.customHeaders = headers;
    this.sleep = options.sleep || defaultSleep;
  }

  /**
   * 确保 remoteBaseDir 指向的目录存在。
   * 从 address 根逐层 MKCOL，忽略「已存在」的 405/301。
   * 坚果云等服务器 PUT/PROPFIND 到不存在的父目录会返回 409，
   * 因此 PUT 前必须先建好 remoteBaseDir。
   */
  private async ensureBaseDir(): Promise<void> {
    if (this.remoteBaseDirSegments.length === 0) return;
    let current = this.address;
    for (const segment of this.remoteBaseDirSegments) {
      current = `${current}/${encodeURIComponent(segment)}`;
      const res = await this.request(`${current}/`, {
        method: 'MKCOL',
        headers: this.headers(),
      });
      // 201=created, 405/301=already exists, 520=Cloudflare-to-Cloudflare 子请求偶发错误（目录可能已创建）
      // 仅 500+ 且非 520 时才视为真正的服务器错误
      if (!this.isSuccessfulMkcol(res.status)) {
        throw new Error(`webdav mkdir failed for ${current} (${res.status})`);
      }
    }
  }

  /** 构建完整 URL，对每个 path segment 做安全编码 */
  private url(key: string, allowEmpty = false): string {
    return `${this.base}/${encodePath(pathSegments(key, allowEmpty))}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { ...this.customHeaders, ...(extra || {}) };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const safeInit = { ...init, redirect: 'error' as const };
    let response = await fetch(url, safeInit);
    for (let attempt = 0; attempt < MAX_RETRIES && RETRYABLE_STATUSES.has(response.status); attempt++) {
      await this.sleep(this.retryDelay(response, attempt));
      response = await fetch(url, safeInit);
    }
    return response;
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers?.get?.('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
    }
    return Math.min(250 * (2 ** attempt), MAX_RETRY_DELAY_MS);
  }

  private isSuccessfulMkcol(status: number): boolean {
    return (status >= 200 && status < 300) || status === 301 || status === 405;
  }

  /**
   * 确保 key 的父目录存在。
   * WebDAV 有层级目录结构，PUT 前必须先 MKCOL 创建路径。
   * 从根向下逐层创建，忽略「已存在」的 405/301。
   */
  private async ensureParentDirs(key: string): Promise<void> {
    const segments = pathSegments(key, false).slice(0, -1);
    if (segments.length === 0) return;

    const current: string[] = [];
    for (const segment of segments) {
      current.push(segment);
      const dirUrl = `${this.base}/${encodePath(current)}/`;
      const res = await this.request(dirUrl, {
        method: 'MKCOL',
        headers: this.headers(),
      });
      // 201=created, 405=already exists, 301=redirect(exists)
      // 520=Cloudflare-to-Cloudflare 子请求偶发错误（目录可能已创建）
      // 仅 500+ 且非 520 时才视为真正的服务器错误
      if (!this.isSuccessfulMkcol(res.status)) {
        throw new Error(`webdav mkdir failed for ${current.join('/')} (${res.status})`);
      }
    }
  }

  async put(key: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    pathSegments(key, false);
    await this.ensureBaseDir();
    await this.ensureParentDirs(key);
    const res = await this.request(this.url(key), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: content as BufferSource,
    });
    if (res.ok) {
      if (await this.head(key)) return;
      throw new Error('webdav put verification failed');
    }
    if (RETRYABLE_STATUSES.has(res.status)) {
      const exists = await this.head(key);
      if (exists) return;
    }
    throw new Error(`webdav put failed (${res.status})`);
  }

  async get(key: string): Promise<ArrayBuffer> {
    const res = await this.request(this.url(key), {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`webdav get failed (${res.status})`);
    return res.arrayBuffer();
  }

  async delete(key: string): Promise<void> {
    const res = await this.request(this.url(key), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return;
    if (res.ok) {
      if (!await this.head(key)) return;
      throw new Error('webdav delete verification failed');
    }
    if (RETRYABLE_STATUSES.has(res.status)) {
      const exists = await this.head(key);
      if (!exists) return;
    }
    throw new Error(`webdav delete failed (${res.status})`);
  }

  async head(key: string): Promise<boolean> {
    const res = await this.request(this.url(key), {
      method: 'HEAD',
      headers: this.headers(),
    });
    if (res.ok) return true;
    if (res.status === 404 || res.status === 410) return false;
    throw new Error(`webdav head failed (${res.status})`);
  }

  /**
   * 列举 prefix 下的所有文件 key（递归）。
   *
   * 使用 PROPFIND Depth:1 + BFS 遍历，兼容不支持 Depth:infinity 的服务器
   * （如坚果云、部分 TeraCloud）。
   *
   * 参考 Remotely Save 的 walk() BFS 实现。
   */
  async list(prefix: string): Promise<string[]> {
    const results: string[] = [];
    const start = prefix.replace(/\/+$/, '');
    const queue: string[] = [start];
    const visited = new Set<string>();

    const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
  </D:prop>
</D:propfind>`;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      // PROPFIND 请求 URL 需以 / 结尾（目录语义）
      const url = this.url(current, true) + (current ? '/' : '');
      const res = await this.request(url, {
        method: 'PROPFIND',
        headers: this.headers({
          Depth: '1',
          'Content-Type': 'application/xml',
        }),
        body: propfindBody,
      });

      // 404=不存在；坚果云等对不存在路径的 PROPFIND 返回 409 Conflict，同样视为空目录
      // 520=Cloudflare 通用错误，坚果云对不存在的深层路径可能返回此码
      if (res.status === 404 || res.status === 409) continue;
      if (!res.ok) throw new Error(`webdav list failed (${res.status})`);

      const xml = await res.text();
      const entries = parsePropfind(xml);

      for (const entry of entries) {
        const key = this.normalizeKey(entry.href);
        if (key === null) continue;
        // 跳过目录自身
        if (key === current || key === `${current}/`) continue;

        if (entry.isCollection) {
          const dirKey = key.replace(/\/+$/, '');
          if (!visited.has(dirKey)) queue.push(dirKey);
        } else {
          results.push(key);
        }
      }
    }

    return results;
  }

  /**
   * 将 PROPFIND 返回的 href 规范化为相对于 base 的 key。
   * href 可能是完整 URL、绝对路径或相对路径。
   */
  private normalizeKey(href: string): string | null {
    let path: string;
    try {
      const url = new URL(href, this.base);
      path = url.pathname;
    } catch {
      path = href;
    }

    const prefix = this.basePath ? `${this.basePath}/` : '/';

    // 先尝试直接匹配
    if (path.startsWith(prefix)) {
      return decodeURIComponent(path.slice(prefix.length));
    }

    // 再尝试解码后匹配
    try {
      const decoded = decodeURIComponent(path);
      if (decoded.startsWith(prefix)) {
        return decoded.slice(prefix.length);
      }
    } catch { /* ignore */ }

    return null;
  }
}



