import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/main/db-open.js';
import { createCore } from '../src/main/api-core.js';
import '../src/shared/engine.js';

const E = globalThis.FinEngine;

function seedMonth () {
    return {
        key: '2026-06',
        status: 'open',
        startingSavings: 1000,
        closingSavings: null,
        groups: [
            {
                groupId: 'g-inc', title: 'Income', kind: 'income',
                fields: [
                    { id: 'f-pay', label: 'Paycheck', value: 2000, pinned: true, accounted: false, tags: [] },
                ],
            },
            {
                groupId: 'g-exp', title: 'Expenses', kind: 'expense',
                fields: [
                    { id: 'f-rent', label: 'Rent', value: 800, pinned: true, accounted: false, tags: [], budgetId: null },
                    { id: 'f-net', label: 'Internet', value: 60, pinned: true, accounted: false, tags: [], budgetId: null },
                ],
            },
        ],
    };
}

let dir, dbPath, ctx, core;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-core-'));
    dbPath = path.join(dir, 'db.json');
    const db = await openDb(dbPath);
    db.data = {
        meta: { schemaVersion: 1, rev: 0 },
        settings: {
            currency: 'USD', initialSavings: 1000,
            groups: [
                { id: 'g-inc', title: 'Income', kind: 'income', order: 0 },
                { id: 'g-exp', title: 'Expenses', kind: 'expense', order: 1 },
            ],
        },
        months: { '2026-06': seedMonth() },
        savingsHistory: { '2026-06': 1000 },
    };
    await db.write();
    ctx = { db, dbPath };
    core = createCore(ctx);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const monthClone = () => E.clone(ctx.db.data.months['2026-06']);
const field = (m, id) => E.findField(m, id);

describe('api-core saveMonth', () => {
    it('clean rev: writes in place, no merge', async () => {
        const mine = monthClone();
        field(mine, 'f-pay').value = 2100;
        const res = await core.saveMonth({ key: '2026-06', month: mine, base: monthClone(), expectedRev: 0 });
        expect(res.merged).toBeUndefined();
        expect(res.rev).toBe(1);
        expect(field(ctx.db.data.months['2026-06'], 'f-pay').value).toBe(2100);
    });

    it('stale rev: merges both sessions\' edits instead of hard-stopping', async () => {
        const base = monthClone();

        // session B saves first (rent edit)
        const theirs = E.clone(base);
        field(theirs, 'f-rent').value = 850;
        await core.saveMonth({ key: '2026-06', month: theirs, base: E.clone(base), expectedRev: 0 });

        // session A saves with the old rev (paycheck edit)
        const mine = E.clone(base);
        field(mine, 'f-pay').value = 2400;
        const res = await core.saveMonth({ key: '2026-06', month: mine, base: E.clone(base), expectedRev: 0 });

        expect(res.merged).toBe(true);
        expect(res.conflicts).toEqual([]);
        const saved = ctx.db.data.months['2026-06'];
        expect(field(saved, 'f-pay').value).toBe(2400);   // mine
        expect(field(saved, 'f-rent').value).toBe(850);   // theirs
        expect(res.data.months['2026-06']).toBeTruthy();  // full snapshot returned
    });

    it('true conflict: mine wins, conflict reported', async () => {
        const base = monthClone();
        const theirs = E.clone(base);
        field(theirs, 'f-net').value = 70;
        await core.saveMonth({ key: '2026-06', month: theirs, base: E.clone(base), expectedRev: 0 });

        const mine = E.clone(base);
        field(mine, 'f-net').value = 65;
        const res = await core.saveMonth({ key: '2026-06', month: mine, base: E.clone(base), expectedRev: 0 });

        expect(res.merged).toBe(true);
        expect(res.conflicts).toHaveLength(1);
        expect(res.conflicts[0]).toMatchObject({ fieldId: 'f-net', prop: 'value', mine: 65, theirs: 70 });
        expect(field(ctx.db.data.months['2026-06'], 'f-net').value).toBe(65);
    });

    it('month closed by another session: hard stop', async () => {
        ctx.db.data.months['2026-06'].status = 'closed';
        ctx.db.data.meta.rev = 5;
        const mine = monthClone();
        mine.status = 'open';
        await expect(core.saveMonth({ key: '2026-06', month: mine, base: monthClone(), expectedRev: 0 }))
            .rejects.toThrow(/closed by another session/);
    });

    it('no base from the client: legacy hard stop on stale rev', async () => {
        ctx.db.data.meta.rev = 3;
        await expect(core.saveMonth({ key: '2026-06', month: monthClone(), expectedRev: 0 }))
            .rejects.toThrow(/stale/);
    });
});

describe('api-core applyTagsEverywhere', () => {
    it('applies without a rev gate (commutes with concurrent edits)', async () => {
        ctx.db.data.meta.rev = 42; // pretend other sessions have been saving
        const res = await core.applyTagsEverywhere({ fieldId: 'f-rent', add: ['housing'], remove: null });
        expect(res.monthsTouched).toBe(1);
        expect(res.rev).toBe(43);
        expect(field(ctx.db.data.months['2026-06'], 'f-rent').tags).toEqual(['housing']);
    });
});

describe('api-core importsApply', () => {
    it('ensures the blob on older dbs, applies ops, persists, bumps the rev', async () => {
        expect(ctx.db.data.imports).toBeUndefined(); // the seed predates imports
        ctx.db.data.meta.rev = 7; // no rev gate, like tags
        const res = await core.importsApply({
            ops: [
                { op: 'saveAccount', account: { id: 'acct-1', label: 'Checking', groupId: 'g-exp' } },
                { op: 'addItems', accountId: 'acct-1', items: [
                    { fp: 'a', date: '2026-06-02', label: 'COFFEE', amount: 4.5 },
                    { fp: 'a', date: '2026-06-02', label: 'COFFEE', amount: 4.5 },
                ] },
            ],
        });
        expect(res.rev).toBe(8);
        expect(res.added).toBe(1);
        expect(res.skipped).toBe(1);
        expect(res.imports.items).toHaveLength(1);
        const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        expect(onDisk.imports.items).toHaveLength(1);
        expect(onDisk.meta.rev).toBe(8);
    });

    it('loadDb ensures the imports blob exists for the renderer', async () => {
        const res = await core.loadDb();
        expect(res.data.imports).toEqual({ accounts: [], rules: [], items: [] });
    });
});

describe('api-core SimpleFIN', () => {
    const sfFetch = (accounts) => async (url, opts = {}) => {
        if ((opts.method || 'GET') === 'POST') return { ok: true, text: async () => 'https://a:b@host/simplefin' };
        return { ok: true, status: 200, json: async () => ({ errors: [], accounts }) };
    };
    const demoAccounts = [{
        id: 'ACT-1', name: 'Checking', org: { name: 'Demo Bank' },
        transactions: [
            { id: 't1', posted: 1760000000, amount: '-105.50', payee: 'Fish Shack' },
            { id: 't2', posted: 1760086400, amount: '-35.50', payee: 'Grocer' },
        ],
    }];

    it('setup claims + probes + stores; status reports; snapshots never leak the credential', async () => {
        ctx.fetchImpl = sfFetch(demoAccounts);
        core = createCore(ctx);
        expect(core.simplefinStatus()).toEqual({ connected: false, lastSync: null });
        const token = Buffer.from('https://host/simplefin/claim/abc').toString('base64');
        const res = await core.simplefinSetup({ token });
        expect(res.connected).toBe(true);
        expect(ctx.db.data.imports.simplefin.accessUrl).toBe('https://a:b@host/simplefin');
        expect(core.simplefinStatus().connected).toBe(true);
        // the credential never leaves the process
        const snap = await core.loadDb();
        expect(snap.data.imports.simplefin).toBeUndefined();
        const applied = await core.importsApply({ ops: [] });
        expect(applied.imports.simplefin).toBeUndefined();
    });

    it('sync creates sfin-bound accounts, dedupes on re-sync, stamps lastSync', async () => {
        ctx.fetchImpl = sfFetch(demoAccounts);
        core = createCore(ctx);
        await core.simplefinSetup({ token: 'https://a:b@host/simplefin' });
        const first = await core.simplefinSync({});
        expect(first.added).toBe(2);
        expect(first.accounts).toBe(1);
        const acct = ctx.db.data.imports.accounts[0];
        expect(acct).toMatchObject({ label: 'Demo Bank Checking', groupId: 'g-exp', sfin: 'ACT-1' });
        expect(ctx.db.data.imports.items.map((i) => i.fp)).toEqual(['sf:t1', 'sf:t2']);
        expect(ctx.db.data.imports.simplefin.lastSync).toBeTruthy();
        expect(first.imports.simplefin).toBeUndefined();

        const again = await core.simplefinSync({});
        expect(again.added).toBe(0);
        expect(again.skipped).toBe(2);
        expect(ctx.db.data.imports.accounts).toHaveLength(1); // no duplicate account either
    });

    it('a UI rename (no sfin in the op) keeps the binding', async () => {
        ctx.fetchImpl = sfFetch(demoAccounts);
        core = createCore(ctx);
        await core.simplefinSetup({ token: 'https://a:b@host/simplefin' });
        await core.simplefinSync({});
        const acct = ctx.db.data.imports.accounts[0];
        await core.importsApply({ ops: [{ op: 'saveAccount', account: { id: acct.id, label: 'Renamed', groupId: 'g-exp' } }] });
        expect(ctx.db.data.imports.accounts[0]).toMatchObject({ label: 'Renamed', sfin: 'ACT-1' });
    });

    it('disconnect deletes the credential; sync without one refuses', async () => {
        ctx.fetchImpl = sfFetch(demoAccounts);
        core = createCore(ctx);
        await core.simplefinSetup({ token: 'https://a:b@host/simplefin' });
        await core.simplefinDisconnect();
        expect(ctx.db.data.imports.simplefin).toBeUndefined();
        await expect(core.simplefinSync({})).rejects.toThrow(/not connected/i);
    });
});

describe('api-core app password', () => {
    it('set → verify → change requires current → remove', async () => {
        expect(core.authHas().hasPassword).toBe(false);

        await core.authSet({ next: 'hunter2' });
        expect(core.authHas().hasPassword).toBe(true);
        expect(core.authVerify({ password: 'hunter2' }).valid).toBe(true);
        expect(core.authVerify({ password: 'wrong' }).valid).toBe(false);

        await expect(core.authSet({ current: 'nope', next: 'other' })).rejects.toThrow(/incorrect/);
        await core.authSet({ current: 'hunter2', next: 'correct-horse' });
        expect(core.authVerify({ password: 'correct-horse' }).valid).toBe(true);

        await core.authSet({ current: 'correct-horse', next: '' });
        expect(core.authHas().hasPassword).toBe(false);
    });

    it('saveSettings can never overwrite the stored password hash', async () => {
        await core.authSet({ next: 'hunter2' });
        const rev = ctx.db.data.meta.rev;
        const doctored = E.clone(ctx.db.data.settings);
        doctored.auth = { v: 1, salt: '00', hash: '00' }; // attacker-supplied
        await core.saveSettings({ settings: doctored, expectedRev: rev });
        expect(core.authVerify({ password: 'hunter2' }).valid).toBe(true);
    });
});
