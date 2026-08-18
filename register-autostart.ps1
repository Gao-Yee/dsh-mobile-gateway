# 注册/取消 dsh-mobile-gateway 开机自启
# 用法: .\register-autostart.ps1           # 注册
#       .\register-autostart.ps1 -Remove   # 取消
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$lnkPath = Join-Path $startupDir 'dsh-mobile-gateway.lnk'
$gatewayDir = $PSScriptRoot

if ($Remove) {
    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host '已取消开机自启。'
    } else {
        Write-Host '当前未注册开机自启。'
    }
    exit 0
}

$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($lnkPath)
$shortcut.TargetPath = (Get-Command node).Source
$shortcut.Arguments = 'gateway.js'
$shortcut.WorkingDirectory = $gatewayDir
$shortcut.WindowStyle = 7  # 最小化
$shortcut.Description = 'dsh-mobile-gateway 开机自启'
$shortcut.Save()
Write-Host "已注册开机自启: $lnkPath"
