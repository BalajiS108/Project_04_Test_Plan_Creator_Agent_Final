// Load backend/.env into process.env before anything else reads it. Without
// this, settings like PER_STEP_MODE=1, MAX_AGENT_TURNS, MAX_HEAL_TURNS, and
// LLM API keys placed in backend/.env are silently ignored — the backend
// would only see env vars set explicitly in the shell that launched it.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { runAgent, runAgentParallel, runAgentPerStep, ExecutionReport, ParallelProgress } from './agent.js';
import { runAgentWithCodeGeneration } from './run-agent-codegen.js';
import { healFailedTests } from './healer.js';
import { applyGuardrails } from './spec-guardrails.js';
import { generateExcelReport, generateHtmlReport } from './report.js';
import {
    dispatchNotification,
    loadNotificationConfig,
    saveNotificationConfig,
    NotificationConfig,
    NotificationEvent,
} from './notifications.js';
import { saveRun, listRuns, getRun, deleteRun, computeStats } from './history.js';
import { runVisualAudit, runA11yAudit, BASELINE_DIR, DIFF_DIR } from './qualityAudit.js';
import { runTestSuite, parseOpenApiSpec, ApiTest } from './apiTesting.js';
import { listSuites, getSuite, saveSuite, deleteSuite, ApiSuite } from './apiSuites.js';
import {
    isAuthEnabled, authMiddleware, requireAdmin,
    authenticateUser, registerUser, signToken, listUsers, hasAnyUser,
    deleteUser, countAdmins,
} from './auth.js';
import {
    loadConfig as loadCicdConfig,
    saveConfig as saveCicdConfig,
    testConnection as testCicdConnection,
    listRecentRuns as listCicdRuns,
    triggerWorkflow as triggerCicdWorkflow,
    listWorkflows as listCicdWorkflows,
    getWorkflow as getCicdWorkflow,
    CICDConfig,
} from './cicd.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Translate a raw Playwright error message into plain English the user can
 * actually read. Playwright's error blobs include the assertion API name,
 * locator objects, timing details, and "Call log:" traces — useful for
 * debugging, unreadable for status reporting. Falls back to a trimmed
 * version of the raw error when no specific pattern matches.
 *
 * Examples:
 *   "expect(locator).toContainText(expected) failed Locator: locator('[data-test=\"error\"]')
 *    Expected substring: \"Username and password do not match\"
 *    Received string: \"Epic sadface: Username is required\" ..."
 *     → "The test expected the text on [data-test=\"error\"] to contain
 *        'Username and password do not match' but the app actually showed
 *        'Epic sadface: Username is required'."
 */
const humanizePlaywrightError = (raw: string): string => {
    if (!raw || typeof raw !== 'string') return raw;
    const clean = stripAnsi(raw).trim();
    if (!clean) return '';

    // 1. toContainText / toHaveText assertion mismatch.
    {
        const exp = clean.match(/Expected (?:substring|string|pattern):\s*"([^"]+)"/);
        const got = clean.match(/Received string:\s*"([^"]+)"/);
        const loc = clean.match(/Locator:\s*locator\('([^']+)'\)/);
        if (exp && got) {
            const sel = loc ? ` on the element ${loc[1]}` : '';
            return `The test expected the text${sel} to contain "${exp[1]}" but the app actually showed "${got[1]}". The expected wording in the test plan does not match what this page renders.`;
        }
    }

    // 2. toHaveCount mismatch.
    {
        const expCount = clean.match(/Expected:\s*(\d+)\b/);
        const recCount = clean.match(/Received:\s*(\d+)\b/);
        const loc = clean.match(/Locator:\s*locator\('([^']+)'\)/);
        if (expCount && recCount && /toHaveCount/.test(clean)) {
            return `The test expected ${expCount[1]} element(s) matching ${loc ? loc[1] : 'the selector'} but found ${recCount[1]}.`;
        }
    }

    // 3. Strict-mode violation: locator resolved to N elements.
    {
        const m = clean.match(/strict mode violation:.*?locator\('([^']+)'\).*?resolved to (\d+) elements/i);
        if (m) {
            return `The selector "${m[1]}" matched ${m[2]} elements but the test was targeting a single one. Use .first(), .filter({ hasText: '...' }), or a more specific selector to disambiguate.`;
        }
    }

    // 4. toBeVisible / toBeHidden / toBeEnabled / toBeDisabled timeouts.
    {
        const matcher = clean.match(/expect\(locator\)\.(toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toBeChecked)\(/);
        const loc = clean.match(/Locator:\s*locator\('([^']+)'\)/);
        const timeout = clean.match(/(?:Timeout|timeout)[\s:]+(\d+)\s*ms/);
        if (matcher && loc) {
            const ms = timeout ? ` within ${(parseInt(timeout[1], 10) / 1000).toFixed(0)}s` : '';
            const want = ({
                toBeVisible: 'become visible',
                toBeHidden: 'be hidden',
                toBeEnabled: 'become enabled',
                toBeDisabled: 'become disabled',
                toBeChecked: 'become checked',
            } as Record<string, string>)[matcher[1]] || matcher[1];
            return `The test waited for ${loc[1]} to ${want}${ms}, but it never did. The element may not exist on this page, the selector is wrong, or the action that should have caused this state never fired.`;
        }
    }

    // 5. locator.click / .fill / .type timeout — element not found or not actionable.
    {
        const m = clean.match(/locator\.(click|fill|type|press|check|uncheck|selectOption|hover)[\s\S]*?(?:Test timeout|Timeout)[\s:]+(\d+)\s*ms/);
        const sel = clean.match(/locator\(['"]([^'"]+)['"]\)/);
        if (m) {
            const verb = m[1];
            const ms = (parseInt(m[2], 10) / 1000).toFixed(0);
            const where = sel ? ` on ${sel[1]}` : '';
            return `Could not ${verb}${where} within ${ms} seconds. The element either wasn't on the page, was hidden, or was being intercepted by another element.`;
        }
    }

    // 6. Navigation failures.
    {
        const m = clean.match(/page\.goto[\s\S]*?(net::[A-Z_]+|TimeoutError)[\s\S]*?(?:url:|at)\s*['"]?(https?:\/\/[^\s'"]+)/);
        if (m) {
            const reason = m[1] === 'net::ERR_NAME_NOT_RESOLVED' ? 'the address could not be resolved (check the URL or your network)' :
                m[1] === 'net::ERR_CONNECTION_REFUSED' ? 'the server refused the connection (it may be down)' :
                m[1].startsWith('net::') ? `the browser reported "${m[1]}"` :
                'the page took too long to load';
            return `Could not load ${m[2]} — ${reason}.`;
        }
    }

    // 7. TypeError from bad API usage.
    {
        const m = clean.match(/TypeError:\s+(.+?)(?:\n|$)/);
        if (m) {
            return `A JavaScript error occurred in the test code: ${m[1]}. The generated script may have used an API incorrectly.`;
        }
    }

    // 8. Fallback: first useful line(s), drop the "Call log:" trailer.
    const firstUseful = clean.split('\n').filter(l => l.trim() && !/^Call log:/i.test(l.trim())).slice(0, 2).join(' ').trim();
    return firstUseful || clean.slice(0, 200);
};

// Utility to strip ANSI escape codes for cleaner UI display
const stripAnsi = (str: string) => {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '');
};

const reportsDir = path.join(__dirname, 'reports');
const videosDir = path.join(__dirname, 'videos');
// tests/generated lives at the project root (one level up from backend/)
const projectRoot = path.resolve(__dirname, '..');
const testsGeneratedDir = path.join(projectRoot, 'tests', 'generated');

if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
if (!fs.existsSync(testsGeneratedDir)) fs.mkdirSync(testsGeneratedDir, { recursive: true });

const app = express();

// CORS: in local dev, allow any origin (frontend at :5173, backend at :3001).
// In production, lock down to one or more explicit frontend origins set via
// FRONTEND_ORIGIN env var (comma-separated for multiple). Without this, a
// production deployment would accept requests from any site on the internet.
//
// Examples for backend/.env or Render env vars:
//   FRONTEND_ORIGIN=https://my-app.vercel.app
//   FRONTEND_ORIGIN=https://my-app.vercel.app,https://my-app-preview.vercel.app
const corsOriginEnv = (process.env.FRONTEND_ORIGIN || '').trim();
if (corsOriginEnv) {
    const allowedOrigins = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
    app.use(cors({
        origin: (origin, cb) => {
            if (!origin) return cb(null, true);  // server-to-server, curl, etc.
            if (allowedOrigins.includes(origin)) return cb(null, true);
            return cb(new Error(`CORS: origin ${origin} not in FRONTEND_ORIGIN allowlist`));
        },
        credentials: true,
    }));
    console.log(`🔒 CORS locked to ${allowedOrigins.length} origin(s): ${allowedOrigins.join(', ')}`);
} else {
    app.use(cors());  // permissive — fine for localhost dev
}

app.use(express.json({ limit: '10mb' }));

// Logger middleware
app.use((req, _res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

// Generated artifacts (downloadable reports, recorded videos, Playwright HTML
// reports, visual-audit images) are served as static files BEFORE the auth
// gate. They're reached via direct browser navigation — <a href>, new tab,
// download — which cannot attach the Bearer token; and the Playwright HTML
// report pulls its own sub-resources via relative URLs that likewise wouldn't
// carry a token. Keeping them ahead of authMiddleware is what makes
// "View HTML Report" / "Export Excel" work when AUTH_ENABLED is on. These
// directories hold only generated test output, not credentials or user data.
const htmlReportsDir = path.join(projectRoot, 'html-reports');
if (!fs.existsSync(htmlReportsDir)) fs.mkdirSync(htmlReportsDir, { recursive: true });

// Serve generated reports for download
app.use('/reports', express.static(reportsDir));

// Serve recorded test execution videos
app.use('/videos', express.static(videosDir));

// Serve Playwright HTML reports (multi-file: index.html + relative assets)
app.use('/html-reports', express.static(htmlReportsDir));

// Visual-regression baseline + diff PNGs are served so the frontend can show
// them inline in the audit panel.
app.use('/audit-images/baselines', express.static(BASELINE_DIR));
app.use('/audit-images/diffs', express.static(DIFF_DIR));

// Auth gate — opt-in via AUTH_ENABLED env var. When off, this is a no-op.
// Everything below this line requires a valid Bearer token (when enabled).
app.use(authMiddleware);

// Progress Tracking
interface WorkerSlot {
    workerId: number;
    currentCase: string;
    currentCaseId?: string;
    currentCaseName?: string;
    progress: number;
    total: number;
    action?: string;
    updatedAt: number;
}

interface ExecutionStatus {
    isRunning: boolean;
    currentCase: string;            // legacy field — mirrors worker 1 for backward compat
    progress: number;
    total: number;
    action: string;
    currentCaseId?: string;
    currentCaseName?: string;
    concurrency: number;             // how many workers were requested for this run
    workers: WorkerSlot[];           // per-worker live status — empty when not running
}
let executionStatus: ExecutionStatus = {
    isRunning: false,
    currentCase: '',
    progress: 0,
    total: 0,
    action: '',
    concurrency: 1,
    workers: [],
};

let stopRequested = false;
// Stores results of completed test cases so /api/partial-results can serve them on Stop
let partialResults: any[] = [];

// Track active Playwright child process for script-mode stop
let activePlaywrightProcess: import('child_process').ChildProcess | null = null;

export const isStopRequested = () => stopRequested;

export const resetStopFlag = () => {
    stopRequested = false;
};

export const updateExecutionStatus = (status: any) => {
    executionStatus = { ...executionStatus, ...status };
};

/**
 * Per-worker progress update — used by runAgentParallel.
 * Looks up the worker slot by id and replaces it with the new state.
 * Also mirrors worker 1's state onto the legacy top-level fields so older
 * UIs that don't know about workers still see something sensible.
 */
export const updateWorkerStatus = (status: ParallelProgress) => {
    const idx = executionStatus.workers.findIndex((w) => w.workerId === status.workerId);
    const slot: WorkerSlot = {
        workerId: status.workerId,
        currentCase: status.currentCase,
        currentCaseId: status.currentCaseId,
        currentCaseName: status.currentCaseName,
        progress: status.progress,
        total: status.total,
        action: status.action,
        updatedAt: Date.now(),
    };
    if (idx === -1) executionStatus.workers.push(slot);
    else executionStatus.workers[idx] = slot;

    // Mirror worker 1 into the top-level legacy fields so anything that still
    // reads executionStatus.currentCase keeps working.
    if (status.workerId === 1) {
        executionStatus = {
            ...executionStatus,
            currentCase: status.currentCase,
            currentCaseId: status.currentCaseId,
            currentCaseName: status.currentCaseName,
            progress: status.progress,
            total: status.total,
            action: status.action || '',
        };
    }
};

export const addPartialResult = (result: any) => {
    partialResults.push(result);
};

app.post('/api/stop', (_req, res) => {
    stopRequested = true;
    executionStatus.isRunning = false;

    // Kill active Playwright child process if running (script-mode stop)
    if (activePlaywrightProcess && !activePlaywrightProcess.killed) {
        console.log('🛑 Killing active Playwright child process...');
        try {
            // On Windows, use taskkill to ensure the entire process tree is killed
            if (process.platform === 'win32') {
                const { execSync } = require('child_process');
                execSync(`taskkill /pid ${activePlaywrightProcess.pid} /T /F`, { stdio: 'ignore' });
            } else {
                activePlaywrightProcess.kill('SIGTERM');
            }
        } catch (e) {
            console.warn('⚠️ Failed to kill child process:', e);
        }
        activePlaywrightProcess = null;
    }

    res.json({ success: true, message: 'Execution stopped successfully.' });
});

app.get('/api/partial-results', async (_req, res) => {
    if (partialResults.length === 0) {
        return res.json({ hasResults: false, results: [], summary: null });
    }
    const passed = partialResults.filter((r: any) => r.status === 'PASS').length;
    const failed = partialResults.filter((r: any) => r.status === 'FAIL').length;
    const errors = partialResults.filter((r: any) => r.status === 'ERROR').length;
    const skippedInResults = partialResults.filter((r: any) => r.status === 'SKIPPED').length;
    const totalDuration = partialResults.reduce((sum: number, r: any) => sum + (r.duration || 0), 0);

    // Total = max(planned tests, what we actually have). The agent now pushes
    // SKIPPED placeholder rows for un-run tests on stop, so partialResults.length
    // usually already matches the plan size — but we keep the max() guard in case
    // executionStatus.total drifts.
    const total = Math.max(executionStatus.total || 0, partialResults.length);
    // Real SKIPPED rows + any planned tests still missing from results.
    const skipped = skippedInResults + Math.max(0, total - partialResults.length);

    const report: ExecutionReport = {
        summary: {
            total,
            passed,
            failed,
            skipped,
            errors,
            duration: totalDuration,
            executedAt: new Date().toISOString()
        },
        results: partialResults
    };

    try {
        const reportPath = await generateExcelReport(report);
        const htmlReportPath = await generateHtmlReport(report);
        const reportFilename = path.basename(reportPath);
        const htmlReportFilename = path.basename(htmlReportPath);

        res.json({
            hasResults: true,
            results: partialResults,
            summary: report.summary,
            reportDownloadUrl: `/reports/${reportFilename}`,
            htmlReportUrl: `/reports/${htmlReportFilename}`
        });
    } catch (e: any) {
        console.error("Error generating partial reports", e);
        res.json({
            hasResults: true,
            results: partialResults,
            summary: report.summary
        });
    }
});

app.post('/api/execute', async (req, res) => {
    try {
        const { testCases, llmConfig, autoHeal, concurrency, headed } = req.body;

        if (!testCases || !llmConfig) {
            return res.status(400).json({ success: false, error: 'Missing testCases or llmConfig in request body.' });
        }

        // Clamp concurrency to a sane range [1, 5]. Default 1 = sequential (legacy behavior).
        const workers = Math.max(1, Math.min(Number(concurrency) || 1, 5));

        console.log('\n========================================');
        console.log('🧪 Test Execution Request Received');
        console.log(`🧬 Auto-Heal: ${autoHeal ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🖥️  Browser mode: ${headed ? 'HEADED (visible)' : 'HEADLESS'}`);
        console.log(`⚡ Concurrency: ${workers} ${workers > 1 ? `(parallel — ${workers} workers)` : '(sequential)'}`);
        console.log('========================================');

        executionStatus = {
            isRunning: true,
            currentCase: 'Initializing...',
            currentCaseId: '',
            currentCaseName: 'Initializing...',
            progress: 0,
            total: testCases.length,
            action: 'Connecting to MCP...',
            concurrency: workers,
            workers: [],
        };
        stopRequested = false;
        partialResults = []; // Reset for new run

        // Pick the right runner.
        // - workers > 1   → parallel path (each worker owns its own MCP session)
        // - DEFAULT       → per-step orchestrator (focused mini-conversation
        //   per step; far more reliable on long flows than the old legacy
        //   path). Used to be opt-in via PER_STEP_MODE=1, now it's the default.
        // - PER_STEP_MODE=legacy in env → opt OUT to the original
        //   single-conversation runAgent (kept as fallback while we iterate).
        const useLegacy = (process.env.PER_STEP_MODE || '').toLowerCase() === 'legacy';
        console.log(useLegacy
            ? '🏛️  PER_STEP_MODE=legacy — using single-conversation runAgent (fallback path)'
            : '🧩 Using per-step orchestrator (runAgentPerStep) — set PER_STEP_MODE=legacy to opt out');
        const report: ExecutionReport = workers > 1
            ? await runAgentParallel(testCases, llmConfig, workers, updateWorkerStatus, { autoHeal: !!autoHeal, headed: !!headed })
            : useLegacy
                ? await runAgent(testCases, llmConfig, updateExecutionStatus, { autoHeal: !!autoHeal, headed: !!headed })
                : await runAgentPerStep(testCases, llmConfig, updateExecutionStatus, { autoHeal: !!autoHeal, headed: !!headed });

        // Generate reports
        const reportPath = await generateExcelReport(report);
        const htmlReportPath = await generateHtmlReport(report);
        const reportFilename = path.basename(reportPath);
        const htmlReportFilename = path.basename(htmlReportPath);

        executionStatus.isRunning = false;
        stopRequested = false;
        res.json({
            success: true,
            report,
            reportDownloadUrl: `/reports/${reportFilename}`,
            htmlReportUrl: `/reports/${htmlReportFilename}`,
            message: `Execution complete. ${report.summary.passed}/${report.summary.total} passed.`
        });

        // Fire notifications after responding — never let a slow webhook delay the UI
        const host = req.headers.host || `localhost:${process.env.PORT || 3001}`;
        const protocol = req.protocol;
        notifyExecutionCompleted(report, {
            mode: 'AI Agent',
            reportUrl: `${protocol}://${host}/reports/${htmlReportFilename}`,
        });

        // Persist this run for the history dashboard
        try {
            saveRun(report, { mode: 'AI Agent', productName: req.body?.productName });
        } catch (e: any) {
            console.warn('Could not persist run history:', e.message);
        }
    } catch (error: any) {
        console.error('❌ Execution error:', error.message);
        executionStatus.isRunning = false;
        res.status(500).json({ success: false, error: error.message });
    } finally {
        stopRequested = false;
        executionStatus.isRunning = false;
    }
});

// DEPRECATED: legacy code-generation execution endpoint.
// The frontend's "Run with Playwright Script Mode" button no longer calls
// this — it now calls /api/generate-scripts followed by /api/run-playwright
// so the same Playwright CLI path is used for both ad-hoc runs and Script
// Library replays. Kept here only as a safety net for any external caller;
// safe to delete once nothing depends on it.
app.post('/api/execute-codegen', async (req, res) => {
    if (executionStatus.isRunning) {
        return res.status(400).json({ success: false, error: 'Execution already in progress' });
    }

    const { testCases, llmConfig, headed, productName } = req.body;

    if (!testCases || !llmConfig) {
        return res.status(400).json({ success: false, error: 'Missing testCases or llmConfig in request body.' });
    }

    executionStatus.isRunning = true;
    executionStatus.currentCase = 'Starting code generation...';
    executionStatus.progress = 0;
    executionStatus.total = 0;

    try {
        console.log('\n╔════════════════════════════════════════╗');
        console.log('║  🚀 CODE GEN EXECUTION STARTED         ║');
        console.log('╚════════════════════════════════════════╝');
        console.log(`🖥️  Browser mode: ${headed ? 'HEADED (visible)' : 'HEADLESS'}`);
        console.log('📝 Test Cases Length:', testCases?.length);
        console.log('📝 LLM Config:', JSON.stringify(llmConfig, null, 2));

        // Use code generation approach
        let codeGenReport;
        try {
            codeGenReport = await runAgentWithCodeGeneration(
                testCases,
                llmConfig,
                (status: any) => {
                    executionStatus.currentCase = status.log || 'Processing...';
                    executionStatus.progress = status.progress || 0;
                    executionStatus.total = status.total || 1;
                    console.log(`📊 Progress: ${executionStatus.currentCase}`);
                },
                { headless: !headed, productName }
            );
        } catch (codeGenError: any) {
            console.error('❌ Error in runAgentWithCodeGeneration:', codeGenError.message);
            console.error('Stack:', codeGenError.stack);
            throw codeGenError;
        }

        console.log('✅ Code generation completed');
        console.log('📊 codeGenReport keys:', Object.keys(codeGenReport));
        console.log('📊 codeGenReport.results:', codeGenReport?.results);

        if (!codeGenReport || !codeGenReport.results) {
            throw new Error(`Invalid code generation report: ${JSON.stringify(codeGenReport)}`);
        }

        // Convert code generation report to ExecutionReport format
        const report: ExecutionReport = {
            summary: {
                total: codeGenReport.summary.total,
                passed: codeGenReport.summary.passed,
                failed: codeGenReport.summary.failed,
                skipped: 0,
                errors: codeGenReport.summary.errors,
                duration: codeGenReport.summary.duration,
                executedAt: new Date().toISOString()
            },
            results: (codeGenReport.results || []).map((result: any, index: number) => ({
                id: index + 1,
                name: result.testName || `Test ${index + 1}`,
                jiraKey: 'CODEGEN',
                priority: 'MEDIUM',
                status: result.status,
                steps: [{ 
                    step: 'Generated Playwright code executed', 
                    result: result.actualResult, 
                    passed: result.status === 'PASS' 
                }],
                expectedResult: 'Test should execute successfully',
                actualResult: result.actualResult,
                duration: result.duration || 0,
                error: result.error
            }))
        };

        const reportPath = await generateExcelReport(report);
        const reportFilename = path.basename(reportPath);
        // Match the MCP path so the "View HTML Report" button appears in
        // Script mode too. Previously codegen only produced Excel, which made
        // the button vanish whenever the user switched to Script mode.
        const htmlReportPath = await generateHtmlReport(report);
        const htmlReportFilename = path.basename(htmlReportPath);

        executionStatus.isRunning = false;
        res.json({
            success: true,
            report,
            reportDownloadUrl: `/reports/${reportFilename}`,
            htmlReportUrl: `/reports/${htmlReportFilename}`,
            message: `Code generation execution complete. ${report.summary.passed}/${report.summary.total} passed.`
        });

        // Fire notifications after responding
        notifyExecutionCompleted(report, { mode: 'Playwright Script' });

        // Persist this run for the history dashboard
        try {
            saveRun(report, { mode: 'Playwright Script', productName: req.body?.productName });
        } catch (e: any) {
            console.warn('Could not persist run history:', e.message);
        }
    } catch (error: any) {
        console.error('❌ Code generation execution error:', error.message);
        console.error('📋 Full error:', error);
        console.error('🔍 Stack trace:', error.stack);
        executionStatus.isRunning = false;
        res.status(500).json({ success: false, error: error.message });
    }
});

// Inspect every distinct URL referenced in the test plan and return REAL DOM
// selectors. Without this the LLM falls back to training-data memory of a
// site, which is how we ended up with hallucinated selectors that look right
// (#inventory_container, #checkout, etc.) but don't always match the current
// page. This is bounded — we cap at 5 pages and 12s per page so generation
// stays fast even when a URL hangs.
async function inspectUrlsForGeneration(markdown: string, log: (s: string) => void): Promise<string> {
    const urlSet = new Set<string>();
    const urlRegex = /(https?:\/\/[^\s)"'`]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRegex.exec(markdown)) !== null) {
        const u = m[1].replace(/[)"',.;]+$/, '');
        urlSet.add(u);
        if (urlSet.size >= 5) break;
    }
    if (urlSet.size === 0) return '';

    const { chromium } = await import('playwright');
    let browser: any;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (e: any) {
        log(`⚠️ Could not launch chromium for page inspection: ${e.message}`);
        return '';
    }

    // Helper: extract a (username, password) hint from the page text. Many
    // demo apps print credentials inline (saucedemo, the-internet, etc.).
    // We look for two patterns: explicit "Username: X / Password: Y" labels,
    // and the "Accepted usernames are: <list>" + "Password for all users: Y"
    // layout SauceDemo uses. Returns null if nothing recognizable.
    const findCredentialsInText = (text: string): { username: string; password: string } | null => {
        const t = text.replace(/\s+/g, ' ');
        // Pattern A: SauceDemo's exact phrasing
        const userListMatch = t.match(/Accepted usernames are:\s+([a-zA-Z0-9_, ]+?)\s+(?:Password|$)/i);
        const passMatch = t.match(/Password for all users:\s*(\S+)/i);
        if (userListMatch && passMatch) {
            const firstUser = userListMatch[1].split(/[\s,]+/).find((s) => s && s !== 'and') || '';
            if (firstUser) return { username: firstUser, password: passMatch[1] };
        }
        // Pattern B: generic "Username: X / Password: Y"
        const labeled = t.match(/Username:\s*(\S+)[\s\S]{0,80}?Password:\s*(\S+)/i);
        if (labeled) return { username: labeled[1], password: labeled[2] };
        return null;
    };

    // Helper: inspect the current page (DRY — used for pre-login URL and
    // post-login URL alike).
    const inspectCurrentPage = async (p: any) => {
        return await p.evaluate(() => {
            const out: { type: string; text: string; selector: string }[] = [];
            const pickSelector = (el: Element): string => {
                const dt = el.getAttribute('data-test') || el.getAttribute('data-testid');
                if (dt) return `[data-test="${dt}"]`;
                if (el.id) return `#${el.id}`;
                const name = el.getAttribute('name');
                if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
                return el.tagName.toLowerCase();
            };
            document.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach((el) => {
                const text = (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').trim();
                if (text) out.push({ type: 'button', text, selector: pickSelector(el) });
            });
            document.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="hidden"]), select, textarea').forEach((el) => {
                const label = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('id') || el.tagName).toString().trim();
                out.push({ type: 'input', text: label, selector: pickSelector(el) });
            });
            document.querySelectorAll('a[href]').forEach((el) => {
                const text = (el.textContent || '').trim();
                if (text) out.push({ type: 'link', text: text.slice(0, 60), selector: pickSelector(el) });
            });
            document.querySelectorAll('[data-test="error"], .error-message, #error, .alert').forEach((el) => {
                const text = (el.textContent || '').trim();
                if (text || el.id) out.push({ type: 'error', text: text.slice(0, 80) || '(empty)', selector: pickSelector(el) });
            });

            const idCounts = new Map<string, Element[]>();
            document.querySelectorAll('[id]').forEach((el) => {
                const id = el.id;
                if (!id) return;
                if (!idCounts.has(id)) idCounts.set(id, []);
                idCounts.get(id)!.push(el);
            });
            const duplicateIds: { id: string; count: number; alternatives: string[] }[] = [];
            idCounts.forEach((els, id) => {
                if (els.length <= 1) return;
                const alts: string[] = [];
                for (const el of els) {
                    const dt = el.getAttribute('data-test') || el.getAttribute('data-testid');
                    if (dt) alts.push(`[data-test="${dt}"]`);
                }
                duplicateIds.push({ id, count: els.length, alternatives: Array.from(new Set(alts)) });
            });

            const dtCounts = new Map<string, number>();
            document.querySelectorAll('[data-test], [data-testid]').forEach((el) => {
                const dt = el.getAttribute('data-test') || el.getAttribute('data-testid')!;
                dtCounts.set(dt, (dtCounts.get(dt) || 0) + 1);
            });
            const duplicateDataTests = Array.from(dtCounts.entries())
                .filter(([, n]) => n > 1)
                .map(([dt, n]) => ({ dt, count: n }));

            return {
                elements: out.slice(0, 60),
                duplicateIds,
                duplicateDataTests,
                visibleText: (document.body.innerText || '').slice(0, 4000),
                currentUrl: location.href,
            };
        });
    };

    // Helper: format an inspection result + dup warnings into the prompt section.
    const formatSection = (urlLabel: string, info: any) => {
        const elementsBlock = info.elements.map((el: any) => `  - ${el.type}: "${el.text}" → ${el.selector}`).join('\n');
        let warnings = '';
        if (info.duplicateIds.length > 0) {
            warnings += `\n  ⚠️ DUPLICATE IDs on this page (strict-mode violation if you target them) — use the alternatives:\n`;
            for (const d of info.duplicateIds.slice(0, 10)) {
                warnings += `      • #${d.id} appears on ${d.count} elements${d.alternatives.length ? ` — use ${d.alternatives.join(' or ')} instead` : ' — append .first() or pick a unique parent/data-test'}\n`;
            }
        }
        if (info.duplicateDataTests.length > 0) {
            warnings += `\n  ⚠️ DUPLICATE data-test attributes — use .first() or filter({ hasText }):\n`;
            for (const d of info.duplicateDataTests.slice(0, 10)) {
                warnings += `      • [data-test="${d.dt}"] appears on ${d.count} elements\n`;
            }
        }
        return `URL: ${urlLabel}\nElements:\n${elementsBlock}${warnings}`;
    };

    const sections: string[] = [];
    for (const url of urlSet) {
        let page: any;
        try {
            page = await browser.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });

            // Inspect the landing page first.
            const initial = await inspectCurrentPage(page);
            sections.push(formatSection(url, initial));
            log(`🔎 Inspected ${url} — ${initial.elements.length} elements, ${initial.duplicateIds.length} duplicate IDs`);

            // Detect a login form (heuristic: two inputs of name/id user/pass + a
            // login-ish button). If we find one AND can extract credentials from
            // the page text, log in and inspect the post-login page too. This
            // covers demo apps that print credentials inline (saucedemo).
            const hasLoginForm = initial.elements.some((el: any) =>
                el.type === 'input' && /user|email|login/i.test(el.text + ' ' + el.selector)
            ) && initial.elements.some((el: any) =>
                el.type === 'input' && /pass/i.test(el.text + ' ' + el.selector)
            ) && initial.elements.some((el: any) =>
                el.type === 'button' && /log\s*in|sign\s*in|submit/i.test(el.text)
            );

            const creds = hasLoginForm ? findCredentialsInText(initial.visibleText || '') : null;
            if (creds) {
                log(`🔐 Login form detected with visible credentials — attempting auto-login as "${creds.username}" to inspect post-auth pages`);
                try {
                    // Use Playwright's getByPlaceholder/role helpers which are
                    // resilient to whatever selector the app uses for the form.
                    const userInput = page.locator('input[type="text"], input[name*="user" i], input[id*="user" i], input[placeholder*="user" i], input[name*="email" i], input[type="email"]').first();
                    const passInput = page.locator('input[type="password"], input[name*="pass" i], input[id*="pass" i], input[placeholder*="pass" i]').first();
                    await userInput.fill(creds.username, { timeout: 5000 });
                    await passInput.fill(creds.password, { timeout: 5000 });
                    await page.locator('button:has-text("Login"), button:has-text("Sign in"), button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 });
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

                    const postLogin = await inspectCurrentPage(page);
                    sections.push(formatSection(`${postLogin.currentUrl} (auto-logged-in)`, postLogin));
                    log(`🔓 Post-login inspection of ${postLogin.currentUrl} — ${postLogin.elements.length} elements, ${postLogin.duplicateIds.length} duplicate IDs`);
                } catch (loginErr: any) {
                    log(`🔐 Auto-login failed (${loginErr.message?.slice(0, 120) || 'unknown'}) — continuing with pre-login DOM only`);
                }
            }

        } catch (e: any) {
            log(`⚠️ Could not inspect ${url}: ${e.message}`);
        } finally {
            if (page) await page.close().catch(() => {});
        }
    }
    await browser.close().catch(() => {});
    return sections.length ? `\nREAL PAGE CONTEXT (inspected just now — use these selectors verbatim, do NOT guess):\n\n${sections.join('\n\n')}\n` : '';
}

// Generate Playwright test scripts from test plan
app.post('/api/generate-scripts', async (req, res) => {
    try {
        const { testCases, llmConfig, productName } = req.body;
        if (!testCases || !llmConfig) {
            return res.status(400).json({ success: false, error: 'Missing testCases or llmConfig' });
        }

        const OpenAI = (await import('openai')).default;
        const getBaseURL = (config: any): string => {
            switch (config.provider) {
                case 'Groq': return 'https://api.groq.com/openai/v1';
                case 'Ollama': return `${(config.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`;
                case 'Gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai/';
                default: return 'https://api.openai.com/v1';
            }
        };
        const openai = new OpenAI({ apiKey: llmConfig.apiKey || 'dummy', baseURL: getBaseURL(llmConfig) });

        // Live DOM inspection — best-effort. If it fails (URL unreachable,
        // playwright missing, etc.) we still generate code from the plan alone.
        const pageContext = await inspectUrlsForGeneration(String(testCases), (s) => console.log(s));

        // Site-specific cheatsheet — mirrors the one in agent.ts. Stable demo
        // sites with deterministic selectors get hardcoded here so the LLM
        // doesn't have to "discover" them from the live inspection alone
        // (which can miss elements depending on what the inspector loaded).
        const tcLower = String(testCases).toLowerCase();
        let siteCheatsheet = '';
        if (/saucedemo\.com/.test(tcLower)) {
            siteCheatsheet = `
SITE CHEATSHEET — saucedemo.com (USE THESE VERBATIM; DOM is stable):

PAGE LADDER — every selector below lives on EXACTLY ONE page. To use a selector you MUST first execute the navigation click that gets you to its page. There is no exception. If your test asserts a selector for page N without first navigating from page N-1, the test will time out at 15 seconds with "waiting for locator('…')".

  PAGE 1 — / (login)
    Users:      #user-name, #password, #login-button
    Error:      [data-test="error"]   (only after a failed login submit)
    Credentials in plain text on the page:
      Users:    standard_user / problem_user / performance_glitch_user / error_user / visual_user / locked_out_user
      Password (all users): secret_sauce
    NAV: clicking #login-button (with a valid user) goes to PAGE 2.

  PAGE 2 — /inventory.html (after login)
    Cart icon:        #shopping_cart_container       (a link, not a button)
    Cart badge:       .shopping_cart_badge           (only appears when cart is non-empty; toHaveText('N'))
    Add-to-cart:      #add-to-cart-<product-name-lowercased-with-hyphens>
                       e.g. #add-to-cart-sauce-labs-backpack, #add-to-cart-sauce-labs-bolt-t-shirt,
                       #add-to-cart-sauce-labs-bike-light, #add-to-cart-sauce-labs-fleece-jacket,
                       #add-to-cart-sauce-labs-onesie
    After clicking Add the button is REPLACED by:
                      #remove-<same-name>            (the original add selector no longer exists)
    Product names:    .inventory_item_name           (MULTI-MATCH — use .filter({hasText:'X'}) when asserting one)
    Sort dropdown:    .product_sort_container
    NAV: clicking #shopping_cart_container → PAGE 3.

  PAGE 3 — /cart.html (only after clicking the cart icon from PAGE 2)
    Item rows:        .cart_item                     (multi-match — .first() / .filter({hasText:'X'}); .toHaveCount(N) for count)
    Item names:       [data-test="inventory-item-name"]   (preferred over .cart_item .inventory_item_name)
    Checkout button:  #checkout                      (LIVES ONLY HERE — clicking from PAGE 2 will time out)
    Continue Shop:    #continue-shopping             (LIVES ONLY HERE — clicking from PAGE 2 will time out)
    NAV: clicking #checkout → PAGE 4. Clicking #continue-shopping → back to PAGE 2.

  PAGE 4 — /checkout-step-one.html (only after clicking #checkout from PAGE 3)
    Form inputs:      #first-name, #last-name, #postal-code
    Continue:         #continue                      (LIVES ONLY HERE — has no other meaning on other pages)
    Cancel:           #cancel
    NAV: filling all three inputs then clicking #continue → PAGE 5.

  PAGE 5 — /checkout-step-two.html (only after clicking #continue from PAGE 4)
    Summary lines:    .summary_info, .summary_subtotal_label, .summary_tax_label, .summary_total_label
                      (THESE LIVE ONLY HERE — asserting them from PAGE 3 or earlier WILL time out)
    Item names:       [data-test="inventory-item-name"]   (still works here, in summary context)
    Finish:           #finish                        (LIVES ONLY HERE)
    Cancel:           #cancel
    NAV: clicking #finish → PAGE 6.

  PAGE 6 — /checkout-complete.html
    Success text:     "Thank you for your order!"     (visible text)
    Back home:        #back-to-products              (returns to PAGE 2)

CRITICAL FAILURE PATTERNS LLMs FALL INTO (do NOT do these):
  ❌ "Verify First Product in Cart" test that asserts .summary_total_label — that's PAGE 5, the test is on PAGE 3.
  ❌ Test body that clicks #continue-shopping at the top, before any cart navigation — the test is on PAGE 2 (inventory) from beforeEach, the button doesn't exist there.
  ❌ Test that clicks #finish without first filling the form on PAGE 4 and clicking #continue.
  ❌ Asserting "Thank you for your order" without going through PAGES 3 → 4 → 5 → 6.
If you find yourself wanting to do any of the above, the test plan author probably meant something else; assert what's actually visible on the page you're on, or add the navigation steps first.
`;
        }

        const prompt = `You are a senior QA automation engineer. Convert the following test plan into complete, runnable Playwright TypeScript test scripts.

Test Plan:
${testCases}
${pageContext}${siteCheatsheet}
Requirements:
- Use Playwright's test framework with \`import { test, expect } from '@playwright/test';\`
- Each test case in the plan should become a separate \`test()\` block inside a \`test.describe()\` suite
- Use data-driven approach where test data is stored in variables at the top of each test
- Selector Strategy: When REAL PAGE CONTEXT is provided above, you MUST use the exact selectors listed there. They were extracted from the live DOM seconds ago. Do NOT substitute selectors from memory or from another version of the site, even if they look similar.
- If REAL PAGE CONTEXT includes a "⚠️ DUPLICATE IDs" or "⚠️ DUPLICATE data-test attributes" warning, treat those selectors as UNSAFE — never write \`page.locator('#that-id')\` because Playwright will throw a strict-mode violation. Use the suggested alternative (data-test or .first()) shown in the warning.
- If a behavior in the plan references an element that's NOT in REAL PAGE CONTEXT, prefer a getByRole/getByText locator (which auto-waits and is resilient) over a guessed ID/class.

CRITICAL SELECTOR HYGIENE (these mistakes break tests in subtle ways):
1. Attribute selectors: do NOT prefix \`[data-test="..."]\` (or \`[data-testid="..."]\`) with a tag name unless that exact tag was verified in REAL PAGE CONTEXT above. Many apps render the same data-test on different tags depending on state. Example: SauceDemo's error message lives on \`<h3 data-test="error">\`, NOT on a \`<div>\`. Write \`[data-test="error"]\`, never \`div[data-test="error"]\`.
2. Post-navigation waits: after clicking a button that navigates to a different page (Checkout, Submit, Login, Continue, Next), the previous page's elements are GONE. Wait for an element you expect on the DESTINATION page, NOT for something that lived on the source page. Example: after \`page.click('#checkout')\` on the cart page, do NOT \`waitForSelector('.cart_item')\` — \`.cart_item\` was on the cart page that just unmounted. Wait for the checkout form's first input instead (e.g. \`#first-name\` or \`#checkout_info_container\`).
3. For dynamic state-triggered messages (errors, toasts, validation) that only appear after an action, use an auto-waiting assertion rather than a bare waitForSelector. Example: \`await expect(page.locator('[data-test="error"]')).toBeVisible();\`
4. After every \`page.click(...)\` that triggers navigation, add an explicit wait for a known destination-page element BEFORE doing anything else on that page. Cart → Checkout: wait for \`#first-name\` or equivalent. Login → Inventory: wait for \`.inventory_list\` or \`#inventory_container\`.

==== BANNED PATTERNS — do not emit these under any circumstances ====
- BANNED: \`.locator('..')\` for parent-traversal. This is fragile DOM walking. Any app that needs you to traverse up to find a button has a more stable ID/data-test attribute somewhere — use that.  Example: do NOT write \`page.getByText('Sauce Labs Bolt T-Shirt').locator('..').getByRole('button', { name: 'Add to cart' })\`. SauceDemo gives every product an Add button with a stable ID like \`#add-to-cart-sauce-labs-bolt-t-shirt\` (product name lowercased, spaces → hyphens). USE THE ID.
- BANNED: \`waitForSelector('.cart_item')\` (or any cart-page locator) AFTER clicking Checkout/Continue/Submit. Wait for the destination page's element.
- BANNED: \`div[data-test=...]\` / \`span[data-test=...]\` / \`p[data-test=...]\` / \`button[data-test=...]\` — drop the tag prefix.
- BANNED: hardcoded \`page.waitForTimeout(N)\` — use auto-waiting locators (\`expect(...).toBeVisible()\`) instead.
- BANNED: \`getByRole('button', { name: 'Add to cart' })\` when the page exposes per-product Add IDs. Disambiguate with the product-specific ID instead.
- BANNED: \`test.title\` — this property does NOT exist on Playwright's test object. Accessing it returns \`undefined\`, so any chained \`.replace(...)\` / \`.toLowerCase()\` / etc. throws \`TypeError: Cannot read properties of undefined\`. The correct API is \`test.info().title\` (a function call returning a TestInfo object). Inside a test body:
  - ✅ \`path: \\\`screenshots/\\\${test.info().title.replace(/\\\\s+/g, '_')}.png\\\`\`
  - ❌ \`path: \\\`screenshots/\\\${test.title.replace(/\\\\s+/g, '_')}.png\\\`\`  (TypeError at runtime)
- BANNED: \`expect(locator).toHaveText('<paraphrased message>')\` for ERROR / TOAST / NOTIFICATION text from the test plan. The plan usually quotes a paraphrase or substring (e.g. "Username and password do not match") but the app renders something longer (e.g. "Epic sadface: Username and password do not match any user in this service"). \`toHaveText\` requires EXACT equality and will fail. Default to substring matching:
  - PREFERRED: \`await expect(page.locator('[data-test="error"]')).toContainText('Username and password do not match');\`
  - Only use \`toHaveText\` when the test plan EXPLICITLY says "exact message: <text>".
- BANNED: asserting an error MESSAGE substring that doesn't match the input the test actually provides. The test plan's Expected Result is often written generically (e.g. "shows an error"), but the app's actual message depends on WHAT field is empty:
  - Empty username (any state of password) → SauceDemo shows "Epic sadface: Username is required"
  - Username filled but password empty → "Epic sadface: Password is required"
  - Both filled, wrong credentials → "Epic sadface: Username and password do not match any user in this service"
  - Locked-out user → "Epic sadface: Sorry, this user has been locked out."
  Match the assertion to what the APP actually renders for the input the test provides, NOT to the test plan's generic phrasing.
  - If the test sets username="" and password="" → assert "Username is required"
  - If the test sets username="x" and password="" → assert "Password is required"
  - If the test sets username="bad" and password="bad" → assert "Username and password do not match"
  - When in doubt about the exact wording, use \`expect(page.locator('[data-test="error"]')).toBeVisible()\` to assert that AN error appears, rather than asserting specific text that may not match.
- BANNED: \`expect(page.locator('.cart_item' | '.inventory_item' | '.list-item' | '.row' | '.product' | 'li' | 'tr')).toBeVisible()\`. These class names typically match MULTIPLE elements, and Playwright's locator assertions are strict by default — \`toBeVisible()\` on a multi-match throws "strict mode violation: locator resolved to N elements". This ban applies whether the selector is passed as a string literal OR via a variable (e.g. \`const cartItemSelector = '.cart_item'; expect(page.locator(cartItemSelector)).toBeVisible()\` is just as banned as the literal form). Use ONE of these patterns instead:
  - Count assertion (PREFERRED when you know how many items to expect): \`await expect(page.locator('.cart_item')).toHaveCount(2)\`
  - Visibility of any: \`await expect(page.locator('.cart_item').first()).toBeVisible()\`
  - Visibility of specific: \`await expect(page.locator('.cart_item').filter({ hasText: 'Sauce Labs Backpack' })).toBeVisible()\`
  - Text content of all (for membership checks): \`const names = await page.locator('.cart_item .inventory_item_name').allTextContents(); expect(names).toContain('Sauce Labs Backpack');\`
- BANNED: asserting that an "Add to cart"-style button now shows text "Remove" using the SAME selector. Many apps (saucedemo included) REPLACE the add button with a separate remove button that has its OWN data-test/id. The original add selector no longer exists in the DOM after click.
  - DO NOT: \`await expect(page.locator('#add-to-cart-sauce-labs-bolt-t-shirt')).toHaveText('Remove')\`
  - INSTEAD pick ONE of these verifiable signals:
    a) Cart badge incremented: \`await expect(page.locator('.shopping_cart_badge')).toHaveText('1')\`
    b) Remove button is now visible: \`await expect(page.locator('#remove-sauce-labs-bolt-t-shirt')).toBeVisible()\` (note the \`remove-\` prefix replaces \`add-to-cart-\` in saucedemo's selector pattern)
    c) Item appears in the cart view (after clicking the cart icon)

==== STABLE-SELECTOR PRIORITY (ALWAYS use highest-available) ====
1. data-test / data-testid attribute (from REAL PAGE CONTEXT if listed)
2. id attribute
3. name attribute on form inputs
4. getByRole + name, ONLY when the role+name pair is unambiguous on that page
5. getByText, ONLY for unique static labels (e.g. headings) — never for repeating product names

- Test Naming: Do NOT include 'TC-N' inside the test description string (e.g. use test('Login success', ...) NOT test('TC-1 Login success', ...)) as the UI adds the prefix automatically.
- Include proper assertions using expect()
- Use page.goto(), page.fill(), page.click(), page.waitForSelector() as appropriate
- Add page.screenshot({ path: 'screenshots/<test-name>.png' }) at the end of each test for evidence
- Include beforeEach hook for common login if tests share the same auth flow
- Do NOT call test.setTimeout() inside individual tests — the project's playwright.config.ts already sets a 90s per-test budget that covers hooks. Calling test.setTimeout(60000) inside the test body shortens the remaining budget AFTER beforeEach has already run, which is why slow logins time out. Leave timeouts to the config.
- Output ONLY the TypeScript code, no markdown fences, no explanation`;

        const response = await openai.chat.completions.create({
            model: llmConfig.model || 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
        });

        let scriptContent = response.choices[0]?.message?.content || '';
        
        // --- Aggressive Sanitization ---
        // 1. If code fences exist, extract ONLY the content inside them
        const fenceMatch = scriptContent.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```/i);
        if (fenceMatch && fenceMatch[1]) {
            scriptContent = fenceMatch[1];
        } else {
            // 2. If no fences, find the first 'import' and strip everything before it
            const importIndex = scriptContent.indexOf('import ');
            if (importIndex !== -1) {
                scriptContent = scriptContent.substring(importIndex);
            }
            // 3. Remove any trailing backticks or markdown markers that might be left
            scriptContent = scriptContent.replace(/```/g, '');
        }
        
        scriptContent = scriptContent.trim();

        // --- Deterministic guardrails ---
        // Catches a small set of high-recurrence LLM mistakes regardless of
        // prompt compliance. Same function is also applied to healed test
        // code in healer.ts so the healing pass can't re-introduce a fix
        // we've already deterministically eliminated.
        const guarded = applyGuardrails(scriptContent);
        scriptContent = guarded.code;
        if (guarded.notes.length) {
            console.log(`🛡️ Guardrails applied: ${guarded.notes.join('; ')}`);
        }

        // Sanitize product name for folder/file usage
        const safeName = (productName || 'Project').replace(/[^a-zA-Z0-9_-]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const timeStr = new Date().toTimeString().slice(0, 5).replace(':', ''); // HHMM

        // Create product-specific sub-folder
        const productDir = path.join(testsGeneratedDir, safeName);
        if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });

        const filename = `${safeName}_${dateStr}_${timeStr}.spec.ts`;
        const fullScriptPath = path.join(productDir, filename);
        const relativeScriptPath = path.relative(projectRoot, fullScriptPath).replace(/\\/g, '/');

        fs.writeFileSync(fullScriptPath, scriptContent, 'utf8');
        console.log(`✅ Test script saved: ${fullScriptPath}`);

        // Also keep the download copy in reports for backward compat
        const reportFilename = `test_scripts_${Date.now()}.spec.ts`;
        const reportScriptPath = path.join(reportsDir, reportFilename);
        fs.writeFileSync(reportScriptPath, scriptContent, 'utf8');

        res.json({
            success: true,
            scriptUrl: `/reports/${reportFilename}`,
            filePath: relativeScriptPath,
            fullPath: fullScriptPath,
            content: scriptContent
        });
    } catch (error: any) {
        console.error('Script generation error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// List all generated scripts (browsable from UI)
// Match `test('name', ...)`, `test.skip('name', ...)`, `test.only('name', ...)`
// and the same with double quotes / backticks. Ignores `test.describe`.
const TEST_NAME_REGEX = /\btest(?:\.(?:skip|only|fixme))?\s*\(\s*(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`)/g;

function extractTestNames(filePath: string): string[] {
    try {
        const src = fs.readFileSync(filePath, 'utf8');
        const names: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = TEST_NAME_REGEX.exec(src)) !== null) {
            const name = m[1] ?? m[2] ?? m[3] ?? '';
            if (name) names.push(name);
        }
        return names;
    } catch {
        return [];
    }
}

interface ScriptListEntry {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    created: string;
    tests: { name: string; status?: 'PASS' | 'FAIL' | 'SKIPPED'; duration?: number; error?: string }[];
    lastRun?: {
        executedAt: string;
        passed: number;
        failed: number;
        skipped: number;
        total: number;
        duration: number;
    };
}

app.get('/api/list-scripts', (_req, res) => {
    try {
        const scripts: ScriptListEntry[] = [];
        if (!fs.existsSync(testsGeneratedDir)) return res.json({ scripts: [] });

        const products = fs.readdirSync(testsGeneratedDir);
        for (const product of products) {
            const productPath = path.join(testsGeneratedDir, product);
            if (!fs.statSync(productPath).isDirectory()) continue;
            const files = fs.readdirSync(productPath).filter(f => f.endsWith('.spec.ts'));
            for (const file of files) {
                const filePath = path.join(productPath, file);
                const stat = fs.statSync(filePath);

                // Load last-run sidecar (if any) and key per-test status by name.
                const sidecarPath = filePath + '.last-run.json';
                let lastRun: ScriptListEntry['lastRun'];
                const statusByName: Record<string, { status: 'PASS' | 'FAIL' | 'SKIPPED'; duration?: number; error?: string }> = {};
                if (fs.existsSync(sidecarPath)) {
                    try {
                        const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
                        lastRun = {
                            executedAt: raw.executedAt,
                            passed: raw.passed || 0,
                            failed: raw.failed || 0,
                            skipped: raw.skipped || 0,
                            total: raw.total || 0,
                            duration: raw.duration || 0,
                        };
                        if (Array.isArray(raw.tests)) {
                            for (const t of raw.tests) {
                                if (t?.name) statusByName[t.name] = { status: t.status, duration: t.duration, error: t.error };
                            }
                        }
                    } catch (e: any) {
                        console.warn(`⚠️ Could not parse sidecar ${sidecarPath}: ${e.message}`);
                    }
                }

                const tests = extractTestNames(filePath).map((name) => ({
                    name,
                    ...(statusByName[name] || {}),
                }));

                scripts.push({
                    name: file,
                    path: filePath,
                    relativePath: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
                    size: stat.size,
                    created: stat.birthtime.toISOString(),
                    tests,
                    lastRun,
                });
            }
        }
        // Most recent first
        scripts.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
        res.json({ scripts });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Run a generated script using Playwright CLI
app.post('/api/run-playwright', async (req, res) => {
    try {
        const { scriptPath, headed, llmConfig, autoHeal } = req.body;
        if (!scriptPath) return res.status(400).json({ success: false, error: 'Missing scriptPath' });

        // Security: ensure path is inside tests/generated
        const resolvedPath = path.resolve(scriptPath);
        if (!resolvedPath.startsWith(testsGeneratedDir)) {
            return res.status(403).json({ success: false, error: 'Access denied: path outside tests/generated' });
        }
        if (!fs.existsSync(resolvedPath)) {
            return res.status(404).json({ success: false, error: 'Script file not found' });
        }

        const { spawn } = await import('child_process');
        
        // Use the local playwright binary in the project root's node_modules
        const playwrightBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
        
        if (!fs.existsSync(playwrightBin)) {
            console.error(`❌ Playwright binary not found at: ${playwrightBin}`);
            return res.status(500).json({ success: false, error: 'Playwright test runner not found.' });
        }

        const relativePath = path.relative(projectRoot, resolvedPath).replace(/\\/g, '/');
        const reportPath = path.join(projectRoot, 'temp-report.json');
        const runId = Date.now();
        const htmlReportRelPath = `html-reports/report_${runId}`;
        
        // Use 'list', 'json', and 'html' reporters. Add --headed when the user
        // wants to watch the browser run; default is headless (faster, no window).
        const playwrightArgs = ['test', relativePath, '--reporter=list,json,html'];
        if (headed) playwrightArgs.push('--headed');
        const child = spawn(playwrightBin, playwrightArgs, {
            cwd: projectRoot,
            shell: true,
            env: { 
                ...process.env, 
                PLAYWRIGHT_JSON_OUTPUT_NAME: 'temp-report.json',
                PLAYWRIGHT_HTML_REPORT: htmlReportRelPath
            }
        });

        // Track for stop button support
        activePlaywrightProcess = child;
        child.on('close', () => { activePlaywrightProcess = null; });

        let stdout = '';
        let stderr = '';

        child.on('error', (err) => {
            console.error('❌ Failed to start Playwright:', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: `Failed to start test runner: ${err.message}` });
            }
        });

        // Track running tests so the polling UI can show per-case progress
        // (the polling endpoint reads executionStatus).
        let scriptTestsSeen = 0;
        executionStatus.currentCase = 'Launching Playwright...';
        executionStatus.action = 'Starting test runner';
        executionStatus.currentCaseId = 'SCRIPT';
        executionStatus.currentCaseName = 'Launching Playwright...';
        executionStatus.progress = 0;
        executionStatus.total = 0;
        executionStatus.isRunning = true;

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            for (const line of chunk.split('\n')) {
                // 1. "Running N tests using K worker(s)" — captures TOTAL up front
                //    so the UI shows "Test X of N" with a real denominator instead of 0.
                const totalMatch = line.match(/Running\s+(\d+)\s+tests?\b/i);
                if (totalMatch) {
                    executionStatus.total = parseInt(totalMatch[1], 10) || 0;
                    executionStatus.action = `Running ${executionStatus.total} tests…`;
                    console.log(`🧮 Total tests to run: ${executionStatus.total}`);
                    continue;
                }
                // 2. Per-test lines from the `list` reporter. Important: the
                //    list reporter only prints ONE line per test (when it
                //    finishes), not a separate "starting" line. Retries print
                //    additional lines like "...(retry #1) (5.1s)" for the
                //    SAME test — those must not double-count.
                //    Examples:
                //      "  ✓  1 [chromium] › path/file.spec.ts:14:3 › Suite › Test title (1.2s)"
                //      "  ✘  2 [chromium] › path/file.spec.ts:30:3 › Other test (5.0s)"
                //      "  ✘  2 [chromium] › path/file.spec.ts:30:3 › Other test (retry #1) (5.0s)"
                if (!line.includes('›')) continue;
                const passed = /^\s*✓/.test(line);
                const failed = /^\s*[✘×✗]/.test(line.trimStart().slice(0, 3));
                if (!passed && !failed) continue;
                const parts = line.split('›');
                let title = parts[parts.length - 1].trim();
                // Strip trailing "(1.2s)" duration
                title = title.replace(/\s*\(\d+(?:\.\d+)?\s*[ms]+\)\s*$/i, '').trim();
                // Detect (and strip) retry suffix so we don't count retries as
                // new tests. The clean title is still useful as the display name.
                const isRetry = /\(retry\s*#\d+\)/i.test(title);
                const cleanTitle = title.replace(/\s*\(retry\s*#\d+\)\s*$/i, '').trim();

                if (!isRetry) {
                    scriptTestsSeen += 1;
                    if (executionStatus.total < scriptTestsSeen) {
                        executionStatus.total = scriptTestsSeen;
                    }
                }
                executionStatus.currentCase = passed ? `✅ Passed: ${cleanTitle}` : `❌ Failed: ${cleanTitle}`;
                executionStatus.currentCaseName = cleanTitle;
                executionStatus.currentCaseId = `T${scriptTestsSeen}`;
                executionStatus.action = passed
                    ? 'Test passed'
                    : isRetry ? `Failed (retry exhausted)` : 'Test failed — Playwright may retry';
                executionStatus.progress = scriptTestsSeen;
                console.log(`🧪 ${passed ? '✓' : '✘'} ${cleanTitle}${isRetry ? ' (retry)' : ''}`);
            }
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', async (code) => {
            if (res.headersSent) return;

            let reportData: any = null;
            try {
                if (fs.existsSync(reportPath)) {
                    reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                }
            } catch (e) {
                console.error('Failed to parse Playwright JSON report:', e);
            }

            if (reportData) {
                const summary = {
                    total: 0,
                    passed: 0,
                    failed: 0,
                    errors: 0,
                    skipped: 0,
                    duration: reportData.stats.duration,
                    executedAt: new Date().toISOString()
                };

                const allResults: any[] = [];
                
                // Recursive function to find all specs in all suites
                const collectSpecs = (suite: any) => {
                    if (suite.specs) {
                        suite.specs.forEach((spec: any) => {
                            const testCase = spec.tests[0];
                            const result = testCase.results[0];
                            // Normalize to uppercase status codes the frontend expects ('PASS'|'FAIL'|'SKIPPED')
                            const status: 'PASS' | 'FAIL' | 'SKIPPED' =
                                result.status === 'passed' ? 'PASS'
                                : result.status === 'skipped' ? 'SKIPPED'
                                : 'FAIL';

                            if (status === 'PASS') summary.passed++;
                            else if (status === 'SKIPPED') summary.skipped++;
                            else summary.failed++;

                            const humanError = humanizePlaywrightError(result.error?.message || '');
                            allResults.push({
                                id: allResults.length + 1,
                                jiraKey: spec.title.match(/TC-\d+/) ? spec.title.match(/TC-\d+/)[0] : 'TS-1',
                                name: spec.title,
                                status,
                                duration: result.duration,
                                steps: result.steps?.map((step: any) => ({
                                    step: step.title,
                                    result: step.error ? humanizePlaywrightError(step.error?.message || 'Step failed') : 'OK',
                                    passed: !step.error,
                                    duration: step.duration
                                })) || [],
                                expectedResult: 'Test should execute successfully',
                                error: humanError,
                                actualResult: status === 'PASS' ? 'Test passed successfully' : (humanError || 'Test failed (no error details available).'),
                                priority: 'High'
                            });
                        });
                    }
                    if (suite.suites) {
                        suite.suites.forEach(collectSpecs);
                    }
                };

                reportData.suites.forEach(collectSpecs);
                summary.total = allResults.length;

                // Write a sidecar JSON next to the spec so the Script Library
                // can show last-run pass/fail badges per test name without
                // scanning the central history store. Best-effort — failing to
                // write the sidecar must not affect the response.
                try {
                    const sidecarPath = resolvedPath + '.last-run.json';
                    const sidecar = {
                        executedAt: summary.executedAt,
                        duration: summary.duration,
                        passed: summary.passed,
                        failed: summary.failed,
                        skipped: summary.skipped,
                        total: summary.total,
                        // Keyed by test title so the library can match by name.
                        tests: allResults.map((r: any) => ({
                            name: r.name,
                            status: r.status,
                            duration: r.duration,
                            error: r.error ? String(r.error).slice(0, 500) : undefined,
                        })),
                    };
                    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
                } catch (sidecarErr: any) {
                    console.warn(`⚠️ Could not write last-run sidecar: ${sidecarErr.message}`);
                }

                const host = req.headers.host || 'localhost:3001';
                const protocol = req.protocol;
                const baseUrl = `${protocol}://${host}`;

                // ── Self-healing pass ─────────────────────────────────────
                // Only runs when the client opted in (autoHeal: true) AND
                // provided llmConfig. If any tests failed, ask the LLM to
                // rewrite just those tests using the failure DOM, then
                // re-run only the healed ones via --grep, then merge.
                let healingApplied: { healed: string[]; skipped: { testName: string; reason: string }[] } | undefined;
                const failedNamesInitial = allResults.filter((r: any) => r.status === 'FAIL').map((r: any) => r.name);
                console.log(`🩹 Healing gate check: autoHeal=${!!autoHeal}, llmConfig=${!!llmConfig}, failures=${failedNamesInitial.length}`);
                if (failedNamesInitial.length > 0 && (!autoHeal || !llmConfig)) {
                    console.log(`🩹 Healing skipped: ${!autoHeal ? 'autoHeal flag is OFF' : ''}${!autoHeal && !llmConfig ? ' AND ' : ''}${!llmConfig ? 'llmConfig missing from request body' : ''}`);
                }
                if (autoHeal && llmConfig && failedNamesInitial.length > 0) {
                    executionStatus.currentCase = `🩹 Self-healing ${failedNamesInitial.length} failed test(s)…`;
                    executionStatus.action = 'Asking LLM to fix selectors based on actual DOM';
                    executionStatus.currentCaseId = 'HEAL';
                    executionStatus.currentCaseName = `Self-healing ${failedNamesInitial.length} test(s)`;
                    console.log(`🩹 ${failedNamesInitial.length} test(s) failed — entering self-healing pass`);

                    try {
                        const healing = await healFailedTests({
                            specPath: resolvedPath,
                            llmConfig,
                            log: (m) => console.log(m),
                        });
                        healingApplied = { healed: healing.healedTests, skipped: healing.skipped };

                        if (healing.healedTests.length > 0) {
                            executionStatus.currentCase = `🩹 Re-running ${healing.healedTests.length} healed test(s)…`;
                            executionStatus.action = 'Verifying that healed selectors work';

                            // Spawn Playwright again, scoped to the healed tests
                            // only. Use --grep with regex-escaped, |-joined titles.
                            const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const grepPattern = healing.healedTests.map(escapeRe).join('|');
                            const retryReportPath = path.join(projectRoot, `temp-report-heal-${Date.now()}.json`);
                            const retryHtmlRel = `html-reports/report_${Date.now()}_heal`;
                            const retryArgs = ['test', relativePath, `--grep=${grepPattern}`, '--reporter=list,json,html'];
                            if (headed) retryArgs.push('--headed');

                            const retryReport: any = await new Promise((resolve) => {
                                const retryChild = spawn(playwrightBin, retryArgs, {
                                    cwd: projectRoot,
                                    shell: true,
                                    env: {
                                        ...process.env,
                                        PLAYWRIGHT_JSON_OUTPUT_NAME: path.basename(retryReportPath),
                                        PLAYWRIGHT_HTML_REPORT: retryHtmlRel,
                                    },
                                });
                                let retryStdout = '';
                                retryChild.stdout.on('data', (d) => { retryStdout += d.toString(); });
                                retryChild.stderr.on('data', () => { /* discarded; failures show up in JSON */ });
                                retryChild.on('close', () => {
                                    try {
                                        if (fs.existsSync(retryReportPath)) {
                                            const json = JSON.parse(fs.readFileSync(retryReportPath, 'utf8'));
                                            fs.unlinkSync(retryReportPath);
                                            resolve(json);
                                        } else {
                                            console.warn('🩹 Healing retry produced no JSON report. stdout tail:', retryStdout.slice(-500));
                                            resolve(null);
                                        }
                                    } catch (e: any) {
                                        console.warn('🩹 Could not parse healing retry report:', e.message);
                                        resolve(null);
                                    }
                                });
                                retryChild.on('error', () => resolve(null));
                            });

                            if (retryReport) {
                                // Build a map of new results by test title
                                const newByName: Record<string, any> = {};
                                const visit = (suite: any) => {
                                    if (suite.specs) for (const s of suite.specs) {
                                        const r = s.tests?.[0]?.results?.[0];
                                        if (r) newByName[s.title] = r;
                                    }
                                    if (suite.suites) suite.suites.forEach(visit);
                                };
                                retryReport.suites?.forEach(visit);

                                // Merge: replace original FAIL entries that were
                                // healed with their new attempt's outcome.
                                for (let i = 0; i < allResults.length; i++) {
                                    const r = allResults[i];
                                    if (!healing.healedTests.includes(r.name)) continue;
                                    const fresh = newByName[r.name];
                                    if (!fresh) continue;
                                    const newStatus: 'PASS' | 'FAIL' | 'SKIPPED' =
                                        fresh.status === 'passed' ? 'PASS'
                                        : fresh.status === 'skipped' ? 'SKIPPED'
                                        : 'FAIL';
                                    // Update summary counters
                                    if (r.status === 'FAIL') summary.failed--;
                                    if (newStatus === 'PASS') summary.passed++;
                                    else if (newStatus === 'SKIPPED') summary.skipped++;
                                    else summary.failed++;
                                    // Replace the result row
                                    const freshHumanError = humanizePlaywrightError(fresh.error?.message || '');
                                    allResults[i] = {
                                        ...r,
                                        status: newStatus,
                                        duration: fresh.duration ?? r.duration,
                                        error: freshHumanError,
                                        actualResult: newStatus === 'PASS'
                                            ? 'Healed: passed after LLM rewrote the failing locators.'
                                            : `Healing attempted but test still failed. ${freshHumanError || ''}`.trim(),
                                        healed: newStatus === 'PASS',
                                        healingFailed: newStatus !== 'PASS',
                                    };
                                }
                                console.log(`🩹 Healing complete: ${healing.healedTests.length} attempted, ${allResults.filter((r: any) => r.healed).length} now passing.`);
                            }
                        } else if (healing.skipped.length > 0) {
                            console.log(`🩹 Healing skipped: ${healing.skipped.map(s => `${s.testName} (${s.reason})`).join(', ')}`);
                        }
                    } catch (healErr: any) {
                        console.error('🩹 Healing pass crashed:', healErr.message);
                    }

                    // Rewrite the sidecar with post-healing results so the
                    // Script Library shows the healed status next time it loads.
                    try {
                        const sidecarPath = resolvedPath + '.last-run.json';
                        fs.writeFileSync(sidecarPath, JSON.stringify({
                            executedAt: summary.executedAt,
                            duration: summary.duration,
                            passed: summary.passed,
                            failed: summary.failed,
                            skipped: summary.skipped,
                            total: summary.total,
                            tests: allResults.map((r: any) => ({
                                name: r.name,
                                status: r.status,
                                duration: r.duration,
                                error: r.error ? String(r.error).slice(0, 500) : undefined,
                                healed: r.healed,
                            })),
                        }, null, 2), 'utf8');
                    } catch { /* sidecar rewrite is best-effort */ }
                }

                res.json({
                    success: true,
                    report: {
                        summary,
                        results: allResults,
                        hasResults: true,
                        htmlReportUrl: `${baseUrl}/${htmlReportRelPath}/index.html`,
                        healing: healingApplied,
                    }
                });
            } else {
                const output = stdout + stderr;
                res.json({
                    success: code === 0,
                    output,
                    passed: (output.match(/✓/g) || []).length,
                    failed: (output.match(/✘/g) || []).length,
                    exitCode: code
                });
            }

            if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
            // Clear the live status so the polling UI knows the run finished.
            executionStatus.isRunning = false;
            executionStatus.currentCase = '';
            executionStatus.action = '';
            executionStatus.progress = 0;
            executionStatus.total = 0;
            executionStatus.currentCaseId = '';
            executionStatus.currentCaseName = '';
        });
    } catch (e: any) {
        executionStatus.isRunning = false;
        res.status(500).json({ success: false, error: e.message });
    }
});

// Health check & Progress Status
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        node: process.version
    });
});

// ── Auth endpoints ──────────────────────────────────────────────────────────
// Frontend calls /api/auth/status on boot to decide whether to gate the UI.
app.get('/api/auth/status', (_req, res) => {
    res.json({
        enabled: isAuthEnabled(),
        anyUserExists: hasAnyUser(),
    });
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'username and password required' });
        const user = await authenticateUser(username, password);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const token = signToken({ sub: user.username, role: user.role });
        res.json({ token, user: { username: user.username, role: user.role } });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, role } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'username and password required' });
        // First-ever account becomes the admin (matches the carve-out in authMiddleware)
        const effectiveRole = hasAnyUser() ? (role === 'admin' ? 'admin' : 'user') : 'admin';
        // If users already exist, only an admin can mint new ones
        if (hasAnyUser() && isAuthEnabled() && req.auth?.role !== 'admin') {
            return res.status(403).json({ error: 'Admin role required to create users' });
        }
        const user = await registerUser(username, password, effectiveRole);
        res.json({ user: { username: user.username, role: user.role } });
    } catch (e: any) {
        const msg = e.message || 'Failed to create user';
        const code = msg.includes('exists') ? 409 : 400;
        res.status(code).json({ error: msg });
    }
});

app.get('/api/auth/me', (req, res) => {
    if (!isAuthEnabled()) return res.json({ enabled: false });
    if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ enabled: true, user: req.auth });
});

app.get('/api/auth/users', requireAdmin, (_req, res) => {
    res.json({ users: listUsers() });
});

// Delete a user. Admin-only. Two safety rails:
//  1) Can't delete yourself (would lock you out of the panel mid-action)
//  2) Can't delete the last admin (would lock out the whole system)
app.delete('/api/auth/users/:username', requireAdmin, (req, res) => {
    const target = String(req.params.username || '').trim();
    if (!target) return res.status(400).json({ error: 'Username required' });
    if (req.auth?.sub?.toLowerCase() === target.toLowerCase()) {
        return res.status(400).json({ error: 'You cannot delete your own account from this panel. Sign in as a different admin first.' });
    }
    // Only block if the target IS an admin AND it's the last admin.
    const targetIsAdmin = listUsers().some(u => u.username.toLowerCase() === target.toLowerCase() && u.role === 'admin');
    if (targetIsAdmin && countAdmins() <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last remaining admin — promote another user to admin first.' });
    }
    const removed = deleteUser(target);
    if (!removed) return res.status(404).json({ error: `User "${target}" not found` });
    res.json({ success: true, username: target });
});


app.get('/api/execution-status', (_req, res) => {
    res.json(executionStatus);
});

// Jira Proxy to bypass CORS
// ── Jira ADF → plain text ────────────────────────────────────────────────
// Jira Cloud's REST v3 returns issue descriptions as ADF (Atlassian Document
// Format) — a JSON tree, NOT a string. Naively JSON.stringify-ing it dumps
// unreadable markup into the LLM context AND hides any URL the author entered,
// because links/smart-links store the actual href in marks/attrs, not in the
// visible text. This walker produces clean text and ALWAYS surfaces URLs
// (link hrefs, inline/smart cards) so downstream test generation can ground
// its steps and preconditions on the real application URL.
function adfToText(node: any): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(adfToText).join('');

    switch (node.type) {
        case 'doc':
            return (node.content || []).map(adfToText).join('\n');
        case 'paragraph':
        case 'heading':
            return (node.content || []).map(adfToText).join('') + '\n';
        case 'text': {
            const t = node.text || '';
            const link = (node.marks || []).find((m: any) => m.type === 'link');
            const href = link?.attrs?.href;
            if (href && href !== t) return `${t} (${href})`;
            if (href) return href;
            return t;
        }
        case 'hardBreak':
            return '\n';
        case 'inlineCard':
        case 'blockCard':
        case 'embedCard':
            return node.attrs?.url ? `${node.attrs.url} ` : '';
        case 'bulletList':
            return (node.content || []).map((li: any) => `- ${adfToText(li).trim()}`).join('\n') + '\n';
        case 'orderedList':
            return (node.content || []).map((li: any, i: number) => `${i + 1}. ${adfToText(li).trim()}`).join('\n') + '\n';
        case 'listItem':
        case 'blockquote':
        case 'codeBlock':
            return (node.content || []).map(adfToText).join('') + '\n';
        case 'rule':
        case 'mediaSingle':
        case 'mediaGroup':
            return '';
        case 'table':
            return (node.content || []).map(adfToText).join('\n') + '\n';
        case 'tableRow':
            return (node.content || []).map((c: any) => adfToText(c).trim()).join(' | ');
        case 'tableHeader':
        case 'tableCell':
            return (node.content || []).map(adfToText).join(' ');
        default:
            if (node.content) return (node.content || []).map(adfToText).join('');
            if (node.attrs?.url) return String(node.attrs.url);
            if (node.text) return String(node.text);
            return '';
    }
}

// Convert a Jira description field (ADF object | string | null) to clean text.
function jiraDescriptionToText(desc: any): string {
    if (!desc) return '';
    if (typeof desc === 'string') return desc;
    try {
        return adfToText(desc).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch {
        return typeof desc === 'object' ? JSON.stringify(desc) : String(desc);
    }
}

app.post('/api/jira/search', async (req, res) => {
    try {
        const { connection, projectKey, sprintVersion } = req.body;
        if (!connection || !projectKey) {
            return res.status(400).json({ error: 'Missing connection or projectKey' });
        }

        const { url, email, apiToken } = connection;
        const baseUrl = url.split('?')[0].replace(/\/$/, '');
        const endpointArr = [`${baseUrl}/rest/api/3/search/jql`, `${baseUrl}/rest/api/3/search`];
        
        const isIssueKey = /-[0-9]+/.test(projectKey);
        let jql = '';
        if (isIssueKey) {
            const issues = projectKey.split(',').map((s: string) => s.trim()).join('","');
            jql = `issue IN ("${issues}")`;
        } else {
            jql = `project = "${projectKey}"`;
            if (sprintVersion) {
                jql += ` AND (fixVersion = "${sprintVersion}" OR sprint = "${sprintVersion}")`;
            }
            jql += ` AND issuetype IN (Story, Bug, Task)`;
        }

        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

        let lastError = null;
        for (const urlEndpoint of endpointArr) {
            try {
                const response = await axios.get(urlEndpoint, {
                    params: { jql, maxResults: 50, fields: 'summary,description,status' },
                    headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
                });

                const issues = response.data.issues.map((issue: any) => ({
                    id: issue.id,
                    key: issue.key,
                    summary: issue.fields.summary,
                    description: jiraDescriptionToText(issue.fields.description),
                    status: issue.fields.status.name
                }));
                return res.json({ issues });
            } catch (error: any) {
                lastError = error;
            }
        }
        
        if (lastError) throw lastError;
        res.json({ issues: [] });
    } catch (error: any) {
        console.error('Jira Proxy Error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data?.errorMessages?.[0] || error.message });
    }
});

app.post('/api/jira/verify', async (req, res) => {
    try {
        let { url, email, apiToken } = req.body;
        if (!url || !email || !apiToken) {
            return res.status(400).json({ error: 'Missing connection details (URL, Email, or Token)' });
        }

        // Ensure URL has a protocol
        if (!url.startsWith('http')) {
            url = `https://${url}`;
        }

        const baseUrl = url.split('?')[0].replace(/\/$/, '');
        const endpoint = `${baseUrl}/rest/api/3/myself`;
        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

        console.log(`🔍 Verifying Jira connection to: ${endpoint}`);

        const response = await axios.get(endpoint, {
            headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
            timeout: 10000 // 10s timeout
        });
        
        console.log(`✅ Jira verified: ${response.data.displayName || response.data.emailAddress}`);
        res.json({ status: 'success', data: response.data });
    } catch (error: any) {
        console.error('❌ Jira Verify Error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data));
            const msg = error.response.data?.errorMessages?.[0] || error.response.data?.message || error.message;
            res.status(error.response.status).json({ error: msg });
        } else if (error.request) {
            console.error('   No response received from Jira. This usually means a network/proxy issue or invalid URL.');
            res.status(500).json({ error: 'Network error: Jira instance unreachable. Check your URL and network/proxy settings.' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// ─── Jira Bug Creation Endpoint ───
app.post('/api/jira/create-bug', async (req, res) => {
    try {
        const { connection, projectKey, testCase } = req.body;

        if (!connection || !projectKey || !testCase) {
            return res.status(400).json({ success: false, error: 'Missing connection, projectKey, or testCase' });
        }

        const { url, email, apiToken } = connection;
        const baseUrl = url.split('?')[0].replace(/\/$/, '');
        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

        // Build ADF (Atlassian Document Format) description
        const descriptionParts: any[] = [];

        // Header
        descriptionParts.push({
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: '🐛 Auto-Generated Bug Report' }]
        });

        // Test Case Info
        descriptionParts.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Test Case: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: `TC-${testCase.id} ${testCase.name}` }
            ]
        });

        descriptionParts.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Priority: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: testCase.priority || 'Medium' }
            ]
        });

        // Error Details
        if (testCase.error) {
            descriptionParts.push({
                type: 'heading',
                attrs: { level: 4 },
                content: [{ type: 'text', text: '❌ Error Details' }]
            });
            descriptionParts.push({
                type: 'codeBlock',
                attrs: { language: 'text' },
                content: [{ type: 'text', text: testCase.error.substring(0, 2000) }]
            });
        }

        // Expected vs Actual
        descriptionParts.push({
            type: 'heading',
            attrs: { level: 4 },
            content: [{ type: 'text', text: '📋 Expected vs Actual' }]
        });
        descriptionParts.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Expected: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: testCase.expectedResult || 'N/A' }
            ]
        });
        descriptionParts.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Actual: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: testCase.actualResult || 'N/A' }
            ]
        });

        // Steps
        if (testCase.steps && testCase.steps.length > 0) {
            descriptionParts.push({
                type: 'heading',
                attrs: { level: 4 },
                content: [{ type: 'text', text: '🔄 Steps to Reproduce' }]
            });

            const stepItems = testCase.steps.map((step: any) => ({
                type: 'listItem',
                content: [{
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: `${step.step || step}` },
                        ...(step.passed === false ? [{ type: 'text', text: ' ❌ FAILED', marks: [{ type: 'strong' }] }] : [])
                    ]
                }]
            }));

            descriptionParts.push({
                type: 'orderedList',
                attrs: { order: 1 },
                content: stepItems
            });
        }

        // Environment info
        descriptionParts.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: `\n🤖 Filed by: Intelligent Test Planning Agent | Duration: ${((testCase.duration || 0) / 1000).toFixed(1)}s`, marks: [{ type: 'em' }] }
            ]
        });

        // Map priority to Jira priority names
        const priorityMap: Record<string, string> = {
            'High': 'High',
            'high': 'High',
            'MEDIUM': 'Medium',
            'Medium': 'Medium',
            'medium': 'Medium',
            'Low': 'Low',
            'low': 'Low'
        };

        // Fallback: If projectKey is still missing or looks like an ID, try to extract from testCase.jiraKey
        let finalProjectKey = projectKey;
        
        // Sanitize: If the key contains a dash (like KAN-2), it's likely an issue key, not a project key
        if (finalProjectKey && finalProjectKey.includes('-')) {
            finalProjectKey = finalProjectKey.split('-')[0];
        }

        if ((!finalProjectKey || finalProjectKey === 'undefined' || finalProjectKey === '') && testCase.jiraKey) {
            const match = testCase.jiraKey.match(/^([A-Z0-9]+)-/);
            if (match) finalProjectKey = match[1];
        }

        console.log(`🐛 Attempting to create Jira bug:`);
        console.log(`   Project Key: "${finalProjectKey}"`);
        console.log(`   Test Case: ${testCase.name} (${testCase.jiraKey})`);

        if (!finalProjectKey) {
            throw new Error('Could not determine a valid Jira Project Key. Please ensure issues have keys like PROJ-123.');
        }

        const issuePayload = {
            fields: {
                project: { key: finalProjectKey },
                summary: `[Auto-Bug] ${testCase.name}`,
                description: {
                    type: 'doc',
                    version: 1,
                    content: descriptionParts
                },
                issuetype: { name: 'Bug' },
                priority: { name: priorityMap[testCase.priority] || 'Medium' }
            }
        };

        console.log(`🐛 Creating Jira bug for: ${testCase.name}`);
        console.log(`   Project: ${projectKey}`);

        const response = await axios.post(
            `${baseUrl}/rest/api/3/issue`,
            issuePayload,
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const issueKey = response.data.key;
        const issueUrl = `${baseUrl}/browse/${issueKey}`;

        console.log(`✅ Bug created: ${issueKey} → ${issueUrl}`);

        res.json({
            success: true,
            issueKey,
            issueUrl,
            message: `Bug ${issueKey} created successfully`
        });
    } catch (error: any) {
        const errorData = error.response?.data;
        console.error('❌ Jira Bug API Error Details:', JSON.stringify(errorData || error.message, null, 2));
        
        let detailedError = 'Failed to create bug';
        if (errorData?.errors) {
            detailedError = Object.entries(errorData.errors)
                .map(([field, msg]) => `${field}: ${msg}`)
                .join(', ');
        } else if (errorData?.errorMessages && errorData.errorMessages.length > 0) {
            detailedError = errorData.errorMessages.join(', ');
        } else {
            detailedError = error.message || 'Unknown error';
        }

        res.status(500).json({ 
            success: false, 
            error: detailedError 
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  Jira Test Sync — push test cases and sync execution results back to Jira
//
//  Strategy: create each test case as a Jira issue. If a parent issue key
//  is provided (e.g. the user's story "KAN-5"), the issue is a Sub-task
//  linked to that parent; otherwise it's a standalone Task. After execution,
//  results are reflected as comments on those issues + a pass/fail label.
//  We deliberately avoid workflow transitions, which vary per-project.
// ════════════════════════════════════════════════════════════════════════════

// Build the ADF (Atlassian Document Format) description for a test-case issue.
function buildTestCaseDescription(tc: any) {
    const blocks: any[] = [
        {
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: 'Test Case' }],
        },
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Priority: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: String(tc.priority || 'Medium') },
            ],
        },
    ];
    if (tc.preconditions) {
        blocks.push(
            { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Preconditions' }] },
            { type: 'paragraph', content: [{ type: 'text', text: String(tc.preconditions) }] }
        );
    }
    if (tc.expectedResult) {
        blocks.push(
            { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Expected Result' }] },
            { type: 'paragraph', content: [{ type: 'text', text: String(tc.expectedResult) }] }
        );
    }
    if (Array.isArray(tc.steps) && tc.steps.length > 0) {
        blocks.push({ type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Steps' }] });
        blocks.push({
            type: 'orderedList',
            attrs: { order: 1 },
            content: tc.steps.map((step: any) => ({
                type: 'listItem',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: typeof step === 'string' ? step : (step.step || step.name || '') }],
                }],
            })),
        });
    }
    if (tc.testData) {
        blocks.push(
            { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Test Data' }] },
            { type: 'paragraph', content: [{ type: 'text', text: String(tc.testData) }] }
        );
    }
    blocks.push({
        type: 'paragraph',
        content: [{
            type: 'text',
            text: '\nGenerated by Intelligent Test Planning Agent',
            marks: [{ type: 'em' }],
        }],
    });
    return { type: 'doc', version: 1, content: blocks };
}

// ─── Push test cases to Jira ────────────────────────────────────────────────
app.post('/api/jira/push-test-cases', async (req, res) => {
    try {
        const { connection, projectKey, parentIssueKey, testCases, provider } = req.body as {
            connection: { url: string; email: string; apiToken: string };
            projectKey: string;
            parentIssueKey?: string;
            testCases: any[];
            provider?: 'jira-native' | 'xray';
        };

        if (!connection || !projectKey || !Array.isArray(testCases) || testCases.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing connection, projectKey, or testCases' });
        }

        const { url, email, apiToken } = connection;
        const baseUrl = url.split('?')[0].replace(/\/$/, '');
        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
        const authHeaders = {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        };
        const useXray = provider === 'xray';

        // Strip suffix if user accidentally passed an issue key (e.g. "KAN-5") as project key
        let cleanProjectKey = projectKey;
        if (cleanProjectKey.includes('-')) cleanProjectKey = cleanProjectKey.split('-')[0];

        const priorityMap: Record<string, string> = {
            high: 'High', High: 'High', HIGH: 'High',
            medium: 'Medium', Medium: 'Medium', MEDIUM: 'Medium',
            low: 'Low', Low: 'Low', LOW: 'Low',
        };

        // ── Discover available issue types for THIS project ───────────────
        // Different Jira projects expose different issue type names: a
        // company-managed project might have "Sub-task", a team-managed one
        // may only have "Task"/"Story", an Xray install adds "Test", etc.
        // We query createmeta once, pick the best available name, and use it
        // for the whole batch. Falls back to defaults if the call fails.
        let availableTypes: { name: string; subtask: boolean }[] = [];
        try {
            const meta = await axios.get(
                `${baseUrl}/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(cleanProjectKey)}&expand=projects.issuetypes`,
                { headers: authHeaders, timeout: 12000 }
            );
            const project = meta.data?.projects?.[0];
            if (project?.issuetypes) {
                availableTypes = project.issuetypes.map((it: any) => ({
                    name: it.name,
                    subtask: !!it.subtask,
                }));
            }
        } catch (e: any) {
            console.warn(`⚠️ createmeta query failed (${e.message}) — using default issue type names`);
        }
        const availableNames = availableTypes.map((t) => t.name);
        const subtaskTypeName = availableTypes.find((t) => t.subtask)?.name; // first available subtask type

        // Pick the first preferred name that the project actually exposes.
        // If we couldn't query the project (permissions), keep the preferred
        // list as-is and let Jira's error bubble back to the user.
        const pickIssueType = (preferred: string[]): string => {
            if (availableNames.length === 0) return preferred[0];
            for (const name of preferred) {
                const found = availableNames.find((n) => n.toLowerCase() === name.toLowerCase());
                if (found) return found;
            }
            // Last resort: any non-subtask, non-epic issue type
            const fallback = availableTypes.find(
                (t) => !t.subtask && !/^epic$/i.test(t.name)
            );
            return fallback?.name || availableNames[0];
        };

        const primaryIssueType = useXray
            ? pickIssueType(['Test', 'Task', 'Story'])
            : parentIssueKey
                ? (subtaskTypeName || pickIssueType(['Sub-task', 'Subtask', 'Task']))
                : pickIssueType(['Task', 'Story', 'Bug']);

        const labelBase = useXray ? ['auto-generated-test', 'xray'] : ['auto-generated-test'];

        // If we successfully queried createmeta and Sub-task isn't actually
        // available, drop the parent link — sticking it on a Task fails.
        const willLinkParent = !!parentIssueKey && !useXray && availableTypes.some((t) => t.subtask && t.name === primaryIssueType);

        const mapping: Record<string, string> = {};
        const errors: { tcId: string; error: string }[] = [];
        console.log(`📋 Issue type chosen for ${cleanProjectKey}: "${primaryIssueType}" (available: ${availableNames.join(', ') || '?'})`);

        // Sequential to keep error attribution clean; parallel would race on rate limits anyway.
        for (const tc of testCases) {
            const tcId = String(tc.tcId || tc.id || `TC-${Object.keys(mapping).length + 1}`);
            try {
                const fields: any = {
                    project: { key: cleanProjectKey },
                    summary: `[Test] ${tc.name || tcId}`.slice(0, 250),
                    description: buildTestCaseDescription(tc),
                    issuetype: { name: primaryIssueType },
                    priority: { name: priorityMap[tc.priority] || 'Medium' },
                    labels: willLinkParent ? labelBase : [...labelBase, ...(parentIssueKey ? [`parent-${parentIssueKey}`] : [])],
                };
                if (willLinkParent) {
                    fields.parent = { key: parentIssueKey };
                }

                const response = await axios.post(
                    `${baseUrl}/rest/api/3/issue`,
                    { fields },
                    { headers: authHeaders, timeout: 15000 }
                );
                const issueKey = response.data.key;
                mapping[tcId] = issueKey;
                console.log(`✅ Pushed ${tcId} → ${issueKey} (${primaryIssueType})`);
            } catch (err: any) {
                const errData = err.response?.data;
                let detail =
                    errData?.errors
                        ? Object.entries(errData.errors).map(([f, m]) => `${f}: ${m}`).join(', ')
                        : errData?.errorMessages?.join(', ') || err.message || 'Unknown error';

                // Fallback A: priority field rejected (some projects disable priority)
                // — retry without it
                if (/priority/i.test(detail)) {
                    try {
                        const retryFields: any = {
                            project: { key: cleanProjectKey },
                            summary: `[Test] ${tc.name || tcId}`.slice(0, 250),
                            description: buildTestCaseDescription(tc),
                            issuetype: { name: primaryIssueType },
                            labels: labelBase,
                        };
                        if (willLinkParent) retryFields.parent = { key: parentIssueKey };
                        const retry = await axios.post(`${baseUrl}/rest/api/3/issue`, { fields: retryFields }, { headers: authHeaders, timeout: 15000 });
                        mapping[tcId] = retry.data.key;
                        console.log(`✅ Pushed ${tcId} → ${retry.data.key} (no priority)`);
                        continue;
                    } catch (retryErr: any) {
                        detail = retryErr.response?.data?.errors
                            ? Object.entries(retryErr.response.data.errors).map(([f, m]) => `${f}: ${m}`).join(', ')
                            : retryErr.response?.data?.errorMessages?.join(', ') || retryErr.message || detail;
                    }
                }

                // Fallback B: issuetype rejected — walk available alternatives.
                // Triggers on "Specify a valid issue type", "Specify an issue type",
                // or any error mentioning issuetype/subtask.
                if (/issuetype|sub-?task|specify (an? )?(valid )?issue type/i.test(detail)) {
                    const tried = new Set<string>([primaryIssueType.toLowerCase()]);
                    const candidates = (availableNames.length > 0
                        ? availableNames
                        : ['Task', 'Story', 'Bug']
                    ).filter((n) => !tried.has(n.toLowerCase()) && !/^epic$/i.test(n));

                    let retriedOk = false;
                    for (const candidate of candidates) {
                        try {
                            const retryFields: any = {
                                project: { key: cleanProjectKey },
                                summary: `[Test] ${tc.name || tcId}`.slice(0, 250),
                                description: buildTestCaseDescription(tc),
                                issuetype: { name: candidate },
                                labels: [...labelBase, ...(parentIssueKey ? [`parent-${parentIssueKey}`] : [])],
                            };
                            // Only re-link a parent if the new candidate is also a sub-task type
                            const isCandidateSubtask = availableTypes.find((t) => t.name === candidate)?.subtask;
                            if (parentIssueKey && !useXray && isCandidateSubtask) {
                                retryFields.parent = { key: parentIssueKey };
                            }
                            const retry = await axios.post(`${baseUrl}/rest/api/3/issue`, { fields: retryFields }, { headers: authHeaders, timeout: 15000 });
                            mapping[tcId] = retry.data.key;
                            console.log(`✅ Pushed ${tcId} → ${retry.data.key} (fallback to "${candidate}")`);
                            retriedOk = true;
                            break;
                        } catch (retryErr: any) {
                            const subDetail = retryErr.response?.data?.errors
                                ? Object.entries(retryErr.response.data.errors).map(([f, m]) => `${f}: ${m}`).join(', ')
                                : retryErr.response?.data?.errorMessages?.join(', ') || retryErr.message;
                            console.log(`   fallback "${candidate}" failed: ${subDetail}`);
                            detail = subDetail || detail;
                        }
                    }
                    if (retriedOk) continue;

                    // Augment the final error so the user sees what we tried.
                    detail = `${detail} | tried: ${[primaryIssueType, ...candidates].join(', ')} | available: ${availableNames.join(', ') || 'unknown'}`;
                }
                console.error(`❌ Failed to push ${tcId}: ${detail}`);
                errors.push({ tcId, error: detail });
            }
        }

        res.json({
            success: errors.length === 0,
            mapping,
            errors,
            baseUrl,
            count: Object.keys(mapping).length,
            total: testCases.length,
        });
    } catch (error: any) {
        console.error('❌ push-test-cases error:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Unexpected error' });
    }
});

// ─── Sync execution results to Jira (post comments + labels) ────────────────
app.post('/api/jira/update-execution-status', async (req, res) => {
    try {
        const { connection, results, provider, projectKey, transitionOnSuccess } = req.body as {
            connection: { url: string; email: string; apiToken: string };
            results: Array<{
                tcId: string;
                jiraKey: string;
                status: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR';
                duration?: number;
                actualResult?: string;
                error?: string;
            }>;
            provider?: 'jira-native' | 'xray';
            projectKey?: string;
            // When true, also transition the Jira issue to a "Done"-like status
            // on PASS (and to "In Progress" / "To Do" on FAIL/ERROR if those
            // transitions exist). Off by default to preserve previous behavior.
            transitionOnSuccess?: boolean;
        };

        if (!connection || !Array.isArray(results) || results.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing connection or results' });
        }
        const useXray = provider === 'xray';

        const { url, email, apiToken } = connection;
        const baseUrl = url.split('?')[0].replace(/\/$/, '');
        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
        const headers = {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        };

        const updated: { jiraKey: string; status: string }[] = [];
        const errors: { jiraKey: string; error: string }[] = [];

        for (const r of results) {
            if (!r.jiraKey) {
                errors.push({ jiraKey: r.tcId, error: 'No Jira key — push this test case first.' });
                continue;
            }
            try {
                const statusEmoji =
                    r.status === 'PASS' ? '✅'
                    : r.status === 'FAIL' ? '❌'
                    : r.status === 'SKIPPED' ? '⏭'
                    : '⚠️';

                const commentBlocks: any[] = [
                    {
                        type: 'heading',
                        attrs: { level: 3 },
                        content: [{ type: 'text', text: `${statusEmoji} Execution: ${r.status}` }],
                    },
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'Time: ', marks: [{ type: 'strong' }] },
                            { type: 'text', text: new Date().toISOString() },
                            { type: 'text', text: '   ·   Duration: ', marks: [{ type: 'strong' }] },
                            { type: 'text', text: `${((r.duration || 0) / 1000).toFixed(2)}s` },
                        ],
                    },
                ];
                if (r.actualResult) {
                    commentBlocks.push({
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'Actual: ', marks: [{ type: 'strong' }] },
                            { type: 'text', text: String(r.actualResult).slice(0, 2000) },
                        ],
                    });
                }
                if (r.error) {
                    commentBlocks.push(
                        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Error' }] },
                        {
                            type: 'codeBlock',
                            attrs: { language: 'text' },
                            content: [{ type: 'text', text: String(r.error).slice(0, 2000) }],
                        }
                    );
                }

                await axios.post(
                    `${baseUrl}/rest/api/3/issue/${encodeURIComponent(r.jiraKey)}/comment`,
                    { body: { type: 'doc', version: 1, content: commentBlocks } },
                    { headers, timeout: 15000 }
                );

                // Best-effort label update so users can filter by execution status in Jira.
                const label =
                    r.status === 'PASS' ? 'test-passed'
                    : r.status === 'FAIL' ? 'test-failed'
                    : r.status === 'SKIPPED' ? 'test-skipped'
                    : 'test-error';

                try {
                    await axios.put(
                        `${baseUrl}/rest/api/3/issue/${encodeURIComponent(r.jiraKey)}`,
                        { update: { labels: [{ add: label }, { remove: 'test-passed' }, { remove: 'test-failed' }, { remove: 'test-skipped' }, { remove: 'test-error' }].filter(op => 'add' in op || op.remove !== label) } },
                        { headers, timeout: 10000 }
                    );
                } catch (labelErr: any) {
                    // Don't fail the whole sync on a label edit error — it's cosmetic
                    console.warn(`⚠️ Could not update labels on ${r.jiraKey}: ${labelErr.message}`);
                }

                // Optional: move the Jira issue's status to reflect the result.
                // Jira workflows vary per project — we list available transitions
                // for the issue and pick the best name match. Failures here are
                // logged but never abort the sync (still cosmetic from the
                // comment/label perspective which already happened above).
                if (transitionOnSuccess) {
                    try {
                        const target =
                            r.status === 'PASS' ? ['Done', 'Closed', 'Resolved', 'Complete']
                            : r.status === 'FAIL' || r.status === 'ERROR' ? ['In Progress', 'Reopened', 'To Do', 'Open']
                            : null;
                        if (target) {
                            const txns = await axios.get(
                                `${baseUrl}/rest/api/3/issue/${encodeURIComponent(r.jiraKey)}/transitions`,
                                { headers, timeout: 10000 }
                            );
                            const available: { id: string; to: { name: string } }[] = txns.data?.transitions || [];
                            let pick: { id: string; to: { name: string } } | undefined;
                            for (const name of target) {
                                pick = available.find(t => t.to?.name?.toLowerCase() === name.toLowerCase());
                                if (pick) break;
                            }
                            if (pick) {
                                await axios.post(
                                    `${baseUrl}/rest/api/3/issue/${encodeURIComponent(r.jiraKey)}/transitions`,
                                    { transition: { id: pick.id } },
                                    { headers, timeout: 10000 }
                                );
                                console.log(`🔁 Transitioned ${r.jiraKey} → ${pick.to.name}`);
                            } else {
                                console.warn(`⚠️ No matching transition on ${r.jiraKey}. Wanted one of [${target.join(', ')}], available: [${available.map(t => t.to?.name).join(', ')}]`);
                            }
                        }
                    } catch (txnErr: any) {
                        console.warn(`⚠️ Status transition failed for ${r.jiraKey}: ${txnErr.response?.data?.errorMessages?.join(', ') || txnErr.message}`);
                    }
                }

                updated.push({ jiraKey: r.jiraKey, status: r.status });
                console.log(`✅ Synced ${r.tcId} (${r.jiraKey}) → ${r.status}`);
            } catch (err: any) {
                const detail =
                    err.response?.data?.errorMessages?.join(', ')
                    || err.response?.data?.error
                    || err.message
                    || 'Unknown error';
                console.error(`❌ Sync failed for ${r.jiraKey}: ${detail}`);
                errors.push({ jiraKey: r.jiraKey, error: detail });
            }
        }

        // ── Xray: also create a Test Execution issue summarizing this run ──
        // Xray's full execution-import endpoint differs between Server and Cloud
        // and requires a custom-field mapping that varies per install. To stay
        // universally compatible we create a standard "Test Execution" issue
        // whose description links every tested issue + status. Users on full
        // Xray installs can later move the link references into the proper
        // Tests custom field, or wire the dedicated import endpoint themselves.
        let testExecutionKey: string | undefined;
        let testExecutionUrl: string | undefined;
        if (useXray && projectKey && updated.length > 0) {
            try {
                let cleanProjectKey = projectKey;
                if (cleanProjectKey.includes('-')) cleanProjectKey = cleanProjectKey.split('-')[0];
                const passed = updated.filter((u) => u.status === 'PASS').length;
                const failed = updated.filter((u) => u.status === 'FAIL').length;
                const tested = updated
                    .slice(0, 50)
                    .map((u) => `${u.jiraKey}: ${u.status}`)
                    .join('\n');
                const summary = `Test Execution — ${passed}/${updated.length} passed (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;
                const description = {
                    type: 'doc',
                    version: 1,
                    content: [
                        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Execution Summary' }] },
                        {
                            type: 'paragraph',
                            content: [
                                { type: 'text', text: 'Passed: ', marks: [{ type: 'strong' }] },
                                { type: 'text', text: `${passed}   ` },
                                { type: 'text', text: 'Failed: ', marks: [{ type: 'strong' }] },
                                { type: 'text', text: `${failed}` },
                            ],
                        },
                        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Tested issues' }] },
                        { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: tested }] },
                    ],
                };
                const exec = await axios.post(
                    `${baseUrl}/rest/api/3/issue`,
                    {
                        fields: {
                            project: { key: cleanProjectKey },
                            summary,
                            description,
                            issuetype: { name: 'Test Execution' },
                            labels: ['auto-generated-test-execution', 'xray'],
                        },
                    },
                    { headers, timeout: 15000 }
                );
                testExecutionKey = exec.data.key;
                testExecutionUrl = `${baseUrl}/browse/${testExecutionKey}`;
                console.log(`✅ Xray Test Execution created: ${testExecutionKey}`);
            } catch (err: any) {
                const detail = err.response?.data?.errorMessages?.join(', ') || err.message;
                console.warn(`⚠️ Could not create Xray Test Execution: ${detail}`);
                errors.push({ jiraKey: 'TestExecution', error: detail });
            }
        }

        res.json({
            success: errors.length === 0,
            updated,
            errors,
            testExecutionKey,
            testExecutionUrl,
            baseUrl,
            count: updated.length,
            total: results.length,
        });
    } catch (error: any) {
        console.error('❌ update-execution-status error:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Unexpected error' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  Input Source Adapters — BRD (PDF/DOCX), HTML, Figma
//  Each endpoint returns a normalized list of items the existing pipeline
//  can consume (shaped like JiraIssue: { id, key, summary, description, status })
// ════════════════════════════════════════════════════════════════════════════

const uploadBrd = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// Heuristic: split long requirement text into discrete "items" (Story-like chunks)
// so the LLM downstream sees structured input rather than one giant blob.
function splitIntoRequirementItems(rawText: string, sourceLabel: string): any[] {
    const text = rawText.replace(/\r\n/g, '\n').trim();
    if (!text) return [];

    // Prefer splitting on markdown-style headings, then numbered/bulleted sections,
    // and fall back to paragraph blocks for unstructured documents.
    const headingSplit = text.split(/\n(?=#{1,6}\s|\d+\.\s+[A-Z]|[A-Z][A-Z\s]{4,}\n)/g);
    const chunks = headingSplit.length > 1
        ? headingSplit
        : text.split(/\n{2,}/g);

    return chunks
        .map((c) => c.trim())
        .filter((c) => c.length > 40)
        .slice(0, 50) // cap to keep prompt sizes manageable
        .map((chunk, idx) => {
            // First non-empty line becomes the summary (heading or first sentence).
            const firstLine = chunk.split('\n')[0].replace(/^#+\s*/, '').trim();
            const summary = firstLine.length > 140
                ? firstLine.slice(0, 137) + '...'
                : firstLine;
            return {
                id: `${sourceLabel}-${idx + 1}`,
                key: `REQ-${idx + 1}`,
                summary: summary || `Requirement ${idx + 1}`,
                description: chunk,
                status: 'Requirement',
            };
        });
}

// ── BRD: PDF or DOCX upload → extracted text → requirement items ─────────────
app.post('/api/input/brd', uploadBrd.single('file'), async (req, res) => {
    try {
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) {
            return res.status(400).json({ success: false, error: 'No file uploaded (expected field name "file")' });
        }

        const filename = file.originalname || 'document';
        const ext = path.extname(filename).toLowerCase();

        let extractedText = '';
        if (ext === '.pdf') {
            // pdf-parse v2 uses a class-based API (PDFParse) instead of v1's function call.
            // Dynamically imported so installation differences between versions don't crash boot.
            const pdfMod: any = await import('pdf-parse');
            const PDFParseCls = pdfMod.PDFParse || pdfMod.default?.PDFParse || pdfMod.default;
            if (typeof PDFParseCls !== 'function') {
                throw new Error('pdf-parse: could not resolve PDFParse export');
            }
            const parser = new PDFParseCls({ data: file.buffer });
            const parsed = await parser.getText();
            extractedText = parsed?.text || '';
        } else if (ext === '.docx') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            extractedText = result.value || '';
        } else if (ext === '.txt' || ext === '.md') {
            extractedText = file.buffer.toString('utf8');
        } else {
            return res.status(400).json({
                success: false,
                error: `Unsupported file type "${ext}". Use .pdf, .docx, .txt, or .md`,
            });
        }

        if (!extractedText.trim()) {
            return res.status(422).json({ success: false, error: 'Document parsed but no text was extracted.' });
        }

        const items = splitIntoRequirementItems(extractedText, 'BRD');
        res.json({
            success: true,
            source: 'brd',
            label: filename,
            items,
            rawText: extractedText.slice(0, 50000), // cap echoed text
        });
    } catch (err: any) {
        console.error('BRD parse error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to parse document' });
    }
});

// Extract clean text + form metadata from a raw HTML blob.
// Returns empty string if nothing usable could be extracted.
function extractTextFromHtml(rawHtml: string): string {
    const $ = cheerio.load(rawHtml);
    $('script, style, noscript, iframe, svg').remove();

    // 1. Semantic prose blocks (preserves heading hierarchy for the splitter).
    const blocks: string[] = [];
    $('h1, h2, h3, h4, p, li').each((_, el) => {
        const tag = (el as any).tagName?.toLowerCase?.() || '';
        const text = $(el).text().trim();
        if (!text) return;
        if (/^h[1-4]$/.test(tag)) {
            blocks.push(`\n\n## ${text}\n`);
        } else {
            blocks.push(text);
        }
    });

    // 2. Form structure — so the LLM knows which fields/buttons exist and can
    //    generate positive AND negative cases against real input names.
    const formChunks: string[] = [];
    $('form').each((idx, formEl) => {
        const $form = $(formEl);
        const lines: string[] = [`\n\n## Form ${idx + 1}`];
        $form.find('input, select, textarea').each((__, el) => {
            const $el = $(el);
            const tagName = ((el as any).tagName || '').toLowerCase();
            const type = $el.attr('type') || tagName || 'text';
            if (type === 'hidden' || type === 'submit' || type === 'button') return;
            const id = $el.attr('id') || '';
            const name = $el.attr('name') || '';
            const placeholder = $el.attr('placeholder') || '';
            const value = $el.attr('value') || '';
            const labelText = id ? $form.find(`label[for="${id}"]`).text().trim() : '';
            const desc = [labelText, name || id, placeholder].filter(Boolean).join(' / ') || '(unnamed)';
            lines.push(`- Field "${desc}" (type=${type}${value ? `, prefilled="${value}"` : ''})`);
        });
        $form.find('button, input[type="submit"], input[type="button"]').each((__, el) => {
            const $el = $(el);
            const text = $el.text().trim() || $el.attr('value') || $el.attr('name') || '';
            if (text) lines.push(`- Button "${text}"`);
        });
        if (lines.length > 1) formChunks.push(lines.join('\n'));
    });

    let extractedText = (blocks.join('\n') + formChunks.join('')).replace(/\n{3,}/g, '\n\n').trim();

    // 3. Coverage check — fall back to body text when the semantic pass missed
    //    significant content (div/span-heavy markup, inline credentials, etc.).
    const fullBodyText = ($('body').text() || $.root().text() || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const semanticChars = extractedText.replace(/\s+/g, '').length;
    const bodyChars = fullBodyText.replace(/\s+/g, '').length;
    if (bodyChars > 0 && semanticChars < bodyChars * 0.6) {
        extractedText = (extractedText + `\n\n## Page Content (full)\n\n${fullBodyText}`).trim();
    } else if (!extractedText) {
        extractedText = fullBodyText;
    }
    return extractedText;
}

type HtmlPageInput = { url?: string; html?: string };

// ── HTML: one or many pages → cleaned text → requirement items ──────────────
// Accepts either:
//   { pages: [{ url?, html? }, ...] }  ← preferred (multi-page UI)
//   { url?, html? }                    ← legacy single-page shape
app.post('/api/input/html', async (req, res) => {
    try {
        const body = req.body as { pages?: HtmlPageInput[]; url?: string; html?: string };
        const pages: HtmlPageInput[] = Array.isArray(body.pages) && body.pages.length > 0
            ? body.pages
            : (body.url || body.html ? [{ url: body.url, html: body.html }] : []);

        if (pages.length === 0) {
            return res.status(400).json({ success: false, error: 'Provide "pages" or "url"/"html" in the body.' });
        }

        const allItems: any[] = [];
        const rawTextChunks: string[] = [];
        let counter = 0;
        const pageLabels: string[] = [];
        const fetchErrors: string[] = [];

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const pageUrl = (page.url || '').trim();
            const pageHtml = page.html || '';

            if (!pageUrl && !pageHtml.trim()) continue; // skip empty rows

            let rawHtml = pageHtml;
            let pageLabel = pageUrl || `pasted-html-${i + 1}`;

            // Only fetch when the user didn't already paste HTML.
            if (!pageHtml.trim() && pageUrl) {
                if (!/^https?:\/\//i.test(pageUrl)) {
                    fetchErrors.push(`Page ${i + 1}: URL "${pageUrl}" must start with http:// or https:// (or paste HTML instead).`);
                    continue;
                }
                try {
                    const response = await axios.get(pageUrl, {
                        timeout: 15000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (TestPlanCreator)' },
                    });
                    rawHtml = String(response.data || '');
                } catch (e: any) {
                    fetchErrors.push(`Page ${i + 1}: failed to fetch ${pageUrl} — ${e.message}`);
                    continue;
                }
            }

            const extractedText = extractTextFromHtml(rawHtml);
            if (!extractedText) continue;

            pageLabels.push(pageLabel);
            rawTextChunks.push(`## Page: ${pageLabel}\n\n${extractedText}`);

            let pageItems = splitIntoRequirementItems(extractedText, `HTML-P${i + 1}`);
            if (pageItems.length === 0) {
                pageItems = [{
                    id: `HTML-P${i + 1}-1`,
                    key: `REQ-${counter + 1}`,
                    summary: extractedText.split('\n')[0].slice(0, 140) || `Page ${i + 1} content`,
                    description: extractedText,
                    status: 'Requirement',
                }];
            }

            // Attach the page's source URL to each item so the LLM uses the right
            // URL per case. Renumber keys to be globally unique across pages.
            for (const item of pageItems) {
                counter += 1;
                item.key = `REQ-${counter}`;
                item.pageUrl = pageUrl;
                item.description = pageUrl
                    ? `Source URL: ${pageUrl}\n\n${item.description}`
                    : item.description;
                allItems.push(item);
            }
        }

        if (allItems.length === 0) {
            const msg = fetchErrors.length
                ? `No usable content extracted. ${fetchErrors.join(' | ')}`
                : 'Could not extract any text from the provided HTML.';
            return res.status(422).json({ success: false, error: msg });
        }

        const label = pageLabels.length === 1
            ? pageLabels[0]
            : `${pageLabels.length} pages`;

        res.json({
            success: true,
            source: 'html',
            label,
            items: allItems,
            rawText: rawTextChunks.join('\n\n').slice(0, 50000),
            warnings: fetchErrors.length ? fetchErrors : undefined,
        });
    } catch (err: any) {
        console.error('HTML parse error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to parse HTML' });
    }
});

// ── Figma: file URL/key + access token → frames + components + text ─────────
app.post('/api/input/figma', async (req, res) => {
    try {
        const { figmaUrl, accessToken } = req.body as { figmaUrl?: string; accessToken?: string };
        if (!figmaUrl || !accessToken) {
            return res.status(400).json({ success: false, error: 'Missing "figmaUrl" or "accessToken".' });
        }

        // Accept either a full URL or a bare file key
        const keyMatch = figmaUrl.match(/(?:file|design)\/([A-Za-z0-9]+)/);
        const fileKey = keyMatch ? keyMatch[1] : figmaUrl.trim();
        if (!fileKey || fileKey.length < 6) {
            return res.status(400).json({ success: false, error: 'Could not parse Figma file key from URL.' });
        }

        let fileResp;
        try {
            fileResp = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
                headers: { 'X-Figma-Token': accessToken },
                timeout: 20000,
            });
        } catch (e: any) {
            const status = e.response?.status;
            const msg = e.response?.data?.err || e.message;
            return res.status(502).json({ success: false, error: `Figma API error (${status}): ${msg}` });
        }

        const docName = fileResp.data?.name || 'Figma Document';
        const items: any[] = [];

        // Walk the document tree, capturing FRAME / COMPONENT nodes plus their text descendants.
        // Each frame becomes one "requirement-like" item.
        const walk = (node: any, parentPath: string) => {
            if (!node) return;
            const path = parentPath ? `${parentPath} / ${node.name}` : node.name;
            if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
                const texts: string[] = [];
                const collectText = (n: any) => {
                    if (!n) return;
                    if (n.type === 'TEXT' && typeof n.characters === 'string') {
                        texts.push(n.characters.trim());
                    }
                    if (Array.isArray(n.children)) n.children.forEach(collectText);
                };
                collectText(node);
                const description = texts.filter(Boolean).slice(0, 80).join('\n');
                if (description) {
                    items.push({
                        id: `FIGMA-${items.length + 1}`,
                        key: `FIG-${items.length + 1}`,
                        summary: path.length > 140 ? path.slice(0, 137) + '...' : path,
                        description,
                        status: 'Design',
                    });
                }
            }
            if (Array.isArray(node.children)) {
                node.children.forEach((c: any) => walk(c, path));
            }
        };
        walk(fileResp.data?.document, '');

        if (items.length === 0) {
            return res.status(422).json({ success: false, error: 'No frames or components with text content were found.' });
        }

        res.json({
            success: true,
            source: 'figma',
            label: docName,
            items: items.slice(0, 50),
        });
    } catch (err: any) {
        console.error('Figma parse error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to fetch Figma file' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  Notifications — config, test send, and the helper that turns an execution
//  report into a multi-channel notification event.
// ════════════════════════════════════════════════════════════════════════════

// Build a NotificationEvent from an ExecutionReport. Trigger kind depends on
// whether any test failed/errored.
function buildExecutionNotification(
    report: ExecutionReport,
    extra: { mode: 'AI Agent' | 'Playwright Script'; productName?: string; reportUrl?: string } = { mode: 'AI Agent' }
): NotificationEvent {
    const { summary } = report;
    const anyFailed = summary.failed > 0 || summary.errors > 0;
    const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;

    const fields = [
        { label: 'Total', value: String(summary.total) },
        { label: 'Passed', value: String(summary.passed) },
        { label: 'Failed', value: String(summary.failed) },
        { label: 'Errors', value: String(summary.errors) },
        { label: 'Skipped', value: String(summary.skipped) },
        { label: 'Duration', value: `${(summary.duration / 1000).toFixed(1)}s` },
        { label: 'Pass Rate', value: `${passRate}%` },
        { label: 'Mode', value: extra.mode },
    ];

    const failedList = (report.results || [])
        .filter((r: any) => r.status === 'FAIL' || r.status === 'ERROR')
        .slice(0, 5)
        .map((r: any) => `• TC-${r.id} ${r.name}${r.error ? `: ${String(r.error).slice(0, 200)}` : ''}`)
        .join('\n');

    return {
        kind: anyFailed ? 'execution-failed' : 'execution-complete',
        title: anyFailed
            ? `❌ Test Run Failed${extra.productName ? ` — ${extra.productName}` : ''} (${summary.failed}/${summary.total} failed)`
            : `✅ Test Run Passed${extra.productName ? ` — ${extra.productName}` : ''} (${summary.passed}/${summary.total})`,
        summary: anyFailed
            ? `Pass rate ${passRate}% · ${summary.failed} failed, ${summary.errors} error(s) in ${(summary.duration / 1000).toFixed(1)}s`
            : `All ${summary.total} test cases passed in ${(summary.duration / 1000).toFixed(1)}s`,
        details: failedList || undefined,
        fields,
        link: extra.reportUrl ? { label: 'View HTML Report', url: extra.reportUrl } : undefined,
    };
}

// Public so other endpoints (and any future code path) can call it consistently.
async function notifyExecutionCompleted(
    report: ExecutionReport,
    extra: { mode: 'AI Agent' | 'Playwright Script'; productName?: string; reportUrl?: string } = { mode: 'AI Agent' }
) {
    try {
        const event = buildExecutionNotification(report, extra);
        await dispatchNotification(event);
    } catch (e: any) {
        console.warn('Notification dispatch failed:', e.message);
    }
}

// ─── Config endpoints ───────────────────────────────────────────────────────
app.get('/api/notifications/config', (_req, res) => {
    const cfg = loadNotificationConfig();
    // Redact the SMTP password before returning to the frontend.
    const safe = {
        ...cfg,
        email: { ...cfg.email, smtpPass: cfg.email.smtpPass ? '••••••••' : '' },
    };
    res.json(safe);
});

app.post('/api/notifications/config', (req, res) => {
    try {
        const incoming = req.body as NotificationConfig;
        if (!incoming || typeof incoming !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid config payload' });
        }
        // If the frontend sends placeholder dots, preserve the existing pass.
        if (incoming.email?.smtpPass === '••••••••') {
            incoming.email.smtpPass = '';
        }
        saveNotificationConfig(incoming);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Test send ──────────────────────────────────────────────────────────────
app.post('/api/notifications/test', async (_req, res) => {
    try {
        const results = await dispatchNotification({
            kind: 'test',
            title: '🔔 Test Notification',
            summary: 'If you can read this, your channel is configured correctly.',
            fields: [
                { label: 'Sent At', value: new Date().toISOString() },
                { label: 'Source', value: 'Intelligent Test Planning Agent' },
            ],
        });
        res.json({ success: true, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  Run History — list/get/stats/delete
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/history/runs', (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 1000);
    try {
        res.json({ runs: listRuns(limit) });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/history/runs/:id', (req, res) => {
    try {
        const run = getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        res.json(run);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/history/runs/:id', (req, res) => {
    try {
        const ok = deleteRun(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Run not found' });
        res.json({ success: true });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/history/stats', (_req, res) => {
    try {
        res.json(computeStats());
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  Quality Audit — visual regression + accessibility
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/audit/visual', async (req, res) => {
    try {
        const { url, name, fullPage, setBaseline, viewport } = req.body || {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing "url"' });
        }
        const result = await runVisualAudit({ url, name, fullPage, setBaseline, viewport });
        // Rewrite the served URLs to be absolute so the frontend can render them
        // regardless of which host:port served the audit endpoint.
        const host = req.headers.host || `localhost:${process.env.PORT || 3001}`;
        const protocol = req.protocol;
        const abs = (rel?: string) => (rel ? `${protocol}://${host}${rel}` : undefined);
        res.json({
            ...result,
            baselineUrl: abs(result.baselineUrl),
            currentUrl: abs(result.currentUrl),
            diffUrl: abs(result.diffUrl),
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/audit/a11y', async (req, res) => {
    try {
        const { url, standards } = req.body || {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing "url"' });
        }
        const result = await runA11yAudit({ url, standards });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  API Testing — runner + OpenAPI spec parser
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/apitest/parse-spec', (req, res) => {
    try {
        const { spec, baseUrl, maxTests } = req.body || {};
        if (!spec || typeof spec !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing "spec" (string)' });
        }
        const result = parseOpenApiSpec(spec, { baseUrl, maxTests });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/apitest/run', async (req, res) => {
    try {
        const { tests, envVars } = req.body as { tests: ApiTest[]; envVars?: Record<string, string> };
        if (!Array.isArray(tests) || tests.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing "tests" (array)' });
        }
        // runTestSuite handles per-test errors and threads extracted variables
        // through the sequence. If a single test is supplied, this still works
        // and the variable map collapses to just env vars.
        const { results, finalVars } = await runTestSuite(tests, envVars || {});
        const summary = {
            total: results.length,
            passed: results.filter((r) => r.status === 'PASS').length,
            failed: results.filter((r) => r.status === 'FAIL').length,
            errors: results.filter((r) => r.status === 'ERROR').length,
            totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
        };
        res.json({ success: true, results, summary, finalVars });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── API Test Suites ──────────────────────────────────────────────────
app.get('/api/apitest/suites', (_req, res) => {
    try {
        res.json({ suites: listSuites() });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/apitest/suites/:name', (req, res) => {
    try {
        const suite = getSuite(req.params.name);
        if (!suite) return res.status(404).json({ error: 'Suite not found' });
        res.json(suite);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/apitest/suites', (req, res) => {
    try {
        const suite = req.body as ApiSuite;
        if (!suite?.name) return res.status(400).json({ error: 'Missing "name"' });
        const saved = saveSuite(suite);
        res.json({ success: true, suite: saved });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/apitest/suites/:name', (req, res) => {
    try {
        const ok = deleteSuite(req.params.name);
        if (!ok) return res.status(404).json({ error: 'Suite not found' });
        res.json({ success: true });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
//  CI/CD — GitHub Actions integration (proxies GitHub API server-side so the
//  user's PAT never reaches the browser).
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/cicd/config', (_req, res) => {
    const cfg = loadCicdConfig();
    res.json({
        owner: cfg.owner,
        repo: cfg.repo,
        workflowFile: cfg.workflowFile,
        defaultBranch: cfg.defaultBranch,
        tokenSet: !!cfg.token,
    });
});

app.post('/api/cicd/config', (req, res) => {
    try {
        const incoming = req.body as Partial<CICDConfig>;
        const saved = saveCicdConfig(incoming);
        res.json({
            success: true,
            owner: saved.owner,
            repo: saved.repo,
            workflowFile: saved.workflowFile,
            defaultBranch: saved.defaultBranch,
            tokenSet: !!saved.token,
        });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/cicd/test', async (_req, res) => {
    const result = await testCicdConnection(loadCicdConfig());
    res.json(result);
});

app.get('/api/cicd/workflow', async (_req, res) => {
    try {
        const wf = await getCicdWorkflow(loadCicdConfig());
        res.json({
            id: wf.id,
            name: wf.name,
            path: wf.path,
            state: wf.state,
            badgeUrl: wf.badge_url,
            htmlUrl: wf.html_url,
        });
    } catch (e: any) {
        res.status(400).json({ error: e.response?.data?.message || e.message });
    }
});

app.get('/api/cicd/workflows', async (_req, res) => {
    try {
        const items = await listCicdWorkflows(loadCicdConfig());
        res.json({ workflows: items });
    } catch (e: any) {
        res.status(400).json({ error: e.response?.data?.message || e.message });
    }
});

app.get('/api/cicd/runs', async (req, res) => {
    try {
        const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
        const runs = await listCicdRuns(loadCicdConfig(), limit);
        res.json({ runs });
    } catch (e: any) {
        res.status(400).json({ error: e.response?.data?.message || e.message });
    }
});

app.post('/api/cicd/trigger', async (req, res) => {
    try {
        const { ref, reason } = req.body || {};
        const inputs = reason ? { reason: String(reason) } : undefined;
        const result = await triggerCicdWorkflow(loadCicdConfig(), ref, inputs);
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(400).json({ error: e.response?.data?.message || e.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`\n🚀 Backend server running on http://0.0.0.0:${PORT}`);
    console.log(`📊 Reports will be saved to ./reports/`);
    console.log(`📹 Videos will be saved to ./videos/`);
    // Surface key feature flags at boot so config issues are obvious without
    // having to fire a request first. If PER_STEP_MODE didn't get set, the
    // user sees that immediately instead of after a failed test run.
    console.log(`\n🔧 Backend flags loaded from env:`);
    const authEnabledLabel = String(process.env.AUTH_ENABLED || '').toLowerCase() === 'true'
        ? '\x1b[32mON\x1b[0m (login required)'
        : 'off (no login)';
    console.log(`   AUTH_ENABLED      = ${authEnabledLabel}`);
    console.log(`   AUTH_JWT_SECRET   = ${process.env.AUTH_JWT_SECRET ? `<set, ${process.env.AUTH_JWT_SECRET.length} chars>` : '\x1b[33mNOT SET (insecure default will be used)\x1b[0m'}`);
    const mcpModeLabel = (process.env.PER_STEP_MODE || '').toLowerCase() === 'legacy'
        ? 'LEGACY (single-conversation runAgent)'
        : '\x1b[32mPER-STEP orchestrator (default)\x1b[0m';
    console.log(`   MCP mode          = ${mcpModeLabel}`);
    console.log(`   MAX_AGENT_TURNS   = ${process.env.MAX_AGENT_TURNS || '30 (default)'}`);
    console.log(`   MAX_HEAL_TURNS    = ${process.env.MAX_HEAL_TURNS || '8 (default)'}`);
    console.log(`   MAX_TURNS_PER_STEP= ${process.env.MAX_TURNS_PER_STEP || '6 (default)'}`);
    console.log('');
});

// Re-export so other modules in this file can call them if needed
export { notifyExecutionCompleted };
