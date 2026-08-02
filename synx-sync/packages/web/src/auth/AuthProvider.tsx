import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, User } from '@synx/shared';
import { clearSession, getSession, setSession } from '../api/client';

type AuthContextValue = { user: User | null; authenticate: (data: AuthResponse) => void; logout: () => void };
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState(() => getSession()?.user ?? null);
  const value = useMemo(() => ({
    user,
    authenticate(data: AuthResponse) { setSession(data); setUser(data.user); },
    logout() { clearSession(); setUser(null); },
  }), [user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
