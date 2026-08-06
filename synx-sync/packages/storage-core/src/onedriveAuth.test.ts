import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generatePkceCodes,
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  isTokenExpired,
  ensureFreshToken,
  configFromTokenResponse,
  ONEDRIVE_SCOPES,
  DEFAULT_AUTHORITY,
} from './onedriveAuth.js';
import { StorageRequestError } from './storageRequestError.js';
import type { OnedriveConfig } from '@synx/shared';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('ONEDRIVE_SCOPES', () => {
  it('includes User.Read, Files.ReadWrite.AppFolder, offline_access', () => {
    expect(ONEDRIVE_SCOPES).toContain('User.Read');
    expect(ONEDRIVE_SCOPES).toContain('Files.ReadWrite.AppFolder');
    expect(ONEDRIVE_SCOPES).toContain('offline_access');
  });
});

describe('DEFAULT_AUTHORITY', () => {
  it('points to consumers endpoint', () => {
    expect(DEFAULT_AUTHORITY).toBe('https://login.microsoftonline.com/consumers');
  });
});

describe('generatePkceCodes', () => {
  it('returns verifier and challenge strings', async () => {
    const { verifier, challenge } = await generatePkceCodes();
    expect(verifier).toBeTruthy();
    expect(challenge).toBeTruthy();
    expect(verifier).not.toBe(challenge);
  });

  it('generates unique codes each call', async () => {
    const first = await generatePkceCodes();
    const second = await generatePkceCodes();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });

  it('verifier is base64url encoded (no +, /, =)', async () => {
    const { verifier } = await generatePkceCodes();
    expect(verifier).not.toMatch(/[+/=]/);
  });
});

describe('buildAuthUrl', () => {
  it('builds correct authorize URL with all params', () => {
    const url = buildAuthUrl({
      clientId: 'my-client-id',
      authority: 'https://login.microsoftonline.com/consumers',
      redirectUri: 'https://worker.example.com/api/onedrive/callback',
      challenge: 'test-challenge',
      state: 'test-state',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://login.microsoftonline.com');
    expect(parsed.pathname).toBe('/consumers/oauth2/v2.0/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('my-client-id');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://worker.example.com/api/onedrive/callback');
    expect(parsed.searchParams.get('scope')).toBe(ONEDRIVE_SCOPES.join(' '));
    expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe('test-state');
    expect(parsed.searchParams.get('response_mode')).toBe('query');
  });
});

describe('exchangeCodeForToken', () => {
  it('posts correct body and returns token response', async () => {
    const tokenResponse = {
      token_type: 'Bearer',
      expires_in: 3600,
      scope: ONEDRIVE_SCOPES.join(' '),
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => tokenResponse,
    } as unknown as Response);

    const result = await exchangeCodeForToken({
      clientId: 'my-client-id',
      authority: 'https://login.microsoftonline.com/consumers',
      code: 'auth-code',
      redirectUri: 'https://worker.example.com/api/onedrive/callback',
      verifier: 'pkce-verifier',
    });

    expect(result.access_token).toBe('new-access-token');
    expect(result.refresh_token).toBe('new-refresh-token');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('my-client-id');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe('https://worker.example.com/api/onedrive/callback');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('preserves status and hides token endpoint details on error response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'invalid authorization code bad-code',
        error_codes: [500],
      }),
    } as unknown as Response);

    const error = await exchangeCodeForToken({
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
      code: 'bad-code',
      redirectUri: 'https://example.com/callback',
      verifier: 'verifier',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('bad-code');
  });
});

describe('refreshAccessToken', () => {
  it('posts refresh_token grant and returns new tokens', async () => {
    const tokenResponse = {
      token_type: 'Bearer',
      expires_in: 3600,
      scope: ONEDRIVE_SCOPES.join(' '),
      access_token: 'refreshed-access-token',
      refresh_token: 'refreshed-refresh-token',
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => tokenResponse,
    } as unknown as Response);

    const result = await refreshAccessToken({
      clientId: 'my-client-id',
      authority: 'https://login.microsoftonline.com/consumers',
      refreshToken: 'old-refresh-token',
    });

    expect(result.access_token).toBe('refreshed-access-token');
    expect(result.refresh_token).toBe('refreshed-refresh-token');

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh-token');
  });

  it('throws on error response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'refresh token expired',
        error_codes: [500],
      }),
    } as unknown as Response);

    const error = await refreshAccessToken({
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
      refreshToken: 'expired-token',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('expired-token');
    expect(error.message).not.toContain('refresh token expired');
  });
});

describe('isTokenExpired', () => {
  it('returns true when token is expired', () => {
    const config: OnedriveConfig = {
      accessToken: 'tok',
      refreshToken: 'refresh',
      accessTokenExpiresAt: Date.now() - 1000, // expired 1 second ago
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
    };
    expect(isTokenExpired(config)).toBe(true);
  });

  it('returns true when token expires within 2 minutes', () => {
    const config: OnedriveConfig = {
      accessToken: 'tok',
      refreshToken: 'refresh',
      accessTokenExpiresAt: Date.now() + 60_000, // expires in 1 minute
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
    };
    expect(isTokenExpired(config)).toBe(true);
  });

  it('returns false when token is still valid', () => {
    const config: OnedriveConfig = {
      accessToken: 'tok',
      refreshToken: 'refresh',
      accessTokenExpiresAt: Date.now() + 3600_000, // 1 hour from now
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
    };
    expect(isTokenExpired(config)).toBe(false);
  });
});

describe('ensureFreshToken', () => {
  it('returns original config when token is still valid', async () => {
    const config: OnedriveConfig = {
      accessToken: 'tok',
      refreshToken: 'refresh',
      accessTokenExpiresAt: Date.now() + 3600_000,
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
    };
    const result = await ensureFreshToken(config);
    expect(result).toBe(config);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes token when expired', async () => {
    const config: OnedriveConfig = {
      accessToken: 'old-tok',
      refreshToken: 'old-refresh',
      accessTokenExpiresAt: Date.now() - 1000,
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token_type: 'Bearer',
        expires_in: 3600,
        scope: ONEDRIVE_SCOPES.join(' '),
        access_token: 'new-tok',
        refresh_token: 'new-refresh',
      }),
    } as unknown as Response);

    const result = await ensureFreshToken(config);
    expect(result.accessToken).toBe('new-tok');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('preserves old refresh token when response omits it', async () => {
    const config: OnedriveConfig = {
      accessToken: 'old-tok',
      refreshToken: 'old-refresh',
      accessTokenExpiresAt: Date.now() - 1000,
      clientId: 'cid',
      authority: 'https://login.microsoftonline.com/consumers',
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token_type: 'Bearer',
        expires_in: 3600,
        scope: ONEDRIVE_SCOPES.join(' '),
        access_token: 'new-tok',
      }),
    } as unknown as Response);

    const result = await ensureFreshToken(config);
    expect(result.accessToken).toBe('new-tok');
    expect(result.refreshToken).toBe('old-refresh');
  });
});

describe('configFromTokenResponse', () => {
  it('builds config from token response', () => {
    const tokenResponse = {
      token_type: 'Bearer',
      expires_in: 3600,
      scope: ONEDRIVE_SCOPES.join(' '),
      access_token: 'access-tok',
      refresh_token: 'refresh-tok',
    };

    const config = configFromTokenResponse(
      'my-client-id',
      'https://login.microsoftonline.com/consumers',
      tokenResponse,
      'my-vault',
    );

    expect(config.accessToken).toBe('access-tok');
    expect(config.refreshToken).toBe('refresh-tok');
    expect(config.clientId).toBe('my-client-id');
    expect(config.authority).toBe('https://login.microsoftonline.com/consumers');
    expect(config.remoteBaseDir).toBe('my-vault');
    expect(config.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('handles undefined remoteBaseDir', () => {
    const tokenResponse = {
      token_type: 'Bearer',
      expires_in: 3600,
      scope: ONEDRIVE_SCOPES.join(' '),
      access_token: 'access-tok',
      refresh_token: 'refresh-tok',
    };

    const config = configFromTokenResponse(
      'my-client-id',
      'https://login.microsoftonline.com/consumers',
      tokenResponse,
    );

    expect(config.remoteBaseDir).toBeUndefined();
  });
});
