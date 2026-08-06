import type { OnedriveConfig } from '@synx/shared';
import { StorageRequestError } from './storageRequestError.js';

/**
 * OneDrive OAuth2 PKCE 工具。
 *
 * 设计参考 Remotely Save 的 fsOnedrive.ts：
 * - 使用 Microsoft identity platform v2.0
 * - PKCE (S256) 避免暴露 client secret
 * - Scopes: User.Read, Files.ReadWrite.AppFolder, offline_access
 * - App Folder: 每个应用有独立的隔离目录，不污染用户 OneDrive 根目录
 *
 * Workers 环境适配：
 * - 使用 Web Crypto API (crypto.subtle) 生成 PKCE
 * - 使用原生 fetch 调用 Microsoft token endpoint
 */

/** OneDrive OAuth2 所需的 scope（与 Remotely Save 一致） */
export const ONEDRIVE_SCOPES = ['User.Read', 'Files.ReadWrite.AppFolder', 'offline_access'];

/** 默认 authority（消费者账户） */
export const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com/consumers';

/** access token 提前刷新的缓冲时间（2 分钟） */
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

// ── PKCE 生成 ─────────────────────────────────────────

/**
 * 生成 PKCE code_verifier 和 code_challenge (S256)。
 * 使用 Web Crypto API，兼容 Cloudflare Workers。
 */
export async function generatePkceCodes(): Promise<{ verifier: string; challenge: string }> {
  // 生成 32 字节随机值作为 verifier 基础
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64UrlEncode(bytes);

  // SHA-256 哈希 verifier 得到 challenge
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}

/** Base64 URL 编码（无 padding） */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── 授权 URL 构建 ─────────────────────────────────────

/**
 * 构建 Microsoft OAuth2 授权 URL。
 * 参考 Remotely Save 的 getAuthUrlAndVerifier。
 */
export function buildAuthUrl(params: {
  clientId: string;
  authority: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(`${params.authority}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', ONEDRIVE_SCOPES.join(' '));
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('response_mode', 'query');
  return url.toString();
}

// ── Token 响应类型 ────────────────────────────────────

export interface TokenResponse {
  token_type: string;
  expires_in: number;
  scope: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export interface TokenError {
  error: string;
  error_description: string;
  error_codes: number[];
}

// ── Token 交换 ────────────────────────────────────────

/**
 * 用授权码交换 access token。
 * 参考 Remotely Save 的 sendAuthReq。
 */
export async function exchangeCodeForToken(params: {
  clientId: string;
  authority: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    tenant: 'consumers',
    client_id: params.clientId,
    scope: ONEDRIVE_SCOPES.join(' '),
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.verifier,
  });

  const res = await fetch(`${params.authority}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json() as TokenResponse | TokenError;
  if (!res.ok || 'error' in json) {
    throw new StorageRequestError(res.status, `onedrive token exchange failed (${res.status})`);
  }
  return json as TokenResponse;
}

/**
 * 用 refresh token 获取新的 access token。
 * 参考 Remotely Save 的 sendRefreshTokenReq。
 */
export async function refreshAccessToken(params: {
  clientId: string;
  authority: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    tenant: 'consumers',
    client_id: params.clientId,
    scope: ONEDRIVE_SCOPES.join(' '),
    refresh_token: params.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${params.authority}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json() as TokenResponse | TokenError;
  if (!res.ok || 'error' in json) {
    throw new StorageRequestError(res.status, `onedrive token refresh failed (${res.status})`);
  }
  return json as TokenResponse;
}

// ── Token 有效性检查与刷新 ─────────────────────────────

/**
 * 检查 access token 是否即将过期（提前 2 分钟刷新）。
 */
export function isTokenExpired(config: OnedriveConfig): boolean {
  return Date.now() + REFRESH_BUFFER_MS >= config.accessTokenExpiresAt;
}

/**
 * 如果 access token 过期，用 refresh token 获取新 token，返回更新后的 config。
 * 如果 token 仍然有效，原样返回。
 */
export async function ensureFreshToken(config: OnedriveConfig): Promise<OnedriveConfig> {
  if (!isTokenExpired(config)) return config;

  const tokenResponse = await refreshAccessToken({
    clientId: config.clientId,
    authority: config.authority,
    refreshToken: config.refreshToken,
  });

  return {
    ...config,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || config.refreshToken,
    accessTokenExpiresAt: Date.now() + tokenResponse.expires_in * 1000 - REFRESH_BUFFER_MS,
  };
}

/**
 * 从 token response 构建 OnedriveConfig。
 */
export function configFromTokenResponse(
  clientId: string,
  authority: string,
  tokenResponse: TokenResponse,
  remoteBaseDir?: string,
): OnedriveConfig {
  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token!,
    accessTokenExpiresAt: Date.now() + tokenResponse.expires_in * 1000 - REFRESH_BUFFER_MS,
    clientId,
    authority,
    remoteBaseDir,
  };
}
