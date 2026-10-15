import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, apiRequest, clearSession, saveSession, type MeResponse, type SessionResponse } from '@/lib/api';

type AuthContextValue = {
  me: MeResponse | null;
  loading: boolean;
  working: boolean;
  offline: boolean;
  signIn: (input: { institutionSlug: string; email: string; password: string }) => Promise<void>;
  acceptInvitation: (input: { institutionSlug: string; email: string; invitationToken: string; displayName: string; password: string; department?: string; programme?: string; batchYear?: number }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [offline, setOffline] = useState(false);

  const refreshMe = useCallback(async () => {
    const result = await apiRequest<MeResponse>('/me');
    setMe(result);
    setOffline(false);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const meResult = await apiRequest<MeResponse>('/me');
        if (active) { setMe(meResult); setOffline(false); }
      } catch (error) {
        if (active) {
          if (error instanceof ApiError && error.status === 0) setOffline(true);
          else setMe(null);
        }
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const signIn = useCallback(async (input: { institutionSlug: string; email: string; password: string }) => {
    setWorking(true);
    try {
      const session = await apiRequest<SessionResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
      await saveSession(session);
      await refreshMe();
    } finally { setWorking(false); }
  }, [refreshMe]);

  const acceptInvitation = useCallback(async (input: { institutionSlug: string; email: string; invitationToken: string; displayName: string; password: string; department?: string; programme?: string; batchYear?: number }) => {
    setWorking(true);
    try {
      const session = await apiRequest<SessionResponse>('/auth/invitations/accept', { method: 'POST', body: JSON.stringify(input) });
      await saveSession(session);
      await refreshMe();
    } finally { setWorking(false); }
  }, [refreshMe]);

  const signOut = useCallback(async () => {
    setWorking(true);
    try { await apiRequest('/auth/logout', { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined); }
    finally { await clearSession(); setMe(null); setOffline(false); setWorking(false); }
  }, []);

  const value = useMemo(() => ({ me, loading, working, offline, signIn, acceptInvitation, signOut, refreshMe }), [me, loading, working, offline, signIn, acceptInvitation, signOut, refreshMe]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
