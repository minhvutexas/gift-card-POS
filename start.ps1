# Gift Card POS - one-click launcher (called by start.bat)
# Starts: database (embedded Postgres :5433) -> API (:4000) -> web app (:5173), then opens the browser.
# Anything already running is reused, so double-clicking twice is safe.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$api  = Join-Path $root 'api'
$web  = Join-Path $root 'web'
$url  = 'http://localhost:5173'
$dbUrl = 'postgres://postgres:postgres@localhost:5433/giftcard'

function Test-Port([int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

function Wait-Port([int]$port, [string]$name, [int]$seconds = 120) {
    Write-Host "  waiting for $name" -NoNewline
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Test-Port $port) { Write-Host " ready" -ForegroundColor Green; return }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ''
    throw "$name did not start on port $port. Check its window for errors."
}

function Start-Service([string]$title, [string]$dir, [string]$command) {
    # Each service gets its own minimized window; close that window to stop it.
    $cmd = "title $title && cd /d `"$dir`" && $command"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $cmd -WindowStyle Minimized | Out-Null
}

Write-Host ''
Write-Host '  Gift Card POS' -ForegroundColor Magenta
Write-Host '  -------------'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed. Install the LTS version from https://nodejs.org and try again.'
}

# First run: install dependencies
foreach ($dir in @($api, $web)) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Host "  installing packages in $(Split-Path -Leaf $dir) (first run only)..."
        Push-Location $dir
        try { npm install --no-audit --no-fund | Out-Host } finally { Pop-Location }
    }
}

# 1) Database
if (Test-Port 5433) { Write-Host '  database already running' }
else {
    Write-Host '  starting database...'
    Start-Service 'GiftCard - Database (keep open)' $api 'npm run db:embedded'
    Wait-Port 5433 'database' 180
    Start-Sleep -Seconds 4   # let the schema check finish
}

# 2) API
if (Test-Port 4000) { Write-Host '  API already running' }
else {
    Write-Host '  starting API...'
    Start-Service 'GiftCard - API (keep open)' $api "set `"DATABASE_URL=$dbUrl`" && set `"PORT=4000`" && npm run dev"
    Wait-Port 4000 'API' 120
}

# 3) Web app
if (Test-Port 5173) { Write-Host '  web app already running' }
else {
    Write-Host '  starting web app...'
    Start-Service 'GiftCard - Web (keep open)' $web 'npx vite --port 5173 --strictPort'
    Wait-Port 5173 'web app' 120
}

Write-Host "  opening $url" -ForegroundColor Green
Start-Process $url
Start-Sleep -Seconds 2
