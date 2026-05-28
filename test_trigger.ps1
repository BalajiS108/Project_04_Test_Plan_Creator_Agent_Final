$testPlan = @"
| Test Case Name | Target Jira Issue | Preconditions | Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| Login Test | JIRA-001 | Navigate to https://www.qaplayground.com/login | 1. Enter email, 2. Enter password, 3. Click login | Login successful | High |
"@

$payload = @{
    testCases = $testPlan
    llmConfig = @{
        provider = "Groq"
        model = "mixtral-8x7b-32768"
        apiKey = "test-key"
    }
} | ConvertTo-Json

Write-Host "Sending test request to backend..."
Write-Host "Payload:`n$payload`n"

$response = Invoke-WebRequest -Uri "http://localhost:3001/api/execute" `
    -Method POST `
    -ContentType "application/json" `
    -Body $payload `
    -ErrorAction Continue

Write-Host "Response Status: $($response.StatusCode)"
Write-Host "Response Body:`n$($response.Content)" | Select-Object -First 100
