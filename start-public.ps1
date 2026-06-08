<#
  start-public.ps1 — one-command launcher for free self-hosting.

  Runs the backend on http://localhost:3001 (in its own window so you can see
  the logs) and exposes it to the public internet via a FREE Cloudflare quick
  tunnel (https://<random>.trycloudflare.com). It prints the public URL to
  paste into the frontend's VITE_BACKEND_URL.

  Prerequisites (one-time):
    1. Node.js installed         (https://nodejs.org)
    2. cloudflared installed:    winget install --id Cloudflare.cloudflared

  Usage:
    powershell -ExecutionPolicy Bypass -File .\start-public.ps1

  Notes:
    - The quick-tunnel URL CHANGES every run. Each time you start this, update
      VITE_BACKEND_URL in your frontend host (Vercel) and redeploy.
    - Auth is ON (backend/.env has AUTH_ENABLED=true). On first run, register
      your admin user via the login screen's first-time setup.
    - Press Ctrl+C in this window to stop the tunnel. Close the backend window
      to stop the backend.
#>

$ErrorActionPreference = 'Stop'
$root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root 'backend'
$port       = 3001
$healthUrl  = "http://localhost:$port/api/health"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ── Preflight: required tools ────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Install it from https://nodejs.org and retry." -ForegroundColor Red
    exit 1
}
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "cloudflared not found. Install it once with:" -ForegroundColor Yellow
    Write-Host "    winget install --id Cloudflare.cloudflared" -ForegroundColor Cyan
    exit 1
}

# ── First-run: install backend deps + Chromium ───────────────────────────────
if (-not (Test-Path (Join-Path $backendDir 'node_modules'))) {
    Write-Step "Installing backend dependencies (first run only)..."
    Push-Location $backendDir
    npm install
    npx playwright install chromium
    Pop-Location
}

# ── Start the backend in its own visible window ──────────────────────────────
Write-Step "Starting backend on http://localhost:$port (separate window)..."
Start-Process -FilePath 'powershell' -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$backendDir'; Write-Host 'Backend (Ctrl+C or close window to stop)' -ForegroundColor Green; npm start"
) | Out-Null

# ── Wait for the backend to answer /api/health ───────────────────────────────
Write-Step "Waiting for the backend to come up..."
$up = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $up = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) {
    Write-Host "Backend did not respond on $healthUrl within 60s. Check the backend window for errors." -ForegroundColor Red
    exit 1
}
Write-Host "Backend is up." -ForegroundColor Green

# ── Start the Cloudflare quick tunnel and capture the public URL ─────────────
Write-Step "Opening a free Cloudflare quick tunnel..."
$logOut = Join-Path $env:TEMP 'cloudflared-testplan.out.log'
$logErr = Join-Path $env:TEMP 'cloudflared-testplan.err.log'
foreach ($f in @($logOut, $logErr)) { if (Test-Path $f) { Remove-Item $f -Force } }

$tunnel = Start-Process -FilePath 'cloudflared' `
    -ArgumentList @('tunnel', '--url', "http://localhost:$port") `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
    -PassThru -WindowStyle Hidden

$publicUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $lines = @()
    if (Test-Path $logOut) { $lines += Get-Content $logOut -ErrorAction SilentlyContinue }
    if (Test-Path $logErr) { $lines += Get-Content $logErr -ErrorAction SilentlyContinue }
    $match = $lines | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
    if ($match) { $publicUrl = $match.Matches[0].Value; break }
}

if (-not $publicUrl) {
    Write-Host "Could not detect the tunnel URL. See $logErr for details." -ForegroundColor Red
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
    exit 1
}

# ── Show the result ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Public backend URL:" -ForegroundColor Green
Write-Host "   $publicUrl" -ForegroundColor White
Write-Host ""
Write-Host " Next: set this in your frontend host (Vercel) and redeploy:" -ForegroundColor Green
Write-Host "   VITE_BACKEND_URL = $publicUrl" -ForegroundColor White
Write-Host ""
Write-Host " (This URL changes every run. Auth is ON — register your admin" -ForegroundColor DarkGray
Write-Host "  on first login.)" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Tunnel is running. Press Ctrl+C here to stop it." -ForegroundColor Yellow

# ── Keep running until Ctrl+C, then clean up the tunnel ───────────────────────
try {
    Wait-Process -Id $tunnel.Id
} finally {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
    Write-Host "`nTunnel stopped. (The backend window stays open — close it to stop the backend.)" -ForegroundColor Yellow
}
