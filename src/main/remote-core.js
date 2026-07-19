/*
 * Remote database: the same renderer-facing surface as api-core, but every
 * method is an HTTP call to a hosted spendwise-server (webserver.js). In
 * remote mode the desktop app is just another web client - cookie session,
 * password auth, rate limiting and merge-on-save all belong to the server,
 * and the raw db.json is never reachable from here.
 *
 * Electron-free on purpose: vitest exercises this against a real
 * createWebServer instance (tests/remote-core.test.js).
 */
'use strict';

/** 401 from the server: the stored session expired or was revoked. */
export class RemoteAuthError extends Error {}

/** The server's WEB_METHODS surface - keep in lockstep with webserver.js. */
const METHODS = [
    'loadDb', 'rev', 'saveMonth', 'saveClosedMonth', 'closeMonth',
    'saveSettings', 'applyTagsEverywhere', 'listBackups', 'restoreBackup',
    'checkUpdate', 'logout',
];

export function normalizeHost (host) {
    let h = String(host || '').trim();
    if (!h) throw new Error('Server address is required');
    // no scheme → http: the common self-host setups (LAN, Tailscale) are plain
    // http on a private network; type https:// explicitly for a public host
    if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
    return h.replace(/\/+$/, '');
}

/** Sign in with the server's app password → session token (fin_sid). */
export async function remoteLogin (host, password) {
    const base = normalizeHost(host);
    let res;
    try {
        res = await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
    } catch (e) {
        throw new Error(`Can't reach ${base} - ${(e.cause && e.cause.code) || e.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(body.error || `Login failed (HTTP ${res.status})`);
    const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    const sid = cookies.map((c) => /(?:^|;\s*)fin_sid=([^;]+)/.exec(c)).find(Boolean);
    if (!sid) throw new Error('The server accepted the login but sent no session cookie');
    return sid[1];
}

export function createRemoteCore ({ host, token }) {
    const base = normalizeHost(host);

    async function call (method, payload) {
        let res;
        try {
            res = await fetch(`${base}/api/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: `fin_sid=${token}` },
                body: JSON.stringify(payload || {}),
            });
        } catch (e) {
            throw new Error(`Can't reach ${base} - ${(e.cause && e.cause.code) || e.message}`);
        }
        if (res.status === 401) {
            throw new RemoteAuthError('Session expired - reconnect to the server in Settings → Remote database.');
        }
        const body = await res.json().catch(() => null);
        if (!body || body.ok !== true) {
            throw new Error((body && body.error) || `Server error (HTTP ${res.status})`);
        }
        const { ok, ...rest } = body;
        return rest;
    }

    const core = { host: base };
    for (const m of METHODS) core[m] = (payload) => call(m, payload);
    return core;
}
