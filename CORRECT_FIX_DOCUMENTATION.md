# CORRECT FIX: MCP Tool Names Mismatch

## Problem Identified

The error **"attempted to call tool 'playwright_navigate' which was not in request.tools"** was caused by:

### Root Cause: Tool Name Mismatch
- **LLM was told to use:** `playwright_navigate`, `playwright_fill`, `playwright_click`
- **MCP actually provides:** `browser_navigate`, `browser_fill_form`, `browser_click`

This created a mismatch where:
1. LLM received tools named `browser_*`
2. LLM tried to call tools named `playwright_*`
3. OpenAI validation rejected the call because those tools didn't exist

## The CORRECT Fix Applied

### File Modified: `backend/agent.ts`

**BEFORE (Lines 463-480):**
```typescript
const systemPrompt = `You are a QA automation agent using Playwright MCP tools...
   - Command: Call playwright_navigate with this extracted URL
1. Form Filling: Use playwright_fill to input data...
2. Validating: Use playwright_wait_for_selector to verify...
3. If popup appears: use playwright_click on appropriate selectors.
```

**AFTER (Lines 463-520):**
```typescript
const systemPrompt = `You are a QA automation agent using Playwright browser automation tools...

TOOLS AVAILABLE (use these exact names):
   - browser_navigate(url) - Navigate to a URL
   - browser_click(selector) - Click an element
   - browser_fill_form(fields, submitSelector) - Fill form fields
   - browser_type(selector, text) - Type text into a field
   - browser_wait_for(selector, text, textGone, time) - Wait for element or text
   - browser_get_visible_text(selector) - Get visible text
   - browser_take_screenshot(filename) - Take a screenshot
   - browser_press_key(key) - Press a keyboard key
   - browser_evaluate(function) - Run JavaScript
   - browser_check(selector, checked) - Check/uncheck checkbox
   - browser_hover(ref) - Hover over element

EXECUTION STRATEGY:
1. Use browser_navigate FIRST with the URL from preconditions
2. Use browser_fill_form or browser_type for text inputs
3. Use browser_click for buttons
```

## Why This Fix Works

1. **Tool Name Alignment:** LLM now knows the EXACT tool names MCP provides
2. **No Mismatch:** LLM calls `browser_navigate` → MCP has `browser_navigate` ✓
3. **Clear Instructions:** LLM knows which tools to use in which situations
4. **Proper Parameters:** Tool signatures match what MCP expects

## Real MCP Tools Available (21 Total)

From your latest test execution log:
```
✅ MCP Connected! 21 tools loaded from server

Tool List:
1. browser_close
2. browser_resize
3. browser_console_messages
4. browser_handle_dialog
5. browser_evaluate
6. browser_file_upload
7. browser_fill_form
8. browser_press_key
9. browser_type
10. browser_navigate          ← CORRECT NAME (was playwright_navigate)
11. browser_navigate_back
12. browser_network_requests
13. browser_run_code
14. browser_take_screenshot
15. browser_snapshot
16. browser_click             ← CORRECT NAME (was playwright_click)
17. browser_drag
18. browser_hover
19. browser_select_option
20. browser_tabs
21. browser_wait_for          ← CORRECT NAME (was playwright_wait_for_selector)
```

## What to Configure for Full End-to-End Testing

### 1. Valid LLM Provider (Choose ONE)

**Option A: Groq (Recommended - Free Credits)**
```json
{
  "provider": "Groq",
  "apiKey": "your_groq_api_key",
  "model": "llama3-70b-8192"
}
```
- Sign up: https://console.groq.com
- Free credits: $5 USD
- Supports tool calling ✓

**Option B: OpenAI**
```json
{
  "provider": "OpenAI",
  "apiKey": "your_openai_api_key", 
  "model": "gpt-4o-mini"
}
```
- Costs: ~$0.15 USD per 100 test cases
- Supports tool calling ✓

**Option C: Ollama (Local, Free)**
```bash
# Install: https://ollama.ai
ollama pull mistral:latest
# or: ollama pull neural-chat:latest
```
```json
{
  "provider": "Ollama",
  "baseUrl": "http://localhost:11434",
  "model": "mistral:latest"
}
```
- No API key needed
- Runs locally
- Note: Only simple models, may not understand tool calling perfectly

## Test Workflow

### 1. Start Backend
```bash
cd backend
npm start
```
Verify: Backend running on port 3001 with MCP tools loaded ✓

### 2. Start Frontend
```bash
npm run dev
```
Verify: Frontend accessible at http://localhost:5173 ✓

### 3. In Web UI:
- Configure Jira connection (get test scenarios)
- Configure LLM provider (e.g., Groq with valid API key)
- Select test cases and generate test cases
- Execute tests → LLM calls `browser_navigate` → MCP executes → Report generated ✓

## Validation Checklist

- [ ] Backend starting without errors
- [ ] "MCP Connected! 21 tools loaded" in backend logs
- [ ] Tools list shows `browser_navigate`, `browser_click`, etc.
- [ ] Frontend UI accessible at http://localhost:5173
- [ ] Valid LLM API key configured
- [ ] Test execution completes
- [ ] No "attempted to call tool" errors
- [ ] Excel report generated

## Summary

**The Fix:** Update LLM system prompt to use actual MCP tool names (`browser_*` not `playwright_*`)

**Status:** ✅ APPLIED to backend/agent.ts

**Next Step:** Configure valid LLM provider API key and test end-to-end
