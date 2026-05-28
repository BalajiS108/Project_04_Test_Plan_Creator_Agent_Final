# Intelligent Test Planning Agent — Project Flow

A non-technical walkthrough of what this tool does, how to use it, and what's coming.

> **TL;DR** — You point this tool at a software requirement (a Jira story, a document, or a web page), tell it what app to test, and it generates test cases, runs them in a real browser, and reports results — all without you writing test code by hand. There are also separate areas for API testing, performance testing (under construction), UI quality checks, and CI/CD integration.

---

## Who is this for?

- **QA engineers** who want test cases generated from requirements automatically and run end-to-end.
- **Project / Test managers** who want push-button test execution and dashboards without scripting.
- **Developers** who want to validate that a feature behaves as the story describes, before code review.

No coding experience is needed to use the UI. The tool writes the test code under the hood.

---

## The 5 modules at a glance

The left sidebar has 5 modules. Each is a separate, focused capability — pick the one matching what you want to test.

| # | Module | What it does | Status |
|---|---|---|---|
| 1 | **Test Case Execution** | Generate UI test cases from requirements and run them in a browser | ✅ Working |
| 2 | **API Testing** | Test REST endpoints with assertions (status code, response body, etc.) | ✅ Working |
| 3 | **Performance Testing** | Load / throughput testing using Apache JMeter | 🚧 Placeholder — wiring coming next |
| 4 | **UI Quality** | Visual regression (screenshot comparison) + Accessibility (WCAG 2.1 AA) scans | ✅ Working |
| 5 | **CI / CD** | Trigger / monitor GitHub Actions runs and see status | ✅ Working |

Plus:
- **⚙️ Settings** (bottom of sidebar) — Jira connections, LLM provider, notifications, light/dark theme.
- **📈 Execution History Trends** (button in the report area) — past runs, pass-rate trend, flakiest tests.

---

## End-to-end typical journey (first time using the tool)

The mainstream use case is **Test Case Execution**. Here's what a first-time user does:

```
   ┌─────────────────────────────────────────────────────────────────┐
   │  1. SETUP                                                       │
   │     - Click Settings → add a Jira connection (URL + token)      │
   │     - Add an LLM provider (OpenAI / Groq / Gemini / Ollama)     │
   │     - Click "Test Case Execution" module in the sidebar         │
   └───────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  2. PICK A REQUIREMENT SOURCE                                   │
   │     One of:                                                     │
   │       (a) Jira story  → tool fetches by project / sprint        │
   │       (b) BRD upload  → tool parses your PDF/DOCX/MD/TXT        │
   │       (c) HTML pages  → paste rendered HTML of pages to test    │
   │       (d) Figma URL   → tool reads the design spec              │
   └───────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  3. REVIEW                                                      │
   │     - See the fetched requirements                              │
   │     - Optionally fill "Application URL" (the app to test)       │
   │     - Add any extra context (e.g. test credentials)             │
   │     - Click Generate                                            │
   └───────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  4. GENERATE + EXECUTE                                          │
   │     - LLM writes a test plan (markdown table with N test cases) │
   │     - Click "Save Script File" to produce a real .spec.ts       │
   │     - Click "Run with Playwright Script Mode" to execute        │
   │     - Watch tests run in real-time (browser opens if "Headed")  │
   │     - See pass/fail per test in the report                      │
   │     - View HTML report, sync results back to Jira, push bugs    │
   └─────────────────────────────────────────────────────────────────┘
```

---

## Module 1: Test Case Execution (the main flow)

### Stage 1 — Setup (Jira Connection)

**What you see:** Step 1 in the sidebar, a list of saved Jira connections.

**What you do:**
- Pick an existing Jira connection, OR
- Click Settings (bottom of sidebar) → **Data Source** tab → **+ Add Connection** → enter Jira URL, your email, and an API token.

**Why it matters:** This is how the tool reads the stories you want test cases for. If you're using a non-Jira source (BRD document, HTML, Figma), you can still pick any connection — it's only used for "Push test cases to Jira" later.

> 💡 **API token vs password:** Atlassian requires an API token (not your login password). Generate one at id.atlassian.com → Security → API tokens.

### Stage 2 — Fetch Issues (Source Selection)

**What you see:** Tabs for **Jira / BRD / HTML / Figma**. Each has its own inputs.

**Each source:**

| Source | Input | When to use |
|---|---|---|
| **Jira** | Project Key (e.g. `KAN`), optional Sprint/Version | When stories already live in Jira |
| **BRD** | A PDF, DOCX, MD, or TXT file (≤25 MB) | When requirements are in a document |
| **HTML** | One or more page URLs + their captured HTML (multi-page UI) | When testing a live web app you can copy outerHTML from |
| **Figma** | File URL + personal access token | When you have a design spec to derive cases from |

**Behind the scenes:** Whatever you pick, the tool normalizes everything into a list of "requirement items" so the rest of the flow doesn't care which source it came from.

> 💡 **Multi-page HTML capture:** Open each page in your browser → press F12 → right-click `<html>` → Copy → Copy outerHTML → paste into a Page card. Click **+ Add another page** to add more.

### Stage 3 — Review & Configure

**What you see:** The fetched requirements, plus three configuration boxes:
1. **Application URL** (optional) — the URL of the app the tests will actually run against (e.g. `https://staging.example.com`). This is **different** from your Jira host.
2. **Additional Context & Notes** — free-form text the LLM uses for grounding (e.g. "Test credentials: alice/Test123!", "Also test: locked-out user, special characters in username").
3. **Output Type** — choose **Test Plan** (the 12-section document) or **Test Cases** (a table of executable cases).

**Why it matters:** Filling these well makes the difference between generic AI output and useful, runnable tests. The Application URL stops the LLM from inventing wrong URLs. Additional Context lets you steer it toward scenarios you actually want covered.

### Stage 4 — Generate & Execute

This stage has **multiple sub-actions** — the toolbar at the top has these buttons:

| Button | What it does |
|---|---|
| **Save Script File** | Asks the LLM to convert your test plan into a real Playwright `.spec.ts` file and save it under `tests/generated/<ProductName>/`. Always produces a fresh generation. |
| **Run with Playwright Script Mode** | Runs the most recent saved script for this product. If none exists yet, generates one first. **Same execution path as Script Library "Run" and terminal** — so results match exactly. |
| **Run with MCP Mode** | Live agent-driven execution: an AI drives a real browser step-by-step using the test plan. Slower but supports Auto-Heal mid-run. |
| **Browser: Headed / Headless** | Headed = you see the browser window open and tests click around. Headless = tests run invisibly (faster). |
| **Auto-Heal** | When ON: if a test fails (e.g. wrong selector), the LLM looks at the actual page DOM at failure, rewrites just that test, and re-runs it. Designed to recover from common LLM mistakes automatically. |
| **Push to Jira** | Creates a Jira issue (Sub-task or Test) for each test case in your plan. |
| **Sync Results to Jira** | After running tests, posts the PASS/FAIL outcome as a comment AND transitions the Jira issue's workflow status (Done on PASS, In Progress on FAIL). |

### Self-Healing — what it actually does

This is one of the most important features. Plain explanation:

1. You run your generated tests.
2. A test fails — say it tried to click `#wrong-button-id` and got a "selector not found" error.
3. **Auto-Heal kicks in** (only if the toggle is ON):
   - Captures the actual HTML of the page at the moment of failure
   - Sends just that failing test + the error + the real DOM to the LLM
   - The LLM rewrites the test using selectors that actually exist on the page
   - The healed test is saved back to the spec file
   - Playwright re-runs just the healed test
4. Final report shows the test as **🩹 Healed** (originally failed, then passed after rewrite).

This dramatically reduces the "LLM wrote slightly wrong selectors" failure class. It does not fix logical bugs in the test plan or genuine app bugs — those still fail honestly.

### Reporting

After execution you see:
- **Summary**: total / passed / failed / skipped / errors / duration
- **Per-test results**: each test case with its status, duration, error message
- **Buttons in the report header**:
  - **📈 Execution History Trends** — opens the trends dashboard
  - **View HTML Report** — Playwright's interactive HTML report (drill-down, screenshots, traces)
  - **Export Excel** — XLSX summary
- **Sync Results to Jira** — push outcomes back to Jira as comments + status transitions

---

## Module 2: API Testing

**What it is:** Test REST endpoints with assertions, similar to Postman but inside this tool.

**What you do:**
- Define a request (method, URL, headers, body)
- Add assertions (status code = 200, response body contains "X", response time < 500ms, etc.)
- Save tests into Suites for re-use
- Or import an OpenAPI / Swagger spec and the tool generates tests for every endpoint

**Why it's separate from Test Case Execution:** UI tests drive a browser. API tests don't need a browser — they just send HTTP requests. Different mechanics, different module.

---

## Module 3: Performance Testing 🚧 *Coming soon*

**What it will be:** Backend load and throughput testing using Apache JMeter.

**Distinct from UI Quality.** Performance Testing is about how many users your backend can handle. UI Quality is about how the rendered page looks and behaves for one user.

**The plan once built:**

```
┌──────────────────────────────────────────────────────────────────┐
│  1. INPUTS                                                       │
│     - Upload a .jmx test plan, OR                                │
│     - Enter a URL + concurrency (e.g. 50 users) + duration       │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  2. EXECUTION                                                    │
│     - Backend spawns:                                            │
│         jmeter -n -t plan.jmx -l result.jtl                      │
│     - Streams progress (requests/sec, errors) to the UI          │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  3. RESULTS                                                      │
│     - Aggregate metrics:                                         │
│         · Average / median / p95 / p99 response time             │
│         · Throughput (requests per second)                       │
│         · Error %                                                │
│     - Per-endpoint breakdown (when plan hits multiple URLs)      │
│     - Download JTL for opening in JMeter GUI                     │
└──────────────────────────────────────────────────────────────────┘
```

**Prerequisite:** Apache JMeter must be installed on the machine running the backend. The backend will detect it on PATH or via the `JMETER_HOME` environment variable.

**Use cases:**
- "Can our login endpoint handle 100 concurrent users?"
- "What's our checkout API's p95 latency under realistic load?"
- "Does error rate spike when concurrent users go from 50 to 100?"

---

## Module 4: UI Quality

**Two checks against any URL:**

### Visual Regression
- Takes a screenshot of a page (the "baseline").
- Next time you run, takes a new screenshot and **pixel-compares** to the baseline.
- Differences highlighted in red.
- Catches accidental visual changes — wrong fonts, missing images, broken layout — that functional tests miss.

### Accessibility (WCAG 2.1 AA)
- Scans the page DOM for accessibility violations:
  - Color contrast issues
  - Missing alt text on images
  - Form inputs without labels
  - Heading hierarchy problems
- Each violation has severity (Critical / Serious / Moderate / Minor) and a fix recommendation.

**Why this module exists:** Functional tests verify the app works. UI Quality verifies the app is *correct* visually and accessible — two different things.

---

## Module 5: CI / CD

**What it is:** A dashboard for GitHub Actions runs of this repository.

**What you can do:**
- See recent workflow runs and their status (success / failed / in progress)
- Manually trigger a workflow run from the UI
- Open run details on GitHub
- Get notified when a run finishes

**Why it's here:** Once you have generated tests that work, you want them to run automatically on every commit / PR. This tab makes the GitHub Actions side visible without leaving the tool.

---

## ⚙️ Settings (bottom of sidebar)

Opens a modal with four tabs:

| Tab | What it manages |
|---|---|
| **Data Source** | Jira connections (URL, email, API token) — supports vanilla Jira and Xray |
| **LLM Brain** | Which LLM the tool talks to: OpenAI, Groq, Gemini, or Ollama (local) — plus the API key |
| **Notifications** | Email / Slack / webhook configuration for "test run completed" alerts |
| **Appearance** | Light or Dark theme toggle |

---

## 📈 Execution History Trends

**Where:** Button in the Execution Report header (visible after you run tests).

**What it shows:**
- **Pass-rate trend chart** — pass % over the last 30 days, with proper X/Y axes
- **Last 30 days statistics** — total runs, pass rate average, failures count
- **Flakiest tests** — tests that have failed intermittently across runs (good candidates for healing or refactoring)
- **Per-run drill-down** — click any historical run to see its full results

Useful for **spotting trends**: "Are we getting more flaky?", "Did the last deploy hurt our pass rate?".

---

## Common workflows / quick scenarios

### Scenario A: "I have a Jira story, I want test cases"
1. Settings → add Jira connection (one-time)
2. Test Case Execution → Stage 1 → pick connection
3. Stage 2 → Jira tab → enter Project Key → Fetch
4. Stage 3 → fill Application URL → Generate
5. Stage 4 → Save Script File → Run with Playwright Script Mode

### Scenario B: "I want to test a public web page (no Jira)"
1. Test Case Execution → Stage 2 → HTML tab
2. Open the page in browser → F12 → Copy `<html>` outerHTML
3. Paste into Page 1 HTML, set Page URL, click + Add another page for more
4. Continue from Stage 3 → Generate → Run

### Scenario C: "I already have a saved test script, just re-run it"
1. Test Case Execution → Stage 4 → toolbar → click **Library** button
2. Find your saved suite (latest 5 shown by default, click "Show more" for older)
3. Expand to see test names + last-run pass/fail per test
4. Click Run on the suite

### Scenario D: "A test failed, can the tool fix it for me?"
1. Make sure **Auto-Heal** is ON (default)
2. Click Run
3. On failure, watch the LIVE badge: it'll say `🩹 Self-healing` while the LLM rewrites the failing test
4. Test re-runs automatically; if it now passes you'll see **🩹 Healed** badge in the report
5. The fixed code is also saved back to the spec file — next run uses the fixed version

### Scenario E: "I want to test a REST API, not a web page"
1. Sidebar → API Testing
2. New Suite → add requests with assertions
3. Run the suite → see pass/fail per request

---

## Glossary (terms you'll see in the UI)

| Term | Meaning |
|---|---|
| **LLM** | Large Language Model — the AI that generates test cases and code. OpenAI, Groq, Gemini, Ollama, etc. |
| **Spec file** (`.spec.ts`) | The actual Playwright test code file the tool generates and runs |
| **MCP** | Model Context Protocol — the protocol the agent uses to drive a live browser via Playwright |
| **Playwright** | The underlying browser-automation framework that actually clicks buttons and verifies results |
| **JMeter** | Apache JMeter — industry-standard tool for load/performance testing (used by upcoming Performance module) |
| **Headed / Headless** | Headed = browser window visible. Headless = invisible. |
| **Auto-Heal** | LLM rewrites failed tests using the actual failure DOM, then re-runs them |
| **Sidecar** | A small companion JSON file saved next to a spec — holds last-run results per test |
| **Healing reporter** | The custom Playwright reporter that captures failure details so the healer can fix them |
| **WCAG 2.1 AA** | Accessibility standard. Level AA is the practical compliance bar most companies aim for |
| **Test Suite** | A group of related tests in one file (e.g. all login tests) |

---

## Where things live on disk

| What | Where |
|---|---|
| Generated test scripts | `tests/generated/<ProductName>/` |
| Last-run results per spec | `tests/generated/<ProductName>/<file>.spec.ts.last-run.json` |
| Failure capture for healing | `tests/generated/<ProductName>/<file>.spec.ts.failure-<test>.json` (deleted after heal) |
| HTML reports | `playwright-report/` (per Playwright defaults) and `html-reports/report_<id>/` (custom) |
| Excel reports | `reports/` |
| Run history | `backend/history/` (one JSON per run) |
| Settings (Jira connections, LLM config) | Browser `localStorage` |

---

## Architectural sketch (for the curious)

```
   ┌─────────────────────────────────────────────────┐
   │              React Frontend (Vite)              │
   │   - Sidebar navigation                          │
   │   - Wizard (4 stages) for test plan creation    │
   │   - Modules for API / Perf / UI Quality / CI    │
   │   - Report viewer + History dashboard           │
   └───────────────────┬─────────────────────────────┘
                       │  HTTP (axios)
                       ▼
   ┌─────────────────────────────────────────────────┐
   │       Node.js Backend (Express)                 │
   │   - /api/input/...    fetch & parse sources     │
   │   - /api/generate-scripts  ask LLM for code     │
   │   - /api/run-playwright    spawn Playwright CLI │
   │   - /api/execute (MCP)     live agent-driven    │
   │   - /api/jira/...          push / sync to Jira  │
   │   - /api/perf/...     (coming: JMeter spawning) │
   └─────┬───────────────────────┬───────────────────┘
         │                       │
         ▼                       ▼
   ┌─────────────────┐    ┌─────────────────────────┐
   │  LLM Provider   │    │  Playwright CLI         │
   │  (OpenAI/Groq/  │    │  (spawned as child      │
   │   Gemini/Ollama)│    │   process for each run) │
   └─────────────────┘    └─────────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │ Chromium browser        │
                          │ (your app under test)   │
                          └─────────────────────────┘
```

---

## What's NOT in this tool

To set expectations clearly:

- **It is NOT a Postman replacement** — API Testing here is useful but Postman has more features for ad-hoc API exploration.
- **It is NOT a test management system** like TestRail or Zephyr — though it integrates with Jira & Xray for storing test cases.
- **It does NOT replace your CI** — the CI/CD module observes/triggers GitHub Actions, it doesn't replace them.
- **It does NOT guarantee 100% reliable AI-generated tests** — Auto-Heal and the live DOM inspector catch many issues, but you should still review generated test plans before relying on them for critical flows.

---

## Quick checklist for a new user

```
[ ] Open the app → sidebar visible on the left
[ ] Click ⚙️ Settings (bottom of sidebar)
    [ ] Data Source tab → add Jira connection
    [ ] LLM Brain tab → pick provider, paste API key
    [ ] Done
[ ] Test Case Execution → Stage 1 → pick the connection you just added
[ ] Stage 2 → pick a source, fetch some requirements
[ ] Stage 3 → fill Application URL, add Additional Context with test data
[ ] Stage 4 → click "Save Script File" → wait for spec.ts to be created
[ ] Stage 4 → click "Run with Playwright Script Mode"
[ ] Wait for tests to finish, review report
[ ] Click "View HTML Report" or "Execution History Trends" for more detail
```

---

*This document is meant to evolve. When the Performance Testing module is wired up, the "Coming soon" section will be replaced with the real usage steps. Other modules will get similar deep-dives as features mature.*
