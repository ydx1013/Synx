import { describe, it, expect, beforeEach, vi } from 'vitest';
import { S3Fs } from './s3Fs.js';
import { StorageRequestError } from './storageRequestError.js';

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

  it.each([
    ['put', (fs: S3Fs) => fs.put('k', new Uint8Array()), 401],
    ['putIfMatch', (fs: S3Fs) => fs.putIfMatch('k', new Uint8Array(), 'etag'), 403],
    ['putIfNoneMatch', (fs: S3Fs) => fs.putIfNoneMatch('k', new Uint8Array()), 401],
    ['putIfNoneMatch', (fs: S3Fs) => fs.putIfNoneMatch('k', new Uint8Array()), 403],
    ['getEtag', (fs: S3Fs) => fs.getEtag('k'), 401],
    ['get', (fs: S3Fs) => fs.get('k'), 403],
    ['delete', (fs: S3Fs) => fs.delete('k'), 401],
    ['deleteMany', (fs: S3Fs) => fs.deleteMany(['k']), 403],
  ] as const)('preserves auth status for %s', async (_name, operation, status) => {
    fetchMock.mockResolvedValue(mockResponse({ status }));
    const error = await operation(new S3Fs(config)).catch((caught) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.status).toBe(status);
  });

  it.each([
    ['put', (fs: S3Fs) => fs.put('k', new Uint8Array())],
    ['putIfMatch', (fs: S3Fs) => fs.putIfMatch('k', new Uint8Array(), 'etag')],
    ['putIfNoneMatch', (fs: S3Fs) => fs.putIfNoneMatch('k', new Uint8Array())],
    ['getEtag', (fs: S3Fs) => fs.getEtag('k')],
    ['get', (fs: S3Fs) => fs.get('k')],
    ['delete', (fs: S3Fs) => fs.delete('k')],
    ['head', (fs: S3Fs) => fs.head('k')],
    ['list', (fs: S3Fs) => fs.list('k')],
    ['deleteMany', (fs: S3Fs) => fs.deleteMany(['k'])],
  ] as const)('retries a network failure for %s', async (_name, operation) => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListBucketResult></ListBucketResult>' }));

    await operation(new S3Fs(config, async () => {}));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 response and succeeds', async () => {
    const buf = new TextEncoder().encode('ok').buffer as ArrayBuffer;
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 200, arrayBuffer: buf }));

    const out = await new S3Fs(config, async () => {}).get('k');
    expect(new TextDecoder().decode(out)).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 401 response', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 401 }));

    const error = await new S3Fs(config, async () => {}).get('k').catch((caught) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 412 conditional write and returns false', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 412 }));

    await expect(new S3Fs(config, async () => {}).putIfMatch('k', new Uint8Array(), 'etag')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the original network error after three attempts', async () => {
    const networkError = new TypeError('network failed');
    fetchMock.mockRejectedValue(networkError);

    await expect(new S3Fs(config, async () => {}).get('k')).rejects.toBe(networkError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves the final retryable HTTP status after three attempts', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 503 }));

    const error = await new S3Fs(config, async () => {}).get('k').catch((caught) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries only the current list page without duplicating completed pages', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents><Key>a</Key></Contents></ListBucketResult>' }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockResponse({ status: 200, text: '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>b</Key></Contents></ListBucketResult>' }));

    await expect(new S3Fs(config, async () => {}).list('x')).resolves.toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callArgs(1).url).toBe(callArgs(2).url);
    expect(callArgs(1).url).toContain('continuation-token=next');
  });
});

describe('S3Fs presignPut', () => {
  it('presigns a single PUT for the whole object for 900 seconds without sending a request', async () => {
    const fs = new S3Fs(config);
    const url = await fs.presignPut('folder/file.bin', 900);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://s3.example.com/b/folder/file.bin');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.has('X-Amz-Signature')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
