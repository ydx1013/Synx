import { describe, expect, it } from 'vitest';
import { collectReferencedImagePaths, pendingUploadKey, replaceExactEmbed } from './pendingImageUploads.js';

describe('pending image uploads', () => {
  it('deduplicates by local and note path', () => {
    expect(pendingUploadKey('attachments/a.png', 'notes/a.md')).toBe('attachments/a.png\nnotes/a.md');
  });

  it('only replaces an exact recorded embed', () => {
    expect(replaceExactEmbed('before ![[a.png]] after', '![[a.png]]', '![](remote)')).toBe('before ![](remote) after');
    expect(replaceExactEmbed('changed', '![[a.png]]', '![](remote)')).toBeNull();
  });

  it('collects both private and public gallery image paths', () => {
    const content = [
      '![](synx-image://gallery-id/images/2026/01/private.png)',
      '![](https://raw.githubusercontent.com/owner/repo/main/images/2026/02/public.png)',
    ].join('\n');
    expect(collectReferencedImagePaths(content, 'gallery-id')).toEqual([
      'images/2026/01/private.png',
      'images/2026/02/public.png',
    ]);
  });
});
