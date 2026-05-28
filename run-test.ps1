# Test Execution Script - Testing tool parameter fixes

Write-Host "Testing Tool Parameter Fixes" -ForegroundColor Cyan

# Create test plan with real test cases that require element interaction
$testPlan = @"
# QA Playground Login Test Plan

## Test Cases

| Test Case Name | Jira Key | Priority | Preconditions | Test Data | Steps | Expected Result |
|---|---|---|---|---|---|---|
| KAN-5-1: Valid Login | KAN-5 | High | User is on https://www.qaplayground.com/login | User ID: test, Pass: pass | 1. Enter username test in email field, 2. Enter password pass in password field, 3. Click Login button | User should be logged in and redirected to dashboard |
| KAN-5-2: Invalid Email | KAN-5 | High | User is on https://www.qaplayground.com/login | Email: invalid@test, Pass: test123 | 1. Enter email invalid@test in email field, 2. Enter password test123 in password field, 3. Click Login button | Error message should display indicating invalid credentials |
"@

$llmConfig = @{
    provider = "OpenAI"
    apiKey = $env:OPENAI_API_KEY
    model = "gpt-4o"
} | ConvertTo-Json

$body = @{
    testCases = $testPlan
    llmConfig = $llmConfig
} | ConvertTo-Json -Depth 10

Write-Host "Test Plan loaded with 2 test cases" -ForegroundColor Green
Write-Host "Target URL: https://www.qaplayground.com/login" -ForegroundColor Yellow

Write-Host "Sending request to backend..." -ForegroundColor Cyan

try {
    $response = Invoke-WebRequest `
        -Uri "http://127.0.0.1:3001/api/execute" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -UseBasicParsing `
        -TimeoutSec 300 `
        -ErrorAction Stop

    Write-Host "Response received!" -ForegroundColor Green

    $data = $response.Content | ConvertFrom-Json

    if ($data.success) {
        Write-Host "Test execution completed successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Summary:" -ForegroundColor Green
        Write-Host "   Total Tests: $($data.report.summary.total)"
        Write-Host "   Passed: $($data.report.summary.passed)" -ForegroundColor Green
        Write-Host "   Failed: $($data.report.summary.failed)" -ForegroundColor Red
        Write-Host "   Errors: $($data.report.summary.errors)" -ForegroundColor Red
        Write-Host ""
        
        # Show individual test results
        Write-Host "Test Results:" -ForegroundColor Green
        foreach ($result in $data.report.results) {
            Write-Host "   [$($result.status)] $($result.name) (Duration: $($result.duration)ms)"
            if ($result.error) {
                Write-Host "      Error: $($result.error)" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "Test execution failed!" -ForegroundColor Red
        Write-Host "   Error: $($data.error)" -ForegroundColor Red
    }

} catch {
    Write-Host "Request failed!" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
    
    # Try to extract response body
    if ($_.Exception.Response) {
        $streamReader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $errorBody = $streamReader.ReadToEnd()
        Write-Host "   Response: $errorBody" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Test execution complete!" -ForegroundColor Cyan
