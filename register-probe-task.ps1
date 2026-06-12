<#
  Register a rate-limit probe as a Windows Scheduled Task: run once now, then every N minutes.

  Parameterized so you can register MULTIPLE independent probes (e.g. different accounts /
  different cadences) side by side -- each with its own task name, profile, and log dir.

  ASCII-only on purpose (Windows PowerShell 5.1 mis-decodes non-ASCII script literals on zh-CN).

  Key points (mirror the macOS LaunchAgent notes):
    1. Interactive logon only -- browser automation needs a real desktop/GUI session.
       Do NOT use "run whether user is logged on or not" (session 0, Chrome unreachable).
    2. A scheduled task does NOT inherit $env:* from your shell, so profile / limit / log dir
       are baked into the task action here.

  Examples (run from the repo dir, normal PowerShell, no admin needed):

    # Task A: account-1, every 60 min, 3 items
    .\register-probe-task.ps1 -ProfileId <profileA> -TaskName SelectionProbeA -IntervalMinutes 60 -Limit 3

    # Task B: account-2, every 30 min, 3 items
    .\register-probe-task.ps1 -ProfileId <profileB> -TaskName SelectionProbeB -IntervalMinutes 30 -Limit 3

  Each task writes to its own folder: D:\probe-logs\<TaskName>\probe.csv (override with -LogDir).
  Delete a task: Unregister-ScheduledTask -TaskName <TaskName> -Confirm:$false
#>

param(
  [Parameter(Mandatory = $true)] [string]$ProfileId,     # opencli profile (account) for THIS task
  [string]$TaskName        = 'SelectionRateLimitProbe',  # unique per task
  [int]   $IntervalMinutes = 60,                         # 60 = hourly, 30 = every half hour
  [int]   $Limit           = 3,                          # items per run
  [string]$LogDir          = '',                         # default: D:\probe-logs\<TaskName>
  [int]   $StopAfter        = 2                          # auto-stop after N consecutive limited runs
)

$ScriptPath = Join-Path $PSScriptRoot 'ratelimit-probe.ps1'
if (-not (Test-Path $ScriptPath)) {
  throw "Probe script not found: $ScriptPath"
}

# Default each task to its own folder on D: so CSVs/raw from different tasks/accounts never mix
if (-not $LogDir) {
  $LogDir = Join-Path 'D:\probe-logs' $TaskName
}

# Idempotent: remove an existing task with the same name first
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed existing task $TaskName, re-registering..."
}

# Action: run the probe via powershell, baking profile / limit / log dir into the command
# (a scheduled task does not inherit env vars from the shell that registered it)
# PROBE_TASK_NAME lets the probe disable THIS task when it detects rate-limiting (auto-stop)
$envSet = "`$env:OPENCLI_PROFILE='$ProfileId'; `$env:PROBE_LIMIT='$Limit'; `$env:PROBE_LOG_DIR='$LogDir'; `$env:PROBE_TASK_NAME='$TaskName'; `$env:PROBE_STOP_AFTER='$StopAfter';"
$inner  = "$envSet & '$ScriptPath'"
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`""

# Trigger: starting now, repeat every IntervalMinutes, indefinitely (empty duration = forever)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

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
  -Description "Selection rate-limit probe ($TaskName): profile=$ProfileId, every ${IntervalMinutes}min, limit=$Limit" | Out-Null

Write-Host "Registered $TaskName  (profile=$ProfileId, every ${IntervalMinutes}min, limit=$Limit)"
Write-Host "Log dir: $LogDir"

# Kick off the first run to verify the chain
Start-ScheduledTask -TaskName $TaskName
Write-Host "Started first run. Check the CSV in ~30-40s:"
Write-Host "  Get-Content `"$LogDir\probe.csv`""

<#
  ---- ops commands (replace <TaskName> with SelectionProbeA / SelectionProbeB / ...) ----
  Show task:    Get-ScheduledTask -TaskName <TaskName>
  Last result:  Get-ScheduledTaskInfo -TaskName <TaskName>
  Run now:      Start-ScheduledTask -TaskName <TaskName>
  Disable:      Disable-ScheduledTask -TaskName <TaskName>
  Enable:       Enable-ScheduledTask  -TaskName <TaskName>
  Delete:       Unregister-ScheduledTask -TaskName <TaskName> -Confirm:$false
  List probes:  Get-ScheduledTask | Where-Object TaskName -like 'Selection*'
#>
