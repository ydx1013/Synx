import { describe, expect, it } from 'vitest';
import { buildLineDiff, DiffTooLargeError } from './lineDiff';

describe('buildLineDiff', () => {
  it('returns unchanged lines when contents match', () => {
    expect(buildLineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { type: 'context', oldLine: 2, newLine: 2, text: 'b' },
    ]);
  });

  it('marks replacements as removed then added', () => {
    expect(buildLineDiff('a\nold\nc', 'a\nnew\nc')).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { type: 'remove', oldLine: 2, newLine: null, text: 'old' },
      { type: 'add', oldLine: null, newLine: 2, text: 'new' },
      { type: 'context', oldLine: 3, newLine: 3, text: 'c' },
    ]);
  });

  it('marks inserted and deleted lines with correct line numbers', () => {
    const result = buildLineDiff('a\nb\nc', 'a\nx\nb');
    expect(result).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { type: 'add', oldLine: null, newLine: 2, text: 'x' },
      { type: 'context', oldLine: 2, newLine: 3, text: 'b' },
      { type: 'remove', oldLine: 3, newLine: null, text: 'c' },
    ]);
  });

  it('normalizes CRLF line endings', () => {
    expect(buildLineDiff('a\r\nb', 'a\nb')).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'a' },
      { type: 'context', oldLine: 2, newLine: 2, text: 'b' },
    ]);
  });

  it('rejects inputs that would create an excessive LCS matrix', () => {
    const text = Array.from({ length: 2100 }, (_, index) => `line-${index}`).join('\n');
    expect(() => buildLineDiff(text, text)).toThrow(DiffTooLargeError);
  });
});
