#requires -Version 5.1
#requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__OMNIDESK_BUNDLE__')) | ConvertFrom-Json
$root = Join-Path $env:ProgramData 'OmniDeskMonitor'
$configPath = Join-Path $root 'agent.json'
$binaryPath = Join-Path $root 'omnidesk-monitor-agent.exe'
$statePath = Join-Path $root 'state.json'
$serviceName = 'OmniDeskMonitor'
$backup = $null
$created = $false
$wasRunning = $false
$replaceBinding = $false
$filesWritten = $false
$managedFiles = @('agent.json','omnidesk-monitor-agent.exe','state.json')
foreach ($path in @($root,$configPath,$binaryPath,(Join-Path $root 'state.json'))) { if (Test-Path -LiteralPath $path) { if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Agent paths must not be reparse points.' } } }
$previous = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($previous -and !(Test-Path -LiteralPath $configPath)) { throw 'Existing service is not managed by this installer.' }
if (Test-Path -LiteralPath $configPath) {
 $old = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
 if ($old.managedBy -ne 'omnidesk-monitor-windows-v1') { throw 'Existing agent configuration is not managed by this installer.' }
 $replaceBinding = $old.nodeId -ne $payload.config.nodeId -or ([string]$old.serverUrl).TrimEnd('/') -ne ([string]$payload.config.serverUrl).TrimEnd('/')
 if ($replaceBinding) {
  Write-Host ('Existing backend: ' + $old.serverUrl + ' | Node: ' + $old.nodeId)
  Write-Host ('New backend:      ' + $payload.config.serverUrl + ' | Node: ' + $payload.config.nodeId)
  Write-Host 'This replaces the local agent binding. Existing backend history stays there; new binding starts a separate traffic counter.'
  if ((Read-Host 'Replace existing installation? Type Y to continue (default: cancel)') -notmatch '^(?i)y(es)?$') { throw 'Installation cancelled. Existing agent was not changed.' }
 }
 # Preserve state and deliberate NIC/discovery settings during upgrades.
 if ($null -ne $old.includeNics) { $payload.config.includeNics = $old.includeNics }
 if ($null -ne $old.disableDiscovery) { $payload.config | Add-Member -MemberType NoteProperty -Name disableDiscovery -Value $old.disableDiscovery -Force }
}
$bytes = [Convert]::FromBase64String($payload.binary)
$sha = [Security.Cryptography.SHA256]::Create()
try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
if ($actual -ne $payload.sha256) { throw 'Agent integrity check failed.' }
if ([Environment]::Is64BitOperatingSystem -eq $false) { throw 'Windows x64 is required.' }
New-Item -ItemType Directory -Path $root -Force | Out-Null
# Restrict the node token and durable state before writing either file.
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict agent directory permissions.' }
try {
 if ($previous) { $wasRunning = $previous.Status -eq 'Running'; Stop-Service -Name $serviceName; (Get-Service $serviceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20)) }
 if (Test-Path -LiteralPath $configPath) {
  $backup = Join-Path $root ('backup-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $backup | Out-Null
  foreach ($file in $managedFiles) { $src=Join-Path $root $file; if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $backup } }
 }
 $filesWritten = $true
 if ($replaceBinding -and (Test-Path -LiteralPath $statePath)) { Remove-Item -LiteralPath $statePath -Force }
 [IO.File]::WriteAllBytes($binaryPath,$bytes)
 $payload.config.statePath = $statePath
 [IO.File]::WriteAllText($configPath,($payload.config | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
 if (!$previous) {
  $emptyPassword = New-Object Security.SecureString
  $serviceAccount = New-Object Management.Automation.PSCredential('NT AUTHORITY\LocalService',$emptyPassword)
  New-Service -Name $serviceName -DisplayName 'OmniDesk Monitor' -BinaryPathName ('"' + $binaryPath + '" -config "' + $configPath + '"') -StartupType Automatic -Credential $serviceAccount | Out-Null
  $created=$true
 }
 Start-Service -Name $serviceName
 (Get-Service $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(20))
 if ($backup) { Write-Host ('Previous installation backed up to: ' + $backup) }
 Write-Host ''
 Write-Host '============================================================' -ForegroundColor Green
 Write-Host '         __' -ForegroundColor Green
 Write-Host '        / /' -ForegroundColor Green
 Write-Host '   __  / /     采集端安装完成' -ForegroundColor Green
 Write-Host '   \ \/ /      INSTALLATION COMPLETE' -ForegroundColor Green
 Write-Host '    \__/' -ForegroundColor Green
 Write-Host '============================================================' -ForegroundColor Green
 Write-Host ('  服务状态：已启动（' + $serviceName + '）') -ForegroundColor Green
 Write-Host ('  上报地址：' + $payload.config.serverUrl)
 Write-Host ('  上报间隔：每 ' + $payload.config.intervalSeconds + ' 秒')
 Write-Host ''
 Write-Host '  下一步：返回 OmniDesk，等待此节点的首次上报。' -ForegroundColor Cyan
 Write-Host '  服务已启动；是否成功接入，请以监控页面收到上报为准。' -ForegroundColor Yellow
 Write-Host '  若一直未接入，请检查服务状态、网络和证书。' -ForegroundColor Yellow
 Write-Host '  安装脚本含节点凭据，使用后请删除。' -ForegroundColor DarkGray
 Write-Host ''
} catch {
 $installError = $_
 Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
 if ($created) { & sc.exe delete $serviceName | Out-Null }
 if ($filesWritten) {
  foreach ($file in $managedFiles) {
   $destination = Join-Path $root $file
   $src = if ($backup) { Join-Path $backup $file } else { $null }
   if ($src -and (Test-Path -LiteralPath $src)) { Copy-Item -LiteralPath $src -Destination $destination -Force }
   elseif (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
  }
 }
 if ($wasRunning) { Start-Service -Name $serviceName -ErrorAction SilentlyContinue }
 throw $installError
}
