import { describe, expect, it } from 'vitest';
import { applyImageReplacements, containsAttachmentReference, findImageCandidates, isCurrentGalleryUrl, isSafeExternalImageUrl } from './imageMigration.js';

describe('image migration', () => {
  it('finds external and local Markdown and wiki image embeds', () => {
    const content = [
      '![外链](https://example.com/a.png)',
      '![本地](attachments/b.jpg)',
      '![[images/c.webp|封面]]',
      '[普通链接](https://example.com/page)',
    ].join('\n');

    expect(findImageCandidates(content)).toEqual([
      { raw: '![外链](https://example.com/a.png)', source: 'https://example.com/a.png', alt: '外链', kind: 'external' },
      { raw: '![本地](attachments/b.jpg)', source: 'attachments/b.jpg', alt: '本地', kind: 'local' },
      { raw: '![[images/c.webp|封面]]', source: 'images/c.webp', alt: '封面', kind: 'local' },
    ]);
  });

  it('ignores non-image schemes and Synx legacy links', () => {
    const content = [
      '![](data:image/png;base64,abc)',
      '![](blob:https://example.com/id)',
      '![](synx-image://gallery/images/a.png)',
    ].join('\n');

    expect(findImageCandidates(content)).toEqual([]);
  });

  it('recognizes current private and public gallery URLs', () => {
    const gallery = { id: 'gallery-1', owner: 'alice', repo: 'images', branch: 'main', folder: 'uploads' };
    expect(isCurrentGalleryUrl('https://synx.example/api/image-galleries/gallery-1/images/content?path=uploads%2Fa.png&key=x', 'https://synx.example', gallery)).toBe(true);
    expect(isCurrentGalleryUrl('https://raw.githubusercontent.com/alice/images/main/uploads/2026/a.png', 'https://synx.example', gallery)).toBe(true);
    expect(isCurrentGalleryUrl('https://example.com/a.png', 'https://synx.example', gallery)).toBe(false);
  });

  it('does not scan image syntax inside code or comments', () => {
    const content = '`![](https://example.com/inline.png)`\n```md\n![](https://example.com/code.png)\n```\n<!-- ![](https://example.com/comment.png) -->';
    expect(findImageCandidates(content)).toEqual([]);
  });

  it('skips ambiguous Markdown URLs containing parentheses instead of truncating them', () => {
    expect(findImageCandidates('![](https://example.com/a_(1).png)')).toEqual([]);
  });

  it('preserves Obsidian wiki image dimensions', () => {
    const content = '![[images/a.png|300x200]]';
    expect(applyImageReplacements(content, new Map([['images/a.png', 'https://gallery/a.png']]))).toBe('![|300x200](https://gallery/a.png)');
  });

  it('supports gallery branches containing slashes', () => {
    const gallery = { id: 'gallery-1', owner: 'alice', repo: 'images', branch: 'feature/images', folder: 'uploads' };
    expect(isCurrentGalleryUrl('https://raw.githubusercontent.com/alice/images/feature/images/uploads/2026/a.png', 'https://synx.example', gallery)).toBe(true);
  });

  it('rejects local and private-network external URLs', () => {
    expect(isSafeExternalImageUrl('https://example.com/a.png')).toBe(true);
    expect(isSafeExternalImageUrl('http://localhost/a.png')).toBe(false);
    expect(isSafeExternalImageUrl('http://127.0.0.1/a.png')).toBe(false);
    expect(isSafeExternalImageUrl('http://192.168.1.2/a.png')).toBe(false);
    expect(isSafeExternalImageUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('detects non-embed Markdown and HTML attachment references before deletion', () => {
    expect(containsAttachmentReference('[下载](../assets/a.png)', 'assets/a.png')).toBe(true);
    expect(containsAttachmentReference('<img src="assets/a.png">', 'assets/a.png')).toBe(true);
    expect(containsAttachmentReference('unrelated text', 'assets/a.png')).toBe(false);
  });

  it('replaces every occurrence while preserving alt text', () => {
    const content = '![A](https://example.com/a.png) and ![A](https://example.com/a.png)';
    expect(applyImageReplacements(content, new Map([['https://example.com/a.png', 'https://gallery/a.png']]))).toBe(
      '![A](https://gallery/a.png) and ![A](https://gallery/a.png)',
    );
  });
});
