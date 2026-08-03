import type {
  MultipartCompleteRequest,
  MultipartPartsRequest,
  MultipartSessionResponse,
  MultipartStartRequest,
} from '@synx/shared';

export const MULTIPART_PART_SIZE = 16 * 1024 * 1024;
/** 超过该阈值（20 MiB）的文件走 Multipart 直传 */
export const MULTIPART_THRESHOLD = 20 * 1024 * 1024;

export interface MultipartClient {
  startMultipart(input: MultipartStartRequest): Promise<MultipartSessionResponse>;
  getMultipartPartUrls(input: MultipartPartsRequest): Promise<{ parts: Array<{ partNumber: number; url: string }> }>;
  uploadMultipartPart(url: string, content: ArrayBuffer | Uint8Array): Promise<string>;
  completeMultipart(input: MultipartCompleteRequest): Promise<{ blobId: string }>;
}

export interface MultipartContentInput {
  path: string;
  content: ArrayBuffer;
  hash: string;
  mtime: number;
  resume?: { blobId: string; uploadId: string };
  /** 会话建立或每片成功后回调（用于持久化断点）；不得抛错 */
  onProgress?: (progress: { blobId: string; uploadId: string; partSize: number; uploadedParts: Array<{ partNumber: number; etag: string }> }) => void;
}

export async function uploadMultipartContent(client: MultipartClient, input: MultipartContentInput): Promise<string> {
  const session = await client.startMultipart({
    path: input.path,
    size: input.content.byteLength,
    hash: input.hash,
    mtime: input.mtime,
    resume: input.resume,
  });
  const completed = new Map(session.uploadedParts.map((part) => [part.partNumber, part.etag]));
  const report = () => input.onProgress?.({
    blobId: session.blobId,
    uploadId: session.uploadId,
    partSize: session.partSize,
    uploadedParts: [...completed].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag })),
  });
  report();

  const missing = Array.from({ length: session.partCount }, (_, index) => index + 1).filter((partNumber) => !completed.has(partNumber));

  for (let offset = 0; offset < missing.length; offset += 16) {
    const partNumbers = missing.slice(offset, offset + 16);
    const { parts } = await client.getMultipartPartUrls({
      path: input.path,
      blobId: session.blobId,
      uploadId: session.uploadId,
      partNumbers,
    });
    for (const part of parts) {
      const start = (part.partNumber - 1) * session.partSize;
      const content = input.content.slice(start, Math.min(start + session.partSize, input.content.byteLength));
      completed.set(part.partNumber, await client.uploadMultipartPart(part.url, content));
      report();
    }
  }

  const result = await client.completeMultipart({
    path: input.path,
    blobId: session.blobId,
    uploadId: session.uploadId,
    size: input.content.byteLength,
    hash: input.hash,
    parts: [...completed].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag })),
  });
  return result.blobId;
}
