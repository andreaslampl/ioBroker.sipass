# Dienst-Wächter (Windows)

Kleines Programm mit Fenster für Windows-PCs (z. B. den SiPass-Server): Du hakst die **Dienste** an, die immer laufen sollen –
steht einer, startet der Dienst-Wächter ihn **innerhalb einer Minute** wieder. Geht für **jeden Windows-Dienst** (SiPass,
SQL Server, andere Programme). Zusätzlich stellt er die **Windows-Wiederherstellung** der Dienste ein (nach einem Absturz startet
Windows sie nach 1 Minute selbst neu).

Optional pro Dienst ein **Port**: Antwortet der Dienst dort zweimal hintereinander nicht, obwohl er „läuft“ (hängt), wird er
neu gestartet – z. B. die SiPass Management Station API auf Port **8744**.

Es läuft im Hintergrund über die Aufgabenplanung (jede Minute und beim Hochfahren, als SYSTEM – auch wenn niemand angemeldet
ist). Nichts zu installieren: PowerShell ist in Windows schon drin.

## 1. Dateien holen

Am PC einen Ordner anlegen, z. B. `C:\Tools\Dienst-Waechter`, und diese zwei Dateien hineinladen
(Link öffnen → Rechtsklick → „Speichern unter“, Dateityp „Alle Dateien“, Namen so lassen):

- <https://raw.githubusercontent.com/andreaslampl/ioBroker.sipass/main/tools/windows/dienst-waechter.ps1>
- <https://raw.githubusercontent.com/andreaslampl/ioBroker.sipass/main/tools/windows/Dienst-Waechter.cmd>

## 2. Starten und Dienste wählen

1. **Doppelklick auf `Dienst-Waechter.cmd`** – Windows fragt nach Administrator-Rechten → **Ja**.
2. Es öffnet sich die Liste aller Dienste. Beim ersten Start sind die **SiPass-Dienste schon angehakt**.
3. Mit **Suchen** findest du weitere (z. B. „SQL“ für den SQL Server von SiPass) – anhaken.
4. Optional: einen Dienst **markieren** und unten den **Port** eintragen (z. B. 8744 für die Management Station API).
5. **„Speichern und überwachen“** – fertig.

Rot = angehakt, läuft aber gerade nicht. **„Jetzt prüfen“** startet stehende Dienste sofort. Unten im Fenster stehen die
letzten Einträge des Protokolls.

## Ändern, Protokoll, Abschalten

- Ändern: wieder `Dienst-Waechter.cmd` starten, Haken setzen/entfernen, speichern.
- Protokoll: Knopf **„Protokoll öffnen“** oder Datei `C:\ProgramData\DienstWaechter\waechter.log`.
- Abschalten: **„Überwachung entfernen“** (die Auswahl bleibt gespeichert).

## Benachrichtigung in ioBroker

Der SiPass-Adapter meldet sich nach einem SiPass-Neustart von selbst wieder an. Für eine Nachricht, wenn SiPass länger weg ist:
in SmartView eine Push-Regel auf `sipass.0.info.connection` = false, „länger als“ z. B. 5 Minuten.
