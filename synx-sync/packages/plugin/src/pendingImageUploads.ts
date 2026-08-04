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

export function collectReferencedImagePaths(content: string, galleryId: string): string[] {
  const paths = new Set<string>();
  const privatePrefix = `synx-image://${galleryId}/`;
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const value = match[1];
    if (value.startsWith(privatePrefix)) {
      paths.add(value.slice(privatePrefix.length).split('/').map(decodeURIComponent).join('/'));
      continue;
    }
    try {
      const url = new URL(value);
      if (url.hostname !== 'raw.githubusercontent.com') continue;
      const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
      const imagesIndex = parts.indexOf('images', 3);
      if (imagesIndex >= 0) paths.add(parts.slice(imagesIndex).join('/'));
    } catch { /* 非 URL 链接 */ }
  }
  return [...paths];
}
