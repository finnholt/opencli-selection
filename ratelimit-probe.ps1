<#
  Buyin/selection rate-limit probe (Windows / PowerShell). Mirrors ratelimit-probe.sh.

  ASCII-only on purpose: Windows PowerShell 5.1 reads scripts as the system ANSI
  codepage (GBK on zh-CN), so any non-ASCII literal in the file would be mis-decoded
  and break parsing. Keep this file pure ASCII.

  What it does each run: call `opencli selection products`, count how many items came
  back with detail_ok=true, classify, append a row to probe.csv. Run it on a schedule
  for a few days to empirically find the rate-limit threshold.

  Logic: products only returns detail_ok=true rows, so
    got < requested -> some details were throttled/failed
    got == 0        -> whole batch blocked (likely risk control)

  Must run in an interactive, logged-in desktop session (Chrome + Browser Bridge
  extension + daemon all need to be live).

  Manual run (params win; each param falls back to its env var, then a default):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\ratelimit-probe.ps1 -ProfileId <id> [-Limit 3] [-LogDir D:\...]
  Env overrides still work: OPENCLI_PROFILE / PROBE_LIMIT / PROBE_TIMEOUT / OPENCLI_BIN / PROBE_LOG_DIR /
                            PROBE_TASK_NAME / PROBE_STOP_AFTER
#>

param(
  [string]$ProfileId = $(if ($env:OPENCLI_PROFILE) { $env:OPENCLI_PROFILE } else { '7jgudy3t' }),
  [int]   $Limit     = $(if ($env:PROBE_LIMIT)     { [int]$env:PROBE_LIMIT }   else { 3 }),
  [int]   $TimeoutS  = $(if ($env:PROBE_TIMEOUT)   { [int]$env:PROBE_TIMEOUT } else { 300 }),
  [string]$LogDir    = $(if ($env:PROBE_LOG_DIR)   { $env:PROBE_LOG_DIR }      else { 'D:\probe-logs\selection-ratelimit-probe' }),
  [string]$TaskName  = $env:PROBE_TASK_NAME,   # which scheduled task to auto-disable; empty on ad-hoc runs
  [int]   $StopAfter = $(if ($env:PROBE_STOP_AFTER) { [int]$env:PROBE_STOP_AFTER } else { 2 })
)

$ErrorActionPreference = 'Continue'

# Auto-stop target: $TaskName comes from -TaskName / $env:PROBE_TASK_NAME (set by
# register-probe-task.ps1). Empty on ad-hoc manual runs -> auto-stop never touches any task.
# Stops after $StopAfter consecutive "limited" runs (got < requested), default 2 (guards a flaky run).
$ProbeTaskName = $TaskName

# opencli is a Node CLI shim (opencli.cmd / extensionless shell script), NOT a Win32 .exe.
# Launching it directly via Start-Process fails with "%1 is not a valid Win32 application".
# So we invoke it through cmd.exe (/c), which resolves opencli.cmd on PATH for us.
# Override with $env:OPENCLI_BIN only if you point it at opencli.cmd (not the bare script).
$Invoke = if ($env:OPENCLI_BIN) { $env:OPENCLI_BIN } else { 'opencli' }

$RawDir = Join-Path $LogDir 'raw'
New-Item -ItemType Directory -Force -Path $RawDir | Out-Null

$Csv    = Join-Path $LogDir 'probe.csv'
$ts     = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$rawOut = Join-Path $RawDir "$stamp.stdout.json"
$rawErr = Join-Path $RawDir "$stamp.stderr.log"

# CSV header (only on first create)
if (-not (Test-Path $Csv)) {
  'ts,requested,got,duration_s,exit_code,verdict,note' | Out-File -FilePath $Csv -Encoding utf8
}

# ---- run once (System.Diagnostics.Process: reliable ExitCode + timeout; async read avoids pipe deadlock) ----
# NOTE: Start-Process -PassThru + redirect has a known bug where .ExitCode returns $null, which made
# every run misclassify as error(exit=). Use .NET Process directly so ExitCode is always captured.
$env:OPENCLI_PROFILE = $ProfileId
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $env:ComSpec    # cmd.exe -- valid Win32 app, resolves opencli.cmd on PATH
$psi.Arguments              = "/c $Invoke selection products --limit $Limit -f json"
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $true
# opencli (Node) emits UTF-8. Without these, .NET decodes the child's bytes using the
# console ANSI codepage (GBK/936 on zh-CN) -> Chinese product names become mojibake (luanma)
# in raw\*.json, the CSV note column, and break ConvertFrom-Json. Force UTF-8 decode.
$psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
$psi.StandardErrorEncoding  = New-Object System.Text.UTF8Encoding $false

$start = Get-Date
$p = [System.Diagnostics.Process]::Start($psi)
$outTask = $p.StandardOutput.ReadToEndAsync()   # read async so a full pipe buffer can't deadlock the child
$errTask = $p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit($TimeoutS * 1000)) {
  try { $p.Kill() } catch {}
  $exitCode = 124                               # timeout (GNU timeout convention)
} else {
  $exitCode = $p.ExitCode
}
$duration = [int]((Get-Date) - $start).TotalSeconds

$outText = $outTask.Result
$errText = $errTask.Result
Set-Content -Path $rawOut -Value $outText -Encoding utf8
Set-Content -Path $rawErr -Value $errText -Encoding utf8

# ---- parse result: how many items came back with detail_ok=true ----
$got = 0
try {
  $json = $outText | ConvertFrom-Json
  if ($json -is [System.Array]) {
    $got = ($json | Where-Object { $_.detail_ok -eq $true }).Count
  } elseif ($json -and $json.detail_ok -eq $true) {
    $got = 1
  }
} catch {
  $got = ([regex]::Matches($outText, '"detail_ok":true')).Count
}

# ---- classify: COUNT-BASED ONLY (do NOT keyword-scan the payload) ----
# The success payload legitimately contains words like "risk" (product_risk_tip) and "login",
# so the old keyword scan produced false captcha/auth verdicts that wrongly auto-disabled the task.
# got is the reliable signal:
#   got >= limit -> ok   |   got == 0 -> blocked (or crashed, if exit!=0)   |   else partial
$verdict =
  if     ($got -ge $Limit) { 'ok' }
  elseif ($got -eq 0)      { if ($exitCode -ne 0) { "error(exit=$exitCode)" } else { 'empty(all_dropped)' } }
  else                     { "partial($got/$Limit)" }

# last non-empty stderr line as note (strip commas/newlines, cap 120 chars)
$note = ''
if ($errText) {
  $lastLine = ($errText -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1)
  if ($lastLine) {
    $note = ($lastLine -replace ',', ';')
    $note = ($note -replace "`r", '' -replace "`n", '')
    if ($note.Length -gt 120) { $note = $note.Substring(0,120) }
  }
}

# ---- append CSV + console echo ----
"$ts,$Limit,$got,$duration,$exitCode,$verdict,$note" | Add-Content -Path $Csv -Encoding utf8
Write-Host "[$ts] requested=$Limit got=$got ${duration}s exit=$exitCode -> $verdict"

# ---- auto-stop on rate-limit ----
# A run is "limited" (rate-limit signal) when it returned fewer items than requested.
function Test-Limited([string]$v) { return ($v -match '^(empty|partial)') }

if ($ProbeTaskName) {
  $shouldStop = $false
  if (Test-Limited $verdict) {
    # need $StopAfter consecutive limited runs (including this one) to stop
    try {
      $recent = @(Import-Csv $Csv | Select-Object -Last $StopAfter)
      if ($recent.Count -ge $StopAfter -and -not ($recent | Where-Object { -not (Test-Limited $_.verdict) })) {
        $shouldStop = $true
      }
    } catch { }
  }
  if ($shouldStop) {
    try {
      Disable-ScheduledTask -TaskName $ProbeTaskName -ErrorAction Stop | Out-Null
      Write-Host "RATE-LIMITED ($verdict) -> disabled scheduled task '$ProbeTaskName'. Re-enable: Enable-ScheduledTask -TaskName $ProbeTaskName"
    } catch {
      Write-Host "WARN: rate-limited but failed to disable task '$ProbeTaskName': $_"
    }
  }
}
