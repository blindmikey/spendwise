import { describe, it, expect, beforeEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import '../src/shared/engine.js';
import '../src/shared/importer.js';

const E = globalThis.FinEngine;
const I = globalThis.FinImporter;

// ---------------------------------------------------------------- fixtures

function makeDb () {
    const settings = {
        currency: 'USD',
        groups: [
            { id: 'g-inc', title: 'Income', kind: 'income', order: 0 },
            { id: 'g-env', title: 'Budgeted', kind: 'envelope', order: 1 },
            { id: 'g-exp', title: 'Expenses', kind: 'expense', order: 2 },
            { id: 'g-biz', title: 'Business', kind: 'expense', order: 3 },
        ],
    };
    const month = {
        key: '2026-10',
        status: 'open',
        startingSavings: 0,
        closingSavings: null,
        groups: [
            { groupId: 'g-inc', title: 'Income', kind: 'income', fields: [] },
            { groupId: 'g-env', title: 'Budgeted', kind: 'envelope', fields: [] },
            {
                groupId: 'g-exp',
                title: 'Expenses',
                kind: 'expense',
                fields: [
                    { id: 'f-elec', label: 'Electric', value: 140, pinned: true, accounted: false, tags: [], budgetId: null },
                    { id: 'f-rent', label: 'Rent', value: 1800, pinned: true, accounted: false, tags: [], budgetId: null },
                ],
            },
            { groupId: 'g-biz', title: 'Business', kind: 'expense', fields: [] },
        ],
    };
    return {
        meta: { schemaVersion: 1, rev: 0 },
        settings,
        months: { '2026-10': month },
        savingsHistory: {},
        imports: { accounts: [{ id: 'acct-1', label: 'Checking', groupId: 'g-exp' }], rules: [], items: [] },
    };
}

// --------------------------------------------------------------- CSV parse

describe('parseCsv', () => {
    it('parses quoted fields, escaped quotes, and commas inside quotes', () => {
        const rows = I.parseCsv('a,"b,c","say ""hi"""\n1,2,3\r\n');
        expect(rows).toEqual([['a', 'b,c', 'say "hi"'], ['1', '2', '3']]);
    });

    it('keeps newlines inside quotes and skips blank lines', () => {
        const rows = I.parseCsv('a,"line1\nline2"\n\n,\nx,y');
        expect(rows).toEqual([['a', 'line1\nline2'], ['x', 'y']]);
    });

    it('detects semicolon and tab delimiters', () => {
        expect(I.parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
        expect(I.parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
        // commas inside quotes don't sway the delimiter vote
        expect(I.detectDelimiter('"a,a";b;c')).toBe(';');
    });
});

describe('parseAmount / parseDate', () => {
    it('handles currency junk, parens, and trailing minus', () => {
        expect(I.parseAmount('$1,234.56')).toBe(1234.56);
        expect(I.parseAmount('(12.34)')).toBe(-12.34);
        expect(I.parseAmount('12.34-')).toBe(-12.34);
        expect(I.parseAmount('-5')).toBe(-5);
        expect(I.parseAmount('')).toBe(0);
        expect(I.parseAmount('N/A')).toBe(0);
    });

    it('parses ISO and US dates', () => {
        expect(I.parseDate('2026-10-04')).toBe('2026-10-04');
        expect(I.parseDate('2026/10/4')).toBe('2026-10-04');
        expect(I.parseDate('10/4/2026')).toBe('2026-10-04');
        expect(I.parseDate('10-04-26')).toBe('2026-10-04');
        expect(I.parseDate('Oct 4')).toBe(null);
    });

    it('converts Excel date serials in the sane modern range only', () => {
        const serial = 46291;
        const expected = new Date((serial - 25569) * 86400000).toISOString().slice(0, 10);
        expect(I.parseDate('46291')).toBe(expected);
        expect(I.parseDate('25569')).toBe('1970-01-01');
        expect(I.parseDate('99999')).toBe(null); // past 2099
        expect(I.parseDate('1234')).toBe(null);  // not a serial
    });
});

// ---------------------------------------------------------------- XLSX parse

/** Minimal valid ZIP builder (local headers + central directory + EOCD). */
function makeZip (entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const nameB = Buffer.from(enc.encode(e.name));
        const raw = Buffer.from(enc.encode(e.data));
        const method = e.method === undefined ? 8 : e.method;
        const comp = method === 8 ? deflateRawSync(raw) : raw;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(raw.length, 22);
        lh.writeUInt16LE(nameB.length, 26);
        const localOff = offset;
        chunks.push(lh, nameB, comp);
        offset += 30 + nameB.length + comp.length;
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(comp.length, 20);
        cd.writeUInt32LE(raw.length, 24);
        cd.writeUInt16LE(nameB.length, 28);
        cd.writeUInt32LE(localOff, 42);
        central.push(cd, nameB);
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...chunks, cdBuf, eocd]));
}

describe('parseXlsx', () => {
    const SHARED = '<sst><si><t>Date</t></si><si><t>Description</t></si><si><t>Amount</t></si>'
        + '<si><t>COFFEE &amp; TEA</t></si><si><t>Grocery &lt;Store&gt;</t></si></sst>';
    const SHEET = '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
        + '<row r="2"><c r="A2"><v>46291</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-4.5</v></c></row>'
        + '<row r="3"><c r="A3"><v>46292</v></c><c r="B3" t="inlineStr"><is><t>Inline Merchant</t></is></c><c r="C3"><v>-12.1</v></c></row>'
        + '<row r="4"><c r="A4"/><c r="C4" t="s"><v>4</v></c></row>'
        + '</sheetData></worksheet>';

    it('reads sheet rows with shared, inline, and entity-encoded strings', async () => {
        const zip = makeZip([
            { name: 'xl/sharedStrings.xml', data: SHARED, method: 0 }, // stored entry path
            { name: 'xl/worksheets/sheet1.xml', data: SHEET },          // deflated entry path
        ]);
        const rows = await I.parseXlsx(zip);
        expect(rows).toEqual([
            ['Date', 'Description', 'Amount'],
            ['46291', 'COFFEE & TEA', '-4.5'],
            ['46292', 'Inline Merchant', '-12.1'],
            ['', '', 'Grocery <Store>'],
        ]);
    });

    it('feeds the same pipeline as CSV: detection, serial dates, amounts', async () => {
        const zip = makeZip([
            { name: 'xl/sharedStrings.xml', data: SHARED },
            { name: 'xl/worksheets/sheet1.xml', data: SHEET },
        ]);
        const rows = await I.parseXlsx(zip);
        const map = I.detectColumns(rows);
        expect(map).toMatchObject({ header: true, date: 0, desc: 1, amount: 2 });
        const txs = I.buildTransactions(rows, map);
        expect(txs[0]).toMatchObject({
            date: new Date((46291 - 25569) * 86400000).toISOString().slice(0, 10),
            label: 'COFFEE & TEA',
            amount: -4.5,
        });
        expect(I.detectExpensesNegative(txs)).toBe(true);
    });

    it('rejects non-zip garbage with a friendly error', async () => {
        await expect(I.parseXlsx(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/valid \.xlsx/i);
    });
});

describe('detectColumns + buildTransactions', () => {
    it('maps a standard headered export', () => {
        const rows = I.parseCsv('Date,Description,Amount\n10/01/2026,COFFEE SHOP,-4.50\n10/02/2026,PAYROLL,1200.00');
        const map = I.detectColumns(rows);
        expect(map).toMatchObject({ header: true, date: 0, desc: 1, amount: 2 });
        const txs = I.buildTransactions(rows, map);
        expect(txs).toHaveLength(2);
        expect(txs[0]).toMatchObject({ date: '2026-10-01', label: 'COFFEE SHOP', amount: -4.5 });
    });

    it('resolves debit/credit pairs to one signed amount (debit positive)', () => {
        const rows = I.parseCsv('Posted Date,Payee,Debit,Credit\n10/01/2026,GROCER,52.10,\n10/02/2026,REFUND,,20.00');
        const map = I.detectColumns(rows);
        expect(map.debit).toBe(2);
        expect(map.credit).toBe(3);
        const txs = I.buildTransactions(rows, map);
        expect(txs[0].amount).toBe(52.1);
        expect(txs[1].amount).toBe(-20);
    });

    it('skips rows a status column marks pending', () => {
        const rows = I.parseCsv('Date,Description,Amount,Status\n10/01/2026,A,-1,Posted\n10/02/2026,B,-2,Pending');
        const txs = I.buildTransactions(rows, I.detectColumns(rows));
        expect(txs.map((t) => t.label)).toEqual(['A']);
    });

    it('probes headerless files', () => {
        const rows = I.parseCsv('10/01/2026,COFFEE SHOP SEATTLE,-4.50\n10/02/2026,BIG GROCER,-52.10');
        const map = I.detectColumns(rows);
        expect(map.header).toBe(false);
        expect(map.date).toBe(0);
        expect(map.desc).toBe(1);
        expect(map.amount).toBe(2);
        expect(I.buildTransactions(rows, map)).toHaveLength(2);
    });
});

describe('sign + fingerprints + merchant normalization', () => {
    it('detects the expenses-negative convention and normalizes it away', () => {
        const txs = [{ amount: -4 }, { amount: -7 }, { amount: 1200 }];
        expect(I.detectExpensesNegative(txs)).toBe(true);
        const out = I.applySign(txs, true);
        expect(out.map((t) => t.amount)).toEqual([4, 7, -1200]);
    });

    it('fingerprints identical lines with occurrence counters, deterministically', () => {
        const txs = [
            { date: '2026-10-01', dateRaw: '10/01', label: 'COFFEE', amount: 4.5 },
            { date: '2026-10-01', dateRaw: '10/01', label: 'COFFEE', amount: 4.5 },
            { date: '2026-10-01', dateRaw: '10/01', label: 'COFFEE', amount: 5 },
        ];
        const fps = I.withFingerprints(txs).map((t) => t.fp);
        expect(fps[0]).toBe('2026-10-01|4.50|coffee');
        expect(fps[1]).toBe('2026-10-01|4.50|coffee#2');
        expect(fps[2]).toBe('2026-10-01|5.00|coffee');
        expect(new Set(fps).size).toBe(3);
    });

    it('normalizes merchants to a stable match key', () => {
        expect(I.normalizeMerchant('SQ *COFFEE 0423')).toBe('SQ COFFEE');
        expect(I.normalizeMerchant('duke energy pmt 10/02')).toBe('DUKE ENERGY PMT');
        expect(I.normalizeMerchant('  ')).toBe('');
    });
});

// --------------------------------------------------------------- ledger ops

describe('applyOps', () => {
    let db;
    beforeEach(() => { db = makeDb(); });

    const add = (items) => I.applyOps(db, [{ op: 'addItems', accountId: 'acct-1', items }]);

    it('adds items and dedupes by (account, fingerprint) - within and across calls', () => {
        const batch = [
            { fp: 'a', date: '2026-10-01', label: 'COFFEE', amount: 4.5 },
            { fp: 'a', date: '2026-10-01', label: 'COFFEE', amount: 4.5 },
            { fp: 'b', date: '2026-10-02', label: 'GROCER', amount: 52 },
        ];
        expect(add(batch)).toMatchObject({ added: 2, skipped: 1 });
        expect(add(batch)).toMatchObject({ added: 0, skipped: 3 });
        expect(db.imports.items).toHaveLength(2);
        expect(db.imports.items[0].status).toBe('pending');
        // the same fingerprint under ANOTHER account is a different transaction
        const res = I.applyOps(db, [{ op: 'addItems', accountId: 'acct-2', items: [{ fp: 'a', label: 'COFFEE', amount: 4.5 }] }]);
        expect(res.added).toBe(1);
    });

    it('content-dedupes re-issued bank ids, credit-counted per account', () => {
        // first sync: two genuinely identical coffees (distinct bank ids)
        add([
            { fp: 'sf:a1', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
            { fp: 'sf:a2', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
        ]);
        expect(db.imports.items).toHaveLength(2);
        // re-sync where the bank re-issued every id: both consumed by credits
        const res = add([
            { fp: 'sf:b1', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
            { fp: 'sf:b2', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
        ]);
        expect(res).toMatchObject({ added: 0, skipped: 2 });
        // syncs carry the whole overlapping window: a genuine THIRD identical
        // purchase arrives alongside (re-issued) copies of the first two,
        // which consume the credits - the third exceeds them and lands
        expect(add([
            { fp: 'sf:c1', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
            { fp: 'sf:c2', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
            { fp: 'sf:c3', date: '2026-10-03', label: 'COFFEE', amount: 4.5 },
        ])).toMatchObject({ added: 1, skipped: 2 });
        // same content under another account is untouched by these credits
        const other = I.applyOps(db, [{ op: 'addItems', accountId: 'acct-2', items: [{ fp: 'sf:a1', date: '2026-10-03', label: 'COFFEE', amount: 4.5 }] }]);
        expect(other.added).toBe(1);
    });

    it('pre-dismisses arrivals matching a standing dismiss rule', () => {
        I.applyOps(db, [{ op: 'saveRule', rule: { accountId: 'acct-1', match: 'AUTOPAY CHASE VISA', action: 'dismiss' } }]);
        add([{ fp: 'x', label: 'AUTOPAY CHASE VISA 4821', amount: 900 }]);
        expect(db.imports.items[0].status).toBe('dismissed');
        expect(db.imports.items[0].auto).toBe(true);
    });

    it('patches whitelisted keys only, null deletes, un-dismiss clears auto', () => {
        add([{ fp: 'x', label: 'A', amount: 1 }]);
        const id = db.imports.items[0].id;
        I.applyOps(db, [{ op: 'patchItem', id, set: { status: 'dismissed', fieldId: 'f1', monthKey: '2026-10', action: 'published', label: 'HACKED' } }]);
        const item = db.imports.items[0];
        expect(item.label).toBe('A'); // the bank's line is the ledger - not patchable
        expect(item.fieldId).toBe('f1');
        db.imports.items[0].auto = true;
        I.applyOps(db, [{ op: 'patchItem', id, set: { status: 'pending', fieldId: null, action: null } }]);
        expect(item.status).toBe('pending');
        expect(item.auto).toBeUndefined();
        expect('fieldId' in item).toBe(false);
    });

    it('upserts accounts and rules (rules keyed by account + match)', () => {
        I.applyOps(db, [{ op: 'saveAccount', account: { label: 'Visa', groupId: 'g-biz' } }]);
        expect(db.imports.accounts).toHaveLength(2);
        const acct = db.imports.accounts[1];
        I.applyOps(db, [{ op: 'saveAccount', account: { id: acct.id, label: 'Visa Card', groupId: 'g-exp' } }]);
        expect(db.imports.accounts).toHaveLength(2);
        expect(db.imports.accounts[1]).toMatchObject({ label: 'Visa Card', groupId: 'g-exp' });

        // the card flag persists and survives a rename that omits it
        I.applyOps(db, [{ op: 'saveAccount', account: { id: acct.id, label: 'Visa Card', groupId: 'g-exp', credit: true } }]);
        expect(db.imports.accounts[1].credit).toBe(true);
        I.applyOps(db, [{ op: 'saveAccount', account: { id: acct.id, label: 'My Visa', groupId: 'g-exp' } }]);
        expect(db.imports.accounts[1]).toMatchObject({ label: 'My Visa', credit: true });

        const rule = { accountId: 'acct-1', match: 'DUKE ENERGY', action: 'merge', groupId: 'g-exp', target: 'Electric' };
        I.applyOps(db, [{ op: 'saveRule', rule }]);
        I.applyOps(db, [{ op: 'saveRule', rule: { ...rule, action: 'publish', target: null } }]);
        expect(db.imports.rules).toHaveLength(1);
        expect(db.imports.rules[0].action).toBe('publish');

        I.applyOps(db, [{ op: 'deleteRule', id: db.imports.rules[0].id }]);
        I.applyOps(db, [{ op: 'deleteAccount', id: acct.id }]);
        expect(db.imports.rules).toHaveLength(0);
        expect(db.imports.accounts).toHaveLength(1);
    });

    it('ensures the blob on older dbs', () => {
        delete db.imports;
        expect(I.applyOps(db, [])).toMatchObject({ added: 0, skipped: 0 });
        expect(db.imports).toEqual({ accounts: [], rules: [], items: [] });
    });
});

// -------------------------------------------- publish / merge / revert / status

describe('month mutations + derived status', () => {
    let db, month, item;
    beforeEach(() => {
        db = makeDb();
        month = db.months['2026-10'];
        I.applyOps(db, [{ op: 'addItems', accountId: 'acct-1', items: [{ fp: 'x', date: '2026-10-03', label: 'DUKE ENERGY PMT', amount: 143.27 }] }]);
        item = db.imports.items[0];
    });

    it('publish creates an accounted, backlinked expense row; status derives', () => {
        expect(I.effectiveStatus(db, item)).toBe('pending');
        const f = I.publish(month, item, { groupId: 'g-biz', label: 'Duke Energy · 10/3', amount: 143.27 });
        I.applyOps(db, [{ op: 'patchItem', id: item.id, set: { monthKey: '2026-10', fieldId: f.id, action: 'published' } }]);
        const g = month.groups.find((g) => g.groupId === 'g-biz');
        expect(g.fields).toHaveLength(1);
        expect(f).toMatchObject({ label: 'Duke Energy · 10/3', value: 143.27, accounted: true, importId: item.id });
        expect(I.effectiveStatus(db, item)).toBe('published');
        expect(I.pendingCount(db)).toBe(0);
        // deleting the row by hand returns the item to the drafts, by derivation
        g.fields = [];
        expect(I.effectiveStatus(db, item)).toBe('pending');
    });

    it('merge fills an existing row, keeps its label, and reverts cleanly', () => {
        const prev = I.mergeInto(month, item, 'f-elec', { amount: 143.27 });
        expect(prev).toEqual({ value: 140, accounted: false });
        I.applyOps(db, [{ op: 'patchItem', id: item.id, set: { monthKey: '2026-10', fieldId: 'f-elec', action: 'merged', prev } }]);
        const f = E.findField(month, 'f-elec');
        expect(f).toMatchObject({ label: 'Electric', value: 143.27, accounted: true, importId: item.id });
        expect(I.effectiveStatus(db, item)).toBe('merged');

        expect(I.revert(month, item)).toBe(true);
        expect(f).toMatchObject({ label: 'Electric', value: 140, accounted: false });
        expect(f.importId).toBeUndefined();
        expect(I.effectiveStatus(db, item)).toBe('pending');
    });

    it('revert removes a published row', () => {
        const f = I.publish(month, item, { groupId: 'g-exp', label: 'Duke', amount: 143.27 });
        I.applyOps(db, [{ op: 'patchItem', id: item.id, set: { monthKey: '2026-10', fieldId: f.id, action: 'published' } }]);
        expect(I.revert(month, item)).toBe(true);
        expect(month.groups.find((g) => g.groupId === 'g-exp').fields.map((x) => x.id)).toEqual(['f-elec', 'f-rent']);
    });

    it('publish falls back to the first expense group for unknown group ids', () => {
        const f = I.publish(month, item, { groupId: 'g-gone', label: 'X', amount: 1 });
        expect(E.groupOfField(month, f.id).groupId).toBe('g-exp');
    });

    it('a credit publishes into an income group as a positive income row', () => {
        const credit = { ...item, amount: -2000 };
        const f = I.publish(month, credit, { groupId: 'g-inc', label: 'Payroll · 10/3', amount: -2000 });
        const g = E.groupOfField(month, f.id);
        expect(g.groupId).toBe('g-inc');
        expect(f).toMatchObject({ value: 2000, accounted: true, importId: item.id });
    });

    it('merging a credit into an income row flips the sign; revert restores', () => {
        const inc = month.groups.find((g) => g.groupId === 'g-inc');
        inc.fields.push({ id: 'f-pay', label: 'Paycheck', value: 3000, pinned: true, accounted: false, tags: [] });
        const prev = I.mergeInto(month, item, 'f-pay', { amount: -3123.45 });
        expect(prev).toEqual({ value: 3000, accounted: false });
        const f = E.findField(month, 'f-pay');
        expect(f).toMatchObject({ value: 3123.45, accounted: true, importId: item.id });
        I.applyOps(db, [{ op: 'patchItem', id: item.id, set: { monthKey: '2026-10', fieldId: 'f-pay', action: 'merged', prev } }]);
        expect(I.revert(month, db.imports.items[0])).toBe(true);
        expect(f).toMatchObject({ value: 3000, accounted: false });
    });

    it('rollover drops importId from carried rows', () => {
        const f = I.publish(month, item, { groupId: 'g-exp', label: 'Carried', amount: 10 });
        f.pinned = true;
        const next = E.rollover(month, db.settings);
        const nf = E.findField(next, f.id);
        expect(nf).toBeTruthy();
        expect(nf.importId).toBeUndefined();
    });
});

describe('suggestTarget', () => {
    let db, month;
    beforeEach(() => { db = makeDb(); month = db.months['2026-10']; });

    it('prefers name overlap over amount proximity', () => {
        const hit = I.suggestTarget(month, 'g-exp', { label: 'DUKE ELECTRIC CO', amount: 90 });
        expect(hit.id).toBe('f-elec');
    });

    it('falls back to amount within 30%', () => {
        const hit = I.suggestTarget(month, 'g-exp', { label: 'ZZZ UTILITY', amount: 150 });
        expect(hit.id).toBe('f-elec');
        expect(I.suggestTarget(month, 'g-exp', { label: 'ZZZ UTILITY', amount: 500 })).toBe(null);
    });

    it('skips import-filled rows and taken ids', () => {
        E.findField(month, 'f-elec').importId = 'other';
        expect(I.suggestTarget(month, 'g-exp', { label: 'ELECTRIC', amount: 140 })).toBe(null);
        delete E.findField(month, 'f-elec').importId;
        expect(I.suggestTarget(month, 'g-exp', { label: 'ELECTRIC', amount: 140 }, new Set(['f-elec']))).toBe(null);
    });
});

describe('homeMonthKey + month-scoped pendingCount', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.months['2026-09'] = { key: '2026-09', status: 'closed', groups: [] };
        I.applyOps(db, [{ op: 'addItems', accountId: 'acct-1', items: [
            { fp: 'a', date: '2026-10-05', label: 'OCT THING', amount: 1 },
            { fp: 'b', date: '2026-09-28', label: 'SEP THING', amount: 2 },
            { fp: 'c', date: '2026-08-01', label: 'ANCIENT', amount: 3 },   // before the books
            { fp: 'd', date: '2026-11-02', label: 'POST-DATED', amount: 4 }, // after the latest month
            { fp: 'e', date: null, dateRaw: 'huh', label: 'NO DATE', amount: 5 },
        ] }]);
    });

    const home = (fp) => I.homeMonthKey(db, db.imports.items.find((i) => i.fp === fp));

    it('homes by transaction date, clamped to existing months', () => {
        expect(home('a')).toBe('2026-10');
        expect(home('b')).toBe('2026-09');
        expect(home('c')).toBe('2026-09'); // older than the books → earliest
        expect(home('d')).toBe('2026-10'); // post-dated → latest
        // no parseable date → the month it was imported (added is "now")
        expect(home('e')).toBe(new Date().toISOString().slice(0, 7));
    });

    it('pendingCount scopes by home month when a key is given', () => {
        expect(I.pendingCount(db)).toBe(5);
        expect(I.pendingCount(db, '2026-09')).toBe(2); // sep + clamped ancient
        expect(I.pendingCount(db, '2026-10') >= 2).toBe(true); // oct + post-dated (+ e if this month)
        I.applyOps(db, [{ op: 'patchItem', id: db.imports.items[1].id, set: { status: 'dismissed' } }]);
        expect(I.pendingCount(db, '2026-09')).toBe(1);
    });
});

describe('rules lookup', () => {
    it('matches on the normalized merchant per account', () => {
        const db = makeDb();
        I.applyOps(db, [{ op: 'saveRule', rule: { accountId: 'acct-1', match: I.normalizeMerchant('SQ *COFFEE 0423'), action: 'publish', groupId: 'g-exp' } }]);
        expect(I.findRule(db.imports, 'acct-1', 'SQ *COFFEE 9981')).toBeTruthy();
        expect(I.findRule(db.imports, 'acct-2', 'SQ *COFFEE 9981')).toBe(null);
        expect(I.findRule(db.imports, 'acct-1', 'OTHER SHOP')).toBe(null);
    });
});
