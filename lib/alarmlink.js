'use strict';

/*
 * Access control <-> intrusion alarm (e.g. ioBroker.nox_alarmzentrale): per area a row with
 *  - armed: data point "armed" of the area (true = armed); siblings ready / openInputs / error are used when they exist
 *  - disarmReaders: a valid booking there disarms (only when armed)
 *  - armReaders: a valid booking there arms (only when unarmed and ready)
 *  - double: the same person books twice within `doubleMs` at a disarm reader while unarmed -> arm
 *  - persons (comma list, part of the name; empty = everybody), times ("Mo-Fr 06:00-22:00; Sa 08:00-12:00"; empty = always)
 * Messages ("Bereich EG unscharf durch Max Muster (Haustüre)", not ready, failed, denied booking while armed) go to
 * `notify(title, text)`. A denied booking never switches anything.
 */

const DAYS = { mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6, so: 0 };

const low = s => String(s || '').toLowerCase();
const list = s =>
    String(s || '')
        .split(/[,;]/)
        .map(x => low(x).trim())
        .filter(Boolean);

/** "Mo-Fr 06:00-22:00; Sa,So 08:00-12:00" -> [{days:Set, from, to}] (minutes); invalid parts are dropped */
function parseTimes(text) {
    const out = [];
    for (const part of String(text || '').split(';')) {
        const m = /^\s*([a-zA-Z,\s-]*?)\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
        if (!m) {
            continue;
        }
        const days = new Set();
        const spec = low(m[1]).replace(/\s+/g, '');
        if (!spec) {
            [0, 1, 2, 3, 4, 5, 6].forEach(d => days.add(d));
        }
        for (const piece of spec.split(',').filter(Boolean)) {
            const [a, b] = piece.split('-');
            if (!(a in DAYS) || (b && !(b in DAYS))) {
                continue;
            }
            if (!b) {
                days.add(DAYS[a]);
                continue;
            }
            // Mo-Fr, Sa-So, Fr-Mo (over the weekend)
            for (let d = DAYS[a], n = 0; n < 7; d = (d + 1) % 7, n++) {
                days.add(d);
                if (d === DAYS[b]) {
                    break;
                }
            }
        }
        if (days.size) {
            out.push({ days, from: Number(m[2]) * 60 + Number(m[3]), to: Number(m[4]) * 60 + Number(m[5]) });
        }
    }
    return out;
}

/** inside one of the windows (a window over midnight counts for the day it starts) */
function inTimes(windows, date) {
    if (!windows.length) {
        return true;
    }
    const min = date.getHours() * 60 + date.getMinutes();
    const day = date.getDay();
    return windows.some(w => {
        if (w.from <= w.to) {
            return w.days.has(day) && min >= w.from && min < w.to;
        }
        return (w.days.has(day) && min >= w.from) || (w.days.has((day + 6) % 7) && min < w.to);
    });
}

function readerMatches(words, ev, readerName) {
    const hay = [readerName, ev.location, ev.description].map(low);
    return words.some(w => hay.some(h => h.includes(w)) || low(ev.token) === w);
}

function personMatches(words, ev) {
    if (!words.length) {
        return true;
    }
    return words.some(w => low(ev.person).includes(w) || low(ev.description).includes(w));
}

const truthy = v => v === true || v === 1 || v === 'true' || v === '1';

class AlarmLink {
    /**
     * @param {object} o
     * @param {object[]} o.links rows of the settings
     * @param {(id: string) => Promise<any>} o.read value of a foreign data point (undefined = missing)
     * @param {(id: string, val: any) => Promise<void>} o.write command (ack false)
     * @param {(title: string, text: string) => void} o.notify
     * @param {(action: object) => void} [o.done] after every action (states "alarm.*")
     * @param {boolean} o.control allowControl
     */
    constructor({ links, read, write, notify, done = () => {}, control, log, now = () => new Date(), doubleMs = 10000, verifyMs = 30000, disarmVerifyMs = 8000 }) {
        this.links = (Array.isArray(links) ? links : [])
            .filter(l => l && l.enabled !== false && String(l.armed || '').trim())
            .map((l, i) => ({
                name: String(l.name || '').trim() || `Bereich ${i + 1}`,
                armed: String(l.armed).trim(),
                prefix: String(l.armed).trim().replace(/\.[^.]+$/, ''),
                disarm: list(l.disarmReaders),
                arm: list(l.armReaders),
                double: Boolean(l.double),
                persons: list(l.persons),
                times: parseTimes(l.times),
                key: i,
            }));
        this.read = read;
        this.write = write;
        this.notify = notify;
        this.done = done;
        this.control = control;
        this.log = log;
        this.now = now;
        this.doubleMs = doubleMs;
        this.verifyMs = verifyMs;
        this.disarmVerifyMs = disarmVerifyMs;
        this.pending = new Map(); // link key -> {person, at, wasArmed}
        this.busy = new Map(); // link key -> time of the last command
        this.timers = new Set();
    }

    stop() {
        for (const t of this.timers) {
            clearTimeout(t);
        }
        this.timers.clear();
    }

    _later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
    }

    /** readers that belong to any area (for the reader list in the log) */
    get size() {
        return this.links.length;
    }

    /** one normalised SiPass event */
    async onAccess(ev, readerName) {
        for (const link of this.links) {
            const atDisarm = readerMatches(link.disarm, ev, readerName);
            const atArm = readerMatches(link.arm, ev, readerName);
            if (!atDisarm && !atArm) {
                continue;
            }
            const armed = truthy(await this.read(link.armed));
            const who = ev.person || 'unbekannte Person';
            const where = readerName || ev.location || 'Leser';
            if (ev.denied) {
                if (armed) {
                    this.notify('Alarmanlage', `Abgewiesene Buchung bei scharfer Anlage: ${link.name}, ${where}${ev.person ? `, ${ev.person}` : ''}`);
                    this.done({ action: 'denied', link: link.name, person: ev.person, reader: where });
                }
                continue;
            }
            if (!ev.granted) {
                continue;
            }
            if (!personMatches(link.persons, ev)) {
                this.log.info(`${link.name}: ${who} darf die Alarmanlage nicht schalten (Liste der Personen)`);
                continue;
            }
            if (!inTimes(link.times, this.now())) {
                this.log.info(`${link.name}: Buchung von ${who} außerhalb der erlaubten Zeiten - Alarmanlage bleibt, wie sie ist`);
                continue;
            }
            const now = Date.now();
            // card twice while unarmed (the first one did not disarm anything) -> arm
            if (atDisarm && link.double) {
                const p = this.pending.get(link.key);
                if (p && p.person === low(who) && now - p.at <= this.doubleMs && !p.wasArmed && !armed) {
                    this.pending.delete(link.key);
                    await this._arm(link, who, `${where}, Karte zweimal`);
                    continue;
                }
                this.pending.set(link.key, { person: low(who), at: now, wasArmed: armed });
            }
            if (atDisarm && armed) {
                await this._disarm(link, who, where);
            } else if (atArm && !armed) {
                await this._arm(link, who, where);
            }
        }
    }

    _allowed(link, what) {
        if (!this.control) {
            this.log.info(`${link.name}: würde ${what} - "Steuern erlauben" ist aus`);
            return false;
        }
        const now = Date.now();
        if (now - (this.busy.get(link.key) || 0) < 5000) {
            return false;
        }
        this.busy.set(link.key, now);
        return true;
    }

    async _disarm(link, who, where) {
        if (!this._allowed(link, 'unscharf schalten')) {
            return;
        }
        await this.write(link.armed, false);
        this.log.info(`${link.name}: unscharf durch ${who} (${where})`);
        this._later(async () => {
            const ok = !truthy(await this.read(link.armed));
            const error = ok ? '' : await this._error(link);
            this.notify('Alarmanlage', ok ? `${link.name} unscharf durch ${who} (${where})` : `${link.name}: Unscharfschalten durch ${who} hat NICHT geklappt${error}`);
            this.done({ action: ok ? 'disarmed' : 'disarmFailed', link: link.name, person: who, reader: where });
        }, this.disarmVerifyMs);
    }

    async _arm(link, who, where) {
        const ready = await this.read(`${link.prefix}.ready`);
        if (ready !== undefined && ready !== null && !truthy(ready)) {
            const open = await this.read(`${link.prefix}.openInputs`);
            this.notify('Alarmanlage', `${link.name} NICHT scharf (${who}, ${where}) - nicht scharfschaltbereit${open ? `, offen: ${open}` : ''}`);
            this.done({ action: 'notReady', link: link.name, person: who, reader: where });
            return;
        }
        if (!this._allowed(link, 'scharf schalten')) {
            return;
        }
        await this.write(link.armed, true);
        this.log.info(`${link.name}: scharf durch ${who} (${where})`);
        // the alarm panel may count down an exit delay first
        this._later(async () => {
            const ok = truthy(await this.read(link.armed));
            const error = ok ? '' : await this._error(link);
            this.notify('Alarmanlage', ok ? `${link.name} scharf durch ${who} (${where})` : `${link.name}: Scharfschalten durch ${who} hat NICHT geklappt${error}`);
            this.done({ action: ok ? 'armed' : 'armFailed', link: link.name, person: who, reader: where });
        }, this.verifyMs);
    }

    async _error(link) {
        const e = await this.read(`${link.prefix}.error`);
        return e ? ` (${e})` : '';
    }
}

module.exports = { AlarmLink, parseTimes, inTimes, readerMatches, personMatches };
