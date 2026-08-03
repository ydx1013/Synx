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

function mockResponse(opts: { ok?: boolean; status?: number; text?: string; arrayBuffer?: ArrayBuffer; headers?: Record<string, string> }) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? status < 400,
    status,
    headers: new Headers(opts.headers),
    text: async () => opts.text ?? '',
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
  } as unknown as Response;
}

/** aws4fetch 把请求包装成 Request 对象再传给 fetch。这里统一取出 url/method。 */
function callArgs(i = 0): { url: string; method: string; body?: BodyInit | null } {
  const arg = fetchMock.mock.calls[i][0] as Request | string;
  if (typeof arg === 'string') {
    const init = fetchMock.mock.calls[i][1] as RequestInit;
    return { url: arg, method: init?.method ?? 'GET', body: init?.body };
  }
  return { url: arg.url, method: arg.method, body: arg.body };
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
    const xml = '<?xml version="1.0"?><ListBucketResult><Contents><Key>a@v1</Key></Contents><Contents><Key>a@v2</Key></Contents></ListBucketResult>';
    fetchMock.mockResolvedValue(mockResponse({ status: 200, text: xml }));
    const fs = new S3Fs(config);
    expect(await fs.list('a')).toEqual(['a@v1', 'a@v2']);
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

describe('S3Fs multipart', () => {
  it('creates a multipart upload and returns UploadId', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, text: '<InitiateMultipartUploadResult><UploadId>up&amp;1</UploadId></InitiateMultipartUploadResult>' }));
    const fs = new S3Fs(config);
    await expect(fs.createMultipartUpload('folder/file.bin')).resolves.toBe('up&1');
    expect(callArgs().method).toBe('POST');
    expect(callArgs().url).toBe('https://s3.example.com/b/folder/file.bin?uploads=');
  });

  it('lists uploaded parts across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>10</Size></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag><Size>20</Size></Part></ListPartsResult>' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>3</PartNumber><ETag>&quot;e3&quot;</ETag><Size>5</Size></Part></ListPartsResult>' }));
    const fs = new S3Fs(config);
    await expect(fs.listMultipartParts('k', 'u&1')).resolves.toEqual([
      { partNumber: 1, etag: '"e1"', size: 10 },
      { partNumber: 2, etag: '"e2"', size: 20 },
      { partNumber: 3, etag: '"e3"', size: 5 },
    ]);
    expect(callArgs(1).url).toContain('part-number-marker=2');
    expect(callArgs(1).url).toContain('uploadId=u%261');
  });

  it('presigns one UploadPart PUT for 900 seconds', async () => {
    const fs = new S3Fs(config);
    const url = await fs.presignUploadPart('k', 'u', 3, 900);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('partNumber')).toBe('3');
    expect(parsed.searchParams.get('uploadId')).toBe('u');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.has('X-Amz-Signature')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('completes parts in ascending order and rejects embedded S3 errors', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200, text: '<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>' }));
    const fs = new S3Fs(config);
    await fs.completeMultipartUpload('k', 'u', [
      { partNumber: 2, etag: '"e2"', size: 5 },
      { partNumber: 1, etag: '"e1"', size: 10 },
    ]);
    const request = fetchMock.mock.calls[0][0] as Request;
    const body = await request.text();
    expect(body.indexOf('<PartNumber>1</PartNumber>')).toBeLessThan(body.indexOf('<PartNumber>2</PartNumber>'));

    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200, text: '<Error><Code>InvalidPart</Code></Error>' }));
    await expect(fs.completeMultipartUpload('k', 'u', [{ partNumber: 1, etag: '"e1"', size: 10 }])).rejects.toThrow('InvalidPart');
  });

  it('aborts idempotently when upload is missing', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 404 }));
    const fs = new S3Fs(config);
    await expect(fs.abortMultipartUpload('k', 'u')).resolves.toBeUndefined();
    expect(callArgs().method).toBe('DELETE');
  });
});
