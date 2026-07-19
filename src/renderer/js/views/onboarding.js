/* global Alpine, FinEngine, showToast, unwrap */
'use strict';

/**
 * First-run onboarding: a fresh database (one empty month, nothing configured)
 * gets a short wizard - current savings, how money comes in, and optionally an
 * auto-funded self-employment tax envelope - instead of a blank screen.
 *
 * Everything it writes goes through the same saveSettings/saveMonth APIs the
 * Settings view uses, so it works identically on desktop and web. Completing
 * OR skipping stamps settings.onboarded into the db - the wizard is about the
 * DATA being set up, so the flag travels with db.json, and a database that
 * already has fields (e.g. adopted from a synced folder) never triggers it.
 */

/** A database that has never been touched: one month, no fields, no history. */
function isFreshDb (data) {
    const keys = FinEngine.monthKeys(data);
    return keys.length === 1
        && data.months[keys[0]].groups.every((g) => g.fields.length === 0)
        && !data.settings.onboarded
        && FinEngine.num(data.settings.initialSavings) === 0;
}

function onboardingView () {
    // [title, kind, starterLabels?] per situation; Tax Savings is appended when
    // taxes are on. The SE auto-rule nets "Self-Employment Income" minus
    // "Business Expenses". Starter labels become pinned $0 rows - visible,
    // renameable structure instead of empty groups, and pinning makes them
    // recur month to month like the real income/bills they stand in for.
    const GROUPS = {
        employed: [
            ['Income', 'income', ['Paycheck']],
            ['Envelope Budgets', 'envelope'], ['Goal Budgets', 'goal'],
            ['Expenses', 'expense', ['Rent / mortgage']],
        ],
        self: [
            ['Self-Employment Income', 'income', ['Client work']],
            ['Envelope Budgets', 'envelope'], ['Goal Budgets', 'goal'],
            ['Expenses', 'expense', ['Rent / mortgage']], ['Business Expenses', 'expense'],
        ],
        mixed: [
            ['Income', 'income', ['Paycheck']],
            ['Self-Employment Income', 'income', ['Client work']],
            ['Envelope Budgets', 'envelope'], ['Goal Budgets', 'goal'],
            ['Expenses', 'expense', ['Rent / mortgage']], ['Business Expenses', 'expense'],
        ],
        dual: [
            ['Income', 'income', ['Paycheck - person 1', 'Paycheck - person 2']],
            ['Envelope Budgets', 'envelope'], ['Goal Budgets', 'goal'],
            ['Expenses', 'expense', ['Rent / mortgage']],
        ],
    };

    return {
        step: 1,
        savingsNow: null,
        situation: 'employed',
        taxWanted: true,
        taxPct: 33,
        busy: false,

        SITUATIONS: [
            ['employed', 'Employed', 'Paychecks from an employer'],
            ['self', 'Self-employed', 'Freelance or business income'],
            ['mixed', 'Household - one of each', 'One employed, one self-employed'],
            ['dual', 'Household - both employed', 'Two employment incomes'],
        ],

        get db () { return Alpine.store('data').db; },
        get ui () { return Alpine.store('ui'); },
        get isWeb () { return !!window.IS_WEB; },
        get hasSE () { return this.situation === 'self' || this.situation === 'mixed'; },
        get stepCount () { return this.hasSE ? 3 : 2; },

        next () {
            if (this.step === 1) { this.step = 2; return; }
            if (this.step === 2 && this.hasSE) { this.step = 3; return; }
            this.finish();
        },
        back () { if (this.step > 1) this.step -= 1; },

        /** Re-point the UI after the whole db changed under it. */
        _adopt (data) {
            const keys = FinEngine.monthKeys(data);
            const open = keys.filter((k) => data.months[k].status === 'open');
            this.ui.currentKey = open.length ? open[open.length - 1] : keys[keys.length - 1];
            this.ui.unlockedKeys = [];
            this.ui.savedSnapshot = JSON.stringify(data.months[this.ui.currentKey]);
        },

        async finish () {
            if (this.busy) return;
            this.busy = true;
            try {
                const settings = FinEngine.clone(this.db.settings);
                settings.initialSavings = FinEngine.num(this.savingsNow);
                const plan = GROUPS[this.situation];
                const defs = plan.map(([title, kind], i) => {
                    const g = { id: FinEngine.uuid(), title, kind, order: i };
                    if (kind === 'envelope' || kind === 'goal') g.strictOverspend = false;
                    return g;
                });
                const withTax = this.hasSE && this.taxWanted && FinEngine.num(this.taxPct) > 0;
                let taxGroupId = null;
                if (withTax) {
                    taxGroupId = FinEngine.uuid();
                    defs.push({ id: taxGroupId, title: 'Tax Savings', kind: 'envelope', order: defs.length, strictOverspend: false });
                }
                settings.groups = defs;
                settings.onboarded = true;

                const res = unwrap(await window.api.saveSettings({ settings, expectedRev: this.db.meta.rev }));
                Alpine.store('data').db = res.data;

                // populate the month: starter rows per the plan, plus the
                // auto-funded tax envelope when wanted
                const key = FinEngine.monthKeys(res.data)[0];
                const month = FinEngine.clone(res.data.months[key]);
                plan.forEach(([title, kind, labels], i) => {
                    if (!labels) return;
                    const g = month.groups.find((mg) => mg.groupId === defs[i].id);
                    for (const label of labels) {
                        const f = FinEngine.newField(kind);
                        f.label = label;
                        f.pinned = true; // placeholders stand in for recurring rows - they carry forward
                        g.fields.push(f);
                    }
                });
                if (withTax) {
                    const srcIds = defs.filter((d) => d.title === 'Self-Employment Income' || d.title === 'Business Expenses')
                        .map((d) => d.id);
                    const f = FinEngine.newField(FinEngine.KIND.ENVELOPE);
                    f.label = 'Self-employment tax';
                    f.auto = { pct: FinEngine.num(this.taxPct), groups: srcIds };
                    month.groups.find((g) => g.groupId === taxGroupId).fields.push(f);
                }
                const saved = unwrap(await window.api.saveMonth({ key, month, base: null, expectedRev: res.data.meta.rev }));
                // the non-merge path returns just { rev } - apply locally
                if (saved.data) {
                    Alpine.store('data').db = saved.data;
                } else {
                    const db = Alpine.store('data').db;
                    db.months[key] = month;
                    db.meta.rev = saved.rev;
                }

                this._adopt(Alpine.store('data').db);
                this.ui.onboarding = false;
                showToast('You’re set - reshape any of this later in Settings', 'success', 6000);
            } catch (e) {
                showToast(e.message, 'error', 9000);
            }
            this.busy = false;
        },

        /** "I'll set things up myself" - just remember not to ask again. */
        async skip () {
            if (this.busy) return;
            this.busy = true;
            try {
                const settings = FinEngine.clone(this.db.settings);
                settings.onboarded = true;
                const res = unwrap(await window.api.saveSettings({ settings, expectedRev: this.db.meta.rev }));
                Alpine.store('data').db = res.data;
            } catch (e) { /* offline or race - the wizard just re-offers next launch */ }
            this.ui.onboarding = false;
            this.busy = false;
        },

        /**
         * Desktop only: point the app at an existing db.json (synced folder,
         * another machine's export). Adopting a lived-in database ends the
         * wizard; picking another empty file keeps it open for that file.
         */
        async adoptExisting () {
            if (this.busy) return;
            this.busy = true;
            try {
                const res = unwrap(await window.api.changeDbLocation());
                const data = Alpine.store('data');
                data.db = res.data;
                data.path = res.path;
                this._adopt(res.data);
                if (!isFreshDb(res.data)) {
                    this.ui.onboarding = false;
                    showToast(`Database now at ${res.path}`, 'success', 6000);
                }
            } catch (e) { showToast(e.message, 'error', 7000); }
            this.busy = false;
        },
    };
}
