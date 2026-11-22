import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';
import { neonSignOut } from './neonAuth';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (input: { email: string; password: string; totp?: string }) => Promise<void>;
  register: (input: { name: string; orgName: string; email: string; password: string }) => Promise<void>;
  /** Troca um JWT do Neon Auth por uma sessão HttpOnly do painel. */
  loginWithNeon: (token: string, totp?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthValue>(
    () => ({
      me,
      loading,
      refresh,
      login: async (input) => {
        await api('/auth/login', { method: 'POST', body: input });
        await refresh();
      },
      register: async (input) => {
        await api('/auth/register', { method: 'POST', body: input });
        await refresh();
      },
      loginWithNeon: async (token, totp) => {
        await api('/auth/neon/session', { method: 'POST', body: { totp }, headers: { authorization: `Bearer ${token}` } });
        await refresh();
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' });
        void neonSignOut();
        setMe(null);
      },
    }),
    [me, loading, refresh],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('AuthProvider ausente');
  return v;
}
