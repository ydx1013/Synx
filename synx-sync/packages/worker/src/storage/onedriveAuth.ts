export {
  DEFAULT_AUTHORITY,
  ONEDRIVE_SCOPES,
  buildAuthUrl,
  configFromTokenResponse,
  ensureFreshToken,
  exchangeCodeForToken,
  generatePkceCodes,
  isTokenExpired,
  refreshAccessToken,
} from '@synx/storage-core';
export type { TokenError, TokenResponse } from '@synx/storage-core';
