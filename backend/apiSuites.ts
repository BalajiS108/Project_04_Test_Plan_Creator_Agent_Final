/**
 * API Test Suite store.
 *
 * Each suite is a single JSON file in `backend/api-suites/` containing:
 *  - the test list (with extractions)
 *  - environment variables (keyed by env name)
 *  - the active environment name
 *
 * Same file-based pattern as `history.ts` — keeps deps light and lets users
 * inspect/edit suites directly on disk.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ApiTest } from './apiTesting.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUITES_DIR = path.join(__dirname, 'api-suites');

if (!fs.existsSync(SUITES_DIR)) fs.mkdirSync(SUITES_DIR, { recursive: true });

export interface ApiSuite {
    name: string;
    description?: string;
    tests: ApiTest[];
    environments: Record<string, Record<string, string>>;   // envName -> vars
    activeEnvironment?: string;
    updatedAt: string;
}

function safePath(name: string): string {
    // Suite names should be human-friendly; we still sanitize on disk
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error('Invalid suite name');
    return path.join(SUITES_DIR, `${slug}.json`);
}

export function listSuites(): { name: string; description?: string; testCount: number; updatedAt: string }[] {
    if (!fs.existsSync(SUITES_DIR)) return [];
    const files = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith('.json'));
    const out: { name: string; description?: string; testCount: number; updatedAt: string }[] = [];
    for (const f of files) {
        try {
            const raw = fs.readFileSync(path.join(SUITES_DIR, f), 'utf8');
            const parsed = JSON.parse(raw) as ApiSuite;
            out.push({
                name: parsed.name,
                description: parsed.description,
                testCount: Array.isArray(parsed.tests) ? parsed.tests.length : 0,
                updatedAt: parsed.updatedAt,
            });
        } catch { /* skip corrupt */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSuite(name: string): ApiSuite | null {
    const file = safePath(name);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

export function saveSuite(suite: ApiSuite): ApiSuite {
    if (!suite.name) throw new Error('Suite name required');
    const toSave: ApiSuite = {
        ...suite,
        environments: suite.environments || {},
        tests: Array.isArray(suite.tests) ? suite.tests : [],
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(safePath(suite.name), JSON.stringify(toSave, null, 2), 'utf8');
    return toSave;
}

export function deleteSuite(name: string): boolean {
    const file = safePath(name);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}
