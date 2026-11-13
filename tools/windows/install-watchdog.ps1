# Installs the SiPass watchdog on the SiPass PC (run once in PowerShell "as administrator"):
#   powershell -ExecutionPolicy Bypass -File install-watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File install-watchdog.ps1 -ApiService "<service name of the Management Station API>"
#   powershell -ExecutionPolicy Bypass -File install-watchdog.ps1 -Remove
# - copies sipass-watchdog.ps1 to C:\ProgramData\SiPassWatchdog
# - Task Scheduler: task "SiPass Watchdog" every minute as SYSTEM (also without anybody logged in)
# - Windows' own recovery for the watched services: restart after 1 minute on a crash
param(
    [string]$Pattern = '*SiPass*',  # several: '*SiPass*,MSSQL*'
    [string]$ApiService = '',
    [int]$Port = 8744,
    [switch]$Remove
)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Bitte PowerShell "Als Administrator ausfuehren" und nochmal starten.'
    exit 1
}

$name = 'SiPass Watchdog'
$dir = Join-Path $env:ProgramData 'SiPassWatchdog'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Aufgabe '$name' entfernt (Protokoll bleibt in $dir)."
    exit 0
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$src = Join-Path $PSScriptRoot 'sipass-watchdog.ps1'
if (-not (Test-Path $src)) {
    Write-Error "sipass-watchdog.ps1 nicht gefunden - beide Dateien in denselben Ordner legen."
    exit 1
}
Copy-Item -Force $src (Join-Path $dir 'sipass-watchdog.ps1')

$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\sipass-watchdog.ps1`" -Pattern `"$Pattern`" -Port $Port"
if ($ApiService) { $arg += " -ApiService `"$ApiService`"" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$startup = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$who = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($trigger, $startup) -Settings $settings -Principal $who -Force | Out-Null
Write-Output "Aufgabe '$name' eingerichtet: jede Minute, als SYSTEM."

# Windows' own recovery: restart the automatic services after 1 minute when they crash
$patterns = $Pattern -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$services = Get-CimInstance Win32_Service | Where-Object {
    $svc = $_
    ($patterns | Where-Object { $svc.Name -like $_ -or $svc.DisplayName -like $_ }).Count -gt 0
} | Where-Object { $_.StartMode -eq 'Auto' }
foreach ($s in $services) {
    sc.exe failure "$($s.Name)" reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
    Write-Output ("Wiederherstellung fuer '{0}': bei Absturz nach 1 Minute neu starten" -f $s.DisplayName)
}
if (-not $services) {
    Write-Output 'Keine automatisch startenden Dienste mit diesem Muster gefunden - mit -List im Watchdog-Skript pruefen.'
}
Write-Output "Protokoll: $dir\watchdog.log"
