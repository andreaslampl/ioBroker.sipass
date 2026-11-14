'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeSiPass, install, until } = require('./fake');
const E = require('../lib/events');

install();

test('events: state names and numbers, message shapes, rules', () => {
    assert.equal(E.OBJECT_STATES.length, 147);
    assert.equal(E.OBJECT_STATES[34], 'AccessGranted');
    assert.equal(E.OBJECT_STATES[44], 'AccessDenied');
    assert.equal(E.OBJECT_STATES[146], 'DeviceOnlineStandardComms');
    assert.equal(E.stateName(34), 'AccessGranted');
    assert.equal(E.stateName('AccessGranted = 34'), 'AccessGranted');
    assert.equal(E.typeName(1), 'Access');
    // objects, JSON strings, arrays, camelCase
    const m = { Type: 1, ObjectState: 34, Description: 'Max Muster', Location: 'Haustüre Tür 1 Leser', OccurenceTime: '2026-11-13T08:00:00Z' };
    assert.equal(E.messages([m]).length, 1);
    assert.equal(E.messages([JSON.stringify(m)]).length, 1);
    assert.equal(E.messages([{ wrap: [m, { objectState: 'AccessDenied' }] }]).length, 2);
    const ev = E.normalize(m);
    assert.equal(ev.granted, true);
    assert.equal(ev.text, 'Zutritt gewährt');
    assert.equal(ev.time, Date.parse('2026-11-13T08:00:00Z'));
    assert.equal(E.normalize({ objectState: 'AccessDenied' }).denied, true);
    assert.ok(E.ruleMatches({ reader: 'haustüre', person: '' }, ev, 'Haustüre Tür 1 Leser'));
    assert.ok(E.ruleMatches({ reader: '', person: 'muster' }, ev, ''));
    assert.ok(!E.ruleMatches({ reader: 'garage' }, ev, 'Haustüre Tür 1 Leser'));
    assert.ok(!E.ruleMatches({ reader: '', person: 'anna' }, ev, ''));
    assert.ok(!E.ruleMatches({ reader: '' }, E.normalize({ ObjectState: 44 }), ''), 'denied never fires');
    const { typed } = require('../main');
    assert.equal(typed('0', 'number'), 0);
    assert.equal(typed('', 'boolean'), true);
    assert.equal(typed('false', 'boolean'), false);
    assert.equal(typed('Unscharf', 'mixed'), 'Unscharf');
});

async function start(t, config = {}) {
    const s = fakeSiPass();
    const port = await s.listen();
    const adapter = require('../main.js')({
        config: { host: '127.0.0.1', port, secure: false, user: 'iobroker', password: 'geheim', rules: [], rawLog: true, ...config },
    });
    t.after(async () => {
        await new Promise(r => adapter.emit('unload', r));
        await s.close();
    });
    adapter.emit('ready');
    return { s, adapter };
}

test('adapter: login, readers, live events, history, alarms', async t => {
    const { s, adapter } = await start(t);
    await until(() => adapter.val('info.connection') === true);
    assert.ok(s.requests.some(r => r.includes('messageSubscriptionType=0')));
    assert.equal(adapter.val('readers.1.name'), 'Haustüre Tür 1 Leser');
    assert.equal(adapter.val('readers.19.name'), 'Gerätehütte Leser');
    // a granted access at the front door (reader found by the name in Location), then a denied one
    s.push({ Type: 'Access = 1', ObjectState: 'AccessGranted = 34', Description: 'Karteninhaber Max Muster', Location: 'Haustüre Tür 1 Leser', OccurenceTime: new Date().toISOString() });
    await until(() => adapter.val('access.grantedReader') === 'Haustüre Tür 1 Leser');
    assert.match(adapter.val('access.grantedText'), /Zutritt gewährt – Haustüre Tür 1 Leser – Karteninhaber Max Muster/);
    assert.ok(adapter.val('readers.1.lastGranted') > 0);
    s.push(JSON.stringify({ Type: 1, ObjectState: 44, Description: 'Unbekannte Karte', Token: '19' }));
    await until(() => adapter.val('access.deniedReader') === 'Gerätehütte Leser');
    assert.equal(adapter.val('readers.19.lastText'), 'Zutritt verweigert');
    assert.equal(JSON.parse(adapter.val('events.history')).length, 2);
    assert.ok(adapter.logs.some(l => l.startsWith('info: SiPass meldet MessageHub.acceptMessage')), 'raw messages are logged for the first tests');
    assert.equal(adapter.val('alarms.count'), 0);
});

test('adapter: rules only with allowControl; value typed to the target', async t => {
    const { s, adapter } = await start(t, {
        allowControl: false,
        rules: [{ name: 'NOX unscharf', reader: 'Haustüre', person: 'Muster', target: 'nox_alarmzentrale.0.areas.1.command', value: '0' }],
    });
    adapter.foreign['nox_alarmzentrale.0.areas.1.command'] = { type: 'number' };
    await until(() => adapter.val('info.connection') === true);
    const ev = { Type: 1, ObjectState: 34, Description: 'Max Muster', Location: 'Haustüre Tür 1 Leser' };
    s.push(ev);
    await until(() => adapter.logs.some(l => l.includes('würde nox_alarmzentrale.0.areas.1.command schalten')));
    assert.equal(adapter.states['nox_alarmzentrale.0.areas.1.command'], undefined, 'nothing written without allowControl');

    adapter.config.allowControl = true;
    s.push({ ...ev, Description: 'Anna Andere' });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(adapter.states['nox_alarmzentrale.0.areas.1.command'], undefined, 'other person: no');
    s.push({ ...ev, Location: 'Gerätehütte Leser' });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(adapter.states['nox_alarmzentrale.0.areas.1.command'], undefined, 'other reader: no');
    s.push({ ...ev, ObjectState: 44 });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(adapter.states['nox_alarmzentrale.0.areas.1.command'], undefined, 'denied: no');
    s.push(ev);
    await until(() => adapter.states['nox_alarmzentrale.0.areas.1.command']);
    assert.deepEqual(adapter.states['nox_alarmzentrale.0.areas.1.command'], { val: 0, ack: false });
});

test('adapter: session lost -> logs in again and reconnects the notifier; logout on unload', async t => {
    const { s, adapter } = await start(t);
    await until(() => adapter.val('info.connection') === true);
    s.expire();
    await until(() => adapter.val('info.connection') === false);
    await until(() => adapter.val('info.connection') === true, 15000);
    s.push({ Type: 1, ObjectState: 34, Location: 'Gerätehütte Leser', Description: 'X' });
    await until(() => adapter.val('access.grantedReader') === 'Gerätehütte Leser');
    await new Promise(r => adapter.emit('unload', r));
    assert.equal(s.sessions.size, 0, 'session freed on unload, so the next start is not refused (910)');
});

test('adapter: wrong password is reported clearly', async t => {
    const { adapter } = await start(t, { password: 'falsch' });
    await until(() => adapter.logs.some(l => l.includes('Benutzername oder Passwort falsch')));
    assert.equal(adapter.val('info.connection'), false);
});

test('adapter: real SiPass 3.0 message shape (no ObjectState, result in the text, person, card number masked, Alive ignored)', async t => {
    const { s, adapter } = await start(t, {
        allowControl: true,
        rules: [{ name: 'NOX', reader: 'Haustüre', person: 'Muster', target: 'nox_alarmzentrale.0.areas.1.command', value: '0' }],
    });
    adapter.foreign['nox_alarmzentrale.0.areas.1.command'] = { type: 'number' };
    await until(() => adapter.val('info.connection') === true);
    // as logged on the owner's SiPass 3.0 (names / card number replaced): one JSON string with an array
    const booking = (desc, readerToken, location) => JSON.stringify([{
        CardNumber: '1234567890123456', CardTechnology: 26, FacilityCode: 0, FirstName: 'Max', LastName: 'Muster',
        ObjectToken: readerToken, ObjectType: 7, State: 5, StateType: 1, PointDisabledState: 1, CommsStatus: 1,
        Description: desc, Location: location, LogTime: '2026-11-15T00:15:09', OccurenceTime: '2026-11-15T00:15:07',
        SubType: 12, Token: '432', Type: 1, OperatorDetail: { FirstName: 'Max', LastName: 'Muster' },
    }]);
    s.push(JSON.stringify([{ Description: '', Location: 'DAMS-Service', LogTime: '2026-11-15T00:13:05', OccurenceTime: '2026-11-15T00:13:05', SubType: 35, Token: '', Type: 5 }]));
    s.push(booking('Gültiger Ausweis: 1234567890123456 Firmencode 0', '1', 'Haustüre Tür 1 Leser'));
    await until(() => adapter.val('access.grantedPerson') === 'Max Muster');
    assert.equal(adapter.val('access.grantedReader'), 'Haustüre Tür 1 Leser');
    assert.equal(adapter.val('access.grantedText'), 'Zutritt gewährt – Haustüre Tür 1 Leser – Max Muster');
    assert.equal(adapter.val('readers.1.lastPerson'), 'Max Muster');
    assert.equal(adapter.val('readers.1.lastDescription'), 'Gültiger Ausweis: …3456 Firmencode 0');
    await until(() => adapter.states['nox_alarmzentrale.0.areas.1.command']);
    assert.deepEqual(adapter.states['nox_alarmzentrale.0.areas.1.command'], { val: 0, ack: false });
    // denied: "Ungültiger Ausweis" must not count as granted
    s.push(booking('Ungültiger Ausweis: 1234567890123456 Firmencode 0', '19', 'Gerätehütte Leser'));
    await until(() => adapter.val('access.deniedReader') === 'Gerätehütte Leser');
    const history = JSON.parse(adapter.val('events.history'));
    assert.equal(history.length, 2, 'Alive is not an event');
    const all = JSON.stringify(adapter.states) + adapter.logs.join('\n');
    assert.ok(!all.includes('1234567890123456'), 'no full card number in states or logs');
});
