import { describe, it, expect, beforeEach, vi } from 'vitest';
import { S3Fs } from './s3Fs.js';

const config = {
  endpoint: 'https://s3.example.com',
  bucket: 'b',
  accessKey: 'ak',
  secretKey: 'sk',
  region: 'us-east-1',
  pathStyle: true,
};

function mockResponse(opts: { ok?: boolean; status?: number; text?: string; arrayBuffer?: ArrayBuffer }) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? status < 400,
    status,
    text: async () => opts.text ?? '',
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
  } as unknown as Response;
}

/** aws4fetch 把请求包装成 Request 对象再传给 fetch。这里统一取出 url/method。 */
function callArgs(i = 0): { url: string; method: string } {
  const arg = fetchMock.mock.calls[i][0] as Request | string;
  if (typeof arg === 'string') {
    return { url: arg, method: (fetchMock.mock.calls[i][1] as RequestInit)?.method ?? 'GET' };
  }
  return { url: arg.url, method: arg.method };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('S3Fs', () => {
  it('put sends PUT request to path-style url', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200 }));
    const fs = new S3Fs(config);
    await fs.put('key1', new TextEncoder().encode('content'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, method } = callArgs(0);
    expect(url).toBe('https://s3.example.com/b/key1');
    expect(method).toBe('PUT');
  });

  it('put throws on error status', async () => {
    // 403 不会触发 aws4fetch 的 5xx 重试，便于测试
    fetchMock.mockResolvedValue(mockResponse({ status: 403, text: 'err' }));
    const fs = new S3Fs(config);
    await expect(fs.put('k', new Uint8Array())).rejects.toThrow('s3 put failed');
  });

  it('get returns arrayBuffer content', async () => {
    const buf = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    fetchMock.mockResolvedValue(mockResponse({ status: 200, arrayBuffer: buf }));
    const fs = new S3Fs(config);
    const out = await fs.get('k');
    expect(new TextDecoder().decode(out)).toBe('hello');
  });

  it('get throws on 404', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 404 }));
    const fs = new S3Fs(config);
    await expect(fs.get('missing')).rejects.toThrow('s3 get failed');
  });

  it('delete tolerates 404', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 404 }));
    const fs = new S3Fs(config);
    await expect(fs.delete('k')).resolves.toBeUndefined();
  });

  it('delete throws on 403', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 403 }));
    const fs = new S3Fs(config);
    await expect(fs.delete('k')).rejects.toThrow('s3 delete failed');
  });

  it('head returns true on 200 and false on 404', async () => {
    const fs = new S3Fs(config);
    fetchMock.mockResolvedValue(mockResponse({ status: 200 }));
    expect(await fs.head('k')).toBe(true);
    fetchMock.mockResolvedValue(mockResponse({ status: 404 }));
    expect(await fs.head('k')).toBe(false);
  });

  it('list parses keys from ListObjectsV2 XML', async () => {
    const xml =
      '<?xml version="1.0"?><ListBucketResult><Contents><Key>a@v1</Key></Contents><Contents><Key>a@v2</Key></Contents></ListBucketResult>';
    fetchMock.mockResolvedValue(mockResponse({ status: 200, text: xml }));
    const fs = new S3Fs(config);
    const keys = await fs.list('a');
    expect(keys).toEqual(['a@v1', 'a@v2']);
  });

  it('list follows continuation tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;token</NextContinuationToken><Contents><Key>a</Key></Contents></ListBucketResult>' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>b</Key></Contents></ListBucketResult>' }));
    const fs = new S3Fs(config);
    expect(await fs.list('x')).toEqual(['a', 'b']);
    expect(callArgs(1).url).toContain('continuation-token=next%26token');
  });

  it('list returns empty when no Contents', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, text: '<ListBucketResult></ListBucketResult>' }));
    const fs = new S3Fs(config);
    expect(await fs.list('none')).toEqual([]);
  });

  it('uses virtual-host style url when pathStyle false', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200 }));
    const fs = new S3Fs({ ...config, pathStyle: false });
    await fs.get('key');
    expect(callArgs(0).url).toBe('https://b.s3.example.com/key');
  });

  it('decodes XML entities in keys', async () => {
    const xml = '<ListBucketResult><Contents><Key>a&amp;b</Key></Contents></ListBucketResult>';
    fetchMock.mockResolvedValue(mockResponse({ status: 200, text: xml }));
    const fs = new S3Fs(config);
    expect(await fs.list('a')).toEqual(['a&b']);
  });
});
