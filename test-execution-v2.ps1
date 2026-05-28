# Test Execution Script - Testing tool parameter fixes

Write-Host "🧪 Testing Tool Parameter Fixes" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Create test plan with real test cases that require element interaction
$testPlan = @"
# QA Playground Login Test Plan

## Test Cases

| Test Case Name | Jira Key | Priority | Preconditions | Test Data | Steps | Expected Result |
|---|---|---|---|---|---|---|
| KAN-5-1: Valid Login | KAN-5 | High | User is on https://www.qaplayground.com/login | User ID: test, Pass: pass | 1. Enter username 'test' in email field<br>2. Enter password 'pass' in password field<br>3. Click Login button | User should be logged in and redirected to dashboard |
| KAN-5-2: Invalid Email | KAN-5 | High | User is on https://www.qaplayground.com/login | Email: invalid@test, Pass: test123 | 1. Enter email 'invalid@test' in email field<br>2. Enter password 'test123' in password field<br>3. Click Login button | Error message should display indicating invalid credentials |
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

Write-Host "📋 Test Plan:" -ForegroundColor Green
Write-Host "   - KAN-5-1: Valid Login Test" -ForegroundColor Yellow
Write-Host "   - KAN-5-2: Invalid Email Test" -ForegroundColor Yellow
Write-Host "   Target URL: https://www.qaplayground.com/login" -ForegroundColor Yellow
Write-Host ""

Write-Host "📤 Sending request to http://127.0.0.1:3001/api/execute" -ForegroundColor Cyan
Write-Host ""

try {
    $response = Invoke-WebRequest `
        -Uri "http://127.0.0.1:3001/api/execute" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -UseBasicParsing `
        -TimeoutSec 300 `
        -ErrorAction Stop

    Write-Host "✅ Response received!" -ForegroundColor Green
    Write-Host ""

    $data = $response.Content | ConvertFrom-Json

    if ($data.success) {
        Write-Host "✅ Test execution completed!" -ForegroundColor Green
        Write-Host ""
        Write-Host "📊 Summary:" -ForegroundColor Green
        Write-Host "   Total Tests: $($data.report.summary.total)"
        Write-Host "   Passed: $($data.report.summary.passed)" -ForegroundColor Green
        Write-Host "   Failed: $($data.report.summary.failed)" -ForegroundColor $(if($data.report.summary.failed -gt 0) { "Red" } else { "Green" })
        Write-Host "   Errors: $($data.report.summary.errors)" -ForegroundColor $(if($data.report.summary.errors -gt 0) { "Red" } else { "Green" })
        Write-Host "   Duration: $($data.report.summary.duration)ms"
        Write-Host ""
        
        # Show individual test results
        Write-Host "📋 Test Results:" -ForegroundColor Green
        foreach ($result in $data.report.results) {
            $status = $result.status
            $statusColor = switch($status) {
                "PASS" { "Green" }
                "FAIL" { "Red" }
                "ERROR" { "Red" }
                default { "Yellow" }
            }
            Write-Host "   [$status] $($result.name) (Duration: $($result.duration)ms)" -ForegroundColor $statusColor
            if ($result.error) {
                Write-Host "      Error: $($result.error)" -ForegroundColor Red
            }
            if ($result.actualResult) {
                Write-Host "      Result: $($result.actualResult)" -ForegroundColor Gray
            }
        }
        
        Write-Host ""
        Write-Host "📥 Report Download: $($data.reportDownloadUrl)" -ForegroundColor Cyan
    } else {
        Write-Host "❌ Test execution failed!" -ForegroundColor Red
        Write-Host "   Error: $($data.error)" -ForegroundColor Red
    }

} catch {
    Write-Host "❌ Request failed!" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
    
    # Try to extract response body
    if ($_.Exception.Response) {
        $streamReader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $errorBody = $streamReader.ReadToEnd()
        Write-Host "   Response: $errorBody" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "Test execution complete!" -ForegroundColor Cyan
