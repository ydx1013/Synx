import { AwsClient } from 'aws4fetch';
import type { S3Config, WorkerFs } from '@synx/shared';
import { checkConnectivity } from './connectivity.js';

/** 向后兼容：保留原导出名，内部委托给通用 checkConnectivity */
export const checkS3Connectivity = checkConnectivity;

/**
 * S3 兼容存储适配器（支持 S3 / R2 / MinIO）。
 * 用 aws4fetch 做 AWS SigV4 签名。
 */
export class S3Fs implements WorkerFs {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
      region: config.region,
      service: 's3',
    });
    const endpoint = config.endpoint.replace(/\/+$/, '');
    // pathStyle: https://endpoint/bucket ; virtual-host: https://bucket.endpoint
    this.base = config.pathStyle
      ? `${endpoint}/${config.bucket}`
      : endpoint.replace(/^(\w+:\/\/)/, `$1${config.bucket}.`);
  }

  private url(key: string): string {
    return `${this.base}/${key}`;
  }

  async put(key: string, content: ArrayBuffer | Uint8Array): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'PUT', body: content as BufferSource });
    if (!res.ok) throw new Error(`s3 put failed (${res.status})`);
  }

  async get(key: string): Promise<ArrayBuffer> {
    const res = await this.client.fetch(this.url(key), { method: 'GET' });
    if (!res.ok) throw new Error(`s3 get failed (${res.status})`);
    return res.arrayBuffer();
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`s3 delete failed (${res.status})`);
  }

  async head(key: string): Promise<boolean> {
    const res = await this.client.fetch(this.url(key), { method: 'HEAD' });
    return res.ok;
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const token = continuationToken ? `&continuation-token=${encodeURIComponent(continuationToken)}` : '';
      const url = `${this.base}?list-type=2&prefix=${encodeS3Prefix(prefix)}${token}`;
      const res = await this.client.fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`s3 list failed (${res.status})`);
      const xml = await res.text();
      keys.push(...parseListKeys(xml));
      continuationToken = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? parseXmlValue(xml, 'NextContinuationToken')
        : undefined;
    } while (continuationToken);
    return keys;
  }

  async deleteMany(keys: string[]): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    // S3 DeleteObjects 每次最多 1000 个
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Delete>\n${batch.map((k) => `  <Object><Key>${escapeXml(k)}</Key></Object>`).join('\n')}\n  <Quiet>false</Quiet>\n</Delete>`;
      const res = await this.client.fetch(`${this.base}?delete=`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body,
      });
      if (!res.ok) {
        failed += batch.length;
        continue;
      }
      const xml = await res.text();
      const errorKeys = parseListValues(xml, 'Error');
      const deletedKeys = parseListValues(xml, 'Deleted');
      deleted += deletedKeys.length;
      failed += errorKeys.length;
    }
    return { deleted, failed };
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * S3 ListObjectsV2 的 prefix 查询参数编码。
 *
 * 对象操作（put/get/head）把 key 原样放进 URL path，aws4fetch 对其中已有的合法
 * `%XX` 序列不再二次编码；S3 服务端对 path 解码一次后得到原始 key。
 * list 若直接对 prefix 做 encodeURIComponent，会把 prefix 里已有的 `%XX` 二次编码
 * 成 `%25XX`，S3 服务端解码一次后仍是 `%XX`（未还原），与对象 key（已还原）不匹配，
 * 导致元数据 List 不到、getVersion 抛 "no current"。这里把 `%25XX` 还原为 `%XX`，
 * 使 prefix 与对象 key 采用同一种编码，服务端解码后两侧一致。
 */
function encodeS3Prefix(prefix: string): string {
  return encodeURIComponent(prefix).replace(/%25[0-9A-Fa-f]{2}/g, (m) => `%${m.slice(3)}`);
}

function parseListValues(xml: string, tag: string): string[] {
  const values: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = parseXmlValue(m[1], 'Key');
    if (key) values.push(key);
  }
  return values;
}

/** 从 ListObjectsV2 XML 提取 <Key> 值（正则解析，避免引入 XML 库） */
function parseListKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([^<]*)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) keys.push(decodeXml(m[1]));
  return keys;
}

function parseXmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
