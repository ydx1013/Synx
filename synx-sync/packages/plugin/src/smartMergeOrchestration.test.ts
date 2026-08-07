import { describe, expect, it, vi } from 'vitest';
import { attemptSmartMarkdownMerge } from './smartMergeOrchestration.js';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const text = (value: ArrayBuffer) => new TextDecoder().decode(value);

describe('attemptSmartMarkdownMerge', () => {
  it('无 base、非 Markdown 或 base 不可读时返回 unavailable', async () => {
    const read = vi.fn();
    await expect(attemptSmartMarkdownMerge({ path: 'a.txt', readBase: read } as never)).resolves.toEqual({ outcome: 'unavailable' });
    await expect(attemptSmartMarkdownMerge({ path: 'a.md', readBase: read } as never)).resolves.toEqual({ outcome: 'unavailable' });
    await expect(attemptSmartMarkdownMerge({ path: 'a.md', baseCommitId: 'c', basePath: 'a.md', readBase: vi.fn().mockRejectedValue(new Error('GC')) } as never)).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('干净合并并通过保护复查后写回本地', async () => {
    const writeMerged = vi.fn();
    const result = await attemptSmartMarkdownMerge({
      path: 'a.md', baseCommitId: 'c1', basePath: 'old.md',
      readBase: vi.fn().mockResolvedValue(bytes('a\nb\nc\n')),
      readLocal: vi.fn().mockResolvedValue(bytes('A\nb\nc\n')),
      readRemote: vi.fn().mockResolvedValue(bytes('a\nb\nC\n')),
      inspectProtection: vi.fn().mockResolvedValue('safe'), writeMerged,
      writeConflictCopy: vi.fn(), writeProtectedCopy: vi.fn(),
    });
    expect(result).toEqual({ outcome: 'merged' });
    expect(text(writeMerged.mock.calls[0][0])).toBe('A\nb\nC\n');
  });

  it('重叠修改必须把候选内容写入冲突副本并返回 conflicted', async () => {
    const writeConflictCopy = vi.fn();
    const result = await attemptSmartMarkdownMerge({
      path: 'a.md', baseCommitId: 'c1', basePath: 'a.md',
      readBase: async () => bytes('a\n'), readLocal: async () => bytes('local\n'), readRemote: async () => bytes('remote\n'),
      inspectProtection: async () => 'safe', writeMerged: vi.fn(), writeConflictCopy, writeProtectedCopy: vi.fn(),
    });
    expect(result).toEqual({ outcome: 'conflicted' });
    expect(text(writeConflictCopy.mock.calls[0][0])).toContain('<<<<<<< LOCAL');
  });

  it('计算期间受保护时不覆盖原文件，写远端普通冲突副本', async () => {
    const writeProtectedCopy = vi.fn();
    const result = await attemptSmartMarkdownMerge({
      path: 'a.md', baseCommitId: 'c1', basePath: 'a.md',
      readBase: async () => bytes('a\nb\n'), readLocal: async () => bytes('A\nb\n'), readRemote: async () => bytes('a\nB\n'),
      inspectProtection: async () => 'changed', writeMerged: vi.fn(), writeConflictCopy: vi.fn(), writeProtectedCopy,
    });
    expect(result).toEqual({ outcome: 'protected' });
    expect(text(writeProtectedCopy.mock.calls[0][0])).toBe('a\nB\n');
  });

  it('预算超限时返回 unavailable，由调用方回退 newer-with-copy', async () => {
    const writeMerged = vi.fn();
    await expect(attemptSmartMarkdownMerge({
      path: 'a.md', baseCommitId: 'c1', basePath: 'a.md',
      readBase: async () => bytes('b\n'.repeat(2_000)),
      readLocal: async () => bytes('l\n'.repeat(2_000)),
      readRemote: async () => bytes('remote\n'),
      inspectProtection: async () => 'safe', writeMerged, writeConflictCopy: vi.fn(), writeProtectedCopy: vi.fn(),
    })).resolves.toEqual({ outcome: 'unavailable' });
    expect(writeMerged).not.toHaveBeenCalled();
  });

  it('冲突副本写入失败时拒绝 action', async () => {
    await expect(attemptSmartMarkdownMerge({
      path: 'a.md', baseCommitId: 'c1', basePath: 'a.md',
      readBase: async () => bytes('a\n'), readLocal: async () => bytes('local\n'), readRemote: async () => bytes('remote\n'),
      inspectProtection: async () => 'safe', writeMerged: vi.fn(), writeConflictCopy: vi.fn().mockRejectedValue(new Error('disk full')), writeProtectedCopy: vi.fn(),
    })).rejects.toThrow('disk full');
  });
});
