import { app, ipcMain, dialog, shell, safeStorage, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, resolveDbPath, loadConfig, saveConfig, migrateLegacyUserData } from './storage/local.js';
import { backupDb, backupsDir } from './backup.js';
import { importLegacy } from './migrate.js';
import { createCore } from './api-core.js';
import { createWebServer } from './webserver.js';
import { createRemoteCore, remoteLogin, normalizeHost } from './remote-core.js';
import { RELEASES_URL } from './update-check.js';
import '../shared/engine.js';

const E = globalThis.FinEngine;

// Live db context shared with the api core (and the web server, which the
// main process starts against the same ctx - one process owns db.json).
export const ctx = { db: null, dbPath: null };
export let core = null;
export let webServer = null;

// Remote mode: the shared db methods route to a hosted spendwise-server
// instead of the local core. The local db stays open underneath (disconnect
// is instant, nothing remote ever writes to it), but the local web server is
// never started while remote - it would serve a stale file.
export let remoteCore = null;
let mode = 'local';

// The session token is a bearer credential - at rest it's OS-encrypted where
// the platform offers it (DPAPI/Keychain), plain JSON otherwise.
const encToken = (t) => safeStorage.isEncryptionAvailable()
    ? { tokenEnc: safeStorage.encryptString(t).toString('base64') }
    : { token: t };
const decToken = (r) => {
    try {
        if (r.tokenEnc) return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(r.tokenEnc, 'base64')) : null;
        return r.token || null;
    } catch { return null; }
};

const ok = (extra = {}) => ({ ok: true, ...extra });

// Reverse-proxy settings resolve config-over-env: a value saved from the
// Settings panel wins; otherwise fall back to the FINANCES_* env vars the CLI
// uses; otherwise the safe default (no trusted proxy, cookie auto-detected).
// ?? not || so an explicit saved 0 / false isn't overridden by the env value.
function resolveWebProxy (config) {
    const w = (config && config.webServer) || {};
    const envTP = process.env.FINANCES_TRUST_PROXY;
    const envSC = process.env.FINANCES_SECURE_COOKIE === '1' || process.env.FINANCES_SECURE_COOKIE === 'true';
    return {
        trustProxy: w.trustProxy ?? (envTP !== undefined ? Math.max(0, Number(envTP) || 0) : 0),
        secureCookie: w.secureCookie ?? envSC,
    };
}
const fail = (error) => ({ ok: false, error: String(error && error.message || error) });

export async function registerIpc () {
    migrateLegacyUserData(); // must run before the config is read
    ctx.dbPath = resolveDbPath();
    ctx.db = await openDb(ctx.dbPath);
    ctx.version = app.getVersion();
    core = createCore(ctx);

    // A saved remote connection makes this boot remote. No stored token
    // (logged out, or the OS store couldn't decrypt it) still boots remote,
    // but flags needsLogin - the renderer shows the password gate instead of
    // ever falling back silently to the local file.
    let remoteToken = null;
    const bootRemote = loadConfig().remote;
    if (bootRemote && bootRemote.host) {
        remoteToken = decToken(bootRemote);
        remoteCore = createRemoteCore({ host: bootRemote.host, token: remoteToken || '' });
        mode = 'remote';
    }
    const active = () => mode === 'remote' ? remoteCore : core;
    const localOnly = (what) => {
        if (mode === 'remote') throw new Error(`${what} is not available with a remote database - it belongs to the machine hosting the data.`);
    };

    const handle = (channel, fn) => ipcMain.handle(channel, async (event, payload) => {
        try {
            return await fn(payload || {}, event);
        } catch (err) {
            return fail(err);
        }
    });

    // preload reads this synchronously at page load → window.IS_REMOTE
    ipcMain.on('remote:mode-sync', (e) => { e.returnValue = mode === 'remote'; });

    // core-backed handlers (same handlers serve the web clients); in remote
    // mode they proxy to the hosted server instead
    handle('db:load', async () => ok(await active().loadDb()));
    handle('db:rev', async () => ok(await active().rev()));
    handle('db:saveMonth', async (p) => ok(await active().saveMonth(p)));
    handle('db:saveClosedMonth', async (p) => ok(await active().saveClosedMonth(p)));
    handle('db:closeMonth', async (p) => ok(await active().closeMonth(p)));
    handle('db:saveSettings', async (p) => ok(await active().saveSettings(p)));
    handle('db:apply-tags', async (p) => ok(await active().applyTagsEverywhere(p)));
    handle('backups:list', async () => ok(await active().listBackups()));
    handle('backups:restore', async (p) => ok(await active().restoreBackup(p)));
    handle('update:check', async (p) => ok(await active().checkUpdate(p)));
    handle('db:migrate-legacy', async (p) => { localOnly('Legacy import'); return ok(await core.migrateLegacy(p)); });
    handle('auth:has', async () => ok(mode === 'remote' ? { hasPassword: true } : core.authHas()));
    handle('auth:verify', async (p) => { localOnly('The lock screen'); return ok(core.authVerify(p)); });
    handle('auth:set', async (p) => { localOnly('Password management'); return ok(await core.authSet(p)); });

    // ---------------------------------------------------------- remote mode

    handle('remote:status', async () => ok({
        connected: mode === 'remote',
        host: mode === 'remote' ? remoteCore.host : '',
        needsLogin: mode === 'remote' && !remoteToken,
    }));

    // password gate (remote boot with no session): sign back in to the saved host
    handle('remote:login', async ({ password }) => {
        if (mode !== 'remote') throw new Error('Not connected to a remote database.');
        const host = remoteCore.host;
        const token = await remoteLogin(host, password);
        saveConfig({ ...loadConfig(), remote: { host, ...encToken(token) } });
        remoteCore = createRemoteCore({ host, token });
        remoteToken = token;
        return ok({ host });
    });

    // clears the session but keeps the host: next launch (and the reload right
    // after) show the password gate. The server-side session is revoked too,
    // best-effort - being offline must not block logging out locally.
    handle('remote:logout', async () => {
        if (mode !== 'remote') throw new Error('Not connected to a remote database.');
        try { await remoteCore.logout(); } catch { /* offline/expired - local clear still applies */ }
        const config = loadConfig();
        config.remote = { host: remoteCore.host };
        saveConfig(config);
        remoteCore = createRemoteCore({ host: config.remote.host, token: '' });
        remoteToken = null;
        return ok();
    });

    handle('remote:connect', async ({ host, password }) => {
        const h = normalizeHost(host);
        const token = await remoteLogin(h, password); // throws on bad password/unreachable
        const config = loadConfig();
        // web serving is a local-db feature: stop it AND persist it off, so a
        // later disconnect doesn't silently resume serving the local file
        const webCfg = config.webServer ? { ...config.webServer, enabled: false } : undefined;
        saveConfig({ ...config, ...(webCfg ? { webServer: webCfg } : {}), remote: { host: h, ...encToken(token) } });
        remoteCore = createRemoteCore({ host: h, token });
        remoteToken = token;
        mode = 'remote';
        await webServer.stop();
        return ok({ host: h }); // the renderer reloads itself to re-enter in remote mode
    });

    handle('remote:disconnect', async () => {
        const config = loadConfig();
        delete config.remote;
        saveConfig(config);
        remoteCore = null;
        mode = 'local';
        return ok(); // renderer reloads; the local db has been open all along
    });

    // Opening the release page is the ONLY external URL the app will launch,
    // so it's pinned to the project's own releases rather than taking a URL
    // from the renderer - a compromised page can't turn this into a launcher.
    handle('update:open', async () => {
        await shell.openExternal(RELEASES_URL);
        return ok();
    });

    // ------------------------------------------------------------ web access

    webServer = createWebServer(ctx, core);
    const bootConfig = loadConfig();
    if (mode === 'local' && bootConfig.webServer && bootConfig.webServer.enabled && core.authHas().hasPassword) {
        try {
            await webServer.start(bootConfig.webServer.port || 4180, undefined, resolveWebProxy(bootConfig));
            console.log('[web] serving on port ' + (bootConfig.webServer.port || 4180));
        } catch (e) {
            console.error('[web] failed to start: ' + e.message);
        }
    }

    handle('web:status', async () => {
        if (mode === 'remote') {
            // pane is hidden in remote mode; keep the response shape harmless
            return ok({ enabled: false, port: 4180, hasPassword: false, running: false, urls: [], sessions: 0, trustProxy: 0, secureCookie: false });
        }
        const config = loadConfig();
        return ok({
            enabled: !!(config.webServer && config.webServer.enabled),
            port: (config.webServer && config.webServer.port) || 4180,
            hasPassword: core.authHas().hasPassword,
            ...webServer.status(),      // running/urls/sessions
            // config intent wins for the proxy fields: while stopped the server
            // still holds its boot default (0), which would misreport a saved
            // setup. When running the two agree - start() derives from the same
            // config - so overriding here is only ever a correction, never a lie.
            ...resolveWebProxy(config),
        });
    });

    handle('web:set', async ({ enabled, port, trustProxy, secureCookie }) => {
        localOnly('Web access');
        port = Math.max(1024, Math.min(65535, E.num(port) || 4180));
        if (enabled && !core.authHas().hasPassword) {
            throw new Error('Set an app password first - web access requires a login.');
        }
        const prev = loadConfig();
        const webCfg = { ...(prev.webServer || {}), enabled: !!enabled, port };
        // only persist proxy fields the caller actually sent, so unrelated
        // toggles (on/off, port) don't wipe a saved reverse-proxy setup
        if (trustProxy !== undefined) webCfg.trustProxy = Math.max(0, Math.min(10, Math.floor(Number(trustProxy) || 0)));
        if (secureCookie !== undefined) webCfg.secureCookie = !!secureCookie;
        saveConfig({ ...prev, webServer: webCfg });
        const resolved = resolveWebProxy({ webServer: webCfg });
        await webServer.stop();
        if (enabled) await webServer.start(port, undefined, resolved);
        // resolved last: while web access is off the server keeps its boot
        // default (0), which would otherwise stomp the value just saved
        return ok({ enabled: !!enabled, port, hasPassword: core.authHas().hasPassword, ...webServer.status(), ...resolved });
    });

    // ------------------------------------------- dialog-based (desktop only)

    handle('backups:open-folder', async () => {
        localOnly('The backups folder');
        const dir = backupsDir(ctx.dbPath);
        fs.mkdirSync(dir, { recursive: true });
        await shell.openPath(dir);
        return ok();
    });

    handle('db:export', async (payload, event) => {
        localOnly('Export');
        const win = BrowserWindow.fromWebContents(event.sender);
        const res = await dialog.showSaveDialog(win, {
            title: 'Export a copy of your data',
            defaultPath: 'spend-wise-export.json',
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (res.canceled || !res.filePath) return ok({ exported: null });
        fs.copyFileSync(ctx.dbPath, res.filePath);
        return ok({ exported: res.filePath });
    });

    // Move the database to a new location (e.g. a synced folder).
    handle('db:change-location', async (payload, event) => {
        localOnly('Moving the database');
        const win = BrowserWindow.fromWebContents(event.sender);
        const res = await dialog.showSaveDialog(win, {
            title: 'Choose where to keep db.json',
            defaultPath: path.join(path.dirname(ctx.dbPath), 'db.json'),
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        const snapshot = () => ({ data: E.clone(ctx.db.data), path: ctx.dbPath });
        if (res.canceled || !res.filePath) return ok(snapshot());
        const newPath = res.filePath;
        if (path.resolve(newPath) !== path.resolve(ctx.dbPath)) {
            if (fs.existsSync(newPath)) {
                // adopting an existing file (multi-machine case): keep it, don't overwrite
                backupDb(ctx.dbPath, 'pre-move');
            } else {
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.copyFileSync(ctx.dbPath, newPath);
            }
            saveConfig({ ...loadConfig(), dbPath: newPath });
            ctx.dbPath = newPath;
            ctx.db = await openDb(ctx.dbPath);
        }
        return ok(snapshot());
    });

    // Phase 1 of legacy import: pick the folder and report the groups found,
    // so the user can adjust each group's kind before anything is written.
    handle('db:migrate-scan', async (payload, event) => {
        localOnly('Legacy import');
        const win = BrowserWindow.fromWebContents(event.sender);
        const res = await dialog.showOpenDialog(win, {
            title: 'Select the legacy data folder (contains files like "january-26")',
            properties: ['openDirectory'],
        });
        if (res.canceled || !res.filePaths.length) return ok({ scanned: false });
        const { data } = importLegacy(res.filePaths[0]);
        return ok({
            scanned: true,
            folder: res.filePaths[0],
            groups: data.settings.groups.map((g) => ({ title: g.title, kind: g.kind })),
        });
    });
}
