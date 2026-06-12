<#
  注册「百应限流探针」计划任务:立即触发一次,之后每隔 1 小时(从触发那刻起算)。

  关键点(对齐 Mac LaunchAgent 的两条注意事项):
    1. 「仅在用户登录时运行」(Interactive)—— 浏览器自动化必须在有 GUI 的桌面会话里跑。
       绝不能用「不管用户是否登录都运行」(那是 session 0,Chrome/扩展连不上)。
    2. WakeToRun:允许唤醒计算机执行(睡眠也尽量按点跑);仍建议电源设置里别让它深睡。

  用法(在本仓库目录下,普通 PowerShell 即可,无需管理员):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\register-probe-task.ps1

  改频率:改下面 $IntervalHours。删除任务见文件末尾。
#>

$TaskName     = 'SelectionRateLimitProbe'
$IntervalHours = 1
$ScriptPath   = Join-Path $PSScriptRoot 'ratelimit-probe.ps1'

if (-not (Test-Path $ScriptPath)) {
  throw "找不到探针脚本:$ScriptPath"
}

# 已存在就先删,保证幂等
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除旧任务 $TaskName,重新注册…"
}

# 执行动作:用 powershell 跑探针脚本
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

# 触发器:此刻起,每 IntervalHours 小时重复,无限期
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

# 设置:允许唤醒、错过了就尽快补、用电池也跑(测试期别因省电跳过)
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# 仅当前用户、交互式登录时运行(有 GUI 才连得上 Chrome)
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
  -Description '百应限流探针:立即 + 每小时跑一次 products,结果记入 probe.csv' | Out-Null

Write-Host "✅ 已注册任务 $TaskName(立即触发 + 每 $IntervalHours 小时)。"

# 立刻先跑一次,验证链路
Start-ScheduledTask -TaskName $TaskName
Write-Host "已手动触发第一次,约 30-40s 后看 CSV:"
Write-Host "  Get-Content `"$env:USERPROFILE\selection-ratelimit-probe\probe.csv`""

<#
  ── 常用运维命令 ──
  查看任务:    Get-ScheduledTask -TaskName SelectionRateLimitProbe
  看上次结果:  Get-ScheduledTaskInfo -TaskName SelectionRateLimitProbe
  立即触发:    Start-ScheduledTask -TaskName SelectionRateLimitProbe
  暂停:        Disable-ScheduledTask -TaskName SelectionRateLimitProbe
  恢复:        Enable-ScheduledTask  -TaskName SelectionRateLimitProbe
  删除:        Unregister-ScheduledTask -TaskName SelectionRateLimitProbe -Confirm:$false
#>
