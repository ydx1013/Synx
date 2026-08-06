import { describe, expect, it, vi } from 'vitest';
import type { WorkerFs } from '@synx/shared';
import { checkConnectivity, ConnectivityError } from './connectivity.js';

function fs(overrides: Partial<WorkerFs> = {}): WorkerFs {
  return {
    list: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(new TextEncoder().encode('synx-connectivity-check-overwrite').buffer),
    delete: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('checkConnectivity diagnostics', () => {
  it('reports the list stage and preserves the upstream error contract', async () => {
    const storage = fs({ list: vi.fn().mockRejectedValue(new Error('Authorization: Basic secret')) });
    const error = await checkConnectivity(storage).catch((value) => value);
    expect(error).toBeInstanceOf(ConnectivityError);
    expect(error.stage).toBe('list');
    expect(error.cleanupFailed).toBe(false);
    expect(error.message).toBe('Authorization: Basic secret');
  });

  it('distinguishes stages while preserving their underlying errors', async () => {
    const cases: Array<[string, string, WorkerFs]> = [
      ['upload', 'upload denied', fs({ put: vi.fn().mockRejectedValueOnce(new Error('upload denied')) })],
      ['overwrite', 'overwrite denied', fs({ put: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('overwrite denied')) })],
      ['download', 'download denied', fs({ get: vi.fn().mockRejectedValue(new Error('download denied')) })],
      ['verify', 'downloaded content mismatch', fs({ get: vi.fn().mockResolvedValue(new TextEncoder().encode('wrong').buffer) })],
      ['delete', 'delete denied', fs({ delete: vi.fn().mockRejectedValue(new Error('delete denied')) })],
    ];
    for (const [stage, message, storage] of cases) {
      const error = await checkConnectivity(storage).catch((value) => value);
      expect(error).toBeInstanceOf(ConnectivityError);
      expect(error.stage).toBe(stage);
      expect(error.message).toBe(message);
    }
  });

  it('attempts cleanup after the initial upload fails and reports cleanup failure', async () => {
    const storage = fs({
      put: vi.fn().mockRejectedValueOnce(new Error('upload denied')),
      delete: vi.fn().mockRejectedValue(new Error('cleanup denied')),
    });
    const error = await checkConnectivity(storage, 'fixed-id').catch((value) => value);
    expect(storage.delete).toHaveBeenCalledWith('.synx-connectivity-test/fixed-id');
    expect(error).toBeInstanceOf(ConnectivityError);
    expect(error.stage).toBe('upload');
    expect(error.cleanupFailed).toBe(true);
    expect(error.message).toBe('upload denied; cleanup failed');
  });

  it('preserves the operation error and marks cleanup failure', async () => {
    const storage = fs({
      put: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('operation denied')),
      delete: vi.fn().mockRejectedValue(new Error('cleanup denied')),
    });
    const error = await checkConnectivity(storage).catch((value) => value);
    expect(error.stage).toBe('overwrite');
    expect(error.cleanupFailed).toBe(true);
    expect(error.message).toBe('operation denied; cleanup failed');
  });

  it.each([
    ['auth', new Error('webdav list failed (403)')],
    ['mkdir', new Error('webdav mkdir failed for https://user:pass@example.com (405)')],
    ['transient', new Error('webdav put failed (520)')],
  ])('records the safe %s diagnostic category independently of the underlying error', async (category, cause) => {
    const storage = category === 'auth'
      ? fs({ list: vi.fn().mockRejectedValue(cause) })
      : fs({ put: vi.fn().mockRejectedValue(cause) });
    const error = await checkConnectivity(storage).catch((value) => value);
    expect(error.category).toBe(category);
    expect(error.message).toBe(cause.message);
  });

  it('preserves a transient category from the overwrite stage', async () => {
    const storage = fs({
      put: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('webdav put failed (503)')),
    });
    const error = await checkConnectivity(storage).catch((value) => value);
    expect(error.stage).toBe('overwrite');
    expect(error.category).toBe('transient');
  });
});
