import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { isStopRequested, addPartialResult } from './server.js';
import { generatePlaywrightCode, inspectPageForCodeGen } from './code-generator.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const videosDir = path.join(__dirname, "videos");
if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
}

export interface TestCaseResult {
    id: number;
    name: string;
    jiraKey: string;
    priority: string;
    status: "PASS" | "FAIL" | "SKIPPED" | "ERROR";
    steps: { step: string; result: string; passed: boolean }[];
    expectedResult: string;
    actualResult: string;
    duration: number;
    error?: string;
    videoFile?: string; // filename of the recorded video
    testData?: string;
    // Set by the auto-heal pass when a re-run succeeded (true) or when the
    // healer's PASS verdict was rejected by the coverage integrity check
    // (healingFailed=true). The frontend renders these as badges.
    healed?: boolean;
    healingFailed?: boolean;
}

export interface ExecutionReport {
    summary: {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
        errors: number;
        duration: number;
        executedAt: string;
    };
    results: TestCaseResult[];
}

export function parseTestCases(markdownPlan: string): any[] {
    console.log("🔍 MCP Agent: Parsing test cases from markdown...");
    console.log("📝 Input length:", markdownPlan.length);

    const parsed: any[] = [];

    // STEP 1: Attempt parsing as Markdown Table first
    const lines = markdownPlan.split('\n');
    let headers: string[] = [];
    let isTable = false;

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
                    console.log("✅ Found table format");
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
            const steps = stepRaw.split(/<br\s*\/?>|\n/i).map(s => s.trim().replace(/^\d+\.\s*/, '')).filter(Boolean);

            let finalSteps = steps.length > 0 ? steps : [stepRaw];
            // FORCE LOGIN STEP: If the first step doesn't mention login, forcefully prepend it.
            if (finalSteps.length > 0 && !finalSteps[0].toLowerCase().includes('login')) {
                finalSteps.unshift('Login to Application (Navigate, Enter username, Enter password, Click Login)');
            }

            parsed.push({
                id: parsed.length + 1,
                name: testCaseName,
                jiraKey: row['target jira issue'] || row['jira key'] || row['jira'] || 'N/A',
                preconditions: row['preconditions'] || 'https://www.qaplayground.com',
                testData: row['test data'] || row['data'] || '',
                steps: finalSteps,
                expectedResult: row['expected result'] || row['expected'] || '',
                priority: row['priority'] || 'Medium',
            });
        }
    }

    if (parsed.length > 0) {
        console.log(`✅ Parsed ${parsed.length} test cases from table format`);
        return parsed;
    }

    // STEP 2: Try parsing from 12-section format (Inclusions section)
    console.log("🔁 No table format found, trying 12-section format (Inclusions section)...");
    const fullText = markdownPlan;
    const inclusionsMatch = fullText.match(/###\s*3\.\s*\*?\*?Inclusions.*?\n([\s\S]*?)(?=###\s*[4-9]\.|$)/i);

    if (inclusionsMatch && inclusionsMatch[1]) {
        console.log("✅ Found Inclusions section");
        const inclusionText = inclusionsMatch[1];

        // Extract CRUD and other scenario types with their bullet points
        const scenarioMatches = inclusionText.matchAll(/[\*-]\s*\*?\*?(?:Create|Read|Update|Delete|Boundary|Concurrency|Security|Performance)[\*_]?\*?:\s*([^\n]+(?:\n(?!\n|[\*_]?\*?(?:Create|Read|Update|Delete|Boundary|Concurrency|Security|Performance))[^\n]*)*)/gi);

        let scenarioIndex = 0;
        for (const match of scenarioMatches) {
            const operationType = match[0].split(':')[0].replace(/[\*_\-\s]/g, '').trim();
            const scenarioText = match[1].trim();

            // Extract bullet points
            const bulletPoints = scenarioText
                .split('\n')
                .filter(line => line.match(/^\s*[-*]/))
                .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
                .filter(line => line.length > 5);

            for (const scenario of bulletPoints) {
                parsed.push({
                    id: parsed.length + 1,
                    name: `${operationType}: ${scenario.substring(0, 70)}`,
                    jiraKey: 'INCLUSIONS',
                    preconditions: 'https://www.qaplayground.com',
                    testData: '',
                    steps: [scenario],
                    expectedResult: 'Scenario executes successfully',
                    priority: 'Medium',
                });
                scenarioIndex++;
            }
        }

        if (parsed.length > 0) {
            console.log(`✅ Parsed ${parsed.length} test cases from 12-section format`);
            return parsed;
        }
    }

    // STEP 3: Try standard block format with ### Test Case: headers
    console.log("🔁 No Inclusions section, trying block format...");
    const testCaseBlocks = markdownPlan.split(/###\s+Test Case:/i).filter(Boolean);
    for (let i = 0; i < testCaseBlocks.length; i++) {
        const block = testCaseBlocks[i].trim();
        if (!block) continue;

        const nameMatch = block.match(/^(.+?)(?:\n|$)/);
        const jiraMatch = block.match(/\*\*Target Jira Issue\*\*:\s*(.+)/i) || block.match(/\*\*Jira Key\*\*:\s*(.+)/i);
        const precondMatch = block.match(/\*\*Preconditions?\*\*:\s*(.+)/i);
        const testDataMatch = block.match(/\*\*Test Data\*\*:\s*(.+)/i);
        const expectedMatch = block.match(/\*\*Expected Result\*\*:\s*(.+)/i);
        const priorityMatch = block.match(/\*\*Priority\*\*:\s*(.+)/i);

        const stepsSection = block.match(/\*\*Steps\*\*:\s*\n([\s\S]*?)(?=\n\s*-\s*\*\*Expected|$)/i);
        const steps: string[] = [];
        if (stepsSection) {
            const stepLines = stepsSection[1].match(/\d+\.\s+(.+)/g);
            if (stepLines) {
                stepLines.forEach(s => steps.push(s.replace(/^\d+\.\s+/, '').trim()));
            } else {
                steps.push(stepsSection[1].trim());
            }
        }

        parsed.push({
            id: parsed.length + 1,
            name: nameMatch ? nameMatch[1].trim().replace(/^\*\*|\*\*$/g, '') : `Test Case ${parsed.length + 1}`,
            jiraKey: jiraMatch ? jiraMatch[1].trim() : 'N/A',
            preconditions: precondMatch ? precondMatch[1].trim() : 'https://www.qaplayground.com',
            testData: testDataMatch ? testDataMatch[1].trim() : '',
            steps: steps.length ? steps : ['Execute the case'],
            expectedResult: expectedMatch ? expectedMatch[1].trim() : '',
            priority: priorityMatch ? priorityMatch[1].trim() : 'Medium',
        });
    }

    if (parsed.length > 0) {
        console.log(`✅ Parsed ${parsed.length} test cases from block format`);
        return parsed;
    }

    // STEP 4: If still empty, create default test case
    console.log("⚠️  No test cases found - creating 1 default test case");
    parsed.push({
        id: 1,
        name: "Default Navigation Test",
        jiraKey: 'DEFAULT',
        preconditions: 'https://www.qaplayground.com',
        testData: '',
        steps: ['Navigate to QA Playground', 'Verify page loads successfully'],
        expectedResult: 'Application loads without errors',
        priority: 'High',
    });

    console.log(`✅ Test case parsing complete. Total: ${parsed.length}`);
    console.log("📋 Test cases:", parsed.map((tc, i) => `${i + 1}. ${tc.name}`));

    return parsed;
}

export async function runAgent(
    // Accept either raw markdown OR a pre-parsed test-case array. The parallel
    // runner (runAgentParallel) parses the full plan once, splits it across
    // workers, then passes each worker's slice as an array — saves re-parsing
    // the same markdown N times and lets us partition deterministically.
    testCasesInput: string | any[],
    llmConfig: any,
    onProgress?: (status: { currentCase: string; progress: number; total: number; action?: string; currentCaseId?: string; currentCaseName?: string }) => void,
    options?: { autoHeal?: boolean; headed?: boolean }
): Promise<ExecutionReport> {
    const testCasesMarkdown = typeof testCasesInput === 'string' ? testCasesInput : '';
    console.log("🚀 Starting Playwright MCP Agent with Video Recording...");
    const autoHeal = options?.autoHeal || false;
    // Default: headed (matches legacy behavior — users were used to seeing the
    // browser). Pass headed:false to run headless (faster, no window).
    const headed = options?.headed !== false;
    console.log(`🧬 Auto-Heal: ${autoHeal ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🖥️  Browser mode: ${headed ? 'HEADED (visible)' : 'HEADLESS'}`);
    const startTime = Date.now();

    // ── Performance tuning knobs ────────────────────────────────────────────
    // Override via env vars without touching code:
    //   MAX_AGENT_TURNS=10  (default 12) — max LLM round-trips per test case
    //   MAX_HEAL_TURNS=2    (default 3)  — auto-heal retries on failure
    //   TOOL_RESULT_CHARS=1500 (default 2000) — cap before appending to LLM history
    // Smaller numbers = faster + cheaper, larger = more headroom for complex tests.
    // Bumped from 12 → 20 → 30 because multi-step e2e flows (login → add to
    // cart → cart → checkout) need real headroom. With the new mandatory
    // "discover clickables before clicking" rule, every step that involves
    // a non-form button costs ~2 turns (discovery + click + maybe verify).
    // A 15-step SauceDemo flow can legitimately need 30+ turns. Override
    // via env var to tighten/loosen.
    const MAX_AGENT_TURNS = Number(process.env.MAX_AGENT_TURNS) || 30;
    // Bumped from 3 → 8. The healer is asked to "re-execute ALL steps from
    // scratch" — 3 turns made that impossible for any non-trivial test plan
    // (after the first heal call there was no time left for actions), which
    // is why every heal run looked like "show healing message, immediately
    // fail". 8 still keeps healing bounded so it doesn't burn forever.
    const MAX_HEAL_TURNS = Number(process.env.MAX_HEAL_TURNS) || 8;
    const TOOL_RESULT_CHARS = Number(process.env.TOOL_RESULT_CHARS) || 2000;

    /**
     * Tool results (page snapshots, accessibility trees, get_visible_text dumps)
     * can be huge — and they get re-sent in the conversation history on every
     * subsequent LLM turn. Capping them is the single biggest perf win.
     */
    const trimToolText = (text: string): string => {
        if (!text || text.length <= TOOL_RESULT_CHARS) return text;
        return text.slice(0, TOOL_RESULT_CHARS) + `\n…[truncated ${text.length - TOOL_RESULT_CHARS} chars]`;
    };

    console.log(`⚙️  Perf knobs: MAX_AGENT_TURNS=${MAX_AGENT_TURNS}, MAX_HEAL_TURNS=${MAX_HEAL_TURNS}, TOOL_RESULT_CHARS=${TOOL_RESULT_CHARS}`);

    // If caller supplied an already-parsed array (parallel runner path), use it
    // directly. Otherwise parse the markdown like before.
    const testCases = typeof testCasesInput === 'string'
        ? parseTestCases(testCasesMarkdown)
        : testCasesInput;
    console.log(`📋 Parsed ${testCases.length} test cases.`);

    if (onProgress) {
        onProgress({ currentCase: 'Connecting to MCP...', progress: 0, total: testCases.length });
    }

    if (testCases.length === 0) {
        return {
            summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, duration: 0, executedAt: new Date().toISOString() },
            results: []
        };
    }

    // Connect to MCP Playwright Server
    let client: Client | null = null;
    let mcpTools: any[] = [];

    // MCP Tools Schema (fallback if MCP server doesn't connect)
    const FALLBACK_TOOLS = [
        {
            name: "browser_navigate",
            description: "Navigate to a URL",
            inputSchema: {
                type: "object" as const,
                properties: {
                    url: {
                        type: "string",
                        description: "URL to navigate to"
                    }
                },
                required: ["url"],
            },
        },
        {
            name: "browser_click",
            description: "Click an element. Use text selector: 'text=ButtonText' or CSS selector",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS or text selector"
                    }
                },
                required: ["selector"],
            },
        },
        {
            name: "browser_fill",
            description: "Fill text input field",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "Input selector"
                    },
                    value: {
                        type: "string",
                        description: "Text value"
                    }
                },
                required: ["selector", "value"],
            },
        },
        {
            name: "browser_type",
            description: "Type text character by character",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "Input selector"
                    },
                    text: {
                        type: "string",
                        description: "Text to type"
                    }
                },
                required: ["selector", "text"],
            },
        },
        {
            name: "browser_fill_form",
            description: "Fill multiple form fields",
            inputSchema: {
                type: "object" as const,
                properties: {
                    fields: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                selector: { type: "string" },
                                value: { type: "string" },
                                type: { type: "string" }
                            },
                            required: ["selector", "value"]
                        },
                        description: "Array of {selector, value, type?} objects"
                    },
                    submitSelector: {
                        type: "string",
                        description: "Optional CSS selector for submit button"
                    }
                },
                required: ["fields"],
            },
        },
        {
            name: "browser_wait_for",
            description: "Wait for text or delay",
            inputSchema: {
                type: "object" as const,
                properties: {
                    text: {
                        type: "string",
                        description: "Text to wait for"
                    },
                    textGone: {
                        type: "string",
                        description: "Text to disappear"
                    },
                    time: {
                        type: "number",
                        description: "Milliseconds to wait"
                    }
                },
                required: [],
            },
        },
        {
            name: "browser_get_visible_text",
            description: "Get all visible page text and elements",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "Optional: get text from specific element"
                    }
                },
                required: [],
            },
        },
        {
            name: "browser_screenshot",
            description: "Take screenshot",
            inputSchema: {
                type: "object" as const,
                properties: {
                    filename: {
                        type: "string",
                        description: "Filename"
                    }
                },
            },
        },
        {
            name: "browser_press_key",
            description: "Press key (Enter, Tab, etc)",
            inputSchema: {
                type: "object" as const,
                properties: {
                    key: {
                        type: "string",
                        description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')"
                    }
                },
                required: ["key"],
            },
        },
        {
            name: "browser_check",
            description: "Check/uncheck checkbox",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "Checkbox selector"
                    },
                    checked: {
                        type: "boolean",
                        description: "true to check, false to uncheck"
                    }
                },
                required: ["selector"],
            },
        },
        {
            name: "browser_select_option",
            description: "Select dropdown option",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "Select element selector"
                    },
                    value: {
                        type: "string",
                        description: "Option value to select"
                    }
                },
                required: ["selector"],
            },
        },
        {
            name: "browser_read_text",
            description: "Read element text",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS selector of the element"
                    }
                },
                required: ["selector"],
            },
        },
        {
            name: "browser_evaluate",
            description: "Execute JavaScript code in the browser",
            inputSchema: {
                type: "object" as const,
                properties: {
                    script: {
                        type: "string",
                        description: "JavaScript code to execute"
                    }
                },
                required: ["script"],
            },
        },
        {
            name: "browser_hover",
            description: "Hover over an element",
            inputSchema: {
                type: "object" as const,
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS selector of the element to hover"
                    }
                },
                required: ["selector"],
            },
        },
        {
            name: "playwright_mark_step",
            description: "Mark the beginning of a new test step. CALL THIS before starting any browser actions for a specific step.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    stepIndex: {
                        type: "number",
                        description: "The 1-based index of the step being executed"
                    },
                    stepDescription: {
                        type: "string",
                        description: "A brief description of what this step involves"
                    }
                },
                required: ["stepIndex"],
            },
        },
    ];

    // Helper: push cold-start status updates to the UI so it doesn't look
    // frozen during the ~10-15s before the first test case actually starts.
    const reportStartupPhase = (action: string) => {
        try {
            onProgress?.({
                currentCase: 'Preparing browser…',
                progress: 0,
                total: testCases.length || 1,
                action,
                currentCaseId: 'STARTUP',
                currentCaseName: 'Preparing browser…',
            });
        } catch { /* status reporting is best-effort */ }
    };

    try {
        reportStartupPhase('Locating Playwright MCP server…');
        // Always prefer local playwright-mcp.ts for fast startup (no npm download)
        const localMcpScript = path.join(__dirname, 'playwright-mcp.ts');
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        let command = npxCmd;
        let args = ['-y', '@playwright/mcp@latest'];

        if (fs.existsSync(localMcpScript)) {
            command = npxCmd;
            args = ['tsx', localMcpScript];
            console.log(`✅ Using LOCAL playwright-mcp.ts (fast startup): ${localMcpScript}`);
        } else {
            console.log(`⚠️ Local playwright-mcp.ts not found. Falling back to @playwright/mcp@latest (may be slow)`);
        }

        console.log(`🔌 Attempting to connect to MCP Playwright Server...`);
        console.log(`   Command: ${command} ${args.join(" ")}`);
        reportStartupPhase('Spawning Playwright MCP server process…');

        const transport = new StdioClientTransport({
            command,
            args,
            // Forward headed/headless preference to the spawned MCP child.
            // playwright-mcp.ts reads MCP_HEADLESS to pick chromium launch mode.
            env: {
                ...(process.env as Record<string, string>),
                MCP_HEADLESS: headed ? '0' : '1',
            },
        });

        client = new Client(
            { name: "test-runner-client", version: "1.0.0" },
            { capabilities: {} }
        );

        // Set a timeout for MCP connection
        reportStartupPhase(`Connecting to MCP server${headed ? ' and launching visible browser' : ''} (this can take 10-15s on the first run)…`);
        const connectionPromise = client.connect(transport);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MCP connection timeout after 30 seconds")), 30000)
        );

        await Promise.race([connectionPromise, timeoutPromise]);

        reportStartupPhase('Loading available browser tools…');
        const toolsResponse = await client.listTools();
        mcpTools = toolsResponse.tools;

        // CRITICAL FIX: Add playwright_mark_step to MCP tools since the system prompt demands it
        const markStepTool = FALLBACK_TOOLS.find(t => t.name === 'playwright_mark_step');
        if (markStepTool && !mcpTools.some(t => t.name === 'playwright_mark_step')) {
            mcpTools.push(markStepTool as any);
        }

        if (mcpTools.length > 0) {
            console.log(`✅ MCP Connected! ${mcpTools.length} tools loaded from server`);
            console.log(`\n📋 REAL MCP TOOL SCHEMAS (first 3 tools):`);
            mcpTools.slice(0, 3).forEach((tool, idx) => {
                console.log(`\n   Tool ${idx + 1}: ${tool.name}`);
                console.log(`   Description: ${tool.description}`);
                console.log(`   Schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);
            });
        } else {
            throw new Error("MCP connected, but no browser tools were detected. Please verify @playwright/mcp is installed and running correctly.");
        }
    } catch (err: any) {
        console.error("❌ MCP Server connection failed. Real browser execution is required.");
        console.error(`   Reason: ${err.message}`);
        console.error("   Ensure @playwright/mcp is installed and can start on this machine.");
        throw new Error(`MCP connection failed: ${err.message}. Real browser execution cannot continue without a working Playwright MCP server.`);
    }

    // CRITICAL: Ensure we ALWAYS have tools
    if (!mcpTools || mcpTools.length === 0) {
        console.error("❌ CRITICAL ERROR: No tools available!");
        throw new Error("No MCP tools available. Ensure @playwright/mcp is installed and connected properly.");
    }

    console.log(`\n📊 Tools Summary:`);
    console.log(`   Total tools available: ${mcpTools.length}`);
    console.log(`   MCP Connected: ${client !== null}`);
    if (client !== null) {
        console.log(`   ✅ Using REAL MCP tool schemas (NOT fallback)`);
    } else {
        console.log(`   ⚠️ Using FALLBACK tool schemas (MCP not available)`);
    }
    mcpTools.forEach((tool, idx) => console.log(`   ${idx + 1}. ${tool.name}`));

    // Connect to LLM
    const getBaseURL = (config: any): string => {
        switch (config.provider) {
            case 'Groq':
                return 'https://api.groq.com/openai/v1';
            case 'Ollama':
                const base = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
                return base.includes('/v1') ? base : `${base}/v1`;
            case 'Gemini':
                return 'https://generativelanguage.googleapis.com/v1beta/openai/';
            case 'OpenAI':
            default:
                return 'https://api.openai.com/v1';
        }
    };

    const resolvedBaseURL = getBaseURL(llmConfig);

    const openai = new OpenAI({
        apiKey: llmConfig.apiKey || (llmConfig.provider === 'Ollama' ? 'ollama' : 'dummy'),
        baseURL: resolvedBaseURL,
        // Some local providers fail if headers are present but empty
        defaultHeaders: llmConfig.apiKey ? undefined : {} 
    });

    console.log(`\n🤖 LLM Configuration:`);
    console.log(`   Provider: ${llmConfig.provider || 'OpenAI'}`);
    console.log(`   Resolved Base URL: ${resolvedBaseURL}`);
    console.log(`   Config baseUrl (may be stale): ${llmConfig.baseUrl || '(empty)'}`);
    console.log(`   Model: ${llmConfig.model || 'gpt-4o'}`);
    console.log(`   API Key provided: ${(llmConfig.apiKey || 'dummy').length > 5 ? 'Yes' : 'No (using dummy)'}`);


    const formattedTools = mcpTools.map(tool => {
        // Extract schema - MCP or fallback
        const schema = tool.inputSchema || { type: "object", properties: {} };

        // Build clean parameters that OpenAI expects
        const cleanSchema = {
            type: "object" as const,
            properties: schema.properties || {},
            required: Array.isArray(schema.required) ? schema.required : []
        };

        // Clean up any extra fields that might cause issues
        return {
            type: "function" as const,
            function: {
                name: String(tool.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
                description: String(tool.description || "No description provided"),
                parameters: cleanSchema
            }
        };
    });

    console.log(`\n🛠️  Formatted Tools for LLM (${formattedTools.length}):`);
    formattedTools.forEach((t: any, idx: number) => {
        const props = Object.keys(t.function.parameters?.properties || {});
        const required = t.function.parameters?.required || [];
        console.log(`   ${idx + 1}. ${t.function.name}`);
        console.log(`      Properties: ${props.join(", ") || "none"}`);
        console.log(`      Required: [${required.join(", ") || "none"}]`);
    });

    if (formattedTools.length === 0) {
        console.error("❌ CRITICAL: No formatted tools available! Test execution will fail.");
        throw new Error("No tools available for test execution. Check MCP configuration and FALLBACK_TOOLS.");
    }

    // Validate all tool schemas before proceeding
    let schemaValidationError = false;
    const validatedTools: any[] = [];

    formattedTools.forEach((tool: any, idx: number) => {
        const params = tool.function.parameters;
        let isValid = true;
        const issues: string[] = [];

        // Check basic structure
        if (!params) {
            issues.push("missing parameters object");
            isValid = false;
        }
        if (params && params.type !== "object") {
            issues.push(`type is '${params.type}' instead of 'object'`);
            isValid = false;
        }

        // Check properties
        if (params && (!params.properties || typeof params.properties !== "object")) {
            issues.push("properties is missing or not an object");
            // Don't fail - properties can be empty
        }

        // Check required
        if (params && params.required && !Array.isArray(params.required)) {
            issues.push(`required is '${typeof params.required}' instead of array`);
            isValid = false;
        }

        // Check description
        if (!tool.function.description) {
            console.warn(`  ⚠️  Tool ${idx + 1} (${tool.function.name}): missing description`);
        }

        if (isValid) {
            validatedTools.push(tool);
        } else {
            console.error(`  ❌ Tool ${idx + 1} (${tool.function.name}): ${issues.join("; ")}`);
            schemaValidationError = true;
        }
    });

    console.log(`\n✅ Schema Validation: ${validatedTools.length}/${formattedTools.length} tools passed`);

    if (validatedTools.length === 0) {
        console.error("❌ CRITICAL: No tools passed schema validation!");
        console.error("All tool schemas are malformed. Cannot proceed.");
        throw new Error("Tool schemas are malformed. Cannot proceed with test execution.");
    }

    if (schemaValidationError) {
        console.warn(`⚠️  WARNING: ${formattedTools.length - validatedTools.length} tools were skipped due to schema errors`);
    }

    // Use only validated tools going forward
    const finalFormattedTools = validatedTools;

    // CRITICAL: Tool inventory before execution
    console.log(`\n🔐 FINAL TOOL INVENTORY (Ready for LLM):`);
    console.log(`   Total tools: ${finalFormattedTools.length}`);
    console.log(`   Using: ${client !== null ? "REAL MCP schemas" : "FALLBACK schemas"}`);
    console.log(`   MCP Connected: ${client !== null ? "YES ✅" : "NO ❌"}`);

    console.log(`\n📋 TOOL SCHEMAS BEING SENT TO LLM:`);
    finalFormattedTools.forEach((tool, idx) => {
        console.log(`\n   [${idx + 1}] ${tool.function.name}`);
        console.log(`       Description: ${tool.function.description}`);
        console.log(`       Parameters:`);
        const props = tool.function.parameters?.properties || {};
        Object.entries(props).forEach(([key, val]: any) => {
            const required = (tool.function.parameters?.required || []).includes(key) ? "(REQUIRED)" : "(optional)";
            console.log(`         - ${key}: ${val.type} ${required}`);
            if (val.description) console.log(`           ${val.description}`);
        });
    });

    if (finalFormattedTools.length === 0) {
        console.error("\n❌ CRITICAL: NO VALIDATED TOOLS AVAILABLE!");
        console.error("   Cannot proceed with test execution - no tools to send to LLM");
        throw new Error("No tools available for test execution after schema validation.");
    }

    // Verify no schema mismatches with MCP tools
    if (client !== null && mcpTools.length > 0) {
        console.log(`\n✅ VERIFY: MCP connected - using ${mcpTools.length} real tools with correct schemas`);
        console.log(`   Schema source: @playwright/mcp@latest`);
        console.log(`   ⚠️  Note: Real MCP tools use 'ref' for element selection, NOT 'selector'`);
    }

    // Execute each test case
    const results: TestCaseResult[] = [];
    let lastKnownUrl: string | null = null;

    // Strip a redundant "Step N." / "Step N:" prefix from a step's text.
    // Test plans authored by humans (or earlier LLMs) often number each
    // step inside its own text, so a 14-step plan reads:
    //    14. Step 13. Click the Checkout button.
    // The agent sees two adjacent numbers and frequently picks the wrong
    // one for playwright_mark_step (it grabbed 13, but the integrity check
    // expects 14 = the position). Strip the embedded prefix so the LLM
    // only ever sees ONE number — the position we control.
    const stripEmbeddedStepPrefix = (s: string): string => {
        if (!s) return s;
        return s.replace(/^\s*step\s+\d+\s*[:.\-)]\s*/i, '').trimStart();
    };

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        // Normalize every step's text once per test case. Downstream code
        // (prompt formatting, step display, coaching messages, integrity
        // check) all read from tc.steps; doing this in-place is cheaper
        // than threading a derived array through every call site.
        if (Array.isArray(tc.steps)) {
            tc.steps = tc.steps.map((s: any) => typeof s === 'string' ? stripEmbeddedStepPrefix(s) : s);
        }
        const tcStart = Date.now();
        console.log(`\n${'='.repeat(80)}`);
        console.log(`▶ TEST CASE [${i + 1}/${testCases.length}]: TC-${tc.id}: ${tc.name} (${tc.jiraKey})`);
        console.log(`${'='.repeat(80)}`);
        console.log(`   Test Data: ${tc.testData || 'None'}`);
        console.log(`   Status: STARTING...`);

        if (onProgress) {
            onProgress({
                currentCase: `Running: TC-${tc.id}: ${tc.name}`,
                currentCaseId: `TC-${tc.id}`,
                currentCaseName: tc.name,
                progress: i + 1,
                total: testCases.length
            });
        }

        const stepResults: { step: string; result: string; passed: boolean }[] = [];
        const actionLog: string[] = [];
        let videoFile: string | undefined = undefined;

        if (isStopRequested()) {
            console.log("🛑 Execution stopped by user.");
            if (onProgress) {
                onProgress({
                    currentCase: "Stopped by user",
                    currentCaseId: "",
                    currentCaseName: "Stopped",
                    progress: i,
                    total: testCases.length
                });
            }
            // Push placeholder SKIPPED entries for every test case that never ran,
            // including the one we were about to start. This way the report shows
            // the FULL plan size with the un-executed tests honestly marked
            // SKIPPED instead of silently dropped or wrongly marked FAIL.
            for (let j = i; j < testCases.length; j++) {
                const skipTc = testCases[j];
                const skippedResult = {
                    id: skipTc.id,
                    name: skipTc.name,
                    jiraKey: skipTc.jiraKey,
                    priority: skipTc.priority,
                    status: 'SKIPPED' as const,
                    steps: (skipTc.steps || []).map((s: string, k: number) => ({
                        step: `Step ${k + 1}: ${s}`,
                        result: 'Not executed — run stopped by user',
                        passed: false,
                    })),
                    expectedResult: skipTc.expectedResult,
                    actualResult: 'Skipped: execution was stopped by user before this test case ran',
                    duration: 0,
                    testData: skipTc.testData,
                };
                results.push(skippedResult);
                addPartialResult(skippedResult);
            }
            break;
        }
        // Video recording skipped per user request

        try {
            // 🔄 CRITICAL: For test case 2+, close the old page and create completely fresh page
            if (client && i > 0) {
                console.log(`\n🔄 PREPARING FRESH BROWSER STATE FOR TEST CASE ${i + 1}...`);

                // Step 1: Try to close the current page
                console.log(`   Step 1: Closing previous page...`);
                try {
                    await client.callTool({
                        name: "playwright_close_page",
                        arguments: {}
                    });
                    console.log(`   ✅ Previous page closed`);
                } catch (closeErr: any) {
                    console.log(`   ℹ️ playwright_close_page not available: ${closeErr.message}`);
                }

                // Step 2: Create a completely new page
                console.log(`   Step 2: Creating brand new page for test case ${i + 1}...`);
                try {
                    const newPageRes = await client.callTool({
                        name: "playwright_new_page",
                        arguments: {}
                    });
                    console.log(`   ✅ New page created successfully`);
                    console.log(`   📄 Page response: ${JSON.stringify(newPageRes).slice(0, 200)}`);
                } catch (pageErr: any) {
                    console.log(`   ℹ️ playwright_new_page not available or failed: ${pageErr.message}`);
                }

                // Step 3: Verify we're on a fresh page by navigating to about:blank first
                console.log(`   Step 3: Verifying fresh page state...`);
                try {
                    const blankNav = await client.callTool({
                        name: "playwright_navigate",
                        arguments: { url: "about:blank" }
                    });
                    console.log(`   ✅ Successfully navigated to about:blank - page is fresh`);
                } catch (blankErr: any) {
                    console.log(`   ⚠️ Could not navigate to about:blank: ${blankErr.message}`);
                }

                console.log(`✅ TEST CASE ${i + 1}: Fresh browser page prepared\n`);
            }

            const uniqueEmail = `testuser_${Date.now()}@testmail.com`;

            // Extract URL from preconditions, test data, or steps
            const extractUrl = (tc: any): string | null => {
                const searchString = `${tc.preconditions || ''} ${tc.testData || ''} ${tc.steps?.join(' ') || ''}`;
                const urlMatch = searchString.match(/(https?:\/\/[^\s]+)/i);
                return urlMatch ? urlMatch[1].trim() : null;
            };

            let urlFromPreconditions = extractUrl(tc);
            if (urlFromPreconditions) {
                lastKnownUrl = urlFromPreconditions;
            } else if (lastKnownUrl) {
                urlFromPreconditions = lastKnownUrl;
                console.log(`   ℹ️ Inheriting URL from previous test case: ${lastKnownUrl}`);
            }

            if (!urlFromPreconditions) {
                console.warn(`  ⚠️ WARNING: No URL found for test case "${tc.name}".`);
            }

            // Generate system prompt dynamically based on REAL available tools
            // Build tool documentation from actual schemas
            const toolDocs = finalFormattedTools.map(t => {
                const paramNames = Object.keys(t.function.parameters?.properties || {});
                const required = (t.function.parameters?.required || []).join(", ");
                return `- ${t.function.name}: ${t.function.description}\n  Parameters: ${paramNames.join(", ") || "none"}\n  Required: [${required || "optional"}]`;
            }).join("\n");

            // Find dynamic tool names based on actual available tools
            // Simply iterate through and find the EXACT tools we need
            console.log(`\n🔍 SIMPLE TOOL DETECTION (no regex):`);
            console.log(`   Tools available: ${finalFormattedTools.map(t => t.function.name).join(", ")}`);

            let navigateTool: string | undefined;
            let inspectTool: string | undefined;
            let clickTool: string | undefined;
            let fillTool: string | undefined;

            // Directly find tools by checking exact names (both browser_* AND playwright_* prefixes)
            for (const tool of finalFormattedTools) {
                const name = tool.function.name;
                console.log(`   Checking: "${name}"`);

                // Navigate tool - match both browser_navigate AND playwright_navigate
                if (name === 'browser_navigate' || name === 'playwright_navigate') {
                    navigateTool = name;
                    console.log(`     ✅ Found navigate: ${name}`);
                }

                // Inspect tools (snapshot for MCP, or get_visible_text for fallback)  
                if (name === 'browser_snapshot' || name === 'browser_get_visible_text' ||
                    name === 'playwright_snapshot' || name === 'playwright_get_visible_text') {
                    inspectTool = name;
                    console.log(`     ✅ Found inspect: ${name}`);
                }

                // Click tool - match both browser_click AND playwright_click
                if (name === 'browser_click' || name === 'playwright_click') {
                    clickTool = name;
                    console.log(`     ✅ Found click: ${name}`);
                }

                // Fill tools - match browser_* and playwright_* variants
                if (name === 'browser_type' || name === 'browser_fill' || name === 'browser_run_code' ||
                    name === 'playwright_type' || name === 'playwright_fill') {
                    // Prefer type > fill > run_code
                    if (!fillTool || name === 'browser_type' || name === 'playwright_type') {
                        fillTool = name;
                        console.log(`     ✅ Found fill: ${name}`);
                    }
                }
            }

            console.log(`\n🔍 DETECTED TOOLS (after search):`);
            console.log(`   navigateTool: ${navigateTool || '❌ NOT FOUND'}`);
            console.log(`   inspectTool: ${inspectTool || '❌ NOT FOUND'}`);
            console.log(`   clickTool: ${clickTool || '❌ NOT FOUND'}`);
            console.log(`   fillTool: ${fillTool || '❌ NOT FOUND'}`);
            console.log(`   ALL AVAILABLE: ${finalFormattedTools.map(t => t.function.name).join(", ")}`);

            // Ensure we have all required tools
            if (!navigateTool) {
                console.error(`❌ No navigate tool found!`);
                throw new Error(`CRITICAL: Cannot find navigate tool in available tools: ${finalFormattedTools.map(t => t.function.name).join(", ")}`);
            }
            if (!inspectTool) {
                console.error(`❌ No inspect/text tool found!`);
                throw new Error(`CRITICAL: Cannot find inspect/text tool in available tools: ${finalFormattedTools.map(t => t.function.name).join(", ")}`);
            }
            if (!clickTool) {
                console.error(`❌ No click tool found!`);
                throw new Error(`CRITICAL: Cannot find click tool in available tools: ${finalFormattedTools.map(t => t.function.name).join(", ")}`);
            }
            if (!fillTool) {
                console.error(`❌ No fill tool found!`);
                throw new Error(`CRITICAL: Cannot find fill tool in available tools: ${finalFormattedTools.map(t => t.function.name).join(", ")}`);
            }

            // Validate that detected tools actually exist in our tool list
            console.log(`\n✅ VALIDATING DETECTED TOOLS:`);
            const toolNamesArray = finalFormattedTools.map(t => t.function.name);
            const toolsToValidate = [
                { name: 'navigate', tool: navigateTool },
                { name: 'inspect', tool: inspectTool },
                { name: 'click', tool: clickTool },
                { name: 'fill', tool: fillTool }
            ];

            for (const { name, tool } of toolsToValidate) {
                const exists = toolNamesArray.includes(tool);
                console.log(`   ${exists ? '✅' : '❌'} ${name}: ${tool} - ${exists ? 'Found' : 'NOT FOUND!'}`);
                if (!exists) {
                    throw new Error(`CRITICAL: ${name} tool '${tool}' not found in available tools: ${toolNamesArray.join(", ")}`);
                }
            }
            console.log(`✅ All required tools validated and present`);

            const hasSignupStep = tc.steps.some((s: string) => /sign\s*up/i.test(s));
            const signupInstruction = hasSignupStep
                ? `
7. If the test includes Sign Up, after navigation and page inspection click the Sign Up button, link, or URL first before continuing.`
                : "";

            // ── Site-specific selector cheatsheets ────────────────────────────
            // For known stable demo sites, inject the exact selectors. This
            // turns "guess the Add to cart button" from an LLM riddle into a
            // copy-from-the-list operation. Add new sites here as needed —
            // criteria: site DOM is stable and we've eaten enough false-pass
            // cycles on it that it's worth hardcoding.
            const tcText = `${tc.name} ${tc.expectedResult || ''} ${(tc.steps || []).join(' ')} ${tc.testData || ''} ${urlFromPreconditions || ''}`.toLowerCase();
            let siteCheatsheet = '';
            if (/saucedemo\.com/.test(tcText)) {
                siteCheatsheet = `
## SITE CHEATSHEET — saucedemo.com (DOM is stable; USE THESE VERBATIM)

Login page (/):
- Username input:      #user-name
- Password input:      #password
- Login button:        #login-button
- Accepted users:      standard_user, problem_user, performance_glitch_user, error_user, visual_user
- Password (all):      secret_sauce
- Error banner:        [data-test="error"]  (only appears after a failed login submit)

Inventory page (/inventory.html — appears after a successful login):
- Cart icon (top-right):       #shopping_cart_container  (link, NOT a button)
- Cart badge with count:       .shopping_cart_badge      (only present when cart is non-empty)
- Add-to-cart button pattern:  #add-to-cart-<product-name-lowercased-with-hyphens>
    examples: #add-to-cart-sauce-labs-backpack, #add-to-cart-sauce-labs-bolt-t-shirt,
              #add-to-cart-sauce-labs-bike-light, #add-to-cart-sauce-labs-fleece-jacket,
              #add-to-cart-sauce-labs-onesie, #add-to-cart-test.allthethings()-t-shirt-(red)
- After click, the button is REPLACED by a Remove button with id pattern:
    #remove-<product-name-lowercased-with-hyphens>
  (the original #add-to-cart-… selector no longer exists in the DOM — don't re-target it)
- Product titles use:          .inventory_item_name      (multi-match — use .filter({hasText:'...'}) if asserting)

Cart page (/cart.html — after clicking #shopping_cart_container):
- Each line item:              .cart_item                (MULTI-MATCH — use .first() or .filter({hasText:'...'}))
- Item names in cart:          [data-test="inventory-item-name"]  (preferred over .cart_item .inventory_item_name)
- Continue Shopping button:    #continue-shopping
- Checkout button:             #checkout

Checkout step one (/checkout-step-one.html):
- First name input:            #first-name
- Last name input:             #last-name
- ZIP code input:              #postal-code
- Continue button:             #continue
- Cancel button:               #cancel

Checkout step two (/checkout-step-two.html):
- Finish button:               #finish
- Cancel button:               #cancel

Checkout complete (/checkout-complete.html):
- Success banner text:         "Thank you for your order!" (use playwright_get_visible_text to verify)
- Back home button:            #back-to-products

If the test plan refers to "Add to cart" for a specific product, ALWAYS use the per-product #add-to-cart-… id. Generic getByText('Add to cart') will match every product on the inventory page and fail strict mode.
`;
            }

            const systemPrompt = `You are a QA test automation expert executing browser tests with Playwright tools.

## MANDATORY EXECUTION PROTOCOL (Follow in exact order)

### STEP 1 - ALIGN WITH TEST STEPS
You MUST call playwright_mark_step(stepIndex=X, stepDescription="<exact text from Test Steps>") at the beginning of each logical test step.
Do NOT call playwright_mark_step for every individual action. Only call it when you transition to a new step defined in the "Test Steps" list.
For example, if Test Step 1 is "Login to Application", call playwright_mark_step(1, "Login to Application") and then perform the navigation, filling, and clicking needed to log in.

EVERY STEP MUST BE EXECUTED. If the Test Steps list has 5 steps, you must call playwright_mark_step for steps 1, 2, 3, 4 AND 5 and perform the required browser actions for each. Skipping a step and then declaring PASS is treated as a FAIL by the post-execution integrity check — the system will detect missing mark_step calls and override your verdict to FAIL with a list of skipped steps. There is no shortcut: each step must be reached, marked, and its actions executed before you may return PASS.

If you encounter a blocker mid-flow (an element won't appear, navigation fails, an unexpected page state) DO NOT bail out and declare PASS — return FAIL with a clear actualResult describing where you got stuck and which step you couldn't complete.

### STEP 2 - NAVIGATE
Always navigate to the URL provided in the preconditions first.

### STEP 3 - DISCOVER & EXECUTE
For each action within a step:
1. **Before filling forms:** call playwright_get_input_fields to see input selectors.
2. **Before clicking ANY button or link that isn't a form-submit (e.g. "Add to cart", "Open Cart", a product tile, a "Next" link):** you MUST call playwright_evaluate to enumerate the clickable elements with their actual ids/data-test/text. Use exactly this script (it filters to visible/clickable items and returns at most 60):

\`\`\`
playwright_evaluate(script: \`
JSON.stringify(
  Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]'))
    .filter(el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      id: el.id || null,
      dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || null,
      name: el.getAttribute('name') || null,
      href: el.getAttribute('href') || null
    }))
    .slice(0, 60),
  null, 2
)
\`)
\`\`\`

3. Pick the EXACT id or data-test value the script returned. Do NOT guess. Do NOT invent. If the test plan says "Add Sauce Labs Bolt T-Shirt to cart" and the script returns \`{id: "add-to-cart-sauce-labs-bolt-t-shirt", text: "Add to cart"}\`, click \`#add-to-cart-sauce-labs-bolt-t-shirt\` — not \`text=Add to cart\` (which would match every product).

4. **If your click did nothing** (page didn't change, no element appeared) and you've not yet diagnosed why, immediately call the enumeration script above on the CURRENT page state. The selector you used may no longer exist (page navigated) or may have been ambiguous.

5. **NEVER call the same playwright_click selector more than twice in a row.** If the second attempt doesn't change the page, the selector is wrong — re-enumerate (step 2) instead of trying a third time. Repeated identical clicks waste your turn budget and the system will detect this as a stuck loop.

6. IMPORTANT: If an action (like a click) doesn't seem to navigate or change the page, check for validation tooltips on ALL input fields using:
   playwright_evaluate(script="Array.from(document.querySelectorAll('input, select, textarea')).map(el => el.validationMessage).filter(m => m !== '').join(', ')")

### STEP 3 - SELECTOR PRIORITY (most reliable → least)
1. ID selector: #email, #password, #submit-btn
2. data-testid or custom data attributes: [data-testid="login-button"]
3. ARIA labels or Roles: [aria-label="Submit Form"], role="button"
4. Type+name: input[name="email"], input[name="password"]  
5. Placeholder: input[placeholder="Enter email"]
6. Button text: text=Sign In, text=Submit, text=Register
7. Type: input[type="email"], input[type="password"], button[type="submit"]

### STEP 4 - ROBUST LOCATOR STRATEGY
NEVER guess selectors. If a selector from a tool call fails:
1. Call playwright_get_input_fields again to refresh the element list.
2. Search for the element by text content or partial ID.
3. Use playwright_evaluate to find elements via document.querySelector if needed.
4. If an element is found but not clickable, check for overlays or if it's hidden.

### STEP 5 - FILL FORMS
Use playwright_fill for text inputs: playwright_fill(selector="#email", value="test@example.com")
Use playwright_fill for passwords: playwright_fill(selector="#password", value="Test123!")

### STEP 6 - VERIFY & PROGRESS
After each action, verify the outcome.
1. If a validation error appears (e.g., "Password is required"):
   - If the test step was specifically intended to verify this message, mark it as PASS.
   - If the test step was trying to progress (e.g., "Login to app"), and you see a missing field error, try to fill that field even if not explicitly in the step text, to "heal" the path.
2. IMPORTANT: If an action fails, check for browser validation tooltips (e.g., "Please fill out this field") using playwright_evaluate(script="document.activeElement.validationMessage").

### STEP 7 - VERIFY EXPECTED RESULT (MANDATORY before PASS)
"All my clicks worked" is NOT a pass. Before returning PASS you MUST collect concrete evidence that the *Expected Result* actually occurred. Skipping this step and returning PASS based only on click success is the #1 cause of bogus passes.

Required verification calls (run AT LEAST ONE that fits the Expected Result):
- playwright_get_visible_text() → check that the expected text/heading/error message is present (or absent, for negative cases)
- playwright_evaluate(script="location.href") → check the URL changed (positive flow) or did NOT change (negative flow)
- playwright_evaluate(script="document.querySelector('<expected-selector>')?.textContent") → check a specific element rendered

NEGATIVE-OUTCOME tests (Expected Result = "user stays on X", "login fails", "error appears", "validation prevents submit", "form not submitted", etc.):
- You MUST positively verify the negative state. A missing navigation alone is NOT evidence — the page might still be loading.
- For blank/invalid login: verify the URL is still the login page AND an error message is present (or the inputs are still focused with validation tooltips). Get the error text with playwright_get_visible_text() or playwright_evaluate.
- If you cannot find any error indicator and the URL didn't change, that's still evidence — but say so in actualResult ("No error message rendered; URL unchanged from /login").
- If the URL DID change to a logged-in destination (e.g. /inventory) when the test expected blockage, that is a FAIL.

POSITIVE-OUTCOME tests (Expected Result = "user lands on X", "item appears", "success message shown"):
- Verify the new page/element is actually visible. Don't infer success from "click didn't throw".

### STEP 8 - RETURN VERDICT
Return ONLY this JSON on the last line.
- PASS is only valid when STEP 7 produced concrete evidence that matches the Expected Result. Quote that evidence in actualResult.
- FAIL when the evidence shows the Expected Result did NOT occur (or could not be verified).

{"verdict": "PASS", "actualResult": "Verified: <quote the evidence — visible text, URL, element state>"}
or
{"verdict": "FAIL", "actualResult": "Expected <X> but observed <Y>. Evidence: <quote>"}

## AVAILABLE TOOLS
${toolDocs}
${siteCheatsheet}`;

            const userPrompt = `TEST: ${tc.name}

URL: ${urlFromPreconditions || 'ERROR: No URL provided!'}

Test Data: ${tc.testData || `Email=${uniqueEmail}`}

Test Steps (use the number before "of" as the stepIndex when calling playwright_mark_step — DO NOT use any number inside the step text):
${tc.steps.map((s: string, i: number) => `Step ${i + 1} of ${tc.steps.length}: ${s}`).join('\n')}

Expected Result: ${tc.expectedResult}

EXECUTION WORKFLOW:
1. Call ${navigateTool}(url="${urlFromPreconditions || ''}") → navigate to the page
2. Call playwright_get_input_fields() → discover all input selectors on the page
3. Call playwright_fill(selector=<discovered_selector>, value=<test_data_value>) → fill each input
4. Call playwright_click(selector=<discovered_selector>) → click buttons/links
5. Call playwright_get_visible_text() → CAPTURE EVIDENCE of the outcome (required before PASS)
6. Repeat steps 3-5 for each test step until ALL steps are complete
7. FINAL VERIFICATION — before returning a verdict, prove the Expected Result actually occurred:
   - Re-read the Expected Result above.
   - If it says "user stays on X / login fails / error message shown / submit blocked" → call playwright_get_visible_text() to confirm the error/state, and playwright_evaluate(script="location.href") to confirm the URL did NOT advance. PASS only if you find evidence of the blockage. NEVER return PASS just because your clicks succeeded — that's the most common bogus pass for negative tests.
   - If it says "user lands on / success / X is displayed" → confirm via playwright_get_visible_text() that the expected text/element is actually visible AND the URL advanced.
8. Return final verdict JSON: {"verdict": "PASS"|"FAIL", "actualResult": "Verified: <quote the evidence>"}

CRITICAL RULES:
- You MUST call playwright_get_input_fields right after navigation to discover the actual selectors before filling anything.
- When clicking a product, you MUST match the EXACT product name from the test data (e.g., "Sauce Labs Bolt T-Shirt"). Use the text selector: playwright_click(selector="text=Sauce Labs Bolt T-Shirt"). Do NOT click any other product.
- When adding a product to the cart, verify the page shows THAT specific product name before clicking 'Add to cart'.
- If test data specifies a product name, search for it using playwright_get_visible_text first, then click the EXACT matching element.${hasSignupStep ? '\n\nSIGN UP NOTE: Click the Sign Up link/button first, then call playwright_get_input_fields again on the signup page to get the registration form selectors.' : ''}`;



            const messages: any[] = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ];

            let finalContent = "";
            let toolCallsExecuted = false;
            let firstToolCallName = "";
            let testCompletionDetected = false;
            let totalActionsExecuted = 0;
            // One-shot retry guard for when the LLM responds text-only on the
            // first turn instead of calling a browser tool. Without this, the
            // test fails immediately with "No browser actions were performed."
            let noToolRetryAttempted = false;

            // Stuck-detection: if no NEW mark_step call has been observed for
            // 3 consecutive turns (and the agent isn't returning a verdict),
            // force-inject a coaching message identifying the next unmarked
            // step. Catches the common "agent spins on get_visible_text /
            // click loops without progressing through the step list" pattern.
            let lastMarkStepCount = 0;
            let turnsWithoutNewMarkStep = 0;

            // UI actions are what users care about: navigate, click, fill, type, press, select
            // Utility actions are MCP infrastructure: get_input_fields, get_visible_text, screenshot, wait
            const UI_ACTION_TOOLS = new Set([
                'playwright_navigate', 'navigate',
                'playwright_click', 'click',
                'playwright_fill', 'fill',
                'playwright_type', 'type',
                'playwright_press_key', 'press_key',
                'playwright_select_option', 'select', 'select_option',
                'playwright_check', 'check',
                'playwright_fill_form',
                'playwright_smart_fill_page',
                'playwright_mark_step',
            ]);

            // Separate logs: uiActionLog drives stepResults; utilityLog is for debug only
            const uiActionLog: { tool: string; args: any; success: boolean; message: string }[] = [];
            const utilityActionLog: { tool: string; success: boolean; message: string }[] = [];
            let uiActionsFailed = false;
            // Track whether the user stopped execution while THIS test case was
            // in-flight, so we can mark it SKIPPED instead of the misleading FAIL.
            let stoppedDuringThisCase = false;

            for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
                if (isStopRequested()) {
                    console.log("🛑 Execution stopped by user during test case execution.");
                    finalContent += `\nWARNING: Execution was forcefully stopped by user during step execution.`;
                    stoppedDuringThisCase = true;
                    break;
                }

                // ALWAYS send tools to LLM - use only validated tools
                const requestPayload: any = {
                    model: llmConfig.model || "gpt-4o",
                    messages,
                    temperature: 0.1,
                };

                // Prepare the tool list to send to the LLM
                let toolsToSend: any[] = [];
                if (finalFormattedTools.length > 0) {
                    // Optimize for token limits on smaller models - send only essential tools
                    const isSmallModel = llmConfig.model?.includes("8b") || llmConfig.model?.includes("1b");
                    toolsToSend = finalFormattedTools;

                    if (isSmallModel) {
                        const essentialToolNames = [
                            "playwright_navigate", "browser_navigate", "navigate",
                            "playwright_click", "browser_click", "click",
                            "playwright_fill", "browser_fill", "fill",
                            "playwright_type", "browser_type", "type",
                            "playwright_wait_for_selector", "browser_wait_for", "wait_for", "wait",
                            "playwright_screenshot", "browser_screenshot", "screenshot",
                            "playwright_get_visible_text", "browser_get_visible_text", "playwright_get_input_fields", "browser_get_input_fields",
                            "playwright_fill_form", "browser_fill_form", "playwright_smart_fill_page", "playwright_mark_step"
                        ];
                        const filtered = finalFormattedTools.filter(t =>
                            essentialToolNames.includes(t.function.name.toLowerCase())
                        );
                        if (filtered.length === 0) {
                            console.warn(`⚠️ Small model tool filter matched 0 tools for model ${llmConfig.model}. Sending all available tools instead.`);
                        } else {
                            toolsToSend = filtered;
                        }
                        console.log(`   ⚙️  Small model detected (${llmConfig.model}): Sending ${toolsToSend.length}/${finalFormattedTools.length} tools`);
                    }

                    if (toolsToSend.length > 0) {
                        requestPayload.tools = toolsToSend;
                    }
                }

                console.log(`\n  🎯 Turn ${turn + 1}: Calling LLM with ${messages.length} messages, ${finalFormattedTools.length} available tools, ${toolsToSend.length} sent tools`);

                // Log which tools are being sent for debugging
                if (turn === 0) {
                    console.log(`  📋 Tools being sent to LLM:`);
                    toolsToSend.forEach((t, idx) => {
                        const params = Object.keys(t.function.parameters?.properties || {});
                        console.log(`     ${idx + 1}. ${t.function.name} [params: ${params.join(", ") || "none"}]`);
                    });
                }

                let response;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount <= maxRetries) {
                    try {
                        if (onProgress) {
                            onProgress({
                                currentCase: `Running: TC-${tc.id}: ${tc.name}`,
                                currentCaseId: `TC-${tc.id}`,
                                currentCaseName: tc.name,
                                progress: i + 1,
                                total: testCases.length,
                                action: actionLog.length > 0 ? actionLog[actionLog.length - 1] : "Thinking..."
                            });
                        }

                        if (turn === 0 || retryCount > 0) {
                            console.log(`
  🧠 LLM Request Context (Turn ${turn + 1}):`);
                            console.log(`    Model: ${requestPayload.model}`);
                            console.log(`    Messages: ${requestPayload.messages.length}`);
                            console.log(`    Tools sent: ${requestPayload.tools ? requestPayload.tools.map((t: any) => t.function.name).join(', ') : 'none'}`);
                            console.log(`    Prompt snippet: ${JSON.stringify(requestPayload.messages[requestPayload.messages.length - 1].content || '').slice(0, 400)}...`);
                        }

                        response = await openai.chat.completions.create(requestPayload);
                        console.log(`  ✅ LLM response received (Turn ${turn + 1})`);
                        if (response?.choices?.[0]?.message) {
                            const msg = response.choices[0].message;
                            console.log(`    Role: ${msg.role}`);
                            console.log(`    Content length: ${String(msg.content || '').length}`);
                            console.log(`    Tool calls present: ${Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0}`);
                            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                                msg.tool_calls.forEach((tc: any, idx: number) => {
                                    console.log(`      ToolCall[${idx}]: ${tc.function.name} args=${JSON.stringify(tc.function.arguments)}`);
                                });
                            }
                        }
                        break; // Success!
                    } catch (llmErr: any) {
                        if (llmErr.status === 429 && retryCount < maxRetries) {
                            const waitTime = (retryCount + 1) * 5000;
                            console.warn(`⚠️ Rate limit reached (429). Retrying in ${waitTime / 1000}s... (Attempt ${retryCount + 1}/${maxRetries})`);
                            if (onProgress) {
                                onProgress({
                                    currentCase: `Running: ${tc.name}`,
                                    currentCaseId: `TC-${tc.id}`,
                                    currentCaseName: tc.name,
                                    progress: i + 1,
                                    total: testCases.length,
                                    action: `Waiting ${waitTime / 1000}s before retry...`
                                });
                            }
                            await new Promise(r => setTimeout(r, waitTime));
                            retryCount++;
                            continue;
                        }

                        console.error(`  ❌ LLM API Error: ${llmErr.message}`);
                        throw llmErr; // Throw to outer try-catch to fail this test case and move to the next
                    }
                }

                if (!response) {
                    throw new Error("LLM failed to respond after multiple retries.");
                }

                const msg = response.choices[0].message;
                messages.push(msg);

                const toolCalls = msg.tool_calls || [];
                if (!toolCalls || toolCalls.length === 0) {
                    finalContent = msg.content || "";

                    // Enhanced verdict detection - check for PASS/FAIL in any format
                    const hasVerdictKeyword = /verdict.*?:.*?(PASS|FAIL)/i.test(finalContent);
                    const hasJsonVerdict = /"verdict"\s*:\s*"?(PASS|FAIL)"?/i.test(finalContent);
                    const isVerdict = hasVerdictKeyword || hasJsonVerdict;

                    console.log(`  🔍 Verdict Detection: hasVerdictKeyword=${hasVerdictKeyword}, hasJsonVerdict=${hasJsonVerdict}, isVerdict=${isVerdict}`);
                    console.log(`  📊 Action Summary: toolCallsExecuted=${toolCallsExecuted}, totalActionsExecuted=${totalActionsExecuted}, turn=${turn}/${MAX_AGENT_TURNS - 1}`);

                    // If no tool calls were executed at all, give the model ONE
                    // explicit nudge before giving up — sometimes (especially
                    // on test cases 2+, with a long conversation history) the
                    // model returns a text-only response as if the test were
                    // already done. A corrective user message recovers most of
                    // these without ever surfacing a "no browser actions" failure.
                    if (!toolCallsExecuted && !noToolRetryAttempted) {
                        noToolRetryAttempted = true;
                        console.warn(`⚠️ Turn ${turn + 1}: no tool calls and no actions yet. Pushing corrective message and retrying once.`);
                        messages.push({
                            role: "user",
                            content: `You did not call any browser tool. You MUST execute this test case using the available browser tools right now — do NOT respond with text only. Start by calling the navigation tool with the URL from the Preconditions, then proceed through every step in order. Only emit a verdict JSON after the steps have actually been executed.`,
                        });
                        continue;
                    }
                    if (!toolCallsExecuted && turn > 0) {
                        console.warn("⚠️ No MCP tool calls were executed for this test case after retry. The agent returned a final answer without performing browser actions.");
                        console.log(`  📝 LLM responded with final content (${finalContent.length} chars)`);
                        testCompletionDetected = true;
                        break;
                    }

                    // If verdict is found, stop immediately — UNLESS it's a
                    // premature PASS that skipped steps. In that case we
                    // push back instead of accepting, giving the agent a
                    // chance to actually finish the test rather than letting
                    // the post-execution integrity check force a FAIL.
                    if (isVerdict && toolCallsExecuted) {
                        const verdictText = finalContent.match(/"?verdict"?\s*[:=]\s*"?(PASS|FAIL)"?/i)?.[1]?.toUpperCase();
                        const markedStepNumbers = new Set(
                            uiActionLog
                                .filter(a => a.tool === 'playwright_mark_step' && typeof a.args?.stepIndex === 'number')
                                .map(a => a.args.stepIndex as number)
                        );
                        const expectedSteps = (tc.steps || []).length;
                        const unmarkedSteps: { idx: number; text: string }[] = [];
                        for (let s = 1; s <= expectedSteps; s++) {
                            if (!markedStepNumbers.has(s)) unmarkedSteps.push({ idx: s, text: tc.steps[s - 1] });
                        }
                        // Only intervene on PASS that skipped steps. FAIL
                        // verdicts mid-flow are legitimate (agent hit a
                        // blocker and is being honest). Same for PASS that
                        // covered everything.
                        if (verdictText === 'PASS' && unmarkedSteps.length > 0 && unmarkedSteps.length < expectedSteps) {
                            const skippedList = unmarkedSteps
                                .map(u => `Step ${u.idx} ("${u.text}")`)
                                .slice(0, 4)
                                .join('; ');
                            const more = unmarkedSteps.length > 4 ? ` and ${unmarkedSteps.length - 4} more` : '';
                            console.warn(`  🚫 Rejecting premature PASS verdict: ${unmarkedSteps.length}/${expectedSteps} step(s) unmarked. Coaching the agent to finish.`);
                            messages.push({
                                role: 'user',
                                content: `Your PASS verdict was REJECTED. You declared PASS but ${unmarkedSteps.length} of ${expectedSteps} steps were never executed: ${skippedList}${more}.\n\nDo NOT return a verdict yet. Resume execution from Step ${unmarkedSteps[0].idx} ("${unmarkedSteps[0].text}"): call playwright_mark_step(${unmarkedSteps[0].idx}, ...), perform its required browser actions, then continue through the remaining steps in order. Only after every step (1..${expectedSteps}) has been marked AND its action(s) executed may you re-evaluate and return a verdict.`,
                            });
                            // Reset finalContent so the verdict-parser on the
                            // next turn doesn't keep matching the rejected one.
                            finalContent = '';
                            continue;
                        }
                        console.log(`  ✅ Verdict detected in response: ${verdictText || 'unknown'}`);
                        testCompletionDetected = true;
                        break;
                    }

                    // If at max turns, force stop
                    if (turn >= MAX_AGENT_TURNS - 1) {
                        console.warn(`⚠️ Maximum turns reached (${turn + 1}/${MAX_AGENT_TURNS}). Forcing test completion.`);
                        if (toolCallsExecuted) {
                            console.log(`  ✅ Tool calls were executed (${totalActionsExecuted} actions). Treating as completed.`);
                            testCompletionDetected = true;
                        }
                        break;
                    }

                    // Track mark_step progress for stuck-detection. If this
                    // turn produced a new mark_step call, reset the counter;
                    // otherwise increment. Three consecutive turns without a
                    // new mark_step => the agent is spinning, force-coach.
                    const currentMarkStepCount = uiActionLog.filter(a => a.tool === 'playwright_mark_step').length;
                    if (currentMarkStepCount > lastMarkStepCount) {
                        lastMarkStepCount = currentMarkStepCount;
                        turnsWithoutNewMarkStep = 0;
                    } else {
                        turnsWithoutNewMarkStep += 1;
                    }

                    // Partial execution - ask agent to continue. Name the
                    // specific next-unreached step (computed from mark_step
                    // calls so far) so the LLM doesn't just call mark_step
                    // generically without progressing.
                    if (toolCallsExecuted && !isVerdict && totalActionsExecuted > 0) {
                        const markedStepNumbers = new Set(
                            uiActionLog
                                .filter(a => a.tool === 'playwright_mark_step' && typeof a.args?.stepIndex === 'number')
                                .map(a => a.args.stepIndex as number)
                        );
                        const totalSteps = (tc.steps || []).length;
                        const nextUnmarked: { idx: number; text: string } | null = (() => {
                            for (let s = 1; s <= totalSteps; s++) {
                                if (!markedStepNumbers.has(s)) {
                                    return { idx: s, text: tc.steps[s - 1] };
                                }
                            }
                            return null;
                        })();

                        // Escalation when the agent hasn't called a new
                        // mark_step in 3 turns despite still firing tools —
                        // it's spinning on discovery/utility calls instead
                        // of progressing. Use a stricter prompt that tells
                        // it to STOP doing anything else first.
                        const stuckOnSameStep = turnsWithoutNewMarkStep >= 3 && nextUnmarked !== null;
                        const coaching = nextUnmarked
                            ? (stuckOnSameStep
                                ? `STOP. You have spent ${turnsWithoutNewMarkStep + 1} turns without advancing past Step ${nextUnmarked.idx} of ${totalSteps} ("${nextUnmarked.text}"). You are stuck.\n\nDo EXACTLY this on your next response, nothing else:\n1. Call playwright_mark_step(stepIndex=${nextUnmarked.idx}, stepDescription="${nextUnmarked.text}").\n2. Use playwright_evaluate to enumerate visible buttons/links if you need a selector (one short script — see the system prompt's STEP 3).\n3. Click the EXACT id/data-test the script returns to do this step.\nDo NOT call get_visible_text again. Do NOT re-list inputs. Do NOT explain. Just mark the step and act on it.\nIf you genuinely cannot perform this step, return {"verdict": "FAIL", "actualResult": "Could not complete Step ${nextUnmarked.idx}: <one-line reason>"} — that's better than spinning silently.`
                                : `CONTINUE: You have executed ${totalActionsExecuted} browser actions, but Step ${nextUnmarked.idx} of ${totalSteps} ("${nextUnmarked.text}") has NOT been started yet — you have not called playwright_mark_step(${nextUnmarked.idx}, ...) for it.\n\nDo this right now:\n1. Call playwright_mark_step(${nextUnmarked.idx}, "${nextUnmarked.text}").\n2. Perform the browser action(s) that satisfy that step.\n3. Continue to the remaining steps in order.\n\nDo NOT return a verdict until every step (1..${totalSteps}) has been marked AND its required action(s) executed. The system will detect skipped steps and override your PASS verdict to FAIL.`)
                            : `CONTINUE: You have executed ${totalActionsExecuted} browser actions and marked every step. If all steps are truly complete, run STEP 7 (verify the Expected Result with playwright_get_visible_text / playwright_evaluate) and then return the verdict JSON.`;
                        if (stuckOnSameStep) {
                            console.warn(`  🥶 Stuck-detection: ${turnsWithoutNewMarkStep + 1} turns without a new mark_step. Pushing strict coaching toward step ${nextUnmarked!.idx}/${totalSteps}.`);
                            // Reset the counter so we don't fire the strict
                            // message every turn — give the agent a chance
                            // to respond to it.
                            turnsWithoutNewMarkStep = 0;
                        } else {
                            console.log(`⚠️ Test in progress. ${totalActionsExecuted} actions executed but no verdict yet. ${nextUnmarked ? `Coaching toward step ${nextUnmarked.idx}/${totalSteps}.` : 'All steps marked — prompting for verification.'}`);
                        }
                        messages.push({ role: "user", content: coaching });
                        continue;
                    }

                    console.log(`  📝 LLM responded with final content (${finalContent.length} chars)`);
                    break;
                }

                console.log(`  🔧 LLM requested ${toolCalls.length} tool call(s)`);

                for (const _toolCall of toolCalls) {
                    const toolCall = _toolCall as any;
                    console.log(`  🔧 Tool call: ${toolCall.function.name}`);

                    // CRITICAL: Verify tool was actually sent to LLM
                    const availableToolNames = finalFormattedTools.map(t => t.function.name);

                    // Helper: resolve requested tool to an available tool name (aliases and fuzzy matches)
                    function resolveToolName(requested: string, toolsList: string[]): string | null {
                        if (!requested) return null;
                        const req = String(requested).toLowerCase();
                        if (toolsList.includes(req)) return req;

                        // Common alias map
                        const aliases: Record<string, string[]> = {
                            'wait_for': ['playwright_wait_for_selector', 'browser_wait_for', 'playwright_wait'],
                            'wait': ['playwright_wait', 'browser_wait_for', 'playwright_wait_for_selector'],
                            'click': ['playwright_click', 'browser_click'],
                            'fill': ['playwright_fill', 'browser_fill', 'playwright_fill_form', 'browser_fill_form'],
                            'type': ['playwright_type', 'browser_type'],
                            'get_visible_text': ['playwright_get_visible_text', 'browser_get_visible_text', 'playwright_get_html'],
                            'get_input_fields': ['playwright_get_input_fields', 'browser_get_input_fields'],
                            'screenshot': ['playwright_screenshot', 'browser_screenshot'],
                            'navigate': ['playwright_navigate', 'browser_navigate'],
                        };

                        if (aliases[req]) {
                            for (const a of aliases[req]) if (toolsList.includes(a)) return a;
                        }

                        // Try fuzzy match: endsWith or includes
                        for (const t of toolsList) {
                            if (t === req) return t;
                            if (t.endsWith('_' + req)) return t;
                            if (t.includes(req) && req.length > 3) return t;
                            if (req.includes(t) && t.length > 3) return t;
                        }

                        return null;
                    }

                    let calledToolName = toolCall.function.name;
                    
                    // GEMINI BUG FIX: Sometimes Gemini puts the entire JSON in the tool name!
                    if (calledToolName.includes('{') && calledToolName.includes('}')) {
                        console.warn(`  ⚠️ Detected JSON inside tool name: ${calledToolName}`);
                        const match = calledToolName.match(/^([a-zA-Z0-9_-]+)\s*(\{.*\})$/);
                        if (match) {
                            calledToolName = match[1];
                            if (!toolCall.function.arguments || toolCall.function.arguments === '{}' || toolCall.function.arguments === '') {
                                toolCall.function.arguments = match[2];
                            }
                        } else {
                            calledToolName = calledToolName.split(/[\s{]/)[0];
                        }
                        toolCall.function.name = calledToolName; // Mutate to prevent 400 on next turn
                    }

                    let toolWasSent = availableToolNames.includes(calledToolName);
                    if (!toolWasSent) {
                        const resolved = resolveToolName(calledToolName, availableToolNames);
                        if (resolved) {
                            console.log(`  ℹ️ Mapping requested tool '${calledToolName}' -> '${resolved}'`);
                            calledToolName = resolved;
                            toolWasSent = true;
                            toolCall.function.name = resolved; // Mutate to prevent 400 on next turn
                        }
                    }

                    if (!toolWasSent) {
                        console.error(`  ❌ CRITICAL ERROR: LLM tried to call tool '${toolCall.function.name}' which was NOT in the request.tools list!`);
                        console.error(`     Available tools: ${availableToolNames.join(", ")}`);
                        console.error(`     This indicates a mismatch between system prompt and available tools`);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: `ERROR: Tool '${toolCall.function.name}' is not available. Available tools: ${availableToolNames.join(", ")}`
                        });
                        continue;
                    }

                    let args;
                    try {
                        args = typeof toolCall.function.arguments === 'string'
                            ? JSON.parse(toolCall.function.arguments)
                            : toolCall.function.arguments;
                    } catch (parseErr: any) {
                        console.error(`    ❌ Failed to parse arguments: ${parseErr.message}`);
                        messages.push({ role: "tool", tool_call_id: toolCall.id, content: `Error: Invalid JSON in arguments` });
                        continue;
                    }

                    // Log what parameters the LLM is trying to use
                    const paramKeys = Object.keys(args || {});
                    const toolSchema = finalFormattedTools.find(t => t.function.name === calledToolName);
                    const expectedParams = Object.keys(toolSchema?.function.parameters?.properties || {});
                    const required = toolSchema?.function.parameters?.required || [];

                    console.log(`     Parameters sent: ${paramKeys.join(", ") || "none"}`);
                    console.log(`     Expected params: ${expectedParams.join(", ") || "none"}`);
                    console.log(`     Required: [${required.join(", ") || "none"}]`);

                    // ── Repeat-call stuck detector ────────────────────────────
                    // If the LLM has called the same click tool with the same
                    // selector 2+ times in the recent history, refuse to fire
                    // it again and force a discovery step instead. This breaks
                    // the most common stuck-loop pattern (LLM keeps clicking a
                    // selector that doesn't exist, page never changes, agent
                    // wastes its turn budget). Only applies to click-family
                    // tools — fills/types are typically idempotent.
                    if (/click/i.test(calledToolName) && args?.selector) {
                        const sel = String(args.selector);
                        // Look at last 4 UI actions of the same tool+selector
                        const recent = uiActionLog.slice(-8).filter(
                            (a) => a.tool === calledToolName && a.args?.selector === sel,
                        );
                        if (recent.length >= 2) {
                            console.warn(`  🔁 Stuck-loop detected: ${calledToolName}('${sel}') called ${recent.length + 1}x. Forcing discovery instead.`);
                            const diag = [
                                `STUCK-LOOP DETECTED — you've already tried ${calledToolName}('${sel}') ${recent.length} time(s) in this test case and the page state has not changed in the way you expected.`,
                                ``,
                                `Refusing to re-fire the same click. Do NOT retry the same selector. Instead, IMMEDIATELY call playwright_evaluate with this exact script to see what's actually on the page right now:`,
                                ``,
                                `playwright_evaluate(script: \`JSON.stringify(Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]')).filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }).map(el => ({tag: el.tagName.toLowerCase(), text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80), id: el.id || null, dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || null, href: el.getAttribute('href') || null})).slice(0, 60), null, 2)\`)`,
                                ``,
                                `Then pick the EXACT id/data-test from that list. The selector "${sel}" is wrong — either the element doesn't exist, it was renamed, or the page has navigated away from where you started.`,
                            ].join('\n');
                            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: diag });
                            // Count this as an attempted UI action so the step
                            // gets credited, but mark it failed so the user
                            // sees the stuck-loop in the report.
                            uiActionLog.push({ tool: calledToolName, args, success: false, message: `${calledToolName}('${sel}') — stuck-loop, refused after ${recent.length} retries` });
                            uiActionsFailed = true;
                            continue;
                        }
                    }

                    if (client) {
                        try {
                            let toolText;
                            if (calledToolName === 'playwright_mark_step') {
                                toolText = JSON.stringify({ success: true, message: `Marked step ${args?.stepIndex || 'unknown'}` });
                            } else {
                                const mcpRes = await client.callTool({ name: calledToolName, arguments: args });
                                toolText = mcpRes.isError
                                    ? `Error: ${JSON.stringify(mcpRes.content)}`
                                    : JSON.stringify(mcpRes.content);
                            }
                            console.log(`  ✅ Tool ${toolCall.function.name} responded.`);
                            toolCallsExecuted = true;
                            totalActionsExecuted++;
                            if (!firstToolCallName) firstToolCallName = calledToolName;

                            // Categorize: is this a meaningful UI action or a utility call?
                            if (UI_ACTION_TOOLS.has(calledToolName)) {
                                const readableArgs = (() => {
                                    const a = args || {};
                                    if (a.url) return `url="${a.url}"`;
                                    if (a.selector && a.value !== undefined) return `selector="${a.selector}", value="${a.value}"`;
                                    if (a.selector) return `selector="${a.selector}"`;
                                    if (a.key) return `key="${a.key}"`;
                                    return JSON.stringify(a).slice(0, 80);
                                })();
                                uiActionLog.push({ tool: calledToolName, args, success: true, message: `${calledToolName}(${readableArgs})` });
                            } else {
                                utilityActionLog.push({ tool: calledToolName, success: true, message: `${calledToolName} - ok` });
                            }
                            // Keep generic actionLog for backward compat
                            actionLog.push(`✅ Action: ${toolCall.function.name}(${JSON.stringify(args)}) - Success`);
                            // Trim before pushing — this content gets re-sent on every subsequent turn
                            messages.push({ role: "tool", tool_call_id: toolCall.id, content: trimToolText(toolText) });
                        } catch (toolErr: any) {
                            const errMsg = toolErr.message || JSON.stringify(toolErr);
                            console.error(`  ❌ Tool ${toolCall.function.name} error: ${errMsg}`);

                            // Provide helpful error message for schema mismatches
                            let helpfulMsg = `Tool error: ${errMsg}`;
                            if (errMsg.includes("missing properties") || errMsg.includes("additionalProperties")) {
                                const toolSchema = finalFormattedTools.find(t => t.function.name === toolCall.function.name);
                                const expectedParams = Object.keys(toolSchema?.function.parameters.properties || {});
                                helpfulMsg = `Parameter mismatch. Expected parameters: [${expectedParams.join(", ")}]. You sent: [${paramKeys.join(", ")}].\n\nFull error: ${errMsg}`;
                            }

                            // Only flag as UI failure if this was a real UI action
                            if (UI_ACTION_TOOLS.has(calledToolName)) {
                                uiActionLog.push({ tool: calledToolName, args, success: false, message: `${calledToolName} failed: ${errMsg.slice(0, 120)}` });
                                uiActionsFailed = true;
                            } else {
                                // Utility failure: log but don't affect verdict
                                utilityActionLog.push({ tool: calledToolName, success: false, message: `${calledToolName} error (ignored): ${errMsg.slice(0, 80)}` });
                            }
                            actionLog.push(`❌ Action: ${toolCall.function.name}(${JSON.stringify(args)}) - Error: ${errMsg}`);
                            messages.push({ role: "tool", tool_call_id: toolCall.id, content: trimToolText(helpfulMsg) });
                        }
                    } else {
                        throw new Error(`MCP client unexpectedly missing during tool execution for ${calledToolName}.`);
                    }
                }
            }

            // ── Verdict determination ──────────────────────────────────────────────────
            // Navigation must be first
            if (toolCallsExecuted && firstToolCallName && firstToolCallName !== navigateTool) {
                console.warn(`⚠️ First tool was '${firstToolCallName}' instead of '${navigateTool}'.`);
            }

            // Parse LLM verdict from its final text response
            const verdictMatch = finalContent.match(/\{"verdict":\s*"(PASS|FAIL)",\s*"actualResult":\s*"([^"]*)"\}/) ||
                finalContent.match(/"verdict"\s*:\s*"(PASS|FAIL)"/i) ||
                finalContent.match(/verdict[:\s]*"?(PASS|FAIL)"?/i);
            let verdict = verdictMatch ? (verdictMatch[1]?.toUpperCase() as "PASS" | "FAIL" | "SKIPPED") : null;
            let actualResult = verdictMatch ? (verdictMatch[2] || '') : '';

            // If the user pressed Stop while this test was running, mark it
            // SKIPPED instead of letting the verdict logic default to FAIL —
            // an interruption isn't a test failure.
            if (stoppedDuringThisCase) {
                console.log(`  ⏭ Test case stopped mid-execution — marking SKIPPED`);
                verdict = 'SKIPPED';
                actualResult = 'Skipped: execution was stopped by user during this test case';
            }

            // Compute verdict from UI actions if LLM didn't provide one.
            // Skip this entire block when the test was stop-interrupted —
            // we already set verdict='SKIPPED' above and don't want it
            // demoted to FAIL just because the action log looks incomplete.
            //
            // For counting purposes, exclude `playwright_mark_step` — that's
            // a pseudo-tool the agent uses to label which step it's on, not
            // a real browser action. Counting it inflated the "All N UI
            // actions completed" message (e.g. claimed 8 when only 6
            // actually touched the page).
            const realUiActions = uiActionLog.filter(a => a.tool !== 'playwright_mark_step');
            if (!stoppedDuringThisCase) {
                const uiActionsRan = realUiActions.length > 0;
                const allUiActionsSucceeded = uiActionsRan && !uiActionsFailed;

                if (!toolCallsExecuted) {
                    // No browser actions at all
                    console.warn("⚠️ Forcing FAIL: no browser tool calls were executed.");
                    verdict = "FAIL";
                    actualResult = "No browser interactions were performed. The agent did not execute any browser actions.";
                } else if (verdict === null) {
                    // LLM didn't emit a verdict — infer from UI action results
                    verdict = allUiActionsSucceeded ? "PASS" : "FAIL";
                    actualResult = allUiActionsSucceeded
                        ? `All ${realUiActions.length} browser action${realUiActions.length === 1 ? '' : 's'} completed without runtime errors. (Note: this does NOT imply the test's expected outcome was verified — only that no Playwright tool call threw.)`
                        : `Some UI actions failed. Check step details.`;
                } else if (verdict === "PASS" && uiActionsFailed) {
                    // LLM said PASS but a UI action actually failed — trust actions
                    verdict = "FAIL";
                    actualResult = `LLM reported PASS but UI actions had errors. ${actualResult}`;
                }
            }
            // If LLM says FAIL (even with all UI actions passing), trust the LLM

            if (!actualResult) {
                actualResult = verdict === "PASS"
                    ? `All ${realUiActions.length} browser action${realUiActions.length === 1 ? '' : 's'} completed without runtime errors.`
                    : finalContent.slice(0, 300);
            }

            // Helper: convert a raw playwright tool call into a plain-English description
            const describeUIAction = (action: { tool: string; args: any; success: boolean; message: string }): string => {
                const a = action.args || {};
                switch (action.tool) {
                    case 'playwright_navigate': case 'navigate':
                        return `Navigate to: ${a.url || '(url)'}`;
                    case 'playwright_click': case 'click': {
                        const sel = String(a.selector || '').replace(/^text=/, '').replace(/"/g, '');
                        return `Click: "${sel}"`;
                    }
                    case 'playwright_fill': case 'fill': {
                        const field = String(a.selector || '')
                            .replace(/\[placeholder=["']?([^"'\]]+)["']?\]/, '$1')
                            .replace(/^#/, '')
                            .replace(/^input\[name=["']([^"']+)["']\]/, '$1');
                        return `Fill "${field}" with "${a.value}"`;
                    }
                    case 'playwright_type': case 'type':
                        return `Type "${a.text}" into "${a.selector}"`;
                    case 'playwright_check': case 'check':
                        return `Check checkbox: ${a.selector}`;
                    case 'playwright_press_key': case 'press_key':
                        return `Press key: ${a.key}`;
                    case 'playwright_select_option': case 'select':
                        return `Select "${a.value || a.label}" from "${a.selector}"`;
                    case 'playwright_fill_form':
                        return `Fill form with ${(a.fields || []).length} field(s)${a.submitSelector ? ', then click submit' : ''}`;
                    case 'playwright_smart_fill_page':
                        return `Smart-fill page with provided data`;
                    default:
                        return action.message;
                }
            };

            console.log(`\n📋 TEST CASE EXECUTION COMPLETE:`);
            console.log(`   Test: ${tc.name}`);
            console.log(`   Verdict: ${verdict}`);

            const totalSteps = tc.steps.length;
            const actionsPerStep = Math.max(1, Math.floor(uiActionLog.length / totalSteps));

            tc.steps.forEach((stepText: string, idx: number) => {
                const stepNum = idx + 1;
                
                // Did the agent EVER call playwright_mark_step? If so, we use
                // mark_step boundaries exclusively (proportional fallback would
                // steal actions from properly-marked steps and falsely populate
                // unmarked ones, hiding the fact that the agent skipped them).
                const anyMarkStepCalled = uiActionLog.some(a => a.tool === 'playwright_mark_step');

                let relevantActions: any[] = [];
                const currentMarkIdx = uiActionLog.findIndex(a => a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum);
                const nextMarkIdx = uiActionLog.findIndex(a => a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum + 1);
                let stepWasReached: boolean;

                if (anyMarkStepCalled) {
                    if (currentMarkIdx !== -1) {
                        relevantActions = uiActionLog.slice(currentMarkIdx + 1, nextMarkIdx !== -1 ? nextMarkIdx : uiActionLog.length);
                        // Special case: If this is Step 1, also include any actions that happened BEFORE the first mark
                        if (stepNum === 1) {
                            const preActions = uiActionLog.slice(0, currentMarkIdx);
                            relevantActions = [...preActions, ...relevantActions];
                        }
                        stepWasReached = true;
                    } else {
                        // mark_step was used but NOT for this step → the agent
                        // skipped this step. Don't borrow actions from elsewhere.
                        relevantActions = [];
                        stepWasReached = false;
                    }
                } else {
                    // No mark_step at all — fall back to proportional distribution.
                    const startIdx = idx * actionsPerStep;
                    const endIdx = idx === totalSteps - 1 ? uiActionLog.length : (idx + 1) * actionsPerStep;
                    relevantActions = uiActionLog.slice(startIdx, endIdx);
                    stepWasReached = relevantActions.length > 0;
                }

                let stepPassed = true;
                let stepResultDetails = "";

                if (relevantActions.length > 0) {
                    stepPassed = relevantActions.every(a => a.success);
                    stepResultDetails = relevantActions
                        .filter(a => a.tool !== 'playwright_mark_step')
                        .map(a => `${a.success ? '✅' : '❌'} ${describeUIAction(a)}`)
                        .join('\n');
                } else if (idx === 0 && !toolCallsExecuted) {
                    stepResultDetails = "No browser actions were performed.";
                    stepPassed = false;
                } else if (!stepWasReached) {
                    // Honest reporting: the agent never executed this step.
                    // Critically, do NOT trust an LLM PASS verdict here —
                    // PASS that skips steps is the most common bogus pass.
                    // Marking stepPassed=false also lets the verdict-integrity
                    // check downstream downgrade the overall test to FAIL.
                    stepResultDetails = "⚠ Step not reached — the agent skipped this step (no playwright_mark_step call and no actions logged for it).";
                    stepPassed = false;
                } else {
                    // stepWasReached === true but the slice between this
                    // mark_step and the next is empty. That's expected and
                    // CORRECT for passive/negative-instruction steps like
                    // "Leave the Username field empty", "Wait for the page
                    // to load", "Observe that nothing happens" — the agent
                    // intentionally performed no UI action to satisfy them.
                    // Treat as passed; just don't oversell it in the message.
                    const passiveLooking = /\b(leave\s+\w+\s+(?:field\s+)?empty|empty|blank|do\s+not|don'?t|without|wait|observe|verify|confirm)\b/i.test(stepText);
                    stepResultDetails = passiveLooking
                        ? "No browser action required for this step (agent acknowledged it; condition is satisfied implicitly — e.g. leave-empty / passive verification)."
                        : "Step acknowledged by the agent but no browser action was logged. If you expected this step to perform an action, treat this as an agent miss.";
                    // Passive steps shouldn't drag the test down. Non-passive
                    // "no action logged" still counts as passed at the per-step
                    // level — the test verdict logic above decides overall PASS/FAIL
                    // based on the full action log and LLM verdict.
                    stepPassed = true;
                }

                // If the whole test failed and this is the "farthest" reached step, ensure it shows the fail
                if (verdict === "FAIL" && idx === Math.min(totalSteps - 1, Math.floor(uiActionLog.length / actionsPerStep))) {
                    stepPassed = false;
                    if (actualResult) stepResultDetails += `\n\nError: ${actualResult}`;
                }

                stepResults.push({
                    step: `Step ${idx + 1}: ${stepText}`,
                    result: stepResultDetails,
                    passed: stepPassed
                });
            });

            // Leftover-actions block removed. It used a proportional bucket
            // (`actionsPerStep`) that was meaningful only when no mark_step
            // calls existed — in modern runs the mark_step boundaries already
            // claim every action that belongs to a step, and any "extra"
            // actions are usually misnumbered mark_step calls (e.g. the LLM
            // called mark_step(stepIndex=10) on what we consider step 14
            // because the step text said "Step 10."). Appending those to
            // the LAST step's display produced the confusing contradiction
            // we saw: "Step 14: not reached — agent skipped this step"
            // followed by two ✅ mark_step rows. The integrity check below
            // already detects the misnumbering; we don't need to paste the
            // raw stray actions onto an unrelated step.

            // ─── Verdict integrity check ────────────────────────────────────
            // If the LLM declared PASS but our step-coverage analysis shows
            // it skipped one or more steps, the PASS is a lie. The most
            // common failure mode: agent runs Step 1 (e.g. login), then
            // fabricates a verdict before doing Step 2..N. Downgrade to FAIL
            // and surface which steps were skipped, so the user sees the
            // truth instead of a misleading green checkmark.
            const unreachedSteps = stepResults.filter(s => /^⚠ Step not reached/i.test(s.result));
            if (verdict === "PASS" && unreachedSteps.length > 0) {
                const skippedLabels = unreachedSteps
                    .map(s => s.step.replace(/^Step \d+:\s*/, ''))
                    .slice(0, 3)
                    .join('; ');
                const more = unreachedSteps.length > 3 ? ` (+${unreachedSteps.length - 3} more)` : '';
                console.warn(`⚠️ Overriding LLM verdict PASS → FAIL: ${unreachedSteps.length}/${stepResults.length} step(s) were skipped.`);
                verdict = "FAIL";
                actualResult = `Agent declared PASS without executing all required steps. ${unreachedSteps.length}/${stepResults.length} step(s) were skipped: ${skippedLabels}${more}. (Original LLM actualResult: ${actualResult || '<none>'})`;
            }

            const tcResult = {
                id: tc.id,
                name: tc.name,
                jiraKey: tc.jiraKey,
                priority: tc.priority,
                // verdict is non-null at this point thanks to the resolution
                // logic above — the `?? 'FAIL'` is a TS-narrowing safety net.
                status: (verdict ?? 'FAIL') as 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR',
                steps: stepResults,
                expectedResult: tc.expectedResult,
                actualResult: actualResult,
                duration: Date.now() - tcStart,
                videoFile,
                testData: tc.testData,
            };
            results.push(tcResult);
            // Store for partial report (available immediately via /api/partial-results)
            addPartialResult(tcResult);

            console.log(`\n✅ TEST CASE [${i + 1}/${testCases.length}] COMPLETED:`);
            console.log(`   Name: ${tc.name}`);
            console.log(`   Status: ${verdict}`);
            console.log(`   Duration: ${Date.now() - tcStart}ms`);

            // ─── AUTO-HEAL: If test failed and auto-heal is enabled, retry once ───
            // verdict's possible values are PASS | FAIL | SKIPPED — heal only on FAIL.
            if (autoHeal && verdict === 'FAIL' && client) {
                console.log(`\n🧬 AUTO-HEAL: Test case failed. Attempting healing retry...`);
                if (onProgress) {
                    onProgress({
                        currentCase: `Healing: TC-${tc.id}: ${tc.name}`,
                        currentCaseId: `TC-${tc.id}`,
                        currentCaseName: `🩹 Healing: ${tc.name}`,
                        progress: i + 1,
                        total: testCases.length,
                        action: 'Auto-healing failed test...'
                    });
                }

                try {
                    // Get current page state for context
                    let pageSnapshot = 'Page state unavailable';
                    try {
                        const snapshotRes = await client.callTool({ name: 'browser_snapshot', arguments: {} });
                        pageSnapshot = JSON.stringify(snapshotRes.content).slice(0, 3000);
                    } catch {
                        try {
                            const textRes = await client.callTool({ name: 'browser_get_visible_text', arguments: {} });
                            pageSnapshot = JSON.stringify(textRes.content).slice(0, 3000);
                        } catch { }
                    }

                    const totalStepsInPlan = (tc.steps || []).length;
                    const stepsFormatted = (tc.steps || []).map((s: string, i: number) => `Step ${i + 1} of ${totalStepsInPlan}: ${s}`).join('\n');
                    const healPrompt = `The previous test case FAILED. Here are the failure details:

Test Case: ${tc.name}
Expected Result: ${tc.expectedResult}
Actual Result (failure): ${actualResult}
Error Details: ${stepResults.filter(s => !s.passed).map(s => s.result).join('\n')}

Current Page Snapshot (Truncated):
${pageSnapshot}

Test Steps (use the number before "of" as the stepIndex when calling playwright_mark_step — DO NOT use any number inside the step text):
${stepsFormatted}

### HEALING STRATEGIES (Priority Order):
1. **TEXT SEARCH**: If the CSS selector (id, class) failed, search for elements containing the visible text.
2. **VALIDATION CORRECTION**: If the failure was due to a validation message (e.g., "Password required"), try to fill the requested field to satisfy the application and progress.
3. **ARIA ROLES**: Use [aria-label="..."] or role="button" selectors.
4. **PAGE EXPLORATION**: Call playwright_get_visible_text() again to see current state.
5. **NAVIGATION RECOVERY**: If on the wrong page, navigate back to the starting URL.

### MANDATORY STRUCTURE (the system will reject your PASS verdict otherwise):
- You MUST call playwright_mark_step(stepIndex=N, stepDescription="...") at the start of EVERY step, where N is the position number shown above.
- Every step (1 through ${totalStepsInPlan}) must be marked. The post-heal integrity check counts mark_step calls — if any step is missing one, your PASS will be downgraded to FAIL with a list of the skipped steps.
- For "discover before clicking" non-form buttons (e.g. Add to Cart, Cart icon, Checkout), use playwright_evaluate to enumerate visible buttons/links by id+data-test+text, then click the EXACT id/data-test from the result. Don't guess.

INSTRUCTIONS: Re-execute ALL ${totalStepsInPlan} steps of this test case from scratch. Correct the broken action that caused the previous failure. Mark every step. Only after every step (1..${totalStepsInPlan}) has been marked AND its required browser action(s) executed may you return a verdict.
After completing all steps, you MUST output this JSON on the last line: {"verdict": "PASS" or "FAIL", "actualResult": "description of healing success/failure"}`;

                    const healMessages: any[] = [
                        { role: 'system', content: `You are a test automation healing agent. Re-execute the failed test with corrected selectors and actions.\n\nCRITICAL: Call playwright_mark_step(stepIndex=N, stepDescription="...") at the START of every step. The system rejects healing verdicts that don't cover all steps via mark_step calls.${siteCheatsheet}` },
                        { role: 'user', content: healPrompt }
                    ];

                    let healVerdict: 'PASS' | 'FAIL' = 'FAIL';
                    let healActualResult = '';

                    // Track every UI action the healer takes, so we can rebuild
                    // stepResults from the heal run (not the original failed run)
                    // AND apply the same step-coverage integrity check we use for
                    // the main pass. Without this, the healer could re-declare
                    // PASS while skipping the same steps the original run did,
                    // and the UI would show the contradictory "PASS but step X
                    // not reached" we saw on the AddMultipleProductsPositive test.
                    const healUiActionLog: { tool: string; args: any; success: boolean; message: string }[] = [];

                    // Healing turns — capped by MAX_HEAL_TURNS (default 3, was 10).
                    // Healing is a "Hail Mary" — 2-3 attempts is enough; more wastes LLM time.
                    for (let healTurn = 0; healTurn < MAX_HEAL_TURNS; healTurn++) {
                        if (isStopRequested()) break;

                        console.log(`  🧬 HEAL TURN ${healTurn + 1}: Calling LLM...`);
                        const healPayload: any = {
                            model: llmConfig.model || 'gpt-4o',
                            messages: healMessages,
                            temperature: 0.1,
                        };
                        if (finalFormattedTools.length > 0) {
                            healPayload.tools = finalFormattedTools;
                        }

                        const healResponse = await openai.chat.completions.create(healPayload);
                        const healChoice = healResponse.choices[0];
                        const healMsg = healChoice.message;
                        healMessages.push(healMsg as any);

                        if (healMsg.content) {
                            console.log(`  🧬 HEAL Reasoning: ${healMsg.content.slice(0, 150)}...`);
                            const vm = healMsg.content.match(/"verdict"\s*:\s*"(PASS|FAIL)"/i);
                            if (vm) {
                                healVerdict = vm[1].toUpperCase() as 'PASS' | 'FAIL';
                                const ar = healMsg.content.match(/"actualResult"\s*:\s*"([^"]*)"/i);
                                healActualResult = ar ? ar[1] : '';
                            }
                        }

                        if (!healMsg.tool_calls || healMsg.tool_calls.length === 0) {
                            console.log(`  🧬 HEAL: No more tool calls. Verdict: ${healVerdict}`);
                            break;
                        }

                        // Execute tool calls
                        for (const tc2 of healMsg.tool_calls) {
                            // Newer openai SDK distinguishes function-typed vs custom-typed tool
                            // calls — narrow with `as any` so we keep the same access pattern
                            // as the rest of this file (which already uses this idiom).
                            const tcAny = tc2 as any;
                            let toolName = tcAny.function?.name;
                            let args;
                            try {
                                args = typeof tcAny.function?.arguments === 'string'
                                    ? JSON.parse(tcAny.function.arguments) : tcAny.function?.arguments;
                            } catch { args = {}; }

                            console.log(`  🧬 HEAL Action: ${toolName}(${JSON.stringify(args).slice(0, 80)}...)`);
                            try {
                                if (toolName === 'playwright_mark_step') {
                                    healMessages.push({ role: 'tool', tool_call_id: tc2.id, content: JSON.stringify({ success: true }) });
                                    // Track mark_step calls so coverage check
                                    // sees them. They're not "real UI actions"
                                    // but the per-step assignment logic looks
                                    // for them by tool name.
                                    healUiActionLog.push({ tool: toolName, args, success: true, message: `mark_step(${args?.stepIndex || '?'})` });
                                } else {
                                    const res = await client!.callTool({ name: toolName, arguments: args });
                                    healMessages.push({ role: 'tool', tool_call_id: tc2.id, content: trimToolText(JSON.stringify(res.content)) });
                                    // Categorize: only count actual UI-modifying
                                    // tools (click/fill/etc) — not get_visible_text
                                    // or other utility reads.
                                    if (UI_ACTION_TOOLS.has(toolName)) {
                                        healUiActionLog.push({ tool: toolName, args, success: true, message: `${toolName}(${JSON.stringify(args).slice(0, 80)})` });
                                    }
                                }
                            } catch (e: any) {
                                console.error(`  🧬 HEAL Tool Error: ${e.message}`);
                                healMessages.push({ role: 'tool', tool_call_id: tc2.id, content: `Error: ${e.message}` });
                                if (UI_ACTION_TOOLS.has(toolName)) {
                                    healUiActionLog.push({ tool: toolName, args, success: false, message: `${toolName} failed: ${e.message?.slice(0, 100)}` });
                                }
                            }
                        }
                    }

                    if (healVerdict === 'PASS') {
                        // ── Heal-path integrity check ────────────────────────
                        // Verify the healer actually reached every step before
                        // we accept its PASS. Reuse the same coverage logic as
                        // the main pass: which step numbers did mark_step
                        // calls cover?
                        const healMarkedSteps = new Set(
                            healUiActionLog
                                .filter(a => a.tool === 'playwright_mark_step' && typeof a.args?.stepIndex === 'number')
                                .map(a => a.args.stepIndex as number),
                        );
                        const expectedSteps = (tc.steps || []).length;
                        const healSkipped: { idx: number; text: string }[] = [];
                        for (let s = 1; s <= expectedSteps; s++) {
                            if (!healMarkedSteps.has(s)) healSkipped.push({ idx: s, text: tc.steps[s - 1] });
                        }

                        const healedResult = results[results.length - 1];
                        if (healSkipped.length > 0 && healSkipped.length < expectedSteps) {
                            // Healer reached SOME steps but not all. Reject its
                            // PASS — show the truth in the UI instead of a
                            // misleading green checkmark beside red "Step not
                            // reached" rows.
                            const skippedList = healSkipped.map(u => `Step ${u.idx} ("${u.text}")`).slice(0, 3).join('; ');
                            const more = healSkipped.length > 3 ? ` +${healSkipped.length - 3} more` : '';
                            console.warn(`  🚫 Rejecting healer PASS verdict: ${healSkipped.length}/${expectedSteps} step(s) still unmarked after healing.`);
                            healedResult.status = 'FAIL';
                            healedResult.actualResult = `🩹 Heal attempt declared PASS but still skipped ${healSkipped.length}/${expectedSteps} step(s): ${skippedList}${more}. (Healer reasoning: ${healActualResult || '<none>'})`;
                            // Mark the test as heal-failed so the UI badge is honest.
                            healedResult.healingFailed = true;
                            healedResult.healed = false;
                        } else {
                            // Healer reached every step — accept the PASS AND
                            // rebuild stepResults so the UI shows the healed
                            // actions instead of the original failed ones.
                            console.log(`🩹 AUTO-HEAL SUCCESS: Test case healed on retry — coverage check passed.`);
                            healedResult.status = 'PASS';
                            healedResult.actualResult = `🩹 Healed on retry: ${healActualResult || 'Test passed after auto-healing'}`;
                            healedResult.error = undefined;
                            healedResult.healed = true;
                            healedResult.healingFailed = false;

                            // Rebuild stepResults from healUiActionLog using
                            // the same mark_step-based slicing logic as the
                            // main pass. This makes the UI show the steps the
                            // healer actually performed (not the steps the
                            // original failed run did).
                            const rebuiltSteps: typeof stepResults = [];
                            for (let idx = 0; idx < tc.steps.length; idx++) {
                                const stepText: string = tc.steps[idx];
                                const stepNum = idx + 1;
                                const curMark = healUiActionLog.findIndex(a => a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum);
                                const nxtMark = healUiActionLog.findIndex(a => a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum + 1);
                                let stepActions: typeof healUiActionLog = [];
                                if (curMark !== -1) {
                                    stepActions = healUiActionLog.slice(curMark + 1, nxtMark !== -1 ? nxtMark : healUiActionLog.length);
                                    if (stepNum === 1) {
                                        stepActions = [...healUiActionLog.slice(0, curMark), ...stepActions];
                                    }
                                }
                                const realStepActions = stepActions.filter(a => a.tool !== 'playwright_mark_step');
                                let stepResultDetails = '';
                                let stepPassed = true;
                                if (realStepActions.length > 0) {
                                    stepPassed = realStepActions.every(a => a.success);
                                    stepResultDetails = realStepActions
                                        .map(a => `${a.success ? '✅' : '❌'} ${describeUIAction(a)}`)
                                        .join('\n');
                                } else {
                                    // Step was marked but no UI actions — same
                                    // passive-step heuristic as the main pass.
                                    const passiveLooking = /\b(leave\s+\w+\s+(?:field\s+)?empty|empty|blank|do\s+not|don'?t|without|wait|observe|verify|confirm)\b/i.test(stepText);
                                    stepResultDetails = passiveLooking
                                        ? 'No browser action required (acknowledged after heal).'
                                        : 'Acknowledged after heal; no UI action logged.';
                                }
                                rebuiltSteps.push({ step: `Step ${stepNum}: ${stepText}`, result: stepResultDetails, passed: stepPassed });
                            }
                            healedResult.steps = rebuiltSteps;
                        }
                    } else {
                        console.log(`❌ AUTO-HEAL FAILED: Test case could not be healed.`);
                    }
                } catch (healErr: any) {
                    console.error(`❌ Auto-heal error: ${healErr.message}`);
                }
            }

            console.log(`   Moving to next test...`);

        } catch (err: any) {
            console.error(`  ❌ Error: ${err.message}`);

            // Still try to stop recording on error
            if (client) {
                try {
                    const stopRes = await client.callTool({ name: "playwright_stop_recording", arguments: {} });
                    const stopText = (stopRes.content as any)?.[0]?.text || "";
                    const videoMatch = stopText.match(/Video saved:\s*(.+)/);
                    if (videoMatch) videoFile = videoMatch[1].trim();
                } catch { }
            }

            results.push({
                id: tc.id,
                name: tc.name,
                jiraKey: tc.jiraKey,
                priority: tc.priority,
                status: "ERROR",
                steps: stepResults,
                expectedResult: tc.expectedResult,
                actualResult: "",
                duration: Date.now() - tcStart,
                error: err.message,
                videoFile,
                testData: tc.testData,
            });
        }
    }

    // Clean up browser: close page/context explicitly, then close MCP client
    if (client) {
        try {
            console.log('\n🧹 Closing browser and MCP connection...');
            // Set a timeout to force-exit if cleanup hangs
            const forceExitTimeout = setTimeout(() => {
                console.log('⚠️ Cleanup taking too long, forcing exit...');
                process.exit(0);
            }, 2000);

            // Ask the MCP server to close its browser context
            await client.callTool({ name: 'playwright_stop_recording', arguments: {} });
            await client.close();

            clearTimeout(forceExitTimeout);
            console.log('✅ Browser closed.');
        } catch (e) {
            console.log('Cleanup finished with notice:', (e as any).message);
        }
    }

    const totalDuration = Date.now() - startTime;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎉 ALL TEST CASES COMPLETED`);
    console.log(`${'='.repeat(80)}`);
    console.log(`📊 FINAL SUMMARY:`);
    console.log(`   Total Tests: ${results.length}`);
    console.log(`   Passed: ${results.filter(r => r.status === "PASS").length}`);
    console.log(`   Failed: ${results.filter(r => r.status === "FAIL").length}`);
    console.log(`   Errors: ${results.filter(r => r.status === "ERROR").length}`);
    console.log(`   Skipped: ${results.filter(r => r.status === "SKIPPED").length}`);
    console.log(`   Total Duration: ${totalDuration}ms`);
    console.log(`\n📋 Test Results:`);
    results.forEach((r, idx) => {
        console.log(`   ${idx + 1}. ${r.name}: ${r.status}`);
    });
    console.log(`${'='.repeat(80)}\n`);

    return {
        summary: {
            total: results.length,
            passed: results.filter(r => r.status === "PASS").length,
            failed: results.filter(r => r.status === "FAIL").length,
            skipped: results.filter(r => r.status === "SKIPPED").length,
            errors: results.filter(r => r.status === "ERROR").length,
            duration: totalDuration,
            executedAt: new Date().toISOString(),
        },
        results,
    };
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Parallel runner — wraps `runAgent` to run N workers concurrently.
 *
 *  Each worker calls the existing runAgent with a SUBSET of test cases. Since
 *  every runAgent invocation spawns its own MCP client (= its own Playwright
 *  browser process), workers are fully isolated. No shared state between them
 *  except the parent's onProgress callback (tagged by worker id).
 *
 *  Workload distribution is round-robin (worker N gets every Nth test) so
 *  long tests don't pile up in one worker.
 * ════════════════════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════════════════
//  PER-STEP ORCHESTRATOR — opt-in alternative to the giant single-conversation
//  agent above. Each test step gets its OWN focused LLM conversation with a
//  tight turn budget (default 6), so the LLM doesn't have to track 15 steps
//  worth of context simultaneously. The browser session (cookies, navigation
//  state) persists across steps via the shared MCP client.
//
//  Trade-offs vs the legacy runAgent:
//    + MUCH more reliable on long flows (15+ steps) — each conversation is
//      focused on one thing, no "I forgot Step 9 existed" drift.
//    + Failures are localized — when a step fails we know exactly which one,
//      and can short-circuit the test case instead of spinning.
//    + Cheaper per turn: smaller prompt, smaller history, fewer tokens.
//    - More LLM calls overall (one mini-conversation per step) — could be
//      slightly slower on tests the legacy agent would breeze through.
//    - Auto-heal is currently NOT wired into this path (legacy agent still
//      handles healing). If a per-step run fails, the test reports honestly.
//
//  Opt in by setting PER_STEP_MODE=1 in the backend env. Default OFF so this
//  doesn't disturb runs that are currently passing.
// ════════════════════════════════════════════════════════════════════════════

export async function runAgentPerStep(
    testCasesInput: string | any[],
    llmConfig: any,
    onProgress?: (status: { currentCase: string; progress: number; total: number; action?: string; currentCaseId?: string; currentCaseName?: string }) => void,
    options?: { autoHeal?: boolean; headed?: boolean }
): Promise<ExecutionReport> {
    console.log('🚀 Starting Per-Step MCP Agent (focused mini-conversation per step)...');
    const headed = options?.headed !== false;
    const startTime = Date.now();
    // Default raised 6 → 10: the Observe→Locate→Act→Confirm loop legitimately
    // needs discover + act + verify + one re-discover/retry without running out
    // of turns on a single hard element. Tunable via env.
    const MAX_TURNS_PER_STEP = Number(process.env.MAX_TURNS_PER_STEP) || 10;
    const TOOL_RESULT_CHARS = Number(process.env.TOOL_RESULT_CHARS) || 2000;

    const testCases = typeof testCasesInput === 'string'
        ? parseTestCases(testCasesInput)
        : (testCasesInput as any[]);
    if (testCases.length === 0) {
        return {
            summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, duration: 0, executedAt: new Date().toISOString() },
            results: [],
        };
    }

    // Same prefix-strip as legacy: a 14-step plan with "Step 13. Click X" text
    // confuses the agent into using the embedded number for mark_step.
    const stripEmbeddedStepPrefix = (s: string): string => s ? s.replace(/^\s*step\s+\d+\s*[:.\-)]\s*/i, '').trimStart() : s;
    for (const tc of testCases) {
        if (Array.isArray(tc.steps)) {
            tc.steps = tc.steps.map((s: any) => typeof s === 'string' ? stripEmbeddedStepPrefix(s) : s);
        }
    }

    const trimToolText = (text: string): string => {
        if (!text || text.length <= TOOL_RESULT_CHARS) return text;
        return text.slice(0, TOOL_RESULT_CHARS) + `\n…[truncated ${text.length - TOOL_RESULT_CHARS} chars]`;
    };

    const UI_ACTION_TOOLS = new Set([
        'playwright_navigate', 'navigate',
        'playwright_click', 'click',
        'playwright_fill', 'fill',
        'playwright_type', 'type',
        'playwright_press_key', 'press_key',
        'playwright_select_option', 'select', 'select_option',
        'playwright_check', 'check',
        'playwright_fill_form',
        'playwright_smart_fill_page',
        'playwright_mark_step',
    ]);

    const describeUIAction = (a: { tool: string; args: any }): string => {
        const x = a.args || {};
        switch (a.tool) {
            case 'playwright_navigate': case 'navigate': return `Navigate to: ${x.url || '(url)'}`;
            case 'playwright_click': case 'click': return `Click: "${String(x.selector || '').replace(/^text=/, '').replace(/"/g, '')}"`;
            case 'playwright_fill': case 'fill': return `Fill "${String(x.selector || '').replace(/^#/, '')}" with "${x.value}"`;
            case 'playwright_type': case 'type': return `Type "${x.value}" into "${x.selector}"`;
            case 'playwright_press_key': case 'press_key': return `Press: ${x.key || '(key)'}`;
            case 'playwright_select_option': case 'select': case 'select_option': return `Select "${x.value}" in "${x.selector}"`;
            case 'playwright_check': case 'check': return `Check: "${x.selector}"`;
            case 'playwright_mark_step': return `mark_step(${x.stepIndex || '?'}, "${String(x.stepDescription || '').slice(0, 60)}")`;
            default: return `${a.tool}(${JSON.stringify(x).slice(0, 80)})`;
        }
    };

    // ── MCP connection ──────────────────────────────────────────────────────
    let client: Client | null = null;
    let mcpTools: any[] = [];
    try {
        const localMcpScript = path.join(__dirname, 'playwright-mcp.ts');
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const command = npxCmd;
        const args = fs.existsSync(localMcpScript) ? ['tsx', localMcpScript] : ['-y', '@playwright/mcp@latest'];
        const transport = new StdioClientTransport({
            command,
            args,
            env: { ...(process.env as Record<string, string>), MCP_HEADLESS: headed ? '0' : '1' },
        });
        client = new Client({ name: 'test-runner-per-step', version: '1.0.0' }, { capabilities: {} });
        await Promise.race([
            client.connect(transport),
            new Promise((_, rej) => setTimeout(() => rej(new Error('MCP connection timeout after 30s')), 30000)),
        ]);
        const toolsRes = await client.listTools();
        mcpTools = toolsRes.tools;
    } catch (err: any) {
        console.error(`❌ Per-step agent: MCP connect failed: ${err.message}`);
        return {
            summary: { total: testCases.length, passed: 0, failed: 0, skipped: 0, errors: testCases.length, duration: Date.now() - startTime, executedAt: new Date().toISOString() },
            results: testCases.map((tc: any) => ({
                id: tc.id, name: tc.name, jiraKey: tc.jiraKey, priority: tc.priority,
                status: 'ERROR' as const, steps: [],
                expectedResult: tc.expectedResult, actualResult: '', error: `MCP setup failed: ${err.message}`,
                duration: 0, testData: tc.testData,
            })),
        };
    }

    // Format tools for OpenAI tool-calling shape. Drop tools whose schema
    // has `format: "uri"` since some providers reject that.
    const sanitize = (schema: any): any => {
        if (!schema || typeof schema !== 'object') return schema;
        const out: any = Array.isArray(schema) ? [] : {};
        for (const k of Object.keys(schema)) {
            if (k === 'format' && schema[k] === 'uri') continue;
            out[k] = sanitize(schema[k]);
        }
        return out;
    };
    const ensureMarkStep = (() => {
        if (mcpTools.some(t => t.name === 'playwright_mark_step')) return mcpTools;
        return [...mcpTools, {
            name: 'playwright_mark_step',
            description: 'Mark the beginning of a new test step.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepIndex: { type: 'number', description: '1-based index of the step' },
                    stepDescription: { type: 'string', description: 'Brief description' },
                },
                required: ['stepIndex'],
            },
        }];
    })();
    const finalFormattedTools = ensureMarkStep.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description || '',
            parameters: sanitize(t.inputSchema || { type: 'object', properties: {} }),
        },
    }));

    const getBaseURL = (cfg: any): string => {
        switch (cfg.provider) {
            case 'Groq': return 'https://api.groq.com/openai/v1';
            case 'Ollama': return `${(cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`;
            case 'Gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai/';
            default: return cfg.baseUrl || 'https://api.openai.com/v1';
        }
    };
    const openai = new OpenAI({ apiKey: llmConfig.apiKey || 'dummy', baseURL: getBaseURL(llmConfig) });

    // Reuse the legacy siteCheatsheet logic — saucedemo is the highest-value
    // bake-in. Could be expanded to other known stable sites later.
    const buildSiteCheatsheet = (tcText: string): string => {
        if (!/saucedemo\.com/i.test(tcText)) return '';
        return `
SITE CHEATSHEET — saucedemo.com (DOM is stable; USE THESE VERBATIM):
- Login: #user-name, #password, #login-button. Users: standard_user / problem_user / performance_glitch_user / error_user / visual_user. Password (all): secret_sauce. Error banner: [data-test="error"].
- Inventory: cart icon #shopping_cart_container; cart badge .shopping_cart_badge. Add-to-cart per product: #add-to-cart-<name-lowercased-with-hyphens> (e.g. #add-to-cart-sauce-labs-backpack). After clicking Add, the button is REPLACED by #remove-<same-name>.
- Cart (/cart.html): item rows .cart_item (multi-match — use .first() or filter); item names [data-test="inventory-item-name"]; Checkout #checkout; Continue Shopping #continue-shopping.
- Checkout step one: #first-name, #last-name, #postal-code, #continue, #cancel.
- Checkout step two: #finish, #cancel.
- Complete page: visible "Thank you for your order!"; #back-to-products.
`;
    };

    // Helpers for the test-case loop.
    // Extract the application URL the LLM should navigate to. We REQUIRE
    // http(s):// — earlier versions would silently pass back "#" or empty
    // string when the test plan only had a placeholder, and the LLM would
    // then call playwright_navigate(url="#") which Playwright rejects with
    // "no valid URL provided".
    const extractValidHttpUrl = (text: string): string | null => {
        if (!text) return null;
        const m = text.match(/(https?:\/\/[^\s)"'`<>]+)/i);
        if (!m) return null;
        const url = m[1].replace(/[)"',.;]+$/, '').trim();
        // Ignore obvious placeholders/anchors.
        if (/^https?:\/\/?$/i.test(url) || url === 'http://' || url === 'https://') return null;
        return url;
    };
    const extractUrl = (tc: any): string | null => {
        const searchString = `${tc.preconditions || ''} ${tc.testData || ''} ${tc.steps?.join(' ') || ''} ${tc.expectedResult || ''}`;
        return extractValidHttpUrl(searchString);
    };

    // Cross-test-case URL fallback: scan EVERY test case in the plan once
    // and pick the first valid URL we find. If a single tc has no URL in
    // its own fields (common when the markdown puts the URL only on tc 1),
    // we use this as the inherited target.
    const fallbackUrl: string | null = (() => {
        for (const tc of testCases) {
            const url = extractUrl(tc);
            if (url) return url;
        }
        return null;
    })();
    if (fallbackUrl) {
        console.log(`🌐 Per-step fallback URL (for tcs missing their own): ${fallbackUrl}`);
    } else {
        console.warn(`⚠️ No http(s):// URL found anywhere in the test plan. All test cases will fail at step 1 unless the LLM has prior knowledge of the URL.`);
    }

    // Resolve a snapshot tool name once — different MCP versions expose it as
    // either `playwright_get_visible_text` or `browser_get_visible_text`.
    // Falling back to whatever exists; if neither, page state stays empty.
    const snapshotToolName = (() => {
        const candidates = ['playwright_get_visible_text', 'browser_get_visible_text', 'playwright_get_html'];
        for (const name of candidates) {
            if (mcpTools.some(t => t.name === name)) return name;
        }
        return null;
    })();
    const evaluateToolName = (() => {
        for (const name of ['playwright_evaluate', 'browser_evaluate']) {
            if (mcpTools.some(t => t.name === name)) return name;
        }
        return null;
    })();
    const navigateToolName = (() => {
        for (const name of ['playwright_navigate', 'browser_navigate']) {
            if (mcpTools.some(t => t.name === name)) return name;
        }
        return null;
    })();

    // Best-effort, site-agnostic cookie/consent banner dismissal. These banners
    // overlay the page and intercept clicks (the #1 cause of "could not locate
    // element" on the first interaction). Only clicks a control whose text is an
    // unambiguous consent acceptor, so it won't click unrelated buttons. Returns
    // what it clicked (or null). Safe to call repeatedly.
    const dismissConsentBanner = async (): Promise<string | null> => {
        if (!evaluateToolName) return null;
        const script = [
            "var ids=['onetrust-accept-btn-handler','truste-consent-button','accept-recommended-btn-handler','CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll'];",
            "for (var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]); if(el){el.click(); return 'id:'+ids[i];}}",
            "var ok=['accept all cookies','accept all','accept cookies','i accept','i agree','agree and close','allow all cookies','allow all','accept'];",
            "var nodes=Array.from(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]'));",
            "for (var j=0;j<nodes.length;j++){var n=nodes[j];var r=n.getBoundingClientRect();var s=getComputedStyle(n); if(r.width<=0||r.height<=0||s.visibility==='hidden'||s.display==='none')continue; var t=(n.textContent||n.value||'').trim().toLowerCase(); if(ok.indexOf(t)!==-1){n.click(); return 'text:'+t;}}",
            "return null;",
        ].join('');
        try {
            const r = await client.callTool({ name: evaluateToolName, arguments: { script } }).catch(() => null);
            const t = (r?.content as any)?.[0]?.text;
            if (t && t !== 'null' && t !== '"null"') {
                console.log(`     🍪 Dismissed consent banner (${t}).`);
                return String(t);
            }
        } catch { /* best effort */ }
        return null;
    };
    const videoStartTool = mcpTools.some(t => t.name === 'playwright_start_recording') ? 'playwright_start_recording' : null;
    const videoStopTool = mcpTools.some(t => t.name === 'playwright_stop_recording') ? 'playwright_stop_recording' : null;
    console.log(`🔎 Per-step session ready — ${mcpTools.length} tools available. Snapshot tool: ${snapshotToolName ?? '(none)'}, video: ${videoStartTool ? 'on' : 'off'}.`);

    // ── Per-test-case execution loop ────────────────────────────────────────
    let lastKnownUrl: string | null = null;
    const results: TestCaseResult[] = [];
    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        if (isStopRequested()) {
            console.log('🛑 Stop requested — halting per-step agent.');
            break;
        }
        const tcStart = Date.now();
        console.log(`\n${'='.repeat(80)}`);
        console.log(`▶ TC-${tc.id}: ${tc.name} [${i + 1}/${testCases.length}] — per-step mode`);
        console.log(`${'='.repeat(80)}`);

        // Resolve URL with this priority:
        //   1. URL inside THIS tc's fields (preconditions / testData / steps)
        //   2. URL from the previous test case (lastKnownUrl)
        //   3. URL found anywhere in the WHOLE test plan (fallbackUrl)
        // Without (3), tcs whose markdown rows are sparse would have no URL
        // even when other tcs in the same plan clearly target the same app.
        let urlFromPreconditions = extractUrl(tc);
        if (urlFromPreconditions) {
            lastKnownUrl = urlFromPreconditions;
        } else if (lastKnownUrl) {
            urlFromPreconditions = lastKnownUrl;
            console.log(`   ℹ️ Inheriting URL from previous test case: ${lastKnownUrl}`);
        } else if (fallbackUrl) {
            urlFromPreconditions = fallbackUrl;
            console.log(`   ℹ️ Falling back to plan-wide URL: ${fallbackUrl}`);
        }
        if (!urlFromPreconditions) {
            console.warn(`   ⚠️ No URL found for TC-${tc.id} — step 1 will FAIL fast with a clear error rather than guessing.`);
        } else {
            console.log(`   🌐 Target URL: ${urlFromPreconditions}`);
        }

        // Start video recording for this test case (best-effort).
        let videoFile = '';
        if (videoStartTool) {
            try {
                const startRes = await client.callTool({ name: videoStartTool, arguments: { testCaseId: `tc_${Date.now()}` } });
                const startText = (startRes.content as any)?.[0]?.text || '';
                const videoMatch = startText.match(/Video will be saved (?:to|as):\s*(.+)/i);
                if (videoMatch) videoFile = videoMatch[1].trim();
            } catch { /* recording is optional */ }
        }

        const tcText = `${tc.name} ${tc.expectedResult || ''} ${(tc.steps || []).join(' ')} ${tc.testData || ''} ${urlFromPreconditions || ''}`;
        const siteCheatsheet = buildSiteCheatsheet(tcText);

        const stepResults: { step: string; result: string; passed: boolean }[] = [];
        const cumulativeActions: { tool: string; args: any; success: boolean; message: string }[] = [];
        let testCaseFailed = false;
        let testCaseFailureReason = '';

        for (let stepIdx = 0; stepIdx < tc.steps.length; stepIdx++) {
            if (isStopRequested()) { testCaseFailed = true; testCaseFailureReason = 'Stopped by user'; break; }
            const stepNum = stepIdx + 1;
            const stepText: string = tc.steps[stepIdx];

            onProgress?.({
                currentCase: `TC-${tc.id} · Step ${stepNum}/${tc.steps.length}`,
                currentCaseId: `TC-${tc.id}`,
                currentCaseName: `${tc.name} — Step ${stepNum}: ${stepText.slice(0, 60)}`,
                progress: i + 1,
                total: testCases.length,
                action: stepText,
            });

            // Capture current page state for context. Best-effort — if the
            // browser hasn't navigated yet (step 1), we get a blank snapshot.
            const readSnapshot = async (): Promise<string> => {
                if (!snapshotToolName) return '';
                try {
                    const visRes = await client.callTool({ name: snapshotToolName, arguments: {} }).catch(() => null);
                    const txt = (visRes?.content as any)?.[0]?.text;
                    return typeof txt === 'string' ? txt.slice(0, 1500) : '';
                } catch { return ''; }
            };
            let pageSnapshot = await readSnapshot();

            // If a cookie/consent banner is overlaying the page, dismiss it BEFORE
            // the agent tries to interact — otherwise it intercepts clicks and the
            // step fails with "could not locate element". Re-snapshot afterward.
            if (/\b(cookie|consent|privacy policy|gdpr)\b/i.test(pageSnapshot)) {
                const dismissed = await dismissConsentBanner();
                if (dismissed) pageSnapshot = await readSnapshot();
            }

            // Brief summary of what previous steps accomplished, so the LLM
            // has continuity without re-reading every action.
            const prevSummary = stepResults.length === 0
                ? '(this is the first step)'
                : stepResults.map((s, idx) => `  ${idx + 1}. ${s.passed ? '✅' : '❌'} ${s.step.replace(/^Step \d+:\s*/, '')}`).join('\n');

            // Step-1 early-out: if no URL is known, don't even bother asking
            // the LLM — it'll hallucinate "#" and we'll fail with a confusing
            // "page.goto error" three turns later. Fail fast with a clear
            // message naming the missing field.
            if (stepNum === 1 && !urlFromPreconditions) {
                console.warn(`     ↳ ABORTING TC-${tc.id}: no URL extractable from the test plan.`);
                const failMsg = `Test plan has no http(s):// URL in preconditions, test data, or step text. Cannot navigate. Add a Preconditions row like "URL: https://www.saucedemo.com/" (or include the URL inside the step text) and re-run.`;
                stepResults.push({
                    step: `Step 1: ${stepText}`,
                    result: `⚠ ${failMsg}`,
                    passed: false,
                });
                for (let j = 1; j < tc.steps.length; j++) {
                    stepResults.push({
                        step: `Step ${j + 1}: ${tc.steps[j]}`,
                        result: `⚠ Step not reached — execution stopped after Step 1 failed (no URL to navigate to).`,
                        passed: false,
                    });
                }
                testCaseFailed = true;
                testCaseFailureReason = failMsg;
                break;
            }

            // DETERMINISTIC STEP-1 NAVIGATION. The browser starts blank, and
            // relying on the LLM to navigate first was flaky (it sometimes
            // narrated or "observed" the blank page instead of navigating, then
            // ran out of turns having performed no action). So the orchestrator
            // navigates itself, seeds it as the step's first successful action,
            // and refreshes the snapshot — the LLM then continues from a loaded
            // page. (We do this whenever the page is still blank and we have a
            // URL, not only literally step 1, to be robust.)
            const seedActions: { tool: string; args: any; success: boolean; message: string }[] = [];
            let navigationHint = '';
            const pageIsBlank = !pageSnapshot || pageSnapshot.trim().length < 5;
            if (stepNum === 1 && urlFromPreconditions && navigateToolName && pageIsBlank) {
                try {
                    const navRes = await client.callTool({ name: navigateToolName, arguments: { url: urlFromPreconditions } }).catch(() => null);
                    const ok = !!navRes && !(navRes as any).isError;
                    seedActions.push({ tool: navigateToolName, args: { url: urlFromPreconditions }, success: ok, message: `${navigateToolName}(${urlFromPreconditions})` });
                    console.log(`     🌐 Auto-navigated to ${urlFromPreconditions} (${ok ? 'ok' : 'failed'}).`);
                    pageSnapshot = await readSnapshot();
                    if (/\b(cookie|consent|privacy policy|gdpr)\b/i.test(pageSnapshot)) {
                        if (await dismissConsentBanner()) pageSnapshot = await readSnapshot();
                    }
                    navigationHint = `\n\nNOTE: The browser has ALREADY been navigated to ${urlFromPreconditions} for you. Do NOT navigate again — proceed directly with the rest of this step on the loaded page.`;
                } catch {
                    navigationHint = `\n\nIMPORTANT — STEP 1: navigate to ${urlFromPreconditions} via playwright_navigate FIRST, then perform the step.`;
                }
            } else if (stepNum === 1 && urlFromPreconditions) {
                navigationHint = `\n\nIMPORTANT — STEP 1: if not already there, navigate to ${urlFromPreconditions} via playwright_navigate FIRST, then perform the step.`;
            }

            const systemPrompt = `You are executing ONE STEP of a Playwright browser test using the available playwright_* tools. Do ONLY this step, then STOP — no verdict, no other steps. The orchestrator calls you again for the next step.

═══ NON-NEGOTIABLE ═══
1. Your FIRST tool call MUST be playwright_mark_step(stepIndex=${stepNum}, stepDescription="<short>").
2. NEVER guess or invent a selector. ALWAYS discover the LIVE page first, then act only on selectors/labels/options that discovery actually returned. The page snapshot in this prompt is truncated and may be stale — re-read the page.
3. Use the Test Data values verbatim. Do not fabricate elements, values, options, or extra steps.
4. When this step's action(s) are done, STOP CALLING TOOLS (do not return JSON, do not start the next step).

═══ OBSERVE → LOCATE → ACT → CONFIRM (do this for the step) ═══
OBSERVE — get fresh, complete page state before touching anything:
- Forms/inputs: playwright_get_input_fields → real selectors, types, labels, current values.
- Buttons/links/tiles: playwright_evaluate with this script (returns visible clickables only):
  return JSON.stringify(Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button],[role=link],[onclick]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}).map(e=>({tag:e.tagName.toLowerCase(),text:(e.textContent||e.value||e.getAttribute('aria-label')||'').trim().slice(0,80),id:e.id||null,dataTest:e.getAttribute('data-test')||e.getAttribute('data-testid')||null,name:e.getAttribute('name')||null,role:e.getAttribute('role')||null})).slice(0,80),null,2)
- Content/verification: playwright_get_visible_text (optionally scoped with a selector).

LOCATE — pick the most STABLE selector from what discovery returned, in priority order:
  #id  >  [data-test=..]/[data-testid=..]  >  [name=..]  >  [aria-label=..]/[role=..]  >  [placeholder=..]  >  text=VisibleText  >  type/tag.
  Use the EXACT id/data-test discovery returned — do not shorten or guess. Avoid brittle long CSS / :nth-child unless nothing else exists. text= is fine only when unique.

ACT — choose the tool that matches the element TYPE:
  • Text / email / password / number / textarea → playwright_fill(selector, value). If the value won't stick or the field is reactive/autocomplete → playwright_type(selector, text).
  • Native <select> → playwright_select_option(selector, label="<visible option text>")  (label preferred; else value=/index=).
  • Custom/JS dropdown or listbox (NOT a real <select>) → playwright_click to OPEN it, playwright_get_visible_text to read the options, then playwright_click the exact option text. If it filters as you type, playwright_type the option then ArrowDown+Enter.
  • Checkbox / radio → playwright_check(selector, checked=true).
  • Button / link / tile → playwright_click(selector).
  • Autocomplete / typeahead (address, search) → playwright_type, then playwright_wait_for_selector for the suggestion list, then click the right suggestion.
  • Several fields at once → playwright_fill_form(fields:[{selector,value,type}], submitSelector?) — types: fill|type|select|check|recaptcha. Or playwright_smart_fill_page(data:{"<label>":"<value>"}) when labels are clear.
  • Element inside an iframe → pass iframe="<iframe css>" on the tool.
  • A cookie/consent/modal/overlay banner blocking interaction → discover and dismiss it (Accept/Close) FIRST, then retry the real action.

VAGUE "fill the details" steps ("give necessary details", "fill all suitable details", "fill the form", "provide the required information", "complete the form"):
- DEEP-SCAN FIRST: call playwright_get_input_fields — it maps EVERY field and flags each "*REQUIRED" one, lists <select> options, and shows checkbox/radio state and which are still empty.
- Then fill EVERYTHING the form needs to advance, not only the values named in the step:
   · For each field whose label matches the Test Data / step, use that exact value.
   · For every OTHER *REQUIRED field that is still empty, supply a clearly valid, realistic value (e.g. a required phone → a valid-format number; a required address → a plausible one). Prefer values consistent with any country/context the step specified.
   · Required <select> → playwright_select_option with one of the listed options. Required checkbox/radio (e.g. consent, "I agree") → playwright_check.
- RE-SCAN with playwright_get_input_fields before moving on and confirm "0 required & still empty". Do NOT click Continue/Next/Review while required fields remain empty — that's what makes the next step fail.
- Use playwright_fill_form or playwright_smart_fill_page to fill many fields in one call when labels are clear.

CONFIRM — prove the action took effect (re-read the value, the visible text, or wait_for_selector for what should appear next):
- After navigation or a click that loads new content, call playwright_wait_for_selector for an element you expect on the new state BEFORE the next action.
- If nothing changed, your selector was wrong: RE-DISCOVER (observe again) and try a different selector. NEVER repeat the same selector more than twice.
- If an element is found but not actionable: scroll it into view via playwright_evaluate("return document.querySelector('<sel>')?.scrollIntoView({block:'center'})"), then retry. Use playwright_click force=true only as a last resort.

═══ NOTES ═══
- Passive step ("leave field empty", "observe X", "wait for load") → mark_step, do the minimal needed read, then stop.
- If you genuinely cannot complete this step after discovery + retries, call playwright_get_visible_text once to capture context, then stop — it will be marked failed with that context.
- NEVER skip mark_step, do multiple steps, or return a verdict JSON.
${siteCheatsheet}`;

            const userPrompt = `Test Case: ${tc.name}
Test URL: ${urlFromPreconditions || '(not provided — extract from test data or steps if needed)'}
Test Data: ${tc.testData || '(none)'}

PREVIOUS STEPS (already completed in this same browser session):
${prevSummary}

CURRENT PAGE STATE (visible text, may be partial):
${pageSnapshot || '(no snapshot available — likely the very first action)'}${navigationHint}

YOUR STEP (do ONLY this — call mark_step(${stepNum}, ...) first):
Step ${stepNum} of ${tc.steps.length}: ${stepText}`;

            console.log(`   ▶ Step ${stepNum}/${tc.steps.length}: ${stepText.slice(0, 80)}`);

            const messages: any[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ];
            const stepActions: { tool: string; args: any; success: boolean; message: string }[] = [...seedActions];
            let stepFailureReason: string | undefined;

            for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
                if (isStopRequested()) { stepFailureReason = 'Stopped by user'; break; }
                let response: any;
                try {
                    response = await openai.chat.completions.create({
                        model: llmConfig.model || 'gpt-4o',
                        messages,
                        tools: finalFormattedTools,
                        temperature: 0.1,
                    });
                } catch (llmErr: any) {
                    stepFailureReason = `LLM API error: ${llmErr.message}`;
                    break;
                }
                const msg = response.choices?.[0]?.message;
                if (!msg) { stepFailureReason = 'LLM returned no message'; break; }
                messages.push(msg);

                const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                if (toolCalls.length === 0) {
                    // No tool call this turn. If the agent has ALREADY performed a
                    // real browser action, treat it as "step done" and stop.
                    // But if it has done NOTHING yet (it just replied with text /
                    // planning), don't bail — nudge it to actually act and keep
                    // going. This is the #1 cause of "no browser action performed":
                    // the model narrates instead of calling a tool on turn 1.
                    const actedAlready = stepActions.some(a => a.tool !== 'playwright_mark_step');
                    if (!actedAlready && turn < MAX_TURNS_PER_STEP - 1) {
                        messages.push({
                            role: 'user',
                            content: 'You responded without calling a tool. Do NOT explain or plan in text — CALL a playwright_* tool now to actually perform this step (e.g. playwright_navigate to the Test URL, then playwright_get_input_fields / playwright_fill / playwright_click). Act now.',
                        });
                        continue;
                    }
                    break;
                }

                for (const tcRaw of toolCalls) {
                    const tcAny = tcRaw as any;
                    const toolName = tcAny.function?.name;
                    let args: any = {};
                    try {
                        args = typeof tcAny.function?.arguments === 'string'
                            ? JSON.parse(tcAny.function.arguments)
                            : tcAny.function?.arguments || {};
                    } catch { args = {}; }

                    // Navigation guardrail: refuse to call navigate with a
                    // non-http URL. Auto-rewrite to the test's known URL if
                    // we have one (this rescues runs where the LLM hallucinated
                    // "#" instead of using the URL we put in the prompt).
                    if (/navigate$/i.test(toolName || '') && args && typeof args.url === 'string') {
                        const u = args.url.trim();
                        if (!/^https?:\/\//i.test(u)) {
                            if (urlFromPreconditions) {
                                console.warn(`     ⚠ LLM tried to navigate to "${u}" — rewriting to known URL "${urlFromPreconditions}".`);
                                args = { ...args, url: urlFromPreconditions };
                            } else {
                                const reason = `Refused to navigate: LLM passed url="${u}" which is not a valid http(s) URL and no Test URL is known for this run.`;
                                console.warn(`     ✗ ${reason}`);
                                messages.push({ role: 'tool', tool_call_id: tcAny.id, content: `Error: ${reason}` });
                                stepActions.push({ tool: toolName, args, success: false, message: reason });
                                continue;
                            }
                        }
                    }

                    try {
                        let toolText = '';
                        if (toolName === 'playwright_mark_step') {
                            toolText = JSON.stringify({ success: true, message: `Marked step ${args.stepIndex ?? '?'}` });
                            stepActions.push({ tool: toolName, args, success: true, message: `mark_step(${args.stepIndex ?? '?'})` });
                        } else {
                            const res = await client.callTool({ name: toolName, arguments: args });
                            toolText = res.isError ? `Error: ${JSON.stringify(res.content)}` : JSON.stringify(res.content);
                            const isUi = UI_ACTION_TOOLS.has(toolName);
                            if (isUi) {
                                stepActions.push({
                                    tool: toolName, args, success: !res.isError,
                                    message: `${toolName}(${args.selector || args.url || JSON.stringify(args).slice(0, 60)})${res.isError ? ' — error' : ''}`,
                                });
                            }
                        }
                        messages.push({ role: 'tool', tool_call_id: tcAny.id, content: trimToolText(toolText) });
                    } catch (toolErr: any) {
                        const isUi = UI_ACTION_TOOLS.has(toolName);
                        if (isUi) {
                            stepActions.push({ tool: toolName, args, success: false, message: `${toolName} failed: ${toolErr.message?.slice(0, 120) || 'unknown'}` });
                        }
                        messages.push({ role: 'tool', tool_call_id: tcAny.id, content: `Error: ${toolErr.message || 'tool execution failed'}` });
                    }
                }
            }

            // Evaluate the step's success:
            // - Pass: mark_step was called for this stepNum AND no UI action failed
            // - Pass (passive): mark_step was called and no UI actions besides mark_step
            // - Fail: anything else
            // LLMs occasionally send stepIndex as a string ("2") not a number,
            // so we coerce both sides before comparing.
            const markStepForThis = stepActions.some(
                a => a.tool === 'playwright_mark_step' && Number(a.args?.stepIndex) === stepNum,
            );
            const realActions = stepActions.filter(a => a.tool !== 'playwright_mark_step');

            // Diagnostic: see exactly what the LLM did in this step. Without
            // this it's impossible to tell from the report whether the LLM
            // never called mark_step, called it with the wrong index, or
            // crashed mid-step.
            const dbg = stepActions.map(a => `${a.success ? '✓' : '✗'} ${a.tool}${a.tool === 'playwright_mark_step' ? `(stepIndex=${a.args?.stepIndex})` : ''}`).join(', ') || '(no tool calls)';
            console.log(`     ↳ ${stepActions.length} tool call(s): ${dbg}`);
            if (stepFailureReason) console.log(`     ↳ FAILURE: ${stepFailureReason}`);
            // "Passive" = a step that legitimately needs no browser action (observe/
            // verify/review). NOTE: deliberately excludes "check" — "check the
            // checkbox" is an ACTION, not an observation.
            const passiveLooking = /\b(leave\s+\w+\s+(?:field\s+)?empty|empty|blank|do\s+not|don'?t|without|wait|observe|verify|confirm|review|validate|ensure|inspect)\b/i.test(stepText);
            // RETRY-TOLERANT: a step that tries selector A (fails), then selector B
            // (succeeds) is a SUCCESS — that recovery is exactly the behavior the
            // prompt asks for. So judge by whether the step ENDED on a successful
            // action, not by whether any intermediate attempt failed. Earlier
            // failed attempts are shown as "↻ retried" rather than failing the step.
            const lastUi = realActions[realActions.length - 1];
            const hadRetries = realActions.some(a => !a.success);

            let resultDetails: string;
            let passed: boolean;
            if (stepFailureReason) {
                resultDetails = stepFailureReason;
                passed = false;
            } else if (realActions.length > 0 && lastUi.success) {
                // Ended on a successful browser action → step done. (mark_step is
                // advisory in per-step mode — the orchestrator owns the boundary.)
                resultDetails = realActions.map(a => `${a.success ? '✅' : '↻'} ${describeUIAction(a)}`).join('\n');
                if (hadRetries) resultDetails = `(recovered after retrying a selector)\n${resultDetails}`;
                if (!markStepForThis) resultDetails += `\n(note: agent skipped mark_step(${stepNum}); judged by successful browser action)`;
                passed = true;
            } else if (realActions.length > 0) {
                // Ended on a FAILED action and never recovered.
                resultDetails = realActions.map(a => `${a.success ? '✅' : '❌'} ${describeUIAction(a)}`).join('\n');
                passed = false;
            } else if (passiveLooking) {
                resultDetails = 'No browser action required for this step (passive: acknowledged, condition satisfied implicitly).';
                passed = true;
            } else {
                // Non-passive step but the agent performed NO browser action — it
                // most likely could not locate the target element. Capture live
                // page context so the failure is actionable (this is far more
                // useful than the old "didn't call mark_step" message).
                let ctx = '';
                if (snapshotToolName) {
                    try {
                        const r = await client.callTool({ name: snapshotToolName, arguments: {} }).catch(() => null);
                        const t = (r?.content as any)?.[0]?.text;
                        if (typeof t === 'string') ctx = `\nPage currently shows: ${t.replace(/\s+/g, ' ').slice(0, 400)}`;
                    } catch { /* best effort */ }
                }
                resultDetails = `⚠ No browser action was performed for this step within the ${MAX_TURNS_PER_STEP}-turn budget — the agent likely could not locate the element for: "${stepText.slice(0, 90)}". Check the element exists / reword the step.${ctx}`;
                passed = false;
            }

            // OUTCOME CHECK (catches false passes like "login succeeded" when it
            // didn't): for a step that should TRANSITION the page (login / sign in
            // / submit / continue / next / pay / etc.), if a NEW error/validation
            // message appears that wasn't on the page before the step, the action
            // did not actually succeed — flip PASS to FAIL. Kept tight + diff-based
            // (only NEW text) so it won't false-fail normal steps.
            if (passed && realActions.length > 0 && /\b(log\s?in|sign\s?in|log\s?on|submit|continue|next|proceed|pay|checkout|review my donation|place order)\b/i.test(stepText)) {
                const afterText = await readSnapshot();
                const before = pageSnapshot.toLowerCase();
                const after = afterText.toLowerCase();
                // Auth/submit-FAILURE phrases only — deliberately tight so a
                // legitimately successful transition isn't false-failed by generic
                // form wording (e.g. "all fields are required").
                const errorSignals = [
                    'incorrect', 'invalid', 'do not match', 'does not match', "doesn't match",
                    'unable to sign', 'could not sign', 'unable to log', 'wrong password',
                    'wrong username', 'not recognized', 'authentication failed', 'login failed',
                    'sign-in failed', 'session expired', 'please try again',
                ];
                const newError = errorSignals.find(p => after.includes(p) && !before.includes(p));
                if (newError) {
                    const snippet = afterText.replace(/\s+/g, ' ').trim().slice(0, 300);
                    resultDetails = `❌ Action ran but the page shows an error — the step did NOT actually succeed (matched "${newError}"). Page now: ${snippet}`;
                    passed = false;
                    console.log(`     ✗ Outcome check failed for step ${stepNum}: new error signal "${newError}".`);
                }
            }

            stepResults.push({ step: `Step ${stepNum}: ${stepText}`, result: resultDetails, passed });
            cumulativeActions.push(...stepActions);

            if (!passed && !testCaseFailed) {
                testCaseFailed = true;
                testCaseFailureReason = `Step ${stepNum} failed: ${resultDetails.split('\n')[0].slice(0, 200)}`;
                console.log(`  ⏭ Short-circuiting test case — Step ${stepNum} failed. Remaining steps marked unreached.`);
                // Fill remaining steps as "not reached" so the report is complete.
                for (let j = stepIdx + 1; j < tc.steps.length; j++) {
                    stepResults.push({
                        step: `Step ${j + 1}: ${tc.steps[j]}`,
                        result: `⚠ Step not reached — execution stopped after Step ${stepNum} failed.`,
                        passed: false,
                    });
                }
                break;
            }
        }

        // Verdict
        const verdict: 'PASS' | 'FAIL' = testCaseFailed ? 'FAIL' : 'PASS';
        const actualResult = testCaseFailed
            ? testCaseFailureReason
            : `All ${tc.steps.length} step(s) executed successfully via per-step orchestration. (Note: this confirms each step's browser action ran without runtime errors. Expected Result verification is the test plan author's responsibility — review the per-step actions to confirm the test plan was actually satisfied.)`;

        // Stop video recording (best-effort; tool may not exist on every MCP build).
        if (videoStopTool) {
            try {
                const stopRes = await client.callTool({ name: videoStopTool, arguments: {} });
                const stopText = (stopRes.content as any)?.[0]?.text || '';
                const videoMatch = stopText.match(/Video saved:\s*(.+)/);
                if (videoMatch) videoFile = videoMatch[1].trim();
            } catch { /* ignore */ }
        }

        const tcResult: TestCaseResult = {
            id: tc.id,
            name: tc.name,
            jiraKey: tc.jiraKey,
            priority: tc.priority,
            status: verdict,
            steps: stepResults,
            expectedResult: tc.expectedResult,
            actualResult,
            duration: Date.now() - tcStart,
            videoFile,
            testData: tc.testData,
        };
        results.push(tcResult);
        addPartialResult(tcResult);

        console.log(`✅ TC-${tc.id} per-step run done: ${verdict} (${stepResults.length} steps, ${stepResults.filter(s => s.passed).length} passed)`);
    }

    // Close MCP client.
    try { await client.close?.(); } catch { /* ignore */ }

    const summary = {
        total: results.length,
        passed: results.filter(r => r.status === 'PASS').length,
        failed: results.filter(r => r.status === 'FAIL').length,
        errors: results.filter(r => r.status === 'ERROR').length,
        skipped: results.filter(r => r.status === 'SKIPPED').length,
        duration: Date.now() - startTime,
        executedAt: new Date().toISOString(),
    };
    return { summary, results };
}

export interface ParallelProgress {
    workerId: number;
    currentCase: string;
    currentCaseId?: string;
    currentCaseName?: string;
    progress: number;
    total: number;
    action?: string;
}

export async function runAgentParallel(
    testCasesMarkdown: string,
    llmConfig: any,
    concurrency: number,
    onProgress?: (status: ParallelProgress) => void,
    options?: { autoHeal?: boolean; headed?: boolean }
): Promise<ExecutionReport> {
    const allCases = parseTestCases(testCasesMarkdown);
    const N = Math.max(1, Math.min(concurrency, allCases.length));
    console.log(`\n🚀 PARALLEL EXECUTION: ${N} workers for ${allCases.length} test cases\n`);

    if (N === 1) {
        // Trivial case — defer to the sequential runner with no changes
        return runAgent(testCasesMarkdown, llmConfig, (s) => {
            onProgress?.({ workerId: 1, ...s });
        }, options);
    }

    // Round-robin partition: worker i gets cases [i, i+N, i+2N, ...]
    const buckets: any[][] = Array.from({ length: N }, () => []);
    allCases.forEach((tc, idx) => buckets[idx % N].push(tc));

    // Launch N workers concurrently. Each one calls runAgent on its bucket.
    // The progress callback gets tagged with the worker id so the UI can
    // attribute updates to the right slot.
    const reports = await Promise.all(
        buckets.map((bucket, workerIdx) => {
            const workerId = workerIdx + 1;
            const perWorkerProgress = onProgress
                ? (s: { currentCase: string; progress: number; total: number; action?: string; currentCaseId?: string; currentCaseName?: string }) =>
                    onProgress({ workerId, ...s })
                : undefined;
            return runAgent(bucket, llmConfig, perWorkerProgress, options).catch((err) => {
                console.error(`❌ Worker ${workerId} crashed:`, err.message);
                // Return an empty report so the merge still works
                return {
                    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, duration: 0, executedAt: new Date().toISOString() },
                    results: [],
                } as ExecutionReport;
            });
        })
    );

    // Merge: concatenate per-worker results, sort by test-case id so the
    // report reads top-to-bottom in plan order, NOT completion order.
    const mergedResults: TestCaseResult[] = reports
        .flatMap((r) => r.results)
        .sort((a, b) => a.id - b.id);

    const summary = {
        total: mergedResults.length,
        passed: mergedResults.filter((r) => r.status === 'PASS').length,
        failed: mergedResults.filter((r) => r.status === 'FAIL').length,
        errors: mergedResults.filter((r) => r.status === 'ERROR').length,
        skipped: mergedResults.filter((r) => r.status === 'SKIPPED').length,
        // Duration in parallel is the longest worker's time (wall-clock),
        // not the sum. Use max of per-worker summary durations.
        duration: reports.reduce((max, r) => Math.max(max, r.summary.duration), 0),
        executedAt: new Date().toISOString(),
    };

    console.log(`\n🏁 PARALLEL EXECUTION COMPLETE: ${summary.passed}/${summary.total} passed in ${(summary.duration / 1000).toFixed(1)}s (wall-clock)\n`);

    return { summary, results: mergedResults };
}
