/**
 * Playwright custom reporter that captures failure context for self-healing.
 *
 * On each test failure, writes a sidecar JSON next to the spec containing:
 *   - testName, testFile, fullTitle
 *   - the failing error message
 *   - the URL the page was on
 *   - a snapshot of the page HTML (capped to keep token cost reasonable)
 *   - the offending source line, when extractable from the stack
 *
 * /api/run-playwright reads these sidecars after the run to drive the
 * healing LLM call.
 *
 * Output file naming:
 *   <spec-path>.failure-<sanitized-test-title>.json
 *
 * Why a reporter (not a fixture):
 *   - No changes needed to generated spec files (no extra import)
 *   - Survives strict mode / TS errors that would break a fixture
 *   - Has access to the full TestResult including attachments and errors
 */

import type {
    Reporter,
    TestCase,
    TestResult,
    FullConfig,
    FullResult,
} from '@playwright/test/reporter';
import fs from 'fs';

interface FailureSidecar {
    testName: string;       // bare test title, e.g. "Login with valid credentials"
    fullTitle: string;      // includes describe path
    specFile: string;       // absolute path of the .spec.ts
    error: string;          // error message + first frame of stack
    failingLine?: string;   // line of source if extractable
    url?: string;           // page URL at time of failure (from screenshot attachment metadata or context)
    htmlSnippet?: string;   // up to ~6000 chars of page HTML at failure
    attempt: number;        // 0 = initial, 1+ = healing retries
}

function sanitizeForFilename(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function extractFailingLine(error?: { stack?: string; message?: string }, specFile?: string): string | undefined {
    if (!error?.stack || !specFile) return undefined;
    // Stack frames look like:
    //   at /abs/path/to/tests/generated/X/foo.spec.ts:42:21
    // Find the first frame inside the spec file.
    const re = new RegExp(specFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):\\d+');
    const m = error.stack.match(re);
    if (!m) return undefined;
    const lineNo = parseInt(m[1], 10);
    try {
        const src = fs.readFileSync(specFile, 'utf8').split('\n');
        return src[lineNo - 1]?.trim();
    } catch {
        return undefined;
    }
}

// Top-level marker so we can confirm Playwright actually loaded this reporter.
// If you don't see this line in Playwright's stdout when running, the reporter
// isn't being loaded (path wrong in playwright.config.ts, or TS load failure).
console.log('🩹 [healing-reporter] module loaded');

export default class HealingReporter implements Reporter {
    onBegin(_config: FullConfig) {
        console.log('🩹 [healing-reporter] onBegin — ready to capture failures');
    }

    onTestEnd(test: TestCase, result: TestResult) {
        // Only capture genuine failures. Skipped tests and passing tests need no healing.
        if (result.status !== 'failed' && result.status !== 'timedOut') return;

        const specFile = test.location.file;
        const firstError = result.errors?.[0] || (result.error as any);
        const errorMessage = (firstError?.message || 'Unknown error').slice(0, 2000);

        // Look for any "html-snapshot" attachment that the spec might have
        // produced via page.content(); if absent, the htmlSnippet stays empty
        // and the healer falls back to live re-inspection.
        const htmlAttachment = result.attachments?.find(
            (a) => a.name === 'html-snapshot' || a.contentType === 'text/html',
        );
        let htmlSnippet: string | undefined;
        let url: string | undefined;
        if (htmlAttachment) {
            try {
                if (htmlAttachment.body) {
                    htmlSnippet = htmlAttachment.body.toString('utf8').slice(0, 6000);
                } else if (htmlAttachment.path) {
                    htmlSnippet = fs.readFileSync(htmlAttachment.path, 'utf8').slice(0, 6000);
                }
            } catch { /* swallow */ }
        }
        // URL hint: search the error message for a recognizable URL token,
        // otherwise pull from any "page-url" attachment.
        const urlAttachment = result.attachments?.find((a) => a.name === 'page-url');
        if (urlAttachment?.body) {
            url = urlAttachment.body.toString('utf8').trim();
        } else {
            const urlMatch = errorMessage.match(/https?:\/\/[^\s)"'`]+/);
            if (urlMatch) url = urlMatch[0];
        }

        const sidecar: FailureSidecar = {
            testName: test.title,
            fullTitle: test.titlePath().join(' › '),
            specFile,
            error: errorMessage,
            failingLine: extractFailingLine(firstError, specFile),
            url,
            htmlSnippet,
            // The reporter doesn't know about healing retry count — that's
            // tracked by the healer in server.ts when it re-spawns Playwright.
            attempt: 0,
        };

        const sidecarPath = `${specFile}.failure-${sanitizeForFilename(test.title)}.json`;
        try {
            fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
            console.log(`🩹 [healing-reporter] captured failure: ${sidecarPath}`);
        } catch (e: any) {
            console.warn(`🩹 [healing-reporter] could not write sidecar: ${e.message}`);
        }
    }

    onEnd(_result: FullResult) {
        // No-op
    }
}
