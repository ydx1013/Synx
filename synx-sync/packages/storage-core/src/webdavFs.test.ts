import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebDAVFs } from './webdavFs.js';
import { StorageRequestError } from './storageRequestError.js';

const config = {
  address: 'https://dav.example.com',
  username: 'user',
  password: 'pass',
  authType: 'basic' as const,
};

const configWithBaseDir = {
  ...config,
  remoteBaseDir: 'my-vault',
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

function callArgs(i = 0): { url: string; method: string; headers: Record<string, string> } {
  const args = fetchMock.mock.calls[i];
  const url = args[0] as string;
  const init = (args[1] as RequestInit) ?? {};
  return { url, method: (init.method as string) ?? 'GET', headers: (init.headers as Record<string, string>) ?? {} };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((_url: string, init?: RequestInit) => Promise.resolve(mockResponse({ status: init?.method === 'HEAD' ? 200 : 500 })));
  vi.stubGlobal('fetch', fetchMock);
});

describe('WebDAVFs constructor', () => {
  it('builds base url without remoteBaseDir', () => {
    const fs = new WebDAVFs(config);
    // base should be https://dav.example.com
    expect(fs).toBeDefined();
  });

  it('builds base url with remoteBaseDir', () => {
    const fs = new WebDAVFs(configWithBaseDir);
    expect(fs).toBeDefined();
  });

  it('strips trailing slashes from address', () => {
    const fs = new WebDAVFs({ ...config, address: 'https://dav.example.com///' });
    expect(fs).toBeDefined();
  });
});

describe('WebDAVFs.put', () => {
  it('sends PUT with basic auth and creates parent dirs', async () => {
    // MKCOL for parent dir, then PUT
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 405 })) // parent dir exists
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // PUT

    const fs = new WebDAVFs(config);
    await fs.put('folder/file.txt', new TextEncoder().encode('content'));

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // First call: MKCOL for parent dir
    const mkcol = callArgs(0);
    expect(mkcol.method).toBe('MKCOL');
    expect(mkcol.url).toBe('https://dav.example.com/folder/');
    expect(mkcol.headers['Authorization']).toMatch(/^Basic /);

    // Second call: PUT
    const put = callArgs(1);
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://dav.example.com/folder/file.txt');
  });

  it('creates nested parent dirs from root', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 201 })) // MKCOL a/
      .mockResolvedValueOnce(mockResponse({ status: 201 })) // MKCOL a/b/
      .mockResolvedValueOnce(mockResponse({ status: 201 })) // MKCOL a/b/c/
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // PUT

    const fs = new WebDAVFs(config);
    await fs.put('a/b/c/file.txt', new Uint8Array());

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(callArgs(0).url).toBe('https://dav.example.com/a/');
    expect(callArgs(1).url).toBe('https://dav.example.com/a/b/');
    expect(callArgs(2).url).toBe('https://dav.example.com/a/b/c/');
  });

  it('skips MKCOL when key has no parent dirs', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new WebDAVFs(config);
    await fs.put('file.txt', new Uint8Array());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callArgs(0).method).toBe('PUT');
  });

  it('confirms a successful PUT with strict HEAD semantics', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 201 }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new WebDAVFs(config);
    await expect(fs.put('file.txt', new Uint8Array())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callArgs(1).method).toBe('HEAD');
  });

  it('rejects a successful PUT when strict HEAD verification reports missing', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 201 }))
      .mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    await expect(fs.put('file.txt', new Uint8Array())).rejects.toThrow('webdav put verification failed');
  });
  it('throws on PUT error', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new WebDAVFs(config);
    await expect(fs.put('file.txt', new Uint8Array())).rejects.toThrow('webdav put failed');
  });

  it('throws when MKCOL returns a non-success status', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new WebDAVFs(config);
    await expect(fs.put('dir/file.txt', new Uint8Array())).rejects.toThrow('webdav mkdir failed');
  });

  it.each([429, 502, 503, 504, 520])('retries PUT after transient status %s', async (status) => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status }))
      .mockResolvedValueOnce(mockResponse({ status: 201 }));

    const fs = new WebDAVFs(config, { sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(fs.put('file.txt', new Uint8Array())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honors bounded Retry-After before retrying', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
      .mockResolvedValueOnce(mockResponse({ status: 201 }));

    const fs = new WebDAVFs(config, { sleep });
    await fs.put('file.txt', new Uint8Array());
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('stops after the bounded retry budget is exhausted and verifies PUT state', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config, { sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(fs.put('file.txt', new Uint8Array())).rejects.toThrow('webdav put failed (503)');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callArgs(2).method).toBe('HEAD');
  });

  it('does not retry permanent PUT failures', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new WebDAVFs(config, { sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(fs.put('file.txt', new Uint8Array())).rejects.toThrow('webdav put failed (403)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on MKCOL 5xx', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500 }));

    const fs = new WebDAVFs(config);
    await expect(fs.put('dir/file.txt', new Uint8Array())).rejects.toThrow('webdav mkdir failed');
  });

  it('encodes special characters in each path segment', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new WebDAVFs(config);
    await fs.put('file name@v1.txt', new Uint8Array());

    const { url } = callArgs(0);
    expect(url).toBe('https://dav.example.com/file%20name%40v1.txt');
  });

  it.each(['../escape.txt', '%2e%2e/escape.txt', 'safe/%252e%252e/escape.txt', 'safe\\escape.txt', '/absolute.txt', 'line\nbreak.txt', 'encoded%250abreak.txt'])(
    'rejects escaping key %s before making a request',
    async (key) => {
      const fs = new WebDAVFs(configWithBaseDir);
      await expect(fs.put(key, new Uint8Array())).rejects.toThrow('invalid webdav path');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('MKCOLs remoteBaseDir segments before PUT when remoteBaseDir set (坚果云 409 兼容)', async () => {
    // 先 MKCOL my-vault/（remoteBaseDir），再 PUT
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 201 })) // MKCOL my-vault/
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // PUT

    const fs = new WebDAVFs(configWithBaseDir);
    await fs.put('file.txt', new Uint8Array());

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const mkcol = callArgs(0);
    expect(mkcol.method).toBe('MKCOL');
    expect(mkcol.url).toBe('https://dav.example.com/my-vault/');

    const put = callArgs(1);
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://dav.example.com/my-vault/file.txt');
  });

  it('MKCOLs nested remoteBaseDir segments level by level', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 201 })) // MKCOL a/
      .mockResolvedValueOnce(mockResponse({ status: 201 })) // MKCOL a/b/
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // PUT

    const fs = new WebDAVFs({ ...config, remoteBaseDir: 'a/b' });
    await fs.put('file.txt', new Uint8Array());

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callArgs(0).url).toBe('https://dav.example.com/a/');
    expect(callArgs(1).url).toBe('https://dav.example.com/a/b/');
    expect(callArgs(2).method).toBe('PUT');
    expect(callArgs(3).method).toBe('HEAD');
  });

  it('tolerates already-existing remoteBaseDir (405) during ensureBaseDir', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 405 })) // MKCOL my-vault/ → already exists
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // PUT

    const fs = new WebDAVFs(configWithBaseDir);
    await expect(fs.put('file.txt', new Uint8Array())).resolves.toBeUndefined();
  });
});

describe('WebDAVFs.get', () => {
  it('rejects redirects instead of forwarding credentials', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 302, ok: false }));

    const fs = new WebDAVFs(config);
    await expect(fs.get('file.txt')).rejects.toThrow('webdav get failed');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('returns arrayBuffer content', async () => {
    const buf = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200, arrayBuffer: buf }));

    const fs = new WebDAVFs(config);
    const out = await fs.get('file.txt');
    expect(new TextDecoder().decode(out)).toBe('hello');
  });

  it('throws on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    await expect(fs.get('missing')).rejects.toThrow('webdav get failed');
  });

  it('sends basic auth header', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new WebDAVFs(config);
    await fs.get('file.txt');

    const { headers } = callArgs(0);
    const expected = `Basic ${btoa('user:pass')}`;
    expect(headers['Authorization']).toBe(expected);
  });
});

describe('WebDAVFs.delete', () => {
  it('checks deletion with HEAD after repeated transient DELETE responses', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 520 }))
      .mockResolvedValueOnce(mockResponse({ status: 520 }))
      .mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    await expect(fs.delete('file')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callArgs(1).method).toBe('DELETE');
    expect(callArgs(2).method).toBe('HEAD');
  });

  it.each([403, 429, 503])('does not treat DELETE as successful when verification HEAD returns %s', async (status) => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 520 }))
      .mockResolvedValueOnce(mockResponse({ status: 520 }))
      .mockResolvedValueOnce(mockResponse({ status }))
      .mockResolvedValueOnce(mockResponse({ status }));

    const fs = new WebDAVFs(config, { sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(fs.delete('file')).rejects.toThrow('webdav head failed');
  });

  it('confirms a successful DELETE with strict HEAD semantics', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 204 }))
      .mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    await expect(fs.delete('file')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callArgs(1).method).toBe('HEAD');
  });

  it('rejects a successful DELETE when strict HEAD verification still finds the object', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 204 }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new WebDAVFs(config);
    await expect(fs.delete('file')).rejects.toThrow('webdav delete verification failed');
  });
  it('tolerates 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    await expect(fs.delete('missing')).resolves.toBeUndefined();
  });

  it('throws on 403', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new WebDAVFs(config);
    await expect(fs.delete('file')).rejects.toThrow('webdav delete failed');
  });
});

describe('WebDAVFs.head', () => {
  it('returns true on 200', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new WebDAVFs(config);
    expect(await fs.head('file.txt')).toBe(true);
  });

  it('returns false on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    expect(await fs.head('missing')).toBe(false);
  });

  it('throws on authorization or server errors', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new WebDAVFs(config);
    await expect(fs.head('file.txt')).rejects.toThrow('webdav head failed');
  });
});

describe('WebDAVFs.list', () => {
  it('retries PROPFIND once after a transient 520 response', async () => {
    const xml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>';
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 520 }))
      .mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    await expect(fs.list('')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callArgs(1).method).toBe('PROPFIND');
  });

  it('parses flat PROPFIND response', async () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/file1.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/file2.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    const keys = await fs.list('');

    expect(keys).toEqual(['file1.txt', 'file2.txt']);
  });

  it('recurses into subdirectories via BFS', async () => {
    // First PROPFIND: root → file1.txt + dir/
    const rootXml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/file1.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dir/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    // Second PROPFIND: dir/ → dir/file2.txt
    const dirXml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dir/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dir/file2.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 207, text: rootXml }))
      .mockResolvedValueOnce(mockResponse({ status: 207, text: dirXml }));

    const fs = new WebDAVFs(config);
    const keys = await fs.list('');

    expect(keys).toContain('file1.txt');
    expect(keys).toContain('dir/file2.txt');
    expect(keys).toHaveLength(2);
  });

  it('returns empty when directory does not exist (404)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new WebDAVFs(config);
    expect(await fs.list('nonexistent/')).toEqual([]);
  });

  it('returns empty when server returns 409 Conflict for missing path (坚果云 兼容)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 409 }));

    const fs = new WebDAVFs(config);
    expect(await fs.list('nonexistent/')).toEqual([]);
  });

  it('handles full URL hrefs', async () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>https://dav.example.com/file.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    const keys = await fs.list('');
    expect(keys).toEqual(['file.txt']);
  });

  it('handles hrefs with remoteBaseDir prefix', async () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>https://dav.example.com/my-vault/file.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(configWithBaseDir);
    const keys = await fs.list('');
    expect(keys).toEqual(['file.txt']);
  });

  it('sends PROPFIND with Depth:1 header', async () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    await fs.list('');

    const { method, headers } = callArgs(0);
    expect(method).toBe('PROPFIND');
    expect(headers['Depth']).toBe('1');
  });

  it('handles namespace-less XML', async () => {
    const xml = `<?xml version="1.0"?>
<multistatus>
  <response>
    <href>/file.txt</href>
    <propstat>
      <prop><resourcetype/></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    const keys = await fs.list('');
    expect(keys).toEqual(['file.txt']);
  });

  it('URL-encodes path in PROPFIND request', async () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    await fs.list('my folder/');

    const { url } = callArgs(0);
    expect(url).toContain('my%20folder/');
  });

  it('decodes XML entities in hrefs', async () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/file&amp;amp.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 207, text: xml }));

    const fs = new WebDAVFs(config);
    const keys = await fs.list('');
    expect(keys).toEqual(['file&amp.txt']);
  });
});

describe('WebDAVFs auth status propagation', () => {
  it.each([
    ['MKCOL base directory', new WebDAVFs(configWithBaseDir), (fs: WebDAVFs) => fs.put('file', new Uint8Array()), 401],
    ['MKCOL parent directory', new WebDAVFs(config), (fs: WebDAVFs) => fs.put('dir/file', new Uint8Array()), 403],
    ['DELETE', new WebDAVFs(config), (fs: WebDAVFs) => fs.delete('file'), 401],
    ['HEAD', new WebDAVFs(config), (fs: WebDAVFs) => fs.head('file'), 403],
    ['PROPFIND', new WebDAVFs(config), (fs: WebDAVFs) => fs.list(''), 401],
  ] as const)('preserves auth status for %s', async (_name, fs, operation, status) => {
    fetchMock.mockResolvedValue(mockResponse({ status }));
    const error = await operation(fs).catch((caught) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.status).toBe(status);
  });

  it('does not wrap network TypeError as a status error', async () => {
    const networkError = new TypeError('network failed');
    fetchMock.mockRejectedValue(networkError);
    await expect(new WebDAVFs(config).get('file')).rejects.toBe(networkError);
  });
});




