/* global Alpine, FinEngine, FinImporter, fmtExact, showToast, confirmDialog, simplefinControls, unwrap */
'use strict';

/**
 * Import inbox: the review modal for bank transactions (see shared/importer.js
 * for the model). Three tabs - drafts to review, processed history, rules &
 * accounts - plus the CSV mapping step.
 *
 * Persistence is split on purpose:
 *  - LEDGER writes (items, statuses, accounts, rules) persist immediately via
 *    importsApply, like tag ops - semantic, no rev gate, disabled offline.
 *  - MONTH rows created by publish/merge are ordinary local edits: undoable,
 *    saved with the normal "Update This Month" button, merged like any other
 *    edit. An item only COUNTS as processed while its row exists (derived
 *    status), so discarding month edits returns items to the drafts on its own.
 */
function inboxView () {
    return {
        tab: 'review',      // review | processed | rules
        edits: {},          // itemId → { label, amount, groupId, targetId, always }
        importing: false,   // CSV mapping step is showing
        csv: null,          // { fileName, rows, map, expensesNegative, accountId }
        newAcctLabel: '',   // inline account creation inside the import step
        busy: false,
        // SimpleFIN sync button + status (connect/disconnect live in Settings)
        ...simplefinControls(),

        /** After a sync lands: show the fresh drafts. */
        afterSfSync () {
            this.tab = 'review';
            this.prepareEdits();
        },

        // ------------------------------------------------------- accessors

        get db () { return Alpine.store('data').db; },
        get ui () { return Alpine.store('ui'); },
        get key () { return this.ui.currentKey; },
        get month () { return (this.db && this.db.months[this.key]) || null; },
        get open () { return this.ui.modals.inbox; },
        get offline () { return !!this.ui.offline; },
        get frozen () {
            return !this.month
                || (this.month.status === 'closed' && !this.ui.unlockedKeys.includes(this.key));
        },
        get imports () { return (this.db && this.db.imports) || { accounts: [], rules: [], items: [] }; },
        get accounts () { return this.imports.accounts || []; },
        get rules () { return this.imports.rules || []; },
        get items () { return this.imports.items || []; },

        status (item) { return FinImporter.effectiveStatus(this.db, item); },
        homeKey (item) { return FinImporter.homeMonthKey(this.db, item); },
        // both tabs are scoped to the month being VIEWED, by transaction date -
        // September's bank lines show up while looking at September
        get pendingItems () {
            return this.items.filter((i) => this.status(i) === 'pending' && this.homeKey(i) === this.key);
        },
        get processedItems () {
            return this.items.filter((i) => this.status(i) !== 'pending' && this.homeKey(i) === this.key)
                .slice().reverse().slice(0, 200);
        },
        /** Drafts waiting in OTHER months: [{ key, label, count }], newest first. */
        get otherPending () {
            const by = {};
            for (const i of this.items) {
                if (this.status(i) !== 'pending') continue;
                const k = this.homeKey(i);
                if (k === this.key) continue;
                by[k] = (by[k] || 0) + 1;
            }
            return Object.keys(by).sort().reverse()
                .map((k) => ({ key: k, label: FinEngine.keyLabel(k), count: by[k] }));
        },
        async gotoMonth (key) {
            if (this.ui.monthGoto) await this.ui.monthGoto(key); // the key watcher re-preps the edits
        },
        get expenseGroups () {
            if (!this.month) return [];
            return this.month.groups
                .filter((g) => g.kind === 'expense')
                .map((g) => ({ groupId: g.groupId, title: g.title }));
        },
        /**
         * A draft's destination groups: expense groups always; income groups
         * join for credits (negative amounts) - a payroll deposit publishes
         * as a real income row. An income group already selected stays
         * listed even if the amount is edited positive, so nothing dangles.
         */
        destGroups (e) {
            if (!this.month) return [];
            const credit = FinEngine.num(e.amount) < 0;
            return this.month.groups
                .filter((g) => g.kind === 'expense'
                    || (g.kind === 'income' && (credit || g.groupId === e.groupId)))
                .map((g) => ({ groupId: g.groupId, title: g.title }));
        },

        // ------------------------------------------------------- lifecycle

        init () {
            // consumeReveal is DEFERRED in both watchers: a badge click sets
            // inboxReveal and opens the modal in one flush, so both fire
            // together - synchronous consumption would let this watcher's
            // tab reset land AFTER the reveal picked its tab. After the
            // flush, whichever queued callback runs first consumes; the
            // other finds the reveal cleared and no-ops.
            this.$watch('open', (v) => {
                if (!v) return;
                this.importing = false;
                this.csv = null;
                this.tab = 'review';
                this.prepareEdits();
                this.loadSfStatus();
                this.$nextTick(() => this.consumeReveal());
            });
            // a badge click while the modal is ALREADY open still reveals
            this.$watch('ui.inboxReveal', (v) => { if (v && this.open) this.$nextTick(() => this.consumeReveal()); });
            // prefills are month-specific (merge targets live in the month)
            this.$watch('key', () => {
                this.edits = {};
                if (this.open) this.prepareEdits();
            });
            window.addEventListener('db-refreshed', () => { if (this.open) this.prepareEdits(); });
        },

        /**
         * Build the per-draft edit state: a standing rule pre-selects its
         * destination; otherwise the account's default group plus a loose
         * merge suggestion. Everything is just pre-selection - the user
         * confirms each row individually (every action also teaches a rule,
         * which a bulk action never could).
         */
        prepareEdits () {
            if (!this.month) return;
            const taken = new Set();
            for (const e of Object.values(this.edits)) { if (e.targetId) taken.add(e.targetId); }
            for (const item of this.pendingItems) {
                if (this.edits[item.id]) continue;
                const rule = FinImporter.findRule(this.imports, item.accountId, item.label);
                const acct = this.accounts.find((a) => a.id === item.accountId);
                const fallback = this.expenseGroups[0] ? this.expenseGroups[0].groupId : '';
                // a credit's default depends on the SOURCE: on a bank account
                // it's usually real income (payroll) → first income group; on
                // a CARD (acct.credit) it's a payment or refund, never income
                // → the account's expense group, as a negative expense. A RULE
                // still wins either way, and every correction teaches one.
                const incomeGroup = FinEngine.num(item.amount) < 0 && !(acct && acct.credit)
                    ? this.month.groups.find((g) => g.kind === 'income') : null;
                const groupId = (rule && rule.groupId)
                    || (incomeGroup && incomeGroup.groupId)
                    || (acct && acct.groupId) || fallback;
                let targetId = '';
                if (rule && rule.action === 'merge' && rule.target) {
                    const g = this.month.groups.find((g) => g.groupId === groupId);
                    const t = g && g.fields.find((f) => f.label === rule.target && !f.importId && !taken.has(f.id));
                    if (t) targetId = t.id;
                } else if (!rule) {
                    const s = FinImporter.suggestTarget(this.month, groupId, item, taken);
                    if (s) targetId = s.id;
                }
                if (targetId) taken.add(targetId);
                const date = this.dateLabel(item);
                this.edits[item.id] = {
                    label: item.label + (date ? ' · ' + date : ''),
                    // a STRING, two decimals: bank amounts are cents-exact and
                    // must read that way ("4.50", not the float's "4.5") -
                    // publish parses through num() either way
                    amount: FinEngine.num(item.amount).toFixed(2),
                    groupId,
                    targetId,
                    always: false,
                };
            }
        },

        /**
         * A month row's imported badge was clicked (ui.inboxReveal = item id):
         * land on the right tab, scroll the item into view, and blink it -
         * same spotlight the month view uses for search hits.
         */
        consumeReveal () {
            const id = this.ui.inboxReveal;
            if (!id) return;
            this.ui.inboxReveal = null;
            const item = this.items.find((i) => i.id === id);
            if (!item) return;
            this.importing = false;
            this.tab = this.status(item) === 'pending' ? 'review' : 'processed';
            this.$nextTick(() => {
                // one frame for the modal's own 150ms fade to get on screen
                setTimeout(() => {
                    const el = document.querySelector(`[data-import-item="${id}"]`);
                    if (!el) return;
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.remove('row-blink');
                    void el.offsetWidth; // restart the animation on repeat clicks
                    el.classList.add('row-blink');
                    setTimeout(() => el.classList.remove('row-blink'), 2400);
                }, 180);
            });
        },

        // --------------------------------------------------------- helpers

        dateLabel (item) {
            if (item.date) {
                const [, m, d] = item.date.split('-');
                return `${+m}/${+d}`;
            }
            return item.dateRaw || '';
        },

        accountLabel (id) {
            const a = this.accounts.find((a) => a.id === id);
            return a ? a.label : 'removed account';
        },

        groupTitle (groupId) {
            const def = ((this.db && this.db.settings.groups) || []).find((g) => g.id === groupId);
            return def ? def.title : '';
        },

        /** Merge targets for a draft: the chosen group's rows not already import-filled. */
        targetOptions (e) {
            const g = this.month && this.month.groups.find((x) => x.groupId === e.groupId
                && (x.kind === 'expense' || x.kind === 'income'));
            if (!g) return [];
            return g.fields
                .filter((f) => !f.importId || f.id === e.targetId)
                .map((f) => ({ id: f.id, label: `${f.label || '(unnamed)'} (${fmtExact(f.value)})` }));
        },

        /** The group select moved: a target from the old group would dangle. */
        groupChanged (e) {
            if (e.targetId && !this.targetOptions(e).some((o) => o.id === e.targetId)) e.targetId = '';
        },

        statusChip (item) {
            const st = this.status(item);
            return {
                dismissed: { text: item.auto ? 'auto-dismissed' : 'dismissed', cls: 'bg-zinc-200 text-zinc-500' },
                published: { text: 'added', cls: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
                merged: { text: 'merged', cls: 'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-400' },
            }[st] || { text: st, cls: 'bg-zinc-200 text-zinc-500' };
        },

        whereLabel (item) {
            const st = this.status(item);
            if (st === 'dismissed') return item.auto ? 'by rule' : '';
            const m = this.db.months[item.monthKey];
            const f = m && FinEngine.findField(m, item.fieldId);
            if (!f) return '';
            const g = FinEngine.groupOfField(m, f.id);
            return `“${f.label || 'unnamed'}”${g ? ' in ' + g.title : ''}`
                + (item.monthKey !== this.key ? ` · ${FinEngine.keyLabel(item.monthKey)}` : '');
        },

        ruleLabel (r) {
            if (r.action === 'dismiss') return 'dismiss';
            const g = this.groupTitle(r.groupId);
            if (r.action === 'merge') return `merge into “${r.target || '?'}”${g ? ' in ' + g : ''}`;
            return `add to ${g || 'expenses'}`;
        },

        canRevert (item) { return item.monthKey === this.key && !this.frozen && !this.offline; },

        revertHint (item) {
            if (item.monthKey !== this.key) return `Switch to ${FinEngine.keyLabel(item.monthKey)} to revert this one`;
            if (this.frozen) return 'This month is closed - unlock it first';
            if (this.offline) return 'Offline - reconnect first';
            return item.action === 'merged' ? 'Undo the merge - the row returns to its penciled-in value' : 'Remove the row and return this to drafts';
        },

        // ------------------------------------------------------ persistence

        /** One importsApply round trip; adopts the server's ledger + rev. */
        async apply (ops, rollback) {
            this.busy = true;
            try {
                const res = unwrap(await window.api.importsApply({ ops }));
                this.db.imports = res.imports;
                this.db.meta.rev = res.rev;
                return res;
            } catch (err) {
                if (rollback) rollback();
                showToast(err.message, 'error', 7000);
                return null;
            } finally {
                this.busy = false;
            }
        },

        // ---------------------------------------------------------- actions

        /** Publish or merge, depending on the draft's target selection. */
        async publishItem (item) {
            if (this.offline || this.frozen || this.busy) return;
            const e = this.edits[item.id];
            if (!e) return;
            const amount = FinEngine.num(e.amount);
            let field, action, prev = null;
            if (e.targetId) {
                prev = FinImporter.mergeInto(this.month, item, e.targetId, { amount });
                if (!prev) { showToast('That row no longer exists - pick another.', 'error'); e.targetId = ''; return; }
                field = FinEngine.findField(this.month, e.targetId);
                action = 'merged';
            } else {
                field = FinImporter.publish(this.month, item, { groupId: e.groupId, label: (e.label || '').trim() || item.label, amount });
                if (!field) { showToast('No expense group to publish into.', 'error'); return; }
                action = 'published';
            }
            const ops = [{ op: 'patchItem', id: item.id, set: { status: 'pending', monthKey: this.key, fieldId: field.id, action, prev } }];
            // learn the destination: next month's arrival comes pre-selected
            const match = FinImporter.normalizeMerchant(item.label);
            if (match) {
                ops.push({
                    op: 'saveRule',
                    rule: {
                        accountId: item.accountId, match,
                        action: action === 'merged' ? 'merge' : 'publish',
                        groupId: e.groupId || null,
                        target: action === 'merged' ? (field.label || null) : null,
                    },
                });
            }
            const res = await this.apply(ops, () => FinImporter.revert(this.month, { ...item, fieldId: field.id, action, prev }));
            if (!res) return;
            delete this.edits[item.id];
            showToast(action === 'merged'
                ? `Merged into “${field.label || 'row'}” - Update This Month to save it`
                : 'Row added - Update This Month to save it', 'success', 5000);
        },

        async dismissItem (item) {
            if (this.offline || this.busy) return;
            const e = this.edits[item.id];
            const ops = [{ op: 'patchItem', id: item.id, set: { status: 'dismissed' } }];
            if (e && e.always) {
                const match = FinImporter.normalizeMerchant(item.label);
                if (match) ops.push({ op: 'saveRule', rule: { accountId: item.accountId, match, action: 'dismiss' } });
            }
            const res = await this.apply(ops);
            if (!res) return;
            delete this.edits[item.id];
            showToast(e && e.always ? 'Dismissed - future matches arrive pre-dismissed' : 'Dismissed', 'info', 2500);
        },

        /** Dismissed → back to the drafts. */
        async restoreItem (item) {
            if (this.offline || this.busy) return;
            const res = await this.apply([{ op: 'patchItem', id: item.id, set: { status: 'pending' } }]);
            if (res) { this.prepareEdits(); this.tab = 'review'; }
        },

        /**
         * Undo a publish/merge: ledger first (clearing the pointers), month
         * mutation after - a failed write then changes nothing anywhere.
         */
        async revertItem (item) {
            if (!this.canRevert(item) || this.busy) return;
            const snap = { ...item };
            const res = await this.apply([{ op: 'patchItem', id: item.id, set: { fieldId: null, monthKey: null, action: null, prev: null } }]);
            if (!res) return;
            FinImporter.revert(this.month, snap);
            this.prepareEdits();
            showToast(snap.action === 'merged'
                ? 'Merge undone - the row is back to its penciled-in value'
                : 'Row removed - the item is back in drafts', 'info', 4000);
        },

        // -------------------------------------------------- accounts & rules

        async saveAccount (acct) {
            if (this.offline) return;
            await this.apply([{ op: 'saveAccount', account: { id: acct.id, label: acct.label, groupId: acct.groupId || null, credit: !!acct.credit } }]);
        },

        async addAccount () {
            if (this.offline) return;
            const fallback = this.expenseGroups[0] ? this.expenseGroups[0].groupId : null;
            await this.apply([{ op: 'saveAccount', account: { label: 'New account', groupId: fallback } }]);
        },

        async removeAccount (acct) {
            const okRemove = await confirmDialog({
                title: `Remove “${acct.label || 'account'}”?`,
                body: 'Its imported items and history stay; only the account mapping (and its rules) go. '
                    + 'You can re-create it on the next CSV import.',
                confirmText: 'Remove account', danger: true,
            });
            if (!okRemove) return;
            const ops = [{ op: 'deleteAccount', id: acct.id }];
            for (const r of this.rules.filter((r) => r.accountId === acct.id)) {
                ops.push({ op: 'deleteRule', id: r.id });
            }
            await this.apply(ops);
        },

        async removeRule (rule) {
            if (this.offline) return;
            await this.apply([{ op: 'deleteRule', id: rule.id }]);
        },

        // -------------------------------------------------------- CSV import

        pickFile (ev) {
            const file = ev.target.files && ev.target.files[0];
            ev.target.value = ''; // allow re-picking the same file later
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const rows = FinImporter.parseCsv(String(reader.result || ''));
                if (!rows.length) { showToast('That file looks empty.', 'error'); return; }
                const map = FinImporter.detectColumns(rows);
                const txs = FinImporter.buildTransactions(rows, map);
                this.csv = {
                    fileName: file.name,
                    rows,
                    map,
                    expensesNegative: FinImporter.detectExpensesNegative(txs),
                    accountId: (this.accounts[0] && this.accounts[0].id) || '',
                };
                this.newAcctLabel = '';
                this.importing = true;
            };
            reader.onerror = () => showToast('Could not read that file.', 'error');
            reader.readAsText(file);
        },

        /** Column choices for the mapping selects, labeled by header or sample. */
        get csvColumns () {
            if (!this.csv) return [];
            const first = this.csv.rows[0] || [];
            return first.map((c, i) => ({
                i,
                label: this.csv.map.header
                    ? (String(c).trim() || `Column ${i + 1}`)
                    : `Column ${i + 1} (${String(c).trim().slice(0, 18) || 'empty'})`,
            }));
        },

        get csvTxs () {
            if (!this.csv) return [];
            return FinImporter.applySign(
                FinImporter.buildTransactions(this.csv.rows, this.csv.map),
                this.csv.expensesNegative);
        },

        get csvPreview () { return this.csvTxs.slice(0, 5); },

        async runCsvImport () {
            if (!this.csv || this.busy || this.offline) return;
            let accountId = this.csv.accountId;
            const ops = [];
            if (!accountId) {
                const label = this.newAcctLabel.trim();
                if (!label) { showToast('Name the account this file belongs to.', 'error'); return; }
                accountId = FinEngine.uuid();
                const fallback = this.expenseGroups[0] ? this.expenseGroups[0].groupId : null;
                ops.push({ op: 'saveAccount', account: { id: accountId, label, groupId: fallback } });
            }
            const txs = FinImporter.withFingerprints(this.csvTxs);
            if (!txs.length) { showToast('No transactions found with this column mapping.', 'error'); return; }
            ops.push({
                op: 'addItems',
                accountId,
                items: txs.map((t) => ({ fp: t.fp, date: t.date, dateRaw: t.dateRaw, label: t.label, amount: t.amount })),
            });
            const res = await this.apply(ops);
            if (!res) return;
            this.importing = false;
            this.csv = null;
            this.newAcctLabel = '';
            this.tab = 'review';
            this.prepareEdits();
            showToast(`${res.added} transaction${res.added === 1 ? '' : 's'} imported`
                + (res.skipped ? ` · ${res.skipped} already seen` : ''), 'success', 5000);
        },
    };
}
