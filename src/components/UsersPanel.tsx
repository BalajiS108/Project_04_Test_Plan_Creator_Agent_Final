import React, { useEffect, useState } from 'react';
import { Users, UserPlus, Trash2, Loader2, ShieldCheck, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  fetchUsers, createUser, deleteUserByUsername,
  AuthUser, UserSummary,
} from '../services/authService';

interface UsersPanelProps {
  currentUser: AuthUser;
}

export const UsersPanel: React.FC<UsersPanelProps> = ({ currentUser }) => {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Create-form state
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [creating, setCreating] = useState(false);

  // Per-row delete state
  const [deletingFor, setDeletingFor] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchUsers();
      setUsers(list);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!newUsername.trim() || newPassword.length < 6) {
      setError('Username required and password must be at least 6 characters');
      return;
    }
    setCreating(true);
    try {
      await createUser(newUsername.trim(), newPassword, newRole);
      setSuccess(`User "${newUsername.trim()}" created.`);
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    setError(null);
    setSuccess(null);
    setDeletingFor(username);
    try {
      await deleteUserByUsername(username);
      setSuccess(`User "${username}" deleted.`);
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to delete user');
    } finally {
      setDeletingFor(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-xl">
          <Users size={18} className="text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">User accounts</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Create and remove accounts. Only admins see this tab.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-50"
          title="Refresh"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {/* Status banners */}
      {error && (
        <div className="px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-start gap-2 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="px-3 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-start gap-2 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300">
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate} className="bg-slate-50 dark:bg-slate-800/40 rounded-2xl p-4 space-y-3 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <UserPlus size={14} className="text-blue-600" />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Add a new user</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 dark:text-slate-400">Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              autoComplete="off"
              required
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 dark:text-slate-400">Password (min 6)</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={6}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 dark:text-slate-400">Role</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'admin' | 'user')}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
            >
              <option value="user">user (standard)</option>
              <option value="admin">admin (can manage users)</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={creating}
            className="mt-5 px-5 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {creating ? 'Creating...' : 'Create user'}
          </button>
        </div>
      </form>

      {/* User list */}
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2 px-1">
          Existing users {users ? `(${users.length})` : ''}
        </p>
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading && !users ? (
            <div className="p-8 text-center text-slate-400">
              <Loader2 size={18} className="animate-spin inline-block" />
            </div>
          ) : users && users.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">No users yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {(users || []).map((u) => {
                const isCurrent = u.username.toLowerCase() === currentUser.username.toLowerCase();
                return (
                  <li
                    key={u.username}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg">
                      {u.role === 'admin'
                        ? <ShieldCheck size={14} className="text-blue-600" />
                        : <Users size={14} className="text-slate-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{u.username}</p>
                        {isCurrent && (
                          <span className="text-[9px] font-black uppercase tracking-widest text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800">
                            you
                          </span>
                        )}
                        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                          u.role === 'admin'
                            ? 'text-amber-700 bg-amber-50 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                            : 'text-slate-700 bg-slate-50 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                        }`}>
                          {u.role}
                        </span>
                      </div>
                      {u.createdAt && (
                        <p className="text-[10px] text-slate-400 mt-0.5">Created {new Date(u.createdAt).toLocaleString()}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(u.username)}
                      disabled={isCurrent || deletingFor === u.username}
                      title={isCurrent ? "You can't delete your own account from here" : `Delete ${u.username}`}
                      className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed dark:hover:bg-red-900/20"
                    >
                      {deletingFor === u.username
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Trash2 size={14} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
