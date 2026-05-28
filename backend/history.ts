/**
 * Run history store.
 *
 * Each execution is persisted as a single JSON file in `backend/history/`.
 * File-based intentionally — zero native deps (avoids better-sqlite3 build
 * issues on Windows) and trivially inspectable. For 100s–1000s of runs this
 * is plenty; if a user ever crosses ~10k runs, migrating to SQLite is a
 * surface-level change because the public functions return plain objects.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { ExecutionReport } from './agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_DIR = path.join(__dirname, 'history');

if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

export interface RunMeta {
    id: string;
    executedAt: string;
    productName: string;
    mode: 'AI Agent' | 'Playwright Script';
    source?: string;          // 'jira' | 'brd' | 'html' | 'figma' | 'unknown'
    total: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    duration: number;
    passRate: number;
}

export interface StoredRun extends RunMeta {
    results: any[];           // Full per-test case detail
}

function shortId() {
    return crypto.randomBytes(4).toString('hex');
}

function safeFilename(id: string) {
    // Reject anything that could escape the history dir
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid run id');
    return path.join(HISTORY_DIR, `${id}.json`);
}

export function saveRun(
    report: ExecutionReport,
    extra: { productName?: string; mode: 'AI Agent' | 'Playwright Script'; source?: string }
): RunMeta {
    const id = `${Date.now()}-${shortId()}`;
    const total = report.summary.total || 0;
    const meta: RunMeta = {
        id,
        executedAt: report.summary.executedAt || new Date().toISOString(),
        productName: extra.productName || 'Untitled',
        mode: extra.mode,
        source: extra.source,
        total,
        passed: report.summary.passed || 0,
        failed: report.summary.failed || 0,
        errors: report.summary.errors || 0,
        skipped: report.summary.skipped || 0,
        duration: report.summary.duration || 0,
        passRate: total > 0 ? Math.round(((report.summary.passed || 0) / total) * 100) : 0,
    };
    const stored: StoredRun = { ...meta, results: report.results || [] };
    fs.writeFileSync(safeFilename(id), JSON.stringify(stored, null, 2), 'utf8');
    return meta;
}

export function listRuns(limit = 100): RunMeta[] {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json'));
    const runs: RunMeta[] = [];
    for (const f of files) {
        try {
            const raw = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8');
            const parsed = JSON.parse(raw) as StoredRun;
            // Drop the heavy `results` array — list view doesn't need it
            const { results: _r, ...meta } = parsed;
            runs.push(meta);
        } catch {
            // Skip corrupted files instead of failing the list
        }
    }
    runs.sort((a, b) => b.executedAt.localeCompare(a.executedAt));
    return runs.slice(0, limit);
}

export function getRun(id: string): StoredRun | null {
    const file = safeFilename(id);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

export function deleteRun(id: string): boolean {
    const file = safeFilename(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}

export interface HistoryStats {
    totalRuns: number;
    averagePassRate: number;
    runs7d: number;
    runs30d: number;
    trend: { date: string; passRate: number; total: number }[];   // last 30 days
    flakiest: { name: string; runs: number; passes: number; fails: number; flakiness: number }[];
    slowest: { name: string; avgDuration: number; runs: number }[];
}

export function computeStats(): HistoryStats {
    const allRuns = listRuns(10000);
    if (allRuns.length === 0) {
        return {
            totalRuns: 0,
            averagePassRate: 0,
            runs7d: 0,
            runs30d: 0,
            trend: [],
            flakiest: [],
            slowest: [],
        };
    }

    const now = Date.now();
    const sevenD = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyD = now - 30 * 24 * 60 * 60 * 1000;

    const runs7d = allRuns.filter((r) => new Date(r.executedAt).getTime() >= sevenD).length;
    const runs30d = allRuns.filter((r) => new Date(r.executedAt).getTime() >= thirtyD).length;

    const avgPassRate = Math.round(
        allRuns.reduce((sum, r) => sum + r.passRate, 0) / allRuns.length
    );

    // Trend: daily pass rate over the last 30 days
    const byDay = new Map<string, { totalPass: number; totalTotal: number; count: number }>();
    for (const r of allRuns) {
        const t = new Date(r.executedAt).getTime();
        if (t < thirtyD) continue;
        const day = new Date(r.executedAt).toISOString().slice(0, 10);
        const entry = byDay.get(day) || { totalPass: 0, totalTotal: 0, count: 0 };
        entry.totalPass += r.passed;
        entry.totalTotal += r.total;
        entry.count += 1;
        byDay.set(day, entry);
    }
    const trend = Array.from(byDay.entries())
        .map(([date, agg]) => ({
            date,
            passRate: agg.totalTotal > 0 ? Math.round((agg.totalPass / agg.totalTotal) * 100) : 0,
            total: agg.count,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

    // Flakiest: tests that have both passed AND failed across runs.
    // We need the full results for each run; load them lazily.
    const testStats = new Map<string, { passes: number; fails: number; runs: number; totalDuration: number }>();
    // Limit history scan for stats to the most recent 500 runs to bound work
    for (const meta of allRuns.slice(0, 500)) {
        const stored = getRun(meta.id);
        if (!stored?.results) continue;
        for (const r of stored.results) {
            const name = String(r.name || `TC-${r.id || '?'}`).replace(/^TC-\d+[:\s]*/i, '').trim();
            if (!name) continue;
            const entry = testStats.get(name) || { passes: 0, fails: 0, runs: 0, totalDuration: 0 };
            entry.runs += 1;
            entry.totalDuration += (r.duration || 0);
            if (r.status === 'PASS') entry.passes += 1;
            else if (r.status === 'FAIL' || r.status === 'ERROR') entry.fails += 1;
            testStats.set(name, entry);
        }
    }

    const flakiest = Array.from(testStats.entries())
        .map(([name, s]) => ({
            name,
            runs: s.runs,
            passes: s.passes,
            fails: s.fails,
            // Flakiness = how close to a 50/50 split a test is, scaled to runs.
            // Sorts mostly-flaky to mostly-stable.
            flakiness: s.runs >= 2 && s.passes > 0 && s.fails > 0
                ? Math.round(100 * (1 - Math.abs(s.passes - s.fails) / s.runs))
                : 0,
        }))
        .filter((t) => t.flakiness > 0)
        .sort((a, b) => b.flakiness - a.flakiness)
        .slice(0, 10);

    const slowest = Array.from(testStats.entries())
        .filter(([, s]) => s.runs > 0)
        .map(([name, s]) => ({
            name,
            avgDuration: Math.round(s.totalDuration / s.runs),
            runs: s.runs,
        }))
        .sort((a, b) => b.avgDuration - a.avgDuration)
        .slice(0, 10);

    return {
        totalRuns: allRuns.length,
        averagePassRate: avgPassRate,
        runs7d,
        runs30d,
        trend,
        flakiest,
        slowest,
    };
}
