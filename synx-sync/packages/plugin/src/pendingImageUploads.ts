import { parsePrivateImageUrl } from './privateImage.js';

export interface PendingImageUpload {
  id: string;
  localPath: string;
  notePath: string;
  originalEmbed: string;
  galleryId: string;
  mimeType: string;
  createdAt: number;
  startupAttempts: number;
  lastError?: string;
}

export function pendingUploadKey(localPath: string, notePath: string): string {
  return `${localPath}\n${notePath}`;
}

export function replaceExactEmbed(content: string, originalEmbed: string, replacement: string): string | null {
  if (!content.includes(originalEmbed)) return null;
  return content.replace(originalEmbed, replacement);
}

/**
 * 从 Markdown 内容中收集引用的图库图片路径（用于孤儿图片扫描）。
 * 支持三种 URL 格式：
 * - synx-image://{galleryId}/{path}（旧版私有）
 * - {origin}/api/image-galleries/{galleryId}/images/content?path={path}&key=...（新版私有）
 * - https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}（公开）
 */
export function collectReferencedImagePaths(content: string, galleryId: string): string[] {
  const paths: string[] = [];
  const imagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(imagePattern)) {
    const url = match[1];
    // 旧版私有：synx-image://{galleryId}/{path}
    if (url.startsWith('synx-image://')) {
      const reference = parsePrivateImageUrl(url);
      if (reference && reference.galleryId === galleryId) paths.push(reference.path);
      continue;
    }
    try {
      const u = new URL(url);
      // 新版私有：{origin}/api/image-galleries/{galleryId}/images/content?path={path}&key=...
      const contentMatch = u.pathname.match(/\/api\/image-galleries\/([^/]+)\/images\/content$/);
      if (contentMatch && decodeURIComponent(contentMatch[1]) === galleryId) {
        const path = u.searchParams.get('path');
        if (path) paths.push(path);
      }
      // 公开：https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
      if (u.hostname === 'raw.githubusercontent.com') {
        const segments = u.pathname.split('/').filter(Boolean); // [owner, repo, branch, ...path]
        if (segments.length >= 4) {
          paths.push(segments.slice(3).map(decodeURIComponent).join('/'));
        }
      }
    } catch { /* not a URL */ }
  }
  return paths;
}
