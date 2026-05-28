#!/usr/bin/env node

/**
 * Direct Playwright Testing - No LLM Needed
 * This approach bypasses the schema issues by directly running Playwright scripts
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function inspectPage(url) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        console.log(`\n🔍 Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle' });
        
        console.log(`\n📄 Page Title: ${await page.title()}`);
        console.log(`\n🔎 Visible Page Content:`);
        console.log('─'.repeat(80));
        
        const text = await page.evaluate(() => document.body.innerText);
        console.log(text.substring(0, 2000)); // First 2000 chars
        
        console.log('\n─'.repeat(80));
        console.log(`\n🎯 Interactive Elements Found:`);
        
        // Find all clickable elements
        const elements = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a[href], input[type="button"], [role="button"]'));
            return buttons.map(el => ({
                text: el.textContent?.trim() || el.innerText?.trim() || '',
                tag: el.tagName,
                type: el.getAttribute('type') || '',
                id: el.id || '',
                class: el.className || '',
                selector: el.id ? `#${el.id}` : `.${el.className?.split(' ')[0] || ''}`
            })).filter(el => el.text.length > 0);
        });
        
        elements.forEach((el, i) => {
            console.log(`   [${i+1}] ${el.text}`);
            console.log(`       Tag: ${el.tag}, Type: ${el.type}`);
            if (el.id) console.log(`       ID: ${el.id}`);
        });
        
        console.log(`\n📝 Form Fields Found:`);
        const fields = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
            return inputs.map(el => ({
                type: el.getAttribute('type') || el.tagName,
                name: el.getAttribute('name') || '',
                id: el.id || '',
                placeholder: el.getAttribute('placeholder') || '',
                label: el.parentElement?.querySelector('label')?.textContent || ''
            }));
        });
        
        fields.forEach((field, i) => {
            console.log(`   [${i+1}] Type: ${field.type}, Name: ${field.name || field.placeholder || field.label}`);
        });
        
        return { success: true, elementCount: elements.length, fieldCount: fields.length };
        
    } catch (err) {
        console.error(`\n❌ Error: ${err.message}`);
        return { success: false, error: err.message };
    } finally {
        await browser.close();
    }
}

// Test URL
const testUrl = 'https://www.qaplayground.com/login';
console.log('🚀 Element Inspector - Direct Playwright Approach');
console.log('═'.repeat(80));

inspectPage(testUrl).then(result => {
    console.log('\n' + '═'.repeat(80));
    if (result.success) {
        console.log(`✅ Inspection complete: Found ${result.elementCount} interactive elements, ${result.fieldCount} form fields`);
    } else {
        console.log(`❌ Inspection failed: ${result.error}`);
    }
    process.exit(result.success ? 0 : 1);
});
