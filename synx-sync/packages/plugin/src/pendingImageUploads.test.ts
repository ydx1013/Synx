import { describe, expect, it } from 'vitest';
import { pendingUploadKey, replaceExactEmbed } from './pendingImageUploads.js';

describe('pending image uploads', () => {
  it('deduplicates by local and note path', () => {
    expect(pendingUploadKey('attachments/a.png', 'notes/a.md')).toBe('attachments/a.png\nnotes/a.md');
  });

  it('only replaces an exact recorded embed', () => {
    expect(replaceExactEmbed('before ![[a.png]] after', '![[a.png]]', '![](remote)')).toBe('before ![](remote) after');
    expect(replaceExactEmbed('changed', '![[a.png]]', '![](remote)')).toBeNull();
  });
});
