import type { ConflictStrategy } from './settings.js';

export interface ConflictInput {
  path: string;
  localMtime: number;
  remoteMtime: number;
  localType: 'file' | 'folder';
  remoteType: 'file' | 'folder';
}

export type ConflictResolution =
  | { outcome: 'keep-local' | 'keep-remote'; conflictPath: string; preserve: 'local' | 'remote'; paused: false }
  | { outcome: 'pause'; preserve: 'both'; paused: true };

export function conflictCopyPath(path: string, device: string, timestamp: number, existing: ReadonlySet<string>): string {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash + 1) : '';
  const conflictDirectory = `.synx-conflicts/${directory}`;
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf('.');
  const basename = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  const safeDevice = device.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
  const stamp = formatTimestamp(timestamp);
  const prefix = `${conflictDirectory}${basename}.conflict-${safeDevice}-${stamp}`;
  let candidate = `${prefix}${extension}`;
  let index = 2;
  while (existing.has(candidate)) candidate = `${prefix}-${index++}${extension}`;
  return candidate;
}

export async function preserveRemoteConflictCopy(
  readRemote: () => Promise<ArrayBuffer>,
  writeCopy: (content: ArrayBuffer) => Promise<void>,
): Promise<boolean> {
  let content: ArrayBuffer;
  try {
    content = await readRemote();
  } catch {
    return false;
  }
  await writeCopy(content);
  return true;
}

export function resolveConflict(input: ConflictInput, strategy: ConflictStrategy, device: string, timestamp: number, existing: ReadonlySet<string>): ConflictResolution {
  if (strategy === 'pause') return { outcome: 'pause', preserve: 'both', paused: true };
  let outcome: 'keep-local' | 'keep-remote';
  if (strategy === 'keep-local') outcome = 'keep-local';
  else if (strategy === 'keep-remote') outcome = 'keep-remote';
  else if (input.localType !== input.remoteType) outcome = input.localType === 'folder' ? 'keep-local' : 'keep-remote';
  else outcome = input.localMtime >= input.remoteMtime ? 'keep-local' : 'keep-remote';
  return {
    outcome,
    conflictPath: conflictCopyPath(input.path, device, timestamp, existing),
    preserve: outcome === 'keep-local' ? 'remote' : 'local',
    paused: false,
  };
}

function formatTimestamp(value: number): string {
  const iso = new Date(value).toISOString();
  return iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '');
}
