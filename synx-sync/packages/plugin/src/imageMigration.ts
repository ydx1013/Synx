export interface ImageCandidate {
  raw: string;
  source: string;
  alt: string;
  kind: 'external' | 'local';
  dimensions?: string;
}

export interface GalleryIdentity {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  folder: string;
}

const IGNORED_SCHEMES = /^(?:data|blob|synx-image):/i;

export function findImageCandidates(content: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const ignoredRanges = findIgnoredRanges(content);
  const markdown = /!\[([^\]]*)\]\(<([^>]+)>\)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of content.matchAll(markdown)) {
    if (insideIgnoredRange(match.index, ignoredRanges)) continue;
    const source = match[2] ?? match[4];
    if (!source || IGNORED_SCHEMES.test(source)) continue;
    const end = match.index + match[0].length;
    if (!match[2] && content[end] && content[end] !== '\n' && content[end] !== '\r' && content[end] !== ' ' && content[end] !== '\t') continue;
    candidates.push({
      raw: match[0],
      source,
      alt: match[1] ?? match[3] ?? '',
      kind: /^https?:\/\//i.test(source) ? 'external' : 'local',
    });
  }

  const wiki = /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]*))?\]\]/g;
  for (const match of content.matchAll(wiki)) {
    if (insideIgnoredRange(match.index, ignoredRanges)) continue;
    const source = match[1].trim();
    if (!source || IGNORED_SCHEMES.test(source)) continue;
    const label = match[2]?.trim() ?? '';
    const dimensions = /^\d+(?:x\d+)?$/.test(label) ? label : undefined;
    candidates.push({ raw: match[0], source, alt: dimensions ? '' : label, kind: 'local', dimensions });
  }
  return candidates.sort((a, b) => content.indexOf(a.raw) - content.indexOf(b.raw));
}

export function isCurrentGalleryUrl(url: string, serverUrl: string, gallery: GalleryIdentity): boolean {
  try {
    const parsed = new URL(url);
    const server = new URL(serverUrl);
    const privatePath = parsed.pathname.match(/\/api\/image-galleries\/([^/]+)\/images\/content$/);
    if (parsed.origin === server.origin && privatePath && decodeURIComponent(privatePath[1]) === gallery.id) return true;

    if (parsed.hostname !== 'raw.githubusercontent.com') return false;
    const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const expectedPrefix = [gallery.owner, gallery.repo, ...gallery.branch.split('/'), ...gallery.folder.split('/')].filter(Boolean);
    return expectedPrefix.every((part, index) => segments[index] === part);
  } catch {
    return false;
  }
}

export function isSafeExternalImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const match172 = host.match(/^172\.(\d+)\./);
    if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

export function containsAttachmentReference(content: string, attachmentPath: string): boolean {
  const normalizedPath = safeDecodeURIComponent(attachmentPath).replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
  const decodedContent = safeDecodeURIComponent(content).replace(/\\/g, '/');
  return decodedContent.includes(normalizedPath) || decodedContent.includes(fileName);
}

export function applyImageReplacements(content: string, replacements: ReadonlyMap<string, string>): string {
  let updated = content;
  for (const candidate of findImageCandidates(content)) {
    const replacement = replacements.get(candidate.source);
    if (!replacement) continue;
    const alt = candidate.dimensions ? `|${candidate.dimensions}` : candidate.alt;
    updated = updated.split(candidate.raw).join(`![${alt}](${replacement})`);
  }
  return updated;
}

function findIgnoredRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of [/```[\s\S]*?```|~~~[\s\S]*?~~~/g, /<!--[\s\S]*?-->/g, /`[^\n`]*`/g]) {
    for (const match of content.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function insideIgnoredRange(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
