# install-a4000.ps1 — onboard A4000 (Windows) to claude-peers
#
# Usage (run in PowerShell, NOT cmd.exe):
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\install-a4000.ps1
#
# Or directly from GitHub once committed + pushed:
#   irm https://raw.githubusercontent.com/jamditis/claude-peers-mcp/main/deploy/install-a4000.ps1 | iex
#
# What it does (in order):
#   0. Verifies preconditions: git available, running elevated
#   1. Installs Bun if missing
#   2. Clones jamditis/claude-peers-mcp if missing
#   3. Runs `bun install`
#   4. Copies deploy/configs/a4000.json to %USERPROFILE%\.claude-peers.json
#   5. Adds Windows Firewall rule for inbound TCP 7899, restricted to sibling IPs
#   6. Registers the MCP server with Claude Code
#   7. Prints next steps to start the broker (manual for now; Task Scheduler later)
#
# Must be run in an elevated PowerShell window (step 5 needs admin rights to
# create the firewall rule).

$ErrorActionPreference = "Stop"

$REPO_PATH = Join-Path $env:USERPROFILE "claude-peers-mcp"
$REPO_URL = "https://github.com/jamditis/claude-peers-mcp.git"
$CONFIG_TARGET = Join-Path $env:USERPROFILE ".claude-peers.json"
$BUN_BIN = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"

Write-Host "===== claude-peers A4000 install =====" -ForegroundColor Cyan
Write-Host ""

# 0. Preconditions: git installed, elevated shell
Write-Host "[0/7] Checking preconditions..." -ForegroundColor Yellow
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git not found in PATH. Install it first (e.g. ``winget install --id Git.Git -e``) and re-run this script."
}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "Must be run in an elevated PowerShell window (right-click PowerShell -> Run as administrator). Step 5 (firewall rule) requires admin rights."
}
Write-Host "      git available, running elevated" -ForegroundColor Green

# 1. Install Bun if missing
if (-not (Test-Path $BUN_BIN)) {
    Write-Host "[1/7] Installing Bun..." -ForegroundColor Yellow
    powershell -c "irm bun.com/install.ps1 | iex"
    if (-not (Test-Path $BUN_BIN)) {
        throw "Bun install failed — $BUN_BIN not present after install"
    }
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
} else {
    Write-Host "[1/7] Bun already installed at $BUN_BIN" -ForegroundColor Green
}

# 2. Clone repo if missing
if (-not (Test-Path $REPO_PATH)) {
    Write-Host "[2/7] Cloning $REPO_URL to $REPO_PATH..." -ForegroundColor Yellow
    git clone $REPO_URL $REPO_PATH
} else {
    Write-Host "[2/7] Repo already at $REPO_PATH — pulling latest..." -ForegroundColor Green
    Push-Location $REPO_PATH
    git pull --ff-only
    Pop-Location
}

# 3. Install deps
Write-Host "[3/7] Running bun install..." -ForegroundColor Yellow
Push-Location $REPO_PATH
& $BUN_BIN install
Pop-Location

# 4. Install config
$SOURCE_CONFIG = Join-Path $REPO_PATH "deploy\configs\a4000.json"
if (-not (Test-Path $SOURCE_CONFIG)) {
    throw "Source config missing: $SOURCE_CONFIG (repo may be out of date — git pull)"
}
if (Test-Path $CONFIG_TARGET) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$CONFIG_TARGET.bak.$stamp"
    Copy-Item $CONFIG_TARGET $backup
    Write-Host "[4/7] Existing config backed up to $backup" -ForegroundColor Yellow
}
Copy-Item $SOURCE_CONFIG $CONFIG_TARGET -Force
Write-Host "[4/7] Config installed to $CONFIG_TARGET" -ForegroundColor Green

# 5. Reconcile Windows Firewall rule for inbound TCP 7899 from sibling brokers.
# Always remove + recreate so re-runs apply current sibling list and any
# stricter settings — skipping when the rule exists would leave stale (or
# over-broad) rules from older script versions in place.
Write-Host "[5/7] Reconciling Windows Firewall rule for inbound TCP 7899..." -ForegroundColor Yellow

# Derive sibling IPs from the same config the broker uses for its allowlist,
# so the firewall rule and the broker stay in sync.
$cfg = Get-Content $SOURCE_CONFIG -Raw | ConvertFrom-Json
$siblingIps = @($cfg.siblings | ForEach-Object { ([Uri]$_.url).Host }) |
    Where-Object { $_ -and $_ -ne $cfg.tailscale_ip }
if ($siblingIps.Count -eq 0) {
    throw "No sibling IPs parsed from $SOURCE_CONFIG — refusing to open firewall with no remote-address restriction."
}

$existing = Get-NetFirewallRule -DisplayName "claude-peers-broker" -ErrorAction SilentlyContinue
if ($existing) {
    Remove-NetFirewallRule -DisplayName "claude-peers-broker"
    Write-Host "      Removed existing rule(s) for reconciliation" -ForegroundColor Yellow
}

New-NetFirewallRule `
    -DisplayName "claude-peers-broker" `
    -Description "Inbound gossip from sibling brokers (claude-peers MCP). Restricted to sibling Tailscale IPs." `
    -Direction Inbound -Protocol TCP -LocalPort 7899 `
    -RemoteAddress $siblingIps `
    -Action Allow -Profile Any | Out-Null
Write-Host "      Rule applied (RemoteAddress = $($siblingIps -join ', '))" -ForegroundColor Green

# 6. Register MCP with Claude Code
$SERVER_TS = Join-Path $REPO_PATH "server.ts"
Write-Host "[6/7] Registering MCP server with Claude Code..." -ForegroundColor Yellow
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) {
    Write-Host "      WARNING: 'claude' CLI not in PATH. Skip registration; do it manually:" -ForegroundColor Yellow
    Write-Host "      claude mcp add --scope user --transport stdio claude-peers -- `"$BUN_BIN`" `"$SERVER_TS`""
} else {
    # Use absolute $BUN_BIN — bun may not be on PATH yet in a fresh shell.
    & claude mcp add --scope user --transport stdio claude-peers -- "$BUN_BIN" "$SERVER_TS"
    Write-Host "      Registered" -ForegroundColor Green
}

# 7. Print next steps
Write-Host ""
Write-Host "[7/7] Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "===== Next steps =====" -ForegroundColor Cyan
Write-Host ""
Write-Host "Start the broker (manual for now — leave this window open):" -ForegroundColor White
Write-Host "  & '$BUN_BIN' '$REPO_PATH\broker.ts'"
Write-Host ""
Write-Host "In a SECOND terminal, verify:" -ForegroundColor White
Write-Host "  curl http://127.0.0.1:7899/health"
Write-Host "  cd '$REPO_PATH'; & '$BUN_BIN' cli.ts ping-siblings"
Write-Host ""
Write-Host "To make broker permanent (run as scheduled task at logon):" -ForegroundColor White
Write-Host "  See deploy\install-a4000-broker-task.ps1 (separate script)"
Write-Host ""
Write-Host "Once broker is up, in any new Claude Code session, you can:" -ForegroundColor White
Write-Host "  - List peers across the tailnet"
Write-Host "  - Send messages to houseofjawn (hoj-*), officejawn (ofj-*), legion2025 (leg-*)"
Write-Host "  - Be reachable as a40-* peer ID"
