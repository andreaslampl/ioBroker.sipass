'use strict';

/*
 * ioBroker.sipass - SiPass integrated (Siemens / Acre) via the Management Station API (REST, port 8744) and its live
 * notifier (SignalR hub messageHub): readers, access events (granted / denied), door alarms, outstanding alarms,
 * and rules "granted access at reader X (person Y) -> write data point Z" (e.g. disarm the NOX) - only with allowControl.
 */

const utils = require('@iobroker/adapter-core');
const { SiPassClient } = require('./lib/client');
const { SignalRClient } = require('./lib/signalr');
const E = require('./lib/events');

const ro = (name, type, role, extra = {}) => ({ type: 'state', common: { name, type, role, read: true, write: false, ...extra }, native: {} });

const OBJECTS = {
    info: { type: 'channel', common: { name: 'Information' }, native: {} },
    'info.connection': ro('Verbunden mit SiPass (Anmeldung + Live-Meldungen)', 'boolean', 'indicator.connected'),
    'info.notifier': ro('Live-Meldungen (Notifier) verbunden', 'boolean', 'indicator.connected'),
    'info.lastRaw': ro('Letzte Meldung von SiPass (roh)', 'string', 'json'),
    events: { type: 'channel', common: { name: 'Ereignisse' }, native: {} },
    'events.last': ro('Letztes Ereignis', 'string', 'json'),
    'events.lastText': ro('Letztes Ereignis (Text)', 'string', 'text'),
    'events.lastTime': ro('Letztes Ereignis (Zeit)', 'number', 'date'),
    'events.history': ro('Letzte Ereignisse', 'string', 'json'),
    access: { type: 'channel', common: { name: 'Buchungen' }, native: {} },
    'access.granted': ro('Letzte gültige Buchung', 'string', 'json'),
    'access.grantedText': ro('Letzte gültige Buchung (Text)', 'string', 'text'),
    'access.grantedReader': ro('Letzte gültige Buchung: Leser', 'string', 'text'),
    'access.grantedTime': ro('Letzte gültige Buchung: Zeit', 'number', 'date'),
    'access.denied': ro('Letzte abgewiesene Buchung', 'string', 'json'),
    'access.deniedText': ro('Letzte abgewiesene Buchung (Text)', 'string', 'text'),
    'access.deniedReader': ro('Letzte abgewiesene Buchung: Leser', 'string', 'text'),
    'access.deniedTime': ro('Letzte abgewiesene Buchung: Zeit', 'number', 'date'),
    alarms: { type: 'channel', common: { name: 'Offene Alarme' }, native: {} },
    'alarms.count': ro('Anzahl offener Alarme', 'number', 'value'),
    'alarms.list': ro('Offene Alarme', 'string', 'json'),
    readers: { type: 'channel', common: { name: 'Leser' }, native: {} },
};

const READER_STATES = {
    name: ro('Name', 'string', 'text'),
    lastText: ro('Letztes Ereignis', 'string', 'text'),
    lastState: ro('Letztes Ereignis (SiPass)', 'string', 'text'),
    lastDescription: ro('Letzte Meldung', 'string', 'text'),
    lastTime: ro('Letztes Ereignis: Zeit', 'number', 'date'),
    lastGranted: ro('Letzte gültige Buchung: Zeit', 'number', 'date'),
    lastDenied: ro('Letzte abgewiesene Buchung: Zeit', 'number', 'date'),
};

const safeId = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_') || '_';

class SiPass extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'sipass' });
        this.readers = new Map(); // token -> name
        this.history = [];
        this.ruleFired = new Map(); // rule index -> time
        this.timers = {};
        this.backoff = 5000;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    get rules() {
        return (Array.isArray(this.config.rules) ? this.config.rules : []).filter(r => r && String(r.target || '').trim());
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        await this.setState('info.notifier', false, true);
        const host = String(this.config.host || '').trim();
        if (!host || !this.config.user) {
            this.log.error('Adresse, Benutzer und Passwort von SiPass fehlen (Instanz-Einstellungen)');
            return;
        }
        for (const [id, obj] of Object.entries(OBJECTS)) {
            await this.extendObject(id, obj);
        }
        const hist = await this.getStateAsync('events.history');
        try {
            this.history = hist && hist.val ? JSON.parse(hist.val) : [];
        } catch {
            this.history = [];
        }
        this.api = new SiPassClient({
            host,
            port: Number(this.config.port) || 8744,
            secure: this.config.secure !== false,
            user: String(this.config.user),
            password: String(this.config.password || ''),
            log: this.log,
        });
        this.notifier = new SignalRClient({ client: this.api, log: this.log });
        this.notifier.on('message', (hub, method, args) => this.onMessage(hub, method, args));
        this.notifier.on('closed', () => {
            this.log.warn('Live-Meldungen (Notifier) getrennt - verbinde neu');
            this.setState('info.notifier', false, true);
            this.setState('info.connection', false, true);
            this.later('connect', () => this.connect(), 2000);
        });
        if (this.rules.length && !this.config.allowControl) {
            this.log.info(`${this.rules.length} Regel(n) eingetragen, aber "Steuern erlauben" ist aus - Regeln werden nur im Log angezeigt`);
        }
        await this.connect();
    }

    later(key, fn, ms) {
        clearTimeout(this.timers[key]);
        this.timers[key] = setTimeout(() => {
            if (!this.stopped) {
                fn();
            }
        }, ms);
    }

    /** login (if needed), readers, subscriptions, notifier; on errors again with growing pauses */
    async connect() {
        if (this.stopped || this.connecting) {
            return;
        }
        this.connecting = true;
        try {
            if (!this.api.token) {
                await this.api.login();
                this.log.info(`Bei SiPass angemeldet (Sitzung ${this.api.sessionTimeout} s)`);
                await this.loadReaders();
            }
            await this.api.subscribe(0); // events (accesses, doors)
            await this.api.subscribe(1); // alarms
            await this.notifier.start();
            this.log.info('Live-Meldungen (Notifier) verbunden');
            await this.setState('info.notifier', true, true);
            await this.setState('info.connection', true, true);
            this.backoff = 5000;
            this.scheduleRenew();
            this.pollAlarms();
        } catch (err) {
            await this.setState('info.connection', false, true);
            if (err.code === 910 || err.code === 911 || err.code === 920) {
                this.log.error(`SiPass: ${err.message}`);
            } else {
                this.log.warn(`SiPass: ${err.message} - neuer Versuch in ${Math.round(this.backoff / 1000)} s`);
            }
            this.notifier.stop();
            if (err.code === 908 || err.code === 919) {
                this.api.token = '';
            }
            // an old session of the same user blocks the login until it times out (SessionTimeout)
            const wait = err.code === 910 ? Math.max(this.backoff, 60000) : this.backoff;
            this.backoff = Math.min(this.backoff * 2, 300000);
            this.later('connect', () => this.connect(), wait);
        } finally {
            this.connecting = false;
        }
    }

    scheduleRenew() {
        const ms = Number(this.config.renewMs) || Math.max(30, Math.floor(this.api.sessionTimeout / 3)) * 1000;
        this.later('renew', async () => {
            try {
                await this.api.renew();
            } catch (err) {
                this.log.warn(`Sitzung verlängern: ${err.message} - melde neu an`);
                this.api.token = '';
                this.notifier.stop();
                await this.setState('info.connection', false, true);
                await this.connect();
                return;
            }
            this.scheduleRenew();
        }, ms);
    }

    async loadReaders() {
        let list = [];
        try {
            list = await this.api.list('/AccessPoints');
        } catch (err) {
            this.log.warn(`Leser lesen: ${err.message}`);
            return;
        }
        this.readers.clear();
        for (const r of list) {
            const token = String(E.field(r, 'Token') ?? '');
            if (!token) {
                continue;
            }
            const name = String(E.field(r, 'Name') || `Leser ${token}`);
            this.readers.set(token, name);
            const base = `readers.${safeId(token)}`;
            await this.extendObject(base, { type: 'channel', common: { name }, native: { token } });
            for (const [k, obj] of Object.entries(READER_STATES)) {
                await this.extendObject(`${base}.${k}`, obj);
            }
            await this.setState(`${base}.name`, name, true);
        }
        this.log.info(`${this.readers.size} Leser: ${[...this.readers.values()].join(', ')}`);
    }

    async pollAlarms() {
        try {
            const list = await this.api.get('/Alarms');
            const arr = Array.isArray(list) ? list : (list && list.ResourceList) || [];
            const short = arr.map(m => E.normalize(m)).map(a => ({ text: a.text, description: a.description, location: a.location, time: a.time, state: a.alarmState }));
            await this.setState('alarms.count', short.length, true);
            await this.setState('alarms.list', JSON.stringify(short), true);
        } catch (err) {
            this.log.debug(`Alarme lesen: ${err.message}`);
        }
        this.later('alarms', () => this.pollAlarms(), Number(this.config.alarmPollMs) || 60000);
    }

    /** reader of an event: by token, else by its name appearing in location / description */
    readerOf(ev) {
        if (ev.token && this.readers.has(ev.token)) {
            return { token: ev.token, name: this.readers.get(ev.token) };
        }
        const hay = `${ev.location} ${ev.description}`.toLowerCase();
        let best = null;
        for (const [token, name] of this.readers) {
            if (name && hay.includes(name.toLowerCase()) && (!best || name.length > best.name.length)) {
                best = { token, name };
            }
        }
        return best;
    }

    onMessage(hub, method, args) {
        const raw = JSON.stringify({ hub, method, args });
        if (this.config.rawLog !== false) {
            this.log.info(`SiPass meldet ${hub}.${method}: ${raw.slice(0, 2000)}`);
        } else {
            this.log.debug(`SiPass meldet ${hub}.${method}: ${raw.slice(0, 2000)}`);
        }
        this.setState('info.lastRaw', raw.slice(0, 20000), true);
        for (const m of E.messages(args)) {
            this.onEvent(E.normalize(m)).catch(err => this.log.warn(`Ereignis: ${err.message}`));
        }
    }

    async onEvent(ev) {
        const reader = this.readerOf(ev);
        const where = reader ? reader.name : ev.location;
        const line = [ev.text, where, ev.description].filter(Boolean).join(' – ');
        const entry = { time: ev.time, type: ev.type, state: ev.state, text: ev.text, reader: where, description: ev.description, granted: ev.granted, denied: ev.denied };
        this.history.unshift(entry);
        this.history = this.history.slice(0, Math.max(1, Math.min(500, Number(this.config.keep) || 50)));
        await this.setState('events.last', JSON.stringify(entry), true);
        await this.setState('events.lastText', line, true);
        await this.setState('events.lastTime', ev.time, true);
        await this.setState('events.history', JSON.stringify(this.history), true);
        if (reader) {
            const base = `readers.${safeId(reader.token)}`;
            await this.setState(`${base}.lastText`, ev.text, true);
            await this.setState(`${base}.lastState`, ev.state, true);
            await this.setState(`${base}.lastDescription`, ev.description, true);
            await this.setState(`${base}.lastTime`, ev.time, true);
            if (ev.granted) {
                await this.setState(`${base}.lastGranted`, ev.time, true);
            }
            if (ev.denied) {
                await this.setState(`${base}.lastDenied`, ev.time, true);
            }
        }
        for (const kind of ['granted', 'denied']) {
            if (ev[kind]) {
                await this.setState(`access.${kind}`, JSON.stringify(entry), true);
                await this.setState(`access.${kind}Text`, line, true);
                await this.setState(`access.${kind}Reader`, where, true);
                await this.setState(`access.${kind}Time`, ev.time, true);
            }
        }
        if (ev.granted) {
            await this.runRules(ev, reader ? reader.name : '');
        }
    }

    /** granted access -> rules (only with allowControl; the same rule at most every 5 s) */
    async runRules(ev, readerName) {
        for (const [i, rule] of this.rules.entries()) {
            if (!E.ruleMatches(rule, ev, readerName)) {
                continue;
            }
            const label = rule.name || `Regel ${i + 1}`;
            const target = String(rule.target).trim();
            if (!this.config.allowControl) {
                this.log.info(`${label}: würde ${target} schalten (${readerName || ev.location}) - "Steuern erlauben" ist aus`);
                continue;
            }
            const now = Date.now();
            if (now - (this.ruleFired.get(i) || 0) < 5000) {
                continue;
            }
            this.ruleFired.set(i, now);
            try {
                const obj = await this.getForeignObjectAsync(target);
                if (!obj) {
                    this.log.warn(`${label}: Datenpunkt ${target} gibt es nicht`);
                    continue;
                }
                const val = typed(rule.value, obj.common && obj.common.type);
                await this.setForeignStateAsync(target, val, false);
                this.log.info(`${label}: ${target} = ${JSON.stringify(val)} (gültige Buchung ${readerName || ev.location}${ev.description ? `: ${ev.description}` : ''})`);
            } catch (err) {
                this.log.warn(`${label}: ${err.message}`);
            }
        }
    }

    async onUnload(callback) {
        this.stopped = true;
        try {
            for (const t of Object.values(this.timers)) {
                clearTimeout(t);
            }
            if (this.notifier) {
                this.notifier.stop();
            }
            if (this.api) {
                // free the session, otherwise the next start is refused (910) until it times out
                await Promise.race([this.api.logout(), new Promise(r => setTimeout(r, 2000))]);
            }
            await this.setState('info.connection', false, true);
            await this.setState('info.notifier', false, true);
        } catch {
            // shutting down
        } finally {
            callback();
        }
    }
}

/** rule value in the type of the target data point; empty = true */
function typed(v, type) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (type === 'boolean') {
        return s === '' ? true : !['false', '0', 'aus', 'off', 'nein'].includes(s.toLowerCase());
    }
    if (type === 'number') {
        return s === '' ? 1 : Number(s.replace(',', '.'));
    }
    if (s === '') {
        return type === 'string' ? '' : true;
    }
    if (type === 'string') {
        return s;
    }
    if (/^-?\d+([.,]\d+)?$/.test(s)) {
        return Number(s.replace(',', '.'));
    }
    if (s === 'true' || s === 'false') {
        return s === 'true';
    }
    return s;
}

if (require.main !== module) {
    module.exports = options => new SiPass(options);
} else {
    new SiPass();
}

module.exports.typed = typed;
