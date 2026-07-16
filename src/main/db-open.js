/*
 * Electron-free database opener + lazy migrations, shared by the Electron
 * main process (storage/local.js), the web server, and the dev preview
 * server - one place for healing logic instead of three copies.
 */
'use strict';

import path from 'node:path';
import fs from 'node:fs';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import '../shared/engine.js';

const E = globalThis.FinEngine;

export function currentMonthKey () {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Open (creating with default data if missing) the lowdb database at dbPath. */
export async function openDb (dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Low(new JSONFile(dbPath), null);
    await db.read();
    if (!db.data || !db.data.meta) {
        db.data = E.defaultData(currentMonthKey());
        await db.write();
    }
    // lazy migration: seed initialSavings from the first month for older dbs
    if (db.data.settings && db.data.settings.initialSavings === undefined) {
        const first = E.monthKeys(db.data)[0];
        db.data.settings.initialSavings = first ? E.num(db.data.months[first].startingSavings) : 0;
        await db.write();
    }
    // heal budgetIds corrupted by the option-value fallback bug ("-" committed
    // as the link target): truthy-but-dangling placeholder text → unlinked
    let healed = 0;
    for (const key of E.monthKeys(db.data)) {
        for (const f of E.allFields(db.data.months[key])) {
            if (f.budgetId === '-' || f.budgetId === '') { f.budgetId = null; healed += 1; }
        }
    }
    if (healed) {
        console.log(`[db] healed ${healed} dangling budget link(s)`);
        await db.write();
    }
    // lazy migration: return-to-income lines no longer carry the auto tag,
    // and their label prefix gained the word "budget"
    let returns = 0;
    for (const key of E.monthKeys(db.data)) {
        for (const f of E.allFields(db.data.months[key])) {
            if (!f.returnedFrom) continue;
            let touched = false;
            if ((f.tags || []).includes('returned-budget')) {
                f.tags = f.tags.filter((t) => t !== 'returned-budget');
                touched = true;
            }
            if ((f.label || '').startsWith('Returned from: ')) {
                f.label = 'Returned from budget: ' + f.label.slice('Returned from: '.length);
                touched = true;
            }
            if (touched) returns += 1;
        }
    }
    if (returns) {
        console.log(`[db] migrated ${returns} return-to-income line(s)`);
        await db.write();
    }
    // lazy migration: months know their own key (scheduled goals need it)
    let stamped = 0;
    for (const key of E.monthKeys(db.data)) {
        if (db.data.months[key].key !== key) { db.data.months[key].key = key; stamped += 1; }
    }
    if (stamped) await db.write();
    return db;
}
