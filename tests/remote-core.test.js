import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/main/db-open.js';
import { createCore } from '../src/main/api-core.js';
import { createWebServer } from '../src/main/webserver.js';
import { createRemoteCore, remoteLogin, normalizeHost, RemoteAuthError } from '../src/main/remote-core.js';
import '../src/shared/engine.js';

const E = globalThis.FinEngine;

// The desktop app's remote mode is remote-core talking to webserver.js - this
// exercises that pairing end-to-end over real HTTP: login, session cookie,
// data round-trips, and the 401 path.

const PORT = 4199;
const HOST = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'remote-test-pw';

let dir, ctx, core, web, token;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-remote-'));
    const dbPath = path.join(dir, 'db.json');
    const db = await openDb(dbPath); // fresh default db (one empty month)
    ctx = { db, dbPath, version: 'test' };
    core = createCore(ctx);
    await core.authSet({ next: PASSWORD });
    web = createWebServer(ctx, core);
    await web.start(PORT, '127.0.0.1');
}, 20000);

afterAll(async () => {
    if (web) await web.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeHost', () => {
    it('defaults to http, strips trailing slashes, requires a value', () => {
        expect(normalizeHost('myhost:4180')).toBe('http://myhost:4180');
        expect(normalizeHost('https://a.example.com///')).toBe('https://a.example.com');
        expect(() => normalizeHost('  ')).toThrow(/required/);
    });
});

describe('remote-core against a live webserver', () => {
    it('rejects a wrong password at login', async () => {
        await expect(remoteLogin(HOST, 'nope')).rejects.toThrow(/wrong password/i);
    });

    it('logs in and returns a session token', async () => {
        token = await remoteLogin(HOST, PASSWORD);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    }, 15000);

    it('loadDb round-trips, with the password hash stripped', async () => {
        const remote = createRemoteCore({ host: HOST, token });
        const res = await remote.loadDb();
        expect(res.data.meta.rev).toBeTypeOf('number');
        expect(res.data.settings.auth).toBeUndefined(); // never leaves the server
        expect(res.path).toBe(ctx.dbPath);
    });

    it('saveMonth writes through to the server db', async () => {
        const remote = createRemoteCore({ host: HOST, token });
        const { data } = await remote.loadDb();
        const key = E.monthKeys(data)[0];
        const month = E.clone(data.months[key]);
        month.groups.find((g) => g.kind === 'income').fields.push({
            id: 'r-pay', label: 'Remote paycheck', value: 1234, pinned: true, accounted: false, tags: [],
        });
        const saved = await remote.saveMonth({ key, month, base: null, expectedRev: data.meta.rev });
        expect(saved.rev).toBe(data.meta.rev + 1);
        expect(E.findField(ctx.db.data.months[key], 'r-pay').value).toBe(1234);
    });

    it('rev matches the server after the write', async () => {
        const remote = createRemoteCore({ host: HOST, token });
        const r = await remote.rev();
        expect(r.rev).toBe(ctx.db.data.meta.rev);
    });

    it('a bad token gets RemoteAuthError, and desktop-only methods are refused', async () => {
        const remote = createRemoteCore({ host: HOST, token: 'not-a-real-token' });
        await expect(remote.loadDb()).rejects.toBeInstanceOf(RemoteAuthError);
        // a method outside WEB_METHODS is politely refused by the server
        const authed = createRemoteCore({ host: HOST, token });
        authed.exportDb = (p) => authed.loadDb.call && (async () => {
            const res = await fetch(`${HOST}/api/exportDb`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `fin_sid=${token}` }, body: '{}',
            });
            return res.json();
        })();
        const out = await authed.exportDb();
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/desktop app/i);
    });

    it('an unreachable host reports a clear error', async () => {
        const remote = createRemoteCore({ host: 'http://127.0.0.1:1', token });
        await expect(remote.rev()).rejects.toThrow(/can't reach/i);
    });

    it('logout revokes the session server-side', async () => {
        const t = await remoteLogin(HOST, PASSWORD);
        const remote = createRemoteCore({ host: HOST, token: t });
        await remote.rev(); // session live
        await remote.logout();
        await expect(remote.rev()).rejects.toBeInstanceOf(RemoteAuthError); // dead everywhere, not just locally
    }, 15000);
});
