import { describe, expect, it, vi } from 'vitest';
import { StorageRequestError } from '@synx/storage-core';
import type { StorageCredentialsResponse } from '@synx/shared';
import {
  clearCredentialCacheForAuthFailure,
  handleStorageAuthFailures,
  createCredentialCache,
  createSerialStateWriter,
  decryptStorageCredentials,
  encryptStorageCredentials,
  isCredentialRequestCurrent,
  persistRefreshedStorageCredentials,
  parseStorageCredentialsResponse,
  readCredentialCacheFromState,
  reconcileCredentialCacheSession,
  writeCredentialCacheToState,
  type CredentialCacheState,
} from './credentialCache.js';

const credentials: StorageCredentialsResponse = {
  storageId: 'storage/one',
  type: 's3',
  config: {
    endpoint: 'https://s3.example.com',
    bucket: 'notes',
    accessKey: 'access-secret',
    secretKey: 'top-secret-value',
    region: 'auto',
  },
};

const context = { jwt: 'jwt-one', userId: 'user-one', storageId: 'storage/one' };

describe('credentialCache crypto', () => {
  it('roundtrips credentials with a versioned encrypted record', async () => {
    const cache = createCredentialCache();
    const encrypted = await encryptStorageCredentials(credentials, context, cache.salt);
    expect(encrypted.version).toBe(1);
    await expect(decryptStorageCredentials(encrypted, context, cache.salt)).resolves.toEqual(credentials);
  });

  it('uses a fresh 12-byte random IV for each encryption', async () => {
    const cache = createCredentialCache();
    const first = await encryptStorageCredentials(credentials, context, cache.salt);
    const second = await encryptStorageCredentials(credentials, context, cache.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(atob(first.iv)).toHaveLength(12);
  });

  it.each([
    ['jwt', { ...context, jwt: 'wrong-jwt' }, undefined],
    ['userId', { ...context, userId: 'wrong-user' }, undefined],
    ['storageId', { ...context, storageId: 'wrong-storage' }, undefined],
    ['salt', context, createCredentialCache().salt],
  ])('rejects decryption with the wrong %s', async (_name, badContext, badSalt) => {
    const cache = createCredentialCache();
    const encrypted = await encryptStorageCredentials(credentials, context, cache.salt);
    await expect(decryptStorageCredentials(encrypted, badContext, badSalt ?? cache.salt)).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const cache = createCredentialCache();
    const encrypted = await encryptStorageCredentials(credentials, context, cache.salt);
    const bytes = Uint8Array.from(atob(encrypted.ciphertext), (char) => char.charCodeAt(0));
    bytes[0] ^= 1;
    const tampered = { ...encrypted, ciphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptStorageCredentials(tampered, context, cache.salt)).rejects.toThrow();
  });

  it('never serializes plaintext secrets', async () => {
    const cache = createCredentialCache();
    cache.entries[context.storageId] = await encryptStorageCredentials(credentials, context, cache.salt);
    const serialized = JSON.stringify(cache);
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).not.toContain('access-secret');
  });
});

describe('serial state writer', () => {
  it('builds state only when each queued write executes', async () => {
    let current = 'before-clear';
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const written: string[] = [];
    const write = vi.fn(async (state: string) => {
      written.push(state);
      if (written.length === 1) await firstWrite;
    });
    const persist = createSerialStateWriter(() => current, write);

    const older = persist();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    current = 'cleared';
    const newer = persist();
    releaseFirst();
    await Promise.all([older, newer]);

    expect(written).toEqual(['before-clear', 'cleared']);
  });
});

describe('credential cache lifecycle', () => {
  function populated(): CredentialCacheState {
    return {
      version: 1,
      salt: 'device-salt',
      entries: {
        one: { version: 1, iv: 'iv-one', ciphertext: 'cipher-one' },
        two: { version: 1, iv: 'iv-two', ciphertext: 'cipher-two' },
      },
    };
  }

  it.each([
    ['jwt changes', { jwt: 'old', userId: 'u' }, { jwt: 'new', userId: 'u' }],
    ['user changes', { jwt: 'jwt', userId: 'u1' }, { jwt: 'jwt', userId: 'u2' }],
    ['logout', { jwt: 'jwt', userId: 'u' }, { jwt: '', userId: null }],
  ])('clears every entry when %s', (_name, previous, next) => {
    const cache = populated();
    expect(reconcileCredentialCacheSession(cache, previous, next).entries).toEqual({});
  });

  it('keeps entries when the session is unchanged', () => {
    const cache = populated();
    expect(reconcileCredentialCacheSession(cache, { jwt: 'jwt', userId: 'u' }, { jwt: 'jwt', userId: 'u' })).toBe(cache);
  });

  it('clears all entries for 401 and only the current storage for 403', () => {
    expect(clearCredentialCacheForAuthFailure(populated(), 401, 'one').entries).toEqual({});
    expect(clearCredentialCacheForAuthFailure(populated(), 403, 'one').entries).toEqual({ two: { version: 1, iv: 'iv-two', ciphertext: 'cipher-two' } });
  });

  it('roundtrips the credential cache through plugin state and persists clearing', () => {
    const state = writeCredentialCacheToState({ reports: [] }, populated());
    expect(readCredentialCacheFromState(state)).toEqual(populated());
    const cleared = clearCredentialCacheForAuthFailure(readCredentialCacheFromState(state)!, 401, 'one');
    expect(readCredentialCacheFromState(writeCredentialCacheToState(state, cleared))?.entries).toEqual({});
  });
});

describe('storage credential parsing', () => {
  it.each([
    [{ ...credentials, config: { ...credentials.config, endpoint: 'http://s3.example.com' } }, 's3 config'],
    [{ ...credentials, config: { ...credentials.config, endpoint: 'https://user:pass@s3.example.com' } }, 's3 config'],
    [{ ...credentials, config: { ...credentials.config, endpoint: 'https://s3.example.com?secret=1' } }, 's3 config'],
    [{ ...credentials, config: { ...credentials.config, endpoint: 'https://127.0.0.1' } }, 's3 config'],
    [{ ...credentials, config: { ...credentials.config, endpoint: 'https://169.254.169.254' } }, 's3 config'],
    [{ storageId: context.storageId, type: 'webdav', config: { address: 'https://[::1]', username: 'u', password: 'p', authType: 'basic' } }, 'webdav config'],
    [{ storageId: context.storageId, type: 'webdav', config: { address: 'https://localhost/dav', username: 'u', password: 'p', authType: 'basic' } }, 'webdav config'],
    [{ storageId: context.storageId, type: 'onedrive', config: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 1, clientId: 'c', authority: 'https://login.microsoftonline.com.evil.test/common' } }, 'onedrive config'],
    [{ storageId: context.storageId, type: 'onedrive', config: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 1, clientId: 'c', authority: 'https://login.microsoftonline.com/common#token' } }, 'onedrive config'],
    [{ ...credentials, storageId: 'other' }, 'storageId'],
    [{ storageId: context.storageId, type: 'dropbox', config: {} }, 'type'],
    [{ storageId: context.storageId, type: 's3', config: { endpoint: 'https://s3.example.com' } }, 'config'],
    [{ storageId: context.storageId, type: 'webdav', config: { address: 'https://dav.example.com', username: 'u', password: 'p', authType: 'digest' } }, 'config'],
    [{ storageId: context.storageId, type: 'onedrive', config: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 'soon', clientId: 'c', authority: 'https://login.example.com' } }, 'config'],
  ])('rejects invalid response %#', (value, message) => {
    expect(() => parseStorageCredentialsResponse(value, context.storageId)).toThrow(message);
  });

  it('validates decrypted cache plaintext with the shared parser', async () => {
    const cache = createCredentialCache();
    const invalid = { ...credentials, storageId: 'other' };
    const encrypted = await encryptStorageCredentials(invalid, context, cache.salt);
    await expect(decryptStorageCredentials(encrypted, context, cache.salt)).rejects.toThrow('storageId');
  });
});

describe('refreshed credential persistence', () => {
  it('discards an old scope without writing the cache', async () => {
    const cache = createCredentialCache();
    const persist = vi.fn(async () => undefined);
    const captured = { jwt: 'jwt', userId: 'user', storageId: 'storage', client: {}, generation: 0 };
    const current = { ...captured, generation: 1 };

    const result = await persistRefreshedStorageCredentials(credentials, captured, () => current, cache, persist);

    expect(result).toBe(false);
    expect(cache.entries).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });

  it('updates the encrypted cache and propagates persistence failure without changing generation', async () => {
    const cache = createCredentialCache();
    const identity = { jwt: context.jwt, userId: context.userId, storageId: context.storageId, client: {}, generation: 3 };
    const persist = vi.fn(async () => { throw new Error('persist failed'); });

    await expect(persistRefreshedStorageCredentials(credentials, identity, () => identity, cache, persist)).rejects.toThrow('persist failed');

    await expect(decryptStorageCredentials(cache.entries[context.storageId], context, cache.salt)).resolves.toEqual(credentials);
    expect(identity.generation).toBe(3);
  });
});

describe('storage auth failure lifecycle', () => {
  const cache = (): CredentialCacheState => ({
    version: 1,
    salt: 'salt',
    entries: { current: {} as any, other: {} as any },
  });

  it.each([
    [403, ['other'], 'current'],
    [401, [], undefined],
  ] as const)('invalidates once for %s and awaits serialized persistence', async (status, remaining, invalidatedStorageId) => {
    let finishPersist!: () => void;
    const persist = vi.fn(() => new Promise<void>((resolve) => { finishPersist = resolve; }));
    const invalidate = vi.fn();
    let current = cache();
    let settled = false;
    const result = handleStorageAuthFailures(
      [{ cause: new StorageRequestError(status, `request failed (${status})`) }, { cause: new StorageRequestError(status, `request failed (${status})`) }],
      'current',
      current,
      (next) => { current = next; },
      invalidate,
      persist,
    ).then((handled) => { settled = true; return handled; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(invalidatedStorageId);
    expect(Object.keys(current.entries)).toEqual(remaining);
    finishPersist();
    await expect(result).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('ignores non-auth failures', async () => {
    const persist = vi.fn(async () => undefined);
    await expect(handleStorageAuthFailures(
      [{ cause: new StorageRequestError(500, 'server failed') }, { cause: new TypeError('network failed') }],
      'current', cache(), () => undefined, vi.fn(), persist,
    )).resolves.toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('credential request session guard', () => {
  it('rejects an old request after the credential generation changes', () => {
    const client = {};
    const captured = { jwt: 'jwt', userId: 'user', storageId: 'storage', client, generation: 0 };
    expect(isCredentialRequestCurrent(captured, { ...captured, generation: 1 })).toBe(false);
  });

  it('accepts only the same jwt, user, storage and client identity', () => {
    const client = {};
    const captured = { jwt: 'jwt', userId: 'user', storageId: 'storage', client, generation: 0 };
    expect(isCredentialRequestCurrent(captured, captured)).toBe(true);
    expect(isCredentialRequestCurrent(captured, { ...captured, jwt: 'new' })).toBe(false);
    expect(isCredentialRequestCurrent(captured, { ...captured, userId: 'new' })).toBe(false);
    expect(isCredentialRequestCurrent(captured, { ...captured, storageId: 'new' })).toBe(false);
    expect(isCredentialRequestCurrent(captured, { ...captured, client: {} })).toBe(false);
  });
});
