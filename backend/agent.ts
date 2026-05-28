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
    const MAX_AGENT_TURNS = Number(process.env.MAX_AGENT_TURNS) || 12;
    const MAX_HEAL_TURNS = Number(process.env.MAX_HEAL_TURNS) || 3;
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

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
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

            const systemPrompt = `You are a QA test automation expert executing browser tests with Playwright tools.

## MANDATORY EXECUTION PROTOCOL (Follow in exact order)

### STEP 1 - ALIGN WITH TEST STEPS
You MUST call playwright_mark_step(stepIndex=X, stepDescription="<exact text from Test Steps>") at the beginning of each logical test step. 
Do NOT call playwright_mark_step for every individual action. Only call it when you transition to a new step defined in the "Test Steps" list.
For example, if Test Step 1 is "Login to Application", call playwright_mark_step(1, "Login to Application") and then perform the navigation, filling, and clicking needed to log in.

### STEP 2 - NAVIGATE
Always navigate to the URL provided in the preconditions first.

### STEP 3 - DISCOVER & EXECUTE
For each action within a step:
1. Call playwright_get_input_fields to see what's on the page.
2. Perform actions (fill, click, etc.).
3. IMPORTANT: If an action (like a click) doesn't seem to navigate or change the page, check for validation tooltips on ALL input fields using:
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

### STEP 7 - RETURN VERDICT
When ALL steps are done, return ONLY this JSON on the last line:
{"verdict": "PASS", "actualResult": "Describe what happened"}
or
{"verdict": "FAIL", "actualResult": "Describe what failed and why"}

## AVAILABLE TOOLS
${toolDocs}`;

            const userPrompt = `TEST: ${tc.name}

URL: ${urlFromPreconditions || 'ERROR: No URL provided!'}

Test Data: ${tc.testData || `Email=${uniqueEmail}`}

Test Steps:
${tc.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}

Expected Result: ${tc.expectedResult}

EXECUTION WORKFLOW:
1. Call ${navigateTool}(url="${urlFromPreconditions || ''}") → navigate to the page
2. Call playwright_get_input_fields() → discover all input selectors on the page  
3. Call playwright_fill(selector=<discovered_selector>, value=<test_data_value>) → fill each input
4. Call playwright_click(selector=<discovered_selector>) → click buttons/links
5. Call playwright_get_visible_text() → verify the result
6. Repeat steps 3-5 for each test step until ALL steps are complete
7. Return final verdict JSON: {"verdict": "PASS" or "FAIL", "actualResult": "<description>"}

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

                    // If verdict is found, stop immediately
                    if (isVerdict && toolCallsExecuted) {
                        console.log(`  ✅ Verdict detected in response: ${finalContent.match(/(PASS|FAIL)/i)?.[0] || 'unknown'}`);
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

                    // Partial execution - ask agent to continue
                    if (toolCallsExecuted && !isVerdict && totalActionsExecuted > 0) {
                        console.log(`⚠️ Test in progress. ${totalActionsExecuted} actions executed but no verdict yet. Prompting to continue...`);
                        messages.push({
                            role: "assistant",
                            content: `CONTINUE: You have executed ${totalActionsExecuted} browser actions so far. Keep executing remaining test steps. When ALL steps are done, return your final verdict in JSON format: {"verdict": "PASS", "actualResult": "..."}`
                        });
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
            if (!stoppedDuringThisCase) {
                const uiActionsRan = uiActionLog.length > 0;
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
                        ? `All ${uiActionLog.length} UI actions completed successfully.`
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
                    ? `All ${uiActionLog.length} UI steps completed successfully.`
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
                
                // Heuristic 1: Look for explicit markers from playwright_mark_step
                const stepActions = uiActionLog.filter(a => 
                    a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum
                );
                
                // Find all actions that happened AFTER this mark_step and BEFORE the next mark_step
                let relevantActions: any[] = [];
                const currentMarkIdx = uiActionLog.findIndex(a => a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum);
                const nextMarkIdx = uiActionLog.findIndex(a => a.tool === 'playwright_mark_step' && a.args?.stepIndex === stepNum + 1);
                
                if (currentMarkIdx !== -1) {
                    relevantActions = uiActionLog.slice(currentMarkIdx + 1, nextMarkIdx !== -1 ? nextMarkIdx : uiActionLog.length);
                    // Special case: If this is Step 1, also include any actions that happened BEFORE the first mark
                    if (stepNum === 1) {
                        const preActions = uiActionLog.slice(0, currentMarkIdx);
                        relevantActions = [...preActions, ...relevantActions];
                    }
                } else {
                    // Fallback to old heuristic if no mark_step was called
                    const startIdx = idx * actionsPerStep;
                    const endIdx = idx === totalSteps - 1 ? uiActionLog.length : (idx + 1) * actionsPerStep;
                    relevantActions = uiActionLog.slice(startIdx, endIdx);
                }

                let stepPassed = true;
                let stepResultDetails = "";

                if (relevantActions.length > 0) {
                    stepPassed = relevantActions.every(a => a.success);
                    stepResultDetails = relevantActions
                        .filter(a => a.tool !== 'playwright_mark_step')
                        .map(a => `${a.success ? '✅' : '❌'} ${describeUIAction(a)}`)
                        .join('\n');
                } else if (verdict === "PASS") {
                    stepResultDetails = "Step completed successfully";
                    stepPassed = true;
                } else if (idx === 0 && !toolCallsExecuted) {
                    stepResultDetails = "No browser actions were performed.";
                    stepPassed = false;
                } else {
                    stepResultDetails = "Step not reached or failed during execution";
                    // At this branch verdict is FAIL/SKIPPED/null (PASS was handled above)
                    stepPassed = false;
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

            // If there are UI actions that didn't fit (cleanup actions etc), add them to the last step or a separate log
            if (uiActionLog.length > totalSteps * actionsPerStep) {
                const leftoverActions = uiActionLog.slice(totalSteps * actionsPerStep);
                const lastStep = stepResults[stepResults.length - 1];
                if (lastStep) {
                    lastStep.result += '\n' + leftoverActions.map(a => `${a.success ? '✅' : '❌'} ${describeUIAction(a)}`).join('\n');
                }
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

                    const healPrompt = `The previous test case FAILED. Here are the failure details:

Test Case: ${tc.name}
Steps: ${tc.steps.join(', ')}
Expected Result: ${tc.expectedResult}
Actual Result (failure): ${actualResult}
Error Details: ${stepResults.filter(s => !s.passed).map(s => s.result).join('\n')}

Current Page Snapshot (Truncated):
${pageSnapshot}

### HEALING STRATEGIES (Priority Order):
1. **TEXT SEARCH**: If the CSS selector (id, class) failed, search for elements containing the visible text.
2. **VALIDATION CORRECTION**: If the failure was due to a validation message (e.g., "Password required"), try to fill the requested field to satisfy the application and progress.
3. **ARIA ROLES**: Use [aria-label="..."] or role="button" selectors.
4. **PAGE EXPLORATION**: Call playwright_get_visible_text() again to see current state.
5. **NAVIGATION RECOVERY**: If on the wrong page, navigate back to the starting URL.

INSTRUCTIONS: Re-execute ALL steps of this test case from scratch. Correct the broken action that caused the previous failure.
After completing all steps, you MUST output this JSON on the last line: {"verdict": "PASS" or "FAIL", "actualResult": "description of healing success/failure"}`;

                    const healMessages: any[] = [
                        { role: 'system', content: 'You are a test automation healing agent. Re-execute the failed test with corrected selectors and actions.' },
                        { role: 'user', content: healPrompt }
                    ];

                    let healVerdict: 'PASS' | 'FAIL' = 'FAIL';
                    let healActualResult = '';

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
                                } else {
                                    const res = await client!.callTool({ name: toolName, arguments: args });
                                    healMessages.push({ role: 'tool', tool_call_id: tc2.id, content: trimToolText(JSON.stringify(res.content)) });
                                }
                            } catch (e: any) {
                                console.error(`  🧬 HEAL Tool Error: ${e.message}`);
                                healMessages.push({ role: 'tool', tool_call_id: tc2.id, content: `Error: ${e.message}` });
                            }
                        }
                    }

                    if (healVerdict === 'PASS') {
                        console.log(`🩹 AUTO-HEAL SUCCESS: Test case healed on retry!`);
                        // Update the result
                        const healedResult = results[results.length - 1];
                        healedResult.status = 'PASS';
                        healedResult.actualResult = `🩹 Healed on retry: ${healActualResult || 'Test passed after auto-healing'}`;
                        healedResult.error = undefined;
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
