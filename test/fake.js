'use strict';

/*
 * Fake SiPass Management Station API as seen on the owner's SiPass 3.0: Login -> {AuthenticationToken, SessionTimeout} (201),
 * token in header "Authorization", errors {ErrorCode, Message}, one session per user (910), Messages/Subscribe returns the
 * notifier URL, classic SignalR 2 at /Notifier (negotiate refuses without token with 500, like the real one).
 * Plus a fake adapter-core.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');

function fakeSiPass({ user = 'iobroker', password = 'geheim', timeout = 300 } = {}) {
    const s = {
        sessions: new Map(), // token -> {user, subscribed: Set}
        requests: [],
        sockets: new Set(),
        readers: [
            { Token: '1', Name: 'Haustüre Tür 1 Leser', OperationMode: 'AccCardOnly = 0' },
            { Token: '19', Name: 'Gerätehütte Leser', OperationMode: 'AccCardOnly = 0' },
        ],
        alarms: [],
        hubMethod: 'onMessage',
    };
    const json = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
    };
    const err = (res, status, code, message) => json(res, status, { ErrorCode: String(code), Message: message });
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname.toLowerCase();
        s.requests.push(`${req.method} ${url.pathname}${url.search}`);
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const auth = req.headers.authorization;
            const sess = auth && s.sessions.get(auth);
            if (p === '/api/management/v1/authentication/login' && req.method === 'POST') {
                let b = {};
                try {
                    b = JSON.parse(Buffer.concat(chunks).toString());
                } catch {
                    return err(res, 412, 909, 'Input is not valid');
                }
                if (b.UserName !== user || b.Password !== password) {
                    return err(res, 401, 911, 'Invalid UserName or Password');
                }
                if ([...s.sessions.values()].some(x => x.user === user)) {
                    return err(res, 401, 910, 'An user is already logged in');
                }
                const token = crypto.randomUUID();
                s.sessions.set(token, { user, subscribed: new Set() });
                return json(res, 201, { AuthenticationToken: token, SessionTimeout: timeout });
            }
            if (p.startsWith('/notifier/')) {
                if (!sess) {
                    return err(res, 500, 0, 'Internal server error');
                }
                if (p === '/notifier/negotiate') {
                    return json(res, 200, { Url: '/Notifier', ConnectionToken: crypto.randomBytes(16).toString('base64'), ConnectionId: crypto.randomUUID(), KeepAliveTimeout: 20, DisconnectTimeout: 30, ConnectionTimeout: 110, TryWebSockets: true, ProtocolVersion: '2.0', TransportConnectTimeout: 5, LongPollDelay: 0 });
                }
                if (p === '/notifier/start') {
                    return json(res, 200, { Response: 'started' });
                }
                return err(res, 404, 0, 'not found');
            }
            if (!sess) {
                return err(res, 401, 919, 'Invalid authorization');
            }
            if (p === '/api/management/v1/authentication/renew') {
                return json(res, 200, {});
            }
            if (p === '/api/management/v1/authentication/logout' && req.method === 'DELETE') {
                s.sessions.delete(auth);
                return json(res, 200, {});
            }
            if (p === '/api/management/v1/messages/subscribe') {
                const t = url.searchParams.get('messageSubscriptionType');
                if (sess.subscribed.has(t)) {
                    return err(res, 406, 906, 'Message already subscribed');
                }
                sess.subscribed.add(t);
                return json(res, 200, `http://${req.headers.host}/Notifier/hubs`);
            }
            if (p === '/api/management/v1/accesspoints') {
                return json(res, 200, { ResourceList: s.readers, _links: [], _embedded: null });
            }
            if (p === '/api/management/v1/alarms') {
                return json(res, 200, s.alarms);
            }
            return err(res, 404, 917, 'Item not found');
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname.toLowerCase() !== '/notifier/connect' || !s.sessions.has(req.headers.authorization) || url.searchParams.get('transport') !== 'webSockets') {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            s.sockets.add(ws);
            ws.on('close', () => s.sockets.delete(ws));
            ws.send(JSON.stringify({ C: 'd-1', S: 1, M: [] }));
        });
    });
    let n = 0;
    Object.assign(s, {
        server,
        listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
        close: () => new Promise(r => {
            for (const ws of s.sockets) {
                ws.terminate();
            }
            server.closeAllConnections();
            server.close(() => r());
        }),
        /** SiPass sends a message to every notifier client */
        push(...args) {
            const frame = JSON.stringify({ C: `d-${++n}`, M: [{ H: 'messageHub', M: s.hubMethod, A: args }] });
            for (const ws of s.sockets) {
                ws.send(frame);
            }
        },
        /** the session ends (SiPass restart / timeout) */
        expire() {
            s.sessions.clear();
            for (const ws of s.sockets) {
                ws.terminate();
            }
        },
    });
    return s;
}

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.foreign = {};
        this.logs = [];
        const log = level => m => this.logs.push(`${level}: ${m}`);
        this.log = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
    }
    _id(id) {
        return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    async setState(id, val, ack) {
        this.states[this._id(id)] = { val, ack: Boolean(ack) };
    }
    async getStateAsync(id) {
        return this.states[this._id(id)] || null;
    }
    async extendObject(id, obj) {
        this.objects[this._id(id)] = obj;
    }
    async getForeignObjectAsync(id) {
        return this.foreign[id] ? { common: this.foreign[id] } : null;
    }
    async setForeignStateAsync(id, val, ack) {
        this.states[id] = { val, ack: Boolean(ack) };
    }
    val(id) {
        const s = this.states[this._id(id)] || this.states[id];
        return s ? s.val : undefined;
    }
}

function install() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter };
        }
        return orig.call(this, request, ...rest);
    };
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { fakeSiPass, FakeAdapter, install, until };
