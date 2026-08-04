import { describe, expect, it, vi } from 'vitest';
import { uploadImageWithRetry } from './imageUpload.js';
import { WorkerApiError } from './workerClient.js';

describe('uploadImageWithRetry', () => {
  it('tries temporary failures three times in total', async () => {
    const upload = vi.fn()
      .mockRejectedValueOnce(new WorkerApiError(502, 'upstream'))
      .mockRejectedValueOnce(new WorkerApiError(502, 'upstream'))
      .mockResolvedValue({ markdownUrl: 'https://raw.example/a.png' });

    const result = await uploadImageWithRetry(upload, async () => undefined);
    expect(result.markdownUrl).toBe('https://raw.example/a.png');
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('does not retry deterministic errors', async () => {
    const upload = vi.fn().mockRejectedValue(new WorkerApiError(403, 'forbidden'));
    await expect(uploadImageWithRetry(upload, async () => undefined)).rejects.toMatchObject({ status: 403 });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
