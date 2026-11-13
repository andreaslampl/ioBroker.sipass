# SiPass watchdog: runs every minute (Task Scheduler, as SYSTEM, installed by install-watchdog.ps1).
#  1. Every Windows service whose name or display name matches one of the patterns and that is set to start
#     automatically, but is stopped, is started again.
#  2. Optional: if the Management Station API does not answer on its port twice in a row, that service is restarted.
# Only services that Windows itself should run (start type "Automatic") are touched - disabled / manual ones stay as they are.
#
#   powershell -ExecutionPolicy Bypass -File sipass-watchdog.ps1 -List     shows which services would be watched
param(
    [string]$Pattern = '*SiPass*',  # several: '*SiPass*,MSSQL*'
    [int]$Port = 8744,
    [string]$ApiService = '',
    [switch]$List,
    [string]$Dir = (Join-Path $env:ProgramData 'SiPassWatchdog')
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$logFile = Join-Path $Dir 'watchdog.log'
$failFile = Join-Path $Dir 'port-failures.txt'

function Write-Log([string]$text) {
    $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $text
    if ($List) { Write-Output $line }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    # keep the log small
    if ((Get-Item $logFile).Length -gt 1MB) {
        Move-Item -Force $logFile "$logFile.old"
    }
}

$patterns = $Pattern -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$services = Get-CimInstance Win32_Service | Where-Object {
    $svc = $_
    ($patterns | Where-Object { $svc.Name -like $_ -or $svc.DisplayName -like $_ }).Count -gt 0
}

if ($List) {
    Write-Output 'Gefundene Dienste (Name / Anzeigename / Starttyp / Zustand):'
    $services | Sort-Object DisplayName | ForEach-Object {
        Write-Output ('  {0}  /  {1}  /  {2}  /  {3}' -f $_.Name, $_.DisplayName, $_.StartMode, $_.State)
    }
    Write-Output 'Neu gestartet werden nur Dienste mit Starttyp "Auto", die nicht laufen.'
    exit 0
}

# 1. automatic services that are not running
foreach ($s in $services) {
    if ($s.StartMode -eq 'Auto' -and $s.State -ne 'Running') {
        Write-Log ("Dienst '{0}' ({1}) ist {2} - starte ihn" -f $s.DisplayName, $s.Name, $s.State)
        try {
            Start-Service -Name $s.Name -ErrorAction Stop
            Write-Log ("Dienst '{0}' gestartet" -f $s.DisplayName)
        } catch {
            Write-Log ("Dienst '{0}' konnte nicht gestartet werden: {1}" -f $s.DisplayName, $_.Exception.Message)
        }
    }
}

# 2. the API port answers? (only when a service for it is named)
if ($ApiService) {
    $ok = $false
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $task = $c.ConnectAsync('127.0.0.1', $Port)
        $ok = $task.Wait(5000) -and $c.Connected
        $c.Close()
    } catch { $ok = $false }
    $fails = 0
    if (Test-Path $failFile) { $fails = [int](Get-Content $failFile -Raw) }
    if ($ok) {
        if ($fails -gt 0) { Write-Log "Port $Port antwortet wieder" }
        $fails = 0
    } else {
        $fails++
        Write-Log "Port $Port antwortet nicht ($fails. Mal)"
        if ($fails -ge 2) {
            Write-Log "Starte Dienst '$ApiService' neu"
            try {
                Restart-Service -Name $ApiService -Force -ErrorAction Stop
                Write-Log "Dienst '$ApiService' neu gestartet"
            } catch {
                Write-Log ("Neustart von '{0}' fehlgeschlagen: {1}" -f $ApiService, $_.Exception.Message)
            }
            $fails = 0
        }
    }
    Set-Content -Path $failFile -Value $fails
}
