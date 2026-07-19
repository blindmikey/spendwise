/*
 * Dev/preview server: serves the renderer in a plain browser with the Electron
 * IPC bridge replaced by HTTP endpoints — the SAME api core the Electron app
 * uses (src/main/api-core.js), so merge-on-save and every handler behave
 * identically. Debugging tool only — no auth, localhost only. The production
 * web server (with login + rate limiting) lives in src/main/webserver.js.
 *
 *   node dev-server.mjs [db-path] [port]
 *
 * Defaults: ./preview-data/db.json, port 4173.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/main/db-open.js';
import { createCore } from './src/main/api-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.argv[2] || process.env.FINANCES_DB_PATH || 'preview-data/db.json');
const port = Number(process.argv[3] || process.env.PORT || 4173);

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const ctx = { db: await openDb(dbPath), dbPath, version: pkg.version };
const core = createCore(ctx);

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error: String(error && error.message || error) });
const snapshot = () => ({ data: JSON.parse(JSON.stringify(ctx.db.data)), path: ctx.dbPath });

// native-dialog features are no-ops in the browser preview
const stubs = {
    async logout () { return {}; }, // no sessions in the dev preview
    async openBackupsFolder () { return {}; },
    async exportDb () { return { exported: null }; },
    async changeDbLocation () { return snapshot(); },
    async migrateScan () { return { scanned: false }; },
};

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml', '.json': 'application/json',
    '.png': 'image/png', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf',
};

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
        const method = u.pathname.slice(5);
        let body = '';
        for await (const chunk of req) body += chunk;
        let out;
        try {
            const payload = body ? JSON.parse(body) : {};
            const fn = core[method] || stubs[method];
            out = fn ? ok(await fn.call(core, payload)) : fail('unknown method ' + method);
        } catch (err) {
            out = fail(err);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
    }

    let pathname = u.pathname === '/' ? '/renderer/index.html' : u.pathname;
    const file = path.join(__dirname, 'src', path.normalize(pathname));
    if (!file.startsWith(path.join(__dirname, 'src')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
    }

    if (pathname === '/renderer/index.html') {
        let html = fs.readFileSync(file, 'utf8');
        html = html.replace("connect-src 'none'", "connect-src 'self'"); // allow the HTTP api shim
        html = html.replace('<link rel="stylesheet"',
            '<base href="/renderer/">\n    <link rel="stylesheet"'); // page is served at /
        html = html.replace('<script src="js/helpers.js"></script>',
            '<script src="js/web-api.js"></script>\n    <script src="js/helpers.js"></script>');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
        return;
    }

    // the dev preview has no login/sessions - flag it so the renderer knows
    // "web" here means "no auth", and hides the Log out control
    if (pathname === '/renderer/js/web-api.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end(fs.readFileSync(file, 'utf8') + '\nwindow.IS_DEV_PREVIEW = true;\n');
        return;
    }

    const type = pathname.endsWith('/manifest.json')
        ? 'application/manifest+json'
        : MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Finances web preview: http://localhost:${port}/  (db: ${dbPath})`);
});
