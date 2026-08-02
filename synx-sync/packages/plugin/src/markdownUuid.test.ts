import { describe, expect, it } from 'vitest';
import {
  ensureMarkdownUuid,
  extractMarkdownUuid,
  findMarkdownUuidRanges,
  replaceMarkdownUuid,
} from './markdownUuid.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_UUID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

describe('Markdown UUID', () => {
  it('injects a generated UUID without changing line endings', () => {
    const result = ensureMarkdownUuid('title\r\nbody\r\n', () => UUID);
    expect(result).toEqual({
      text: `<!-- synx-id:${UUID} -->\r\ntitle\r\nbody\r\n`,
      uuid: UUID,
      changed: true,
    });
  });

  it('keeps an existing valid UUID', () => {
    const text = `<!-- synx-id:${UUID} -->\nbody`;
    expect(ensureMarkdownUuid(text, () => OTHER_UUID)).toEqual({ text, uuid: UUID, changed: false });
    expect(extractMarkdownUuid(text)).toBe(UUID);
  });

  it('does not accept malformed UUID values', () => {
    expect(extractMarkdownUuid('<!-- synx-id:not-a-uuid -->')).toBeNull();
  });

  it('replaces a copied note UUID', () => {
    const text = `<!-- synx-id:${UUID} -->\nbody`;
    expect(replaceMarkdownUuid(text, OTHER_UUID)).toBe(`<!-- synx-id:${OTHER_UUID} -->\nbody`);
  });

  it('finds every UUID comment range for editor hiding', () => {
    const text = `a\n<!-- synx-id:${UUID} -->\nb`;
    expect(findMarkdownUuidRanges(text)).toEqual([{ from: 2, to: 2 + `<!-- synx-id:${UUID} -->`.length }]);
  });
});
