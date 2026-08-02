export * from './types.js';
export * from './workerFs.js';
export * from './api.js';

/** 工具：base64 <-> ArrayBuffer */
export function arrayBufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // Obsidian/Electron 环境下 btoa 可能 "Illegal invocation"，优先用 Buffer
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Buffer !== 'undefined') {
    return (g.Buffer as { from(d: Uint8Array): { toString(e: string): string } }).from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Buffer !== 'undefined') {
    const buf = (g.Buffer as { from(s: string, e: string): Uint8Array }).from(b64, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** 生成版本 ID：时间戳 + 短哈希 */
export function makeVersionId(timestamp: number, hashHex: string): string {
  const ts = new Date(timestamp).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const short = hashHex.slice(0, 6);
  return `v${ts}_${short}`;
}

/** 生成对象 storage key：{syncFolder}/{path}@v{ts}_{hash} */
export function makeStorageKey(syncFolder: string, path: string, versionId: string): string {
  const folder = syncFolder.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  return `${folder}/${cleanPath}@${versionId}`;
}
