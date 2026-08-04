import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubGalleryError, checkGitHubGallery, uploadGitHubImage } from './githubGallery.js';

const config = {
  token: 'github-secret',
  owner: 'alice',
  repo: 'images',
  branch: 'main',
  folder: 'uploads',
};

afterEach(() => vi.unstubAllGlobals());

describe('checkGitHubGallery', () => {
  it('returns repository visibility when token can push to the branch', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'main' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkGitHubGallery(config)).resolves.toEqual({ isPrivate: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.github.com/repos/alice/images', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer github-secret' }),
    }));
  });

  it('maps rate limits without exposing the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('github-secret upstream', { status: 429 })));

    await expect(checkGitHubGallery(config)).rejects.toMatchObject({
      name: 'GitHubGalleryError',
      code: 'GITHUB_RATE_LIMITED',
      status: 429,
    });
    await checkGitHubGallery(config).catch((error: GitHubGalleryError) => {
      expect(error.message).not.toContain(config.token);
    });
  });
});

describe('uploadGitHubImage', () => {
  it('uploads base64 content to the encoded repository path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: { sha: 'abc' } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadGitHubImage(config, 'uploads/2026/08/a b.png', new Uint8Array([1, 2, 3]))).resolves.toEqual({ sha: 'abc' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/alice/images/contents/uploads/2026/08/a%20b.png');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({ branch: 'main', content: 'AQID' });
  });

  it('preserves image bytes when the Worker base64 path uses multiple chunks', async () => {
    const content = new Uint8Array(422429);
    for (let index = 0; index < content.length; index++) content[index] = index % 251;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: { sha: 'abc' } }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const nodeBuffer = (globalThis as typeof globalThis & {
      Buffer: { from(value: string | Uint8Array, encoding?: string): Uint8Array };
    }).Buffer;
    vi.stubGlobal('Buffer', undefined);
    await uploadGitHubImage(config, 'uploads/2026/08/image.png', content);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const encoded = (JSON.parse(String(init.body)) as { content: string }).content;
    expect(new Uint8Array(nodeBuffer.from(encoded, 'base64'))).toEqual(content);
  });
});
