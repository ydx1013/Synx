import { describe, expect, it, vi } from 'vitest';
import { uploadMultipartContent } from './multipartUpload.js';

describe('uploadMultipartContent', () => {
  it('只上传远端缺失分片并完成会话', async () => {
    const client = {
      startMultipart: vi.fn().mockResolvedValue({
        blobId: 'vault/a.bin@id', uploadId: 'u1', partSize: 4, partCount: 3,
        uploadedParts: [{ partNumber: 1, etag: '"e1"', size: 4 }],
      }),
      getMultipartPartUrls: vi.fn().mockImplementation(async ({ partNumbers }: { partNumbers: number[] }) => ({
        parts: partNumbers.map((partNumber) => ({ partNumber, url: `https://storage/${partNumber}` })),
      })),
      uploadMultipartPart: vi.fn().mockImplementation(async (url: string) => `"e${url.at(-1)}"`),
      completeMultipart: vi.fn().mockResolvedValue({ blobId: 'vault/a.bin@id', size: 10, hash: 'a'.repeat(64) }),
    };
    const result = await uploadMultipartContent(client, {
      path: 'a.bin', content: new Uint8Array(10).buffer, hash: 'a'.repeat(64), mtime: 1,
      onProgress: vi.fn(),
    });
    expect(client.uploadMultipartPart).toHaveBeenCalledTimes(2);
    expect(client.uploadMultipartPart.mock.calls[0][1].byteLength).toBe(4);
    expect(client.uploadMultipartPart.mock.calls[1][1].byteLength).toBe(2);
    expect(client.completeMultipart).toHaveBeenCalledWith(expect.objectContaining({
      parts: [
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 2, etag: '"e2"' },
        { partNumber: 3, etag: '"e3"' },
      ],
    }));
    expect(result).toBe('vault/a.bin@id');
  });
});
