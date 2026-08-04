import { WorkerApiError } from './workerClient.js';

export interface UploadedImageLink {
  markdownUrl: string;
}

export async function uploadImageWithRetry<T extends UploadedImageLink>(
  upload: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await upload();
    } catch (error) {
      lastError = error;
      if (!isTemporaryUploadError(error) || attempt === 2) throw error;
      await wait(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function isTemporaryUploadError(error: unknown): boolean {
  if (!(error instanceof WorkerApiError)) return true;
  return error.status === 429 || error.status >= 500;
}
