import axios from 'axios';
import { backendUrl } from './backendUrl';

export interface AuthStatus {
  enabled: boolean;
  anyUserExists: boolean;
}

export interface AuthUser {
  username: string;
  role: 'admin' | 'user';
}

export const TOKEN_KEY = 'tp_auth_token';
export const USER_KEY = 'tp_auth_user';

/**
 * Apply (or clear) the global Authorization header for axios. The frontend
 * services already use plain `axios.X` calls, so a default header is enough
 * — no need to refactor every service to use a custom client.
 */
export const applyAuthToken = (token: string | null) => {
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
};

/**
 * Auth header for raw `fetch()` calls. Axios picks up the default header set by
 * applyAuthToken automatically, but plain fetch (used in TestPlanView for the
 * execute/run/stop endpoints) does not — so it must attach the token itself.
 * Returns an empty object when no token is stored, which is harmless when auth
 * is disabled on the backend.
 */
export const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const fetchAuthStatus = async (): Promise<AuthStatus> => {
  const res = await axios.get(`${backendUrl()}/api/auth/status`, { timeout: 10000 });
  return res.data;
};

export const login = async (username: string, password: string): Promise<{ token: string; user: AuthUser }> => {
  const res = await axios.post(`${backendUrl()}/api/auth/login`, { username, password }, { timeout: 15000 });
  return res.data;
};

export const register = async (
  username: string,
  password: string,
  role?: 'admin' | 'user'
): Promise<{ user: AuthUser }> => {
  const res = await axios.post(`${backendUrl()}/api/auth/register`, { username, password, role }, { timeout: 15000 });
  return res.data;
};

export const restoreSession = (): { token: string; user: AuthUser } | null => {
  const token = localStorage.getItem(TOKEN_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  if (!token || !userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as AuthUser;
    applyAuthToken(token);
    return { token, user };
  } catch {
    return null;
  }
};

export const persistSession = (token: string, user: AuthUser) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  applyAuthToken(token);
};

export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  applyAuthToken(null);
};

// ── Admin: user management ────────────────────────────────────────────────
// These hit endpoints guarded by requireAdmin; the axios default Authorization
// header (set by applyAuthToken on login/restoreSession) attaches the admin's
// JWT automatically.
export interface UserSummary {
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export const fetchUsers = async (): Promise<UserSummary[]> => {
  const res = await axios.get(`${backendUrl()}/api/auth/users`, { timeout: 10000 });
  return res.data?.users || [];
};

export const createUser = async (
  username: string,
  password: string,
  role: 'admin' | 'user',
): Promise<{ user: AuthUser }> => {
  // Same endpoint as register but the admin JWT is attached automatically.
  const res = await axios.post(
    `${backendUrl()}/api/auth/register`,
    { username, password, role },
    { timeout: 15000 },
  );
  return res.data;
};

export const deleteUserByUsername = async (username: string): Promise<void> => {
  await axios.delete(`${backendUrl()}/api/auth/users/${encodeURIComponent(username)}`, { timeout: 10000 });
};
