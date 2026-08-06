import type { StorageCredentialsResponse } from '@synx/shared';
import { StorageRequestError } from '@synx/storage-core';

const CACHE_VERSION = 1 as const;
const encoder = new TextEncoder();

export interface CredentialCacheContext {
  jwt: string;
  userId: string;
  storageId: string;
}

export interface EncryptedStorageCredentialsV1 {
  version: 1;
  iv: string;
  ciphertext: string;
}

export interface CredentialCacheStateV1 {
  version: 1;
  salt: string;
  entries: Record<string, EncryptedStorageCredentialsV1>;
}

export type CredentialCacheState = CredentialCacheStateV1;

export interface CredentialCacheSession {
  jwt: string;
  userId: string | null;
}

export interface CredentialRequestIdentity {
  jwt: string;
  userId: string;
  storageId: string;
  client: unknown;
  generation: number;
}

export function createCredentialCache(): CredentialCacheState {
  return {
    version: CACHE_VERSION,
    salt: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
    entries: {},
  };
}

export function isCredentialCacheState(value: unknown): value is CredentialCacheState {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<CredentialCacheState>;
  return cache.version === CACHE_VERSION
    && typeof cache.salt === 'string'
    && !!cache.entries
    && typeof cache.entries === 'object';
}

export function readCredentialCacheFromState(state: unknown): CredentialCacheState | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { credentialCache?: unknown }).credentialCache;
  return isCredentialCacheState(value) ? value : undefined;
}

export function writeCredentialCacheToState<T extends object>(state: T, credentialCache: CredentialCacheState): T & { credentialCache: CredentialCacheState } {
  return { ...state, credentialCache };
}

export function isCredentialRequestCurrent(captured: CredentialRequestIdentity, current: CredentialRequestIdentity): boolean {
  return captured.jwt === current.jwt
    && captured.userId === current.userId
    && captured.storageId === current.storageId
    && captured.client === current.client
    && captured.generation === current.generation;
}

export async function persistRefreshedStorageCredentials(
  credentials: StorageCredentialsResponse,
  captured: CredentialRequestIdentity,
  getCurrent: () => CredentialRequestIdentity,
  cache: CredentialCacheState,
  persist: () => Promise<void>,
): Promise<boolean> {
  if (!isCredentialRequestCurrent(captured, getCurrent())) return false;
  const context = { jwt: captured.jwt, userId: captured.userId, storageId: captured.storageId };
  const encrypted = await encryptStorageCredentials(credentials, context, cache.salt);
  if (!isCredentialRequestCurrent(captured, getCurrent())) return false;
  cache.entries[captured.storageId] = encrypted;
  await persist();
  return true;
}

export function createSerialStateWriter<T>(buildState: () => T, write: (state: T) => Promise<void>): () => Promise<void> {
  let queue = Promise.resolve();
  return () => {
    const requestedWrite = queue.then(() => write(buildState()));
    queue = requestedWrite.catch(() => undefined);
    return requestedWrite;
  };
}

export function parseStorageCredentialsResponse(value: unknown, expectedStorageId: string): StorageCredentialsResponse {
  if (!value || typeof value !== 'object') throw new Error('无效的凭证响应');
  const response = value as { storageId?: unknown; type?: unknown; config?: unknown };
  if (response.storageId !== expectedStorageId) throw new Error('凭证响应 storageId 不匹配');
  if (!response.config || typeof response.config !== 'object') throw new Error('无效的凭证 config');
  const config = response.config as Record<string, unknown>;
  const strings = (fields: string[]) => fields.every((field) => typeof config[field] === 'string' && config[field] !== '');
  if (response.type === 's3') {
    if (!strings(['endpoint', 'bucket', 'accessKey', 'secretKey', 'region']) || !isSafeHttpsUrl(config.endpoint as string) || (config.pathStyle !== undefined && typeof config.pathStyle !== 'boolean')) throw new Error('无效的 s3 config');
  } else if (response.type === 'webdav') {
    if (!strings(['address', 'username', 'password']) || !isSafeHttpsUrl(config.address as string) || config.authType !== 'basic' || (config.remoteBaseDir !== undefined && typeof config.remoteBaseDir !== 'string') || (config.customHeaders !== undefined && typeof config.customHeaders !== 'string')) throw new Error('无效的 webdav config');
  } else if (response.type === 'onedrive') {
    if (!strings(['accessToken', 'refreshToken', 'clientId', 'authority']) || !isMicrosoftAuthority(config.authority as string) || typeof config.accessTokenExpiresAt !== 'number' || !Number.isFinite(config.accessTokenExpiresAt) || (config.remoteBaseDir !== undefined && typeof config.remoteBaseDir !== 'string') || (config.username !== undefined && typeof config.username !== 'string')) throw new Error('无效的 onedrive config');
  } else {
    throw new Error('无效的凭证 type');
  }
  return value as StorageCredentialsResponse;
}

export async function encryptStorageCredentials(
  credentials: StorageCredentialsResponse,
  context: CredentialCacheContext,
  salt: string,
): Promise<EncryptedStorageCredentialsV1> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(context.jwt, base64ToArrayBuffer(salt));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: additionalData(context) },
    key,
    encoder.encode(JSON.stringify(credentials)),
  );
  return { version: CACHE_VERSION, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptStorageCredentials(
  encrypted: EncryptedStorageCredentialsV1,
  context: CredentialCacheContext,
  salt: string,
): Promise<StorageCredentialsResponse> {
  if (encrypted.version !== CACHE_VERSION) throw new Error('不支持的凭证缓存版本');
  const key = await deriveKey(context.jwt, base64ToArrayBuffer(salt));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(encrypted.iv), additionalData: additionalData(context) },
    key,
    base64ToArrayBuffer(encrypted.ciphertext),
  );
  return parseStorageCredentialsResponse(JSON.parse(new TextDecoder().decode(plaintext)), context.storageId);
}

export function reconcileCredentialCacheSession(
  cache: CredentialCacheState,
  previous: CredentialCacheSession,
  next: CredentialCacheSession,
): CredentialCacheState {
  if (previous.jwt === next.jwt && previous.userId === next.userId) return cache;
  return { ...cache, entries: {} };
}

export function clearCredentialCacheForAuthFailure(
  cache: CredentialCacheState,
  status: number,
  storageId: string,
): CredentialCacheState {
  if (status === 401) return { ...cache, entries: {} };
  if (status !== 403 || !(storageId in cache.entries)) return cache;
  const entries = { ...cache.entries };
  delete entries[storageId];
  return { ...cache, entries };
}

export async function handleStorageAuthFailures(
  results: ReadonlyArray<{ cause?: unknown }>,
  storageId: string,
  cache: CredentialCacheState,
  updateCache: (cache: CredentialCacheState) => void,
  invalidate: (storageId?: string) => void,
  persist: () => Promise<void>,
): Promise<boolean> {
  const statuses = results.flatMap(({ cause }) => cause instanceof StorageRequestError && (cause.status === 401 || cause.status === 403) ? [cause.status] : []);
  if (statuses.length === 0) return false;
  const status = statuses.includes(401) ? 401 : 403;
  updateCache(clearCredentialCacheForAuthFailure(cache, status, storageId));
  invalidate(status === 403 ? storageId : undefined);
  await persist();
  return true;
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function isSafeHttpsUrl(value: string): boolean {
  const url = parseHttpsUrl(value);
  if (!url) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (hostname.includes(':')) return /^[23][0-9a-f]{3}:/i.test(hostname);
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 0 && octets[2] === 2) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && octets[2] === 100) || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224);
}

function isMicrosoftAuthority(value: string): boolean {
  const url = parseHttpsUrl(value);
  return url?.hostname.toLowerCase() === 'login.microsoftonline.com';
}

async function deriveKey(jwt: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(jwt), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('synx-storage-credentials-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function additionalData(context: Pick<CredentialCacheContext, 'userId' | 'storageId'>): ArrayBuffer {
  return toArrayBuffer(encoder.encode(JSON.stringify([CACHE_VERSION, context.userId, context.storageId])));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  return toArrayBuffer(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
