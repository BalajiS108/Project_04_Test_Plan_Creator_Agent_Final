/**
 * Playwright custom reporter (CommonJS) that captures failure context for
 * self-healing. CJS extension `.cjs` because Playwright's reporter loader
 * doesn't reliably handle `.ts` reporters in this project (root package.json
 * is "type": "module", backend has its own tsconfig). Plain JS bypasses all
 * those loader edge cases.
 *
 * On each test failure, writes a sidecar JSON next to the spec:
 *   <spec-path>.failure-<sanitized-test-title>.json
 *
 * Fields written:
 *   - testName, fullTitle, specFile
 *   - error (message + first frame of stack, capped)
 *   - failingLine (extracted from stack against the spec source)
 *   - url, htmlSnippet when attachments are present
 *   - attempt (always 0 from here; healer tracks attempt counts itself)
 *
 * Logs prefixed with 🩹 so we can confirm in console output that the reporter
 * actually loaded and ran.
 */

const fs = require('fs');

console.log('🩹 [healing-reporter] module loaded (CJS)');

function sanitizeForFilename(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function extractFailingLine(error, specFile) {
    if (!error || !error.stack || !specFile) return undefined;
    const re = new RegExp(specFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):\\d+');
    const m = error.stack.match(re);
    if (!m) return undefined;
    const lineNo = parseInt(m[1], 10);
    try {
        const src = fs.readFileSync(specFile, 'utf8').split('\n');
        return src[lineNo - 1] ? src[lineNo - 1].trim() : undefined;
    } catch {
        return undefined;
    }
}

class HealingReporter {
    onBegin(/* config, suite */) {
        console.log('🩹 [healing-reporter] onBegin — ready to capture failures');
    }

    onTestEnd(test, result) {
        if (result.status !== 'failed' && result.status !== 'timedOut') return;

        const specFile = test.location && test.location.file;
        if (!specFile) {
            console.warn('🩹 [healing-reporter] test failed but no spec file path — cannot write sidecar');
            return;
        }

        const firstError = (result.errors && result.errors[0]) || result.error || {};
        const errorMessage = String(firstError.message || 'Unknown error').slice(0, 2000);

        let htmlSnippet;
        let url;
        if (Array.isArray(result.attachments)) {
            const htmlAttachment = result.attachments.find(
                (a) => a.name === 'html-snapshot' || a.contentType === 'text/html',
            );
            if (htmlAttachment) {
                try {
                    if (htmlAttachment.body) {
                        htmlSnippet = htmlAttachment.body.toString('utf8').slice(0, 6000);
                    } else if (htmlAttachment.path) {
                        htmlSnippet = fs.readFileSync(htmlAttachment.path, 'utf8').slice(0, 6000);
                    }
                } catch { /* ignore */ }
            }
            const urlAttachment = result.attachments.find((a) => a.name === 'page-url');
            if (urlAttachment && urlAttachment.body) {
                url = urlAttachment.body.toString('utf8').trim();
            }
        }
        if (!url) {
            const urlMatch = errorMessage.match(/https?:\/\/[^\s)"'`]+/);
            if (urlMatch) url = urlMatch[0];
        }

        const sidecar = {
            testName: test.title,
            fullTitle: typeof test.titlePath === 'function' ? test.titlePath().join(' › ') : test.title,
            specFile,
            error: errorMessage,
            failingLine: extractFailingLine(firstError, specFile),
            url,
            htmlSnippet,
            attempt: 0,
        };

        const sidecarPath = specFile + '.failure-' + sanitizeForFilename(test.title) + '.json';
        try {
            fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
            console.log('🩹 [healing-reporter] captured failure: ' + sidecarPath);
        } catch (e) {
            console.warn('🩹 [healing-reporter] could not write sidecar: ' + (e && e.message));
        }
    }

    onEnd(/* result */) {
        // No-op
    }
}

module.exports = HealingReporter;
// Some Playwright loaders prefer a default property:
module.exports.default = HealingReporter;
