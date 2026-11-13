# ioBroker.sipass

Zutrittskontrolle **SiPass integrated** (Siemens, heute Acre Security) in ioBroker – über die **Management Station API**
(REST, Port 8744) und ihre Live-Meldungen (Notifier).

- **Buchungen live:** letzte gültige und letzte abgewiesene Buchung mit Leser, Text und Uhrzeit
- **Leser** (Zutrittspunkte) mit ihrem letzten Ereignis
- **Ereignisliste** (`events.history`, die letzten 50) und **offene Alarme**
- **Regeln:** gültige Buchung an Leser X (optional nur für Person Y) → Datenpunkt schreiben, z. B. die NOX-Alarmanlage
  unscharf schalten. Nur mit dem Haken **„Steuern erlauben“** (ohne Haken stehen sie nur im Log).

Getestet mit einer nachgebauten SiPass-Schnittstelle (Anmeldung und Notifier so, wie sie an SiPass 3.0 beobachtet wurden).
Wie SiPass die Buchungen genau schickt, ist nicht dokumentiert – deshalb schreibt der Adapter anfangs **jede Meldung ins
Log** (Einstellung „Jede Meldung von SiPass ins Log schreiben“).

## Voraussetzungen

- SiPass integrated mit Lizenz und installiertem Dienst **Management Station API** (Port 8744)
- Ein **eigener SiPass-Bediener** für ioBroker: SiPass lehnt eine zweite Anmeldung desselben Bedieners ab
  („Dieser Benutzer ist schon angemeldet“).

## Installation

```
iobroker url https://github.com/andreaslampl/ioBroker.sipass
```

## Einstellungen

| Feld | Bedeutung |
|---|---|
| Adresse, Port, HTTPS | SiPass-Server, Standard 8744 mit HTTPS (eigenes Zertifikat von SiPass wird angenommen) |
| SiPass-Bediener, Passwort | Anmeldung an der Management Station API |
| Jede Meldung ins Log | für die ersten Tests an; zeigt, was SiPass schickt |
| Steuern erlauben | erst ankreuzen, wenn die Regeln im Log richtig auslösen |
| Regeln | Name, Leser (Teil des Namens), Person (optional, Teil des Textes), Datenpunkt, Wert (leer = true) |

**Beispiel NOX unscharf:** Leser `Haustüre`, Datenpunkt `nox_alarmzentrale.0.areas.1.command`, Wert passend zum NOX-Adapter
(dort muss „Steuern erlauben“ ebenfalls an sein). Dieselbe Regel löst höchstens alle 5 Sekunden einmal aus.

## Datenpunkte

| Datenpunkt | Inhalt |
|---|---|
| `info.connection` | angemeldet und Live-Meldungen verbunden |
| `access.grantedText` / `grantedReader` / `grantedTime` | letzte gültige Buchung |
| `access.deniedText` / `deniedReader` / `deniedTime` | letzte abgewiesene Buchung |
| `events.lastText`, `events.history` | letztes Ereignis, Liste der letzten Ereignisse (JSON) |
| `readers.<Nr>.*` | Name, letztes Ereignis, letzte gültige / abgewiesene Buchung |
| `alarms.count`, `alarms.list` | offene Alarme in SiPass (jede Minute) |
| `info.lastRaw` | letzte Meldung von SiPass unverändert (zur Fehlersuche) |

## Lizenz

MIT
