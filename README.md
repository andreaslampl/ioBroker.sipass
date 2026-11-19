# ioBroker.sipass

Zutrittskontrolle **SiPass integrated** (Siemens, heute Acre Security) in ioBroker – über die **Management Station API**
(REST, Port 8744) und ihre Live-Meldungen (Notifier).

- **Buchungen live:** letzte gültige und letzte abgewiesene Buchung mit Leser, Text und Uhrzeit
- **Leser** (Zutrittspunkte) mit ihrem letzten Ereignis
- **Ereignisliste** (`events.history`, die letzten 50) und **offene Alarme**
- **Regeln:** gültige Buchung an Leser X (optional nur für Person Y) → Datenpunkt schreiben, z. B. die NOX-Alarmanlage
  unscharf schalten. Nur mit dem Haken **„Steuern erlauben“** (ohne Haken stehen sie nur im Log).

Läuft mit SiPass integrated 3.0. Kartennummern werden nirgends ganz gespeichert (nur die letzten 4 Stellen). Zum Einrichten
kann jede Meldung von SiPass ins Log geschrieben werden (Einstellung „Jede Meldung von SiPass ins Log schreiben“) – danach
wieder ausschalten.

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
| `access.grantedText` / `grantedReader` / `grantedPerson` / `grantedTime` | letzte gültige Buchung, z. B. „Zutritt gewährt – Haustüre Tür 1 Leser – Max Muster“ |
| `access.deniedText` / `deniedReader` / `deniedPerson` / `deniedTime` | letzte abgewiesene Buchung |
| `events.lastText`, `events.history` | letztes Ereignis, Liste der letzten Ereignisse (JSON) |
| `readers.<Nr>.*` | Name, letztes Ereignis, letzte Person, letzte gültige / abgewiesene Buchung |
| `alarms.count`, `alarms.list` | offene Alarme in SiPass (jede Minute) |
| `info.lastRaw` | letzte Meldung von SiPass unverändert (zur Fehlersuche) |

## Zutritt & Alarmanlage

Zutrittskontrolle und Einbruchmeldeanlage arbeiten ohne Verkabelung zusammen, z. B. mit dem NOX-Adapter
(`nox_alarmzentrale.0.areas.N.armed`). Pro Bereich eine Zeile im Abschnitt „Zutritt & Alarmanlage“:

| Spalte | Bedeutung |
| --- | --- |
| Datenpunkt „scharf“ | z. B. `nox_alarmzentrale.0.areas.1.armed` (true = scharf) |
| Unscharf an Lesern | gültige Buchung dort → **unscharf** (nur wenn scharf), z. B. `Haustüre` |
| Scharf an Lesern | gültige Buchung dort → **scharf**, z. B. ein Leser innen am Ausgang |
| Karte zweimal = scharf | dieselbe Person bucht innerhalb von 10 s zweimal an einem Unscharf-Leser, während der Bereich unscharf ist → scharf |
| Personen | Teile des Namens, mit Komma getrennt (leer = alle mit gültiger Karte) |
| Zeiten | z. B. `Mo-Fr 06:00-22:00; Sa 08:00-12:00` (leer = immer) |

- **Scharf nur, wenn bereit:** Ist ein Melder offen (`ready` = false), wird nicht scharf geschaltet. Es kommt die
  Meldung „EG NICHT scharf – offen: Fenster Küche“.
- **Kontrolle:** Nach dem Schalten prüft der Adapter, ob es geklappt hat (unscharf nach 8 s, scharf nach 30 s, wegen
  der Ausgangsverzögerung). Danach kommt die Meldung „EG unscharf durch Max Muster (Haustüre)“ oder „… hat NICHT
  geklappt“.
- **Abgewiesene Buchung** an einem dieser Leser, während der Bereich scharf ist → Meldung.
- **Meldungen an:** ein Datenpunkt, z. B. `smartview.0.push.message`. SmartView schickt sie als Push / Telegram /
  WhatsApp und zeigt sie in der Meldungsliste. Jeder andere Datenpunkt bekommt den Text.
- Datenpunkte `alarm.lastAction`, `alarm.lastText`, `alarm.lastPerson`, `alarm.lastArea`, `alarm.lastTime`.
- Schaltet nur mit **„Steuern erlauben“**. Ohne den Haken steht im Log nur, was passieren würde – gut zum Ausprobieren.
- Eine abgewiesene Buchung schaltet nie. Eine Karte allein ist nur ein Faktor: Für das Unscharfschalten sind Leser
  mit **Karte + PIN** (in SiPass einstellbar) sicherer. Bei Anlagen nach EN 50131 / VdS ist das keine zugelassene
  Schalteinrichtung.
- Die bisherigen **Regeln** gibt es weiterhin. Für dieselbe Aufgabe bitte nicht beides eintragen, sonst wird doppelt
  geschaltet.

## SiPass-Dienste überwachen (Watchdog)

Bleibt SiPass öfter stehen: am SiPass-PC den **Dienst-Wächter** einrichten – ein kleines Programm mit Fenster, in dem man
beliebige Windows-Dienste anhakt; stehen sie, startet er sie jede Minute wieder (optional mit Port-Prüfung). Anleitung: [`tools/windows/ANLEITUNG.md`](tools/windows/ANLEITUNG.md).

## Lizenz

MIT
