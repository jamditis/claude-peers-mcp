# install-host-d-broker-task.ps1 — register the broker as a Windows scheduled task
# that runs at user logon, so it's always up without needing a persistent terminal.
#
# Usage (run as the user who'll use Claude Code, in elevated PowerShell):
#   .\install-host-d-broker-task.ps1
#
# This is OPTIONAL — install-host-d.ps1 leaves the broker as a manual-start
# process. Use this once you've confirmed the broker works end-to-end.

$ErrorActionPreference = "Stop"

$BUN = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
$BROKER = Join-Path $env:USERPROFILE "claude-peers-mcp\broker.ts"

if (-not (Test-Path $BUN)) { throw "Bun not found at $BUN — run install-host-d.ps1 first" }
if (-not (Test-Path $BROKER)) { throw "broker.ts not found at $BROKER — run install-host-d.ps1 first" }

$action = New-ScheduledTaskAction -Execute $BUN -Argument "`"$BROKER`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

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
