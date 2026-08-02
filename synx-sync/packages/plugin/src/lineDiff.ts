export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export const MAX_DIFF_LINES = 4000;
export const MAX_DIFF_CELLS = 4_000_000;

export class DiffTooLargeError extends Error {
  constructor() {
    super('文件过大，无法生成差异视图，请使用源码查看。');
  }
}

export function buildLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length + newLines.length > MAX_DIFF_LINES || oldLines.length * newLines.length > MAX_DIFF_CELLS) {
    throw new DiffTooLargeError();
  }
  const table = buildLcsTable(oldLines, newLines);
  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push({ type: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1, text: oldLines[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      result.push({ type: 'remove', oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
      oldIndex++;
    } else {
      result.push({ type: 'add', oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
      newIndex++;
    }
  }

  while (oldIndex < oldLines.length) {
    result.push({ type: 'remove', oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
    oldIndex++;
  }
  while (newIndex < newLines.length) {
    result.push({ type: 'add', oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
    newIndex++;
  }

  return result;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  return table;
}
