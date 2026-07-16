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
