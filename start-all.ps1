# Start backend and frontend for Test Plan Creator

Write-Host "🚀 Starting Test Plan Creator (Frontend + Backend)" -ForegroundColor Green
Write-Host ""

# Start backend server in a new window
Write-Host "📦 Starting Backend Server (Port 3001)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Command `"cd '$(Get-Location)\backend'; npm start`"" -WindowStyle Minimized

# Wait for backend to start
Start-Sleep -Seconds 3

# Start frontend dev server in a new window
Write-Host "🎨 Starting Frontend Dev Server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Command `"cd '$(Get-Location)'; npm run dev`"" -WindowStyle Normal

Write-Host ""
Write-Host "✅ Both servers should be starting..." -ForegroundColor Green
Write-Host "   Frontend: http://localhost:5173" -ForegroundColor Yellow
Write-Host "   Backend:  http://localhost:3001" -ForegroundColor Yellow
Write-Host ""
Write-Host "📝 Open the frontend URL in your browser to use the application." -ForegroundColor Green
