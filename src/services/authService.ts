import axios from 'axios';

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

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
