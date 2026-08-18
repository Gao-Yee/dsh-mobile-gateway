# 后台启动 dsh-mobile-gateway（独立于当前终端，关闭窗口后仍运行）
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host '未找到 node，请先安装 Node.js。'; exit 1 }
$port = 3081
$configPath = Join-Path $PSScriptRoot 'config.json'
if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.port) { $port = [int]$config.port }
}
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) { Write-Host "网关已在运行 (PID $($existing.OwningProcess -join ','))。"; exit 0 }
Start-Process -FilePath 'node' -ArgumentList 'gateway.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Start-Sleep -Seconds 1
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "dsh-mobile-gateway 已启动 (端口 $port)。日志: gateway.log"
} else {
    Write-Host '启动失败，请查看 gateway.log'
    if (Test-Path 'gateway.log') { Get-Content 'gateway.log' -Tail 20 }
}
