import { describe, expect, it } from 'vitest';
import { isMarkdownMergeWithinBudget, mergeMarkdownText } from './smartMerge.js';

describe('isMarkdownMergeWithinBudget', () => {
  it('拒绝高行数短行输入，避免进入 LCS 矩阵', () => {
    const manyLines = 'x\n'.repeat(10_001);
    expect(isMarkdownMergeWithinBudget('base\n', manyLines, 'remote\n')).toBe(false);
  });

  it('拒绝超过 2MiB 的单份内容', () => {
    expect(isMarkdownMergeWithinBudget('x'.repeat(2 * 1024 * 1024 + 1), 'local', 'remote')).toBe(false);
  });

  it('拒绝超过四百万 cells 的矩阵并接受普通笔记', () => {
    expect(isMarkdownMergeWithinBudget('b\n'.repeat(2_000), 'l\n'.repeat(2_000), 'remote')).toBe(false);
    expect(isMarkdownMergeWithinBudget('a\nb\n', 'A\nb\n', 'a\nB\n')).toBe(true);
  });
});

describe('mergeMarkdownText', () => {
  it('合并双方修改的不同行', () => {
    expect(mergeMarkdownText('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({
      clean: true,
      content: 'A\nb\nC\n',
    });
  });

  it('合并双方在不同位置的插入和删除', () => {
    expect(mergeMarkdownText('a\nb\nc\n', 'x\na\nc\n', 'a\nb\nc\ny\n')).toEqual({
      clean: true,
      content: 'x\na\nc\ny\n',
    });
  });

  it('双方同改为相同结果时不冲突', () => {
    expect(mergeMarkdownText('a\nb\n', 'a\nB\n', 'a\nB\n')).toEqual({ clean: true, content: 'a\nB\n' });
  });

  it('重叠修改生成标准冲突标记候选内容', () => {
    expect(mergeMarkdownText('a\nb\nc\n', 'a\nlocal\nc\n', 'a\nremote\nc\n')).toEqual({
      clean: false,
      content: 'a\n<<<<<<< LOCAL\nlocal\n=======\nremote\n>>>>>>> REMOTE\nc\n',
    });
  });

  it('保留无末尾换行的输入语义', () => {
    expect(mergeMarkdownText('a\nb', 'A\nb', 'a\nB')).toEqual({ clean: true, content: 'A\nB' });
  });
});
