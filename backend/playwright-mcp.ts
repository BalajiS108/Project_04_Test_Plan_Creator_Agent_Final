import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";

const server = new Server(
    {
        name: "playwright-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

const videosDir = path.join(process.cwd(), "videos");
if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
}

// MCP_HEADLESS env var controls visibility: '1' = headless, anything else = headed (default).
// Set by agent.ts when spawning this child process so the UI toggle reaches us.
const MCP_HEADLESS = process.env.MCP_HEADLESS === '1';

async function ensureBrowser() {
    if (!browser) {
        browser = await chromium.launch({
            headless: MCP_HEADLESS,
            args: MCP_HEADLESS ? [] : ['--start-maximized']
        });
    }
    if (!context || !page) {
        context = await browser.newContext({
            viewport: null, // Use full monitor resolution
        });
        page = await context.newPage();
    }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "playwright_start_recording",
                description: "Start a new browser session with video recording enabled. Call this before executing a test case. Closes any existing session first.",
                inputSchema: {
                    type: "object",
                    properties: {
                        testCaseId: { type: "number", description: "ID of the test case, used for naming the video file" },
                        testCaseName: { type: "string", description: "Name of the test case for the video filename" },
                    },
                    required: ["testCaseId"],
                },
            },
            {
                name: "playwright_stop_recording",
                description: "Stop recording and close the current browser context. Returns the path to the recorded video file.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "playwright_navigate",
                description: "Navigate to a URL. Returns the page title after navigation.",
                inputSchema: {
                    type: "object",
                    properties: { url: { type: "string" } },
                    required: ["url"],
                },
            },
            {
                name: "playwright_click",
                description: "Click an element. Supports CSS selectors or Playwright text selectors like 'text=Submit'. If the element is inside an iframe, set iframe to a selector matching the iframe element.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector or Playwright selector like text=Click Me" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe containing the target element" },
                        force: { type: "boolean", description: "Force the click even if the element is not visible (use as last resort)" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "playwright_fill",
                description: "Clear and fill a text input field. For reactive forms that need keystroke events, use playwright_type instead.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string" },
                        value: { type: "string" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe containing the target element" },
                    },
                    required: ["selector", "value"],
                },
            },
            {
                name: "playwright_type",
                description: "Type text into an element keystroke-by-keystroke (simulates real typing). Better for reactive forms, auto-complete fields, and inputs that listen for keydown/keyup events. Clicks the element first, then types.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of the input element" },
                        text: { type: "string", description: "Text to type" },
                        delay: { type: "number", description: "Delay between keystrokes in ms (default: 50)" },
                        clearFirst: { type: "boolean", description: "Whether to clear the field before typing (default: true)" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe containing the target element" },
                    },
                    required: ["selector", "text"],
                },
            },
            {
                name: "playwright_press_key",
                description: "Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown). Useful for submitting forms, navigating dropdowns, or closing popups.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: { type: "string", description: "Key to press, e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown'" },
                        selector: { type: "string", description: "Optional: focus this element first before pressing the key" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["key"],
                },
            },
            {
                name: "playwright_select_option",
                description: "Select an option from a <select> dropdown by value, label, or index.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector for the <select> element" },
                        value: { type: "string", description: "Option value attribute to select" },
                        label: { type: "string", description: "Option visible text to select (alternative to value)" },
                        index: { type: "number", description: "Option index to select (alternative to value/label)" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "playwright_wait_for_selector",
                description: "Wait for an element matching the selector to appear in the DOM. Use this after navigating or clicking to wait for the next page/section to load.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector to wait for" },
                        state: { type: "string", description: "State to wait for: 'visible', 'attached', 'hidden', 'detached' (default: 'visible')" },
                        timeout: { type: "number", description: "Max wait time in ms (default: 15000)" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "playwright_fill_form",
                description: "BATCH fill multiple form fields, check checkboxes, handle reCAPTCHA, and click submit — ALL in one call. Supports field types: 'fill' (default), 'type' (keystroke), 'select' (dropdown), 'check' (checkbox/radio), 'recaptcha' (clicks reCAPTCHA iframe checkbox). For reCAPTCHA, set type='recaptcha' and selector to the reCAPTCHA iframe selector.",
                inputSchema: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "array",
                            description: "Array of fields to fill",
                            items: {
                                type: "object",
                                properties: {
                                    selector: { type: "string", description: "CSS selector for the input/checkbox/iframe" },
                                    value: { type: "string", description: "Value to fill (for check: 'true' to check, for recaptcha: 'true')" },
                                    type: { type: "string", description: "'fill' (default), 'type' (keystroke), 'select' (dropdown), 'check' (checkbox/radio), 'recaptcha' (reCAPTCHA iframe click)" },
                                },
                                required: ["selector", "value"],
                            },
                        },
                        submitSelector: { type: "string", description: "Optional CSS selector or text selector for the submit/continue button to click after filling" },
                        waitBeforeSubmit: { type: "number", description: "Optional ms to wait before clicking submit (default: 500)" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe containing the FORM (not reCAPTCHA)" },
                    },
                    required: ["fields"],
                },
            },
            {
                name: "playwright_check",
                description: "Check or uncheck a checkbox or radio button.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector for the checkbox/radio" },
                        checked: { type: "boolean", description: "true to check, false to uncheck (default: true)" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "playwright_read_text",
                description: "Read text content of an element by CSS selector",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "playwright_screenshot",
                description: "Take a screenshot of the current page. Use this to visually verify the page state.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filename: { type: "string", description: "Filename for the screenshot (without extension)" },
                    },
                },
            },
            {
                name: "playwright_wait",
                description: "Wait for a specified number of milliseconds",
                inputSchema: {
                    type: "object",
                    properties: { ms: { type: "number" } },
                    required: ["ms"],
                },
            },
            {
                name: "playwright_get_html",
                description: "Get the outer HTML of a specific element (or the full page if no selector). Use a selector to get only the relevant section of the page for better readability.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "Optional CSS selector to get HTML of a specific element. If omitted, returns full page HTML." },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                },
            },
            {
                name: "playwright_get_visible_text",
                description: "Get all visible text on the page (or within a specific element). Much cleaner than get_html for understanding page content.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "Optional CSS selector to scope the text extraction" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                },
            },
            {
                name: "playwright_get_input_fields",
                description: "Get all visible input fields, textareas, selects, and buttons on the page with their selectors, types, labels, and current values. Perfect for understanding a form layout before filling it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                },
            },
            {
                name: "playwright_evaluate",
                description: "Execute arbitrary JavaScript in the browser page context. Use for complex interactions that other tools can't handle.",
                inputSchema: {
                    type: "object",
                    properties: {
                        script: { type: "string", description: "JavaScript code to execute. Use 'return' to return a value." },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["script"],
                },
            },
            {
                name: "playwright_smart_fill_page",
                description: "SMART auto-fill: Discovers ALL form fields on the page by their labels, matches them to the provided data, fills text inputs, clicks radio buttons (Yes/No), checks checkboxes, handles reCAPTCHA, and clicks the submit button. All in ONE call. Provide data as key-value pairs where keys loosely match field labels (e.g., 'first name', 'email', 'password').",
                inputSchema: {
                    type: "object",
                    properties: {
                        data: {
                            type: "object",
                            description: "Key-value pairs to fill. Keys should match field labels (case-insensitive, partial match). Examples: {\"first name\": \"John\", \"last name\": \"Doe\", \"email\": \"john@test.com\", \"18 years\": \"Yes\"}",
                            additionalProperties: { type: "string" },
                        },
                        submitText: { type: "string", description: "Text of the submit button to click (e.g., 'Continue', 'Register', 'Submit'). Default: auto-detect." },
                        handleRecaptcha: { type: "boolean", description: "Whether to attempt clicking the reCAPTCHA checkbox (default: true)" },
                    },
                    required: ["data"],
                },
            },
            // Shorthand aliases for common LLM-generated names
            {
                name: "wait_for",
                description: "Wait for an element to be visible. Alias for playwright_wait_for_selector.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector or Playwright selector" },
                        state: { type: "string", enum: ["attached", "detached", "visible", "hidden"], description: "State to wait for" },
                        timeout: { type: "number", description: "Timeout in milliseconds (default: 10000)" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "click",
                description: "Click an element. Alias for playwright_click.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector or Playwright selector" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                        force: { type: "boolean", description: "Force click even if not visible" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "fill",
                description: "Fill a text input. Alias for playwright_fill.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector for input element" },
                        value: { type: "string", description: "Text to fill" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector", "value"],
                },
            },
            {
                name: "navigate",
                description: "Navigate to a URL. Alias for playwright_navigate.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "URL to navigate to" },
                    },
                    required: ["url"],
                },
            },
            {
                name: "type",
                description: "Type text into an element. Alias for playwright_type.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector" },
                        text: { type: "string", description: "Text to type" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector", "text"],
                },
            },
            {
                name: "wait",
                description: "Wait for a duration or condition. Alias for playwright_wait.",
                inputSchema: {
                    type: "object",
                    properties: {
                        text: { type: "string", description: "Text to wait for" },
                        textGone: { type: "string", description: "Text to wait to disappear" },
                        time: { type: "number", description: "Time to wait in seconds" },
                    },
                },
            },
            {
                name: "check",
                description: "Check a checkbox. Alias for playwright_check.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector for checkbox" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector"],
                },
            },
            {
                name: "select",
                description: "Select an option from a dropdown. Alias for playwright_select_option.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector for select element" },
                        values: { type: "array", items: { type: "string" }, description: "Value(s) to select" },
                        iframe: { type: "string", description: "Optional CSS selector for an iframe" },
                    },
                    required: ["selector", "values"],
                },
            },
            {
                name: "screenshot",
                description: "Take a screenshot. Alias for playwright_screenshot.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filename: { type: "string", description: "Filename for the screenshot" },
                        fullPage: { type: "boolean", description: "Screenshot full page or just viewport" },
                    },
                },
            },
        ],
    };
});

// Helper: resolve the target frame (main page or iframe)
async function getTargetFrame(iframeSelector?: string): Promise<Page | import("playwright").Frame> {
    await ensureBrowser();
    if (!page) throw new Error("No page available");
    if (iframeSelector) {
        const frameElement = await page.waitForSelector(iframeSelector, { timeout: 10000 });
        if (!frameElement) throw new Error(`Iframe not found: ${iframeSelector}`);
        const frame = await frameElement.contentFrame();
        if (!frame) throw new Error(`Could not access iframe content: ${iframeSelector}`);
        return frame;
    }
    return page;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let name = request.params.name;
    // Safely handle null/undefined arguments (LLM sometimes passes null for no-arg tools)
    const args = (request.params.arguments && typeof request.params.arguments === 'object') 
        ? request.params.arguments 
        : {};

    // Map shorthand alias names to actual playwright_ tool names
    const aliasMap: Record<string, string> = {
        "navigate": "playwright_navigate",
        "click": "playwright_click",
        "fill": "playwright_fill",
        "type": "playwright_type",
        "wait_for": "playwright_wait_for_selector",
        "wait": "playwright_wait",
        "check": "playwright_check",
        "select": "playwright_select_option",
        "screenshot": "playwright_screenshot",
        "press_key": "playwright_press_key",
    };

    // Resolve alias to actual tool name
    if (aliasMap[name]) {
        name = aliasMap[name];
    }

    // Helper to highlight elements for easier visual debugging in headed mode
    async function highlightElement(target: Page | Frame, selector: string) {
        try {
            await target.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el instanceof HTMLElement) {
                    const originalStyle = el.style.cssText;
                    el.style.backgroundColor = '#ffff00'; // Bright yellow
                    el.style.border = '3px solid #ff0000'; // Bright red
                    el.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.7)';
                    el.style.zIndex = '9999999';
                    setTimeout(() => {
                        el.style.cssText = originalStyle;
                    }, 400);
                }
            }, selector);
            await new Promise(r => setTimeout(r, 200)); // Short pause for visual impact
        } catch (e) {
            // Ignore highlight errors (e.g. element not found yet, which is fine as fill/click will wait)
        }
    }

    try {
        switch (name) {
            case "playwright_start_recording": {
                // Close any existing context
                if (page) {
                    try { await page.close(); } catch { }
                    page = null;
                }
                if (context) {
                    try { await context.close(); } catch { }
                    context = null;
                }

                if (!browser) {
                    browser = await chromium.launch({
                        headless: MCP_HEADLESS,
                        args: MCP_HEADLESS ? [] : ['--start-maximized']
                    });
                }

                // Normal context, no video recording for speed
                const tcId = (args.testCaseId as number) || 0;
                context = await browser.newContext({
                    viewport: null, // Use full monitor resolution
                });

                page = await context.newPage();
                return { content: [{ type: "text", text: `Browser session ready for test case ${tcId}. Executing in HEADED mode (maximized).` }] };
            }

            case "playwright_stop_recording": {
                let videoPath = "";

                if (page) {
                    // Get the video path before closing
                    const video = page.video();
                    if (video) {
                        videoPath = await video.path();
                    }
                    await page.close();
                    page = null;
                }

                if (context) {
                    await context.close();
                    context = null;
                }

                return {
                    content: [{
                        type: "text",
                        text: "Execution step complete. Resources cleared."
                    }]
                };
            }

            case "playwright_navigate": {
                await ensureBrowser();
                if (!page) throw new Error("No page available");
                await page.goto(args.url as string, { waitUntil: 'load', timeout: 30000 });
                try {
                    // Try to wait for network to settle, but don't fail if it takes too long
                    await page.waitForLoadState('networkidle', { timeout: 5000 });
                } catch (e) {}
                const title = await page.title();
                return { content: [{ type: "text", text: `Navigated to ${args.url}. Page title: "${title}"` }] };
            }

            case "playwright_click": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                await target.waitForSelector(args.selector as string, { state: 'visible', timeout: 15000 });
                await highlightElement(target, args.selector as string);
                const opts: any = { timeout: 15000 };
                if (args.force) opts.force = true;
                await target.click(args.selector as string, opts);
                return { content: [{ type: "text", text: `Successfully clicked on "${args.selector}"` }] };
            }

            case "playwright_fill": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                await target.waitForSelector(args.selector as string, { state: 'visible', timeout: 15000 });
                await highlightElement(target, args.selector as string);
                await target.fill(args.selector as string, args.value as string, { timeout: 15000 });
                return { content: [{ type: "text", text: `Successfully filled "${args.selector}" with "${args.value}"` }] };
            }

            case "playwright_fill_form": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const fields = (args.fields || []) as { selector: string; value: string; type?: string }[];
                const results: string[] = [];

                for (const field of fields) {
                    try {
                        const method = field.type || "fill";
                        if (method === "check") {
                            // Handle checkbox/radio
                            if (field.value === "false" || field.value === "uncheck") {
                                await target.uncheck(field.selector, { timeout: 10000, force: true });
                                results.push(`✓ Unchecked ${field.selector}`);
                            } else {
                                await target.check(field.selector, { timeout: 10000, force: true });
                                results.push(`✓ Checked ${field.selector}`);
                            }
                        } else if (method === "recaptcha") {
                            // Handle reCAPTCHA iframe
                            if (!page) throw new Error("No page");
                            try {
                                const recaptchaFrame = page.frameLocator(field.selector);
                                await recaptchaFrame.locator('#recaptcha-anchor').click({ timeout: 10000 });
                                results.push(`✓ Clicked reCAPTCHA checkbox in ${field.selector}`);
                                // Wait for reCAPTCHA to process
                                await page.waitForTimeout(2000);
                            } catch (recErr: any) {
                                // Fallback: try finding the iframe element and clicking inside
                                try {
                                    const frameEl = await page.waitForSelector(field.selector, { timeout: 5000 });
                                    const frame = await frameEl?.contentFrame();
                                    if (frame) {
                                        await frame.click('.recaptcha-checkbox-border, #recaptcha-anchor', { timeout: 5000 });
                                        results.push(`✓ Clicked reCAPTCHA via contentFrame`);
                                        await page.waitForTimeout(2000);
                                    } else {
                                        results.push(`✗ reCAPTCHA: could not access frame: ${recErr.message}`);
                                    }
                                } catch (e2: any) {
                                    results.push(`✗ reCAPTCHA failed: ${e2.message}`);
                                }
                            }
                        } else if (method === "select") {
                            await target.selectOption(field.selector, { label: field.value }, { timeout: 10000 });
                            results.push(`✓ Selected "${field.value}" in ${field.selector}`);
                        } else if (method === "type") {
                            await target.click(field.selector, { timeout: 10000 });
                            await target.type(field.selector, field.value, { delay: 10 });
                            results.push(`✓ Typed "${field.value}" in ${field.selector}`);
                        } else {
                            await target.fill(field.selector, field.value, { timeout: 10000 });
                            results.push(`✓ Filled "${field.value}" in ${field.selector}`);
                        }
                    } catch (e: any) {
                        results.push(`✗ Failed ${field.selector}: ${e.message}`);
                    }
                }

                // Wait before submit
                const waitMs = (args.waitBeforeSubmit as number) || 500;
                if (page) await page.waitForTimeout(waitMs);

                // Click submit button if provided
                if (args.submitSelector) {
                    try {
                        await target.click(args.submitSelector as string, { timeout: 10000 });
                        if (page) await page.waitForTimeout(1500);
                        results.push(`✓ Clicked submit: ${args.submitSelector}`);
                    } catch (e: any) {
                        results.push(`✗ Failed to click submit: ${e.message}`);
                    }
                }

                return { content: [{ type: "text", text: results.join('\n') }] };
            }

            case "playwright_check": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const checked = args.checked !== false;
                if (checked) {
                    await target.check(args.selector as string, { timeout: 15000, force: true });
                } else {
                    await target.uncheck(args.selector as string, { timeout: 15000, force: true });
                }
                return { content: [{ type: "text", text: `${checked ? 'Checked' : 'Unchecked'} "${args.selector}"` }] };
            }

            case "playwright_type": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const delay = (args.delay as number) || 10;
                const clearFirst = args.clearFirst !== false; // default true

                // Click the element first to focus it
                await target.click(args.selector as string, { timeout: 15000 });

                if (clearFirst) {
                    // Select all existing text and delete it
                    await target.press(args.selector as string, "Control+a");
                    await target.press(args.selector as string, "Backspace");
                }

                // Type keystroke by keystroke
                await target.type(args.selector as string, args.text as string, { delay });
                return { content: [{ type: "text", text: `Successfully typed "${args.text}" into "${args.selector}"` }] };
            }

            case "playwright_press_key": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                if (args.selector) {
                    await target.press(args.selector as string, args.key as string, { timeout: 15000 });
                } else {
                    await (target as Page).keyboard.press(args.key as string);
                }
                await page?.waitForTimeout(300);
                return { content: [{ type: "text", text: `Pressed key "${args.key}"${args.selector ? ` on "${args.selector}"` : ''}` }] };
            }

            case "playwright_select_option": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const selectArgs: any = {};
                if (args.value !== undefined) selectArgs.value = args.value as string;
                else if (args.label !== undefined) selectArgs.label = args.label as string;
                else if (args.index !== undefined) selectArgs.index = args.index as number;
                await target.selectOption(args.selector as string, selectArgs, { timeout: 15000 });
                return { content: [{ type: "text", text: `Selected option in "${args.selector}"` }] };
            }

            case "playwright_wait_for_selector": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const state = (args.state as string) || "visible";
                const timeout = (args.timeout as number) || 15000;
                await target.waitForSelector(args.selector as string, { state: state as any, timeout });
                return { content: [{ type: "text", text: `Element "${args.selector}" is now ${state}` }] };
            }

            case "playwright_read_text": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const text = await target.textContent(args.selector as string, { timeout: 15000 });
                return { content: [{ type: "text", text: text || "" }] };
            }

            case "playwright_get_html": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                let html: string;
                if (args.selector) {
                    const el = await target.waitForSelector(args.selector as string, { timeout: 10000 });
                    html = el ? await el.evaluate(e => e.outerHTML) : "Element not found";
                } else {
                    html = await (target as Page).content?.() || await target.evaluate(() => document.documentElement.outerHTML);
                }
                return { content: [{ type: "text", text: html.slice(0, 50000) }] };
            }

            case "playwright_get_visible_text": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                let visibleText: string;
                if (args.selector) {
                    visibleText = await target.$eval(args.selector as string, el => (el as HTMLElement).innerText || el.textContent || "");
                } else {
                    visibleText = await target.evaluate(() => document.body.innerText);
                }
                return { content: [{ type: "text", text: visibleText.slice(0, 20000) }] };
            }

            case "playwright_get_input_fields": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const fields = await target.evaluate(() => {
                    const results: any[] = [];
                    // Inputs and textareas
                    document.querySelectorAll('input, textarea, select, button, [role="button"]').forEach((el, idx) => {
                        const htmlEl = el as HTMLElement;
                        if (htmlEl.offsetParent === null && htmlEl.getAttribute('type') !== 'hidden') return; // skip hidden

                        const tag = el.tagName.toLowerCase();
                        const type = el.getAttribute('type') || tag;
                        const name = el.getAttribute('name') || '';
                        const id = el.getAttribute('id') || '';
                        const placeholder = el.getAttribute('placeholder') || '';
                        const ariaLabel = el.getAttribute('aria-label') || '';
                        const value = (el as HTMLInputElement).value || '';
                        const text = tag === 'button' || el.getAttribute('role') === 'button' ? htmlEl.innerText.trim() : '';

                        // Find associated label
                        let label = '';
                        if (id) {
                            const labelEl = document.querySelector(`label[for="${id}"]`);
                            if (labelEl) label = (labelEl as HTMLElement).innerText.trim();
                        }
                        if (!label) {
                            const parent = el.closest('label');
                            if (parent) label = (parent as HTMLElement).innerText.trim();
                        }

                        // Build a good selector
                        let selector = '';
                        if (id) selector = `#${id}`;
                        else if (name) selector = `${tag}[name="${name}"]`;
                        else if (placeholder) selector = `${tag}[placeholder="${placeholder}"]`;
                        else if (ariaLabel) selector = `${tag}[aria-label="${ariaLabel}"]`;
                        else selector = `${tag}:nth-of-type(${idx + 1})`;

                        results.push({ tag, type, name, id, placeholder, ariaLabel, label, value, text, selector });
                    });
                    return results;
                });

                const summary = fields.map((f: any) => {
                    const parts = [`[${f.type}]`, f.selector];
                    if (f.label) parts.push(`label="${f.label}"`);
                    if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
                    if (f.text) parts.push(`text="${f.text}"`);
                    if (f.value) parts.push(`value="${f.value}"`);
                    return parts.join(' | ');
                }).join('\n');

                return { content: [{ type: "text", text: `Found ${fields.length} interactive elements:\n${summary}` }] };
            }

            case "playwright_evaluate": {
                const target = await getTargetFrame(args.iframe as string | undefined);
                const result = await target.evaluate((script: string) => {
                    return new Function(script)();
                }, args.script as string);
                return { content: [{ type: "text", text: result !== undefined ? JSON.stringify(result) : "Executed successfully (no return value)" }] };
            }

            case "playwright_screenshot": {
                await ensureBrowser();
                if (!page) throw new Error("No page available");
                const fname = (args.filename as string) || `screenshot_${Date.now()}`;
                const screenshotPath = path.join(videosDir, `${fname}.png`);
                await page.screenshot({ path: screenshotPath, fullPage: true });
                return { content: [{ type: "text", text: `Screenshot saved: ${fname}.png` }] };
            }

            case "playwright_smart_fill_page": {
                const target = await getTargetFrame(undefined);
                const dataToFill = (args.data || {}) as Record<string, string>;
                const handleRecaptcha = args.handleRecaptcha !== false;
                const submitText = args.submitText as string | undefined;
                const results: string[] = [];

                // Wait briefly for network activity to settle
                if (page) await page.waitForTimeout(2000);

                // Find ALL inputs piercing shadow DOM natively via Playwright
                const locators = target.locator('input:not([type="hidden"]), select, textarea');
                const count = await locators.count();

                const fields: { locator: any; type: string; label: string; id: string }[] = [];
                for (let i = 0; i < count; i++) {
                    const loc = locators.nth(i);
                    // Ensure visible
                    if (!(await loc.isVisible().catch(() => false))) continue;

                    const tagName = await loc.evaluate(e => e.tagName.toLowerCase());
                    const type = await loc.getAttribute('type') || tagName;
                    const id = await loc.getAttribute('id') || '';
                    let label = await loc.getAttribute('aria-label') || await loc.getAttribute('placeholder') || '';

                    if (!label && id) {
                        try {
                            const lblEl = target.locator(`label[for="${id}"]`);
                            if (await lblEl.count() > 0 && await lblEl.first().isVisible()) {
                                label = await lblEl.first().innerText();
                            }
                        } catch { }
                    }
                    if (!label) {
                        try {
                            const parentLbl = loc.locator('xpath=ancestor::label');
                            if (await parentLbl.count() > 0) {
                                label = await parentLbl.first().innerText();
                            }
                        } catch { }
                    }

                    fields.push({ locator: loc, type, label: label.toLowerCase(), id });
                }

                if (fields.length === 0) {
                    results.push(`✗ Found 0 form fields. The page might still be loading or fields are hidden.`);
                } else {
                    results.push(`Found ${fields.length} interactive fields.`);
                }

                // Match data to fields
                const used = new Set();
                for (const [key, val] of Object.entries(dataToFill)) {
                    const searchKey = key.toLowerCase();
                    const match = fields.find(f => !used.has(f.id || f.label) && (f.label.includes(searchKey) || searchKey.includes(f.label)));

                    if (match) {
                        used.add(match.id || match.label);
                        try {
                            if (match.type === 'checkbox' || match.type === 'radio') {
                                if (val.toLowerCase() === 'true' || val.toLowerCase() === 'yes') {
                                    await match.locator.check({ force: true, timeout: 5000 });
                                    results.push(`✓ Checked field: ${match.label}`);
                                }
                            } else if (match.type === 'select') {
                                await match.locator.selectOption({ label: val }, { timeout: 5000 });
                                results.push(`✓ Selected: ${val} in ${match.label}`);
                            } else {
                                await match.locator.click({ timeout: 5000 }).catch(() => { });
                                await match.locator.fill(val, { timeout: 5000 });
                                results.push(`✓ Filled: ${val} in ${match.label}`);
                            }
                        } catch (e: any) {
                            results.push(`✗ Failed: ${match.label} - ${e.message}`);
                        }
                    } else {
                        results.push(`✗ Could not find field matching: ${key}`);
                    }
                }

                // Handle Recaptcha
                if (handleRecaptcha && page) {
                    try {
                        const frames = page.frames();
                        const recaptchaFrame = frames.find(f => f.url().includes('recaptcha/api2/anchor'));
                        if (recaptchaFrame) {
                            await recaptchaFrame.click('.recaptcha-checkbox-border, #recaptcha-anchor', { timeout: 6000 });
                            results.push(`✓ Handled reCAPTCHA`);
                            await page.waitForTimeout(2000);
                        }
                    } catch (e: any) {
                        results.push(`✗ Failed reCAPTCHA: ${e.message}`);
                    }
                }

                if (page) await page.waitForTimeout(1000);

                // Click Submit
                if (submitText) {
                    try {
                        // Playwright text selector is case-insensitive and pierces shadow DOM
                        const btn = target.locator(`text="${submitText}"`);
                        if (await btn.count() > 0) {
                            await btn.first().click({ timeout: 5000 });
                            results.push(`✓ Clicked Submit: ${submitText}`);
                        } else {
                            // Fallback to fuzzy text search
                            const fuzzyBtn = target.locator(`button:has-text("${submitText}")`);
                            if (await fuzzyBtn.count() > 0) {
                                await fuzzyBtn.first().click({ timeout: 5000 });
                                results.push(`✓ Clicked Submit via button text`);
                            } else {
                                results.push(`✗ Could not find submit button: ${submitText}`);
                            }
                        }
                    } catch (e: any) {
                        results.push(`✗ Failed to click submit: ${e.message}`);
                    }
                }

                return { content: [{ type: "text", text: results.join('\n') }] };
            }

            case "playwright_wait": {
                await ensureBrowser();
                if (!page) throw new Error("No page available");
                await page.waitForTimeout(args.ms as number || 1000);
                return { content: [{ type: "text", text: `Waited ${args.ms}ms` }] };
            }

            default:
                return { isError: true, content: [{ type: "text", text: `Tool ${name} not found` }] };
        }
    } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
});

async function closeBrowser() {
    if (page) { try { await page.close(); } catch { } page = null; }
    if (context) { try { await context.close(); } catch { } context = null; }
    if (browser) { try { await browser.close(); } catch { } browser = null; }
}

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // When the parent process (agent.ts) closes the connection (on stop or completion),
    // clean up the browser so it doesn't linger on the user's screen.
    process.stdin.on('end', async () => {
        console.error('[playwright-mcp] Client disconnected. Closing browser...');
        await closeBrowser();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await closeBrowser();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        await closeBrowser();
        process.exit(0);
    });
}

run().catch(console.error);
