'use strict';

/*
 * REST client for the SiPass integrated Management Station API (port 8744):
 *   POST /api/management/v1/Authentication/Login {UserName, Password} -> {AuthenticationToken, SessionTimeout (s)}
 *   every further request: header "Authorization: <token>" (checked on the owner's SiPass 3.0)
 *   GET  .../Authentication/Renew keeps the session, DELETE .../Authentication/Logout ends it
 * Errors come as HTTP status + {ErrorCode, Message} (e.g. 908 Session Expired, 910 user already logged in).
 * SiPass usually has its own certificate -> not checked (local network).
 */

const http = require('node:http');
const https = require('node:https');

const BASE = '/api/management/v1';

const ERRORS = {
    900: 'Kein Zugriff', 901: 'SiPass-Dienst hat keine Verbindung zum SiPass-Server', 902: 'SiPass-Dienst nicht erreichbar',
    903: 'Zu viele Clients', 905: 'Zugriff gesperrt', 906: 'schon abonniert', 908: 'Sitzung abgelaufen', 909: 'Eingabe ungültig',
    910: 'Dieser Benutzer ist schon angemeldet (anderes Programm / alte Sitzung - eigenen Bediener für ioBroker anlegen)',
    911: 'Benutzername oder Passwort falsch', 914: 'Befehl fehlgeschlagen', 915: 'Ungültiger Befehl', 917: 'Nicht gefunden',
    919: 'Anmeldung ungültig', 920: 'Keine Lizenz für die Schnittstelle (Management Station API)', 929: 'SiPass-Server hat keine Verbindung zur Datenbank',
    930: 'SiPass-Lizenz abgelaufen', 931: 'Anmeldung als externer Bediener nicht erlaubt',
};

class ApiError extends Error {
    constructor(status, code, message) {
        super(`${ERRORS[code] || message || `HTTP ${status}`}${code ? ` (${code})` : ''}`);
        this.status = status;
        this.code = code;
    }
}

class SiPassClient {
    constructor({ host, port = 8744, secure = true, user, password, timeout = 15000, log = null }) {
        this.host = host;
        this.port = port;
        this.secure = secure;
        this.user = user;
        this.password = password;
        this.timeout = timeout;
        this.log = log;
        this.token = '';
        this.sessionTimeout = 300;
    }

    get origin() {
        return `${this.secure ? 'https' : 'http'}://${this.host}:${this.port}`;
    }

    /** raw request; resolves {status, body (parsed JSON or text)} */
    raw(method, path, { body, headers = {} } = {}) {
        const lib = this.secure ? https : http;
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        return new Promise((resolve, reject) => {
            const req = lib.request({
                host: this.host,
                port: this.port,
                path,
                method,
                rejectUnauthorized: false,
                timeout: this.timeout,
                headers: {
                    Accept: 'application/json',
                    ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
                    ...headers,
                },
            }, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let parsed = text;
                    try {
                        parsed = text ? JSON.parse(text) : null;
                    } catch {
                        // text answer
                    }
                    resolve({ status: res.statusCode, body: parsed, headers: res.headers });
                });
            });
            req.on('timeout', () => req.destroy(new Error('Keine Antwort von SiPass (Zeitüberschreitung)')));
            req.on('error', reject);
            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    static check(res) {
        if (res.status >= 200 && res.status < 300) {
            return res.body;
        }
        const b = res.body && typeof res.body === 'object' ? res.body : {};
        throw new ApiError(res.status, Number(b.ErrorCode || b.errorCode) || 0, b.Message || b.message || (typeof res.body === 'string' ? res.body.slice(0, 200) : ''));
    }

    async login() {
        const res = await this.raw('POST', `${BASE}/Authentication/Login`, { body: { UserName: this.user, Password: this.password } });
        const b = SiPassClient.check(res) || {};
        const token = b.AuthenticationToken || b.authenticationToken;
        if (!token) {
            throw new Error('Anmeldung: keine AuthenticationToken in der Antwort');
        }
        this.token = String(token);
        this.sessionTimeout = Number(b.SessionTimeout || b.sessionTimeout) || 300;
        return this.token;
    }

    async logout() {
        if (!this.token) {
            return;
        }
        const token = this.token;
        this.token = '';
        await this.raw('DELETE', `${BASE}/Authentication/Logout`, { headers: { Authorization: token } }).catch(() => null);
    }

    async renew() {
        return SiPassClient.check(await this.raw('GET', `${BASE}/Authentication/Renew`, { headers: { Authorization: this.token } }));
    }

    /** request with the session token; logs in again once when the session expired */
    async request(method, path, body) {
        if (!this.token) {
            await this.login();
        }
        let res = await this.raw(method, `${BASE}${path}`, { body, headers: { Authorization: this.token } });
        const b = res.body && typeof res.body === 'object' ? res.body : {};
        const code = Number(b.ErrorCode || b.errorCode) || 0;
        if (res.status === 401 && [908, 919, 900].includes(code)) {
            this.token = '';
            await this.login();
            res = await this.raw(method, `${BASE}${path}`, { body, headers: { Authorization: this.token } });
        }
        return SiPassClient.check(res);
    }

    get(path) {
        return this.request('GET', path);
    }

    /** list endpoints answer {ResourceList: [...]}, some plain arrays */
    async list(path) {
        const b = await this.get(path);
        if (Array.isArray(b)) {
            return b;
        }
        return (b && (b.ResourceList || b.resourceList)) || [];
    }

    /** subscribe messages: 0 = events, 1 = alarms; "already subscribed" (906) is fine */
    async subscribe(type) {
        try {
            return await this.get(`/Messages/Subscribe?messageSubscriptionType=${type}`);
        } catch (err) {
            if (err.code === 906) {
                return null;
            }
            throw err;
        }
    }
}

module.exports = { SiPassClient, ApiError, ERRORS, BASE };
