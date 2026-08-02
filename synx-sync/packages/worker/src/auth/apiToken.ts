const PREFIX = 'synx_pat_';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${PREFIX}${base64Url(bytes)}`;
}

export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function apiTokenPrefix(token: string): string {
  return token.slice(0, PREFIX.length + 8);
}
