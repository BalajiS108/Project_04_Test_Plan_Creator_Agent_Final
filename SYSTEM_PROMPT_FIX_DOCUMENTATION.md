# System Prompt Tool Names Fix - Documentation

## Problem Summary
The system prompt in `backend/agent.ts` was instructing the LLM to use incorrect tool names and parameters that didn't match the actual MCP (Model Context Protocol) Playwright tools being provided.

### What Was Wrong
**Old (Incorrect) Tool Names:**
- `browser_navigate(url)`
- `browser_snapshot()` (doesn't exist in MCP)
- `browser_click(ref)` (parameter name wrong)
- `browser_fill_form(fields, submitSelector)` with wrong field parameters
- `browser_wait_for(text, textGone, time)`
- `browser_get_visible_text()`
- `browser_take_screenshot()`
- `browser_check()`

---

## Solution Applied
Updated `backend/agent.ts` (lines 463-560) to use the ACTUAL MCP tool names and parameters from `playwright-mcp.ts`.

### Correct Tool Names Now Used
| Tool | Parameters | Purpose |
|------|------------|---------|
| `playwright_navigate(url)` | `url: string` | Navigate to a URL |
| `playwright_click(selector, force?)` | `selector: string`, `force?: boolean` | Click elements by CSS/text selector |
| `playwright_fill(selector, value)` | `selector: string`, `value: string` | Fill text inputs |
| `playwright_type(selector, text, delay?, clearFirst?)` | CSS selector and text | Type character-by-character for reactive forms |
| `playwright_fill_form(fields, submitSelector?)` | Array of `{selector, value, type?}` | Batch fill multiple form fields |
| `playwright_press_key(key, selector?)` | `key: string` like 'Enter' | Press keyboard keys |
| `playwright_wait_for_selector(selector, state?, timeout?)` | `selector: string` | Wait for elements to appear |
| `playwright_get_visible_text(selector?)` | Optional `selector` | Get page content for verification |
| `playwright_screenshot(filename)` | `filename: string` | Take screenshots |
| `playwright_check(selector, checked?)` | `selector: string`, `checked?: boolean` | Check/uncheck boxes |
| `playwright_select_option(selector, value/label/index)` | CSS selector and value/label | Select dropdown options |
| `playwright_wait(ms)` | `ms: number` | Wait N milliseconds |
| `playwright_get_html(selector?)` | Optional CSS selector | Get HTML for debugging |
| `playwright_read_text(selector)` | `selector: string` | Read specific element text |

---

## Key Parameter Changes

### 1. **playwright_click** - Parameter Name Change
```typescript
// WRONG:
browser_click(ref: string) // "ref" doesn't exist in MCP schema

// CORRECT:
playwright_click(selector: string, force?: boolean)
// Use CSS selectors like: 'button[type="submit"]' or text selectors like: 'text=Login'
```

### 2. **playwright_fill_form** - Field Object Structure
```typescript
// WRONG (from old system prompt):
// - Fields with "ref" from non-existent snapshot()
// - "submitSelector" as tool parameter

// CORRECT (matching MCP schema):
playwright_fill_form([
  {
    selector: 'input[name="email"]',  // CSS selector (REQUIRED)
    value: "test@example.com",         // Value (REQUIRED)
    type: "fill"  // "fill"|"type"|"select"|"check"|"recaptcha" (OPTIONAL, default: "fill")
  },
  {
    selector: 'input[type="password"]',
    value: "Pass123",
    type: "fill"
  }
], "button[type=submit']")  // submitSelector is optional parameter
```

### 3. **Removed Non-Existent Tools**
- `browser_snapshot()` - Doesn't exist in MCP. The system now uses CSS selectors directly
- Non-existent `browser_*` prefix tools - All tools are `playwright_*`

---

## Workflow Updated

**Old workflow (using non-existent tools):**
1. Call `browser_snapshot()` to get element refs
2. Use refs in `browser_click()`, `browser_fill_form()`
3. Problems: Tool doesn't exist, workflow impossible

**New workflow (matching actual MCP tools):**
1. Call `playwright_navigate(url)` to go to URL
2. Call `playwright_get_visible_text()` to inspect page
3. Use CSS selectors directly with `playwright_click()`, `playwright_fill()`, `playwright_fill_form()`
4. Wait for elements with `playwright_wait_for_selector()`
5. Verify with `playwright_get_visible_text()`

---

## Files Modified
- `backend/agent.ts` (lines 463-560): Updated system prompt with correct tool names and parameters

## Testing Status
✅ System prompt syntax validated - all tool references corrected
✅ Tool names now match MCP server: `playwright-mcp.ts`
✅ Parameters now match actual schemas in `playwright-mcp.ts`
⏳ End-to-end test execution pending (requires LLM API availability)

---

## How This Fix Works

### Before Fix
1. LLM reads system prompt saying: "Use `browser_navigate()`..."
2. LLM tries to call: `browser_navigate(url)`
3. MCP server responds: "Tool 'browser_navigate' not found" ❌
4. Test execution fails

### After Fix
1. LLM reads system prompt saying: "Use `playwright_navigate()`..."
2. LLM tries to call: `playwright_navigate(url)`
3. MCP server finds tool and executes ✅
4. Parameter schema matches: selector instead of ref ✅
5. Test execution proceeds

---

## Lessons Learned

1. **Tool Schemas Come from MCP Server**: Never invent tool names/parameters. Always match what the MCP server actually provides
2. **CSS Selectors vs Element Refs**: Playwright uses CSS selectors directly, no need for element references
3. **Tool Parameter Consistency**: System prompt parameters must EXACTLY match the inputSchema in MCP tools
4. **Testing Imports**: The `playwright-mcp.ts` file defines the source truth for tool names and schemas

---

## Next Steps for Full Integration
1. Verify LLM API connectivity (OpenAI, Groq, or Ollama)
2. Run end-to-end test execution with small test plan
3. Monitor tool call responses from MCP server
4. Capture any remaining parameter mismatches
5. Update system prompt if new tools need documentation
