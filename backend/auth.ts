/**
 * Lightweight, opt-in auth for the backend.
 *
 *  - `AUTH_ENABLED=true`  → all endpoints require a valid JWT
 *  - unset / `false`      → app works exactly as before (no behavior change)
 *
 * Users are stored in `backend/auth/users.json` (gitignored). Passwords are
 * bcrypt-hashed; sessions are stateless JWTs signed with `AUTH_JWT_SECRET`
 * (generated and persisted on first run if not provided in the env).
 *
 * First-time bootstrap: when AUTH_ENABLED is true and no users exist yet,
 * `/api/auth/register` is unguarded once so the first call creates an admin.
 * Every subsequent register call requires an existing admin.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.join(__dirname, 'auth');
const USERS_FILE = path.join(AUTH_DIR, 'users.json');
const SECRET_FILE = path.join(AUTH_DIR, 'jwt-secret');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

export interface StoredUser {
    username: string;
    passwordHash: string;
    role: 'admin' | 'user';
    createdAt: string;
}

interface UsersFile {
    users: StoredUser[];
}

function loadUsers(): UsersFile {
    if (!fs.existsSync(USERS_FILE)) return { users: [] };
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
    catch { return { users: [] }; }
}

function saveUsers(file: UsersFile) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(file, null, 2), 'utf8');
}

function getOrCreateSecret(): string {
    if (process.env.AUTH_JWT_SECRET) return process.env.AUTH_JWT_SECRET;
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret, 'utf8');
    return secret;
}

export const isAuthEnabled = (): boolean =>
    String(process.env.AUTH_ENABLED || '').toLowerCase() === 'true';

export interface AuthTokenPayload {
    sub: string;            // username
    role: 'admin' | 'user';
}

export function signToken(payload: AuthTokenPayload): string {
    return jwt.sign(payload, getOrCreateSecret(), { expiresIn: '8h' });
}

export function verifyToken(token: string): AuthTokenPayload | null {
    try {
        const decoded = jwt.verify(token, getOrCreateSecret()) as AuthTokenPayload;
        return decoded;
    } catch {
        return null;
    }
}

export async function registerUser(username: string, password: string, role: 'admin' | 'user' = 'user'): Promise<StoredUser> {
    const file = loadUsers();
    if (file.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error('Username already exists');
    }
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    const passwordHash = await bcrypt.hash(password, 10);
    const user: StoredUser = {
        username,
        passwordHash,
        role,
        createdAt: new Date().toISOString(),
    };
    file.users.push(user);
    saveUsers(file);
    return user;
}

export async function authenticateUser(username: string, password: string): Promise<StoredUser | null> {
    const file = loadUsers();
    const user = file.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    return ok ? user : null;
}

export function listUsers(): { username: string; role: string; createdAt: string }[] {
    return loadUsers().users.map(({ passwordHash: _ph, ...rest }) => rest);
}

export function hasAnyUser(): boolean {
    return loadUsers().users.length > 0;
}

// Augment the Express Request with an optional `auth` payload so route
// handlers can access the authenticated user without re-decoding.
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            auth?: AuthTokenPayload;
        }
    }
}

/**
 * Middleware that enforces a valid JWT when AUTH_ENABLED is true. Endpoints
 * listed in `OPEN_PATHS` are always public (health, login, status).
 */
const OPEN_PATHS = new Set<string>([
    '/api/health',
    '/api/auth/status',
    '/api/auth/login',
]);

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!isAuthEnabled()) return next();

    // First-time-setup carve-out: when no users exist yet, allow ONE unguarded
    // register call so the operator can create the admin account.
    if (req.path === '/api/auth/register' && !hasAnyUser()) return next();

    if (OPEN_PATHS.has(req.path)) return next();

    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
    req.auth = payload;
    next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!isAuthEnabled()) return next();
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    next();
}
