import { describe, expect, it, vi } from 'vitest';
import type { WorkerFs } from '@synx/shared';
import { checkS3Connectivity } from './s3Fs.js';

function makeFs(overrides: Partial<WorkerFs> = {}): WorkerFs {
  return {
    list: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(new TextEncoder().encode('synx-connectivity-check-overwrite').buffer),
    delete: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('checkS3Connectivity', () => {
  it('verifies list, two writes, download integrity and cleanup', async () => {
    const fs = makeFs();

    await expect(checkS3Connectivity(fs, 'fixed-id')).resolves.toEqual({ ok: true });

    expect(fs.list).toHaveBeenCalledWith('.synx-connectivity-test/');
    expect(fs.put).toHaveBeenCalledTimes(2);
    expect(fs.get).toHaveBeenCalledWith('.synx-connectivity-test/fixed-id');
    expect(fs.delete).toHaveBeenCalledWith('.synx-connectivity-test/fixed-id');
  });

  it('rejects when downloaded content differs and still cleans up', async () => {
    const fs = makeFs({
      get: vi.fn().mockResolvedValue(new TextEncoder().encode('different').buffer),
    });

    await expect(checkS3Connectivity(fs, 'fixed-id')).rejects.toThrow('downloaded content mismatch');
    expect(fs.delete).toHaveBeenCalledWith('.synx-connectivity-test/fixed-id');
  });

  it('attempts cleanup when the second write fails', async () => {
    const put = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write denied'));
    const fs = makeFs({ put });

    await expect(checkS3Connectivity(fs, 'fixed-id')).rejects.toThrow('write denied');
    expect(fs.delete).toHaveBeenCalledWith('.synx-connectivity-test/fixed-id');
  });

  it('preserves the operation error when cleanup also fails', async () => {
    const fs = makeFs({
      get: vi.fn().mockRejectedValue(new Error('read denied')),
      delete: vi.fn().mockRejectedValue(new Error('delete denied')),
    });

    await expect(checkS3Connectivity(fs, 'fixed-id')).rejects.toThrow('read denied; cleanup failed');
  });
});
