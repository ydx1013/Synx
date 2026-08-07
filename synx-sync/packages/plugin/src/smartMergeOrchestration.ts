import { isMarkdownMergeWithinBudget, mergeMarkdownText } from './smartMerge.js';
import type { LocalWriteProtection } from './syncWriteGuard.js';

export type SmartMergeOutcome =
  | { outcome: 'unavailable' }
  | { outcome: 'merged' }
  | { outcome: 'conflicted' }
  | { outcome: 'protected' };

export interface SmartMergeOperations {
  path: string;
  baseCommitId?: string;
  basePath?: string;
  readBase(commitId: string, path: string): Promise<ArrayBuffer>;
  readLocal(): Promise<ArrayBuffer>;
  readRemote(): Promise<ArrayBuffer>;
  inspectProtection(): Promise<LocalWriteProtection>;
  writeMerged(content: ArrayBuffer): Promise<void>;
  writeConflictCopy(content: ArrayBuffer): Promise<void>;
  writeProtectedCopy(content: ArrayBuffer): Promise<void>;
}

export async function attemptSmartMarkdownMerge(operations: SmartMergeOperations): Promise<SmartMergeOutcome> {
  if (!operations.path.toLowerCase().endsWith('.md') || !operations.baseCommitId || !operations.basePath) {
    return { outcome: 'unavailable' };
  }
  let base: ArrayBuffer;
  try {
    base = await operations.readBase(operations.baseCommitId, operations.basePath);
  } catch {
    return { outcome: 'unavailable' };
  }
  const [local, remote] = await Promise.all([operations.readLocal(), operations.readRemote()]);
  const decode = new TextDecoder('utf-8', { fatal: true });
  let baseText: string;
  let localText: string;
  let remoteText: string;
  try {
    baseText = decode.decode(base);
    localText = decode.decode(local);
    remoteText = decode.decode(remote);
  } catch {
    return { outcome: 'unavailable' };
  }
  if (!isMarkdownMergeWithinBudget(baseText, localText, remoteText)) return { outcome: 'unavailable' };
  const merged = mergeMarkdownText(baseText, localText, remoteText);
  const encoded = new TextEncoder().encode(merged.content).buffer;
  if (!merged.clean) {
    await operations.writeConflictCopy(encoded);
    return { outcome: 'conflicted' };
  }
  if (await operations.inspectProtection() !== 'safe') {
    await operations.writeProtectedCopy(remote);
    return { outcome: 'protected' };
  }
  await operations.writeMerged(encoded);
  return { outcome: 'merged' };
}
