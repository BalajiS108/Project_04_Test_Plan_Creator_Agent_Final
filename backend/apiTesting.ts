/**
 * API Testing — HTTP test runner + OpenAPI spec → test scaffold parser.
 *
 * Tests are evaluated against a simple assertion DSL so the UI doesn't need
 * a code editor; every assertion type maps cleanly to a single form field.
 */

import axios, { AxiosRequestConfig } from 'axios';
import yaml from 'js-yaml';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type AssertionType =
    | 'status'           // expected: number (exact)
    | 'statusRange'      // range: '2xx'|'3xx'|'4xx'|'5xx'
    | 'header'           // name + expected
    | 'jsonPath'         // path (dot.notation) + expected (string compare)
    | 'jsonPathExists'   // path
    | 'bodyContains'     // expected (substring)
    | 'responseTimeBelow';// expectedMs

export interface ApiAssertion {
    type: AssertionType;
    name?: string;       // optional friendly label
    expected?: any;
    path?: string;
    range?: '2xx' | '3xx' | '4xx' | '5xx';
    expectedMs?: number;
}

/**
 * An extraction copies a value out of the response into the shared context
 * so later tests can reference it as {{name}} in URL/headers/body.
 *
 * Three sources: a JSON path into the response body, a response-header value,
 * or the HTTP status code.
 */
export interface ApiExtraction {
    name: string;
    source: 'jsonPath' | 'header' | 'status';
    path?: string;       // for jsonPath
    headerName?: string; // for header
}

/**
 * A dataset turns one test definition into N parametrized runs. Each row is
 * a flat variable map merged on top of the env/extracted context for that
 * one execution. Example:
 *   dataset: [
 *     { case: 'happy',    email: 'a@b.com', password: 'pa55' },
 *     { case: 'bad-pwd',  email: 'a@b.com', password: 'xxx',  expectedStatus: 401 },
 *   ]
 * The original test is unchanged; the rows are referenced in url/body/etc as
 * {{email}}, {{password}}, etc, and surface in the result name as a suffix.
 */
export interface ApiDatasetRow {
    [key: string]: string | number | boolean;
}

export interface ApiTest {
    id: string;
    name: string;
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: any;
    assertions: ApiAssertion[];
    extractions?: ApiExtraction[];
    dataset?: ApiDatasetRow[];
    timeoutMs?: number;
}

export interface ApiTestStep {
    label: string;
    passed: boolean;
    detail: string;
}

export interface ApiTestResult {
    id: string;
    name: string;
    method: HttpMethod;
    url: string;
    status: 'PASS' | 'FAIL' | 'ERROR';
    httpStatus?: number;
    durationMs: number;
    requestPreview: { method: string; url: string; headers?: Record<string, string>; body?: any };
    responsePreview?: { status?: number; headers?: Record<string, string>; bodyExcerpt?: string };
    steps: ApiTestStep[];
    extracted?: Record<string, string>;
    error?: string;
}

/* ─── JSON path lookup (dot notation + [idx]) ───────────────────────── */

function lookup(obj: any, path: string): { found: boolean; value: any } {
    if (path === '' || path == null) return { found: true, value: obj };
    const parts = path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean);
    let cur: any = obj;
    for (const p of parts) {
        if (cur == null) return { found: false, value: undefined };
        if (typeof cur !== 'object') return { found: false, value: undefined };
        if (!(p in cur)) return { found: false, value: undefined };
        cur = cur[p];
    }
    return { found: true, value: cur };
}

/* ─── Variable substitution ──────────────────────────────────────────── */

// Substitutes {{name}} tokens against a flat variable map. Environment
// variables go in as `env.NAME`; extracted values go in by their raw name.
// Unknown tokens are left intact so the user can see they weren't substituted.
function substitute<T>(value: T, vars: Record<string, string>): T {
    if (value == null) return value;
    if (typeof value === 'string') {
        return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, key) => {
            return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
        }) as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map((v) => substitute(v, vars)) as unknown as T;
    }
    if (typeof value === 'object') {
        const out: any = {};
        for (const [k, v] of Object.entries(value as any)) out[k] = substitute(v, vars);
        return out;
    }
    return value;
}

function applyVars(test: ApiTest, vars: Record<string, string>): ApiTest {
    return {
        ...test,
        url: substitute(test.url, vars),
        headers: test.headers ? substitute(test.headers, vars) : undefined,
        queryParams: test.queryParams ? substitute(test.queryParams, vars) : undefined,
        body: test.body !== undefined ? substitute(test.body, vars) : undefined,
    };
}

/* ─── Run one test ───────────────────────────────────────────────────── */

export async function runApiTest(test: ApiTest, vars: Record<string, string> = {}): Promise<ApiTestResult> {
    const resolved = applyVars(test, vars);
    const start = Date.now();
    const reqPreview = {
        method: resolved.method,
        url: resolved.url,
        headers: resolved.headers,
        body: resolved.body,
    };

    const config: AxiosRequestConfig = {
        method: resolved.method,
        url: resolved.url,
        headers: resolved.headers,
        params: resolved.queryParams,
        data: resolved.body,
        timeout: resolved.timeoutMs || 30000,
        // We want non-2xx responses to resolve, not throw, so assertions can inspect them
        validateStatus: () => true,
        maxRedirects: 5,
    };

    let httpStatus: number | undefined;
    let responseHeaders: Record<string, string> | undefined;
    let responseBody: any;
    let bodyExcerpt = '';
    let networkError: string | undefined;

    try {
        const response = await axios.request(config);
        httpStatus = response.status;
        responseHeaders = Object.fromEntries(
            Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)])
        );
        responseBody = response.data;
        try {
            bodyExcerpt = typeof responseBody === 'string'
                ? responseBody.slice(0, 4000)
                : JSON.stringify(responseBody, null, 2).slice(0, 4000);
        } catch { bodyExcerpt = '<unserializable response body>'; }
    } catch (e: any) {
        networkError = e.message;
    }

    const durationMs = Date.now() - start;
    const steps: ApiTestStep[] = [];

    // Always include the request step — show the resolved values so the user
    // can confirm variable substitution happened as expected.
    steps.push({
        label: `${resolved.method} ${resolved.url}`,
        passed: !networkError,
        detail: networkError ? `Request failed: ${networkError}` : `HTTP ${httpStatus} in ${durationMs}ms`,
    });

    if (networkError) {
        return {
            id: test.id,
            name: test.name,
            method: resolved.method,
            url: resolved.url,
            status: 'ERROR',
            durationMs,
            requestPreview: reqPreview,
            steps,
            error: networkError,
        };
    }

    // Evaluate each assertion
    let allPassed = true;
    for (const a of resolved.assertions) {
        const step = evaluateAssertion(a, { status: httpStatus!, headers: responseHeaders!, body: responseBody, durationMs });
        steps.push(step);
        if (!step.passed) allPassed = false;
    }

    // Run extractions into a flat map for chaining
    const extracted: Record<string, string> = {};
    for (const ex of resolved.extractions || []) {
        if (!ex.name) continue;
        try {
            let value: any = undefined;
            if (ex.source === 'status') value = httpStatus;
            else if (ex.source === 'header') value = responseHeaders?.[(ex.headerName || '').toLowerCase()];
            else if (ex.source === 'jsonPath') {
                const r = lookup(responseBody, ex.path || '');
                if (r.found) value = r.value;
            }
            if (value !== undefined && value !== null) {
                extracted[ex.name] = typeof value === 'string' ? value : String(value);
                steps.push({
                    label: `extract → ${ex.name}`,
                    passed: true,
                    detail: `set to "${String(extracted[ex.name]).slice(0, 120)}"`,
                });
            } else {
                steps.push({
                    label: `extract → ${ex.name}`,
                    passed: false,
                    detail: `source "${ex.source}" produced no value`,
                });
                // Extraction failure shouldn't fail the test by itself — assertions own pass/fail
            }
        } catch (e: any) {
            steps.push({ label: `extract → ${ex.name}`, passed: false, detail: e.message });
        }
    }

    return {
        id: test.id,
        name: test.name,
        method: resolved.method,
        url: resolved.url,
        status: allPassed ? 'PASS' : 'FAIL',
        httpStatus,
        durationMs,
        requestPreview: reqPreview,
        responsePreview: { status: httpStatus, headers: responseHeaders, bodyExcerpt },
        steps,
        extracted: Object.keys(extracted).length > 0 ? extracted : undefined,
    };
}

function evaluateAssertion(
    a: ApiAssertion,
    ctx: { status: number; headers: Record<string, string>; body: any; durationMs: number }
): ApiTestStep {
    const label = a.name || describeAssertion(a);
    try {
        switch (a.type) {
            case 'status': {
                const ok = ctx.status === Number(a.expected);
                return { label, passed: ok, detail: ok ? `got ${ctx.status}` : `expected ${a.expected}, got ${ctx.status}` };
            }
            case 'statusRange': {
                const first = String(ctx.status)[0];
                const want = (a.range || '').charAt(0);
                const ok = first === want;
                return { label, passed: ok, detail: ok ? `${ctx.status} is in ${a.range}` : `${ctx.status} is not in ${a.range}` };
            }
            case 'header': {
                const got = ctx.headers[String(a.name || '').toLowerCase()] || '';
                const ok = String(a.expected) === '' ? !!got : got.includes(String(a.expected));
                return { label, passed: ok, detail: ok ? `header "${a.name}" = "${got}"` : `header "${a.name}" was "${got}", expected to include "${a.expected}"` };
            }
            case 'jsonPath': {
                const r = lookup(ctx.body, String(a.path || ''));
                if (!r.found) return { label, passed: false, detail: `path "${a.path}" not found in body` };
                const ok = String(r.value) === String(a.expected);
                return { label, passed: ok, detail: ok ? `${a.path} = ${JSON.stringify(r.value)}` : `${a.path} = ${JSON.stringify(r.value)}, expected ${JSON.stringify(a.expected)}` };
            }
            case 'jsonPathExists': {
                const r = lookup(ctx.body, String(a.path || ''));
                return { label, passed: r.found, detail: r.found ? `${a.path} exists` : `${a.path} missing` };
            }
            case 'bodyContains': {
                const bodyStr = typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body || '');
                const ok = bodyStr.includes(String(a.expected || ''));
                return { label, passed: ok, detail: ok ? 'substring found' : `body does not contain "${a.expected}"` };
            }
            case 'responseTimeBelow': {
                const want = Number(a.expectedMs);
                const ok = ctx.durationMs < want;
                return { label, passed: ok, detail: ok ? `${ctx.durationMs}ms < ${want}ms` : `${ctx.durationMs}ms ≥ ${want}ms` };
            }
        }
    } catch (e: any) {
        return { label, passed: false, detail: `evaluation error: ${e.message}` };
    }
}

function describeAssertion(a: ApiAssertion): string {
    switch (a.type) {
        case 'status': return `status == ${a.expected}`;
        case 'statusRange': return `status in ${a.range}`;
        case 'header': return `header ${a.name} contains "${a.expected}"`;
        case 'jsonPath': return `body.${a.path} == ${a.expected}`;
        case 'jsonPathExists': return `body.${a.path} exists`;
        case 'bodyContains': return `body contains "${a.expected}"`;
        case 'responseTimeBelow': return `responseTime < ${a.expectedMs}ms`;
    }
}

/**
 * Run a sequence of tests, threading extracted values from earlier results
 * into the variable context so later tests can reference them as {{name}}.
 * Environment variables are flattened with an `env.` prefix.
 *
 * If a test has a `dataset`, the test is expanded into N runs — one per row.
 * Each row's keys become row-scoped variables (not propagated). Result names
 * get a `[row-label]` suffix and result ids get `::row-N` so the UI can list
 * each parametrized run separately without collisions.
 */
export async function runTestSuite(
    tests: ApiTest[],
    envVars: Record<string, string> = {}
): Promise<{ results: ApiTestResult[]; finalVars: Record<string, string> }> {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(envVars || {})) vars[`env.${k}`] = String(v);

    const results: ApiTestResult[] = [];
    for (const t of tests) {
        const rows = (t.dataset && t.dataset.length > 0) ? t.dataset : [null];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const runVars = { ...vars };
            let runId = t.id;
            let runName = t.name;
            if (row) {
                for (const [k, v] of Object.entries(row)) runVars[k] = String(v);
                // Prefer a 'case' or 'name' label, else fall back to a numeric index
                const label = String(row.case ?? row.name ?? `row-${i + 1}`);
                runId = `${t.id}::${label}`;
                runName = `${t.name} [${label}]`;
            }
            const r = await runApiTest({ ...t, id: runId, name: runName }, runVars);
            results.push(r);
            // Only the LAST row's extractions propagate to subsequent tests.
            // For most chaining patterns (login → use token) this is the right
            // default; data-driven tests rarely want to chain across rows.
            if (r.extracted && i === rows.length - 1) {
                for (const [k, v] of Object.entries(r.extracted)) vars[k] = v;
            }
        }
    }
    return { results, finalVars: vars };
}

/* ─── OpenAPI parser → test scaffolds ────────────────────────────────── */

interface ParseOpts {
    baseUrl?: string;        // override / supplement the spec's `servers`
    maxTests?: number;
}

export interface ParseResult {
    success: boolean;
    detectedBaseUrl?: string;
    info?: { title?: string; version?: string };
    tests: ApiTest[];
    error?: string;
}

export function parseOpenApiSpec(specText: string, opts: ParseOpts = {}): ParseResult {
    let spec: any;
    try {
        spec = specText.trim().startsWith('{')
            ? JSON.parse(specText)
            : yaml.load(specText);
    } catch (e: any) {
        return { success: false, tests: [], error: `Failed to parse spec: ${e.message}` };
    }
    if (!spec || typeof spec !== 'object') {
        return { success: false, tests: [], error: 'Spec is empty or not an object' };
    }

    const servers: any[] = Array.isArray(spec.servers) ? spec.servers : [];
    const detectedBaseUrl = opts.baseUrl
        || servers[0]?.url
        || (spec.host ? `${spec.schemes?.[0] || 'https'}://${spec.host}${spec.basePath || ''}` : '');

    const tests: ApiTest[] = [];
    const paths = spec.paths || {};
    const cap = opts.maxTests || 100;

    for (const rawPath of Object.keys(paths)) {
        const ops = paths[rawPath] || {};
        for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
            const op = ops[method];
            if (!op) continue;
            if (tests.length >= cap) break;

            const expectedStatus = pickExpectedStatus(op.responses);
            // Substitute {path} params with a placeholder marker the user can
            // edit before running. Don't try to invent real IDs.
            const url = `${detectedBaseUrl}${rawPath}`.replace(/\{([^}]+)\}/g, ':$1');

            const requestBody = method === 'get' || method === 'delete' ? undefined : extractExampleBody(op, spec);

            const assertions: ApiAssertion[] = [];
            if (expectedStatus) assertions.push({ type: 'status', expected: expectedStatus });
            else assertions.push({ type: 'statusRange', range: '2xx' });
            assertions.push({ type: 'responseTimeBelow', expectedMs: 3000 });

            tests.push({
                id: `${method}-${rawPath}-${tests.length + 1}`,
                name: op.summary || `${method.toUpperCase()} ${rawPath}`,
                method: method.toUpperCase() as HttpMethod,
                url,
                headers: { Accept: 'application/json' },
                body: requestBody,
                assertions,
                timeoutMs: 15000,
            });
        }
    }

    return {
        success: true,
        detectedBaseUrl,
        info: { title: spec.info?.title, version: spec.info?.version },
        tests,
    };
}

function pickExpectedStatus(responses: any): number | undefined {
    if (!responses) return undefined;
    // Prefer 200/201/204, otherwise first 2xx code
    for (const c of ['200', '201', '204']) if (responses[c]) return Number(c);
    const code = Object.keys(responses).find((k) => /^2\d\d$/.test(k));
    return code ? Number(code) : undefined;
}

function extractExampleBody(op: any, spec: any): any {
    // OpenAPI 3
    const content = op.requestBody?.content;
    if (content) {
        const mt = content['application/json'] || Object.values(content)[0];
        if (mt) {
            if (mt.example !== undefined) return mt.example;
            if (mt.examples && typeof mt.examples === 'object') {
                const first = Object.values(mt.examples)[0] as any;
                if (first?.value !== undefined) return first.value;
            }
            if (mt.schema) return sampleFromSchema(mt.schema, spec);
        }
    }
    // Swagger 2 fallback
    const param = Array.isArray(op.parameters) ? op.parameters.find((p: any) => p.in === 'body') : null;
    if (param?.schema) return sampleFromSchema(param.schema, spec);
    return undefined;
}

// Generate a tiny sample object from a JSON Schema. Intentionally shallow —
// just enough to give the user a starting point they can edit.
function sampleFromSchema(schema: any, spec: any, depth = 0): any {
    if (!schema || depth > 4) return null;
    if (schema.$ref) {
        const ref = String(schema.$ref).replace(/^#\//, '').split('/');
        let resolved: any = spec;
        for (const seg of ref) resolved = resolved?.[seg];
        return resolved ? sampleFromSchema(resolved, spec, depth + 1) : null;
    }
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    switch (schema.type) {
        case 'string': return schema.enum?.[0] ?? 'string';
        case 'number':
        case 'integer': return 0;
        case 'boolean': return true;
        case 'array': return [sampleFromSchema(schema.items, spec, depth + 1)];
        case 'object':
        default: {
            const obj: any = {};
            const props = schema.properties || {};
            for (const k of Object.keys(props).slice(0, 8)) {
                obj[k] = sampleFromSchema(props[k], spec, depth + 1);
            }
            return obj;
        }
    }
}
