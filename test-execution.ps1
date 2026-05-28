# Test Execution Script

Write-Host "🧪 Testing Complete E2E Flow" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Create test plan with URL in preconditions
$testPlan = @"
# Test Plan

## Test Cases

| Test Case Name | Jira Key | Priority | Preconditions | Test Data | Steps | Expected Result |
|---|---|---|---|---|---|---|
| Test Navigation | TEST-001 | High | User is on https://www.example.com/login page | Username: user@example.com | 1. Wait for page load<br>2. Verify navigation worked | Page should load successfully |
"@

$llmConfig = @{
    provider = "Ollama"
    baseUrl = "http://localhost:11434"
    model = "llama2"
} | ConvertTo-Json

$body = @{
    testCases = $testPlan
    llmConfig = $llmConfig
} | ConvertTo-Json -Depth 10

Write-Host "📋 Test Configuration:" -ForegroundColor Green
Write-Host "   URL in Preconditions: https://www.example.com/login" -ForegroundColor Yellow
Write-Host "   LLM Provider: Ollama (local)" -ForegroundColor Yellow
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
        -TimeoutSec 120 `
        -ErrorAction Stop

    Write-Host "✅ Response received!" -ForegroundColor Green
    Write-Host ""

    $data = $response.Content | ConvertFrom-Json

    if ($data.success) {
        Write-Host "✅ Test execution successful!" -ForegroundColor Green
        Write-Host ""
        Write-Host "📊 Summary:" -ForegroundColor Green
        Write-Host "   Total Tests: $($data.report.summary.total)"
        Write-Host "   Passed: $($data.report.summary.passed)" -ForegroundColor Green
        Write-Host "   Failed: $($data.report.summary.failed)" -ForegroundColor $(if($data.report.summary.failed -gt 0) { "Red" } else { "Green" })
        Write-Host "   Errors: $($data.report.summary.errors)" -ForegroundColor $(if($data.report.summary.errors -gt 0) { "Red" } else { "Green" })
        Write-Host "   Duration: $($data.report.summary.duration)ms"
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
Write-Host "Test complete!" -ForegroundColor Cyan
