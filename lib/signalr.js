'use strict';

/*
 * Minimal client for classic ASP.NET SignalR 2 (SiPass "Notifier", hub "messageHub" at /Notifier), WebSockets transport:
 *   GET  /Notifier/negotiate?clientProtocol=…&connectionData=[{"name":"messagehub"}]   (needs header Authorization)
 *   WS   /Notifier/connect?transport=webSockets&connectionToken=…&connectionData=…
 *   GET  /Notifier/start?transport=webSockets&…  -> {"Response":"started"}
 * Frames: {} = keep alive, {"C":cursor,"M":[{"H":"messageHub","M":"<method>","A":[args]}]}. Every hub call is passed on
 * as 'message' (hub, method, args) - which method SiPass uses for events is not documented, so nothing is filtered.
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const PROTOCOL = '2.1';

class SignalRClient extends EventEmitter {
    constructor({ client, hub = 'messageHub', path = '/Notifier', log = null }) {
        super();
        this.client = client; // SiPassClient (origin, token, raw)
        this.hub = hub;
        this.path = path;
        this.log = log;
        this.ws = null;
        this.connected = false;
        this.stopped = false;
        this.keepAlive = 20;
        this.watch = null;
    }

    get connectionData() {
        return JSON.stringify([{ name: this.hub.toLowerCase() }]);
    }

    query(extra) {
        const q = new URLSearchParams({ clientProtocol: PROTOCOL, connectionData: this.connectionData, ...extra });
        return q.toString();
    }

    async start() {
        this.stopped = false;
        const neg = await this.client.raw('GET', `${this.path}/negotiate?${this.query({})}`, { headers: { Authorization: this.client.token } });
        if (neg.status !== 200 || !neg.body || !neg.body.ConnectionToken) {
            throw new Error(`Notifier: Verbindungsaufbau abgelehnt (HTTP ${neg.status})`);
        }
        this.keepAlive = Number(neg.body.KeepAliveTimeout) || 20;
        const token = neg.body.ConnectionToken;
        const origin = this.client.origin.replace(/^http/, 'ws');
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`${origin}${this.path}/connect?${this.query({ transport: 'webSockets', connectionToken: token, tid: String(Math.floor(Math.random() * 11)) })}`, {
                headers: { Authorization: this.client.token },
                rejectUnauthorized: false,
                handshakeTimeout: 15000,
            });
            this.ws = ws;
            let opened = false;
            ws.on('open', () => {
                opened = true;
                resolve();
            });
            ws.on('message', data => this.frame(data.toString()));
            ws.on('error', err => {
                if (!opened) {
                    reject(new Error(`Notifier: ${err.message}`));
                } else if (this.log) {
                    this.log.debug(`Notifier: ${err.message}`);
                }
            });
            ws.on('close', () => {
                clearTimeout(this.watch);
                const was = this.connected;
                this.connected = false;
                if (this.ws === ws) {
                    this.ws = null;
                }
                if (opened && !this.stopped) {
                    this.emit('closed', was);
                }
            });
        });
        const st = await this.client.raw('GET', `${this.path}/start?${this.query({ transport: 'webSockets', connectionToken: token })}`, { headers: { Authorization: this.client.token } });
        if (st.status !== 200) {
            this.stop();
            throw new Error(`Notifier: Start abgelehnt (HTTP ${st.status})`);
        }
        this.connected = true;
        this.alive();
    }

    /** no frame (not even a keep alive) for 2.5 x KeepAliveTimeout -> the connection is dead */
    alive() {
        clearTimeout(this.watch);
        this.watch = setTimeout(() => {
            if (this.log) {
                this.log.warn('Notifier: keine Lebenszeichen mehr - neue Verbindung');
            }
            if (this.ws) {
                this.ws.terminate();
            }
        }, this.keepAlive * 2500);
    }

    frame(text) {
        this.alive();
        let f;
        try {
            f = JSON.parse(text);
        } catch {
            return;
        }
        for (const m of (f && f.M) || []) {
            if (m && m.H !== undefined) {
                this.emit('message', String(m.H), String(m.M || ''), Array.isArray(m.A) ? m.A : []);
            }
        }
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.watch);
        this.connected = false;
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // already closed
            }
            this.ws = null;
        }
    }
}

module.exports = { SignalRClient };
