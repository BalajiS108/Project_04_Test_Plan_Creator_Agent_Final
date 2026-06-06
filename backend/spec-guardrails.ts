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
    // collection-class locators when passed as a string literal.
    //
    // The class names below are the SauceDemo + common multi-item patterns
    // we've seen LLMs target. The list is intentionally broad because
    // missing one (like `.inventory_item_name`) produces a confusing
    // "resolved to N elements" error that even Auto-Heal struggles to
    // diagnose — the healer often rewrites the same banned pattern back in.
    //
    // Pattern groups (regex below is the union):
    //   - per-row classes: cart_item, inventory_item, list-item, etc.
    //   - per-row CHILDREN classes: inventory_item_name/price/desc/img,
    //     cart_item_label, cart_quantity (these are the new ones — Fix 6
    //     missed them before)
    //   - generic containers users get strict-mode bitten by: product, row,
    //     item, tile, card, panel
    const COLLECTION_CLASSES = [
        // Per-row roots
        'cart_item', 'cart-item', 'cart_list',
        'inventory_item',
        'list-item', 'list_item',
        // Per-row CHILDREN (these were missing — caused the .inventory_item_name failure)
        'inventory_item_name', 'inventory_item_price', 'inventory_item_desc', 'inventory_item_img', 'inventory_item_label',
        'cart_item_label', 'cart_quantity', 'cart_item_name', 'cart_item_price',
        // Generic multi-item container patterns common across demo apps
        'product', 'product-card', 'product_card', 'product-tile', 'product_tile',
        'item', 'tile', 'card', 'row',
    ];
    const collectionAlternation = COLLECTION_CLASSES.map(c => c.replace(/[-]/g, '[-]')).join('|');
    const collectionRe = new RegExp(
        `expect\\(\\s*page\\.locator\\(\\s*(['"\`])\\.(?:${collectionAlternation})\\1\\s*\\)\\s*\\)\\.toBeVisible\\(\\)`,
        'g',
    );
    if (collectionRe.test(code)) {
        notes.push('added .first() to toBeVisible on collection-class locators');
        code = code.replace(collectionRe, (m) => m.replace(/\)\)\.toBeVisible\(\)/, ').first()).toBeVisible()'));
    }

    // Fix 6b: variable-form of the same bug. LLMs often hoist the selector:
    //   const cartItemSelector = '.cart_item';
    //   await expect(page.locator(cartItemSelector)).toBeVisible();
    // Fix 6's regex doesn't match because the locator() arg is an identifier,
    // not a string. Two-pass: find any const/let/var declaration assigning a
    // collection-class string, then rewrite any expect(page.locator(<that
    // identifier>)).toBeVisible() to use .first().
    const collectionClassDeclRe = new RegExp(
        `\\b(?:const|let|var)\\s+(\\w+)\\s*(?::\\s*[A-Za-z<>\\[\\]\\s,]+)?\\s*=\\s*['"\`](\\.(?:${collectionAlternation}))['"\`]`,
        'g',
    );
    const collectionVars: string[] = [];
    let declMatch: RegExpExecArray | null;
    while ((declMatch = collectionClassDeclRe.exec(code)) !== null) {
        collectionVars.push(declMatch[1]);
    }
    if (collectionVars.length > 0) {
        let rewrites = 0;
        for (const varName of collectionVars) {
            // Word-boundary anchored so `cart` doesn't accidentally match `cartIcon`.
            const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const visRe = new RegExp(
                `expect\\(\\s*page\\.locator\\(\\s*${esc}\\s*\\)\\s*\\)\\.toBeVisible\\(\\)`,
                'g',
            );
            const before = code;
            code = code.replace(visRe, `expect(page.locator(${varName}).first()).toBeVisible()`);
            if (code !== before) rewrites++;
        }
        if (rewrites > 0) {
            notes.push(`added .first() to toBeVisible on ${rewrites} variable-form collection-class locator(s): [${collectionVars.join(', ')}]`);
        }
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

    // Fix 10: SauceDemo page-context guardrail.
    //
    // SauceDemo is a stable demo app with a strict page ladder. Each selector
    // exists on EXACTLY ONE page. LLMs frequently emit assertions/clicks for
    // selectors that belong to a page the test never navigates to — the test
    // then times out at 15s on a non-existent element. We've seen these:
    //
    //   - `#continue-shopping` clicked from /inventory.html (only on /cart.html)
    //   - `.summary_total_label` asserted from /cart.html (only on /checkout-step-two.html)
    //   - `#checkout` clicked from /inventory.html (only on /cart.html)
    //   - `#finish` clicked from /cart.html (only on /checkout-step-two.html)
    //   - `#first-name`/`#last-name`/`#postal-code` filled from /cart.html (only on /checkout-step-one.html)
    //
    // Strategy: walk each `test() {…}` body line by line, tracking which page
    // the test has navigated to. When a line references a selector that lives
    // on a higher page than the current state, that line is a known bug —
    // comment it out so the test fails fast on the real issue (or, with luck,
    // still passes when the offending assertion was the only problem).
    //
    // Page ladder (each requires the previous):
    //   1. /                       → after page.goto(baseUrl)
    //   2. /inventory.html         → after click on #login-button
    //   3. /cart.html              → after click on #shopping_cart_container or .shopping_cart_link
    //   4. /checkout-step-one.html → after click on #checkout
    //   5. /checkout-step-two.html → after click on #continue (only valid on step-one)
    //   6. /checkout-complete.html → after click on #finish
    //
    // Brace-balanced test() parsing so we don't mix state between tests.
    const PAGE_RANK: Record<string, number> = {
        login: 1, inventory: 2, cart: 3, stepOne: 4, stepTwo: 5, complete: 6,
    };
    // Selector → page it lives on. Match against each line's text content.
    // Bare hash IDs match `'#x'` / `"#x"` / `` `#x` ``; class selectors match `.x`.
    const SELECTOR_PAGE: { re: RegExp; page: keyof typeof PAGE_RANK; label: string }[] = [
        // /cart.html
        { re: /['"`]#continue-shopping['"`]/, page: 'cart', label: '#continue-shopping' },
        { re: /['"`]\.cart_item['"`]/, page: 'cart', label: '.cart_item' },
        { re: /['"`]\.cart_quantity['"`]/, page: 'cart', label: '.cart_quantity' },
        // /checkout-step-one.html
        { re: /['"`]#first-name['"`]/, page: 'stepOne', label: '#first-name' },
        { re: /['"`]#last-name['"`]/, page: 'stepOne', label: '#last-name' },
        { re: /['"`]#postal-code['"`]/, page: 'stepOne', label: '#postal-code' },
        // /checkout-step-two.html (the summary page)
        { re: /['"`]\.summary_total_label['"`]/, page: 'stepTwo', label: '.summary_total_label' },
        { re: /['"`]\.summary_subtotal_label['"`]/, page: 'stepTwo', label: '.summary_subtotal_label' },
        { re: /['"`]\.summary_tax_label['"`]/, page: 'stepTwo', label: '.summary_tax_label' },
        { re: /['"`]\.summary_info_label['"`]/, page: 'stepTwo', label: '.summary_info_label' },
        { re: /['"`]\.summary_info['"`]/, page: 'stepTwo', label: '.summary_info' },
        { re: /['"`]\.summary_quantity['"`]/, page: 'stepTwo', label: '.summary_quantity' },
        { re: /['"`]#finish['"`]/, page: 'stepTwo', label: '#finish' },
        // /checkout-complete.html
        { re: /['"`]#back-to-products['"`]/, page: 'complete', label: '#back-to-products' },
        { re: /['"`]\.complete-header['"`]/, page: 'complete', label: '.complete-header' },
    ];
    // Navigation transitions: detect on a line and advance currentPage.
    const PAGE_TRANSITIONS: { re: RegExp; from: (keyof typeof PAGE_RANK)[]; to: keyof typeof PAGE_RANK }[] = [
        { re: /page\.click\(\s*['"`](?:#shopping_cart_container|\.shopping_cart_link)['"`]/, from: ['inventory'], to: 'cart' },
        { re: /page\.click\(\s*['"`]#checkout['"`]/, from: ['cart'], to: 'stepOne' },
        { re: /page\.click\(\s*['"`]#continue-shopping['"`]/, from: ['cart'], to: 'inventory' },
        { re: /page\.click\(\s*['"`]#continue['"`]/, from: ['stepOne'], to: 'stepTwo' },
        { re: /page\.click\(\s*['"`]#finish['"`]/, from: ['stepTwo'], to: 'complete' },
        { re: /page\.click\(\s*['"`]#login-button['"`]/, from: ['login'], to: 'inventory' },
        { re: /page\.click\(\s*['"`]#back-to-products['"`]/, from: ['complete'], to: 'inventory' },
    ];
    const applyPageContextToBody = (body: string): { body: string; removed: { line: string; reason: string }[] } => {
        const removed: { line: string; reason: string }[] = [];
        const lines = body.split('\n');
        const out: string[] = [];
        // Most LLM-generated tests run a login + first-action flow in
        // beforeEach, leaving the page on /inventory.html. Starting state.
        // If we see a fresh page.goto in this body, we'd reset — but that's
        // rare and we'd rather over-remove a misplaced assertion than miss it.
        let currentPage: keyof typeof PAGE_RANK = 'inventory';
        for (const line of lines) {
            // First check: is this line's selector valid for the current page?
            // (Run this BEFORE applying the transition on this same line so
            // that a click on `#checkout` from a state where we're NOT on /cart
            // gets caught, instead of being rescued by the same line.)
            let drop: { reason: string } | null = null;
            for (const sp of SELECTOR_PAGE) {
                if (!sp.re.test(line)) continue;
                // Allow if the line ITSELF performs the navigation that gets us there.
                const lineSelfNav = PAGE_TRANSITIONS.some(t => t.to === sp.page && t.re.test(line));
                if (lineSelfNav) continue;
                if (PAGE_RANK[sp.page] > PAGE_RANK[currentPage]) {
                    drop = { reason: `selector ${sp.label} lives on page rank ${PAGE_RANK[sp.page]} (${sp.page}) but the test is at page rank ${PAGE_RANK[currentPage]} (${currentPage}) here. No navigation to that page earlier in this test.` };
                    break;
                }
            }
            if (drop) {
                removed.push({ line: line.trim(), reason: drop.reason });
                const indent = (line.match(/^[ \t]*/) || [''])[0];
                out.push(`${indent}// (auto-removed by page-context guardrail) ${drop.reason}`);
                out.push(`${indent}// original: ${line.trim().slice(0, 200)}`);
                continue;
            }
            out.push(line);
            // After keeping the line, apply any forward navigation it triggered.
            for (const t of PAGE_TRANSITIONS) {
                if (t.re.test(line) && t.from.includes(currentPage)) {
                    currentPage = t.to;
                    break;
                }
            }
        }
        return { body: out.join('\n'), removed };
    };
    const rewriteTestBodies = (src: string): { code: string; perTestRemoved: { line: string; reason: string }[][] } => {
        const out: string[] = [];
        const perTestRemoved: { line: string; reason: string }[][] = [];
        let cursor = 0;
        const startRe = /\btest\(\s*['"`][^'"`]+['"`]\s*,\s*async\s*\([^)]*\)\s*=>\s*\{/g;
        let m: RegExpExecArray | null;
        while ((m = startRe.exec(src)) !== null) {
            out.push(src.slice(cursor, m.index + m[0].length));
            const bodyStart = m.index + m[0].length;
            let depth = 1;
            let i = bodyStart;
            while (i < src.length && depth > 0) {
                const ch = src[i];
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
                if (depth > 0) i++;
            }
            const body = src.slice(bodyStart, i);
            const { body: newBody, removed } = applyPageContextToBody(body);
            out.push(newBody);
            cursor = i;
            startRe.lastIndex = i;
            if (removed.length > 0) perTestRemoved.push(removed);
        }
        out.push(src.slice(cursor));
        return { code: out.join(''), perTestRemoved };
    };
    const pc = rewriteTestBodies(code);
    if (pc.perTestRemoved.length > 0) {
        const totalLines = pc.perTestRemoved.reduce((n, arr) => n + arr.length, 0);
        code = pc.code;
        notes.push(`page-context guardrail: removed ${totalLines} misplaced line(s) across ${pc.perTestRemoved.length} test(s) (selectors used outside the page they live on)`);
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
