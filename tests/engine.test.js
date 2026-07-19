import { describe, it, expect, beforeEach } from 'vitest';
import '../src/shared/engine.js';

const E = globalThis.FinEngine;

// ---------------------------------------------------------------- fixtures

function makeSettings ({ strict = false } = {}) {
    return {
        currency: 'USD',
        groups: [
            { id: 'g-inc', title: 'Income', kind: 'income', order: 0 },
            { id: 'g-env', title: 'Budgeted', kind: 'envelope', order: 1, strictOverspend: strict },
            { id: 'g-goal', title: 'Goals', kind: 'goal', order: 2, strictOverspend: false },
            { id: 'g-exp', title: 'Expenses', kind: 'expense', order: 3 },
        ],
    };
}

function makeMonth (key = '2026-06') {
    return {
        key,
        status: 'open',
        startingSavings: 1000,
        closingSavings: null,
        groups: [
            {
                groupId: 'g-inc', title: 'Income', kind: 'income',
                fields: [
                    { id: 'f-pay', label: 'Paycheck', value: 2000, pinned: true, accounted: false, tags: [] },
                    { id: 'f-side', label: 'Side gig', value: 500, pinned: false, accounted: false, tags: [] },
                ],
            },
            {
                groupId: 'g-env', title: 'Budgeted', kind: 'envelope',
                fields: [
                    { id: 'f-groc', label: 'Grocery', value: 500, avail: 500, spent: 0, pinned: true, accounted: false, tags: [] },
                ],
            },
            {
                groupId: 'g-goal', title: 'Goals', kind: 'goal',
                fields: [
                    { id: 'f-garb', label: 'Garbage', value: 50, avail: 100, spent: 0, target: 150, pinned: true, accounted: false, tags: [] },
                ],
            },
            {
                groupId: 'g-exp', title: 'Expenses', kind: 'expense',
                fields: [
                    { id: 'f-rent', label: 'Rent', value: 800, pinned: true, accounted: false, tags: ['housing'], budgetId: null },
                    { id: 'f-food', label: 'Groceries run', value: 120, pinned: false, accounted: false, tags: ['food'], budgetId: 'f-groc' },
                ],
            },
        ],
    };
}

let settings, month;
beforeEach(() => { settings = makeSettings(); month = makeMonth(); });

// ------------------------------------------------------------------ totals

describe('totals', () => {
    it('income group sums all values', () => {
        expect(E.groupTotal(month, month.groups[0])).toBe(2500);
    });

    it('expense group excludes budget-linked fields', () => {
        expect(E.groupTotal(month, month.groups[3])).toBe(800);
    });

    it('linked expenses count toward envelope effective spent', () => {
        const groc = E.findField(month, 'f-groc');
        expect(E.effectiveSpent(month, groc)).toBe(120);
    });

    it('envelope group total is allotment only while within budget', () => {
        expect(E.groupTotal(month, month.groups[1])).toBe(500);
    });

    // cents are allowed in income/expense amounts, but a group total never
    // shows them and always rounds AGAINST the month: income down, spending up
    describe('cents rounding', () => {
        it('income group total rounds DOWN', () => {
            month.groups[0].fields = [
                { id: 'a', label: 'A', value: 100.99, pinned: true, accounted: false, tags: [] },
                { id: 'b', label: 'B', value: 0.5, pinned: true, accounted: false, tags: [] },
            ];
            expect(E.groupTotal(month, month.groups[0])).toBe(101); // 101.49 → 101
        });

        it('expense group total rounds UP', () => {
            month.groups[3].fields = [
                { id: 'c', label: 'C', value: 100.01, pinned: true, accounted: false, tags: [], budgetId: null },
                { id: 'd', label: 'D', value: 0.5, pinned: true, accounted: false, tags: [], budgetId: null },
            ];
            expect(E.groupTotal(month, month.groups[3])).toBe(101); // 100.51 → 101
        });

        it('rounds the SUM, not each field', () => {
            month.groups[0].fields = Array.from({ length: 3 }, (_, i) => (
                { id: 'x' + i, label: 'x', value: 0.4, pinned: true, accounted: false, tags: [] }
            ));
            // 1.20 total → 1. Flooring each field first would give 0.
            expect(E.groupTotal(month, month.groups[0])).toBe(1);
        });

        it('whole-dollar amounts are not pushed up by float error', () => {
            // 10.00 + 20.00 sums to 30.000000000000004 in float; a naive ceil
            // would report 31
            month.groups[3].fields = [
                { id: 'e', label: 'E', value: 10.0, pinned: true, accounted: false, tags: [], budgetId: null },
                { id: 'f', label: 'F', value: 20.0, pinned: true, accounted: false, tags: [], budgetId: null },
            ];
            expect(E.groupTotal(month, month.groups[3])).toBe(30);
        });

        it('0.1 + 0.2 does not leak float error into an income total', () => {
            month.groups[0].fields = [
                { id: 'g', label: 'G', value: 0.1, pinned: true, accounted: false, tags: [] },
                { id: 'h', label: 'H', value: 0.2, pinned: true, accounted: false, tags: [] },
            ];
            expect(E.groupTotal(month, month.groups[0])).toBe(0);
        });

        it('envelope overage from a fractional linked expense rounds UP', () => {
            const groc = E.findField(month, 'f-groc');
            groc.avail = 100;
            month.groups[3].fields = [
                { id: 'i', label: 'I', value: 100.25, pinned: true, accounted: false, tags: [], budgetId: 'f-groc' },
            ];
            // 0.25 over → the envelope group carries allotment 500 + 0.25 → 501
            expect(E.groupTotal(month, month.groups[1])).toBe(501);
        });

        it('month net and savings stay whole', () => {
            month.groups[0].fields = [{ id: 'j', label: 'J', value: 1000.75, pinned: true, accounted: false, tags: [] }];
            month.groups[3].fields = [{ id: 'k', label: 'K', value: 100.25, pinned: true, accounted: false, tags: [], budgetId: null }];
            const net = E.monthNet(month);
            expect(Number.isInteger(net)).toBe(true);
            expect(Number.isInteger(E.savings(month))).toBe(true);
            // income 1000.75 → 1000; expenses 100.25 → 101; envelopes 500 + goal 50
            expect(net).toBe(1000 - 101 - 500 - 50);
        });

        it('unspent envelope money rounds DOWN and stays whole', () => {
            const groc = E.findField(month, 'f-groc');
            groc.avail = 500;
            month.groups[3].fields = [
                { id: 'l', label: 'L', value: 10.75, pinned: true, accounted: false, tags: [], budgetId: 'f-groc' },
            ];
            // groceries: 500 − 10.75 = 489.25 → 489, plus the goal's 100 avail
            expect(E.unspentBudgets(month)).toBe(589);
            expect(Number.isInteger(E.savingsWithBudgets(month))).toBe(true);
        });
    });

    it('envelope overage counts once, in the month it happens', () => {
        const groc = E.findField(month, 'f-groc');
        groc.spent = 600; // 600 manual + 120 linked = 720 vs 500 avail → 220 over
        expect(E.overage(month, groc)).toBe(220);
        expect(E.groupTotal(month, month.groups[1])).toBe(720); // 500 + 220
    });

    it('month net and savings', () => {
        // 2500 income − 500 env − 50 goal − 800 expenses = 1150
        expect(E.monthNet(month)).toBe(1150);
        expect(E.savings(month)).toBe(2150);
    });

    it('savings with unspent budgets adds remaining envelope balances', () => {
        // grocery: 500 − 120 = 380; garbage goal: 100 − 0 = 100
        expect(E.unspentBudgets(month)).toBe(480);
        expect(E.savingsWithBudgets(month)).toBe(2150 + 480);
    });

    it('treats junk values as zero', () => {
        month.groups[0].fields[0].value = 'abc';
        expect(E.groupTotal(month, month.groups[0])).toBe(500);
    });
});

// ---------------------------------------------------------------- rollover

describe('rollover', () => {
    it('carries only pinned fields, clears accounted', () => {
        month.groups[0].fields[0].accounted = true;
        const next = E.rollover(month, settings);
        const inc = next.groups.find((g) => g.groupId === 'g-inc');
        expect(inc.fields.map((f) => f.id)).toEqual(['f-pay']);
        expect(inc.fields[0].accounted).toBe(false);
    });

    it('field ids are preserved across months (cross-month identity)', () => {
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc')).toBeTruthy();
    });

    it('surplus carries: avail = value + remain', () => {
        // grocery: avail 500, effective spent 120 → remain 380 → next avail 880
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc').avail).toBe(880);
        expect(E.findField(next, 'f-groc').spent).toBe(0);
    });

    it('default mode: overspend does NOT penalize next month', () => {
        E.findField(month, 'f-groc').spent = 700; // 820 effective vs 500 avail
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc').avail).toBe(500); // just the allotment
    });

    it('strict mode: overspend applies the legacy one-time penalty, clamped at 0', () => {
        settings = makeSettings({ strict: true });
        const groc = E.findField(month, 'f-groc');
        groc.spent = 700; // remain = 500 − 820 = −320 → 500 − 320 = 180
        let next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc').avail).toBe(180);

        groc.spent = 1200; // remain = −820 → clamp at 0
        next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc').avail).toBe(0);
    });

    it('startingSavings of next month = computed savings of closing month', () => {
        const next = E.rollover(month, settings);
        expect(next.startingSavings).toBe(E.savings(month));
    });

    it('drops budget links whose envelope did not carry over', () => {
        // a budget leaves by being deleted (or its group removed from
        // settings) - never by being unpinned, which the UI doesn't offer
        month.groups[1].fields = [];
        const exp = month.groups[3].fields[0];
        exp.budgetId = 'f-groc';
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-rent').budgetId).toBeNull();
    });

    it('budgets carry forward even if stored unpinned (legacy imports)', () => {
        E.findField(month, 'f-groc').pinned = false;
        E.findField(month, 'f-garb').pinned = false;
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc')).toBeTruthy();
        expect(E.findField(next, 'f-garb')).toBeTruthy();
        // an unpinned income line still drops - the rule is budgets-only
        expect(E.findField(next, 'f-side')).toBeFalsy();
    });

    it('materializes groups added to settings since last month', () => {
        settings.groups.push({ id: 'g-se', title: 'SE Income', kind: 'income', order: 4 });
        const next = E.rollover(month, settings);
        expect(next.groups.some((g) => g.groupId === 'g-se')).toBe(true);
    });
});

// -------------------------------------------------------------- carry-over

describe('close-time carry-over', () => {
    function closeWithCarry (ids) {
        const carried = E.carryOverExtract(month, ids);
        const next = E.rollover(month, settings);
        E.carryOverRestore(next, carried);
        return { carried, next };
    }

    it('zeroes the row in the closing month, keeping it in history', () => {
        E.carryOverExtract(month, ['f-side']);
        const side = E.findField(month, 'f-side');
        expect(side.value).toBe(0);
        expect(side.accounted).toBe(false);
    });

    it('pinned row: the rolled copy gets its value back, unaccounted', () => {
        const { next } = closeWithCarry(['f-pay']);
        expect(E.findField(month, 'f-pay').value).toBe(0);
        const pay = E.findField(next, 'f-pay');
        expect(pay.value).toBe(2000);
        expect(pay.pinned).toBe(true);
        expect(pay.accounted).toBe(false);
    });

    it('unpinned row: re-inserted into its group with tags and budget link', () => {
        const { next } = closeWithCarry(['f-side', 'f-food']);
        const side = E.findField(next, 'f-side');
        expect(side).toMatchObject({ value: 500, pinned: false, accounted: false });
        const food = E.findField(next, 'f-food');
        expect(food).toMatchObject({ value: 120, tags: ['food'], budgetId: 'f-groc' });
        expect(E.groupOfField(next, 'f-food').groupId).toBe('g-exp');
    });

    it('carried value does not count in the closing month but moves whole to the next', () => {
        const before = E.savings(month);
        const { next } = closeWithCarry(['f-side']); // income 500 that never arrived
        expect(E.savings(month)).toBe(before - 500);
        expect(next.startingSavings).toBe(E.savings(month));
        expect(E.findField(next, 'f-side').value).toBe(500);
    });

    it('a carried linked expense leaves the envelope unspent this month', () => {
        // f-food (120) is linked to f-groc: carrying it means nothing was
        // spent from the envelope, so the full allotment rolls forward
        const { next } = closeWithCarry(['f-food']);
        expect(E.findField(next, 'f-groc').avail).toBe(1000); // 500 + 500 remain
    });

    it('ignores accounted rows, envelope rows, and unknown ids', () => {
        E.findField(month, 'f-pay').accounted = true;
        const carried = E.carryOverExtract(month, ['f-pay', 'f-groc', 'nope']);
        expect(carried).toEqual([]);
        expect(E.findField(month, 'f-pay').value).toBe(2000);
        expect(E.findField(month, 'f-groc').value).toBe(500);
    });

    it('falls back to a same-kind group when the original was deleted from settings', () => {
        settings.groups = settings.groups.filter((g) => g.id !== 'g-inc');
        settings.groups.push({ id: 'g-inc2', title: 'Other income', kind: 'income', order: 9 });
        const { next } = closeWithCarry(['f-side']);
        expect(E.groupOfField(next, 'f-side').groupId).toBe('g-inc2');
    });
});

// ------------------------------------------------------------------- goals

describe('goal envelopes (capped budgets)', () => {
    it('reports FUNDING progress toward the target', () => {
        const garb = E.findField(month, 'f-garb');
        expect(E.goalProgress(month, garb)).toEqual({ pct: 67, reached: false });
        garb.avail = 150;
        expect(E.goalProgress(month, garb)).toEqual({ pct: 100, reached: true });
    });

    it('spending does NOT visually wipe funding progress (due-month pay stays at 100%)', () => {
        const garb = E.findField(month, 'f-garb');
        garb.avail = 150;
        garb.spent = 150; // paid the bill in the due month
        expect(E.goalProgress(month, garb)).toEqual({ pct: 100, reached: true });
        // ...while the funding math still reacts: contributions resume
        expect(E.contribution(month, garb, 'goal')).toBe(50);
    });

    it('accumulates by the monthly rate while below target', () => {
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-garb').avail).toBe(150); // 100 + 50, capped at 150
    });

    it('contribution shrinks to the remaining headroom near the cap', () => {
        const garb = E.findField(month, 'f-garb');
        garb.avail = 120; // headroom 30 < rate 50
        expect(E.contribution(month, garb, 'goal')).toBe(30);
        expect(E.groupTotal(month, month.groups[2])).toBe(30); // month only pays 30
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-garb').avail).toBe(150); // lands exactly on target
    });

    it('at the cap it contributes nothing and just sits', () => {
        const garb = E.findField(month, 'f-garb');
        garb.avail = 150;
        expect(E.contribution(month, garb, 'goal')).toBe(0);
        expect(E.groupTotal(month, month.groups[2])).toBe(0);
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-garb').avail).toBe(150); // unchanged
    });

    it('spending reopens headroom and contributions resume the same month', () => {
        const garb = E.findField(month, 'f-garb');
        garb.avail = 150;
        garb.spent = 150; // goal fully used (e.g. the bill was paid from it)
        expect(E.contribution(month, garb, 'goal')).toBe(50); // refill resumes
        expect(E.groupTotal(month, month.groups[2])).toBe(50);
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-garb').avail).toBe(50); // 0 remain + 50
    });

    it('overspending a goal splits: the balance depletes, the overflow comes from liquid', () => {
        const garb = E.findField(month, 'f-garb');
        garb.avail = 100;
        garb.spent = 150; // a $150 bill against a $100 balance
        const goalGroup = month.groups.find((g) => g.kind === 'goal');
        // month pays: $50 overflow + $50 contribution (headroom reopened) —
        // the envelope's $100 covered the rest of the bill, counted in the
        // months that saved it
        expect(E.overage(month, garb)).toBe(50);
        expect(E.groupTotal(month, goalGroup)).toBe(100);
        // next month: balance starts depleted, no strict penalty ever
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-garb').avail).toBe(50); // 0 base + 50 contribution
    });

    it('goal groups ignore strictOverspend even if it is set', () => {
        settings.groups.find((g) => g.id === 'g-goal').strictOverspend = true;
        const garb = E.findField(month, 'f-garb');
        garb.avail = 100;
        garb.spent = 400; // deep overspend
        const next = E.rollover(month, settings);
        // strict would clamp toward 0 with a penalty; goals never do
        expect(E.findField(next, 'f-garb').avail).toBe(50);
    });

    it('linked expenses drain goals exactly like budgets', () => {
        const garb = E.findField(month, 'f-garb');
        garb.avail = 150;
        month.groups[3].fields[0].budgetId = 'f-garb'; // rent → garbage (contrived)
        expect(E.effectiveSpent(month, garb)).toBe(800);
        expect(E.overage(month, garb)).toBe(650); // over the balance → counted once
    });

    it('a goal without a target behaves like a plain envelope', () => {
        const garb = E.findField(month, 'f-garb');
        garb.target = null;
        garb.avail = 99999;
        expect(E.contribution(month, garb, 'goal')).toBe(50); // full rate, no cap
    });

    it('envelopes ignore target even if one is set', () => {
        const groc = E.findField(month, 'f-groc');
        groc.target = 10;
        expect(E.contribution(month, groc, 'envelope')).toBe(500);
    });
});

// ------------------------------------------------ scheduled goals (due date)

describe('scheduled goals (due date + frequency)', () => {
    // the user's canonical example: $120 garbage bill due next month, yearly
    function schedField (month, over = {}) {
        const goal = month.groups.find((g) => g.kind === 'goal');
        goal.fields = [{
            id: 'f-sched', label: 'Garbage Bill', value: 60, avail: 60, spent: 0,
            target: 120, dueKey: '2026-07', freqMonths: 12,
            pinned: true, accounted: false, tags: [],
            ...over,
        }];
        return goal.fields[0];
    }

    it('scheduledAmount spreads headroom over the months remaining, rounded up', () => {
        const f = { target: 120, dueKey: '2026-07' };
        expect(E.scheduledAmount('2026-06', f, 0)).toBe(60);    // 2 months left
        expect(E.scheduledAmount('2026-07', f, 60)).toBe(60);   // 1 month left
        expect(E.scheduledAmount('2026-09', { target: 120, dueKey: '2027-08' }, 0)).toBe(10); // 12 months
        expect(E.scheduledAmount('2026-06', { target: 100, dueKey: '2026-08' }, 0)).toBe(34); // ceil(100/3)
    });

    it('past-due one-time goals fund the rest immediately', () => {
        expect(E.scheduledAmount('2026-09', { target: 120, dueKey: '2026-07' }, 20)).toBe(100);
    });

    it('charges the materialized deposit; mid-month spending does not change it', () => {
        const f = schedField(month); // June: deposit 60 already materialized
        const goalGroup = month.groups.find((g) => g.kind === 'goal');
        expect(E.contribution(month, f, 'goal')).toBe(60);
        f.spent = 60; // paid something from it mid-month
        expect(E.contribution(month, f, 'goal')).toBe(60); // unchanged
        expect(E.groupTotal(month, goalGroup)).toBe(60);
    });

    it('rollover materializes the next deposit from remaining headroom', () => {
        schedField(month); // June: 60 in, due July
        const july = E.rollover(month, settings);
        const f = E.findField(july, 'f-sched');
        expect(july.key).toBe('2026-07');
        expect(f.value).toBe(60);   // (120 − 60) over 1 month
        expect(f.avail).toBe(120);  // fully funded on the due month
        expect(f.dueKey).toBe('2026-07'); // due month itself: no advance yet
    });

    it('unspent at the cap: due advances, deposit drops to $0 and it sits', () => {
        const m = makeMonth('2026-07');
        schedField(m, { value: 60, avail: 120 }); // July: funded, not spent
        const august = E.rollover(m, settings);
        const f = E.findField(august, 'f-sched');
        expect(f.dueKey).toBe('2027-07'); // advanced by 12 months
        expect(f.value).toBe(0);          // no headroom → nothing to deposit
        expect(f.avail).toBe(120);        // sits at the cap
    });

    it('paid on the due month: next cycle re-spreads over the new year ($10/mo)', () => {
        const m = makeMonth('2026-07');
        schedField(m, { value: 60, avail: 120, spent: 120 }); // July: paid the $120 bill
        const august = E.rollover(m, settings);
        const f = E.findField(august, 'f-sched');
        expect(f.dueKey).toBe('2027-07');
        expect(f.value).toBe(10);  // ceil(120 / 12)
        expect(f.avail).toBe(10);
    });

    it('one-time goals (freq 0) never advance their due date', () => {
        const m = makeMonth('2026-07');
        schedField(m, { value: 60, avail: 120, freqMonths: 0 });
        const august = E.rollover(m, settings);
        expect(E.findField(august, 'f-sched').dueKey).toBe('2026-07');
    });

    it('recompute re-derives scheduled deposits from the edited chain', () => {
        const june = makeMonth('2026-06');
        schedField(june, { value: 60, avail: 60 });
        june.status = 'closed';
        const july = E.rollover(june, settings);
        const db = {
            meta: { schemaVersion: 1, rev: 0 },
            settings,
            months: { '2026-06': june, '2026-07': july },
            savingsHistory: { '2026-06': 1000, '2026-07': july.startingSavings },
        };
        // user edits June: they had actually spent 20 from the goal
        E.findField(db.months['2026-06'], 'f-sched').spent = 20;
        const { db: out } = E.recomputeForward(db, '2026-06');
        const f = E.findField(out.months['2026-07'], 'f-sched');
        expect(f.value).toBe(80);   // headroom 120−40 over 1 month
        expect(f.avail).toBe(120);  // 40 carried + 80 deposit
    });

    it('months carry their key (defaultData + rollover)', () => {
        const db = E.defaultData('2026-07');
        expect(db.months['2026-07'].key).toBe('2026-07');
        const next = E.rollover(db.months['2026-07'], db.settings);
        expect(next.key).toBe('2026-08');
    });
});

// ---------------------------------------------------------- empty envelope

describe('emptyEnvelope', () => {
    it('returns only the previously-committed balance, with traceability metadata', () => {
        const groc = E.findField(month, 'f-groc');
        groc.avail = 900; // 400 committed earlier + this month's 500 contribution
        const res = E.emptyEnvelope(month, 'f-groc');
        // this month's 500 stops being charged when the field is deleted, so it
        // must not be handed back; linked spending is re-charged via unlinking
        expect(res.remaining).toBe(400);
        expect(res.returned.label).toBe('Returned from budget: Grocery');
        expect(res.returned.value).toBe(400);
        expect(res.returned.tags).toEqual([]); // no auto-tagging
        expect(res.returned.returnedFrom).toBe('f-groc');
        expect(res.returned.returnBase).toBe(400);
        expect(E.findField(month, 'f-groc')).toBeNull();
        expect(E.findField(month, 'f-food').budgetId).toBeNull();
    });

    it('a first-month envelope (nothing committed yet) returns nothing', () => {
        // avail 500 = exactly this month's contribution → deletion just cancels the charge
        const res = E.emptyEnvelope(month, 'f-groc');
        expect(res.remaining).toBe(0);
        expect(res.returned).toBeNull();
    });

    it('direct spending reduces the returnable balance', () => {
        const groc = E.findField(month, 'f-groc');
        groc.avail = 900;
        groc.spent = 150;
        const res = E.emptyEnvelope(month, 'f-groc');
        expect(res.remaining).toBe(250); // 400 committed − 150 spent directly
    });

    it('returning is wealth-neutral: liquid gains exactly the envelope\'s remaining balance', () => {
        const groc = E.findField(month, 'f-groc');
        groc.avail = 900;
        const liquidBefore = E.savings(month);
        const envelopeWealth = 900 - E.effectiveSpent(month, groc); // 780 still in the envelope
        E.emptyEnvelope(month, 'f-groc');
        // money moved pockets — none was created or destroyed
        expect(E.savings(month)).toBe(liquidBefore + envelopeWealth);
    });
});

// ------------------------------------------------- tags across the lifetime

describe('applyTagsAcrossMonths', () => {
    it('adds and removes a tag on every instance of the field, past included', () => {
        const june = makeMonth('2026-06');
        june.status = 'closed';
        const july = E.rollover(june, settings); // Grocery carries with the same id
        const db = { meta: { schemaVersion: 1, rev: 0 }, settings, months: { '2026-06': june, '2026-07': july }, savingsHistory: {} };

        const touched = E.applyTagsAcrossMonths(db, 'f-groc', ['groceries'], null);
        expect(touched).toBe(2);
        expect(E.findField(db.months['2026-06'], 'f-groc').tags).toContain('groceries');
        expect(E.findField(db.months['2026-07'], 'f-groc').tags).toContain('groceries');

        // existing tags elsewhere survive; removal is global too
        E.findField(db.months['2026-06'], 'f-groc').tags.push('household');
        E.applyTagsAcrossMonths(db, 'f-groc', [], 'groceries');
        expect(E.findField(db.months['2026-06'], 'f-groc').tags).toEqual(['household']);
        expect(E.findField(db.months['2026-07'], 'f-groc').tags).toEqual([]);
    });
});

// -------------------------------------------------------- recompute forward

describe('recomputeForward', () => {
    function makeChain () {
        // June (closed) → July (closed) → August (open), built via real rollover
        const june = makeMonth();
        june.status = 'closed';

        const july = E.rollover(june, settings);
        july.status = 'closed';
        E.findField(july, 'f-groc').spent = 200;

        const august = E.rollover(july, settings);

        june.closingSavings = E.savings(june);
        july.closingSavings = E.savings(july);

        return {
            meta: { schemaVersion: 1, rev: 3 },
            settings,
            months: { '2026-06': june, '2026-07': july, '2026-08': august },
            savingsHistory: {
                '2026-06': june.startingSavings,
                '2026-07': july.startingSavings,
                '2026-08': august.startingSavings,
            },
        };
    }

    it('is a no-op on an untouched chain', () => {
        const db = makeChain();
        const { changes } = E.recomputeForward(db, '2026-06');
        expect(changes).toEqual([]);
    });

    it('propagates an edit through savings and envelope chains', () => {
        const db = makeChain();
        // user edits June: paycheck was actually 2200 (+200), grocery spent 300 more
        const june = db.months['2026-06'];
        E.findField(june, 'f-pay').value = 2200;
        E.findField(june, 'f-groc').spent = 300; // eff spent 420, still within 500

        const { db: out, changes } = E.recomputeForward(db, '2026-06');

        // June's own closing savings re-derived
        expect(out.months['2026-06'].closingSavings).toBe(E.savings(out.months['2026-06']));

        // July starting savings +200, grocery avail 500+(500−420)=580 (was 880)
        expect(out.months['2026-07'].startingSavings).toBe(E.savings(out.months['2026-06']));
        expect(E.findField(out.months['2026-07'], 'f-groc').avail).toBe(580);

        // August chains from recomputed July
        expect(out.months['2026-08'].startingSavings).toBe(E.savings(out.months['2026-07']));
        expect(E.findField(out.months['2026-08'], 'f-groc').avail)
            .toBe(500 + (580 - 200)); // value + remain of recomputed July

        // savingsHistory follows
        expect(out.savingsHistory['2026-07']).toBe(out.months['2026-07'].startingSavings);
        expect(out.savingsHistory['2026-08']).toBe(out.months['2026-08'].startingSavings);

        // change summary names each affected month
        expect(changes.map((c) => c.key)).toEqual(['2026-07', '2026-08']);
        expect(changes[0].startingSavings.from + 200).toBe(changes[0].startingSavings.to);
    });

    it("recompute uses each month's own allotment for its balance", () => {
        const db = makeChain();
        // user raised July's grocery allotment after the rollover created it
        E.findField(db.months['2026-07'], 'f-groc').value = 700;
        const { db: out } = E.recomputeForward(db, '2026-06');
        // June remain = 500 − 120 linked = 380; July balance = 380 + its own 700
        expect(E.findField(out.months['2026-07'], 'f-groc').avail).toBe(1080);
    });

    it('never touches user-entered values in later months', () => {
        const db = makeChain();
        E.findField(db.months['2026-07'], 'f-groc').label = 'Grocery (renamed)';
        E.findField(db.months['2026-06'], 'f-pay').value = 9999;

        const { db: out } = E.recomputeForward(db, '2026-06');
        const julyGroc = E.findField(out.months['2026-07'], 'f-groc');
        expect(julyGroc.label).toBe('Grocery (renamed)');
        expect(julyGroc.spent).toBe(200);   // user-entered spent untouched
        expect(julyGroc.value).toBe(500);   // allotment untouched
    });

    it('leaves fields born in later months alone', () => {
        const db = makeChain();
        const julyEnv = db.months['2026-07'].groups.find((g) => g.groupId === 'g-env');
        julyEnv.fields.push({ id: 'f-new', label: 'Vacation', value: 100, avail: 42, spent: 0, pinned: true, accounted: false, tags: [] });
        E.findField(db.months['2026-06'], 'f-pay').value = 3000;

        const { db: out } = E.recomputeForward(db, '2026-06');
        expect(E.findField(out.months['2026-07'], 'f-new').avail).toBe(42);
    });

    it('adjusts "Returned from" income lines when the chain under them changes', () => {
        const db = makeChain();
        const july = db.months['2026-07'];
        // empty Grocery in July: avail 880 = June remain 380 + July's 500 contribution;
        // July has 200 direct spending → return = 380 − 200 = 180, base = 380
        const res = E.emptyEnvelope(july, 'f-groc');
        expect(res.returned.value).toBe(180);
        expect(res.returned.returnBase).toBe(380);

        // edit June: the linked grocery run was only 20, not 120 → remain 480 (+100)
        E.findField(db.months['2026-06'], 'f-food').value = 20;
        const { db: out, changes } = E.recomputeForward(db, '2026-06');

        const rf = E.allFields(out.months['2026-07']).find((f) => f.returnedFrom === 'f-groc');
        expect(rf.value).toBe(280);       // 180 + 100 delta
        expect(rf.returnBase).toBe(480);  // snapshot follows the chain
        // the adjustment is named in the recompute summary
        const julyChange = changes.find((c) => c.key === '2026-07');
        expect(julyChange.envelopes.some((e) => e.id === rf.id && e.from === 180 && e.to === 280)).toBe(true);
        // and flows into the following month's starting savings
        expect(out.months['2026-08'].startingSavings).toBe(E.savings(out.months['2026-07']));
    });

    it('preserves manual edits to a return line as an offset', () => {
        const db = makeChain();
        const july = db.months['2026-07'];
        const res = E.emptyEnvelope(july, 'f-groc');
        const rf = E.allFields(july).find((f) => f.returnedFrom === 'f-groc');
        rf.value = res.returned.value + 25; // user tweaked the line by hand

        E.findField(db.months['2026-06'], 'f-food').value = 20; // +100 to the chain
        const { db: out } = E.recomputeForward(db, '2026-06');
        const rf2 = E.allFields(out.months['2026-07']).find((f) => f.returnedFrom === 'f-groc');
        expect(rf2.value).toBe(180 + 25 + 100); // offset survives, delta applies
    });

    it('does not mutate the input db', () => {
        const db = makeChain();
        const snapshot = JSON.stringify(db);
        E.findField(db.months['2026-06'], 'f-pay').value = 2200;
        const before = JSON.stringify(db);
        E.recomputeForward(db, '2026-06');
        expect(JSON.stringify(db)).toBe(before);
        expect(snapshot).not.toBe(before); // sanity: the edit itself happened
    });
});

// ------------------------------------------------------- auto-funded fields

describe('auto-funded fields', () => {
    // fixture: income 2500, expenses at FACE value 920 (rent 800 + linked food
    // 120 — budget links must not move the rate) → net of both = 1580
    const rule = { pct: 33, groups: ['g-inc', 'g-exp'] };

    it('derives the value from a percentage of source-group net', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = rule;
        expect(E.fieldValue(month, groc)).toBe(Math.round(1580 * 0.33)); // 521
        expect(E.groupTotal(month, month.groups[1])).toBe(521);
    });

    it('assigning a source expense to a budget does not change the rate', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = rule;
        const linked = E.fieldValue(month, groc);   // food is linked to f-groc
        E.findField(month, 'f-food').budgetId = null;
        expect(E.fieldValue(month, groc)).toBe(linked); // unlinked: same rate
    });

    it('inactive/incomplete rules fall back to the stored value', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = { pct: 0, groups: ['g-inc'] };
        expect(E.fieldValue(month, groc)).toBe(500);
        groc.auto = { pct: 33, groups: [] };
        expect(E.fieldValue(month, groc)).toBe(500);
    });

    it('never goes negative when sources net out below zero', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = { pct: 33, groups: ['g-exp'] }; // expenses only → net −920
        expect(E.fieldValue(month, groc)).toBe(0);
    });

    it('applyAutoValues materializes the derived value into storage', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = rule;
        E.applyAutoValues(month);
        expect(groc.value).toBe(521);
    });

    it('rollover contributes the derived value to next month\'s balance', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = rule;
        // avail 500, linked spent 120 → remain 380; contribution 521 → 901
        const next = E.rollover(month, settings);
        expect(E.findField(next, 'f-groc').avail).toBe(901);
        expect(E.findField(next, 'f-groc').auto).toEqual(rule); // rule carries forward
    });

    it('recomputeForward re-derives auto values before chaining', () => {
        const groc = E.findField(month, 'f-groc');
        groc.auto = rule;
        E.applyAutoValues(month);
        month.status = 'closed';
        const next = E.rollover(month, settings);
        const db = {
            meta: { schemaVersion: 1, rev: 0 },
            settings,
            months: { '2026-06': month, '2026-07': next },
            savingsHistory: { '2026-06': 1000, '2026-07': next.startingSavings },
        };
        // edit June income: 2000 → 3000 (+1000) → face net 3500 − 920 = 2580 → auto 851
        E.findField(db.months['2026-06'], 'f-pay').value = 3000;
        const { db: out } = E.recomputeForward(db, '2026-06');
        expect(E.findField(out.months['2026-06'], 'f-groc').value).toBe(Math.round(2580 * 0.33));
        // July's balance = June remain (380) + July's OWN auto rate — derived
        // from July's sources (2000 income − 800 rent = 1200 → 396). June's
        // higher rate belongs to June's balance (adjusted live in the UI).
        expect(E.findField(out.months['2026-07'], 'f-groc').avail)
            .toBe(Math.round(1200 * 0.33) + 380);
    });
});

// --------------------------------------------------------------- misc/data

describe('helpers and defaults', () => {
    it('month key math', () => {
        expect(E.nextKey('2026-12')).toBe('2027-01');
        expect(E.prevKey('2026-01')).toBe('2025-12');
        expect(E.keyLabel('2026-07')).toBe('July 2026');
    });

    it('syncMonthWithSettings adds new groups, keeps orphaned non-empty ones', () => {
        settings.groups.push({ id: 'g-se', title: 'SE Income', kind: 'income', order: 4 });
        E.syncMonthWithSettings(month, settings);
        expect(month.groups.some((g) => g.groupId === 'g-se')).toBe(true);

        settings.groups = settings.groups.filter((g) => g.id !== 'g-exp');
        E.syncMonthWithSettings(month, settings);
        // g-exp instance has fields → preserved
        expect(month.groups.some((g) => g.groupId === 'g-exp')).toBe(true);
    });

    it('defaultData creates a usable first month', () => {
        const db = E.defaultData('2026-07');
        expect(db.months['2026-07'].groups.length).toBe(4);
        expect(db.months['2026-07'].status).toBe('open');
        expect(db.meta.rev).toBe(0);
    });

    it('new fields get uuid ids', () => {
        const f = E.newField('expense');
        expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(f.budgetId).toBeNull();
    });
});
