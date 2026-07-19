/*
 * Built-in web server ("web access"): serves the same renderer to browsers on
 * the LAN (or beyond, if the user arranges transport - Tailscale, reverse
 * proxy), against the SAME live db the Electron window uses - one process
 * owns db.json, so co-editing needs no file sync. Login uses the app
 * password (settings.auth); sessions are HttpOnly cookies; failed logins are
 * rate-limited per IP. Electron-free - the dev/scratch harnesses boot it too.
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, '..'); // serves /renderer/* below here

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;

// A web client may co-edit and read - dialog-based ops and password
// management stay desktop-only.
const WEB_METHODS = new Set([
    'loadDb', 'rev', 'saveMonth', 'saveClosedMonth', 'closeMonth',
    'saveSettings', 'applyTagsEverywhere', 'listBackups', 'restoreBackup',
    'checkUpdate',
]);

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml', '.json': 'application/json',
    '.png': 'image/png', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf',
};

const LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spend Wise - sign in</title>
<link rel="icon" type="image/png" href="/renderer/assets/icon.ico">
<link rel="apple-touch-icon" href="/renderer/assets/icon.png">
<meta name="theme-color" content="#059669">
<style>
  @font-face {
    font-family: 'Roca';
    src: url('/renderer/fonts/roca.woff2') format('woff2'),
         url('/renderer/fonts/roca.woff') format('woff');
    font-weight: 700 900;
    font-style: normal;
    font-display: swap;
  }
  body { font-family: system-ui, sans-serif; background: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / .07); padding: 2rem; width: 20rem; text-align: center; box-sizing: border-box; }
  img.logo { display: block; width: 2.5rem; height: 2.5rem; margin: 0 auto .5rem; }
  h1 { font-family: 'Roca', system-ui, sans-serif; font-weight: 900; color: #047857; font-size: 1.125rem; margin: 0 0 1rem; }
  input { width: 100%; box-sizing: border-box; border: 1px solid #d4d4d8; border-radius: 6px; padding: .55rem .75rem; font-size: .9rem; text-align: center; outline: none; }
  input:focus { border-color: #10b981; box-shadow: 0 0 0 1px #10b981; }
  button { margin-top: .75rem; width: 100%; background: #059669; color: #fff; border: 0; border-radius: 6px; padding: .6rem; font-weight: 700; font-size: .9rem; cursor: pointer; }
  button:hover { background: #10b981; }
  .hidden { display: none; }
  p.err { color: #dc2626; font-size: .8rem; min-height: 1rem; margin: .6rem 0 0; }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
    20%, 40%, 60%, 80% { transform: translateX(5px); }
  }
  form.shake { animation: shake 0.5s ease; }
  /* the page is same-origin with the app, so it honors the app's saved theme
     (spendwise-theme, set by the Appearance toggle after any prior login) and
     falls back to the OS. Colours mirror src/renderer/css/input.css. */
  html.dark body { background: #1b1e25; }
  html.dark form { background: #262a33; border-color: #333843; box-shadow: 0 10px 15px -3px rgb(0 0 0 / .4); }
  html.dark h1 { color: #c7e0da; }
  html.dark input { background: #1b1e25; border-color: #464c59; color: #e8eaef; }
  html.dark input:focus { border-color: #10b981; box-shadow: 0 0 0 1px #10b981; }
  html.dark p.err { color: #f87171; }
</style>
<script>
  (function () {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    function pref () { try { return localStorage.getItem('spendwise-theme') || 'system'; } catch (e) { return 'system'; } }
    function apply () {
      var p = pref();
      document.documentElement.classList.toggle('dark', p === 'dark' || (p === 'system' && mq.matches));
    }
    mq.addEventListener('change', function () { if (pref() === 'system') apply(); });
    apply();
  }());
</script></head><body>
<form id="f">
  <img class="logo" src="/renderer/assets/icon.ico" alt="" draggable="false">
  <h1>Spend Wise</h1>
  <input id="pw" type="password" placeholder="App password" autofocus autocomplete="current-password">
  <button type="submit">Unlock</button>
  <p class="err hidden" id="err"></p>
</form>
<script>
const form = document.getElementById('f');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }) });
  const out = await res.json();
  if (out.ok) location.reload();
  else {
    document.getElementById('err').classList.remove('hidden');
    document.getElementById('err').textContent = out.error || 'Wrong password';
    document.getElementById('pw').value = '';
    form.classList.remove('shake');
    void form.offsetWidth; // reflow so the animation restarts on repeat failures
    form.classList.add('shake');
  }
});
</script></body></html>`;

const NO_PASSWORD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Spend Wise</title>
<style>
  body { font-family: system-ui, sans-serif; text-align:center; padding-top:4rem; color:#3f3f46; background:#fff; }
  h1 { color:#047857; font-size: 1.125rem }
  html.dark body { background:#1b1e25; color:#c4c9d2; }
  html.dark h1 { color:#c7e0da; }
</style>
<script>
  (function () {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    function pref () { try { return localStorage.getItem('spendwise-theme') || 'system'; } catch (e) { return 'system'; } }
    function apply () {
      var p = pref();
      document.documentElement.classList.toggle('dark', p === 'dark' || (p === 'system' && mq.matches));
    }
    mq.addEventListener('change', function () { if (pref() === 'system') apply(); });
    apply();
  }());
</script></head>
<body>
<h1>Spend Wise</h1>
<p>Web access needs an app password.<br>Set one in the desktop app under Settings → App password.</p>
</body></html>`;

/**
 * opts.trustProxy   - number of reverse proxies in front (true = 1, 0 = none).
 *                     Required for correct per-client rate limiting behind a
 *                     proxy; NEVER default it on: an untrusted client can
 *                     forge X-Forwarded-For and evade the lockout.
 * opts.secureCookie - force the Secure cookie flag (auto-detected from
 *                     X-Forwarded-Proto when a proxy is trusted).
 */
export function createWebServer (ctx, core, opts = {}) {
    const sessions = new Map(); // token → { created, last }
    const attempts = new Map(); // ip → { fails, lockedUntil }
    // hops/secureCookie start from construction opts (the CLI passes them here)
    // but can be re-applied at start() so the desktop app, which builds the
    // server once at boot, can still configure them when web access is toggled.
    const normHops = (tp) => tp === true ? 1 : Math.max(0, Number(tp) || 0);
    let hops = normHops(opts.trustProxy);
    let secureCookie = !!opts.secureCookie;
    let server = null;
    let port = null;

    // ctx.authOverride: session-only hash from the CLI's --password flag, for
    // local testing - takes precedence over the stored password and is never
    // written to the db
    const authHash = () => ctx.authOverride
        || (ctx.db.data && ctx.db.data.settings && ctx.db.data.settings.auth);
    const hasPassword = () => !!authHash();

    const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
        .map((c) => c.trim().split('=')).filter((kv) => kv.length === 2));

    const sessionOf = (req) => {
        const token = parseCookies(req).fin_sid;
        const s = token && sessions.get(token);
        if (!s) return null;
        if (Date.now() - s.last > SESSION_TTL_MS) { sessions.delete(token); return null; }
        s.last = Date.now();
        return token;
    };

    /**
     * With N trusted proxies, the (N)th entry from the RIGHT of
     * X-Forwarded-For is the real client: each proxy appends the peer it
     * received from, so anything further left is client-supplied and forgeable.
     */
    const clientIp = (req) => {
        if (hops) {
            const chain = String(req.headers['x-forwarded-for'] || '')
                .split(',').map((s) => s.trim()).filter(Boolean);
            if (chain.length) return chain[Math.max(0, chain.length - hops)];
        }
        return req.socket.remoteAddress || 'unknown';
    };

    const isHttps = (req) => secureCookie
        || (hops > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

    const json = (res, status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
    };

    /** settings.auth (the scrypt hash) never leaves the process over HTTP. */
    const stripAuth = (out) => {
        if (out && out.data && out.data.settings) delete out.data.settings.auth;
        return out;
    };

    async function readBody (req) {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > MAX_BODY) throw new Error('payload too large');
        }
        return body ? JSON.parse(body) : {};
    }

    async function handleLogin (req, res) {
        const ip = clientIp(req);
        const a = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
        if (Date.now() < a.lockedUntil) {
            const mins = Math.ceil((a.lockedUntil - Date.now()) / 60000);
            return json(res, 429, { ok: false, error: `Too many attempts - try again in ${mins} min` });
        }
        const { password } = await readBody(req);
        await new Promise((r) => setTimeout(r, 250)); // flat cost per attempt
        if (!verifyPassword(password, authHash())) {
            a.fails += 1;
            if (a.fails >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCKOUT_MS; a.fails = 0; }
            attempts.set(ip, a);
            return json(res, 403, { ok: false, error: 'Wrong password' });
        }
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { created: Date.now(), last: Date.now() });
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `fin_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
                + (isHttps(req) ? '; Secure' : ''),
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true }));
    }

    async function handleRequest (req, res) {
        const u = new URL(req.url, 'http://localhost');

        if (!hasPassword()) {
            res.writeHead(503, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
            return res.end(NO_PASSWORD_PAGE);
        }

        if (req.method === 'POST' && u.pathname === '/api/login') return handleLogin(req, res);

        // icons and fonts are public: the login page needs its favicon and
        // display face, and a browser fetching either without the cookie would
        // otherwise get HTML back
        const isPublicAsset = req.method === 'GET'
            && (u.pathname.startsWith('/renderer/assets/') || u.pathname.startsWith('/renderer/fonts/'));

        const token = sessionOf(req);
        if (!token && !isPublicAsset) {
            if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
                return json(res, 401, { ok: false, error: 'unauthorized' });
            }
            res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
            return res.end(LOGIN_PAGE);
        }

        if (req.method === 'POST' && u.pathname === '/api/logout') {
            sessions.delete(token);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fin_sid=; Path=/; Max-Age=0' });
            return res.end('{"ok":true}');
        }

        if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
            const method = u.pathname.slice(5);
            if (!WEB_METHODS.has(method)) return json(res, 200, { ok: false, error: 'This action is only available in the desktop app.' });
            try {
                const payload = await readBody(req);
                const out = stripAuth(await core[method](payload));
                return json(res, 200, { ok: true, ...out });
            } catch (err) {
                return json(res, 200, { ok: false, error: String(err && err.message || err) });
            }
        }

        // ------------------------------------------------------- static files
        const pathname = u.pathname === '/' ? '/renderer/index.html' : u.pathname;
        const file = path.join(SRC_ROOT, path.normalize(pathname));
        if (!file.startsWith(SRC_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404); return res.end('not found');
        }
        if (pathname === '/renderer/index.html') {
            let html = fs.readFileSync(file, 'utf8');
            html = html.replace("connect-src 'none'", "connect-src 'self'");
            html = html.replace('<link rel="stylesheet"', '<base href="/renderer/">\n    <link rel="stylesheet"');
            html = html.replace('<script src="js/helpers.js"></script>',
                '<script src="js/web-api.js"></script>\n    <script src="js/helpers.js"></script>');
            res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
            return res.end(html);
        }
        const type = pathname.endsWith('/manifest.json')
            ? 'application/manifest+json'
            : MIME[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(fs.readFileSync(file));
    }

    return {
        start (p, host = opts.host || '0.0.0.0', runtime = {}) {
            // desktop path re-applies these each time web access is turned on
            if (runtime.trustProxy !== undefined) hops = normHops(runtime.trustProxy);
            if (runtime.secureCookie !== undefined) secureCookie = !!runtime.secureCookie;
            if (server) return Promise.resolve(port);
            return new Promise((resolve, reject) => {
                server = http.createServer((req, res) => {
                    handleRequest(req, res).catch((err) => json(res, 500, { ok: false, error: String(err && err.message || err) }));
                });
                server.on('error', (err) => { server = null; reject(err); });
                server.listen(p, host, () => { port = p; resolve(p); });
            });
        },

        /** Test seam: how this server resolves the client IP for rate limiting. */
        _clientIp: clientIp,
        stop () {
            return new Promise((resolve) => {
                if (!server) return resolve();
                const s = server;
                server = null;
                port = null;
                // sever keep-alive connections or close() waits on them forever
                if (s.closeAllConnections) s.closeAllConnections();
                s.close(() => resolve());
            });
        },
        status () {
            const urls = [];
            if (server) {
                for (const list of Object.values(os.networkInterfaces())) {
                    for (const ni of list || []) {
                        if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
                    }
                }
                urls.unshift(`http://localhost:${port}`);
            }
            return { running: !!server, port, urls, sessions: sessions.size, trustProxy: hops, secureCookie };
        },
    };
}
