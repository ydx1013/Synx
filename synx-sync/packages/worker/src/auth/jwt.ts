import type { JwtPayload } from '@synx/shared';

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', strToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** 签发 JWT（HS256），默认 7 天过期 */
export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'> & { exp?: number },
  secret: string,
  ttlSeconds = 7 * 24 * 60 * 60,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: payload.exp ?? now + ttlSeconds };
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64url(strToBytes(JSON.stringify(header)));
  const payloadB64 = base64url(strToBytes(JSON.stringify(full)));
  const data = `${headerB64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, strToBytes(data));
  return `${data}.${base64url(sig)}`;
}

/** 校验 JWT，返回 payload 或 null（无效/过期） */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, base64urlToBytes(sigB64), strToBytes(data));
  if (!valid) return null;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}
