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

  Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File .\ratelimit-probe.ps1
  Env overrides: OPENCLI_PROFILE / PROBE_LIMIT / PROBE_TIMEOUT / OPENCLI_BIN / PROBE_LOG_DIR
#>

$ErrorActionPreference = 'Continue'

# ---- tunables (env wins) ----
$ProfileId = if ($env:OPENCLI_PROFILE) { $env:OPENCLI_PROFILE } else { '7jgudy3t' }
$Limit     = if ($env:PROBE_LIMIT)     { [int]$env:PROBE_LIMIT } else { 3 }
$TimeoutS  = if ($env:PROBE_TIMEOUT)   { [int]$env:PROBE_TIMEOUT } else { 300 }
$LogDir    = if ($env:PROBE_LOG_DIR)   { $env:PROBE_LOG_DIR } else { 'D:\probe-logs\selection-ratelimit-probe' }

# Auto-stop: when rate-limited, disable this probe's scheduled task so we stop hammering the account.
# $TaskName is set by register-probe-task.ps1 (empty on manual runs -> never touches any task).
# Hard signals (captcha/auth) stop immediately; soft signals (empty/partial) stop after
# $StopAfter consecutive non-ok runs (default 2, guards against a single flaky run).
$ProbeTaskName = $env:PROBE_TASK_NAME
$StopAfter     = if ($env:PROBE_STOP_AFTER) { [int]$env:PROBE_STOP_AFTER } else { 2 }

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

# ---- run once (with timeout, stdout/stderr redirected separately) ----
$env:OPENCLI_PROFILE = $ProfileId
# cmd.exe /c <opencli> selection products ... -- cmd.exe IS a valid Win32 app and resolves the .cmd
$cmdArgs = @('/c', $Invoke, 'selection', 'products', '--limit', "$Limit", '-f', 'json')

$start = Get-Date
$proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgs `
  -RedirectStandardOutput $rawOut -RedirectStandardError $rawErr `
  -NoNewWindow -PassThru

if (-not $proc.WaitForExit($TimeoutS * 1000)) {
  try { $proc.Kill() } catch {}
  $exitCode = 124   # timeout, same convention as GNU timeout
} else {
  $exitCode = $proc.ExitCode
}
$duration = [int]((Get-Date) - $start).TotalSeconds

# ---- parse result ----
$got = 0
$outText = ''
if (Test-Path $rawOut) { $outText = Get-Content -Raw -Encoding utf8 $rawOut }
try {
  $json = $outText | ConvertFrom-Json
  if ($json -is [System.Array]) {
    $got = ($json | Where-Object { $_.detail_ok -eq $true }).Count
  } elseif ($json -and $json.detail_ok -eq $true) {
    $got = 1
  }
} catch {
  # not valid JSON (likely whole batch failed): fall back to counting the marker
  $got = ([regex]::Matches($outText, '"detail_ok":true')).Count
}

$errText = ''
if (Test-Path $rawErr) { $errText = Get-Content -Raw -Encoding utf8 $rawErr }
$blob = "$outText`n$errText"

# Classify. The masked page error "network unstable" usually shows up as got=0 here,
# so we lean on the count + a few ASCII markers rather than matching Chinese text.
$verdict = ''
if     ($blob -match 'AuthRequired|not.?login|-1025|relogin|re-login') { $verdict = 'auth(login_lost)' }
elseif ($blob -match 'captcha|verify|slider|risk')                     { $verdict = 'captcha(risk)' }
elseif ($exitCode -ne 0) { $verdict = "error(exit=$exitCode)" }
elseif ($got -eq 0)      { $verdict = 'empty(all_dropped)' }
elseif ($got -lt $Limit) { $verdict = "partial($got/$Limit)" }
else                     { $verdict = 'ok' }

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
# A run counts as "limited" if it's a throttle/risk signal (not ok, not a generic tool error).
function Test-Limited([string]$v) { return ($v -match '^(empty|partial|captcha|auth)') }

if ($ProbeTaskName) {
  $hardStop = ($verdict -match '^(captcha|auth)')   # risk control / login lost -> stop immediately
  $softStop = $false
  if ((Test-Limited $verdict) -and (-not $hardStop)) {
    # need $StopAfter consecutive limited runs (including this one) to stop
    try {
      $recent = @(Import-Csv $Csv | Select-Object -Last $StopAfter)
      if ($recent.Count -ge $StopAfter -and -not ($recent | Where-Object { -not (Test-Limited $_.verdict) })) {
        $softStop = $true
      }
    } catch { }
  }
  if ($hardStop -or $softStop) {
    try {
      Disable-ScheduledTask -TaskName $ProbeTaskName -ErrorAction Stop | Out-Null
      Write-Host "RATE-LIMITED ($verdict) -> disabled scheduled task '$ProbeTaskName'. Re-enable: Enable-ScheduledTask -TaskName $ProbeTaskName"
    } catch {
      Write-Host "WARN: rate-limited but failed to disable task '$ProbeTaskName': $_"
    }
  }
}
