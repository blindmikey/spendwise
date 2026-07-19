#!/usr/bin/env node
/*
 * Headless server: runs the app without Electron, for self-hosting on a box
 * that's always on. Shares the exact same api-core + web server the desktop
 * app uses - the only thing missing is the desktop window (and with it the
 * native-dialog features: export, move database, legacy import; do those in
 * the desktop app against the same db.json, or pre-seed the file).
 *
 *   spendwise-server                     # serve
 *   spendwise-server --password <pw>     # serve with a session-only password
 *   spendwise-server --set-password      # set/change the login (then exit)
 *   spendwise-server --help
 *
 * Config comes from the environment (all optional):
 *   FINANCES_DB_PATH       default ./data/db.json
 *   FINANCES_PORT / PORT   default 4180
 *   FINANCES_HOST          default 0.0.0.0
 *   FINANCES_PASSWORD      bootstrap only - sets the login if none exists yet
 *   FINANCES_TRUST_PROXY   number of reverse proxies in front (1 for the usual
 *                          nginx/Caddy/Traefik setup). Needed for per-client
 *                          rate limiting; leave unset when directly exposed.
 *   FINANCES_SECURE_COOKIE 1 to force the Secure cookie flag (auto-detected
 *                          from X-Forwarded-Proto when a proxy is trusted)
 */
'use strict';

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from '../main/db-open.js';

// node 18 has no global `crypto` (it became one in 19). The shared engine is
// UMD and reads uuid() off the global, so without this it would silently drop
// to its Math.random fallback here - fine for uniqueness, but needlessly weak
// when a CSPRNG is one import away. Electron and node 20+ already have it.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { createCore } from '../main/api-core.js';
import { createWebServer } from '../main/webserver.js';
import { hashPassword } from '../main/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

if (flag('--help') || flag('-h')) {
    process.stdout.write(`
  Spend Wise - self-hosted server (v${pkg.version})

  Usage
    spendwise-server                 serve the app
    spendwise-server --password <pw> serve with a session-only password - for
                                     local testing; the stored one is untouched
    spendwise-server --set-password  set or change the login password, then exit
    spendwise-server --version

  Environment
    FINANCES_DB_PATH        path to db.json          (default ./data/db.json)
    FINANCES_PORT | PORT    listen port              (default 4180)
    FINANCES_HOST           bind address             (default 0.0.0.0)
    FINANCES_PASSWORD       sets the login on first run only
    FINANCES_TRUST_PROXY    reverse proxies in front (e.g. 1 behind nginx)
    FINANCES_SECURE_COOKIE  1 to force Secure cookies

  Everyone signs in with the one app password; the desktop app uses the same
  db.json, so you can point it at this file too (one writer at a time - or let
  people co-edit through this server, which merges concurrent edits).

`);
    process.exit(0);
}

if (flag('--version') || flag('-v')) {
    process.stdout.write(pkg.version + '\n');
    process.exit(0);
}

const dbPath = path.resolve(process.env.FINANCES_DB_PATH || 'data/db.json');
const port = Number(process.env.FINANCES_PORT || process.env.PORT || 4180);
const host = process.env.FINANCES_HOST || '0.0.0.0';

const db = await openDb(dbPath);
const ctx = { db, dbPath, version: pkg.version };
const core = createCore(ctx);

/** Read a password from a TTY without echoing it, or from piped stdin. */
function askPassword (prompt) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) { // echo "pw" | spendwise-server --set-password
            let data = '';
            process.stdin.on('data', (c) => { data += c; });
            process.stdin.on('end', () => resolve(data.trim()));
            return;
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = function (s) { // mute everything after the prompt
            if (s.includes(prompt)) rl.output.write(prompt);
        };
        rl.question(prompt, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer.trim()); });
    });
}

if (flag('--set-password')) {
    const existing = core.authHas().hasPassword;
    let next = flagValue('--set-password');
    let current = '';
    if (existing) {
        current = process.env.FINANCES_CURRENT_PASSWORD || await askPassword('Current password: ');
    }
    if (!next) {
        next = await askPassword(existing ? 'New password: ' : 'Password: ');
        const confirm = await askPassword('Confirm: ');
        if (next !== confirm) {
            console.error('Passwords did not match - nothing changed.');
            process.exit(1);
        }
    }
    if (!next) {
        console.error('Empty password - nothing changed. (Removing the password disables web access.)');
        process.exit(1);
    }
    try {
        await core.authSet({ current, next });
        console.log(`Password ${existing ? 'changed' : 'set'} for ${dbPath}`);
        process.exit(0);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

// Bootstrap (first run / container start): only ever sets a password when the
// database has none - it must not clobber one the user later changed.
if (!core.authHas().hasPassword && process.env.FINANCES_PASSWORD) {
    await core.authSet({ next: process.env.FINANCES_PASSWORD });
    console.log('[auth] password set from FINANCES_PASSWORD');
}

// --password <pw>: session-only login for local testing (npm run serve --
// --password test). Held in memory and checked ahead of the stored hash;
// nothing is written, so it cannot clobber (or leak into) the real password.
const sessionPw = flagValue('--password');
if (sessionPw) {
    ctx.authOverride = hashPassword(sessionPw);
    console.log('[auth] session-only password active (--password) - the stored password is untouched');
}

const web = createWebServer(ctx, core, {
    host,
    trustProxy: process.env.FINANCES_TRUST_PROXY,
    secureCookie: process.env.FINANCES_SECURE_COOKIE === '1' || process.env.FINANCES_SECURE_COOKIE === 'true',
});

await web.start(port, host);

console.log(`Spend Wise v${pkg.version}`);
console.log(`  serving   http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
console.log(`  database  ${dbPath}`);
if (!core.authHas().hasPassword && !ctx.authOverride) {
    console.log('\n  ⚠ No app password set - the server will refuse to serve the app until you run:');
    console.log('      spendwise-server --set-password\n');
}

const shutdown = async (signal) => {
    console.log(`\n[${signal}] shutting down…`);
    await web.stop();
    process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
