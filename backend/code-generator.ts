import { OpenAI } from "openai";

interface TestCase {
    name: string;
    jiraKey?: string;
    preconditions: string;
    steps: string[];
    expectedResult: string;
    priority: string;
}

interface PageInspection {
    url: string;
    title: string;
    visibleText: string;
    elements: Array<{
        text: string;
        type: string;
        selector: string;
        xpath?: string;
    }>;
}

/**
 * Generate Playwright test code for all test cases
 * This approach has the LLM write the actual test code instead of calling tools
 */
export async function generatePlaywrightCode(
    testCases: TestCase[],
    pageInspections: PageInspection | PageInspection[] | null,
    llmConfig: any
): Promise<string> {
    // Normalize to an array — callers may still pass a single inspection.
    const inspections: PageInspection[] = Array.isArray(pageInspections)
        ? pageInspections
        : pageInspections
            ? [pageInspections]
            : [];
    // Get base URL based on provider
    const getBaseURL = (config: any): string => {
        switch (config.provider) {
            case 'Groq':
                return 'https://api.groq.com/openai/v1';
            case 'Ollama':
                return `${(config.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`;
            case 'Gemini':
                return 'https://generativelanguage.googleapis.com/v1beta/openai/';
            case 'OpenAI':
            default:
                return 'https://api.openai.com/v1';
        }
    };

    const openai = new OpenAI({
        apiKey: llmConfig.apiKey || "dummy",
        baseURL: getBaseURL(llmConfig)
    });

    // Extract URL from first test case preconditions
    let targetUrl = "";
    if (testCases.length > 0) {
        const urlMatch = testCases[0].preconditions.match(/(https?:\/\/[^\s]+)/i);
        targetUrl = urlMatch ? urlMatch[1].trim() : "";
    }

    // Build system prompt for code generation
    const systemPrompt = `You are an expert Playwright test code generator. Your job is to write clean, maintainable, EXECUTABLE Playwright code that runs against the real application without manual editing.

==== HARD RULES — DO NOT VIOLATE ====
1. Generate ONLY executable Playwright code — no explanations, no markdown fences, no "TODO" stubs.
2. Start with: import { test, expect, chromium } from '@playwright/test';
3. Use ONLY values that are explicitly present in the test case's Preconditions, Test Data, or Steps. NEVER invent usernames, passwords, URLs, error messages, dashboard paths, or any other literal values.
4. NEVER emit placeholder strings like 'expected_admin_dashboard_url', 'TODO', 'fill_me_in', 'YOUR_USERNAME_HERE', or any "// Replace with actual ..." comment. If a value is required but absent from the test case, mark the test with \`test.skip(true, 'Missing data: <what>')\` — do NOT pretend you have the value.
5. Use the URL from EACH test case's own Preconditions for that test's navigation. Different tests may target different pages. Do NOT reuse the first test's URL for all tests.
6. If a test targets a page that requires authentication, the test MUST perform the login flow first (filling the same login form used by login tests), OR use a beforeEach that logs in. Do NOT goto a protected page without authenticating, the app will redirect to /login and the test will fail.
7. Each test must be self-contained and runnable in isolation — assume no state from prior tests.

==== LOCATOR PRIORITIES (use in this order) ====
1. data-testid / data-test attributes
2. ID attributes: #...
3. name attribute: [name="..."]
4. Role-based: getByRole('button', { name: '...' })
5. Exact text: getByText('exact text', { exact: true })
6. CSS selectors as a fallback
7. XPath only if nothing else works

==== PLAYWRIGHT BEST PRACTICES ====
- Strict mode: If a selector might match multiple elements, use .first() or .filter({ hasText: '...' }).
- Waits: Prefer auto-waiting locators (expect(loc).toBeVisible()) over page.waitForTimeout. Use page.waitForSelector before asserting on dynamic content.
- Navigation: call page.goto(url) WITHOUT waitUntil:'networkidle' — on real sites with analytics/polling, networkidle never settles and goto times out. Use the default, or waitUntil:'domcontentloaded'. After navigating, rely on auto-waiting locators (e.g. await expect(loc).toBeVisible()) instead.
- Screenshots: Use \`const safeTitle = test.info().title.replace(/[^a-z0-9]/gi, '_');\` for safe filenames.
- Logs: console.log key actions to aid debugging.
- Timeouts: Do NOT call test.setTimeout() inside test bodies. The project's playwright.config.ts already provides a 90s per-test budget (which covers beforeEach hooks). A test.setTimeout(60000) inside a test reduces the remaining budget AFTER beforeEach has already consumed time, which causes false timeouts on slow logins. Leave timeouts to the config.

==== GROUNDING DISCIPLINE ====
- Every \`page.fill(selector, value)\` value must come from the test case's Test Data or Steps verbatim.
- Every \`expect(...).toHaveText(value)\` value must come from the test case's Expected Result or the page context provided below — not your training-data guess.
- Every \`page.goto(url)\` URL must come from that test case's Preconditions.
- If the test case's Expected Result is vague ("login succeeds"), assert something concrete that's actually verifiable from the page context (e.g., presence of a known post-login element). If nothing concrete is verifiable, use \`test.skip()\` rather than fake an assertion.

==== EXAMPLES ====
✅ GOOD (uses test data verbatim):
   await page.fill('#user-name', 'standard_user');  // value comes from Test Data
   await page.fill('#password', 'secret_sauce');     // value comes from Test Data

❌ BAD (invented credentials):
   const validUsername = 'valid_user';               // never appeared in test data
   await page.fill('#user-name', validUsername);

✅ GOOD (skip when data missing):
   test('Add to cart', async ({ page }) => {
     test.skip(true, 'Missing data: no valid credentials in any test case to authenticate first');
     // ...
   });

❌ BAD (placeholder string):
   await expect(page).toHaveURL('expected_admin_dashboard_url'); // Replace with actual URL`;

    // Build page context for code generation — one section per inspected page,
    // so the LLM has real DOM context for every distinct URL the test cases reference.
    const pageContext = inspections.length === 0
        ? ""
        : "\n\n==== PAGE CONTEXTS (real DOM, use these — do NOT guess) ====\n" +
          inspections.map((insp, i) => `\n--- Page ${i + 1} ---
URL: ${insp.url}
Page Title: ${insp.title}

Available Elements:
${insp.elements.map((el) => `- ${el.type}: "${el.text}" (selector: ${el.selector})`).join("\n")}

Visible Text on Page (use values that appear here as Test Data when relevant — e.g. credentials printed on the page):
${insp.visibleText.slice(0, 2000)}`).join("\n");

    // Build test cases description
    const testCasesDescription = testCases
        .map(
            (tc, idx) => `
Test ${idx + 1}: ${tc.name}
Priority: ${tc.priority}
Preconditions: ${tc.preconditions}
Steps:
${tc.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}
Expected Result: ${tc.expectedResult}`
        )
        .join("\n---\n");

    const userPrompt = `Generate Playwright test code for the following test cases:
${pageContext}

TEST CASES TO AUTOMATE:
${testCasesDescription}

Generate complete, executable Playwright code that:
1. Navigates to the URL in preconditions
2. Implements each step using appropriate Playwright methods
3. Verifies the expected result
4. Includes proper waits and error handling
5. Is well-commented and easy to understand

Start with imports and generate all test code in one file.`;

    console.log(`\n🤖 Generating Playwright test code using ${llmConfig.model || "gpt-4o"}...`);

    try {
        const response = await openai.chat.completions.create({
            model: llmConfig.model || "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: userPrompt
                }
            ],
            temperature: 0.3,
            max_tokens: 4000
        });

        const generatedCode = response.choices[0].message.content || "";

        // Clean up the response (remove markdown code blocks if present)
        let code = generatedCode;
        if (code.includes("```")) {
            const match = code.match(/```(?:typescript|javascript|playwri ght)?\n?([\s\S]*?)```/);
            if (match) {
                code = match[1].trim();
            }
        }

        // Deterministic sanitization — never trust the LLM to avoid the footguns.
        // `networkidle` almost never fires on real sites (analytics/polling keep
        // the network busy), so page.goto/waitForLoadState time out at 30s on the
        // very first line. Force the reliable 'domcontentloaded' instead.
        code = code
            .replace(/waitUntil:\s*['"]networkidle['"]/g, "waitUntil: 'domcontentloaded'")
            .replace(/waitForLoadState\(\s*['"]networkidle['"]\s*([),])/g, "waitForLoadState('domcontentloaded'$1");

        console.log(`✅ Generated ${code.split("\n").length} lines of Playwright code`);
        return code;
    } catch (err: any) {
        console.error("❌ Code generation failed:", err.message);
        throw new Error(`Failed to generate Playwright code: ${err.message}`);
    }
}

/**
 * Extract page information for code generation
 */
export async function inspectPageForCodeGen(page: any): Promise<PageInspection> {
    try {
        // Get page title
        const title = await page.title();

        // Get all visible text
        const visibleText = await page.evaluate(() => {
            return document.body.innerText;
        });

        // Get interactive elements
        const elements = await page.evaluate(() => {
            const els: Array<{
                text: string;
                type: string;
                selector: string;
            }> = [];

            // Get buttons
            document.querySelectorAll("button, input[type='submit']").forEach((btn: any) => {
                const text = btn.textContent?.trim() || btn.value || btn.getAttribute("aria-label") || "Button";
                els.push({
                    text: text,
                    type: "button",
                    selector: btn.getAttribute("data-test") || btn.getAttribute("data-testid") || btn.getAttribute("id") || `button:has-text("${text}")`
                });
            });

            // Get inputs
            document.querySelectorAll("input:not([type='submit'])").forEach((inp: any) => {
                const label =
                    inp.getAttribute("placeholder") ||
                    inp.getAttribute("aria-label") ||
                    inp.getAttribute("name") ||
                    inp.getAttribute("id") ||
                    "Input";
                els.push({
                    text: label,
                    type: "input",
                    selector: inp.getAttribute("data-test") || inp.getAttribute("data-testid") || inp.getAttribute("id") || `input[name="${inp.getAttribute("name")}"]`
                });
            });

            // Get specific error containers or text
            document.querySelectorAll("[data-test='error'], .error-message, #error").forEach((err: any) => {
                els.push({
                    text: err.textContent?.trim() || "Error message",
                    type: "error",
                    selector: err.getAttribute("data-test") ? `[data-test="${err.getAttribute("data-test")}"]` : (err.getAttribute("id") ? `#${err.getAttribute("id")}` : ".error")
                });
            });

            // Get product/cart items specifically for SauceDemo or similar apps
            document.querySelectorAll(".inventory_item, .cart_item, [data-test='inventory-item']").forEach((item: any) => {
                const name = item.querySelector(".inventory_item_name, .inventory_item_label")?.textContent?.trim() || "Item";
                els.push({
                    text: name,
                    type: "product_item",
                    selector: item.getAttribute("data-test") ? `[data-test="${item.getAttribute("data-test")}"]` : ".cart_item"
                });
            });

            return els;
        });

        return {
            url: page.url(),
            title,
            visibleText,
            elements
        };
    } catch (err: any) {
        console.error("❌ Page inspection failed:", err.message);
        throw new Error(`Failed to inspect page: ${err.message}`);
    }
}

/**
 * Execute generated Playwright code
 */
export async function executePlaywrightCode(code: string): Promise<{
    success: boolean;
    output: string;
    error?: string;
}> {
    try {
        console.log("\n▶️  Executing Playwright test code...");

        // This would typically be executed in a sandbox or separate process
        // For now, we'll return the code for execution
        return {
            success: true,
            output: code
        };
    } catch (err: any) {
        return {
            success: false,
            output: "",
            error: err.message
        };
    }
}
