# ioBroker.sipass

ioBroker adapter for SiPass integrated (Siemens, now Acre Security) access control via the Management Station API (REST,
port 8744, HTTPS with SiPass' own certificate) and its live notifier (classic ASP.NET SignalR 2.4, hub `messageHub` at
`/Notifier`). Owner: SiPass 3.0 with an employee test licence (all modules). Goal: show bookings and let a granted access at a
reader disarm the NOX alarm system (ioBroker.nox_alarmzentrale) - SiPass can arm/disarm SPC via EDP itself, but not the NOX.

## Facts checked on the owner's SiPass 3.0 (PowerShell, swagger JSON from /swagger/docs/v1)

- `POST /api/management/v1/Authentication/Login` {UserName, Password} -> 201 {AuthenticationToken, SessionTimeout: 300}.
- Every further request: header `Authorization: <token>` (raw, no "Bearer"); AuthenticationToken/Token/X-Auth-Token -> 401 919.
- `GET …/Authentication/Renew`, `DELETE …/Authentication/Logout`; errors as {ErrorCode, Message} (910 = user already logged in,
  911 wrong password, 908 session expired, 906 already subscribed, 920 no licence).
- `GET /api/management/V1/Messages/Subscribe?messageSubscriptionType=0` (0 Event, 1 Alarm, 2 SubscriptionEvent) -> 200, body =
  notifier URL ("https://<hostname>:8744/Notifier/hubs").
- `/Notifier/negotiate?clientProtocol=2.1&connectionData=[{"name":"messagehub"}]` -> 200 only WITH the Authorization header
  (500 without); KeepAliveTimeout 20, TryWebSockets true. `/Notifier/hubs` proxy: hub `messageHub`, no server methods; the
  client method name SiPass calls is NOT known -> the adapter passes every hub call on and logs it (`rawLog`, default on).
- Message model (swagger AlarmMessage / State): Type (Access = 1 …), ObjectState (AccessGranted 34, AccessDenied 44, DoorForced 50,
  DoorHeld 49 …, 147 names in lib/events.js), Description, Location, OccurenceTime, Token. Values may come as names "X = n".
- Command API exists (`POST …/Command` {CommandType, ObjectToken, ObjectType}, e.g. IntrusionDisArm 39, AccessPointUnlock 20) -
  not used yet.

## Layout

- `lib/client.js` – `SiPassClient`: raw http(s) (rejectUnauthorized false), login/renew/logout, `request()` logs in again once
  on 908/919/900, `list()` (ResourceList), `subscribe()` (906 ok). German error texts per ErrorCode.
- `lib/signalr.js` – `SignalRClient`: negotiate -> ws connect (Authorization header) -> start; frames {} keep alive,
  {"M":[{H,M,A}]} -> emit 'message'; watchdog 2.5 x KeepAliveTimeout; 'closed' -> main reconnects.
- `lib/events.js` – OBJECT_STATES/TYPES, GRANTED/DENIED sets, German TEXT, `messages()` (finds message objects in hub args: objects,
  JSON strings, arrays, any case), `normalize()`, `ruleMatches()` (granted only; reader text in reader name/location/description
  or token; person text in description).
- `main.js` – connect(): login, readers (/AccessPoints -> readers.<token>.*), subscribe 0 + 1, notifier; backoff 5 s .. 5 min
  (910: at least 60 s - an old session blocks until it times out); renew every SessionTimeout/3; /Alarms every 60 s; events ->
  events.*, access.granted*/denied*, readers.*; rules (config.rules [{name, reader, person, target, value}], only with
  `allowControl` (default off - keep it that way), same rule max every 5 s, value typed by the target object); logout on unload.
- `test/` – `node --test`; `fake.js` = fake SiPass (REST + SignalR over ws as observed) + fake adapter-core.

## Status

- 0.1.0: built from the owner's swagger file and PowerShell checks; not yet run against the real SiPass. First field step: install,
  book once with a card, send the "SiPass meldet messageHub.<method>" log line -> adjust parsing if needed.
- 0.1.0 field: on the owner's ioBroker (js-controller 7.2.5, Node 22) login, 10 readers from /AccessPoints and the notifier
  connection work against the real SiPass 3.0. Waiting for the first booking's raw log line.

- 0.1.1: owner says SiPass services often stop -> `tools/windows/` (Windows side, the adapter cannot restart Windows services):
  `sipass-watchdog.ps1` (services matching -Pattern '*SiPass*[,…]' with StartMode Auto and not running -> Start-Service; optional
  -ApiService restarted after 2 failed TCP checks of -Port 8744; log C:\ProgramData\SiPassWatchdog\watchdog.log, -List),
  `install-watchdog.ps1` (scheduled task "SiPass Watchdog" every minute + at startup as SYSTEM, sc.exe failure restart/60000 x3,
  -Remove), ANLEITUNG.md. ASCII-only strings, saved with BOM + CRLF for Windows PowerShell 5.1. Not run on Windows here (no pwsh).

- 0.1.2: owner wanted a window and other services too -> `tools/windows/dienst-waechter.ps1` replaces the 0.1.1 scripts: WinForms
  window (self-elevates; ListView of all services with checkboxes, search, "nur überwachte", port per service via NumericUpDown,
  save -> C:\ProgramData\DienstWaechter\config.json {services:[{name, display, port}]}, copies itself there, task
  "Dienst-Waechter" every minute + at startup as SYSTEM running `-Run`, sc.exe failure restart x3; "Jetzt prüfen", log view,
  remove task); `-Run` = Invoke-Check (start stopped non-disabled services, restart after 2 failed port checks, state.json,
  missing services logged once). `Dienst-Waechter.cmd` launcher. UTF-8 with BOM + CRLF (umlauts, Windows PowerShell 5.1).
  Checked: parser of pwsh 7.4 (scratchpad), -Run with mocked Get-Service/Start-Service/Restart-Service; the window itself not
  run (no Windows here).

- 0.1.3 field: owner only saw the black admin console (window most likely behind it) -> Shown: TopMost on/off + Activate;
  console says what happens; GUI part in try/catch with the error + Read-Host.

- 0.1.4 field (stack from the owner's .NET dialog): the window never painted - ListView.OnItemChecked fires once per item when
  the handle is created (hundreds of services) and each call ran Update-Status -> Get-ScheduledTask (slow CIM). Now ticks are
  ignored until Form.Shown (`loading`), ItemChecked only updates the count, the task state is cached (`taskActive`, read at
  start / set on save / remove).

- 0.1.4 field, confirmed: the Dienst-Waechter window opens on the owner's SiPass PC (Windows 11, PowerShell 5.1).

- 0.1.4 field: bookings arrive in ioBroker from the real SiPass 3.0 (owner confirmed); hub method name / exact payload not yet
  noted - ask for one raw "SiPass meldet messageHub.<method>" line if parsing ever needs changes.

- 0.2.0 field payload (owner's SiPass 3.0): hub "MessageHub", method "acceptMessage", A = [JSON string of an array]. Access event:
  {CardNumber, CardTechnology, FacilityCode, FirstName, LastName, ObjectToken (= reader token from /AccessPoints), ObjectType 7,
  State 5, StateType 1, …, Description "Gültiger Ausweis: <card> Firmencode 0", Location (reader name), LogTime, OccurenceTime,
  SubType 12, Token (message id), Type 1, OperatorDetail} - NO ObjectState. -> events.js: result from the text (DENIED_TEXT first,
  "Ungültiger Ausweis" contains "gültiger Ausweis"; denied wording not yet seen in the field), person = First + Last name, reader =
  ObjectToken, `maskCards()` (digit runs >= 8 -> …last4) for states AND the raw log, Service/SubType 35 "Alive" (Location
  "DAMS-Service") ignored. States access.*Person, readers.*.lastPerson. Test with the real shape (anonymised).

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.sipass`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses, host names, operator names, passwords or cardholder names in the repository.
