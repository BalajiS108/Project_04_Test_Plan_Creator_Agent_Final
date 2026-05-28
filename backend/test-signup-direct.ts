#!/usr/bin/env node

/**
 * Direct Playwright Sign Up Test
 * This demonstrates the CORRECT way to execute the test without schema issues
 */

import { chromium } from 'playwright';
import { Page } from 'playwright';

interface StepResult {
    step: string;
    result: string;
    passed: boolean;
}

async function runSignupTest(): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    const browser = await chromium.launch({ headless: false }); // visible for debugging
    const page = await browser.newPage();
    
    try {
        // Step 1: Navigate to login page
        steps.push({
            step: "Navigate to login page",
            result: "Navigating to https://www.qaplayground.com/login",
            passed: false
        });
        
        await page.goto('https://www.qaplayground.com/login');
        await page.waitForLoadState('networkidle');
        steps[steps.length - 1].passed = true;
        steps[steps.length - 1].result = "✅ Successfully navigated to login page";
        
        // Step 2: Click on "Sign up" button
        steps.push({
            step: "Click on the Sign up button",
            result: "Looking for Sign up element...",
            passed: false
        });
        
        const signupLink = await page.locator('a#signup-link');
        if (await signupLink.isVisible()) {
            await signupLink.click();
            await page.waitForLoadState('networkidle');
            steps[steps.length - 1].passed = true;
            steps[steps.length - 1].result = "✅ Clicked Sign up button and navigated to signup page";
        } else {
            throw new Error("Sign up link not found");
        }
        
        // Step 3: Enter Full Name
        steps.push({
            step: "Enter Full Name as 'John Doe' in the Full Name field",
            result: "Looking for Full Name field...",
            passed: false
        });
        
        const nameField = await page.locator('input#name, input[name="name"]');
        if (await nameField.isVisible()) {
            await nameField.fill('John Doe');
            steps[steps.length - 1].passed = true;
            steps[steps.length - 1].result = "✅ Entered 'John Doe' in Full Name field";
        } else {
            throw new Error("Full Name field not found");
        }
        
        // Step 4: Enter Email
        steps.push({
            step: "Enter 'johndoe@example.com' in the Email field",
            result: "Looking for Email field...",
            passed: false
        });
        
        const emailField = await page.locator('input#email, input[name="email"]');
        if (await emailField.isVisible()) {
            await emailField.fill('johndoe@example.com');
            steps[steps.length - 1].passed = true;
            steps[steps.length - 1].result = "✅ Entered 'johndoe@example.com' in Email field";
        } else {
            throw new Error("Email field not found");
        }
        
        // Step 5: Enter Password
        steps.push({
            step: "Enter 'P@ssw0rd' in the Password field",
            result: "Looking for Password field...",
            passed: false
        });
        
        const passwordField = await page.locator('input#password, input[name="password"]');
        if (await passwordField.isVisible()) {
            await passwordField.fill('P@ssw0rd');
            steps[steps.length - 1].passed = true;
            steps[steps.length - 1].result = "✅ Entered password in Password field";
        } else {
            throw new Error("Password field not found");
        }
        
        // Step 6: Enter Confirm Password
        steps.push({
            step: "Enter 'P@ssw0rd' in the Confirm Password field",
            result: "Looking for Confirm Password field...",
            passed: false
        });
        
        const confirmField = await page.locator('input#confirm-password, input[name="confirmPassword"]');
        if (await confirmField.isVisible()) {
            await confirmField.fill('P@ssw0rd');
            steps[steps.length - 1].passed = true;
            steps[steps.length - 1].result = "✅ Entered password in Confirm Password field";
        } else {
            throw new Error("Confirm Password field not found");
        }
        
        // Step 7: Click "Create Account" button
        steps.push({
            step: "Click on the 'Create Account' button",
            result: "Looking for Create Account button...",
            passed: false
        });
        
        const createBtn = await page.locator('button#signup-btn, button:has-text("Create Account")');
        if (await createBtn.isVisible()) {
            await createBtn.click();
            // Wait a bit to see if page processes
            await page.waitForTimeout(2000);
            steps[steps.length - 1].passed = true;
            steps[steps.length - 1].result = "✅ Clicked 'Create Account' button";
        } else {
            throw new Error("Create Account button not found");
        }
        
        // Final verdict
        const allPassed = steps.every(s => s.passed);
        console.log('\n' + '═'.repeat(80));
        console.log(allPassed ? '✅ ALL STEPS PASSED' : '⚠️ SOME STEPS FAILED');
        console.log('═'.repeat(80));
        
        return steps;
        
    } catch (err: any) {
        console.error(`\n❌ Test Failed: ${err.message}`);
        steps[steps.length > 0 ? steps.length - 1 : 0].passed = false;
        steps[steps.length > 0 ? steps.length - 1 : 0].result = `❌ Error: ${err.message}`;
        return steps;
    } finally {
        // Keep browser open for 5 seconds
        await page.waitForTimeout(5000);
        await browser.close();
    }
}

console.log('═'.repeat(80));
console.log('🚀 Direct Playwright Sign Up Test');
console.log('═'.repeat(80));

runSignupTest().then(steps => {
    console.log('\n📋 STEP-BY-STEP RESULTS:\n');
    steps.forEach((step, i) => {
        const status = step.passed ? '✅' : '❌';
        console.log(`${status} Step ${i + 1}: ${step.step}`);
        console.log(`   Result: ${step.result}\n`);
    });
    
    const passedCount = steps.filter(s => s.passed).length;
    console.log(`\n📊 Summary: ${passedCount}/${steps.length} steps passed`);
    process.exit(passedCount === steps.length ? 0 : 1);
});
