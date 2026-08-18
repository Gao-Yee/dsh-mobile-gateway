# 停止 dsh-mobile-gateway
$port = 3081
$configPath = Join-Path $PSScriptRoot 'config.json'
if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.port) { $port = [int]$config.port }
}
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Host "网关未在运行 (端口 $port)。"; exit 0 }
$conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Stop-Process -Id $_ -Force
    Write-Host "已停止 PID $_"
}
