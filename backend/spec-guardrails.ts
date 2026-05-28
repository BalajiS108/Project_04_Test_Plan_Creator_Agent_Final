/**
 * Post-generation guardrails for LLM-produced Playwright code.
 *
 * Catches a small set of high-recurrence LLM mistakes deterministically,
 * after the LLM call but before the code is written to disk OR re-spliced
 * back into a spec during the self-healing pass. Centralized here so both
 * /api/generate-scripts and the healer apply the exact same rules.
 *
 * Each fix is conservative: it either rewrites the obviously-wrong pattern
 * with a known-correct replacement, or it leaves a visible comment when a
 * safe automatic rewrite isn't possible.
 */

export interface GuardrailResult {
    code: string;
    notes: string[];
}

export function applyGuardrails(input: string): GuardrailResult {
    let code = input;
    const notes: string[] = [];

    // Fix 1: drop tag prefix on [data-test=...] / [data-testid=...]
    //   div[data-test="error"] → [data-test="error"]
    //   button[data-test="..."] → [data-test="..."]
    const tagPrefixRegex = /\b(?:div|span|p|h[1-6]|button|input|a|label|section|article|ul|ol|li)(?=\[data-test(?:id)?=)/g;
    const beforeTag = code;
    code = code.replace(tagPrefixRegex, '');
    if (code !== beforeTag) notes.push('stripped tag prefix from [data-test*=] selectors');

    // Fix 2: warn on page.waitForTimeout(N) — masks real timing issues
    if (/page\.waitForTimeout\s*\(/.test(code)) {
        notes.push('WARNING: contains page.waitForTimeout — prefer auto-waiting locators');
    }

    // Fix 3: warn on .locator('..') parent traversal — usually fragile
    if (/\.locator\(\s*['"`]\.\.['"`]\s*\)/.test(code)) {
        notes.push('WARNING: contains .locator("..") parent-traversal — likely fragile');
    }

    // Fix 4: replace add-to-cart .toHaveText('Remove') (button gets replaced, not relabeled)
    const toggleAssertionPattern = /await\s+expect\(\s*page\.locator\(\s*['"`]([#\[][^'"`]*add-to-cart[^'"`]*)['"`]\s*\)\s*\)\.toHaveText\(\s*['"`]Remove['"`]\s*\)/g;
    if (toggleAssertionPattern.test(code)) {
        notes.push('replaced add→Remove toggle assertion with cart-badge check');
        code = code.replace(
            toggleAssertionPattern,
            "await expect(page.locator('.shopping_cart_badge')).toBeVisible()  // (auto-fixed: original button is replaced after click, not relabeled)",
        );
    }

    // Fix 5: replace .cart_item wait after #checkout click (cart page is gone)
    const checkoutCartIssue = /(page\.click\(\s*['"`]#checkout['"`]\s*\);?\s*\n\s*)await\s+page\.waitForSelector\(\s*['"`]\.cart_item['"`]\s*\)/g;
    if (checkoutCartIssue.test(code)) {
        notes.push('replaced .cart_item wait after #checkout with destination-page wait');
        code = code.replace(
            checkoutCartIssue,
            "$1await page.waitForSelector('#first-name, #checkout_info_container')",
        );
    }

    // Fix 6: strict-mode multi-match — add .first() to toBeVisible on
    // collection-class locators (cart_item, inventory_item, etc.)
    const collectionRe = /expect\(\s*page\.locator\(\s*(['"`])\.(?:cart_item|inventory_item|list-item|list_item|product|row|item|cart-item)\1\s*\)\s*\)\.toBeVisible\(\)/g;
    if (collectionRe.test(code)) {
        notes.push('added .first() to toBeVisible on collection-class locators');
        code = code.replace(collectionRe, (m) => m.replace(/\)\)\.toBeVisible\(\)/, ').first()).toBeVisible()'));
    }

    // Fix 9: Playwright API misuse — LLMs frequently write `test.title` (which
    // is undefined, so `.replace(...)` throws TypeError) when they mean
    // `test.info().title`. Same for `test.info` referenced as a property.
    // This is a deterministic API fact, so rewrite without ambiguity.
    const testTitleRe = /\btest\.title\b/g;
    if (testTitleRe.test(code)) {
        notes.push('rewrote test.title → test.info().title (Playwright API)');
        code = code.replace(testTitleRe, 'test.info().title');
    }

    // Fix 8: SauceDemo cart page — `.cart_item .inventory_item_name` is a
    // fragile descendant selector. The cart page has a different DOM shape
    // than the inventory page (name lives inside an <a> wrapper), and
    // allTextContents() doesn't auto-wait for descendants. SauceDemo gives
    // every item name the stable atomic `data-test="inventory-item-name"`,
    // which is safer and equivalent. Replace globally.
    const cartItemNameRe = /(['"`])\.cart_item\s+\.inventory_item_name\1/g;
    if (cartItemNameRe.test(code)) {
        notes.push('rewrote .cart_item .inventory_item_name → [data-test=inventory-item-name]');
        code = code.replace(
            cartItemNameRe,
            (_, q) => q === '"'
                ? `${q}[data-test='inventory-item-name']${q}`
                : `${q}[data-test="inventory-item-name"]${q}`,
        );
    }

    // Fix 7: SauceDemo-specific — #inventory_container is duplicated.
    // Quote-aware: when outer is double, use single for inner attr value
    // (and vice versa) so we never produce nested unescaped quotes.
    const sauceDemoDupIdRe = /(['"`])#inventory_container\1/g;
    if (sauceDemoDupIdRe.test(code)) {
        notes.push('rewrote duplicate-ID #inventory_container → [data-test=inventory-container]');
        code = code.replace(
            sauceDemoDupIdRe,
            (_, q) => q === '"'
                ? `${q}[data-test='inventory-container']${q}`
                : `${q}[data-test="inventory-container"]${q}`,
        );
    }

    return { code, notes };
}
