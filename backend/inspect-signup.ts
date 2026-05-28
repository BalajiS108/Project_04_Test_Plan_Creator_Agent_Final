#!/usr/bin/env node

import { chromium } from 'playwright';

async function findSignupPage() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        // First, go to login page and find signup link
        console.log(`\n🔍 Step 1: Navigate to login page`);
        await page.goto('https://www.qaplayground.com/login', { waitUntil: 'networkidle' });
        
        // Check if signup link exists
        const signupLink = await page.locator('a#signup-link');
        console.log(`✅ Found Sign up link with ID: signup-link`);
        
        // Get the href to find signup URL
        const href = await signupLink.getAttribute('href');
        console.log(`📍 Sign up link href: ${href}`);
        
        // Navigate to signup page
        const signupUrl = href.startsWith('http') ? href : `https://www.qaplayground.com${href}`;
        console.log(`\n🔍 Step 2: Navigate to Sign Up page: ${signupUrl}`);
        
        await page.goto(signupUrl, { waitUntil: 'networkidle' });
        
        console.log(`\n📄 Page Title: ${await page.title()}`);
        console.log(`\n🔎 Visible Page Content (first 1500 chars):`);
        console.log('─'.repeat(80));
        
        const text = await page.evaluate(() => document.body.innerText);
        console.log(text.substring(0, 1500));
        
        console.log('\n─'.repeat(80));
        console.log(`\n🎯 Form Fields on Sign Up Page:`);
        
        const fields = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input, textarea, select, label'));
            return inputs.map(el => {
                if (el.tagName === 'LABEL') {
                    return {
                        type: 'LABEL',
                        text: el.textContent?.trim() || '',
                        htmlFor: el.getAttribute('for') || ''
                    };
                }
                return {
                    type: el.getAttribute('type') || el.tagName,
                    name: el.getAttribute('name') || '',
                    id: el.id || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    value: el.getAttribute('value') || ''
                };
            });
        });
        
        console.log('Form elements:');
        fields.forEach((field, i) => {
            if (field.type === 'LABEL') {
                console.log(`   [${i+1}] LABEL: ${field.text} (for: ${field.htmlFor})`);
            } else {
                console.log(`   [${i+1}] ${field.type.toUpperCase()} - ${field.name || field.placeholder || field.value}`);
            }
        });
        
        console.log(`\n🎯 Buttons Found:`);
        const buttons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
                .map(el => ({
                    text: el.textContent?.trim() || el.value || '',
                    type: el.getAttribute('type') || el.tagName,
                    id: el.id || ''
                }));
        });
        
        buttons.forEach((btn, i) => {
            console.log(`   [${i+1}] ${btn.text} (${btn.type}${btn.id ? ', ID: ' + btn.id : ''})`);
        });
        
        return { success: true, url: signupUrl };
        
    } catch (err) {
        console.error(`\n❌ Error: ${err.message}`);
        return { success: false, error: err.message };
    } finally {
        await browser.close();
    }
}

console.log('🚀 Sign Up Page Inspector');
console.log('═'.repeat(80));

findSignupPage().then(result => {
    console.log('\n' + '═'.repeat(80));
    if (result.success) {
        console.log(`✅ Success! Sign up URL: ${result.url}`);
    } else {
        console.log(`❌ Failed: ${result.error}`);
    }
    process.exit(result.success ? 0 : 1);
});
