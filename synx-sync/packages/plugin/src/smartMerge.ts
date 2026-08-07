export interface MarkdownMergeResult {
  clean: boolean;
  content: string;
}

export const SMART_MERGE_MAX_BYTES_PER_INPUT = 2 * 1024 * 1024;
export const SMART_MERGE_MAX_LINES_PER_INPUT = 10_000;
export const SMART_MERGE_MAX_LCS_CELLS = 4_000_000;

interface Hunk {
  start: number;
  end: number;
  lines: string[];
  side: 'local' | 'remote';
}

export function isMarkdownMergeWithinBudget(base: string, local: string, remote: string): boolean {
  const inputs = [base, local, remote];
  if (inputs.some((input) => new TextEncoder().encode(input).byteLength > SMART_MERGE_MAX_BYTES_PER_INPUT)) return false;
  const lineCounts = inputs.map((input) => splitLines(input).length);
  if (lineCounts.some((count) => count > SMART_MERGE_MAX_LINES_PER_INPUT)) return false;
  const baseRows = lineCounts[0] + 1;
  return lineCounts.slice(1).every((sideLines) => baseRows <= Math.floor(SMART_MERGE_MAX_LCS_CELLS / (sideLines + 1)));
}

export function mergeMarkdownText(base: string, local: string, remote: string): MarkdownMergeResult {
  if (local === remote) return { clean: true, content: local };
  if (local === base) return { clean: true, content: remote };
  if (remote === base) return { clean: true, content: local };

  const baseLines = splitLines(base);
  const hunks = [
    ...diffHunks(baseLines, splitLines(local), 'local'),
    ...diffHunks(baseLines, splitLines(remote), 'remote'),
  ].sort((a, b) => a.start - b.start || a.end - b.end || (a.side === 'local' ? -1 : 1));

  let content = '';
  let cursor = 0;
  let clean = true;
  for (let index = 0; index < hunks.length;) {
    const cluster: Hunk[] = [hunks[index++]];
    let end = cluster[0].end;
    while (index < hunks.length && overlapsCluster(hunks[index], cluster, end)) {
      cluster.push(hunks[index]);
      end = Math.max(end, hunks[index].end);
      index++;
    }
    const start = cluster[0].start;
    content += baseLines.slice(cursor, start).join('');
    const localHunks = cluster.filter((hunk) => hunk.side === 'local');
    const remoteHunks = cluster.filter((hunk) => hunk.side === 'remote');
    if (localHunks.length === 0 || remoteHunks.length === 0) {
      content += renderSide(baseLines, start, end, cluster);
    } else {
      const localText = renderSide(baseLines, start, end, localHunks);
      const remoteText = renderSide(baseLines, start, end, remoteHunks);
      if (localText === remoteText) content += localText;
      else {
        clean = false;
        content += conflictText(localText, remoteText);
      }
    }
    cursor = end;
  }
  content += baseLines.slice(cursor).join('');
  return { clean, content };
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffHunks(base: string[], changed: string[], side: Hunk['side']): Hunk[] {
  const lengths = Array.from({ length: base.length + 1 }, () => new Array<number>(changed.length + 1).fill(0));
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = changed.length - 1; j >= 0; j--) {
      lengths[i][j] = base[i] === changed[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let current: Hunk | undefined;
  const start = () => current ??= { start: i, end: i, lines: [], side };
  const finish = () => {
    if (current) hunks.push(current);
    current = undefined;
  };
  while (i < base.length || j < changed.length) {
    if (i < base.length && j < changed.length && base[i] === changed[j]) {
      finish(); i++; j++;
    } else if (j < changed.length && (i === base.length || lengths[i][j + 1] >= lengths[i + 1][j])) {
      start().lines.push(changed[j++]);
    } else {
      start().end = ++i;
    }
  }
  finish();
  return hunks;
}

function overlapsCluster(hunk: Hunk, cluster: Hunk[], end: number): boolean {
  if (hunk.start < end) return true;
  return hunk.start === end && cluster.some((item) => item.start === item.end && item.start === hunk.start);
}

function renderSide(base: string[], start: number, end: number, hunks: Hunk[]): string {
  let result = '';
  let cursor = start;
  for (const hunk of [...hunks].sort((a, b) => a.start - b.start || a.end - b.end)) {
    result += base.slice(cursor, hunk.start).join('') + hunk.lines.join('');
    cursor = hunk.end;
  }
  return result + base.slice(cursor, end).join('');
}

function conflictText(local: string, remote: string): string {
  return `<<<<<<< LOCAL\n${ensureTrailingNewline(local)}=======\n${ensureTrailingNewline(remote)}>>>>>>> REMOTE\n`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
