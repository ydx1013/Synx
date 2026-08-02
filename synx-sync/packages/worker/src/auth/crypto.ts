// AES-256-GCM 加解密（用于存储用户 S3 凭证）
// 密钥从 ENCRYPTION_KEY 字符串经 SHA-256 派生（AES-256 需 32 字节）

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(encryptionKey: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', strToBytes(encryptionKey));
  return crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 加密字符串，返回 base64(iv || ciphertext+tag) */
export async function encryptString(plaintext: string, encryptionKey: string): Promise<string> {
  const key = await deriveAesKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, strToBytes(plaintext));
  const ctBytes = new Uint8Array(ct);
  const combined = new Uint8Array(iv.length + ctBytes.length);
  combined.set(iv, 0);
  combined.set(ctBytes, iv.length);
  return bytesToBase64(combined);
}

/** 解密字符串 */
export async function decryptString(b64: string, encryptionKey: string): Promise<string> {
  const key = await deriveAesKey(encryptionKey);
  const combined = base64ToBytes(b64);
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
