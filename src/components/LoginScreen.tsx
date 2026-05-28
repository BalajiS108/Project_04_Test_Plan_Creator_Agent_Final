import React, { useState } from 'react';
import { Lock, User, LogIn, UserPlus, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { login, register, persistSession, AuthUser } from '../services/authService';

interface LoginScreenProps {
  // True when the backend reports no users exist — the first registration
  // becomes the admin (no existing admin needed to create it).
  bootstrapMode: boolean;
  onAuthenticated: (user: AuthUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ bootstrapMode, onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>(bootstrapMode ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'register') {
      if (password !== confirm) {
        setError('Passwords do not match');
        return;
      }
      if (password.length < 6) {
        setError('Password must be at least 6 characters');
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === 'register') {
        await register(username, password, bootstrapMode ? 'admin' : undefined);
        // Auto-login right after register so the first-run bootstrap is one step
        const { token, user } = await login(username, password);
        persistSession(token, user);
        onAuthenticated(user);
      } else {
        const { token, user } = await login(username, password);
        persistSession(token, user);
        onAuthenticated(user);
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-blue-50 to-slate-100 p-6 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 p-10 dark:bg-slate-900 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-gradient-to-br from-blue-500 to-blue-700 p-3 rounded-2xl text-white shadow-lg shadow-blue-300/30">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-800 dark:text-slate-100 leading-tight">
              {bootstrapMode ? 'Create the first admin' : mode === 'register' ? 'Create account' : 'Sign in'}
            </h1>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">
              Intelligent Test Planning Agent
            </p>
          </div>
        </div>

        {bootstrapMode && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-blue-50 border border-blue-100 text-blue-700 text-xs dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300">
            No users exist yet. This account will be the administrator.
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">Username</label>
            <div className="relative">
              <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">Password</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              />
            </div>
          </div>

          {mode === 'register' && (
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 dark:text-slate-400">Confirm Password</label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-start gap-2 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60"
          >
            {loading
              ? <Loader2 size={16} className="animate-spin" />
              : mode === 'register' ? <UserPlus size={16} /> : <LogIn size={16} />}
            {mode === 'register' ? (bootstrapMode ? 'Create Admin Account' : 'Create Account') : 'Sign In'}
          </button>
        </form>

        {!bootstrapMode && (
          <button
            onClick={() => { setMode((m) => (m === 'login' ? 'register' : 'login')); setError(null); }}
            className="w-full text-center text-xs text-slate-400 hover:text-blue-600 mt-4"
          >
            {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
          </button>
        )}
      </div>
    </div>
  );
};
