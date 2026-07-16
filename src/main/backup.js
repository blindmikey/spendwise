import path from 'node:path';
import fs from 'node:fs';

const KEEP = 20;

export function backupsDir (dbPath) {
    return path.join(path.dirname(dbPath), 'backups');
}

/** Copy db.json to backups/db-<timestamp>.json before a risky write. Keeps last 20. */
export function backupDb (dbPath, reason = 'backup') {
    if (!fs.existsSync(dbPath)) return null;
    const dir = backupsDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `db-${stamp}-${reason}.json`;
    fs.copyFileSync(dbPath, path.join(dir, name));
    prune(dir);
    return name;
}

function prune (dir) {
    const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith('db-') && f.endsWith('.json'))
        .sort();
    while (files.length > KEEP) {
        fs.unlinkSync(path.join(dir, files.shift()));
    }
}

export function listBackups (dbPath) {
    const dir = backupsDir(dbPath);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.startsWith('db-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .map((name) => {
            const stat = fs.statSync(path.join(dir, name));
            return { name, size: stat.size, mtime: stat.mtime.toISOString() };
        });
}

export function backupPath (dbPath, name) {
    // guard against path escape - only bare filenames from listBackups are valid
    if (path.basename(name) !== name) throw new Error('Invalid backup name');
    return path.join(backupsDir(dbPath), name);
}
