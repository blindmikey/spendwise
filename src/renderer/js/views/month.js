/* global Alpine, FinEngine, Charts, fmt, showToast, confirmDialog, unwrap */
'use strict';

function monthView () {
    return {
        tagEditorFor: null,     // field id with the tag editor open
        autoEditorFor: null,    // field id with the auto-fund editor open
        schedEditorFor: null,   // field id with the goal-schedule editor open
        newTag: '',
        // groupId → bool, persisted per machine so collapse choices survive
        // reloads and view switches (monthView is re-created by x-if)
        collapsed: (() => {
            try { return JSON.parse(localStorage.getItem('finances.collapsedGroups')) || {}; }
            catch { return {}; }
        })(),
        budgetOptions: [],      // shared dropdown options, refreshed by one watcher
        knownTags: [],          // tag suggestions, computed when a tag editor opens
        tagSuggestOpen: false,  // suggestion dropdown under the tag input
        tagSuggestIndex: -1,    // highlighted suggestion (-1 = none)
        tagSuggestPos: { x: 0, y: 0 }, // fixed-position coords (group cards clip overflow)
        rowMenuFor: null,       // field id with the mobile ⋮ actions menu open
        rowMenuPos: { x: 0, y: 0 },
        linkedMap: {},          // envelopeFieldId → linked expense total, one watcher
        _optCache: {},
        history: [],            // undo/redo snapshots of the current month
        historyIndex: -1,

        // ------------------------------------------------------- accessors

        get db () { return Alpine.store('data').db; },
        get ui () { return Alpine.store('ui'); },
        get key () { return this.ui.currentKey; },
        get month () { return (this.db && this.db.months[this.key]) || null; },
        get keys () { return FinEngine.monthKeys(this.db); },
        get isLatest () { return this.keys[this.keys.length - 1] === this.key; },
        get isClosed () { return this.month && this.month.status === 'closed'; },
        get unlocked () { return this.ui.unlockedKeys.includes(this.key); },
        get readonly () { return this.isClosed && !this.unlocked; },
        get offline () { return !!this.ui.offline; },
        // readonly = "this month is history"; frozen = "you can't edit right
        // now" (history OR no server to save to). The closed-month notice keys
        // off readonly; every input disables on frozen.
        get frozen () { return this.readonly || this.offline; },
        get label () { return this.key ? FinEngine.keyLabel(this.key) : ''; },
        get isDirty () { return this.month && JSON.stringify(this.month) !== this.ui.savedSnapshot; },

        get net () { return this.month ? FinEngine.monthNet(this.month) : 0; },
        get currentSavings () { return this.month ? FinEngine.savings(this.month) : 0; },
        get withBudgets () { return this.month ? FinEngine.savingsWithBudgets(this.month) : 0; },

        /**
         * The envelope dropdown options are computed by ONE watcher and stored,
         * instead of a getter - a getter would be re-evaluated independently by
         * every expense row's <select> (each scan is envelopes × expenses),
         * which made budget assignment take ~1s on a real-sized month.
         */
        computeBudgetOptions () {
            const opts = [{ id: '', label: '-' }];
            if (!this.month) return opts;
            for (const g of this.month.groups) {
                if (!FinEngine.isEnvelopeKind(g.kind)) continue;
                for (const f of g.fields) {
                    const left = FinEngine.num(f.avail) - FinEngine.effectiveSpent(this.month, f);
                    opts.push({ id: f.id, label: `${f.label || '(unnamed)'} (${fmt(left)} left)` });
                }
            }
            return opts;
        },

        get optionsSignature () { return JSON.stringify(this.computeBudgetOptions()); },

        refreshBudgetOptions () {
            const fresh = JSON.parse(this.optionsSignature);
            // reuse unchanged option objects so keyed x-for skips their bindings
            const next = fresh.map((o) => {
                const hit = this._optCache[o.id];
                return (hit && hit.label === o.label) ? hit : o;
            });
            this._optCache = Object.fromEntries(next.map((o) => [o.id, o]));
            this.budgetOptions = next;
        },

        /** Income/expense groups an auto-fund rule may draw from. */
        get sourceGroups () {
            if (!this.month) return [];
            return this.month.groups
                .filter((g) => g.kind === 'income' || g.kind === 'expense')
                .map((g) => ({ groupId: g.groupId, title: g.title }));
        },

        /**
         * Per-row helpers read the shared linkedMap instead of calling the
         * engine's linkedSpent - otherwise every envelope row binding rescans
         * every expense row on each change (the other half of the ~1s lag).
         */
        get linkedSignature () {
            const map = {};
            if (this.month) {
                for (const g of this.month.groups) {
                    if (g.kind !== 'expense') continue;
                    for (const f of g.fields) {
                        if (f.budgetId) map[f.budgetId] = (map[f.budgetId] || 0) + FinEngine.num(f.value);
                    }
                }
            }
            return JSON.stringify(map);
        },

        /**
         * Available includes the current month's own allotment (legacy behavior),
         * so editing an envelope's monthly amount - or an auto-fund rate moving -
         * must adjust "available" live by the difference. Capped goals are
         * excluded (their top-up is bounded by the target and lands at close-out).
         */
        get rateSignature () {
            const map = {};
            if (this.month) {
                for (const g of this.month.groups) {
                    if (!FinEngine.isEnvelopeKind(g.kind)) continue;
                    for (const f of g.fields) {
                        if (g.kind === 'goal' && FinEngine.num(f.target) > 0) continue;
                        map[f.id] = FinEngine.fieldValue(this.month, f);
                    }
                }
            }
            return JSON.stringify(map);
        },

        refreshRateCache () {
            this._rateCache = JSON.parse(this.rateSignature);
            this._schedCache = JSON.parse(this.scheduleSignature);
            this._rateCtx = this.key + '|' + (this.db ? this.db.meta.rev : 0);
            this._schedCtx = this._rateCtx;
        },

        /**
         * Scheduled goals materialize their monthly deposit whenever the
         * schedule inputs (target, due date, frequency) change: the deposit is
         * fixed for the month, so spending mid-cycle doesn't accelerate it -
         * the NEXT month recalculates from the new headroom.
         */
        get scheduleSignature () {
            const map = {};
            if (this.month) {
                for (const g of this.month.groups) {
                    if (g.kind !== 'goal') continue;
                    for (const f of g.fields) {
                        map[f.id] = { t: FinEngine.num(f.target), d: f.dueKey || '', q: FinEngine.num(f.freqMonths) };
                    }
                }
            }
            return JSON.stringify(map);
        },

        applyScheduleChanges () {
            const ctx = this.key + '|' + (this.db ? this.db.meta.rev : 0);
            const map = JSON.parse(this.scheduleSignature);
            if (ctx !== this._schedCtx || !this._schedCache) {
                this._schedCache = map;
                this._schedCtx = ctx;
                return;
            }
            for (const [id, s] of Object.entries(map)) {
                const old = this._schedCache[id];
                // unseen id in the same ctx = field born this flush - include it
                const changed = old ? (old.t !== s.t || old.d !== s.d || old.q !== s.q) : true;
                if (!changed || !s.d || !(s.t > 0)) continue;
                const field = FinEngine.findField(this.month, id);
                if (!field) continue;
                const base = Math.max(0, FinEngine.num(field.avail) - FinEngine.num(field.value));
                const deposit = FinEngine.scheduledAmount(this.key, field, base);
                field.value = deposit;
                field.avail = base + deposit;
            }
            this._schedCache = map;
        },

        applyRateDeltas () {
            const ctx = this.key + '|' + (this.db ? this.db.meta.rev : 0);
            const map = JSON.parse(this.rateSignature);
            if (ctx !== this._rateCtx || !this._rateCache) {
                // month switched or data replaced - balances are already correct
                this._rateCache = map;
                this._rateCtx = ctx;
                return;
            }
            for (const [id, rate] of Object.entries(map)) {
                const old = this._rateCache[id];
                if (old === undefined || old === rate) continue;
                const field = FinEngine.findField(this.month, id);
                if (field) field.avail = FinEngine.num(field.avail) + (rate - old);
            }
            this._rateCache = map;
        },

        /** Mobile row-actions menu (⋮): fixed-positioned - group cards clip
            overflow - and kept on-screen for rows near the right edge. */
        toggleRowMenu (field, e) {
            if (this.rowMenuFor === field.id) { this.rowMenuFor = null; return; }
            const r = e.currentTarget.getBoundingClientRect();
            this.rowMenuPos = {
                x: Math.max(8, Math.min(r.left, window.innerWidth - 232)),
                y: r.bottom + 4,
            };
            this.rowMenuFor = field.id;
        },

        toggleCollapsed (groupId) {
            this.collapsed[groupId] = !this.collapsed[groupId];
            localStorage.setItem('finances.collapsedGroups', JSON.stringify(this.collapsed));
        },

        groupTotal (group) { return FinEngine.groupTotal(this.month, group); },
        linked (field) { return this.linkedMap[field.id] || 0; },
        effSpent (field) { return FinEngine.num(field.spent) + this.linked(field); },
        overBudget (field) { return this.effSpent(field) > FinEngine.num(field.avail); },
        progress (field) { return FinEngine.goalProgress(this.month, field); },
        envelopeLeft (field) { return FinEngine.num(field.avail) - this.effSpent(field); },
        // fuel gauge: % of the envelope still unspent this month.
        // untouched envelopes show no gauge at all.
        health (field) {
            const avail = FinEngine.num(field.avail);
            const spent = this.effSpent(field);
            const left = avail - spent;
            const pct = avail > 0 ? Math.max(0, Math.min(100, (left / avail) * 100)) : 0;
            return { pct, empty: left <= 0, show: spent > 0 };
        },
        // NOTE: do not name helpers after Object.prototype members (valueOf,
        // toString…) - inside Alpine's `with`-based expression scope they
        // resolve to the prototype method of the nearest scope object.
        rateOf (field) { return FinEngine.fieldValue(this.month, field); },
        contrib (group, field) { return FinEngine.contribution(this.month, field, group.kind); },
        isAuto (field) { return FinEngine.hasAuto(field); },
        isSched (group, field) { return group.kind === 'goal' && !!field.dueKey && FinEngine.num(field.target) > 0; },

        groupHint (kind) {
            return {
                income: 'All income for the month. <kbd class="border border-zinc-300 rounded-sm py-0.5 px-0.75"><svg class="w-3.5 h-3.5 inline-block -mt-1"><use href="#i-pin"/></svg></kbd> Pin recurring sources so they carry forward.',
                envelope: 'Little savings accounts: Spending flows in automatically from expense rows assigned to the envelope. Use <kbd class="border border-zinc-300 rounded-sm py-0.5 px-0.75"><svg class="w-3.5 h-3.5 inline-block -mt-1"><use href="#i-percent"/></svg></kbd> to auto-fund from a percentage of other groups.',
                goal: 'Envelope budgets with a cap - ideal for recurring bills. Use <kbd class="border border-zinc-300 rounded-sm py-0.5 px-0.75"><svg class="w-3.5 h-3.5 inline-block -mt-1"><use href="#i-clock"/></svg></kbd> to set a due date and the monthly deposit is calculated for you and re-spread each cycle.',
                expense: 'Monthly or one-time expenses. <kbd class="border border-zinc-300 rounded-sm py-0.5 px-0.75"><svg class="w-3.5 h-3.5 inline-block -mt-1"><use href="#i-pin"/></svg></kbd> Pin recurring ones. Assign one to an envelope and it spends from that envelope’s balance instead.',
            }[kind] || '';
        },

        // ------------------------------------------------------ life cycle

        init () {
            // the header's month picker lives outside this component
            this.ui.monthGoto = (k) => this.goto(k);
            this.$watch('key', () => {
                this.tagEditorFor = null;
                this.autoEditorFor = null;
                this.schedEditorFor = null;
                this.resetHistory();
                this.renderChart();
            });
            this.$watch('currentSavings', () => this.scheduleChart());
            this.$watch('optionsSignature', () => this.refreshBudgetOptions());
            this.$watch('linkedSignature', (sig) => { this.linkedMap = JSON.parse(sig); });
            this.$watch('rateSignature', () => this.applyRateDeltas());
            this.$watch('scheduleSignature', () => this.applyScheduleChanges());
            this.$watch('monthSignature', (sig) => this.recordHistory(sig));
            this.linkedMap = JSON.parse(this.linkedSignature);
            this.refreshBudgetOptions();
            this.refreshRateCache();
            this.resetHistory();
            this.$nextTick(() => this.renderChart());
        },

        // -------------------------------------------------- undo / redo

        get monthSignature () { return this.month ? JSON.stringify(this.month) : ''; },

        resetHistory () {
            clearTimeout(this._histTimer);
            this.history = this.month ? [JSON.stringify(this.month)] : [];
            this.historyIndex = this.history.length - 1;
        },

        recordHistory (sig) {
            if (this._histSuppress || !sig) return;
            clearTimeout(this._histTimer);
            // group rapid keystrokes into one undo step
            this._histTimer = setTimeout(() => {
                if (this.history[this.historyIndex] === sig) return;
                this.history = this.history.slice(0, this.historyIndex + 1);
                this.history.push(sig);
                if (this.history.length > 100) this.history.shift();
                this.historyIndex = this.history.length - 1;
            }, 350);
        },

        applyHistory (index) {
            if (this.frozen || index < 0 || index >= this.history.length) return false;
            clearTimeout(this._histTimer);
            this._histSuppress = true;
            this.historyIndex = index;
            Object.assign(this.db.months, { [this.key]: JSON.parse(this.history[index]) });
            this.refreshRateCache(); // reverted rates must not re-apply as avail deltas
            this.$nextTick(() => { this._histSuppress = false; });
            return true;
        },

        undo () {
            if (this.applyHistory(this.historyIndex - 1)) showToast('Undo', 'info', 1200);
        },

        redo () {
            if (this.applyHistory(this.historyIndex + 1)) showToast('Redo', 'info', 1200);
        },

        hotkeys (e) {
            if (this.ui.view !== 'month' || !(e.ctrlKey || e.metaKey)) return;
            const k = (e.key || '').toLowerCase();
            if (k === 's') { e.preventDefault(); this.save(); }
            else if (k === 'z' && e.shiftKey) { e.preventDefault(); this.redo(); }
            else if (k === 'z') { e.preventDefault(); this.undo(); }
            else if (k === 'y') { e.preventDefault(); this.redo(); }
        },

        renderChart () {
            if (!this.month) return;
            Charts.savingsLine(this.$refs.savingsChart, this.db, this.key, this.currentSavings);
        },

        scheduleChart () {
            clearTimeout(this._chartTimer);
            this._chartTimer = setTimeout(() => this.renderChart(), 400);
        },

        snapshot () { this.ui.savedSnapshot = JSON.stringify(this.month); },

        // ------------------------------------------------------ navigation

        /** Two frames: one to get the overlay on screen, one to let it paint. */
        painted () {
            return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        },

        async goto (key) {
            if (!key || key === this.key || !this.db.months[key]) return;
            if (this.isDirty) {
                const okDiscard = await confirmDialog({
                    title: 'Discard unsaved changes?',
                    body: `You have unsaved edits in ${this.label}. Leaving now discards them.`,
                    confirmText: 'Discard changes', danger: true,
                });
                if (!okDiscard) return;
                Object.assign(this.db.months, { [this.key]: JSON.parse(this.ui.savedSnapshot) });
            }
            this.ui.unlockedKeys = this.ui.unlockedKeys.filter((k) => k !== this.key);

            // Rendering a month's rows blocks the main thread, so swap to
            // "loading…" BEFORE the work starts — set the flag, wait for a real
            // paint, and only then change month. (Hiding main also spares the
            // browser laying out rows nobody can see yet.)
            this.ui.switching = true;
            await this.painted();
            this.ui.currentKey = key;
            this.snapshot();
            await this.painted(); // the new month has rendered by now
            this.ui.switching = false;
        },

        async unlock () {
            const okUnlock = await confirmDialog({
                title: `Edit ${this.label}?`,
                body: 'This month is closed. You can edit it, but saving will recompute every later month - '
                    + 'envelope balances, starting savings, and the savings history - so the books stay consistent. '
                    + 'A backup is taken automatically before anything is rewritten.',
                confirmText: 'Unlock for editing', danger: true,
            });
            if (okUnlock) this.ui.unlockedKeys.push(this.key);
        },

        cancelEditing () {
            Object.assign(this.db.months, { [this.key]: JSON.parse(this.ui.savedSnapshot) });
            this.ui.unlockedKeys = this.ui.unlockedKeys.filter((k) => k !== this.key);
            this.refreshRateCache(); // reverted rates must not re-apply as deltas
            this.resetHistory();
        },

        // ---------------------------------------------------------- fields

        addField (group, index) {
            const f = FinEngine.newField(group.kind);
            group.fields.splice(index === undefined ? group.fields.length : index + 1, 0, f);
            this.closeEditors(); // a new row means you're done with the old one
        },

        /**
         * The tag / auto-fund / schedule editors belong to one row. Rather than
         * make people dismiss them, they close as soon as attention moves on —
         * focus landing in another row, or a new row being added.
         */
        closeEditors (exceptFieldId = null) {
            for (const k of ['tagEditorFor', 'autoEditorFor', 'schedEditorFor', 'rowMenuFor']) {
                if (this[k] && this[k] !== exceptFieldId) this[k] = null;
            }
            this.tagSuggestOpen = false;
        },

        /** focusin bubbles from any control in the row, so one handler per row. */
        rowFocused (field) {
            this.closeEditors(field.id);
        },

        async removeField (group, field) {
            if (FinEngine.isEnvelopeKind(group.kind)) {
                const left = FinEngine.returnableBalance(this.month, field, group.kind);
                if (left > 0) {
                    // deleting an envelope with money in it: ask what to do with it
                    const answer = await confirmDialog({
                        title: `Remove “${field.label || 'envelope'}”?`,
                        body: `${fmt(left)} of it was committed in earlier months - return that to Income as `
                            + `“Returned from budget: ${field.label || 'unnamed'}” to keep the ledger accurate, `
                            + 'or discard it so the balance disappears from your books. '
                            + '(This month’s contribution simply stops either way.)',
                        confirmText: 'Return to Income',
                        altText: 'Discard',
                    });
                    if (answer === false) return;
                    if (answer === true) {
                        const res = FinEngine.emptyEnvelope(this.month, field.id);
                        if (res && res.returned) showToast(`${fmt(res.remaining)} returned to Income`, 'success');
                        return;
                    }
                    // 'alt' → fall through and discard
                }
                for (const f of FinEngine.allFields(this.month)) {
                    if (f.budgetId === field.id) f.budgetId = null;
                }
            }
            group.fields.splice(group.fields.indexOf(field), 1);
        },

        // ------------------------------------------------------- auto-fund

        toggleAutoEditor (field) {
            this.autoEditorFor = this.autoEditorFor === field.id ? null : field.id;
            this.tagEditorFor = null;
            this.schedEditorFor = null;
        },

        toggleSchedEditor (field) {
            this.schedEditorFor = this.schedEditorFor === field.id ? null : field.id;
            this.tagEditorFor = null;
            this.autoEditorFor = null;
        },

        async clearSchedule (field) {
            const okClear = await confirmDialog({
                title: 'Remove the schedule?',
                body: 'The goal keeps its balance and target, but the monthly deposit stops being calculated - '
                    + 'set it manually like a plain envelope budget with a cap.',
                confirmText: 'Remove schedule',
            });
            if (okClear) { field.dueKey = null; this.schedEditorFor = null; }
        },

        ensureAuto (field) {
            if (!field.auto) field.auto = { pct: 0, groups: [] };
            return field.auto;
        },

        setAutoPct (field, pct) {
            this.ensureAuto(field).pct = Math.max(0, Math.min(100, FinEngine.num(pct)));
        },

        toggleAutoGroup (field, groupId) {
            const auto = this.ensureAuto(field);
            auto.groups = auto.groups.includes(groupId)
                ? auto.groups.filter((id) => id !== groupId)
                : [...auto.groups, groupId];
        },

        clearAuto (field) {
            field.auto = null;
            this.autoEditorFor = null;
        },

        // ------------------------------------------------------------ tags

        toggleTagEditor (field) {
            this.tagEditorFor = this.tagEditorFor === field.id ? null : field.id;
            this.autoEditorFor = null;
            this.schedEditorFor = null;
            this.newTag = '';
            this.tagSuggestOpen = false;
            this.tagSuggestIndex = -1;
            // computed here (imperatively, outside any effect) so the dropdown
            // never becomes a reactive dependency on every field of every month
            if (this.tagEditorFor) this.knownTags = this.allKnownTags();
        },

        /** Existing tags matching the typed text (substring), minus the ones
            already on the field - so near-duplicates like "grocery" surface
            the existing "groceries" before it gets created. */
        tagSuggestions (field) {
            const q = this.newTag.trim().toLowerCase().replace(/\s+/g, '-');
            return this.knownTags
                .filter((t) => !field.tags.includes(t) && (!q || t.includes(q)))
                .slice(0, 5);
        },

        openTagSuggest (e) {
            const r = e.target.getBoundingClientRect();
            this.tagSuggestPos = { x: r.left, y: r.bottom + 4 };
            this.tagSuggestOpen = true;
            this.tagSuggestIndex = -1;
        },

        pickTag (field, tag) {
            this.newTag = tag;
            this.addTag(field);
            this.tagSuggestIndex = -1;
        },

        tagKeydown (field, e) {
            const list = this.tagSuggestions(field);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.tagSuggestOpen = true;
                this.tagSuggestIndex = Math.min(this.tagSuggestIndex + 1, list.length - 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.tagSuggestIndex = Math.max(this.tagSuggestIndex - 1, -1);
            } else if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                if (this.tagSuggestIndex >= 0 && list[this.tagSuggestIndex]) this.pickTag(field, list[this.tagSuggestIndex]);
                else this.addTag(field);
                this.tagSuggestIndex = -1;
            } else if (e.key === 'Escape') {
                this.tagSuggestOpen = false;
                this.tagSuggestIndex = -1;
            } else {
                this.tagSuggestIndex = -1; // typing resets the highlight
            }
        },

        addTag (field) {
            const tag = this.newTag.trim().toLowerCase().replace(/\s+/g, '-');
            this.newTag = '';
            if (!tag || field.tags.includes(tag)) return;
            this.syncTag(field, [tag], null);
        },

        removeTag (field, tag) {
            this.syncTag(field, [], tag);
        },

        /**
         * Tags are a field-lifetime property: the operation applies to every
         * month the field appears in, past included - mirrored locally and
         * persisted immediately (tags never affect any totals).
         */
        async syncTag (field, add, remove) {
            if (this.offline) return; // tags persist server-side immediately
            const wasDirty = this.isDirty;
            const monthsTouched = FinEngine.applyTagsAcrossMonths(this.db, field.id, add, remove);
            try {
                const res = unwrap(await window.api.applyTagsEverywhere({
                    fieldId: field.id, add, remove, expectedRev: this.db.meta.rev,
                }));
                this.db.meta.rev = res.rev;
                // rev changed: re-sync the delta-watcher contexts or the next
                // rate/schedule change would be swallowed by the ctx guard
                this.refreshRateCache();
                // the tag change itself is already persisted - don't leave the
                // month looking dirty unless it already was
                if (!wasDirty) this.snapshot();
                if (monthsTouched > 1) {
                    showToast(`${add.length ? '#' + add[0] : 'Tag'} ${add.length ? 'applied to' : 'removed from'} ${monthsTouched} months`, 'info', 2500);
                }
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },

        allKnownTags () {
            const tags = new Set();
            for (const k of this.keys) {
                for (const f of FinEngine.allFields(this.db.months[k])) {
                    (f.tags || []).forEach((t) => tags.add(t));
                }
            }
            return [...tags].sort();
        },

        // ----------------------------------------------------- persistence

        async save () {
            if (this.frozen) return;
            if (this.isClosed) return this.saveClosed();
            try {
                const res = unwrap(await window.api.saveMonth({
                    key: this.key,
                    month: FinEngine.clone(this.month),
                    // the month as this session loaded it - the merge base
                    // when another session saved in the meantime
                    base: this.ui.savedSnapshot ? JSON.parse(this.ui.savedSnapshot) : null,
                    expectedRev: this.db.meta.rev,
                }));
                if (res.merged) {
                    // another session saved since we loaded: the server did a
                    // field-level three-way merge and recomputed - adopt its state
                    Alpine.store('data').db = res.data;
                    this.snapshot();
                    this.refreshRateCache();
                    this.resetHistory();
                    this.renderChart();
                    const n = (res.conflicts || []).length;
                    showToast(n
                        ? `Saved - merged with another session's edits (${n} overlapping ${n === 1 ? 'change' : 'changes'}, yours kept)`
                        : 'Saved - merged with another session\'s edits', 'info', 6000);
                } else {
                    this.db.meta.rev = res.rev;
                    this.db.savingsHistory[this.key] = FinEngine.num(this.month.startingSavings);
                    this.snapshot();
                    this.refreshRateCache();
                    showToast('Month saved', 'success');
                }
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },

        async saveClosed () {
            const okSave = await confirmDialog({
                title: 'Save & recompute forward?',
                body: `Saving ${this.label} rewrites the derived numbers of every later month. `
                    + 'A backup of the current data is taken first.',
                confirmText: 'Save & Recompute', danger: true,
            });
            if (!okSave) return;
            try {
                const res = unwrap(await window.api.saveClosedMonth({
                    key: this.key,
                    month: FinEngine.clone(this.month),
                    expectedRev: this.db.meta.rev,
                }));
                Alpine.store('data').db = res.data;
                this.ui.unlockedKeys = this.ui.unlockedKeys.filter((k) => k !== this.key);
                this.snapshot();
                this.refreshRateCache();
                this.resetHistory();
                this.renderChart();
                if (res.changes.length) {
                    this.ui.recomputeChanges = res.changes;
                    this.ui.modals.recompute = true;
                } else {
                    showToast('Saved - no later months were affected', 'success');
                }
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },

        async closeOut () {
            if (this.isClosed || !this.isLatest || this.offline) return;
            const nextLabel = FinEngine.keyLabel(FinEngine.nextKey(this.key));
            const okClose = await confirmDialog({
                title: `Close out ${this.label}?`,
                body: `Finalizes ${this.label} with ${fmt(this.currentSavings)} in savings, rolls pinned fields and `
                    + `envelope balances forward, and starts ${nextLabel}. You can still edit it later.`,
                confirmText: 'Close Out Month',
            });
            if (!okClose) return;
            try {
                const res = unwrap(await window.api.closeMonth({
                    key: this.key,
                    month: FinEngine.clone(this.month),
                    expectedRev: this.db.meta.rev,
                }));
                Alpine.store('data').db = res.data;
                this.ui.currentKey = res.nextKey;
                this.snapshot();
                this.refreshRateCache();
                this.resetHistory();
                this.renderChart();
                showToast(`${FinEngine.keyLabel(res.nextKey)} is ready`, 'success');
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },
    };
}
