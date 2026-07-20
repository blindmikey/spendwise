/*!
 * FinEngine - pure calculation core for Spend Wise.
 *
 * Loaded three ways, hence the UMD-style wrapper:
 *  - renderer: plain <script src>, reads globalThis.FinEngine
 *  - Electron main (ESM): `import '../shared/engine.js'` then globalThis.FinEngine
 *  - vitest: same as main
 *
 * Everything here is pure: functions either read month/db objects or return
 * new/mutated structures with no I/O, so both the live UI math and the
 * close-out/recompute paths share one implementation.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) { module.exports = factory(); }
    root.FinEngine = factory();
})(globalThis, function () {
    'use strict';

    const KIND = Object.freeze({
        INCOME: 'income',
        EXPENSE: 'expense',
        ENVELOPE: 'envelope',
        GOAL: 'goal',
    });

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const isEnvelopeKind = (kind) => kind === KIND.ENVELOPE || kind === KIND.GOAL;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const truthy = (v) => v === true || v === 1 || v === '1';

    function uuid () {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            return ('' + 1e7 + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
                (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ---------------------------------------------------------------- keys

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    function nextKey (key) {
        let [y, m] = key.split('-').map(Number);
        m += 1; if (m > 12) { m = 1; y += 1; }
        return `${y}-${String(m).padStart(2, '0')}`;
    }

    function prevKey (key) {
        let [y, m] = key.split('-').map(Number);
        m -= 1; if (m < 1) { m = 12; y -= 1; }
        return `${y}-${String(m).padStart(2, '0')}`;
    }

    function keyLabel (key) {
        const [y, m] = key.split('-').map(Number);
        return `${MONTH_NAMES[m - 1] || '?'} ${y}`;
    }

    function monthIndex (key) {
        const [y, m] = String(key).split('-').map(Number);
        return y * 12 + (m - 1);
    }

    function addMonths (key, n) {
        const idx = monthIndex(key) + n;
        return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
    }

    function monthKeys (db) { return Object.keys(db.months || {}).sort(); }

    // ------------------------------------------------------------- lookups

    function allFields (month) {
        const out = [];
        for (const g of month.groups) out.push(...g.fields);
        return out;
    }

    function findField (month, fieldId) {
        for (const g of month.groups) {
            const f = g.fields.find((f) => f.id === fieldId);
            if (f) return f;
        }
        return null;
    }

    function groupOfField (month, fieldId) {
        for (const g of month.groups) {
            if (g.fields.some((f) => f.id === fieldId)) return g;
        }
        return null;
    }

    /**
     * What one linked expense row draws from its envelope: WHOLE dollars -
     * cents round up per row (in cents, so float noise can't bump an exact
     * amount) - a 3.33 grocery run takes 4. Balances stay integral when
     * allotments are, and the rounding goes against the month, as everywhere.
     * Shared with the month view's memoized linked-spend map - one definition,
     * so ledger and display can't disagree.
     */
    function linkedDraw (value) {
        return Math.ceil(cents(value) / 100);
    }

    /** Sum of expense-field draws linked (via budgetId) to an envelope field. */
    function linkedSpent (month, envelopeFieldId) {
        let sum = 0;
        for (const g of month.groups) {
            if (g.kind !== KIND.EXPENSE) continue;
            for (const f of g.fields) {
                if (f.budgetId === envelopeFieldId) sum += linkedDraw(f.value);
            }
        }
        return sum;
    }

    /**
     * The mirror image: an INCOME row linked to a budget deposits its amount
     * straight into that balance instead of liquid savings (a one-off Venmo
     * earmarked for Dining Out). Whole dollars, floored - income never
     * flatters. The row is excluded from the income group's total (see
     * groupTotal), so the month's savings are exactly as if the money had
     * been received and the allotment raised by hand.
     */
    function linkedDeposit (value) {
        return Math.floor(cents(value) / 100);
    }

    function linkedIncome (month, envelopeFieldId) {
        let sum = 0;
        for (const g of month.groups) {
            if (g.kind !== KIND.INCOME) continue;
            for (const f of g.fields) {
                if (f.budgetId === envelopeFieldId) sum += linkedDeposit(f.value);
            }
        }
        return sum;
    }

    /**
     * Manual spent + spending through linked expense rows, MINUS income routed
     * directly in. Deposits ride the same channel as negative spending, so
     * everything downstream - available, overage, rollover, unspent budgets -
     * sees them without special cases.
     */
    function effectiveSpent (month, field) {
        return num(field.spent) + linkedSpent(month, field.id) - linkedIncome(month, field.id);
    }

    /** Spending beyond what the envelope held - counts against this month once. */
    function overage (month, field) {
        return Math.max(0, effectiveSpent(month, field) - num(field.avail));
    }

    // -------------------------------------------- auto-funded contributions

    /** An auto rule is active once it has a percentage and source groups. */
    function hasAuto (field) {
        return !!(field && field.auto && num(field.auto.pct) > 0 && (field.auto.groups || []).length);
    }

    /**
     * Signed net of the rule's source groups (income +, expense −) at FACE
     * value: an expense counts whether or not it is assigned to a budget.
     * Where money is paid from (envelope vs liquid) is a ledger concern -
     * it must not move e.g. a tax-savings percentage, because an expense is
     * still an expense for tax purposes when it draws from an envelope.
     *
     * ONE exception: expenses drawn from the auto-funded envelope ITSELF
     * (selfId). Those are distributions of money the rule already set aside -
     * a quarterly estimated-tax payment out of the tax-savings envelope is
     * not new deductible activity, and counting it would zero the very
     * set-aside that pays it. Excluding only the self-link breaks that
     * feedback loop while leaving every other envelope-drawn expense (a
     * laptop from the office budget) reducing the net as a real expense.
     */
    function autoSourcesNet (month, rule, selfId) {
        let net = 0;
        for (const gid of rule.groups || []) {
            const g = month.groups.find((g) => g.groupId === gid);
            if (!g || isEnvelopeKind(g.kind)) continue; // sources are income/expense groups
            let t = 0;
            for (const f of g.fields) {
                if (g.kind === KIND.EXPENSE && selfId && f.budgetId === selfId) continue;
                t += num(f.value);
            }
            net += (g.kind === KIND.INCOME) ? t : -t;
        }
        return net;
    }

    /**
     * A field's effective monthly amount: auto-funded fields derive it live
     * (e.g. "33% of Self-Employment net"), everything else uses the stored value.
     */
    function fieldValue (month, field) {
        if (hasAuto(field)) {
            return Math.round(Math.max(0, autoSourcesNet(month, field.auto, field.id)) * num(field.auto.pct) / 100);
        }
        return num(field.value);
    }

    /** Materialize auto-funded values into storage (called on save/close/recompute). */
    function applyAutoValues (month) {
        for (const g of month.groups) {
            if (!isEnvelopeKind(g.kind)) continue;
            for (const f of g.fields) {
                if (hasAuto(f)) f.value = fieldValue(month, f);
            }
        }
        return month;
    }

    // -------------------------------------------------------------- totals

    /**
     * The deposit a SCHEDULED goal needs this month: remaining headroom spread
     * evenly (rounded up, so it's never underfunded) across the months left
     * until the due date, inclusive. Past-due or missing dates fund in full.
     */
    function scheduledAmount (monthKey, field, base) {
        const headroom = Math.max(0, num(field.target) - Math.max(0, base));
        if (!field.dueKey || !monthKey) return headroom;
        const monthsLeft = Math.max(1, monthIndex(field.dueKey) - monthIndex(monthKey) + 1);
        return Math.ceil(headroom / monthsLeft);
    }

    /**
     * What this month actually puts into an envelope. Plain envelopes always
     * take the full monthly amount. Goals with a target only fill remaining
     * headroom: at the cap they take nothing and sit until spending (linked
     * expenses) drains the balance, which reopens headroom the same month.
     * SCHEDULED goals (dueKey set) charge their materialized deposit - fixed
     * for the month; paying the goal mid-cycle affects NEXT month's deposit.
     */
    function contribution (month, field, kind) {
        const rate = fieldValue(month, field);
        if (kind !== KIND.GOAL || !(num(field.target) > 0)) return rate;
        if (field.dueKey) return num(field.value);
        const remain = Math.max(0, num(field.avail) - effectiveSpent(month, field));
        return Math.min(rate, Math.max(0, num(field.target) - remain));
    }

    /**
     * Income and expense amounts may carry cents, but a GROUP total never
     * does - and it always rounds against you, so the month is never flattered:
     * income DOWN, spending UP. Sums are accumulated in integer cents first;
     * summing floats and rounding after would let 10.00 + 20.00 land on
     * 30.000000000000004 and ceil to 31.
     */
    const cents = (v) => Math.round(num(v) * 100);

    function groupTotal (month, group) {
        let c = 0;
        if (group.kind === KIND.INCOME) {
            // budget-linked income deposits straight into its envelope - it
            // never lands in liquid, so it can't count here (mirror of the
            // linked-expense exclusion below)
            for (const f of group.fields) { if (!f.budgetId) c += cents(f.value); }
            return Math.floor(c / 100);
        }
        if (group.kind === KIND.EXPENSE) {
            // budget-linked expenses are handled by their envelope, never double-counted
            for (const f of group.fields) { if (!f.budgetId) c += cents(f.value); }
            return Math.ceil(c / 100);
        }
        // envelopes: allotments are whole dollars, but overage comes from linked
        // expense rows and can carry cents - it's spending, so it rounds up too
        for (const f of group.fields) c += cents(contribution(month, f, group.kind)) + cents(overage(month, f));
        return Math.ceil(c / 100);
    }

    function monthNet (month) {
        let net = 0;
        for (const g of month.groups) {
            const t = groupTotal(month, g);
            net += (g.kind === KIND.INCOME) ? t : -t;
        }
        return net;
    }

    function savings (month) { return num(month.startingSavings) + monthNet(month); }

    function unspentBudgets (month) {
        let c = 0;
        for (const g of month.groups) {
            if (!isEnvelopeKind(g.kind)) continue;
            for (const f of g.fields) {
                c += Math.max(0, cents(f.avail) - cents(effectiveSpent(month, f)));
            }
        }
        // money still sitting in envelopes reads like income: round it DOWN so
        // the headline total is never flattered, and never shows cents
        return Math.floor(c / 100);
    }

    function savingsWithBudgets (month) { return savings(month) + unspentBudgets(month); }

    /**
     * FUNDING progress toward the target: how much has been set aside this
     * cycle (avail), deliberately ignoring spending - paying the bill in the
     * due month must not visually wipe the achievement. The next cycle's
     * rollover resets avail, and with it the bar.
     */
    function goalProgress (month, field) {
        const target = num(field.target);
        if (target <= 0) return { pct: 0, reached: false };
        const avail = num(field.avail);
        return { pct: Math.min(100, Math.round(avail / target * 100)), reached: avail >= target };
    }

    // ----------------------------------------------------- month lifecycle

    function strictFor (settings, groupId, fallback = false) {
        const def = (settings.groups || []).find((g) => g.id === groupId);
        if (def && typeof def.strictOverspend === 'boolean') return def.strictOverspend;
        return !!fallback;
    }

    /**
     * Next month's envelope balance.
     * remain >= 0            → value + remain              (surplus carries)
     * remain < 0, strict     → max(0, value + remain)      (legacy one-time penalty)
     * remain < 0, default    → value                       (overspend already hit the ledger)
     * `value` defaults to the stored value; pass fieldValue() for auto-funded fields.
     */
    function rolloverAvail (field, effSpent, strict, value = num(field.value)) {
        const remain = num(field.avail) - effSpent;
        if (remain >= 0) return value + remain;
        return strict ? Math.max(0, value + remain) : value;
    }

    function newField (kind) {
        const f = { id: uuid(), label: '', value: 0, pinned: false, accounted: false, tags: [] };
        if (kind === KIND.EXPENSE) f.budgetId = null;
        if (isEnvelopeKind(kind)) { f.avail = 0; f.spent = 0; f.pinned = true; }
        if (kind === KIND.GOAL) { f.target = null; f.dueKey = null; f.freqMonths = null; }
        return f;
    }

    function sortedDefs (settings) {
        return [...(settings.groups || [])].sort((a, b) => num(a.order) - num(b.order));
    }

    /** Build the next month from a closing month + current settings. */
    function rollover (month, settings) {
        const next = {
            key: month.key ? nextKey(month.key) : undefined,
            status: 'open',
            startingSavings: savings(month),
            closingSavings: null,
            groups: [],
        };
        for (const def of sortedDefs(settings)) {
            const prev = month.groups.find((g) => g.groupId === def.id);
            const g = { groupId: def.id, title: def.title, kind: def.kind, fields: [] };
            if (prev) {
                for (const f of prev.fields) {
                    // budgets always carry - they're standing savings accounts,
                    // not line items, and have no pin control. Legacy imports
                    // can still arrive unpinned, so don't trust the flag here.
                    if (!f.pinned && !isEnvelopeKind(def.kind)) continue;
                    const nf = clone(f);
                    nf.accounted = false;
                    if (isEnvelopeKind(def.kind)) {
                        const eff = effectiveSpent(month, f);
                        // goals are never strict: their overspend split already
                        // paid the overflow from liquid this month
                        const strict = def.kind === KIND.ENVELOPE && strictFor(settings, def.id);
                        if (def.kind === KIND.GOAL && nf.dueKey && num(nf.target) > 0) {
                            // scheduled goal: advance a passed due date by its
                            // frequency, then materialize next month's deposit
                            const childKey = month.key ? nextKey(month.key) : null;
                            if (childKey && num(nf.freqMonths) > 0) {
                                while (monthIndex(nf.dueKey) < monthIndex(childKey)) {
                                    nf.dueKey = addMonths(nf.dueKey, num(nf.freqMonths));
                                }
                            }
                            const base = rolloverAvail(f, eff, strict, 0);
                            nf.value = scheduledAmount(childKey, nf, base);
                            nf.avail = base + nf.value;
                        } else {
                            nf.avail = rolloverAvail(f, eff, strict, contribution(month, f, def.kind));
                        }
                        nf.spent = 0;
                    }
                    g.fields.push(nf);
                }
            }
            next.groups.push(g);
        }
        // drop budget links whose envelope didn't carry over
        const ids = new Set(allFields(next).map((f) => f.id));
        for (const f of allFields(next)) {
            if (f.budgetId && !ids.has(f.budgetId)) f.budgetId = null;
        }
        return next;
    }

    /**
     * Close-time carry-over: an income/expense row with a value that was never
     * marked paid/received didn't actually happen this month - at close-out the
     * user can move it into the next month instead of counting it.
     *
     * carryOverExtract(month, ids) runs BEFORE the close is computed, and
     * before applyAutoValues - a % rule must not fund from income that never
     * arrived. It zeroes each row (the zeroed, unaccounted row stays in the
     * closed month's history, showing the item was expected but didn't happen)
     * and captures a snapshot for re-materialization. Envelope-kind rows,
     * already-accounted rows and unknown ids are ignored.
     */
    function carryOverExtract (month, ids) {
        const entries = [];
        for (const id of ids || []) {
            const g = groupOfField(month, id);
            if (!g || isEnvelopeKind(g.kind)) continue;
            const f = g.fields.find((x) => x.id === id);
            if (!f || truthy(f.accounted) || num(f.value) === 0) continue;
            entries.push({ groupId: g.groupId, kind: g.kind, snap: clone(f) });
            f.value = 0;
        }
        return entries;
    }

    /**
     * The restore half, applied to the month rollover() built. A pinned row
     * already carried (same id, value zeroed by the extract) - its value is
     * put back. An unpinned row didn't carry - it is re-inserted into its
     * group (same-kind fallback if the group was deleted from settings) with
     * its original value, exactly as it sat before the close: unpinned,
     * unaccounted, tags and budget link intact.
     */
    function carryOverRestore (next, entries) {
        for (const e of entries || []) {
            const carried = findField(next, e.snap.id);
            if (carried) {
                carried.value = num(e.snap.value);
                carried.accounted = false;
                continue;
            }
            const g = next.groups.find((g) => g.groupId === e.groupId)
                || next.groups.find((g) => g.kind === e.kind);
            if (!g) continue;
            const nf = clone(e.snap);
            nf.accounted = false;
            if (nf.budgetId && !findField(next, nf.budgetId)) nf.budgetId = null;
            g.fields.push(nf);
        }
        return next;
    }

    /** Empty group instances for a brand-new month (first run). */
    function materializeMonth (settings, startingSavings = 0, key = undefined) {
        return {
            key,
            status: 'open',
            startingSavings: num(startingSavings),
            closingSavings: null,
            groups: sortedDefs(settings).map((def) => ({
                groupId: def.id, title: def.title, kind: def.kind, fields: [],
            })),
        };
    }

    /**
     * Align a month's group instances with the settings group list:
     * add instances for new groups, refresh title/kind snapshots, keep the
     * settings order, and drop instances of deleted groups only when empty.
     */
    function syncMonthWithSettings (month, settings) {
        const defs = sortedDefs(settings);
        const groups = [];
        for (const def of defs) {
            let g = month.groups.find((g) => g.groupId === def.id);
            if (!g) g = { groupId: def.id, fields: [] };
            g.title = def.title;
            g.kind = def.kind;
            groups.push(g);
        }
        for (const g of month.groups) {
            if (!defs.some((d) => d.id === g.groupId) && g.fields.length > 0) {
                groups.push(g); // orphaned but non-empty: keep, don't destroy data
            }
        }
        month.groups = groups;
        return month;
    }

    /**
     * What "Return to Income" hands back: only money committed in EARLIER
     * months. Deleting the field also deletes this month's contribution
     * charge, so handing that part back too would mint phantom income; and
     * linked expenses get unlinked (re-charged as ordinary spending), so only
     * direct/manual spending reduces the returnable balance.
     */
    function returnableBalance (month, field, kind) {
        return Math.max(0, num(field.avail) - contribution(month, field, kind) - num(field.spent));
    }

    /**
     * Retire an envelope: return its previously-committed balance as an income
     * line ("Returned from budget: <label>") and remove the envelope field. The line
     * carries metadata (returnedFrom, returnBase) so recomputeForward can keep
     * it consistent if the chain that fed the envelope is edited later.
     */
    function emptyEnvelope (month, fieldId) {
        const group = groupOfField(month, fieldId);
        const field = findField(month, fieldId);
        if (!group || !field || !isEnvelopeKind(group.kind)) return null;

        const remaining = returnableBalance(month, field, group.kind);
        const base = Math.max(0, num(field.avail) - contribution(month, field, group.kind));
        group.fields = group.fields.filter((f) => f.id !== fieldId);

        // unlink any expenses that pointed at this envelope
        for (const f of allFields(month)) {
            if (f.budgetId === fieldId) f.budgetId = null;
        }

        let returned = null;
        if (remaining > 0) {
            const income = month.groups.find((g) => g.kind === KIND.INCOME);
            if (income) {
                returned = newField(KIND.INCOME);
                returned.label = `Returned from budget: ${field.label || 'unnamed'}`;
                returned.value = remaining;
                returned.returnedFrom = fieldId;
                returned.returnBase = base;
                income.fields.push(returned);
            }
        }
        return { removed: field, remaining, returned };
    }

    /**
     * Tags are a property of the FIELD across its whole lifetime: apply an
     * add/remove to every instance of the field (same id) in every month -
     * past included. Tags never affect money math, so closed months are safe
     * to touch and no recompute is needed.
     */
    function applyTagsAcrossMonths (db, fieldId, addTags = [], removeTag = null) {
        let touched = 0;
        for (const key of monthKeys(db)) {
            const f = findField(db.months[key], fieldId);
            if (!f) continue;
            const tags = new Set(f.tags || []);
            for (const t of addTags) tags.add(t);
            if (removeTag) tags.delete(removeTag);
            f.tags = [...tags];
            touched += 1;
        }
        return touched;
    }

    // ------------------------------------------------------ three-way merge

    const jsonEq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

    /** Union of own keys across versions, minus structurals handled separately. */
    function mergeKeys (objs, skip) {
        const keys = new Set();
        for (const o of objs) { if (o) Object.keys(o).forEach((k) => keys.add(k)); }
        for (const k of skip) keys.delete(k);
        return [...keys];
    }

    /** Three-way merge of one field's user-entered properties. Whoever changed
        a property from base wins; both-changed-differently is a conflict and
        MINE wins (the saver is the one looking at the screen). Tags merge as
        sets - adds and removes from both sides both apply. */
    function mergeField (bf, mf, tf, conflicts) {
        const out = clone(mf);
        for (const key of mergeKeys([bf, mf, tf], ['id', 'tags'])) {
            const bv = bf ? bf[key] : undefined;
            const mv = mf[key];
            const tv = tf ? tf[key] : undefined;
            const mineChanged = !jsonEq(mv, bv);
            const theirsChanged = !jsonEq(tv, bv);
            if (theirsChanged && !mineChanged) {
                if (tv === undefined) delete out[key];
                else out[key] = clone(tv);
            } else if (mineChanged && theirsChanged && !jsonEq(mv, tv)) {
                conflicts.push({ fieldId: mf.id, label: mf.label || (tf && tf.label) || '', prop: key, mine: mv, theirs: tv });
            }
        }
        const b = new Set((bf && bf.tags) || []);
        const t = new Set((tf && tf.tags) || []);
        const merged = new Set(mf.tags || []);
        for (const x of t) { if (!b.has(x)) merged.add(x); }      // theirs added
        for (const x of b) { if (!t.has(x)) merged.delete(x); }   // theirs removed
        out.tags = [...merged];
        return out;
    }

    const fieldTouched = (bf, f) => !jsonEq(
        { ...bf, tags: [...(bf.tags || [])].sort() },
        { ...f, tags: [...(f.tags || [])].sort() });

    /**
     * Field-level three-way merge of one month. `base` is the snapshot the
     * saving session originally loaded, `mine` is what it is saving now,
     * `theirs` is what another session persisted meanwhile. Field identity is
     * the uuid (stable across sessions). Add/delete semantics: additions from
     * both sides survive; a deletion wins only over an untouched field -
     * edits beat deletes (recorded as conflicts). Ordering follows mine, with
     * theirs' additions inserted after their surviving neighbor. Derived
     * values (avail chains, auto/scheduled deposits, closingSavings) are NOT
     * reconciled here - run recomputeForward after merging.
     * Returns { month, conflicts: [{fieldId, label, prop, mine, theirs}] }.
     */
    function mergeMonth (base, mine, theirs) {
        const conflicts = [];
        base = base || theirs; // no base → treat theirs as the baseline; mine wins where it differs
        const out = clone(mine);

        // month-level scalars (status guarded by the caller; startingSavings
        // and closingSavings are re-derived by recomputeForward anyway)
        for (const key of mergeKeys([base, mine, theirs], ['groups', 'key'])) {
            const bv = base[key], mv = mine[key], tv = theirs[key];
            if (!jsonEq(tv, bv) && jsonEq(mv, bv)) {
                if (tv === undefined) delete out[key];
                else out[key] = clone(tv);
            }
        }

        const groupById = (m) => new Map((m.groups || []).map((g) => [g.groupId, g]));
        const bGroups = groupById(base), tGroups = groupById(theirs);

        out.groups = (mine.groups || []).map((mg) => {
            const bg = bGroups.get(mg.groupId);
            const tg = tGroups.get(mg.groupId);
            const og = { ...clone(mg) };
            // group meta (title/kind snapshots) - theirs wins only where mine idle
            for (const key of mergeKeys([bg, mg, tg], ['groupId', 'fields'])) {
                const bv = bg ? bg[key] : undefined;
                if (tg && !jsonEq(tg[key], bv) && jsonEq(mg[key], bv)) og[key] = clone(tg[key]);
            }
            if (!tg) return og; // group unknown to theirs - keep mine as-is

            const bF = new Map(((bg && bg.fields) || []).map((f) => [f.id, f]));
            const tF = new Map((tg.fields || []).map((f) => [f.id, f]));
            const merged = [];
            const seen = new Set();

            for (const mf of mg.fields || []) {
                seen.add(mf.id);
                const bf = bF.get(mf.id);
                const tf = tF.get(mf.id);
                if (!bf) {                         // mine added (or both added same id)
                    merged.push(mergeField(null, mf, tf, conflicts));
                } else if (!tf) {                  // theirs deleted
                    if (fieldTouched(bf, mf)) {    // …but mine edited it - edits beat deletes
                        conflicts.push({ fieldId: mf.id, label: mf.label || '', prop: 'removed', mine: 'kept (edited here)', theirs: 'removed' });
                        merged.push(clone(mf));
                    } // untouched → honor the deletion
                } else {
                    merged.push(mergeField(bf, mf, tf, conflicts));
                }
            }

            // theirs' side: additions, and deletes-by-mine that they edited
            const tList = tg.fields || [];
            for (let i = 0; i < tList.length; i++) {
                const tf = tList[i];
                if (seen.has(tf.id)) continue;
                const bf = bF.get(tf.id);
                if (bf && !fieldTouched(bf, tf)) continue; // mine deleted, theirs untouched → deletion wins
                if (bf) {
                    conflicts.push({ fieldId: tf.id, label: tf.label || '', prop: 'removed', mine: 'removed', theirs: 'kept (edited there)' });
                }
                // insert after the nearest preceding theirs-neighbor that survived
                let at = merged.length;
                for (let j = i - 1; j >= 0; j--) {
                    const idx = merged.findIndex((f) => f.id === tList[j].id);
                    if (idx !== -1) { at = idx + 1; break; }
                }
                merged.splice(at, 0, clone(tf));
            }

            og.fields = merged;
            return og;
        });

        // groups only theirs knows about (settings sync landed there first)
        const mineGroupIds = new Set(out.groups.map((g) => g.groupId));
        for (const tg of theirs.groups || []) {
            if (!mineGroupIds.has(tg.groupId)) out.groups.push(clone(tg));
        }

        return { month: out, conflicts };
    }

    // ---------------------------------------------------- recompute forward

    /**
     * Re-derive every month after fromKey (and fromKey's own closingSavings):
     * startingSavings chains, envelope avail chains (matched by field id),
     * closingSavings of closed months, and savingsHistory entries.
     * User-entered labels/values/spent/tags in later months are never touched.
     * Returns { db, changes } on a clone - caller decides whether to persist.
     */
    function recomputeForward (db, fromKey) {
        const out = clone(db);
        const changes = [];

        const from = out.months[fromKey];
        if (from) {
            from.key = fromKey;
            applyAutoValues(from);
            if (from.status === 'closed') from.closingSavings = savings(from);
            if (out.savingsHistory) out.savingsHistory[fromKey] = num(from.startingSavings);
        }

        let prevKeyOf = fromKey;
        for (const key of monthKeys(out).filter((k) => k > fromKey)) {
            const prev = out.months[prevKeyOf];
            const m = out.months[key];
            m.key = key;
            applyAutoValues(m);
            const ch = { key, label: keyLabel(key), startingSavings: null, envelopes: [] };

            const newStart = savings(prev);
            if (num(m.startingSavings) !== newStart) {
                ch.startingSavings = { from: num(m.startingSavings), to: newStart };
                m.startingSavings = newStart;
            }

            for (const g of m.groups) {
                if (!isEnvelopeKind(g.kind)) continue;
                for (const f of g.fields) {
                    const pf = findField(prev, f.id);
                    if (!pf) continue; // field born this month - avail is user-entered
                    const pg = groupOfField(prev, f.id);
                    if (!pg || !isEnvelopeKind(pg.kind)) continue;
                    const gStrict = g.kind === KIND.ENVELOPE && strictFor(out.settings, g.groupId);
                    // a month's balance includes its OWN allotment (the user may
                    // have edited it after the rollover created this month)
                    const prevEff = effectiveSpent(prev, pf);
                    let incoming = fieldValue(m, f);
                    if (g.kind === KIND.GOAL && num(f.target) > 0) {
                        const base = Math.max(0, num(pf.avail) - prevEff);
                        if (f.dueKey) {
                            incoming = scheduledAmount(key, f, base);
                            f.value = incoming; // scheduled deposit follows the chain
                        } else {
                            incoming = Math.min(incoming, Math.max(0, num(f.target) - base));
                        }
                    }
                    const newAvail = rolloverAvail(pf, prevEff, gStrict, incoming);
                    if (num(f.avail) !== newAvail) {
                        ch.envelopes.push({ id: f.id, label: f.label, from: num(f.avail), to: newAvail });
                        f.avail = newAvail;
                    }
                }
            }

            // envelopes deleted in this month via "Return to Income": keep the
            // return line consistent with the recomputed chain. Delta-adjusted,
            // so manual edits to the line survive as an offset.
            for (const pg of prev.groups) {
                if (!isEnvelopeKind(pg.kind)) continue;
                for (const pf of pg.fields) {
                    if (findField(m, pf.id)) continue; // still exists - handled above
                    const rf = allFields(m).find((f) => f.returnedFrom === pf.id);
                    if (!rf) continue;
                    const pgStrict = pg.kind === KIND.ENVELOPE && strictFor(out.settings, pg.groupId);
                    const newBase = rolloverAvail(pf, effectiveSpent(prev, pf), pgStrict, 0);
                    if (newBase === num(rf.returnBase)) continue;
                    const to = Math.max(0, num(rf.value) + (newBase - num(rf.returnBase)));
                    ch.envelopes.push({ id: rf.id, label: rf.label || 'returned budget', from: num(rf.value), to });
                    rf.value = to;
                    rf.returnBase = newBase;
                }
            }

            if (m.status === 'closed') m.closingSavings = savings(m);
            if (out.savingsHistory) out.savingsHistory[key] = num(m.startingSavings);

            if (ch.startingSavings || ch.envelopes.length) changes.push(ch);
            prevKeyOf = key;
        }

        return { db: out, changes };
    }

    // -------------------------------------------------------- default data

    function defaultSettings () {
        return {
            currency: 'USD',
            initialSavings: 0,
            groups: [
                { id: uuid(), title: 'Income', kind: KIND.INCOME, order: 0 },
                { id: uuid(), title: 'Envelope Budgets', kind: KIND.ENVELOPE, order: 1, strictOverspend: false },
                { id: uuid(), title: 'Goal Budgets', kind: KIND.GOAL, order: 2, strictOverspend: false },
                { id: uuid(), title: 'Expenses', kind: KIND.EXPENSE, order: 3 },
            ],
        };
    }

    function defaultData (currentKey) {
        const settings = defaultSettings();
        const months = {};
        if (currentKey) months[currentKey] = materializeMonth(settings, settings.initialSavings, currentKey);
        return {
            meta: { schemaVersion: 1, rev: 0 },
            settings,
            months,
            savingsHistory: currentKey ? { [currentKey]: num(settings.initialSavings) } : {},
        };
    }

    return {
        KIND, num, isEnvelopeKind, clone, truthy, uuid,
        MONTH_NAMES, nextKey, prevKey, keyLabel, monthKeys, monthIndex, addMonths, scheduledAmount,
        allFields, findField, groupOfField,
        linkedDraw, linkedSpent, linkedDeposit, linkedIncome, effectiveSpent, overage,
        hasAuto, autoSourcesNet, fieldValue, applyAutoValues, contribution,
        groupTotal, monthNet, savings, unspentBudgets, savingsWithBudgets, goalProgress,
        strictFor, rolloverAvail, newField, sortedDefs, rollover,
        carryOverExtract, carryOverRestore,
        materializeMonth, syncMonthWithSettings, returnableBalance, emptyEnvelope,
        applyTagsAcrossMonths, mergeMonth, recomputeForward,
        defaultSettings, defaultData,
    };
});
