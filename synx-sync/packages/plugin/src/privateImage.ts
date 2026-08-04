export interface PrivateImageReference {
  galleryId: string;
  path: string;
}

export function parsePrivateImageUrl(value: string): PrivateImageReference | null {
  if (!value.startsWith('synx-image://')) return null;
  try {
    const url = new URL(value);
    const galleryId = decodeURIComponent(url.hostname);
    const path = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    return galleryId && path ? { galleryId, path } : null;
  } catch {
    return null;
  }
}
