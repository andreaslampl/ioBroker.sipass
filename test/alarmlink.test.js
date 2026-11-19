'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AlarmLink, parseTimes, inTimes } = require('../lib/alarmlink');
const { fakeSiPass, install, until } = require('./fake');

install();

const at = (day, hh, mm) => new Date(2026, 10, 16 + day, hh, mm); // 16.11.2026 = Monday

test('times: weekdays, ranges over the weekend and midnight, invalid parts dropped', () => {
    const w = parseTimes('Mo-Fr 06:00-22:00; Sa,So 08:00-12:00; kaputt');
    assert.equal(w.length, 2);
    assert.equal(inTimes(w, at(0, 6, 0)), true, 'Monday 06:00');
    assert.equal(inTimes(w, at(0, 22, 0)), false, 'Monday 22:00 (end excluded)');
    assert.equal(inTimes(w, at(5, 9, 0)), true, 'Saturday 09:00');
    assert.equal(inTimes(w, at(6, 13, 0)), false, 'Sunday 13:00');
    const night = parseTimes('Fr 22:00-02:00');
    assert.equal(inTimes(night, at(4, 23, 0)), true, 'Friday 23:00');
    assert.equal(inTimes(night, at(5, 1, 0)), true, 'Saturday 01:00 belongs to Friday night');
    assert.equal(inTimes(night, at(6, 1, 0)), false);
    assert.equal(inTimes(parseTimes(''), at(0, 3, 0)), true, 'empty = always');
    assert.equal(inTimes(parseTimes('Fr-Mo 00:00-23:59'), at(6, 12, 0)), true, 'Fr-Mo includes Sunday');
});

function setup(o = {}) {
    const st = { 'nox.0.areas.1.armed': true, 'nox.0.areas.1.ready': true, 'nox.0.areas.1.openInputs': '', ...o.states };
    const writes = [];
    const msgs = [];
    const done = [];
    const logs = [];
    const link = new AlarmLink({
        links: [{ name: 'EG', armed: 'nox.0.areas.1.armed', disarmReaders: 'Haustüre', armReaders: 'Ausgang', double: true, persons: 'muster, anna', times: o.times || '', ...o.link }],
        read: async id => st[id],
        write: async (id, v) => {
            writes.push([id, v]);
            st[id] = o.ignore ? st[id] : v;
        },
        notify: (t, x) => msgs.push(x),
        done: a => done.push(a.action),
        control: o.control !== false,
        log: { info: m => logs.push(m) },
        now: () => o.now || at(0, 12, 0),
        verifyMs: 30,
        disarmVerifyMs: 30,
    });
    return { st, writes, msgs, done, logs, link };
}
const ev = (person, location, granted = true) => ({ granted, denied: !granted, person, location, description: '', token: '' });
const wait = ms => new Promise(r => setTimeout(r, ms));

test('alarm link: disarm at the entry, arm at the exit only when ready, messages after the check', async () => {
    const t = setup();
    await t.link.onAccess(ev('Max Muster', 'Haustüre Tür 1 Leser'), 'Haustüre Tür 1 Leser');
    assert.deepEqual(t.writes, [['nox.0.areas.1.armed', false]]);
    await wait(60);
    assert.deepEqual(t.msgs, ['EG unscharf durch Max Muster (Haustüre Tür 1 Leser)']);
    // exit while a window is open: not armed, message with the open detectors
    t.st['nox.0.areas.1.ready'] = false;
    t.st['nox.0.areas.1.openInputs'] = 'Fenster Küche';
    t.link.busy.clear();
    await t.link.onAccess(ev('Max Muster', 'Ausgang Leser'), 'Ausgang Leser');
    assert.equal(t.writes.length, 1);
    assert.match(t.msgs[1], /EG NICHT scharf .* offen: Fenster Küche/);
    t.st['nox.0.areas.1.ready'] = true;
    await t.link.onAccess(ev('Max Muster', 'Ausgang Leser'), 'Ausgang Leser');
    assert.deepEqual(t.writes[1], ['nox.0.areas.1.armed', true]);
    await wait(60);
    assert.equal(t.msgs[2], 'EG scharf durch Max Muster (Ausgang Leser)');
    assert.deepEqual(t.done, ['disarmed', 'notReady', 'armed']);
});

test('alarm link: card twice arms only when it was unarmed (no disarm + re-arm), other persons / times / denied', async () => {
    const t = setup({ states: { 'nox.0.areas.1.armed': false } });
    await t.link.onAccess(ev('Anna Andere', 'Haustüre'), 'Haustüre');
    assert.equal(t.writes.length, 0, 'first card while unarmed: just the door');
    await t.link.onAccess(ev('Anna Andere', 'Haustüre'), 'Haustüre');
    assert.deepEqual(t.writes, [['nox.0.areas.1.armed', true]], 'second card within 10 s: armed');
    // armed: first card disarms, a second card right after must not arm again
    const u = setup();
    await u.link.onAccess(ev('Max Muster', 'Haustüre'), 'Haustüre');
    u.link.busy.clear();
    await u.link.onAccess(ev('Max Muster', 'Haustüre'), 'Haustüre');
    assert.deepEqual(u.writes, [['nox.0.areas.1.armed', false]]);
    // somebody not on the list, outside the times, a denied booking
    const v = setup({ times: 'Mo-Fr 06:00-08:00' });
    await v.link.onAccess(ev('Eva Fremd', 'Haustüre'), 'Haustüre');
    await v.link.onAccess(ev('Max Muster', 'Haustüre'), 'Haustüre');
    await v.link.onAccess(ev('Max Muster', 'Haustüre', false), 'Haustüre');
    assert.deepEqual(v.writes, []);
    assert.match(v.logs.join('\n'), /Eva Fremd darf die Alarmanlage nicht schalten/);
    assert.match(v.logs.join('\n'), /außerhalb der erlaubten Zeiten/);
    assert.deepEqual(v.msgs, ['Abgewiesene Buchung bei scharfer Anlage: EG, Haustüre, Max Muster']);
});

test('alarm link: failed command is reported; without control only a log line', async () => {
    const t = setup({ ignore: true, states: { 'nox.0.areas.1.error': 'Bereich nicht bereit' } });
    await t.link.onAccess(ev('Max Muster', 'Haustüre'), 'Haustüre');
    await wait(60);
    assert.equal(t.msgs[0], 'EG: Unscharfschalten durch Max Muster hat NICHT geklappt (Bereich nicht bereit)');
    const u = setup({ control: false });
    await u.link.onAccess(ev('Max Muster', 'Haustüre'), 'Haustüre');
    assert.deepEqual(u.writes, []);
    assert.match(u.logs.join('\n'), /würde unscharf schalten/);
});

test('adapter: booking at the real SiPass shape disarms the NOX area and sends a SmartView message', async t => {
    const s = fakeSiPass();
    const port = await s.listen();
    const adapter = require('../main.js')({
        config: {
            host: '127.0.0.1', port, secure: false, user: 'iobroker', password: 'geheim', rules: [], allowControl: true,
            alarmLinks: [{ enabled: true, name: 'Erdgeschoss', armed: 'nox_alarmzentrale.0.areas.1.armed', disarmReaders: 'Haustüre', armReaders: '', persons: 'Muster', times: '' }],
            alarmNotify: 'smartview.0.push.message',
        },
    });
    adapter.alarmTiming = { disarmVerifyMs: 50, verifyMs: 50 };
    adapter.states['nox_alarmzentrale.0.areas.1.armed'] = { val: true, ack: true };
    t.after(async () => {
        await new Promise(r => adapter.emit('unload', r));
        await s.close();
    });
    adapter.emit('ready');
    await until(() => adapter.val('info.connection') === true);
    s.push(JSON.stringify([{ FirstName: 'Max', LastName: 'Muster', ObjectToken: '1', ObjectType: 7, Description: 'Gültiger Ausweis: 1234567890123456 Firmencode 0', Location: 'Haustüre Tür 1 Leser', OccurenceTime: new Date().toISOString(), SubType: 12, Type: 1 }]));
    await until(() => adapter.states['nox_alarmzentrale.0.areas.1.armed'].ack === false);
    assert.equal(adapter.states['nox_alarmzentrale.0.areas.1.armed'].val, false);
    await until(() => adapter.states['smartview.0.push.message']);
    assert.deepEqual(JSON.parse(adapter.states['smartview.0.push.message'].val), { title: 'Alarmanlage', text: 'Erdgeschoss unscharf durch Max Muster (Haustüre Tür 1 Leser)' });
    assert.equal(adapter.val('alarm.lastAction'), 'disarmed');
    assert.equal(adapter.val('alarm.lastPerson'), 'Max Muster');
});
