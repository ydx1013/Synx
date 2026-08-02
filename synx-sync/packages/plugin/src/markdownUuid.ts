const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_COMMENT = new RegExp(`<!--\\s*synx-id\\s*:\\s*(${UUID_PATTERN})\\s*-->`, 'i');
const UUID_COMMENTS = new RegExp(UUID_COMMENT.source, 'gi');

export interface MarkdownUuidResult {
  text: string;
  uuid: string;
  changed: boolean;
}

export interface TextRange {
  from: number;
  to: number;
}

export function extractMarkdownUuid(text: string): string | null {
  return UUID_COMMENT.exec(text)?.[1]?.toLowerCase() ?? null;
}

export function ensureMarkdownUuid(text: string, generate: () => string = () => crypto.randomUUID()): MarkdownUuidResult {
  const existing = extractMarkdownUuid(text);
  if (existing) return { text, uuid: existing, changed: false };
  const uuid = generate().toLowerCase();
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return { text: `<!-- synx-id:${uuid} -->${newline}${text}`, uuid, changed: true };
}

export function replaceMarkdownUuid(text: string, uuid: string): string {
  return text.replace(UUID_COMMENT, `<!-- synx-id:${uuid.toLowerCase()} -->`);
}

export function findMarkdownUuidRanges(text: string): TextRange[] {
  UUID_COMMENTS.lastIndex = 0;
  const ranges: TextRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = UUID_COMMENTS.exec(text)) !== null) ranges.push({ from: match.index, to: match.index + match[0].length });
  return ranges;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}
