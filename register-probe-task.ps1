<#
  Register the rate-limit probe as a Windows Scheduled Task: run once now, then every N hours.

  ASCII-only on purpose (Windows PowerShell 5.1 mis-decodes non-ASCII script literals on zh-CN).

  Key points (mirror the macOS LaunchAgent notes):
    1. Run only when the user is logged on (Interactive). Browser automation needs a real
       desktop/GUI session. Do NOT switch to "run whether user is logged on or not"
       (that is session 0 -- Chrome/extension are unreachable there).
    2. WakeToRun: allow waking the machine to run; still better to disable deep sleep
       in power settings during the test.

  Usage (from the repo dir, normal PowerShell, no admin needed):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\register-probe-task.ps1

  Change frequency via $IntervalHours. Delete the task: see bottom of file.
#>

$TaskName      = 'SelectionRateLimitProbe'
$IntervalHours = 1
$ScriptPath    = Join-Path $PSScriptRoot 'ratelimit-probe.ps1'

if (-not (Test-Path $ScriptPath)) {
  throw "Probe script not found: $ScriptPath"
}

# Idempotent: remove an existing task first
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed existing task $TaskName, re-registering..."
}

# Action: run the probe via powershell
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Trigger: starting now, repeat every IntervalHours, indefinitely
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

# Settings: allow wake, catch up if missed, run on battery (do not skip during the test)
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# Current user, interactive logon only (need a GUI to reach Chrome)
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Selection rate-limit probe: run now + every hour, logs to probe.csv' | Out-Null

Write-Host "Registered task $TaskName (run now + every $IntervalHours h)."

# Kick off the first run to verify the chain
Start-ScheduledTask -TaskName $TaskName
Write-Host "Started first run. Check the CSV in ~30-40s:"
Write-Host "  Get-Content `"$env:USERPROFILE\selection-ratelimit-probe\probe.csv`""

<#
  ---- ops commands ----
  Show task:    Get-ScheduledTask -TaskName SelectionRateLimitProbe
  Last result:  Get-ScheduledTaskInfo -TaskName SelectionRateLimitProbe
  Run now:      Start-ScheduledTask -TaskName SelectionRateLimitProbe
  Disable:      Disable-ScheduledTask -TaskName SelectionRateLimitProbe
  Enable:       Enable-ScheduledTask  -TaskName SelectionRateLimitProbe
  Delete:       Unregister-ScheduledTask -TaskName SelectionRateLimitProbe -Confirm:$false
#>
