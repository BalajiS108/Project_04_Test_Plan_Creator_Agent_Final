# 🚀 Intelligent Test Planning Agent — Quick Start

> One page. Print it, share it, pin it.

---

## What this tool does in 1 sentence
**Point it at a requirement (Jira / doc / web page / Figma), it generates UI test cases, runs them in a real browser, and reports results — no coding needed.**

---

## The 5 modules (left sidebar)

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  1. 📋 Test Case Execution   ── generate + run UI tests      │
│  2. 🔌 API Testing           ── REST endpoint tests          │
│  3. ⚡ Performance Testing    ── JMeter load (🚧 coming soon) │
│  4. 🛡️  UI Quality            ── visual regression + a11y    │
│  5. 🔄 CI / CD               ── GitHub Actions monitor       │
│                                                              │
│  ─────────────────────────                                   │
│  ⚙️  Settings                ── Jira, LLM, Theme             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## First-time setup (3 steps, ~2 minutes)

```
┌─────────────────────────────────────────────────────┐
│ 1. Click ⚙️ Settings (bottom of sidebar)             │
│    → Data Source tab → + Add Connection             │
│    → enter Jira URL + email + API token             │
└─────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ 2. Settings → LLM Brain tab                         │
│    → pick OpenAI / Groq / Gemini / Ollama           │
│    → paste API key → Save                           │
└─────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ 3. Settings → Appearance → pick Light / Dark        │
│    Close Settings. You're ready.                    │
└─────────────────────────────────────────────────────┘
```

> 💡 **Jira API token** = generated at `id.atlassian.com → Security → API tokens`. NOT your login password.

---

## The main flow — 4 stages

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  ① SETUP     │───→│  ② FETCH     │───→│  ③ REVIEW    │───→│  ④ GENERATE  │
│              │    │   ISSUES     │    │              │    │   & EXECUTE  │
│ pick Jira    │    │ Jira / BRD / │    │ Application  │    │ Save Script  │
│ connection   │    │ HTML / Figma │    │ URL + extra  │    │ → Run → Report│
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### What each stage needs from you

| Stage | What you do | Time |
|---|---|---|
| ① Setup | Pick a Jira connection (or click + Add) | 5 sec |
| ② Fetch Issues | Pick source tab, enter project key / URL / file / Figma | 10 sec |
| ③ Review | Fill **Application URL** (the app to test) + optional context | 30 sec |
| ④ Generate & Execute | Save Script File → Run with Playwright Script Mode | 1-3 min |

---

## Top toolbar — what each button does (Stage 4)

| Button | Use it when… |
|---|---|
| **Save Script File** | You want a fresh LLM regeneration (use when test plan changed) |
| **Run with Playwright Script Mode** | Run the saved script. Same as Library Run + terminal — consistent results |
| **Run with MCP Mode** | Live agent-driven; slower but supports inline Auto-Heal |
| **Browser: Headed / Headless** | Headed = see browser. Headless = invisible, faster |
| **Auto-Heal** | ON by default. Auto-fixes failed tests using the actual failure DOM |
| **Push to Jira** | Create a Jira issue per test case |
| **Sync Results to Jira** | Post pass/fail comment + transition workflow status |
| **📈 Execution History Trends** | Open the pass-rate trend dashboard |
| **View HTML Report** | Playwright's interactive report with screenshots, traces |

---

## Self-Healing in 4 panels

```
 ┌─────────────────────┐    ┌─────────────────────┐
 │ ① Test FAILS        │───→│ ② Capture failure   │
 │   Wrong selector?   │    │   Error + page HTML │
 │   Timeout?          │    │   sent to LLM       │
 └─────────────────────┘    └─────────┬───────────┘
                                      ↓
 ┌─────────────────────┐    ┌─────────────────────┐
 │ ④ Test re-runs      │←───│ ③ LLM rewrites      │
 │   🩹 Healed badge if│    │   just that test    │
 │   it now passes     │    │   with real selector│
 └─────────────────────┘    └─────────────────────┘
```

> Healing only fires when **Auto-Heal toggle is ON**. Won't fix logical bugs or real app bugs — only selector / locator / timing issues.

---

## Quick scenarios

| I want to… | Do this |
|---|---|
| Test a Jira story | Stage 1 pick connection → Stage 2 Jira tab + project key → Stage 3 add Application URL → Stage 4 Save Script → Run |
| Test a public web page (no Jira) | Stage 2 HTML tab → F12 → copy `<html>` outerHTML → paste into Page card → continue |
| Re-run a saved script | Stage 4 toolbar → Library button → expand suite to see test names → click Run on the row |
| Recover from a flaky test | Make sure **Auto-Heal** is ON → click Run → watch for 🩹 Healed badge |
| Test REST APIs (not UI) | Sidebar → API Testing → new suite → add requests + assertions |
| See trend over time | Stage 4 → after a run → click **📈 Execution History Trends** |

---

## Common mistakes to avoid

| ❌ Don't | ✅ Do |
|---|---|
| Use your Jira password as the API token | Generate an API token at id.atlassian.com |
| Skip the Application URL in Stage 3 (then complain about wrong URLs in tests) | Always fill it — the LLM uses it verbatim in test Preconditions |
| Click Run with Playwright Script Mode expecting fresh code every time | That button **reuses the saved script** for consistency. Click **Save Script File** to force regeneration |
| Confuse Performance Testing (JMeter, backend load) with UI Quality (visual + a11y) | They're different tabs for different purposes |
| Hide the scrollbar when there's lots of test data | Browser scroll is intentional; the test plan table also has its own internal horizontal scroll |

---

## Glossary (the 6 terms that matter)

- **LLM** — Large Language Model (the AI: OpenAI / Groq / Gemini / Ollama)
- **Spec file** — The actual Playwright test code (`tests/generated/<Product>/*.spec.ts`)
- **Playwright** — Browser automation framework that runs the tests
- **MCP** — Model Context Protocol; how the live agent talks to the browser
- **Auto-Heal** — Auto-rewrites failed tests using the actual failure DOM
- **JMeter** — Apache JMeter; load testing tool (for Performance Testing module)

---

## Need more detail?

See **[PROJECT_FLOW.md](PROJECT_FLOW.md)** for the full walkthrough — including the upcoming JMeter integration, architecture diagram, and detailed module deep-dives.

---

*Last updated: 2026-05-25 · Generated by the project team*
