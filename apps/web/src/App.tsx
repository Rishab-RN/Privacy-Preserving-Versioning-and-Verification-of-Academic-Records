import { useState, useEffect } from 'react';
import type { SessionResponse, UserPrincipal } from '@scholarproof/contracts';
import type { Session } from './types.js';
import { request, RequestFailure } from './api.js';
import { Workspace } from './Workspace.js';
import { Login } from './pages/Login.js';
export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        setSession((current) => (current?.token === session?.token ? null : current));
        setNotice('Your session expired. Sign in again to continue.');
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  async function login(subject: string, password: string) {
    const auth = await request<SessionResponse>('/auth/login', undefined, { subject, password });
    try {
      const principal = await request<UserPrincipal>('/auth/me', auth.token);
      setNotice('');
      setSession({ ...auth, principal });
    } catch (error) {
      await request('/auth/logout', auth.token, {}).catch(() => undefined);
      throw error;
    }
  }
  async function api<T>(path: string, body?: unknown, key?: string): Promise<T> {
    try {
      return await request<T>(path, session?.token, body, key);
    } catch (error) {
      if (error instanceof RequestFailure && error.status === 401) {
        setSession((current) => (current?.token === session?.token ? null : current));
        setNotice('Your session is no longer valid. Sign in again.');
      }
      throw error;
    }
  }
  async function logout() {
    try {
      await api('/auth/logout', {});
      setNotice('');
    } catch {
      setNotice(
        'Signed out on this device. Server-side session revocation could not be confirmed.',
      );
    } finally {
      setSession(null);
    }
  }
  return session ? (
    <Workspace key={session.token} session={session} api={api} logout={logout} />
  ) : (
    <Login login={login} notice={notice} />
  );
}
