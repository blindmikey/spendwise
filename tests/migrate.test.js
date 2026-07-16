import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importLegacy } from '../src/main/migrate.js';
import '../src/shared/engine.js';

const E = globalThis.FinEngine;

const legacyDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../archive/old-finances-app/data');
const hasLegacyData = fs.existsSync(path.join(legacyDir, 'savings_history'));

describe.skipIf(!hasLegacyData)('importLegacy against the real archive', () => {
    // skipIf still runs this body to collect tests, so the import has to be
    // deferred - beforeAll is skipped with the suite, a bare call is not.
    let data, summary;
    beforeAll(() => { ({ data, summary } = importLegacy(legacyDir)); });

    it('imports the full history', () => {
        expect(summary.months).toBeGreaterThan(80);
        expect(summary.firstMonth).toBe('2018-07');
        expect(E.monthKeys(data)).toContain('2026-01');
    });

    it('seeds initialSavings from the first month', () => {
        expect(data.settings.initialSavings).toBe(E.num(data.months['2018-07'].startingSavings));
    });

    it('maps legacy group types to the right kinds (month snapshots)', () => {
        const jan = data.months['2026-01'];
        const kinds = Object.fromEntries(jan.groups.map((g) => [g.title, g.kind]));
        expect(kinds['Income']).toBe('income');
        expect(kinds['Self-Employment Income']).toBe('income');
        expect(kinds['Budgets']).toBe('envelope');
        expect(kinds['Expenses']).toBe('expense');
        expect(kinds['Self-Employment Expenses']).toBe('expense');
    });

    it('settings adopt only the groups present in the latest month', () => {
        const latest = data.months[E.monthKeys(data).pop()];
        expect(data.settings.groups.map((g) => g.id)).toEqual(latest.groups.map((g) => g.groupId));
        for (const def of data.settings.groups) {
            if (E.isEnvelopeKind(def.kind)) expect(def.strictOverspend).toBe(false);
        }
    });

    it('only the latest month is open, others closed with derived closing savings', () => {
        const keys = E.monthKeys(data);
        const last = keys[keys.length - 1];
        expect(data.months[last].status).toBe('open');
        for (const k of keys.slice(0, -1)) {
            expect(data.months[k].status).toBe('closed');
            expect(data.months[k].closingSavings).toBe(E.savings(data.months[k]));
        }
    });

    it('reproduces January 2026 group totals from the legacy app', () => {
        const legacy = JSON.parse(fs.readFileSync(path.join(legacyDir, 'january-26'), 'utf8')).form;
        const month = data.months['2026-01'];
        expect(E.num(month.startingSavings)).toBe(E.num(legacy.savings));

        for (const legacyGroup of legacy.data) {
            const group = month.groups.find((g) => g.title === legacyGroup.title);
            expect(group, legacyGroup.title).toBeTruthy();
            expect(group.fields.length).toBe(legacyGroup.fields.length);
            // legacy stored each group's computed total — our engine must agree
            // (tolerance: legacy summed with parseInt, truncating cents per field)
            const diff = Math.abs(E.groupTotal(month, group) - E.num(legacyGroup.total));
            expect(diff, `${legacyGroup.title}: off by ${diff}`).toBeLessThan(Math.max(1, group.fields.length));
        }
    });

    it('gives pinned fields a stable uuid across months', () => {
        const dec = data.months['2025-12'];
        const jan = data.months['2026-01'];
        const decIds = new Set(E.allFields(dec).map((f) => f.id));
        const carried = E.allFields(jan).filter((f) => decIds.has(f.id));
        expect(carried.length).toBeGreaterThan(0);
        for (const f of E.allFields(jan)) expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('remaps expense→budget links to the new envelope ids', () => {
        let checked = 0;
        for (const key of E.monthKeys(data)) {
            const month = data.months[key];
            for (const g of month.groups) {
                if (g.kind !== 'expense') continue;
                for (const f of g.fields) {
                    if (!f.budgetId) continue;
                    const target = E.findField(month, f.budgetId);
                    if (target) checked += 1; // link resolves within the same month
                }
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    it('honors kind overrides everywhere a group appears', () => {
        const { data: mapped } = importLegacy(legacyDir, { 'Self-EMployment Tax Savings': 'envelope' });
        const def = mapped.settings.groups.find((g) => g.title === 'Self-EMployment Tax Savings');
        expect(def.kind).toBe('envelope');
        for (const key of E.monthKeys(mapped)) {
            const inst = mapped.months[key].groups.find((g) => g.title === 'Self-EMployment Tax Savings');
            if (inst) expect(inst.kind).toBe('envelope');
        }
    });

    it('imports savings history keyed by YYYY-MM', () => {
        expect(data.savingsHistory['2018-06']).toBe(12387);
        expect(Object.keys(data.savingsHistory).every((k) => /^\d{4}-\d{2}$/.test(k))).toBe(true);
    });
});
