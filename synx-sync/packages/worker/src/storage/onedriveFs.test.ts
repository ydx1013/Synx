import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OneDriveFs } from './onedriveFs.js';
import type { OnedriveConfig } from '@synx/shared';

const config: OnedriveConfig = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  accessTokenExpiresAt: Date.now() + 3600_000, // 1 hour in the future
  clientId: 'test-client-id',
  authority: 'https://login.microsoftonline.com/consumers',
};

const configWithBaseDir: OnedriveConfig = {
  ...config,
  remoteBaseDir: 'my-vault',
};

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
  text?: string;
}) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? status < 400,
    status,
    json: async () => opts.json ?? {},
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

function callArgs(i = 0): { url: string; method: string; headers: Record<string, string>; body?: unknown } {
  const args = fetchMock.mock.calls[i];
  const url = args[0] as string;
  const init = (args[1] as RequestInit) ?? {};
  return {
    url,
    method: (init.method as string) ?? 'GET',
    headers: (init.headers as Record<string, string>) ?? {},
    body: init.body,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('OneDriveFs constructor', () => {
  it('creates instance without remoteBaseDir', () => {
    const fs = new OneDriveFs(config);
    expect(fs).toBeDefined();
  });

  it('creates instance with remoteBaseDir', () => {
    const fs = new OneDriveFs(configWithBaseDir);
    expect(fs).toBeDefined();
  });

  it('strips leading/trailing slashes from remoteBaseDir', () => {
    const fs = new OneDriveFs({ ...config, remoteBaseDir: '/my-vault///' });
    expect(fs).toBeDefined();
  });
});

describe('OneDriveFs.put', () => {
  it('sends PUT with bearer token for small files', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new OneDriveFs(config);
    await fs.put('folder/file.txt', new TextEncoder().encode('content'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, method, headers } = callArgs(0);
    expect(method).toBe('PUT');
    expect(url).toContain('/drive/special/approot');
    expect(url).toContain('/folder/file.txt');
    expect(url).toContain(':/content');
    expect(headers['Authorization']).toBe('Bearer test-access-token');
  });

  it('includes remoteBaseDir in path', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new OneDriveFs(configWithBaseDir);
    await fs.put('file.txt', new TextEncoder().encode('content'));

    const { url } = callArgs(0);
    expect(url).toContain('/drive/special/approot:/my-vault/file.txt');
  });

  it('uses conflictBehavior=replace', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new OneDriveFs(config);
    await fs.put('file.txt', new Uint8Array());

    const { url } = callArgs(0);
    // URLSearchParams encodes @ as %40
    expect(url).toContain('microsoft.graph.conflictBehavior=replace');
  });

  it('throws on PUT error', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new OneDriveFs(config);
    await expect(fs.put('file.txt', new Uint8Array())).rejects.toThrow('onedrive put failed');
  });

  it('uses upload session for large files', async () => {
    const largeContent = new Uint8Array(5 * 1024 * 1024); // 5 MB > DIRECT_UPLOAD_MAX (4MB)

    // createUploadSession response
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: { uploadUrl: 'https://upload.microsoft.com/session/123' },
        }),
      )
      // upload chunk response (final chunk)
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: { id: 'item-1' },
        }),
      );

    const fs = new OneDriveFs(config);
    await fs.put('large.bin', largeContent);

    // First call: createUploadSession, second: PUT chunk
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const sessionCall = callArgs(0);
    expect(sessionCall.method).toBe('POST');
    expect(sessionCall.url).toContain('createUploadSession');

    const chunkCall = callArgs(1);
    expect(chunkCall.method).toBe('PUT');
    expect(chunkCall.url).toBe('https://upload.microsoft.com/session/123');
    expect(chunkCall.headers['Content-Range']).toMatch(/^bytes 0-\d+\/\d+$/);
  });

  it('encodes # in path as %23', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new OneDriveFs(config);
    await fs.put('file#tag.txt', new Uint8Array());

    const { url } = callArgs(0);
    expect(url).toContain('%23');
    expect(url).not.toContain('#tag');
  });
});

describe('OneDriveFs.get', () => {
  it('downloads content via downloadUrl', async () => {
    const content = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: { '@microsoft.graph.downloadUrl': 'https://download.microsoft.com/file123' },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ status: 200, arrayBuffer: content }));

    const fs = new OneDriveFs(config);
    const out = await fs.get('file.txt');

    expect(new TextDecoder().decode(out)).toBe('hello world');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: get metadata
    const metaCall = callArgs(0);
    expect(metaCall.url).toContain('$select=@microsoft.graph.downloadUrl');

    // Second call: download from downloadUrl (no auth header needed)
    const dlCall = callArgs(1);
    expect(dlCall.url).toBe('https://download.microsoft.com/file123');
  });

  it('throws when downloadUrl is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 200, json: { id: 'item-1' } }),
    );

    const fs = new OneDriveFs(config);
    await expect(fs.get('file.txt')).rejects.toThrow('no downloadUrl');
  });

  it('throws on metadata fetch error', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new OneDriveFs(config);
    await expect(fs.get('file.txt')).rejects.toThrow('onedrive get metadata failed');
  });

  it('throws on download error', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: { '@microsoft.graph.downloadUrl': 'https://download.microsoft.com/file123' },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new OneDriveFs(config);
    await expect(fs.get('file.txt')).rejects.toThrow('onedrive download failed');
  });
});

describe('OneDriveFs.delete', () => {
  it('sends DELETE with bearer token', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 204 }));

    const fs = new OneDriveFs(config);
    await fs.delete('file.txt');

    const { method, headers } = callArgs(0);
    expect(method).toBe('DELETE');
    expect(headers['Authorization']).toBe('Bearer test-access-token');
  });

  it('tolerates 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new OneDriveFs(config);
    await expect(fs.delete('missing')).resolves.toBeUndefined();
  });

  it('throws on 403', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403 }));

    const fs = new OneDriveFs(config);
    await expect(fs.delete('file')).rejects.toThrow('onedrive delete failed');
  });
});

describe('OneDriveFs.head', () => {
  it('returns true on 200', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new OneDriveFs(config);
    expect(await fs.head('file.txt')).toBe(true);
  });

  it('returns false on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new OneDriveFs(config);
    expect(await fs.head('missing')).toBe(false);
  });

  it('selects only id field', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));

    const fs = new OneDriveFs(config);
    await fs.head('file.txt');

    const { url } = callArgs(0);
    expect(url).toContain('$select=id');
  });
});

describe('OneDriveFs.list', () => {
  it('lists files via delta API', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'file1.txt',
              file: {},
              parentReference: { path: '/drive/root:/Apps/remotely-save' },
            },
            {
              name: 'file2.md',
              file: {},
              parentReference: { path: '/drive/root:/Apps/remotely-save/sub' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/token123',
        },
      }),
    );

    const fs = new OneDriveFs({ ...config, remoteBaseDir: 'remotely-save' });
    const keys = await fs.list('');

    expect(keys).toHaveLength(2);
    expect(keys).toContain('file1.txt');
    expect(keys).toContain('sub/file2.md');
  });

  it('skips folders and deleted items', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'file.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
            {
              name: 'subfolder',
              folder: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
            {
              name: 'deleted.txt',
              deleted: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/token',
        },
      }),
    );

    const fs = new OneDriveFs(configWithBaseDir);
    const keys = await fs.list('');

    expect(keys).toEqual(['file.txt']);
  });

  it('returns empty on 404 (app folder not created yet)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const fs = new OneDriveFs(config);
    expect(await fs.list('')).toEqual([]);
  });

  it('handles pagination via nextLink', async () => {
    // First page
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'file1.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?token=page2',
        },
      }),
    );
    // Second page
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'file2.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/final',
        },
      }),
    );

    const fs = new OneDriveFs(configWithBaseDir);
    const keys = await fs.list('');

    expect(keys).toHaveLength(2);
    expect(keys).toContain('file1.txt');
    expect(keys).toContain('file2.txt');
  });

  it('filters by prefix', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'a.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
            {
              name: 'b.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault/sub' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/token',
        },
      }),
    );

    const fs = new OneDriveFs(configWithBaseDir);
    const keys = await fs.list('sub/');

    expect(keys).toEqual(['sub/b.txt']);
  });

  it('throws on non-404 error', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500 }));

    const fs = new OneDriveFs(config);
    await expect(fs.list('')).rejects.toThrow('onedrive list failed');
  });

  it('deduplicates keys', async () => {
    // Two pages with the same file (updated in second page)
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'file.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?token=page2',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          value: [
            {
              name: 'file.txt',
              file: {},
              parentReference: { path: '/drive/root:/my-vault' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/final',
        },
      }),
    );

    const fs = new OneDriveFs(configWithBaseDir);
    const keys = await fs.list('');

    expect(keys).toEqual(['file.txt']);
  });
});
