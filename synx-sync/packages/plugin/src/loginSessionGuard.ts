import type { DirectRepositoryScope } from './directRepositoryResolver.js';

export interface LoginSessionSnapshot {
  serverUrl: string;
  jwt: string;
  userId: string | null;
}

export function loginSessionFromRepositoryScope(scope: DirectRepositoryScope): LoginSessionSnapshot {
  return { serverUrl: scope.serverUrl, jwt: scope.jwt, userId: scope.userId };
}

export function isLoginSessionCurrent(
  captured: LoginSessionSnapshot,
  current: LoginSessionSnapshot,
): boolean {
  return captured.serverUrl === current.serverUrl
    && captured.jwt === current.jwt
    && captured.userId === current.userId;
}

export async function runForLoginSession<T>(
  captured: LoginSessionSnapshot,
  getCurrent: () => LoginSessionSnapshot,
  operation: () => Promise<T>,
): Promise<boolean> {
  if (!isLoginSessionCurrent(captured, getCurrent())) return false;
  await operation();
  return true;
}
