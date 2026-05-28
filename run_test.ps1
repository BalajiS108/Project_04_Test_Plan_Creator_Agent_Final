$testPlan = @"
| Test Case Name | Target Jira Issue | Preconditions | Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| Inspect Playground Page | QA-001 | Navigate to https://www.qaplayground.com | 1. Inspect the page content, 2. Look for sign up or login button, 3. Report what elements are visible | Page loads successfully | High |
"@

$payload = @{
    testCases = $testPlan
    llmConfig = @{
        provider = "Groq"
        model = "mixtral-8x7b-32768"
        apiKey = "gsk_test"
    }
} | ConvertTo-Json -Depth 10

Write-Host "🚀 Sending test request to backend..."
Write-Host "Test Plan:`n$testPlan`n"

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3001/api/execute" `
        -Method POST `
        -ContentType "application/json" `
        -Body $payload `
        -ErrorAction Stop

    Write-Host "✅ Response Status: $($response.StatusCode)" -ForegroundColor Green
    
    # Parse JSON response
    $json = $response.Content | ConvertFrom-Json
    Write-Host "`n📊 Summary:" -ForegroundColor Cyan
    Write-Host "   Total: $($json.summary.total)"
    Write-Host "   Passed: $($json.summary.passed)"
    Write-Host "   Failed: $($json.summary.failed)"
    Write-Host "   Errors: $($json.summary.errors)"
    
    Write-Host "`n📝 Results:" -ForegroundColor Cyan
    foreach ($result in $json.results) {
        Write-Host "   Test: $($result.name)"
        Write-Host "   Status: $($result.status)"
        if ($result.error) {
            Write-Host "   Error: $($result.error)"
        }
        Write-Host "   Actual Result: $($result.actualResult)" -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        Write-Host "Response: $($_.Exception.Response.StatusCode)"
    }
}
