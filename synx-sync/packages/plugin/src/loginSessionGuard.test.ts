import { describe, expect, it, vi } from 'vitest';
import { FifoSerializer } from './fifoSerializer.js';
import { loginSessionFromRepositoryScope, runForLoginSession, type LoginSessionSnapshot } from './loginSessionGuard.js';

const oldSession: LoginSessionSnapshot = {
  serverUrl: 'https://old.example.com',
  jwt: 'old-jwt',
  userId: 'old-user',
};
const newSession: LoginSessionSnapshot = {
  serverUrl: 'https://new.example.com',
  jwt: 'new-jwt',
  userId: 'new-user',
};

describe('login session guarded auth handling', () => {
  it('builds the captured login session from the repository request scope', () => {
    expect(loginSessionFromRepositoryScope({
      serverUrl: oldSession.serverUrl,
      userId: oldSession.userId!,
      jwt: oldSession.jwt,
      storageId: 'storage-1',
      syncFolder: 'Vault',
      credentialGeneration: 0,
    })).toEqual(oldSession);
  });

  it('ignores an old client 401 after the user changes account', async () => {
    let current = newSession;
    const clearSession = vi.fn(async () => undefined);
    const notice = vi.fn();

    const handled = await runForLoginSession(oldSession, () => current, async () => {
      await clearSession();
      notice();
    });

    expect(handled).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('clears and notifies for a 401 from the current session', async () => {
    let current = oldSession;
    const clearSession = vi.fn(async () => { current = { ...current, jwt: '', userId: null }; });
    const notice = vi.fn();

    const handled = await runForLoginSession(oldSession, () => current, async () => {
      await clearSession();
      notice();
    });

    expect(handled).toBe(true);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('does not clear when the account changes before queued cleanup starts', async () => {
    const serializer = new FifoSerializer();
    let release!: () => void;
    const blocker = serializer.run(() => new Promise<void>((resolve) => { release = resolve; }));
    let current = oldSession;
    const clearSession = vi.fn(async () => undefined);
    const cleanup = serializer.run(() => runForLoginSession(oldSession, () => current, clearSession));

    await Promise.resolve();
    current = newSession;
    release();
    await blocker;

    await expect(cleanup).resolves.toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('does not clear the new credential cache for an old client 401', async () => {
    let current = newSession;
    const clearCredentialCache = vi.fn(async () => undefined);

    const handled = await runForLoginSession(oldSession, () => current, clearCredentialCache);

    expect(handled).toBe(false);
    expect(clearCredentialCache).not.toHaveBeenCalled();
  });
});
