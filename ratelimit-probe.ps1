<#
  百应限流探针(Windows / PowerShell 版)—— 对齐 ratelimit-probe.sh 的逻辑。

  每次跑一小批 products 详情,把「成功/被风控/报错」结构化记进 CSV,
  跑几天后看 CSV 就能经验性地摸出限流阈值。

  判定:products 只返回 detail_ok=true 的条目,所以
    got < requested -> 有详情被限流/失败
    got == 0        -> 整批被拦(多半风控)
  再扫 stdout+stderr 文案给分类标签(网络不稳定/滑块/登录失效)。

  ⚠️ 必须在「已登录的交互桌面会话」里跑(Chrome + Browser Bridge 扩展 + daemon 都要在)。
     所以计划任务要设成「仅在用户登录时运行」,不要勾「不管用户是否登录都运行」(那是 session 0,无 GUI)。

  手动跑:  powershell -NoProfile -ExecutionPolicy Bypass -File .\ratelimit-probe.ps1
  可用环境变量覆盖:OPENCLI_PROFILE / PROBE_LIMIT / PROBE_TIMEOUT / OPENCLI_BIN / PROBE_LOG_DIR
#>

$ErrorActionPreference = 'Continue'

# ── 可调参数(环境变量优先)──
$Profile_  = if ($env:OPENCLI_PROFILE) { $env:OPENCLI_PROFILE } else { '7jgudy3t' }
$Limit     = if ($env:PROBE_LIMIT)     { [int]$env:PROBE_LIMIT } else { 3 }
$TimeoutS  = if ($env:PROBE_TIMEOUT)   { [int]$env:PROBE_TIMEOUT } else { 300 }
$LogDir    = if ($env:PROBE_LOG_DIR)   { $env:PROBE_LOG_DIR } else { Join-Path $env:USERPROFILE 'selection-ratelimit-probe' }

# opencli 可执行文件:优先环境变量,否则从 PATH 解析(Windows 上通常是 opencli.cmd)
$Bin = $env:OPENCLI_BIN
if (-not $Bin) {
  $cmd = Get-Command opencli -ErrorAction SilentlyContinue
  if ($cmd) { $Bin = $cmd.Source } else { $Bin = 'opencli' }
}

$RawDir = Join-Path $LogDir 'raw'
New-Item -ItemType Directory -Force -Path $RawDir | Out-Null

$Csv      = Join-Path $LogDir 'probe.csv'
$ts       = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$rawOut   = Join-Path $RawDir "$stamp.stdout.json"
$rawErr   = Join-Path $RawDir "$stamp.stderr.log"

# CSV 表头(只在首次创建时写;用 UTF8 以正确存中文)
if (-not (Test-Path $Csv)) {
  'ts,requested,got,duration_s,exit_code,verdict,note' | Out-File -FilePath $Csv -Encoding utf8
}

# ── 跑一次(带超时 + 分别重定向 stdout/stderr)──
$env:OPENCLI_PROFILE = $Profile_
$args = @('selection','products','--limit', "$Limit", '-f','json')

$start = Get-Date
$proc = Start-Process -FilePath $Bin -ArgumentList $args `
  -RedirectStandardOutput $rawOut -RedirectStandardError $rawErr `
  -NoNewWindow -PassThru

if (-not $proc.WaitForExit($TimeoutS * 1000)) {
  try { $proc.Kill() } catch {}
  $exitCode = 124   # 超时,约定用 124(同 GNU timeout)
} else {
  $exitCode = $proc.ExitCode
}
$duration = [int]((Get-Date) - $start).TotalSeconds

# ── 解析结果 ──
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
  # 不是合法 JSON(多半整批失败):退化成数 "detail_ok":true 出现次数
  $got = ([regex]::Matches($outText, '"detail_ok":true')).Count
}

$errText = ''
if (Test-Path $rawErr) { $errText = Get-Content -Raw -Encoding utf8 $rawErr }
$blob = "$outText`n$errText"

# 扫文案给分类标签
$verdict = ''
if     ($blob -match '网络不稳定|网络异常|网络开小差') { $verdict = 'net_unstable(疑风控)' }
elseif ($blob -match '滑块|验证码|captcha|verify|安全验证') { $verdict = 'captcha(风控)' }
elseif ($blob -match '登录失效|未登录|not.?login|AuthRequired|请重新登录') { $verdict = 'auth(登录态丢失)' }
elseif ($exitCode -ne 0) { $verdict = "error(exit=$exitCode)" }
elseif ($got -eq 0)      { $verdict = 'empty(整批掉)' }
elseif ($got -lt $Limit) { $verdict = "partial($got/$Limit)" }
else                     { $verdict = 'ok' }

# 取 stderr 末行当 note(去逗号/换行,免得撑破 CSV;截 120 字)
$note = ''
if ($errText) {
  $lastLine = ($errText -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1)
  if ($lastLine) {
    $note = ($lastLine -replace ',', ';' -replace "`r|`n", ';')
    if ($note.Length -gt 120) { $note = $note.Substring(0,120) }
  }
}

# ── 落 CSV + 控制台回显 ──
"$ts,$Limit,$got,$duration,$exitCode,$verdict,$note" | Add-Content -Path $Csv -Encoding utf8
Write-Host "[$ts] requested=$Limit got=$got ${duration}s exit=$exitCode -> $verdict"
