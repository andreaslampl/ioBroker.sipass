# SiPass-Watchdog (am SiPass-PC)

Startet SiPass-Dienste, die eigentlich laufen sollten (Starttyp „Automatisch“), aber stehen – jede Minute, auch wenn niemand
angemeldet ist. Zusätzlich stellt es die **Windows-Wiederherstellung** der Dienste ein: Stürzt ein Dienst ab, startet Windows
ihn nach 1 Minute selbst neu. Optional wird die **Management Station API** neu gestartet, wenn sie auf Port 8744 nicht mehr
antwortet, obwohl der Dienst „läuft“.

Dienste, die deaktiviert oder auf „Manuell“ stehen, werden nicht angefasst.

## 1. Dateien holen

Am SiPass-PC einen Ordner anlegen, z. B. `C:\Temp\Watchdog`, und diese zwei Dateien hineinladen
(Link öffnen → Rechtsklick → „Speichern unter“, Dateityp „Alle Dateien“):

- <https://raw.githubusercontent.com/andreaslampl/ioBroker.sipass/main/tools/windows/sipass-watchdog.ps1>
- <https://raw.githubusercontent.com/andreaslampl/ioBroker.sipass/main/tools/windows/install-watchdog.ps1>

## 2. Nachsehen, welche Dienste es findet

**PowerShell als Administrator** öffnen (Start → „PowerShell“ → Rechtsklick → „Als Administrator ausführen“):

```
cd C:\Temp\Watchdog
powershell -ExecutionPolicy Bypass -File .\sipass-watchdog.ps1 -List
```

Es zeigt alle Dienste mit „SiPass“ im Namen, ihren Starttyp und ob sie laufen. Steht dort der Dienst der
**Management Station API**, merke dir seinen **Namen** (die erste Spalte).

Läuft SiPass mit einer eigenen **SQL-Server-Instanz** auf demselben PC und soll die mit überwacht werden:
`-Pattern "*SiPass*,MSSQL*"` anhängen (bei `-List` und bei der Installation).

## 3. Einrichten

```
powershell -ExecutionPolicy Bypass -File .\install-watchdog.ps1
```

Mit Neustart der API, wenn Port 8744 nicht antwortet (Namen aus Schritt 2 einsetzen):

```
powershell -ExecutionPolicy Bypass -File .\install-watchdog.ps1 -ApiService "NAME-AUS-SCHRITT-2"
```

Fertig. In der **Aufgabenplanung** steht jetzt „SiPass Watchdog“ (jede Minute und beim Hochfahren).

## Protokoll und Entfernen

- Protokoll: `C:\ProgramData\SiPassWatchdog\watchdog.log` – dort steht jeder Neustart mit Uhrzeit.
- Entfernen: `powershell -ExecutionPolicy Bypass -File .\install-watchdog.ps1 -Remove`

## Benachrichtigung in ioBroker

Der ioBroker-Adapter meldet sich nach einem SiPass-Neustart von selbst wieder an. Wer eine Nachricht möchte, wenn SiPass länger
weg ist: in SmartView eine Push-Regel auf `sipass.0.info.connection` = false, „länger als“ z. B. 5 Minuten.
