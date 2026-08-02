import type { OnedriveConfig, WorkerFs } from '@synx/shared';
import { checkConnectivity } from './connectivity.js';
import { ensureFreshToken } from './onedriveAuth.js';

/** 向后兼容别名 */
export const checkOnedriveConnectivity = checkConnectivity;

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const DIRECT_UPLOAD_MAX = 4 * 1024 * 1024; // 4 MB

/**
 * OneDrive 存储适配器。
 *
 * 设计参考 Remotely Save 的 FakeFsOnedrive，适配 Cloudflare Workers 环境：
 * - 使用 Microsoft Graph API（原生 fetch，无 CORS 问题）
 * - 使用 App Folder（/drive/special/approot）作为隔离存储
 * - 支持 access token 自动刷新（通过 ensureFreshToken）
 * - 小文件直接 PUT 上传，大文件走 upload session
 * - 下载使用 @microsoft.graph.downloadUrl
 *
 * 中转站角色：Worker 收到插件的文件后，转发到用户的 OneDrive App Folder。
 */
export class OneDriveFs implements WorkerFs {
  private config: OnedriveConfig;
  private readonly remoteBaseDir: string;

  constructor(config: OnedriveConfig) {
    this.config = config;
    this.remoteBaseDir = (config.remoteBaseDir || '').replace(/^\/+|\/+$/g, '');
  }

  /**
   * 确保使用有效的 access token。
   * 如果 token 过期，自动刷新。
   * 注意：刷新后的 token 只在当前实例中有效，不回写 D1（由调用方决定是否持久化）。
   */
  private async getHeaders(): Promise<Record<string, string>> {
    this.config = await ensureFreshToken(this.config);
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Cache-Control': 'no-cache',
    };
  }

  /**
   * 构建 Graph API 路径。
   * App Folder 路径格式：/drive/special/approot:/{remoteBaseDir}/{key}
   * 参考 Remotely Save 的 getOnedrivePath。
   */
  private graphPath(key: string): string {
    const prefix = this.remoteBaseDir
      ? `/drive/special/approot:/${this.remoteBaseDir}`
      : '/drive/special/approot';

    if (!key || key === '/' || key === '') return prefix;

    let k = key;
    if (k.endsWith('/')) k = k.slice(0, -1);
    if (k.startsWith('/')) k = `${prefix}${k}`;
    else k = `${prefix}/${k}`;

    return k;
  }

  private graphUrl(key: string): string {
    // encodeURI 但保留 # → %23（Graph API 要求）
    return `${GRAPH_API}${encodeURI(this.graphPath(key))}`.replace(/#/g, '%23');
  }

  async put(key: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    const headers = await this.getHeaders();
    const url = `${this.graphUrl(key)}:/content`;

    if (content.byteLength < DIRECT_UPLOAD_MAX) {
      // 小文件：直接 PUT
      const res = await fetch(`${url}?${new URLSearchParams({ '@microsoft.graph.conflictBehavior': 'replace' })}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: content as BufferSource,
      });
      if (!res.ok) throw new Error(`onedrive put failed (${res.status})`);
    } else {
      // 大文件：创建 upload session，分块上传
      // 参考 Remotely Save 的 _writeFileFromRoot 和 Graph API 文档
      const sessionRes = await fetch(`${this.graphUrl(key)}:/createUploadSession`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'replace' },
        }),
      });
      if (!sessionRes.ok) throw new Error(`onedrive createUploadSession failed (${sessionRes.status})`);

      const session = await sessionRes.json() as { uploadUrl: string };
      const uploadUrl = session.uploadUrl;

      const uint8 = content instanceof Uint8Array ? content : new Uint8Array(content);
      const RANGE_SIZE = 5 * 1024 * 1024; // 5 MB per chunk
      let start = 0;

      while (start < uint8.byteLength) {
        const end = Math.min(start + RANGE_SIZE, uint8.byteLength);
        const chunkRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${start}-${end - 1}/${uint8.byteLength}`,
            'Content-Type': 'application/octet-stream',
          },
          body: uint8.slice(start, end),
        });
        if (!chunkRes.ok) throw new Error(`onedrive upload chunk failed (${chunkRes.status})`);
        start = end;
      }
    }
  }

  async get(key: string): Promise<ArrayBuffer> {
    const headers = await this.getHeaders();

    // 先获取 downloadUrl
    const metaRes = await fetch(`${this.graphUrl(key)}?$select=@microsoft.graph.downloadUrl`, {
      headers,
    });
    if (!metaRes.ok) throw new Error(`onedrive get metadata failed (${metaRes.status})`);

    const meta = await metaRes.json() as { '@microsoft.graph.downloadUrl': string };
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) throw new Error('onedrive get: no downloadUrl in response');

    // 用 downloadUrl 下载内容（无需 auth header）
    const contentRes = await fetch(downloadUrl);
    if (!contentRes.ok) throw new Error(`onedrive download failed (${contentRes.status})`);
    return contentRes.arrayBuffer();
  }

  async delete(key: string): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(this.graphUrl(key), {
      method: 'DELETE',
      headers,
    });
    if (!res.ok && res.status !== 404) throw new Error(`onedrive delete failed (${res.status})`);
  }

  async head(key: string): Promise<boolean> {
    const headers = await this.getHeaders();
    const res = await fetch(`${this.graphUrl(key)}?$select=id`, { headers });
    return res.ok;
  }

  /**
   * 列举 prefix 下的所有文件 key。
   *
   * 使用 Graph API delta 接口（参考 Remotely Save 的 walk），
   * delta 返回 App Folder 下所有变更（包括子目录中的文件）。
   * 我们过滤出文件项，提取相对路径。
   */
  async list(prefix: string): Promise<string[]> {
    const headers = await this.getHeaders();
    const basePath = this.remoteBaseDir
      ? `/drive/special/approot:/${this.remoteBaseDir}`
      : '/drive/special/approot';

    // 使用 delta API 列举所有内容
    let deltaUrl = `${GRAPH_API}${encodeURI(`${basePath}:/delta`)}`.replace(/#/g, '%23');
    const results: string[] = [];
    const seen = new Set<string>();

    while (deltaUrl) {
      const res = await fetch(deltaUrl, { headers });
      if (res.status === 404) break; // App Folder 还不存在
      if (!res.ok) throw new Error(`onedrive list failed (${res.status})`);

      const data = await res.json() as {
        value: Array<{
          name: string;
          parentReference?: { path?: string };
          file?: object;
          folder?: object;
          deleted?: object;
        }>;
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };

      for (const item of data.value) {
        // 跳过已删除项
        if (item.deleted) continue;
        // 只收集文件，不收集文件夹
        if (!item.file) continue;

        const key = this.extractKey(item, basePath);
        if (key && !seen.has(key) && key.startsWith(prefix)) {
          seen.add(key);
          results.push(key);
        }
      }

      // 分页
      deltaUrl = data['@odata.nextLink'] || '';
      // deltaLink 表示列举完成（我们每次都从头列举，不存储 deltaLink）
      if (data['@odata.deltaLink'] && !data['@odata.nextLink']) break;
    }

    return results;
  }

  /**
   * 从 DriveItem 提取相对于 remoteBaseDir 的 key。
   * 简化版：使用 parentReference.path + name 构建完整路径，然后截取。
   */
  private extractKey(
    item: { name: string; parentReference?: { path?: string } },
    basePath: string,
  ): string | null {
    if (!item.parentReference?.path || !item.name) return null;

    // parentReference.path 格式可能多种多样：
    // /drive/root:/Apps/remotely-save/xxx
    // /drive/root:/应用/remotely-save/xxx
    // /drive/items/xxx!/xxx
    // 我们只关心 remoteBaseDir 之后的部分

    const fullPath = `${item.parentReference.path}/${item.name}`;
    const remoteBaseDir = this.remoteBaseDir;

    if (remoteBaseDir) {
      // 尝试匹配 .../remoteBaseDir/...
      const idx = fullPath.indexOf(`/${remoteBaseDir}/`);
      if (idx >= 0) {
        return fullPath.slice(idx + remoteBaseDir.length + 2);
      }
      // 也尝试 encoded 形式
      const encodedBase = encodeURIComponent(remoteBaseDir);
      const idx2 = fullPath.indexOf(`/${encodedBase}/`);
      if (idx2 >= 0) {
        return decodeURIComponent(fullPath.slice(idx2 + encodedBase.length + 2));
      }
    } else {
      // 没有子目录，取 approot 之后的部分
      // path 格式: /drive/root:/Apps/SynxSync → key = Apps/SynxSync/name
      const match = fullPath.match(/\/drive\/root:\/(.+)/);
      if (match) {
        return decodeURIComponent(match[1]);
      }
    }

    return null;
  }
}
