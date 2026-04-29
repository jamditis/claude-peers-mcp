# install-a4000-broker-task.ps1 — register the broker as a Windows scheduled task
# that starts at user logon and KEEPS RUNNING after the user logs out.
#
# Uses LogonType S4U (Service-for-User): runs as the current user without
# storing a password, and continues after logoff. S4U has no network
# credentials, but the broker doesn't need them — it only listens on a local
# TCP port and reaches siblings by Tailscale IP.
#
# Must be run in an elevated PowerShell window (registering an S4U task
# requires admin rights).
#
# Usage:
#   .\install-a4000-broker-task.ps1
#
# This is OPTIONAL — install-a4000.ps1 leaves the broker as a manual-start
# process. Use this once you've confirmed the broker works end-to-end.

$ErrorActionPreference = "Stop"

$BUN = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
$BROKER = Join-Path $env:USERPROFILE "claude-peers-mcp\broker.ts"

if (-not (Test-Path $BUN)) { throw "Bun not found at $BUN — run install-a4000.ps1 first" }
if (-not (Test-Path $BROKER)) { throw "broker.ts not found at $BROKER — run install-a4000.ps1 first" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "Must be run in an elevated PowerShell window. Registering an S4U scheduled task requires admin rights."
}

$action = New-ScheduledTaskAction -Execute $BUN -Argument "`"$BROKER`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
# S4U keeps the task alive after the user logs out — Interactive would not.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask `
    -TaskName "claude-peers-broker" `
    -Description "Claude Peers broker daemon (MCP gossip + message routing)" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "Scheduled task 'claude-peers-broker' registered." -ForegroundColor Green
Write-Host "Starting it now..."
Start-ScheduledTask -TaskName "claude-peers-broker"
Start-Sleep -Seconds 3

$health = try { (Invoke-RestMethod -Uri "http://127.0.0.1:7899/health" -TimeoutSec 5) } catch { $null }
if ($health) {
    Write-Host "Broker is healthy: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} else {
    Write-Host "Broker did not respond on /health within 3s. Check 'Get-ScheduledTaskInfo -TaskName claude-peers-broker'." -ForegroundColor Yellow
}
