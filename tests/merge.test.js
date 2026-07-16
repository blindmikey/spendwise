import { describe, it, expect } from 'vitest';
import '../src/shared/engine.js';

const E = globalThis.FinEngine;

// Base month shared by both sessions; "mine" and "theirs" diverge from it.
function baseMonth () {
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
                    { id: 'f-side', label: 'Side gig', value: 500, pinned: false, accounted: false, tags: ['gig'] },
                ],
            },
            {
                groupId: 'g-env', title: 'Budgeted', kind: 'envelope',
                fields: [
                    { id: 'f-groc', label: 'Grocery', value: 500, avail: 500, spent: 0, pinned: true, accounted: false, tags: [] },
                ],
            },
            {
                groupId: 'g-exp', title: 'Expenses', kind: 'expense',
                fields: [
                    { id: 'f-rent', label: 'Rent', value: 800, pinned: true, accounted: false, tags: ['housing'], budgetId: null },
                    { id: 'f-food', label: 'Groceries run', value: 120, pinned: false, accounted: false, tags: [], budgetId: 'f-groc' },
                ],
            },
        ],
    };
}

const field = (m, id) => E.findField(m, id);

describe('mergeMonth', () => {
    it('merges non-overlapping edits from both sides with no conflicts', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-pay').value = 2100;        // I edited income
        field(theirs, 'f-rent').label = 'Rent (new lease)'; // they edited an expense

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(conflicts).toEqual([]);
        expect(field(month, 'f-pay').value).toBe(2100);
        expect(field(month, 'f-rent').label).toBe('Rent (new lease)');
    });

    it('keeps additions from both sides, inserting theirs near their neighbor', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        mine.groups[2].fields.push({ id: 'f-mine-new', label: 'My new expense', value: 40, pinned: false, accounted: false, tags: [], budgetId: null });
        theirs.groups[2].fields.splice(1, 0, { id: 'f-their-new', label: 'Their insert', value: 60, pinned: false, accounted: false, tags: [], budgetId: null });

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(conflicts).toEqual([]);
        const ids = month.groups[2].fields.map((f) => f.id);
        expect(ids).toContain('f-mine-new');
        expect(ids).toContain('f-their-new');
        // theirs inserted after f-rent (its preceding neighbor on their side)
        expect(ids.indexOf('f-their-new')).toBe(ids.indexOf('f-rent') + 1);
    });

    it('honors a deletion of an untouched field', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        theirs.groups[0].fields = theirs.groups[0].fields.filter((f) => f.id !== 'f-side');

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(conflicts).toEqual([]);
        expect(field(month, 'f-side')).toBeNull();
    });

    it('edits beat deletes — theirs deleted what I edited', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-side').value = 750;
        theirs.groups[0].fields = theirs.groups[0].fields.filter((f) => f.id !== 'f-side');

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(field(month, 'f-side').value).toBe(750);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ fieldId: 'f-side', prop: 'removed' });
    });

    it('edits beat deletes — I deleted what theirs edited', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        mine.groups[0].fields = mine.groups[0].fields.filter((f) => f.id !== 'f-side');
        field(theirs, 'f-side').label = 'Side gig (renamed)';

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(field(month, 'f-side').label).toBe('Side gig (renamed)');
        expect(conflicts).toHaveLength(1);
    });

    it('true conflict: both edited the same property — mine wins, conflict recorded', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-rent').value = 850;
        field(theirs, 'f-rent').value = 900;

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(field(month, 'f-rent').value).toBe(850);
        expect(conflicts).toEqual([
            { fieldId: 'f-rent', label: 'Rent', prop: 'value', mine: 850, theirs: 900 },
        ]);
    });

    it('both edited the same property to the same value — no conflict', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-rent').accounted = true;
        field(theirs, 'f-rent').accounted = true;

        const { conflicts } = E.mergeMonth(base, mine, theirs);
        expect(conflicts).toEqual([]);
    });

    it('tags merge as sets: adds and removes from both sides all apply', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-side').tags = ['gig', 'client-a'];          // I added client-a
        field(theirs, 'f-side').tags = ['dog-sitting'];            // they removed gig, added dog-sitting

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(conflicts).toEqual([]);
        expect([...field(month, 'f-side').tags].sort()).toEqual(['client-a', 'dog-sitting']);
    });

    it('theirs linked an expense to an envelope while I edited its amount', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-food').value = 180;
        field(theirs, 'f-food').budgetId = null; // they unlinked it

        const { month, conflicts } = E.mergeMonth(base, mine, theirs);
        expect(conflicts).toEqual([]);
        expect(field(month, 'f-food').value).toBe(180);
        expect(field(month, 'f-food').budgetId).toBeNull();
    });

    it('keeps groups only theirs knows about', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        theirs.groups.push({ groupId: 'g-new', title: 'Rental', kind: 'expense', fields: [] });

        const { month } = E.mergeMonth(base, mine, theirs);
        expect(month.groups.some((g) => g.groupId === 'g-new')).toBe(true);
    });

    it('survives a missing base (falls back to theirs as baseline; mine wins)', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        field(mine, 'f-pay').value = 2222;
        field(theirs, 'f-pay').value = 1111;

        const { month } = E.mergeMonth(null, mine, theirs);
        expect(field(month, 'f-pay').value).toBe(2222);
    });

    it('month scalars: theirs closed-out metadata carries when mine is idle', () => {
        const base = baseMonth();
        const mine = E.clone(base);
        const theirs = E.clone(base);
        theirs.startingSavings = 1500; // e.g. upstream recompute landed there

        const { month } = E.mergeMonth(base, mine, theirs);
        expect(month.startingSavings).toBe(1500);
    });
});
