import { arrayBufferToBase64, type GitHubGalleryConfig } from '@synx/shared';

export type GitHubGalleryErrorCode =
  | 'GITHUB_UNAUTHORIZED'
  | 'GITHUB_FORBIDDEN'
  | 'GITHUB_NOT_FOUND'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_UPSTREAM_FAILED';

export class GitHubGalleryError extends Error {
  constructor(public readonly code: GitHubGalleryErrorCode, public readonly status: number) {
    super(githubErrorMessage(code));
    this.name = 'GitHubGalleryError';
  }
}

const API_ROOT = 'https://api.github.com';

function githubErrorMessage(code: GitHubGalleryErrorCode): string {
  const messages: Record<GitHubGalleryErrorCode, string> = {
    GITHUB_UNAUTHORIZED: 'GitHub Token 无效',
    GITHUB_FORBIDDEN: 'GitHub 仓库权限不足',
    GITHUB_NOT_FOUND: 'GitHub 仓库、分支或图片不存在',
    GITHUB_RATE_LIMITED: 'GitHub API 请求频率受限',
    GITHUB_UPSTREAM_FAILED: 'GitHub 服务暂时不可用',
  };
  return messages[code];
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Synx-Image-Gallery',
  };
}

function repoBase(config: GitHubGalleryConfig): string {
  return `${API_ROOT}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function githubFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { ...headers(token), ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    throw new GitHubGalleryError('GITHUB_UPSTREAM_FAILED', 502);
  }
  if (response.ok) return response;
  if (response.status === 401) throw new GitHubGalleryError('GITHUB_UNAUTHORIZED', 401);
  if (response.status === 403) throw new GitHubGalleryError('GITHUB_FORBIDDEN', 403);
  if (response.status === 404) throw new GitHubGalleryError('GITHUB_NOT_FOUND', 404);
  if (response.status === 429) throw new GitHubGalleryError('GITHUB_RATE_LIMITED', 429);
  throw new GitHubGalleryError('GITHUB_UPSTREAM_FAILED', 502);
}

export async function checkGitHubGallery(config: GitHubGalleryConfig): Promise<{ isPrivate: boolean }> {
  const repoResponse = await githubFetch(repoBase(config), config.token);
  const repo = await repoResponse.json() as { private?: boolean; permissions?: { push?: boolean } };
  if (!repo.permissions?.push) throw new GitHubGalleryError('GITHUB_FORBIDDEN', 403);
  await githubFetch(`${repoBase(config)}/branches/${encodeURIComponent(config.branch)}`, config.token);
  return { isPrivate: repo.private === true };
}

export async function uploadGitHubImage(config: GitHubGalleryConfig, path: string, content: Uint8Array): Promise<{ sha: string }> {
  const response = await githubFetch(`${repoBase(config)}/contents/${encodePath(path)}`, config.token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Add image ${path.split('/').pop() ?? 'image'}`,
      content: arrayBufferToBase64(content),
      branch: config.branch,
    }),
  });
  const result = await response.json() as { content?: { sha?: string } };
  if (!result.content?.sha) throw new GitHubGalleryError('GITHUB_UPSTREAM_FAILED', 502);
  return { sha: result.content.sha };
}

export async function readGitHubImage(config: GitHubGalleryConfig, path: string): Promise<Response> {
  return githubFetch(`${repoBase(config)}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`, config.token, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
}
