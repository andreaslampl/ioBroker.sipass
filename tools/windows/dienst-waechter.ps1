# Dienst-Waechter: watches chosen Windows services (e.g. SiPass, SQL Server) and starts them again when they stop.
#   Double click Dienst-Waechter.cmd (or: powershell -ExecutionPolicy Bypass -File dienst-waechter.ps1) -> window:
#   tick services, optional port per service (no answer twice -> restart), "Speichern und ueberwachen".
#   The Task Scheduler then runs "dienst-waechter.ps1 -Run" every minute and at startup as SYSTEM.
# Config: C:\ProgramData\DienstWaechter\config.json, log: waechter.log in the same folder.
param([switch]$Run)

$ErrorActionPreference = 'Continue'
$Dir = Join-Path $env:ProgramData 'DienstWaechter'
$ConfigFile = Join-Path $Dir 'config.json'
$StateFile = Join-Path $Dir 'state.json'
$LogFile = Join-Path $Dir 'waechter.log'
$Installed = Join-Path $Dir 'dienst-waechter.ps1'
$TaskName = 'Dienst-Waechter'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

function Write-Log([string]$text) {
    $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $text
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    if ((Get-Item $LogFile).Length -gt 1MB) {
        Move-Item -Force $LogFile "$LogFile.old"
    }
}

function Get-WatchList {
    if (Test-Path $ConfigFile) {
        try {
            $c = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            return @($c.services | Where-Object { $_ -and $_.name })
        } catch {
            Write-Log "config.json nicht lesbar: $($_.Exception.Message)"
        }
    }
    return @()
}

function Test-Port([int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $t = $c.ConnectAsync('127.0.0.1', $port)
        $ok = $t.Wait(5000) -and $c.Connected
        $c.Close()
        return $ok
    } catch {
        return $false
    }
}

# one round: start stopped services, restart those whose port does not answer twice in a row
function Invoke-Check {
    $state = @{}
    if (Test-Path $StateFile) {
        try {
            (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = [int]$_.Value }
        } catch { }
    }
    foreach ($e in Get-WatchList) {
        $name = [string]$e.name
        $s = Get-Service -Name $name -ErrorAction SilentlyContinue
        if (-not $s) {
            # note it once, not every minute
            if (-not $state["missing:$name"]) {
                Write-Log "Dienst '$name' gibt es nicht (mehr)"
                $state["missing:$name"] = 1
            }
            continue
        }
        [void]$state.Remove("missing:$name")
        if ([string]$s.StartType -eq 'Disabled') {
            continue
        }
        if ($s.Status -ne 'Running') {
            if ($s.Status -eq 'StartPending' -or $s.Status -eq 'StopPending') {
                continue
            }
            Write-Log ("'{0}' ist {1} - starte" -f $s.DisplayName, $s.Status)
            try {
                Start-Service -Name $name -ErrorAction Stop
                Write-Log ("'{0}' gestartet" -f $s.DisplayName)
            } catch {
                Write-Log ("'{0}' konnte nicht gestartet werden: {1}" -f $s.DisplayName, $_.Exception.Message)
            }
            $state[$name] = 0
            continue
        }
        $port = [int]$e.port
        if ($port -gt 0) {
            if (Test-Port $port) {
                if ([int]$state[$name] -gt 0) {
                    Write-Log ("'{0}': Port {1} antwortet wieder" -f $s.DisplayName, $port)
                }
                $state[$name] = 0
            } else {
                $state[$name] = [int]$state[$name] + 1
                Write-Log ("'{0}': Port {1} antwortet nicht ({2}. Mal)" -f $s.DisplayName, $port, $state[$name])
                if ($state[$name] -ge 2) {
                    try {
                        Restart-Service -Name $name -Force -ErrorAction Stop
                        Write-Log ("'{0}' neu gestartet" -f $s.DisplayName)
                    } catch {
                        Write-Log ("Neustart von '{0}' fehlgeschlagen: {1}" -f $s.DisplayName, $_.Exception.Message)
                    }
                    $state[$name] = 0
                }
            }
        }
    }
    $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

if ($Run) {
    Invoke-Check
    exit 0
}

# ---------------- window ----------------

$admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # the task and the services need administrator rights
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 0
}

Write-Host 'Dienst-Wächter wird geöffnet …  (dieses schwarze Fenster offen lassen)'
try {
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$watch = @{} # service name -> port (0 = only "is running")
$list = Get-WatchList
if ($list.Count -gt 0) {
    foreach ($e in $list) { $watch[[string]$e.name] = [int]$e.port }
} else {
    # first start: suggest the SiPass services
    foreach ($s in Get-Service | Where-Object { $_.DisplayName -like '*SiPass*' -or $_.Name -like '*SiPass*' }) {
        $watch[$s.Name] = 0
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Dienst-Wächter'
$form.Size = New-Object System.Drawing.Size(980, 720)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$intro = New-Object System.Windows.Forms.Label
$intro.Text = 'Haken = überwachen: steht der Dienst, wird er innerhalb einer Minute wieder gestartet. Port (optional): antwortet der Dienst dort zweimal hintereinander nicht, wird er neu gestartet.'
$intro.SetBounds(12, 10, 940, 36)
$form.Controls.Add($intro)

$lblSearch = New-Object System.Windows.Forms.Label
$lblSearch.Text = 'Suchen:'
$lblSearch.SetBounds(12, 52, 55, 22)
$form.Controls.Add($lblSearch)

$search = New-Object System.Windows.Forms.TextBox
$search.SetBounds(70, 49, 300, 24)
$form.Controls.Add($search)

$onlyWatched = New-Object System.Windows.Forms.CheckBox
$onlyWatched.Text = 'nur überwachte zeigen'
$onlyWatched.SetBounds(390, 50, 200, 22)
$form.Controls.Add($onlyWatched)

$lv = New-Object System.Windows.Forms.ListView
$lv.View = 'Details'
$lv.CheckBoxes = $true
$lv.FullRowSelect = $true
$lv.HideSelection = $false
$lv.MultiSelect = $false
$lv.SetBounds(12, 80, 940, 360)
$lv.Anchor = 'Top,Left,Right,Bottom'
[void]$lv.Columns.Add('Dienst', 330)
[void]$lv.Columns.Add('Name', 230)
[void]$lv.Columns.Add('Starttyp', 100)
[void]$lv.Columns.Add('Zustand', 110)
[void]$lv.Columns.Add('Port', 80)
$form.Controls.Add($lv)

$lblPort = New-Object System.Windows.Forms.Label
$lblPort.Text = 'Port für den markierten Dienst (0 = nur prüfen, ob er läuft):'
$lblPort.SetBounds(12, 452, 360, 22)
$lblPort.Anchor = 'Bottom,Left'
$form.Controls.Add($lblPort)

$port = New-Object System.Windows.Forms.NumericUpDown
$port.Minimum = 0
$port.Maximum = 65535
$port.SetBounds(375, 449, 90, 24)
$port.Anchor = 'Bottom,Left'
$port.Enabled = $false
$form.Controls.Add($port)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Text = 'Speichern und überwachen'
$btnSave.SetBounds(12, 484, 200, 32)
$btnSave.Anchor = 'Bottom,Left'
$form.Controls.Add($btnSave)

$btnCheck = New-Object System.Windows.Forms.Button
$btnCheck.Text = 'Jetzt prüfen'
$btnCheck.SetBounds(222, 484, 120, 32)
$btnCheck.Anchor = 'Bottom,Left'
$form.Controls.Add($btnCheck)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = 'Liste aktualisieren'
$btnRefresh.SetBounds(352, 484, 140, 32)
$btnRefresh.Anchor = 'Bottom,Left'
$form.Controls.Add($btnRefresh)

$btnLog = New-Object System.Windows.Forms.Button
$btnLog.Text = 'Protokoll öffnen'
$btnLog.SetBounds(502, 484, 130, 32)
$btnLog.Anchor = 'Bottom,Left'
$form.Controls.Add($btnLog)

$btnRemove = New-Object System.Windows.Forms.Button
$btnRemove.Text = 'Überwachung entfernen'
$btnRemove.SetBounds(772, 484, 180, 32)
$btnRemove.Anchor = 'Bottom,Right'
$form.Controls.Add($btnRemove)

$status = New-Object System.Windows.Forms.Label
$status.SetBounds(12, 524, 940, 22)
$status.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($status)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$logBox.SetBounds(12, 550, 940, 120)
$logBox.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($logBox)

$script:loading = $false

function Get-StartTypeText($s) {
    switch ([string]$s.StartType) {
        'Automatic' { 'Automatisch' }
        'Manual' { 'Manuell' }
        'Disabled' { 'Deaktiviert' }
        default { [string]$s.StartType }
    }
}

function Get-StatusText($s) {
    switch ([string]$s.Status) {
        'Running' { 'läuft' }
        'Stopped' { 'gestoppt' }
        'StartPending' { 'startet …' }
        'StopPending' { 'stoppt …' }
        default { [string]$s.Status }
    }
}

function Update-List {
    $script:loading = $true
    $lv.BeginUpdate()
    $lv.Items.Clear()
    $q = $search.Text.Trim()
    foreach ($s in Get-Service | Sort-Object DisplayName) {
        $on = $watch.ContainsKey($s.Name)
        if ($onlyWatched.Checked -and -not $on) { continue }
        if ($q -and $s.DisplayName -notlike "*$q*" -and $s.Name -notlike "*$q*") { continue }
        $item = New-Object System.Windows.Forms.ListViewItem($s.DisplayName)
        [void]$item.SubItems.Add($s.Name)
        [void]$item.SubItems.Add((Get-StartTypeText $s))
        [void]$item.SubItems.Add((Get-StatusText $s))
        [void]$item.SubItems.Add($(if ($on -and $watch[$s.Name] -gt 0) { [string]$watch[$s.Name] } else { '' }))
        $item.Tag = $s.Name
        $item.Checked = $on
        if ($on -and $s.Status -ne 'Running') { $item.ForeColor = [System.Drawing.Color]::Firebrick }
        [void]$lv.Items.Add($item)
    }
    $lv.EndUpdate()
    $script:loading = $false
    Update-Status
}

function Update-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $active = if ($task) { "Überwachung aktiv (Aufgabe '$TaskName', jede Minute)" } else { 'Überwachung nicht eingerichtet' }
    $status.Text = "$active  -  $($watch.Count) Dienst(e) angehakt"
    if (Test-Path $LogFile) {
        $logBox.Lines = @(Get-Content $LogFile -Tail 12 -Encoding UTF8)
        $logBox.SelectionStart = $logBox.Text.Length
        $logBox.ScrollToCaret()
    } else {
        $logBox.Text = 'Noch keine Einträge im Protokoll.'
    }
}

$lv.Add_ItemChecked({
    param($sender, $e)
    if ($script:loading) { return }
    $name = [string]$e.Item.Tag
    if ($e.Item.Checked) {
        if (-not $watch.ContainsKey($name)) { $watch[$name] = 0 }
    } else {
        [void]$watch.Remove($name)
        $e.Item.SubItems[4].Text = ''
    }
    Update-Status
})

$lv.Add_SelectedIndexChanged({
    if ($lv.SelectedItems.Count -eq 0) {
        $port.Enabled = $false
        return
    }
    $name = [string]$lv.SelectedItems[0].Tag
    $script:loading = $true
    $port.Value = $(if ($watch.ContainsKey($name)) { [int]$watch[$name] } else { 0 })
    $port.Enabled = $watch.ContainsKey($name)
    $script:loading = $false
})

$port.Add_ValueChanged({
    if ($script:loading -or $lv.SelectedItems.Count -eq 0) { return }
    $item = $lv.SelectedItems[0]
    $name = [string]$item.Tag
    if ($watch.ContainsKey($name)) {
        $watch[$name] = [int]$port.Value
        $item.SubItems[4].Text = $(if ($port.Value -gt 0) { [string]$port.Value } else { '' })
    }
})

$search.Add_TextChanged({ Update-List })
$onlyWatched.Add_CheckedChanged({ Update-List })
$btnRefresh.Add_Click({ Update-List })

$btnSave.Add_Click({
    try {
        if ($watch.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Kein Dienst angehakt. Zum Abschalten "Überwachung entfernen" verwenden.', 'Dienst-Wächter') | Out-Null
            return
        }
        $services = @()
        foreach ($name in $watch.Keys) {
            $s = Get-Service -Name $name -ErrorAction SilentlyContinue
            $services += [pscustomobject]@{ name = $name; display = $(if ($s) { $s.DisplayName } else { $name }); port = [int]$watch[$name] }
        }
        ([pscustomobject]@{ services = $services }) | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigFile -Encoding UTF8
        # the task runs the copy in ProgramData (independent of where this file was started from)
        if ($PSCommandPath -ne $Installed) {
            Copy-Item -Force $PSCommandPath $Installed
        }
        $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Installed`" -Run"
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $boot = New-ScheduledTaskTrigger -AtStartup
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        $who = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every, $boot) -Settings $settings -Principal $who -Force | Out-Null
        # Windows' own recovery as well: restart after 1 minute when the service crashes
        foreach ($name in $watch.Keys) {
            & sc.exe failure "$name" reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
        }
        Write-Log ("Überwachung gespeichert: {0}" -f (($services | ForEach-Object { if ($_.port -gt 0) { "$($_.display) (Port $($_.port))" } else { $_.display } }) -join ', '))
        Update-Status
        [System.Windows.Forms.MessageBox]::Show("Gespeichert. $($watch.Count) Dienst(e) werden jetzt jede Minute geprüft.", 'Dienst-Wächter') | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Fehler: $($_.Exception.Message)", 'Dienst-Wächter') | Out-Null
    }
})

$btnCheck.Add_Click({
    $form.Cursor = 'WaitCursor'
    Invoke-Check
    $form.Cursor = 'Default'
    Update-List
})

$btnLog.Add_Click({
    if (-not (Test-Path $LogFile)) { Write-Log 'Protokoll angelegt' }
    Start-Process notepad.exe $LogFile
})

$btnRemove.Add_Click({
    $r = [System.Windows.Forms.MessageBox]::Show('Überwachung abschalten? (Die Auswahl bleibt gespeichert.)', 'Dienst-Wächter', 'YesNo')
    if ($r -eq 'Yes') {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Log 'Überwachung entfernt'
        Update-Status
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.Add_Tick({ Update-Status })
$timer.Start()

# always in front (a window started with administrator rights often opens behind the console)
$form.Add_Shown({
    $form.TopMost = $true
    $form.Activate()
    $form.TopMost = $false
})
Update-List
Write-Host 'Fenster ist offen.'
[void]$form.ShowDialog()
$timer.Stop()
} catch {
    Write-Host ''
    Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Zeile $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())"
    Read-Host 'Enter drücken zum Schließen'
}
