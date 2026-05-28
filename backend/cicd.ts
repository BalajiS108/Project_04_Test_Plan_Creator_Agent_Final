/**
 * CI/CD integration — proxies a small slice of the GitHub Actions REST API
 * so the UI can show run history, status, and trigger workflow_dispatch
 * without exposing the user's PAT to the browser.
 *
 * Config (owner, repo, token, workflow filename) lives in
 * `backend/cicd-config.json` — same pattern as `notifications-config.json`.
 * Token is never echoed back to the frontend; we report `tokenSet: boolean`
 * instead and re-use the stored value on subsequent calls.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'cicd-config.json');

const GH = 'https://api.github.com';

export interface CICDConfig {
    owner: string;
    repo: string;
    token: string;
    workflowFile: string;   // e.g. "e2e-tests.yml"
    defaultBranch: string;
}

const DEFAULT_CONFIG: CICDConfig = {
    owner: '',
    repo: '',
    token: '',
    workflowFile: 'e2e-tests.yml',
    defaultBranch: 'main',
};

export function loadConfig(): CICDConfig {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function saveConfig(incoming: Partial<CICDConfig>) {
    const existing = loadConfig();
    // Preserve the stored token if the frontend sent an empty/placeholder value.
    const merged: CICDConfig = {
        ...existing,
        ...incoming,
        token: (incoming.token && incoming.token !== '••••••••') ? incoming.token : existing.token,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

function ghHeaders(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

function assertConfigured(cfg: CICDConfig) {
    if (!cfg.owner || !cfg.repo || !cfg.token) {
        const missing: string[] = [];
        if (!cfg.owner) missing.push('owner');
        if (!cfg.repo) missing.push('repo');
        if (!cfg.token) missing.push('token');
        throw new Error(`CI/CD not configured — missing: ${missing.join(', ')}`);
    }
}

/** Test the credentials by hitting /user. Used by the "Test Connection" button. */
export async function testConnection(cfg: CICDConfig): Promise<{ ok: boolean; login?: string; error?: string }> {
    if (!cfg.token) return { ok: false, error: 'No token configured' };
    try {
        const res = await axios.get(`${GH}/user`, { headers: ghHeaders(cfg.token), timeout: 10000 });
        return { ok: true, login: res.data?.login };
    } catch (e: any) {
        return { ok: false, error: e.response?.data?.message || e.message };
    }
}

/**
 * Fetch the workflow row for the configured filename. Required to learn its
 * numeric id (needed by the dispatches endpoint).
 */
export async function getWorkflow(cfg: CICDConfig): Promise<any> {
    assertConfigured(cfg);
    const res = await axios.get(
        `${GH}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}`,
        { headers: ghHeaders(cfg.token), timeout: 12000 }
    );
    return res.data;
}

export interface RunSummary {
    id: number;
    name: string;
    displayTitle: string;
    status: string;            // queued | in_progress | completed
    conclusion: string | null; // success | failure | cancelled | skipped | null
    event: string;             // push | pull_request | schedule | workflow_dispatch
    branch: string;
    headSha: string;
    actor: string;
    actorAvatar: string;
    htmlUrl: string;
    createdAt: string;
    updatedAt: string;
    runStartedAt: string;
    durationMs: number | null;
}

/** Latest `limit` runs for the configured workflow. */
export async function listRecentRuns(cfg: CICDConfig, limit = 20): Promise<RunSummary[]> {
    assertConfigured(cfg);
    const res = await axios.get(
        `${GH}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/runs?per_page=${Math.min(limit, 100)}`,
        { headers: ghHeaders(cfg.token), timeout: 15000 }
    );
    const runs = (res.data?.workflow_runs || []) as any[];
    return runs.map((r) => {
        const start = r.run_started_at ? new Date(r.run_started_at).getTime() : null;
        const end = r.status === 'completed' && r.updated_at ? new Date(r.updated_at).getTime() : null;
        return {
            id: r.id,
            name: r.name || r.workflow_id,
            displayTitle: r.display_title || r.head_commit?.message?.split('\n')[0] || '',
            status: r.status,
            conclusion: r.conclusion,
            event: r.event,
            branch: r.head_branch,
            headSha: r.head_sha,
            actor: r.actor?.login || r.triggering_actor?.login || 'unknown',
            actorAvatar: r.actor?.avatar_url || '',
            htmlUrl: r.html_url,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            runStartedAt: r.run_started_at,
            durationMs: start && end ? end - start : null,
        };
    });
}

/**
 * Trigger a workflow_dispatch run. Returns immediately after GitHub accepts
 * the request (204) — the run shows up in /runs a few seconds later.
 */
export async function triggerWorkflow(cfg: CICDConfig, ref?: string, inputs?: Record<string, string>) {
    assertConfigured(cfg);
    const branch = ref || cfg.defaultBranch || 'main';
    await axios.post(
        `${GH}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/dispatches`,
        { ref: branch, inputs: inputs || {} },
        { headers: ghHeaders(cfg.token), timeout: 12000 }
    );
    return { triggeredAt: new Date().toISOString(), branch };
}

/** List workflow files in the repo — for the setup UI's "pick a workflow" step. */
export async function listWorkflows(cfg: CICDConfig): Promise<{ name: string; path: string; state: string }[]> {
    assertConfigured(cfg);
    const res = await axios.get(
        `${GH}/repos/${cfg.owner}/${cfg.repo}/actions/workflows`,
        { headers: ghHeaders(cfg.token), timeout: 12000 }
    );
    return (res.data?.workflows || []).map((w: any) => ({
        name: w.name,
        path: w.path,
        state: w.state,
    }));
}
