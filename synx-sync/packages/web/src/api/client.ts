import type { AuthResponse, User } from '@synx/shared';

const TOKEN_KEY = 'synx-token';
const USER_KEY = 'synx-user';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getSession(): { token: string; user: User } | null {
  const token = window.localStorage.getItem(TOKEN_KEY);
  const rawUser = window.localStorage.getItem(USER_KEY);
  if (!token || !rawUser) return null;
  try {
    return { token, user: JSON.parse(rawUser) as User };
  } catch {
    clearSession();
    return null;
  }
}

export function setSession(session: AuthResponse): void {
  window.localStorage.setItem(TOKEN_KEY, session.token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = window.localStorage.getItem(TOKEN_KEY);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (response.status === 401 && token) clearSession();
  if (!response.ok) throw new ApiError(response.status, data.error || `请求失败 (${response.status})`, data.code);
  return data as T;
}
