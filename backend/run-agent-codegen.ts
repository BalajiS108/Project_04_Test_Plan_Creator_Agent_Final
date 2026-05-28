/**
 * Alternative agent using code generation approach
 * Generates Playwright test code for all test cases and executes them
 */

import { chromium, Browser, Page } from "playwright";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { generatePlaywrightCode, inspectPageForCodeGen } from "./code-generator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CodeGenTestResult {
    testName: string;
    status: "PASS" | "FAIL" | "ERROR";
    actualResult: string;
    error?: string;
    duration: number;
}

interface CodeGenConfig {
    headless?: boolean;
    slowMo?: number;
    // Saved alongside other Script Library entries so users can re-run / inspect
    // it later. If omitted, defaults to "Codegen".
    productName?: string;
}

/**
 * New approach: Generate Playwright code and execute it
 */
export async function runAgentWithCodeGeneration(
    testCasesMarkdown: string,
    llmConfig: any,
    onProgress?: (status: any) => void,
    codeGenConfig?: CodeGenConfig
): Promise<{
    summary: {
        total: number;
        passed: number;
        failed: number;
        errors: number;
        duration: number;
    };
    generatedCode: string;
    results: CodeGenTestResult[];
    executionLog: string[];
}> {
    const startTime = Date.now();
    const executionLog: string[] = [];
    
    function log(msg: string) {
        console.log(msg);
        executionLog.push(msg);
        if (onProgress) {
            onProgress({ log: msg });
        }
    }

    try {
        // Step 1: Parse test cases
        log("\n📋 STEP 1: Parsing test cases...");
        const testCases = parseTestCases(testCasesMarkdown);
        log(`✅ Parsed ${testCases.length} test cases`);

        if (testCases.length === 0) {
            log("❌ No test cases found in markdown");
            return {
                summary: { total: 0, passed: 0, failed: 0, errors: 1, duration: 0 },
                generatedCode: "",
                results: [],
                executionLog
            };
        }

        // Step 2: Launch browser and inspect EVERY distinct URL referenced by
        // any test case's preconditions. Previously we inspected only the first
        // test's URL, which left the LLM blind to other pages and forced it to
        // hallucinate selectors/values for them.
        log("\n🌐 STEP 2: Launching browser and inspecting pages...");
        const browser = await chromium.launch({
            headless: codeGenConfig?.headless !== false,
            slowMo: codeGenConfig?.slowMo || 0
        });

        const page = await browser.newPage();

        const distinctUrls: string[] = [];
        for (const tc of testCases) {
            const m = tc.preconditions.match(/(https?:\/\/[^\s]+)/i);
            if (m) {
                const u = m[1].trim().replace(/[)"',.;]+$/, ''); // strip trailing punctuation
                if (!distinctUrls.includes(u)) distinctUrls.push(u);
            }
        }
        if (distinctUrls.length === 0) distinctUrls.push("about:blank");

        const pageInspections: any[] = [];
        for (const url of distinctUrls) {
            log(`📍 Navigating to: ${url}`);
            try {
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
                const inspection = await inspectPageForCodeGen(page);
                pageInspections.push(inspection);
                log(`✅ Inspected ${url} — ${inspection.elements.length} interactive elements`);
            } catch (e: any) {
                log(`⚠️  Could not inspect ${url}: ${e.message} — generator will work without DOM context for this page`);
            }
        }

        // Step 3: Generate Playwright code
        log("\n💻 STEP 3: Generating Playwright test code...");
        const generatedCode = await generatePlaywrightCode(
            testCases,
            pageInspections,
            llmConfig
        );
        
        log(`✅ Generated code (${generatedCode.split("\n").length} lines)`);

        // Save generated code to file
        const codeFilePath = path.join(__dirname, "..", "generated_tests.ts");
        fs.writeFileSync(codeFilePath, generatedCode);
        log(`📁 Saved generated code to: ${codeFilePath}`);

        //Step 4: Execute generated code (real Playwright CLI run — no more stub)
        log("\n⚙️  STEP 4: Executing generated tests via Playwright CLI...");

        // Close the inspection browser before handing off to the Playwright CLI —
        // we don't want two Chromium instances fighting for resources.
        await browser.close();

        const executionResults = await executeGeneratedCode(
            generatedCode,
            null,
            null as any,
            testCases,
            log,
            !codeGenConfig?.headless,
            (info) => {
                onProgress?.({
                    log: `Running: ${info.current}`,
                    progress: info.index,
                    total: executionResults?.length || info.total || testCases.length,
                });
            },
            codeGenConfig?.productName,
        );

        const totalDuration = Date.now() - startTime;
        const passed = executionResults.filter(r => r.status === "PASS").length;
        const failed = executionResults.filter(r => r.status === "FAIL").length;
        const errors = executionResults.filter(r => r.status === "ERROR").length;

        log(`\n✅ Execution complete!`);
        log(`Summary: ${passed} passed, ${failed} failed, ${errors} errors`);

        return {
            summary: {
                // Use the ACTUAL number of tests Playwright ran, not the
                // markdown-parsed count. If markdown had 5 cases but the LLM
                // consolidated them into 3 real tests, total should be 3.
                total: executionResults.length,
                passed,
                failed,
                errors,
                duration: totalDuration
            },
            generatedCode,
            results: executionResults,
            executionLog
        };

    } catch (err: any) {
        log(`\n❌ Fatal error: ${err.message}`);
        return {
            summary: { total: 0, passed: 0, failed: 0, errors: 1, duration: Date.now() - startTime },
            generatedCode: "",
            results: [],
            executionLog
        };
    }
}

/**
 * Parse test cases from markdown - supports multiple formats including 12-section test plan
 */
function parseTestCases(markdownPlan: string): any[] {
    console.log("🔍 Parsing test cases from markdown...");
    console.log("📝 Input length:", markdownPlan.length);
    console.log("📝 First 500 chars:", markdownPlan.substring(0, 500));
    
    const parsed: any[] = [];
    const lines = markdownPlan.split('\n');
    let headers: string[] = [];
    let isTable = false;

    // STEP 1: Try to parse as table format (for detailed test cases)
    console.log("📋 Attempting table format parsing...");
    for (const line of lines) {
        if (line.trim().startsWith('|')) {
            let cols = line.split('|').map(s => s.trim());
            if (cols[0] === '') cols.shift();
            if (cols[cols.length - 1] === '') cols.pop();

            if (!isTable) {
                const lowerCols = cols.map(c => c.toLowerCase());
                if (lowerCols.some(c => c.includes('test case') || c.includes('name'))) {
                    isTable = true;
                    headers = lowerCols;
                    console.log("✅ Found table format with headers:", headers);
                }
                continue;
            }

            if (cols[0].includes('---')) continue;

            const row: Record<string, string> = {};
            headers.forEach((h, i) => {
                row[h] = cols[i] || '';
            });

            const testCaseName = row['test case name'] || row['name'] || row['test case'];
            if (!testCaseName || testCaseName.includes('---')) continue;

            const stepRaw = row['steps'] || '';
            const steps = stepRaw.split(/<br\s*\/?>|\n/i)
                .map(s => s.trim().replace(/^\d+\.\s*/, ''))
                .filter(Boolean);

            parsed.push({
                id: parsed.length + 1,
                name: testCaseName,
                jiraKey: row['target jira issue'] || row['jira key'] || 'N/A',
                preconditions: row['preconditions'] || 'https://www.qaplayground.com',
                steps: steps.length > 0 ? steps : [stepRaw],
                expectedResult: row['expected result'] || '',
                priority: row['priority'] || 'Medium',
            });
        }
    }

    console.log(`📊 Found ${parsed.length} test cases from table format`);

    // STEP 2: If no table found, try to parse from 12-section format (Inclusions section)
    if (parsed.length === 0) {
        console.log("🔁 No table format found, trying 12-section format (Inclusions section)...");
        const fullText = markdownPlan;
        
        // Find the Inclusions section
        const inclusionsMatch = fullText.match(/###\s*3\.\s*\*?\*?Inclusions.*?\n([\s\S]*?)(?=###\s*[4-9]\.|$)/i);
        if (inclusionsMatch) {
            console.log("✅ Found Inclusions section");
            const inclusionText = inclusionsMatch[1];
            
            // Extract test scenarios from the inclusions section
            // Look for patterns like:
            // - **Create**: Scenarios...
            // - **Read**: Scenarios...
            // - **Update**: Scenarios...
            // etc.
            
            const scenarioMatches = inclusionText.matchAll(/[\*_]?\*?(?:Create|Read|Update|Delete|Boundary|Concurrency|Security|Performance)[\*_]?\*?:\s*([^\n]+(?:\n(?!\n|[\*_]?\*?(?:Create|Read|Update|Delete|Boundary|Concurrency|Security|Performance))[^\n]*)*)/gi);
            
            for (const match of scenarioMatches) {
                const operationType = match[0].split(':')[0].replace(/[\*_]/g, '').trim();
                const scenarioText = match[1];
                
                // Extract individual scenarios/bullet points
                const scenarios = scenarioText
                    .split(/\n/)
                    .filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'))
                    .map(line => line.replace(/^[\s\-\*]+/, '').trim())
                    .filter(Boolean);
                
                for (const scenario of scenarios) {
                    if (scenario.length > 0) {
                        parsed.push({
                            id: parsed.length + 1,
                            name: `${operationType}: ${scenario.substring(0, 80)}`,
                            jiraKey: 'INCLUSIONS',
                            preconditions: 'https://www.qaplayground.com',
                            steps: [scenario],
                            expectedResult: 'Scenario should execute successfully',
                            priority: 'Medium',
                        });
                    }
                }
            }
        }

        console.log(`📊 Found ${parsed.length} test cases from 12-section format`);
    }

    // STEP 3: If still no tests, try heading-based format
    if (parsed.length === 0) {
        console.log("🔁 No tests found, trying heading-based format...");
        let currentTest: any = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for test case headings (## or ###)
            if (line.match(/^#+\s+/) && !line.toLowerCase().includes('objective') && !line.toLowerCase().includes('scope')) {
                // Save previous test case
                if (currentTest && currentTest.name) {
                    parsed.push(currentTest);
                }
                
                // Create new test case from heading
                const headingText = line.replace(/^#+\s+/, '').trim();
                currentTest = {
                    id: parsed.length + 1,
                    name: headingText,
                    jiraKey: 'GENERATED',
                    preconditions: 'https://www.qaplayground.com',
                    steps: [],
                    expectedResult: 'Test should pass',
                    priority: 'Medium'
                };
            } else if (currentTest && line.length > 0) {
                if (!line.startsWith('#')) {
                    if (line.toLowerCase().includes('step')) {
                        currentTest.steps.push(line);
                    } else if (!currentTest.steps.length && line.length > 10) {
                        currentTest.steps.push(line);
                    }
                }
            }
        }
        
        if (currentTest && currentTest.name) {
            parsed.push(currentTest);
        }

        console.log(`📊 Found ${parsed.length} test cases from heading format`);
    }

    // STEP 4: If still empty, create default test case from URL
    if (parsed.length === 0) {
        console.log("⚠️  No test cases found - creating default test case");
        parsed.push({
            id: 1,
            name: "Basic Functionality Test",
            jiraKey: 'DEFAULT',
            preconditions: 'https://www.qaplayground.com',
            steps: ['Navigate to application', 'Verify page loads'],
            expectedResult: 'Application should load successfully',
            priority: 'High',
        });
    }

    console.log("✅ Test case parsing complete. Cases found:", parsed.length);
    console.log("📋 Test cases:", parsed.map(tc => ({ id: tc.id, name: tc.name })));
    return parsed;
}

/**
 * Execute generated code
 */
/**
 * Execute generated Playwright code by writing it to a temp .spec.ts and
 * shelling out to the Playwright CLI. Results come from the JSON reporter
 * so they reflect what *actually* happened — not what the markdown parser
 * thought would happen.
 *
 * Previously this function was a stub that auto-passed every parsed test case
 * regardless of whether the generated code matched, ran, or even compiled.
 * The mismatch between "5 cases shown" and "3 cases in .spec.ts" was a
 * symptom of that — the fake executor walked the markdown count, not the
 * real test count.
 *
 * `browser` and `page` from the inspection phase are passed in but no longer
 * used here — we let the Playwright CLI manage its own browser lifecycle so
 * the report (durations, screenshots-on-failure, traces) is honest.
 */
async function executeGeneratedCode(
    code: string,
    _browser: any,
    _page: Page,
    _testCasesUnused: any[],
    log: (msg: string) => void,
    headed: boolean = false,
    onTestProgress?: (info: { current: string; index: number; total: number }) => void,
    productName: string = "Codegen",
): Promise<CodeGenTestResult[]> {
    const { spawn } = await import("child_process");

    // Save under tests/generated/<productName>/ so the file shows up in the
    // Script Library alongside scripts saved via "Save Script File". Earlier
    // versions wrote to an orphan tests/generated/_codegen/ folder that the
    // library never listed.
    const projectRoot = path.join(__dirname, "..");
    const safeProduct = (productName || "Codegen").replace(/[^a-zA-Z0-9_-]/g, "_");
    const productDir = path.join(projectRoot, "tests", "generated", safeProduct);
    if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toTimeString().slice(0, 5).replace(":", "");
    const specPath = path.join(productDir, `${safeProduct}_codegen_${dateStr}_${timeStr}.spec.ts`);
    fs.writeFileSync(specPath, code, "utf8");
    log(`📝 Wrote generated spec to library: ${specPath}`);

    const relativePath = path.relative(projectRoot, specPath).replace(/\\/g, "/");
    const reportPath = path.join(projectRoot, `temp-codegen-report-${Date.now()}.json`);

    const playwrightBin = path.join(
        projectRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "playwright.cmd" : "playwright"
    );

    if (!fs.existsSync(playwrightBin)) {
        const msg = `Playwright binary not found at ${playwrightBin}`;
        log(`❌ ${msg}`);
        return [{
            testName: "Codegen execution",
            status: "ERROR",
            actualResult: msg,
            error: msg,
            duration: 0,
        }];
    }

    const args = ["test", relativePath, "--reporter=list,json"];
    if (headed) args.push("--headed");

    log(`▶️  Spawning: ${playwrightBin} ${args.join(" ")}`);

    return new Promise<CodeGenTestResult[]>((resolve) => {
        const child = spawn(playwrightBin, args, {
            cwd: projectRoot,
            shell: true,
            env: {
                ...process.env,
                PLAYWRIGHT_JSON_OUTPUT_NAME: path.basename(reportPath),
            },
        });

        let stdout = "";
        let stderr = "";
        let testsSeen = 0;

        child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            // Surface per-test progress from the 'list' reporter as it streams.
            // Lines look like: "  ✓  1 [chromium] › path/file.spec.ts:14:3 › Suite › Test title (1.2s)"
            for (const line of text.split("\n")) {
                const m = line.match(/›\s+([^›]+?)\s*(?:\(\d+(?:\.\d+)?[ms]+\))?\s*$/);
                if (m && line.includes("›")) {
                    testsSeen += 1;
                    onTestProgress?.({ current: m[1].trim(), index: testsSeen, total: 0 });
                    log(`🧪 ${m[1].trim()}`);
                }
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => {
            log(`❌ Failed to start Playwright: ${err.message}`);
            resolve([{
                testName: "Codegen execution",
                status: "ERROR",
                actualResult: err.message,
                error: err.message,
                duration: 0,
            }]);
        });

        child.on("close", (exitCode) => {
            // Try to read the JSON report — that's the source of truth.
            let report: any = null;
            try {
                if (fs.existsSync(reportPath)) {
                    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
                    fs.unlinkSync(reportPath);
                }
            } catch (e: any) {
                log(`⚠️  Could not parse Playwright report: ${e.message}`);
            }

            const out: CodeGenTestResult[] = [];
            const visit = (suite: any) => {
                if (Array.isArray(suite.specs)) {
                    for (const spec of suite.specs) {
                        const tc = spec.tests?.[0];
                        const r = tc?.results?.[0];
                        const status = r?.status === "passed" ? "PASS" : r?.status === "skipped" ? "FAIL" : "FAIL";
                        out.push({
                            testName: spec.title || "Unnamed test",
                            status: status as CodeGenTestResult["status"],
                            actualResult: status === "PASS" ? "Test passed" : (r?.error?.message ? r.error.message.slice(0, 500) : `Exit ${exitCode}`),
                            error: r?.error?.message,
                            duration: r?.duration || 0,
                        });
                    }
                }
                if (Array.isArray(suite.suites)) suite.suites.forEach(visit);
            };

            if (report?.suites) {
                report.suites.forEach(visit);
                log(`✅ Playwright completed. ${out.length} test(s) reported.`);
            } else {
                // No JSON report — the file likely failed to compile or load.
                const combined = (stdout + stderr).slice(-1500);
                log(`⚠️  No JSON report parsed. Returning single failure with last 1500 chars of output.`);
                out.push({
                    testName: "Codegen execution",
                    status: "ERROR",
                    actualResult: `Playwright produced no JSON report (exit ${exitCode}). Output tail:\n${combined}`,
                    error: stderr.slice(-500) || `Exit ${exitCode}`,
                    duration: 0,
                });
            }

            resolve(out);
        });
    });
}
