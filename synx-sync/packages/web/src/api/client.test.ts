import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, clearSession, getSession, setSession } from './client';

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('session', () => {
  it('stores and restores an authenticated session', () => {
    setSession({ token: 'token', user: { id: 'u1', username: 'alice', email: 'a@example.com', createdAt: 1, updatedAt: 1 } });
    expect(getSession()).toMatchObject({ token: 'token', user: { username: 'alice' } });
    clearSession();
    expect(getSession()).toBeNull();
  });
});

describe('api', () => {
  it('adds the bearer token and parses JSON', async () => {
    setSession({ token: 'token', user: { id: 'u1', username: 'alice', email: 'a@example.com', createdAt: 1, updatedAt: 1 } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/test')).resolves.toEqual({ ok: true });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token');
  });

  it('throws a typed error for failed requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })));
    await expect(api('/api/test')).rejects.toMatchObject({ status: 400, message: 'bad request' });
  });
});
