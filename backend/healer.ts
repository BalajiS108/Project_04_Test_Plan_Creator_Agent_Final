/**
 * Self-healing pass for Playwright test failures.
 *
 * Flow (called from /api/run-playwright after the initial run finishes):
 *   1. scanFailureSidecars(specPath) → list of failure contexts written by healing-reporter
 *   2. for each failure: ask the LLM to rewrite ONLY that test() block, given:
 *        - the original test code (extracted from the spec via regex)
 *        - the error message + failing line
 *        - the page HTML snippet captured at failure (or live re-inspection as fallback)
 *   3. splice the new test() block back into the spec file
 *   4. return the list of healed test names so the caller can re-run them via --grep
 *
 * Healing only touches the failing test() blocks. Passing tests are left untouched.
 * If a test can't be healed (LLM returns garbage, patch can't be applied), we skip
 * it and let it fail honestly on the next run.
 */

import fs from 'fs';
import path from 'path';
import { applyGuardrails } from './spec-guardrails.js';

export interface HealingResult {
    healedTests: string[];        // bare titles
    skipped: { testName: string; reason: string }[];
    notes: string[];              // human-readable progress for logs/UI
}

interface FailureSidecar {
    testName: string;
    fullTitle: string;
    specFile: string;
    error: string;
    failingLine?: string;
    url?: string;
    htmlSnippet?: string;
    attempt: number;
}

/**
 * Scan the directory that contains the spec for any failure sidecars the
 * healing-reporter wrote during this run.
 */
export function scanFailureSidecars(specPath: string): FailureSidecar[] {
    const dir = path.dirname(specPath);
    const baseName = path.basename(specPath);
    if (!fs.existsSync(dir)) return [];
    const prefix = `${baseName}.failure-`;
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    const out: FailureSidecar[] = [];
    for (const f of files) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (raw?.testName) out.push(raw as FailureSidecar);
        } catch { /* skip malformed sidecar */ }
    }
    return out;
}

/**
 * Remove all failure sidecars for a spec — called after healing so the next
 * run starts with a clean slate.
 */
export function clearFailureSidecars(specPath: string): void {
    const dir = path.dirname(specPath);
    const baseName = path.basename(specPath);
    if (!fs.existsSync(dir)) return;
    const prefix = `${baseName}.failure-`;
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix) && f.endsWith('.json')) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
        }
    }
}

/**
 * Find the source range of a test('...', async ...) block by name.
 * Returns the [start, end) indices into the source, or null if not found.
 *
 * Heuristic: locate `test('NAME'` (with any quote style), walk forward
 * counting braces/parens until we close the test() call. Works for the
 * shape Playwright tests almost always have. Bails on weird syntax.
 */
function findTestBlock(source: string, testName: string): { start: number; end: number; indent: string } | null {
    // Match: optional indent + test( with the exact title
    // Skip test.describe(), test.skip() handled separately
    const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\n)([ \\t]*)test\\s*\\(\\s*(['"\`])${escaped}\\3`, 'g');
    const m = re.exec(source);
    if (!m) return null;
    const indent = m[2];
    const blockStart = m.index + m[1].length; // start of the test( line, ignoring the newline matched

    // Walk forward through balanced parens until the test(...) closes,
    // then through the semicolon/newline that follows.
    let i = source.indexOf('(', blockStart);
    if (i === -1) return null;
    let depth = 0;
    for (; i < source.length; i++) {
        const c = source[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) { i++; break; }
        }
    }
    // Consume an optional trailing ';' and the newline
    while (i < source.length && /[;\s]/.test(source[i])) {
        i++;
        if (source[i - 1] === '\n') break;
    }
    return { start: blockStart, end: i, indent };
}

/**
 * Optional live re-inspection of the failure URL. Used when the reporter's
 * htmlSnippet is empty (the spec didn't attach one). Best-effort — if we
 * can't reach the URL we just send the LLM what we have.
 */
async function inspectUrlBriefly(url: string): Promise<string> {
    try {
        const { chromium } = await import('playwright');
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
            const html = await page.content();
            return html.slice(0, 6000);
        } finally {
            await browser.close().catch(() => {});
        }
    } catch {
        return '';
    }
}

function buildHealingPrompt(args: {
    failure: FailureSidecar;
    originalTestSrc: string;
    htmlSnippet: string;
}): string {
    const { failure, originalTestSrc, htmlSnippet } = args;
    // Playwright includes alternative selector hints inside "strict mode
    // violation" errors. Extract them so the LLM can copy them verbatim
    // instead of guessing — this is the single highest-leverage healing
    // signal because Playwright already knows the correct unique selectors.
    const strictModeMatch = failure.error.match(/strict mode violation[\s\S]*?resolved to (\d+) elements?:([\s\S]+?)(?:\n\s*\n|$)/i);
    let strictModeHint = '';
    if (strictModeMatch) {
        // Pull "aka locator('...')" alternatives Playwright suggests.
        const alts = [...failure.error.matchAll(/aka\s+(locator\([^)]+\)|getBy[A-Z][a-zA-Z]+\([^)]+\))/g)].map(m => m[1]);
        strictModeHint = `\n==== STRICT MODE VIOLATION DETECTED ====
The error says your selector matched ${strictModeMatch[1]} elements. Playwright already suggested these unique alternatives — USE ONE OF THEM VERBATIM (do not invent a new one):
${alts.length ? alts.map(a => `  • ${a}`).join('\n') : '  (no explicit suggestions found in error text — pick a unique data-test/aria attribute from the DOM below)'}
`;
    }

    // Playwright's text assertion errors include both Expected and Received.
    // When toHaveText fails because the actual string is longer/different
    // (common: app shows "Epic sadface: <message>" but story says just
    // "<message>"), the right fix is to either copy the actual text verbatim
    // OR switch to .toContainText() with the meaningful substring. The LLM
    // sometimes ignores the Received value and keeps the original Expected
    // because that's what the test plan said — without an explicit hint.
    const expectedMatch = failure.error.match(/Expected(?:\s+string)?:\s*"([^"]+)"/i);
    const receivedMatch = failure.error.match(/Received(?:\s+string)?:\s*"([^"]+)"/i);
    let textMismatchHint = '';
    if (expectedMatch && receivedMatch) {
        textMismatchHint = `\n==== TEXT MISMATCH DETECTED ====
Playwright shows what the app ACTUALLY rendered vs what the test asserted:
  • Expected: "${expectedMatch[1]}"
  • Received: "${receivedMatch[1]}"

The app's actual text is correct — your test's expected value was a paraphrase or substring. Pick ONE fix:
  (a) PREFERRED — switch to a substring match so future copy tweaks don't break the test:
        await expect(locator).toContainText('${expectedMatch[1]}');
  (b) Match the actual text verbatim:
        await expect(locator).toHaveText('${receivedMatch[1].replace(/'/g, "\\'")}');
Do NOT keep the original failing assertion as-is. Do NOT swap the assertion for toBeVisible (that weakens the test).
`;
    }

    return `You are a Playwright test fixer. ONE test failed during execution. Rewrite ONLY that single test so it passes against the actual DOM shown below. Output ONLY the corrected test() block — no explanation, no markdown fences, no other tests.

==== ORIGINAL FAILING TEST ====
${originalTestSrc}

==== FAILURE ERROR ====
${failure.error}
${strictModeHint}${textMismatchHint}
${failure.failingLine ? `Offending line: ${failure.failingLine}\n` : ''}
==== ACTUAL PAGE DOM AT FAILURE (truncated) ====
${htmlSnippet ? htmlSnippet : '(none captured — use selectors that are typically stable)'}

==== HARD RULES (must obey, otherwise the patch is rejected) ====
1. Output MUST start with "test(" — no imports, no describe, no commentary.
2. Use the SAME test title verbatim: '${failure.testName.replace(/'/g, "\\'")}'.
3. Use a verified selector visible in the DOM above. Prefer data-test/id/name. Drop tag-prefixes on [data-test="..."] (write [data-test="x"], not div[data-test="x"]).
4. If a class selector matches multiple elements (e.g. .cart_item), use .first() with toBeVisible(), or use toHaveCount(N).
5. **Strict mode violations**: if the FAILURE ERROR above says "strict mode violation: locator('X') resolved to N elements", the fix is non-negotiable: replace selector 'X' with one of the unique alternatives Playwright suggested (shown above), OR append .first() to the existing locator. Do NOT keep the old multi-match selector. SauceDemo specifically has duplicate \`#inventory_container\` IDs — use \`[data-test="inventory-container"]\` instead.
6. **Text-content mismatches**: if a TEXT MISMATCH section appears above, you MUST update the assertion (Option (a) toContainText is preferred, Option (b) toHaveText with the verbatim received text is the fallback). Keeping the original Expected value is forbidden — the app's actual text is the source of truth.
7. After clicks that navigate, wait for an element on the DESTINATION page, not the source page.
8. Do NOT add test.setTimeout() — the playwright.config already provides a 90s budget.
9. Keep the same overall intent. Don't replace assertions with no-ops. If the test must skip, use test.skip(true, 'reason').`;
}

/**
 * Public entry: heal each failure, mutate the spec file, return the list of
 * test names that should be re-run.
 */
export async function healFailedTests(args: {
    specPath: string;
    llmConfig: any;
    log?: (msg: string) => void;
}): Promise<HealingResult> {
    const log = args.log || (() => {});
    log(`🩹 healFailedTests() invoked for: ${args.specPath}`);
    const failures = scanFailureSidecars(args.specPath);
    const result: HealingResult = { healedTests: [], skipped: [], notes: [] };

    if (failures.length === 0) {
        log('🩹 No failure sidecars found — nothing to heal.');
        log('🩹 (If you expected failures here, check that healing-reporter loaded — look for "🩹 [healing-reporter] module loaded" in Playwright output above.)');
        return result;
    }

    log(`🩹 Found ${failures.length} failed test(s) to heal: ${failures.map(f => `"${f.testName}"`).join(', ')}`);

    const OpenAI = (await import('openai')).default;
    const getBaseURL = (config: any): string => {
        switch (config.provider) {
            case 'Groq': return 'https://api.groq.com/openai/v1';
            case 'Ollama': return `${(config.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`;
            case 'Gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai/';
            default: return 'https://api.openai.com/v1';
        }
    };
    const openai = new OpenAI({ apiKey: args.llmConfig.apiKey || 'dummy', baseURL: getBaseURL(args.llmConfig) });

    let source = fs.readFileSync(args.specPath, 'utf8');

    for (const failure of failures) {
        if (failure.attempt >= 2) {
            result.skipped.push({ testName: failure.testName, reason: 'max healing attempts (2) reached' });
            log(`🩹 SKIP "${failure.testName}": already healed twice without success`);
            continue;
        }

        const block = findTestBlock(source, failure.testName);
        if (!block) {
            result.skipped.push({ testName: failure.testName, reason: 'could not locate test block in spec' });
            log(`🩹 SKIP "${failure.testName}": couldn't locate its test() block in the spec source`);
            continue;
        }
        const originalSrc = source.slice(block.start, block.end);

        let html = failure.htmlSnippet || '';
        if (!html && failure.url) {
            log(`🩹 Re-inspecting ${failure.url} to capture DOM for healing…`);
            html = await inspectUrlBriefly(failure.url);
        }

        const prompt = buildHealingPrompt({ failure, originalTestSrc: originalSrc, htmlSnippet: html });
        log(`🩹 Asking LLM to heal "${failure.testName}"…`);

        let healed: string;
        try {
            const resp = await openai.chat.completions.create({
                model: args.llmConfig.model || 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
            });
            healed = resp.choices[0]?.message?.content || '';
        } catch (e: any) {
            result.skipped.push({ testName: failure.testName, reason: `LLM call failed: ${e.message}` });
            log(`🩹 SKIP "${failure.testName}": LLM error — ${e.message}`);
            continue;
        }

        // Strip markdown fences if the LLM included them despite instructions
        const fenceMatch = healed.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```/i);
        if (fenceMatch) healed = fenceMatch[1];
        healed = healed.trim();

        // Hard sanity check: it must start with "test("
        if (!/^test\s*\(/.test(healed)) {
            result.skipped.push({ testName: failure.testName, reason: 'LLM output did not start with test(' });
            log(`🩹 SKIP "${failure.testName}": LLM output didn't start with test(`);
            continue;
        }

        // Run the healed code through the SAME guardrails as initial
        // generation. Without this, the healing LLM can re-introduce a
        // pattern we deterministically eliminate at generation time
        // (e.g. #inventory_container, div[data-test=…], etc.) and the
        // re-run would fail with the same error we just tried to fix.
        const healedGuarded = applyGuardrails(healed);
        if (healedGuarded.notes.length) {
            log(`🩹 🛡️ Guardrails applied to healed "${failure.testName}": ${healedGuarded.notes.join('; ')}`);
        }
        healed = healedGuarded.code;

        // Re-indent the healed block to match the original's indentation so
        // the spliced spec still parses cleanly inside whatever describe block
        // it lived in. We add the original's indent to every line after the
        // first (the first line already gets prefixed when we splice it in).
        const reindented = healed.split('\n').map((line, idx) => idx === 0 ? line : block.indent + line).join('\n');

        // Splice the new test in place of the old one. Preserve trailing
        // newline so the file structure remains tidy.
        const before = source.slice(0, block.start) + block.indent;
        const after = '\n' + source.slice(block.end);
        source = before + reindented + after;

        result.healedTests.push(failure.testName);
        log(`🩹 ✓ Healed "${failure.testName}"`);
    }

    // Persist the patched spec so re-runs use the healed code, and so the
    // user can inspect what changed.
    if (result.healedTests.length > 0) {
        fs.writeFileSync(args.specPath, source, 'utf8');
        log(`🩹 Spec rewritten with ${result.healedTests.length} healed test(s): ${args.specPath}`);
    }

    // Clean up the sidecars — they've served their purpose. (The healed
    // tests will create fresh sidecars on the next run if they still fail.)
    clearFailureSidecars(args.specPath);

    return result;
}
