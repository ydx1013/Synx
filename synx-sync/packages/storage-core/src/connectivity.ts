import type { WorkerFs } from '@synx/shared';

const CONNECTIVITY_PREFIX = '.synx-connectivity-test/';
const CONNECTIVITY_CONTENT = new TextEncoder().encode('synx-connectivity-check');
const CONNECTIVITY_OVERWRITE = new TextEncoder().encode('synx-connectivity-check-overwrite');

export type ConnectivityStage = 'list' | 'upload' | 'overwrite' | 'download' | 'verify' | 'delete';
export type ConnectivityCategory = 'auth' | 'mkdir' | 'transient' | 'operation';

export class ConnectivityError extends Error {
  constructor(
    public readonly stage: ConnectivityStage,
    public readonly cleanupFailed: boolean,
    public readonly category: ConnectivityCategory = 'operation',
    cause?: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : `connectivity ${stage} failed`;
    super(cleanupFailed ? `${message}; cleanup failed` : message);
    this.name = 'ConnectivityError';
  }
}

export async function checkConnectivity(
  fs: WorkerFs,
  id: string = crypto.randomUUID(),
): Promise<{ ok: true }> {
  const key = `${CONNECTIVITY_PREFIX}${id}`;
  let operationStage: ConnectivityStage | null = null;
  let operationCategory: ConnectivityCategory = 'operation';
  let operationError: unknown;
  let uploaded = false;

  try {
    await fs.list(CONNECTIVITY_PREFIX);
  } catch (error) {
    throw new ConnectivityError('list', false, categorizeConnectivityError(error), error);
  }

  try {
    await fs.put(key, CONNECTIVITY_CONTENT);
    uploaded = true;
  } catch (error) {
    let cleanupFailed = false;
    try {
      await fs.delete(key);
    } catch {
      cleanupFailed = true;
    }
    throw new ConnectivityError('upload', cleanupFailed, categorizeConnectivityError(error), error);
  }

  try {
    await fs.put(key, CONNECTIVITY_OVERWRITE);
  } catch (error) {
    operationStage = 'overwrite';
    operationCategory = categorizeConnectivityError(error);
    operationError = error;
  }

  if (!operationStage) {
    let downloaded: Uint8Array | null = null;
    try {
      downloaded = new Uint8Array(await fs.get(key));
    } catch (error) {
      operationStage = 'download';
      operationCategory = categorizeConnectivityError(error);
      operationError = error;
    }
    if (downloaded && !bytesEqual(downloaded, CONNECTIVITY_OVERWRITE)) {
      operationStage = 'verify';
      operationError = new Error('downloaded content mismatch');
    }
  }

  let cleanupError: unknown;
  if (uploaded) {
    try {
      await fs.delete(key);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (operationStage) {
    throw new ConnectivityError(operationStage, cleanupError !== undefined, operationCategory, operationError);
  }
  if (cleanupError !== undefined) {
    throw new ConnectivityError('delete', false, categorizeConnectivityError(cleanupError), cleanupError);
  }
  return { ok: true };
}

function categorizeConnectivityError(error: unknown): ConnectivityCategory {
  const message = error instanceof Error ? error.message : '';
  if (/\((401|403)\)/.test(message)) return 'auth';
  if (/mkdir failed/.test(message)) return 'mkdir';
  if (/\((429|502|503|504|520)\)/.test(message)) return 'transient';
  return 'operation';
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
