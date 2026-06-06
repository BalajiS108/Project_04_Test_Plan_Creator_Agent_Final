/**
 * Central resolver for the backend's base URL.
 *
 * Priority order:
 *   1. VITE_BACKEND_URL build-time env (production: Vercel frontend pointing
 *      at a Render-hosted backend, e.g. https://my-backend.onrender.com)
 *   2. localhost:3001 with the current page's hostname (local dev: same host
 *      for both frontend and backend, e.g. http://localhost:3001)
 *
 * To set in production: in Vercel project settings, add an env var
 * named VITE_BACKEND_URL set to your Render backend's URL. Re-deploy.
 *
 * The trailing slash is always stripped so callers can do
 * `${backendUrl()}/api/foo` without worrying about double slashes.
 */
export const backendUrl = (): string => {
    const envUrl = import.meta.env.VITE_BACKEND_URL as string | undefined;
    if (envUrl && envUrl.trim()) {
        return envUrl.trim().replace(/\/$/, '');
    }
    const host = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
    return `http://${host}:3001`;
};
