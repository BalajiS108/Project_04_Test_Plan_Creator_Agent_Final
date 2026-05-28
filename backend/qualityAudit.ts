/**
 * Quality Audit — standalone visual-regression + accessibility checks.
 *
 * Decoupled from agent.ts so the MCP execution path stays untouched. Each
 * audit launches its own headless Chromium, runs the check on the supplied
 * URL, and returns a result the UI can render. Visual baselines live in
 * `backend/visual-baselines/`; diff images get stored next to them.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { AxeBuilder } from '@axe-core/playwright';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASELINE_DIR = path.join(__dirname, 'visual-baselines');
const DIFF_DIR = path.join(__dirname, 'visual-diffs');

if (!fs.existsSync(BASELINE_DIR)) fs.mkdirSync(BASELINE_DIR, { recursive: true });
if (!fs.existsSync(DIFF_DIR)) fs.mkdirSync(DIFF_DIR, { recursive: true });

// Derive a stable, filesystem-safe identifier from a URL+name combo so
// repeated audits of the same target overwrite the same baseline.
function slug(url: string, name?: string): string {
    const raw = `${name || ''}::${url}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

export interface VisualAuditResult {
    success: boolean;
    name: string;
    url: string;
    baselineExisted: boolean;
    captured: boolean;
    diffPixels?: number;
    totalPixels?: number;
    diffPercent?: number;
    baselineUrl?: string;
    currentUrl?: string;
    diffUrl?: string;
    error?: string;
}

interface VisualOpts {
    url: string;
    name?: string;
    fullPage?: boolean;
    setBaseline?: boolean;
    viewport?: { width: number; height: number };
}

/**
 * Capture a screenshot and (if a baseline exists) compute a pixel diff.
 * If no baseline exists, the captured screenshot becomes the baseline.
 * `setBaseline: true` forces overwriting the baseline regardless.
 */
export async function runVisualAudit(opts: VisualOpts): Promise<VisualAuditResult> {
    const { url, name = 'untitled', fullPage = false, setBaseline = false } = opts;
    const viewport = opts.viewport || { width: 1280, height: 720 };
    const id = slug(url, name);

    const baselinePath = path.join(BASELINE_DIR, `${id}.png`);
    const currentPath = path.join(DIFF_DIR, `${id}-current.png`);
    const diffPath = path.join(DIFF_DIR, `${id}-diff.png`);

    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Allow late renders (animations, async paint) to settle.
        await page.waitForTimeout(500);

        const buffer = await page.screenshot({ fullPage });
        fs.writeFileSync(currentPath, buffer);

        const hadBaseline = fs.existsSync(baselinePath);
        if (setBaseline || !hadBaseline) {
            fs.writeFileSync(baselinePath, buffer);
            return {
                success: true,
                name,
                url,
                baselineExisted: hadBaseline,
                captured: true,
                baselineUrl: `/audit-images/baselines/${id}.png`,
                currentUrl: `/audit-images/diffs/${id}-current.png`,
            };
        }

        // Diff via pixelmatch. If sizes differ, resize to the larger of the two —
        // pixelmatch needs identical dimensions.
        const baselinePng = PNG.sync.read(fs.readFileSync(baselinePath));
        const currentPng = PNG.sync.read(buffer);
        const width = Math.max(baselinePng.width, currentPng.width);
        const height = Math.max(baselinePng.height, currentPng.height);

        const fitTo = (src: PNG, w: number, h: number): PNG => {
            if (src.width === w && src.height === h) return src;
            const out = new PNG({ width: w, height: h });
            // Initialize to transparent so unmatched regions show as max diff.
            PNG.bitblt(src, out, 0, 0, Math.min(src.width, w), Math.min(src.height, h), 0, 0);
            return out;
        };
        const baselineFit = fitTo(baselinePng, width, height);
        const currentFit = fitTo(currentPng, width, height);
        const diffPng = new PNG({ width, height });

        const diffPixels = pixelmatch(
            baselineFit.data, currentFit.data, diffPng.data,
            width, height,
            { threshold: 0.1, alpha: 0.4, diffColor: [255, 0, 0] }
        );
        fs.writeFileSync(diffPath, PNG.sync.write(diffPng));

        const totalPixels = width * height;
        const diffPercent = +(diffPixels / totalPixels * 100).toFixed(3);

        return {
            success: true,
            name,
            url,
            baselineExisted: true,
            captured: true,
            diffPixels,
            totalPixels,
            diffPercent,
            baselineUrl: `/audit-images/baselines/${id}.png`,
            currentUrl: `/audit-images/diffs/${id}-current.png`,
            diffUrl: `/audit-images/diffs/${id}-diff.png`,
        };
    } catch (e: any) {
        return { success: false, name, url, baselineExisted: false, captured: false, error: e.message };
    } finally {
        await browser.close();
    }
}

export { BASELINE_DIR, DIFF_DIR };

/* ─── Accessibility ──────────────────────────────────────────────────────── */

export interface A11yViolation {
    id: string;
    impact: string | null;
    description: string;
    help: string;
    helpUrl: string;
    tags: string[];
    nodeCount: number;
    sampleSelectors: string[];
}

export interface A11yAuditResult {
    success: boolean;
    url: string;
    violationCount: number;
    counts: { critical: number; serious: number; moderate: number; minor: number };
    violations: A11yViolation[];
    passes: number;
    inapplicable: number;
    error?: string;
}

interface A11yOpts {
    url: string;
    standards?: ('wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa' | 'best-practice')[];
}

export async function runA11yAudit(opts: A11yOpts): Promise<A11yAuditResult> {
    const { url } = opts;
    const standards = opts.standards && opts.standards.length > 0 ? opts.standards : ['wcag2aa', 'wcag21aa', 'best-practice'];

    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(500);

        const results = await new AxeBuilder({ page })
            .withTags(standards)
            .analyze();

        const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
        const violations: A11yViolation[] = results.violations.map((v) => {
            const imp = (v.impact as keyof typeof counts) || 'minor';
            if (imp in counts) counts[imp] += 1;
            return {
                id: v.id,
                impact: v.impact || null,
                description: v.description,
                help: v.help,
                helpUrl: v.helpUrl,
                tags: v.tags,
                nodeCount: v.nodes.length,
                sampleSelectors: v.nodes.slice(0, 5).map((n) =>
                    Array.isArray(n.target) ? n.target.join(' ') : String(n.target)
                ),
            };
        });

        return {
            success: true,
            url,
            violationCount: violations.length,
            counts,
            violations: violations.sort((a, b) => {
                const order = { critical: 0, serious: 1, moderate: 2, minor: 3 } as any;
                return (order[a.impact || 'minor'] ?? 9) - (order[b.impact || 'minor'] ?? 9);
            }),
            passes: results.passes.length,
            inapplicable: results.inapplicable.length,
        };
    } catch (e: any) {
        return {
            success: false,
            url,
            violationCount: 0,
            counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
            violations: [],
            passes: 0,
            inapplicable: 0,
            error: e.message,
        };
    } finally {
        await browser.close();
    }
}
