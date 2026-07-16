import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
export { openDb, currentMonthKey } from '../db-open.js';

const configPath = () => path.join(app.getPath('userData'), 'config.json');

// The app was called "Finances" before 1.1; Electron derives userData from the
// app name, so the rename would strand the old folder's database, settings and
// backups. Adopt them once, on first run of the renamed app.
const LEGACY_APP_NAME = 'Finances';

export function migrateLegacyUserData () {
    const current = app.getPath('userData');
    const legacy = path.join(path.dirname(current), LEGACY_APP_NAME);
    if (path.resolve(legacy) === path.resolve(current) || !fs.existsSync(legacy)) return null;
    // only ever adopt into a folder that has no data of its own
    if (fs.existsSync(path.join(current, 'db.json')) || fs.existsSync(path.join(current, 'config.json'))) return null;

    const copied = [];
    fs.mkdirSync(current, { recursive: true });
    for (const name of ['config.json', 'db.json']) {
        const from = path.join(legacy, name);
        if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(current, name)); copied.push(name); }
    }
    const legacyBackups = path.join(legacy, 'backups');
    if (fs.existsSync(legacyBackups)) {
        // the user's history lives here - Settings → Backups must still find it
        fs.cpSync(legacyBackups, path.join(current, 'backups'), { recursive: true });
        copied.push(`backups/ (${fs.readdirSync(legacyBackups).length} files)`);
    }
    if (!copied.length) return null;
    // copy, never move: the old folder stays as a safety net
    console.log(`[migrate] adopted data from "${LEGACY_APP_NAME}": ${copied.join(', ')}`);
    return { from: legacy, to: current, copied };
}

export function loadConfig () {
    try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch {
        return {};
    }
}

export function saveConfig (config) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

export function resolveDbPath () {
    if (process.env.FINANCES_DB_PATH) return process.env.FINANCES_DB_PATH; // tests
    const config = loadConfig();
    return config.dbPath || path.join(app.getPath('userData'), 'db.json');
}
