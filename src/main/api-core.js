/*
 * Transport-agnostic API core: the same handlers sit behind Electron IPC,
 * the built-in web server, and the dev preview server. Method names match
 * the renderer's window.api surface so every transport maps 1:1.
 *
 * `ctx` owns the LIVE lowdb instance and path, mutable so restore /
 * change-location can swap them: { db, dbPath }. Handlers THROW on failure -
 * each transport wraps results in { ok, ... } / { ok:false, error }.
 *
 * No Electron imports here - dialog-based features (export, change location,
 * import-folder picking) live with their transports.
 */
'use strict';

import fs from 'node:fs';
import '../shared/engine.js';
import { backupDb, listBackups, backupPath } from './backup.js';
import { importLegacy } from './migrate.js';
import { openDb } from './db-open.js';
import { hashPassword, verifyPassword } from './auth.js';
import { createUpdateChecker, RELEASES_URL } from './update-check.js';

const E = globalThis.FinEngine;

export function createCore (ctx) {
    const updater = createUpdateChecker({
        currentVersion: ctx.version || '',
        fetchImpl: ctx.fetchImpl, // tests inject; production uses global fetch
    });
    const assertRev = (expectedRev) => {
        if (E.num(expectedRev) !== E.num(ctx.db.data.meta.rev)) {
            throw new Error('stale: the data was changed by another session. Reload before saving.');
        }
    };

    async function persist () {
        ctx.db.data.meta.rev = E.num(ctx.db.data.meta.rev) + 1;
        await ctx.db.write(); // lowdb/steno writes temp-file-then-rename (atomic)
    }

    const snapshot = () => ({ data: E.clone(ctx.db.data), path: ctx.dbPath, version: ctx.version || '' });

    return {
        async loadDb () {
            await ctx.db.read();
            if (!ctx.db.data) throw new Error('Database file is missing or unreadable.');
            return snapshot();
        },

        rev () {
            return { rev: E.num(ctx.db.data.meta.rev) };
        },

        /**
         * Ask GitHub whether a newer release is tagged. Opt-out lives in
         * settings so it travels with the database (a self-hoster decides once
         * for everyone who uses their server). Never throws: a failed check is
         * not the user's problem.
         */
        async checkUpdate ({ force = false } = {}) {
            const enabled = ctx.db.data.settings.updateCheck !== false; // default on
            if (!enabled) {
                return { enabled: false, current: ctx.version || '', available: false, url: RELEASES_URL };
            }
            const res = await updater.check({ force });
            return { enabled: true, ...res };
        },

        /**
         * Save an OPEN month. Clean rev → write in place. Stale rev → field-
         * level three-way merge against what the other session persisted
         * (`base` is the month as this client loaded it), then recompute
         * forward so derived chains stay consistent. True conflicts are
         * reported, not fatal - co-editing must not hard-stop.
         */
        async saveMonth ({ key, month, base, expectedRev }) {
            if (!ctx.db.data.months[key]) throw new Error('That month no longer exists - reload.');
            E.applyAutoValues(month);

            if (E.num(expectedRev) === E.num(ctx.db.data.meta.rev)) {
                ctx.db.data.months[key] = month;
                ctx.db.data.savingsHistory[key] = E.num(month.startingSavings);
                await persist();
                return { rev: ctx.db.data.meta.rev };
            }

            const theirs = ctx.db.data.months[key];
            if (theirs.status === 'closed' && month.status !== 'closed') {
                throw new Error(`${E.keyLabel(key)} was closed by another session. Reload before editing.`);
            }
            if (!base) assertRev(expectedRev); // client sent no base snapshot → legacy hard stop

            const { month: merged, conflicts } = E.mergeMonth(base, month, theirs);
            const staged = E.clone(ctx.db.data);
            staged.months[key] = E.applyAutoValues(merged);
            const { db: recomputed } = E.recomputeForward(staged, key);
            ctx.db.data = recomputed;
            ctx.db.data.savingsHistory[key] = E.num(ctx.db.data.months[key].startingSavings);
            await persist();
            return { ...snapshot(), rev: ctx.db.data.meta.rev, merged: true, conflicts };
        },

        // Save an edited CLOSED month: backup → apply → recompute → persist.
        // History edits keep the hard rev gate - merging rewritten history is
        // not worth the risk.
        async saveClosedMonth ({ key, month, expectedRev }) {
            assertRev(expectedRev);
            backupDb(ctx.dbPath, 'pre-recompute');
            const staged = E.clone(ctx.db.data);
            staged.months[key] = E.applyAutoValues(month);
            const { db: recomputed, changes } = E.recomputeForward(staged, key);
            ctx.db.data = recomputed;
            await persist();
            return { ...snapshot(), changes };
        },

        // Close out a month: finalize it, materialize the next via rollover.
        // carryOver: ids of income/expense rows that never happened this month
        // (value, no paid/received mark) - they are zeroed here and re-created
        // in the next month, all inside this one write (see engine carryOver*).
        async closeMonth ({ key, month, expectedRev, carryOver }) {
            assertRev(expectedRev);
            const nk = E.nextKey(key);
            if (ctx.db.data.months[nk]) {
                throw new Error(`${E.keyLabel(nk)} already exists - edit it instead of closing ${E.keyLabel(key)} again.`);
            }
            backupDb(ctx.dbPath, 'close-month');
            // extract before auto-values: a % rule must not fund from income
            // that never arrived
            const carried = E.carryOverExtract(month, carryOver);
            E.applyAutoValues(month);
            month.status = 'closed';
            month.closingSavings = E.savings(month);
            ctx.db.data.months[key] = month;
            ctx.db.data.savingsHistory[key] = E.num(month.startingSavings);
            const next = E.rollover(month, ctx.db.data.settings);
            E.carryOverRestore(next, carried);
            ctx.db.data.months[nk] = next;
            ctx.db.data.savingsHistory[nk] = E.num(next.startingSavings);
            await persist();
            return { ...snapshot(), nextKey: nk, carried: carried.length };
        },

        // Save settings; open months re-sync to the new group list. The app
        // password can NOT be changed through here - settings.auth is always
        // preserved from the live db (see setPassword), so a web client can
        // never overwrite it with a doctored settings blob.
        async saveSettings ({ settings, expectedRev }) {
            assertRev(expectedRev);
            const prevInitial = E.num(ctx.db.data.settings.initialSavings);
            const auth = ctx.db.data.settings.auth;
            ctx.db.data.settings = { ...settings };
            if (auth) ctx.db.data.settings.auth = auth;
            else delete ctx.db.data.settings.auth;

            for (const key of E.monthKeys(ctx.db.data)) {
                if (ctx.db.data.months[key].status === 'open') {
                    E.syncMonthWithSettings(ctx.db.data.months[key], ctx.db.data.settings);
                }
            }

            let changes = [];
            const keys = E.monthKeys(ctx.db.data);
            const newInitial = E.num(settings.initialSavings);
            if (keys.length && newInitial !== prevInitial) {
                backupDb(ctx.dbPath, 'initial-savings');
                const first = keys[0];
                ctx.db.data.months[first].startingSavings = newInitial;
                ctx.db.data.savingsHistory[first] = newInitial;
                const res = E.recomputeForward(ctx.db.data, first);
                ctx.db.data = res.db;
                changes = res.changes;
            }

            await persist();
            return { ...snapshot(), changes };
        },

        // Tag add/remove applies to the field across ALL months. No rev gate:
        // tag ops are semantic and commute with concurrent edits - rebasing
        // them onto the current state is always correct.
        async applyTagsEverywhere ({ fieldId, add, remove }) {
            const monthsTouched = E.applyTagsAcrossMonths(ctx.db.data, fieldId, add || [], remove || null);
            await persist();
            return { rev: ctx.db.data.meta.rev, monthsTouched };
        },

        async listBackups () {
            return { backups: listBackups(ctx.dbPath) };
        },

        async restoreBackup ({ name }) {
            const source = backupPath(ctx.dbPath, name);
            if (!fs.existsSync(source)) throw new Error('Backup not found.');
            backupDb(ctx.dbPath, 'pre-restore');
            fs.copyFileSync(source, ctx.dbPath);
            ctx.db = await openDb(ctx.dbPath);
            await persist(); // bump rev so other sessions detect the change
            return snapshot();
        },

        // Phase 2 of legacy import (folder picking is transport-specific).
        async migrateLegacy ({ folder, overrides }) {
            if (!folder) return { imported: false };
            const { data, summary } = importLegacy(folder, overrides || {});
            backupDb(ctx.dbPath, 'pre-import');
            data.meta.rev = E.num(ctx.db.data.meta.rev); // persist() bumps it
            data.settings.auth = ctx.db.data.settings.auth; // password survives an import
            if (!data.settings.auth) delete data.settings.auth;
            ctx.db.data = data;
            await persist();
            return { ...snapshot(), imported: true, summary };
        },

        // ------------------------------------------------------ app password

        authHas () {
            return { hasPassword: !!(ctx.db.data.settings && ctx.db.data.settings.auth) };
        },

        authVerify ({ password }) {
            return { valid: verifyPassword(password, ctx.db.data.settings.auth) };
        },

        // Set / change / remove (next = empty). Changing or removing requires
        // the current password.
        async authSet ({ current, next }) {
            const auth = ctx.db.data.settings.auth;
            if (auth && !verifyPassword(current || '', auth)) {
                throw new Error('Current password is incorrect.');
            }
            if (next) ctx.db.data.settings.auth = hashPassword(next);
            else delete ctx.db.data.settings.auth;
            await persist();
            return { hasPassword: !!next, rev: ctx.db.data.meta.rev };
        },
    };
}
