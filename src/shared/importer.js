/*!
 * FinImporter - bank-import logic for Spend Wise.
 *
 * Same UMD wrapper as engine.js (renderer <script src>, Electron main ESM,
 * vitest) and the same purity rule: CSV text in, transactions out; ledger
 * ops applied to a db object; month mutations for publish/merge/revert.
 * No I/O here - transports persist, views render.
 *
 * The inbox model: every bank transaction ever seen becomes an ITEM in
 * db.imports.items and stays there forever - the items array doubles as the
 * dedupe ledger (accountId + fingerprint). An item's stored `status` is only
 * 'pending' or 'dismissed'; "published"/"merged" are DERIVED: an item counts
 * as processed only while the month row it points at (fieldId, importId
 * backlink) actually exists. Discarding unsaved month edits therefore
 * returns the item to the draft inbox by itself - the ledger records intent,
 * the month holds the truth.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) { module.exports = factory(); }
    root.FinImporter = factory();
})(globalThis, function () {
    'use strict';

    // engine is loaded everywhere this module is (script order / import order)
    const E = () => globalThis.FinEngine;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    // ------------------------------------------------------------ CSV parse

    /** Pick the delimiter by counting candidates outside quotes on line 1. */
    function detectDelimiter (text) {
        const line = String(text).split(/\r?\n/).find((l) => l.trim()) || '';
        let best = ',', bestCount = -1, inQ = false;
        for (const d of [',', ';', '\t']) {
            let count = 0;
            inQ = false;
            for (const ch of line) {
                if (ch === '"') inQ = !inQ;
                else if (!inQ && ch === d) count += 1;
            }
            if (count > bestCount) { best = d; bestCount = count; }
        }
        return best;
    }

    /** Standard CSV state machine: quotes, "" escapes, CRLF, newlines in quotes. */
    function parseCsv (text, delimiter) {
        const d = delimiter || detectDelimiter(text);
        const rows = [];
        let row = [], cell = '', inQ = false;
        const s = String(text);
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inQ) {
                if (ch === '"') {
                    if (s[i + 1] === '"') { cell += '"'; i += 1; } else inQ = false;
                } else cell += ch;
            } else if (ch === '"') {
                inQ = true;
            } else if (ch === d) {
                row.push(cell); cell = '';
            } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && s[i + 1] === '\n') i += 1;
                row.push(cell); cell = '';
                if (row.some((c) => c.trim() !== '')) rows.push(row);
                row = [];
            } else cell += ch;
        }
        row.push(cell);
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        return rows;
    }

    // ------------------------------------------------------- normalization

    /** '$1,234.56', '(12.34)', '12.34-' → signed number; junk → 0. */
    function parseAmount (s) {
        let t = String(s == null ? '' : s).trim();
        if (!t) return 0;
        let neg = false;
        if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
        if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
        t = t.replace(/[^0-9.\-]/g, '');
        const n = Number(t);
        if (!Number.isFinite(n)) return 0;
        return neg ? -Math.abs(n) : n;
    }

    /** ISO / US dates → 'YYYY-MM-DD'; anything else → null. */
    function parseDate (s) {
        const t = String(s == null ? '' : s).trim();
        let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t); // 2026-10-04, 2026/10/4
        if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
        m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(t);   // 10/4/2026, 10-04-26
        if (m) {
            const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
            return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
        }
        return null;
    }

    const HEADER_WORDS = /^(date|transaction date|posted date|post date|posting date|trans\.? date|description|payee|merchant|memo|name|details|narrative|amount|debit|credit|withdrawal|withdrawals|deposit|deposits|balance|status|category|type|check number|reference)$/i;

    /**
     * Guess the column layout. Returns indexes (-1 = none):
     * { header, date, desc, amount, debit, credit, status }.
     * Headers win when present; otherwise the first data row is probed
     * (date = first date-parsing cell, desc = longest texty cell, amount =
     * first numeric cell). Guesses only pre-fill the mapping UI - the user
     * confirms before anything is imported.
     */
    function detectColumns (rows) {
        const map = { header: false, date: -1, desc: -1, amount: -1, debit: -1, credit: -1, status: -1 };
        if (!rows.length) return map;
        const first = rows[0].map((c) => String(c).trim());
        map.header = first.some((c) => HEADER_WORDS.test(c));

        if (map.header) {
            const find = (re) => first.findIndex((c) => re.test(c));
            map.date = find(/^(date|transaction date|trans\.? date)$/i);
            if (map.date === -1) map.date = find(/^(posted date|post date|posting date)$/i);
            if (map.date === -1) map.date = find(/date/i);
            map.desc = find(/^(description|payee|merchant|name)$/i);
            if (map.desc === -1) map.desc = find(/description|payee|merchant|memo|name|details|narrative/i);
            map.amount = find(/^amount$/i);
            if (map.amount === -1) map.amount = find(/amount/i);
            map.debit = find(/debit|withdrawal/i);
            map.credit = find(/credit|deposit/i);
            map.status = find(/^status$/i);
            // a lone amount column beats a debit/credit pair guess that only half-matched
            if (map.amount !== -1) { if (map.debit === map.amount) map.debit = -1; if (map.credit === map.amount) map.credit = -1; }
            return map;
        }

        // no header: probe the first row
        map.date = first.findIndex((c) => parseDate(c));
        let longest = -1, longestLen = -1;
        first.forEach((c, i) => {
            if (i === map.date) return;
            const texty = /[A-Za-z]{3,}/.test(c);
            if (texty && c.length > longestLen) { longest = i; longestLen = c.length; }
        });
        map.desc = longest;
        map.amount = first.findIndex((c, i) => i !== map.date && i !== map.desc && c !== '' && parseAmount(c) !== 0);
        return map;
    }

    /**
     * Rows + mapping → raw transactions { date, dateRaw, label, amount }.
     * Debit/credit pairs resolve to one signed amount (debit positive).
     * Pending rows (a status column saying so) are skipped - only posted
     * transactions ever enter the ledger. Sign normalization happens later
     * (applySign), once the whole file's convention is known.
     */
    function buildTransactions (rows, map) {
        const out = [];
        const data = map.header ? rows.slice(1) : rows;
        for (const row of data) {
            if (map.status !== -1 && /pending/i.test(String(row[map.status] || ''))) continue;
            const label = String((map.desc !== -1 && row[map.desc]) || '').trim();
            let amount;
            if (map.debit !== -1 || map.credit !== -1) {
                amount = Math.abs(parseAmount(map.debit !== -1 ? row[map.debit] : 0))
                    - Math.abs(parseAmount(map.credit !== -1 ? row[map.credit] : 0));
            } else {
                amount = parseAmount(map.amount !== -1 ? row[map.amount] : 0);
            }
            if (!label && amount === 0) continue;
            const dateRaw = String((map.date !== -1 && row[map.date]) || '').trim();
            out.push({ date: parseDate(dateRaw), dateRaw, label, amount });
        }
        return out;
    }

    /** True when the file reads expenses as negative numbers (the majority). */
    function detectExpensesNegative (txs) {
        let neg = 0, pos = 0;
        for (const t of txs) {
            if (t.amount < 0) neg += 1;
            else if (t.amount > 0) pos += 1;
        }
        return neg > pos;
    }

    /** Normalize to the ledger convention: expenses POSITIVE, credits negative. */
    function applySign (txs, expensesNegative) {
        return txs.map((t) => ({ ...t, amount: expensesNegative ? -t.amount : t.amount }));
    }

    /**
     * Stable identity for dedupe across re-imports: date|amount|label, with an
     * occurrence counter so two identical coffees on one day stay two items
     * (and re-importing an overlapping file still matches one-to-one).
     */
    function withFingerprints (txs) {
        const seen = {};
        return txs.map((t) => {
            const base = `${t.date || t.dateRaw}|${num(t.amount).toFixed(2)}|${t.label.trim().toLowerCase()}`;
            const n = (seen[base] = (seen[base] || 0) + 1);
            return { ...t, fp: n === 1 ? base : `${base}#${n}` };
        });
    }

    /** 'SQ *COFFEE 0423' → 'SQ COFFEE': the match key for rules. */
    function normalizeMerchant (label) {
        return String(label || '').toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // ------------------------------------------------------------- the blob

    function ensureImports (db) {
        if (!db.imports || typeof db.imports !== 'object') db.imports = {};
        for (const k of ['accounts', 'rules', 'items']) {
            if (!Array.isArray(db.imports[k])) db.imports[k] = [];
        }
        return db.imports;
    }

    /** One rule per (account, normalized merchant). */
    function findRule (imports, accountId, label) {
        const match = normalizeMerchant(label);
        return (imports.rules || []).find((r) => r.accountId === accountId && r.match === match) || null;
    }

    // ----------------------------------------------------------- ledger ops

    const PATCHABLE = ['status', 'monthKey', 'fieldId', 'action', 'prev'];

    /**
     * Apply semantic ops to db.imports. No rev gate by design (mirrors tag
     * ops): adds are deduped against the ledger, patches target item ids,
     * accounts/rules upsert - all of it commutes with concurrent edits, so
     * rebasing onto the current state is always correct. The caller persists.
     *
     * Ops:
     *   { op:'addItems', accountId, items:[{ fp, date, dateRaw, label, amount }] }
     *   { op:'patchItem', id, set:{ status?, monthKey?, fieldId?, action?, prev? } }  (null deletes)
     *   { op:'saveAccount', account:{ id?, label, groupId } }
     *   { op:'deleteAccount', id }
     *   { op:'saveRule', rule:{ id?, accountId, match, action, groupId?, target? } }
     *   { op:'deleteRule', id }
     *
     * Returns { added, skipped } (addItems totals).
     */
    function applyOps (db, ops) {
        const imports = ensureImports(db);
        let added = 0, skipped = 0;
        for (const op of ops || []) {
            if (!op || typeof op !== 'object') continue;
            switch (op.op) {
                case 'addItems': {
                    const mine = imports.items.filter((i) => i.accountId === op.accountId);
                    const have = new Set(mine.map((i) => i.fp));
                    // second line of defense behind the fingerprint: some banks
                    // re-issue transaction ids between syncs, which would slip
                    // every line past an id-based fingerprint. Each EXISTING
                    // item grants one content credit (date|amount|label); an
                    // incoming item with an unseen fp consumes a credit instead
                    // of duplicating. Credit-counted, not keyed-once, so two
                    // genuine identical coffees still both import.
                    const contentKey = (x) => `${x.date || x.dateRaw || ''}|${num(x.amount).toFixed(2)}|${String(x.label || '').trim().toLowerCase()}`;
                    const credits = {};
                    for (const i of mine) {
                        const k = contentKey(i);
                        credits[k] = (credits[k] || 0) + 1;
                    }
                    for (const t of op.items || []) {
                        if (!t || !t.fp || have.has(t.fp)) { skipped += 1; continue; }
                        const ck = contentKey(t);
                        if (credits[ck] > 0) { credits[ck] -= 1; skipped += 1; continue; }
                        have.add(t.fp);
                        const item = {
                            id: E().uuid(),
                            accountId: op.accountId,
                            fp: t.fp,
                            date: t.date || null,
                            dateRaw: t.dateRaw || '',
                            label: String(t.label || ''),
                            amount: num(t.amount),
                            added: new Date().toISOString(),
                            status: 'pending',
                        };
                        // standing dismissals (card payments, own-account
                        // transfers) arrive pre-dismissed - visible under
                        // Processed, never cluttering the draft inbox
                        const rule = findRule(imports, op.accountId, item.label);
                        if (rule && rule.action === 'dismiss') {
                            item.status = 'dismissed';
                            item.auto = true;
                        }
                        imports.items.push(item);
                        added += 1;
                    }
                    break;
                }
                case 'patchItem': {
                    const item = imports.items.find((i) => i.id === op.id);
                    if (!item) break;
                    for (const k of PATCHABLE) {
                        if (!op.set || !(k in op.set)) continue;
                        if (op.set[k] === null) delete item[k];
                        else item[k] = op.set[k];
                    }
                    if (item.status === 'pending') delete item.auto; // un-dismissed by hand
                    break;
                }
                case 'saveAccount': {
                    const a = op.account || {};
                    const existing = a.id && imports.accounts.find((x) => x.id === a.id);
                    if (existing) {
                        Object.assign(existing, { label: String(a.label || ''), groupId: a.groupId || null });
                        // sfin (the SimpleFIN account binding) only changes when
                        // explicitly sent - a rename from the UI must not sever it
                        if (a.sfin !== undefined) existing.sfin = a.sfin;
                    } else {
                        const fresh = { id: a.id || E().uuid(), label: String(a.label || ''), groupId: a.groupId || null };
                        if (a.sfin !== undefined) fresh.sfin = a.sfin;
                        imports.accounts.push(fresh);
                    }
                    break;
                }
                case 'deleteAccount':
                    imports.accounts = imports.accounts.filter((a) => a.id !== op.id);
                    break;
                case 'saveRule': {
                    const r = op.rule || {};
                    const match = r.match || '';
                    if (!match) break;
                    const existing = imports.rules.find((x) => x.id === r.id)
                        || imports.rules.find((x) => x.accountId === r.accountId && x.match === match);
                    const clean = {
                        accountId: r.accountId || null,
                        match,
                        action: ['dismiss', 'publish', 'merge'].includes(r.action) ? r.action : 'publish',
                        groupId: r.groupId || null,
                        target: r.target || null,
                    };
                    if (existing) Object.assign(existing, clean);
                    else imports.rules.push({ id: E().uuid(), ...clean });
                    break;
                }
                case 'deleteRule':
                    imports.rules = imports.rules.filter((r) => r.id !== op.id);
                    break;
                default:
                    break;
            }
        }
        return { added, skipped };
    }

    // ------------------------------------------------------- derived status

    /** The month row an item claims - only if it still exists and points back. */
    function itemField (db, item) {
        if (!item || !item.fieldId || !item.monthKey) return null;
        const month = db.months && db.months[item.monthKey];
        if (!month) return null;
        const f = E().findField(month, item.fieldId);
        return f && f.importId === item.id ? f : null;
    }

    /**
     * 'pending' | 'dismissed' | 'published' | 'merged'. Stored status covers
     * the first two; the processed states hold only while the linked row is
     * really there (see the module comment).
     */
    function effectiveStatus (db, item) {
        if (item.status === 'dismissed') return 'dismissed';
        if (itemField(db, item)) return item.action === 'merged' ? 'merged' : 'published';
        return 'pending';
    }

    function pendingCount (db) {
        const items = (db && db.imports && db.imports.items) || [];
        let n = 0;
        for (const i of items) { if (effectiveStatus(db, i) === 'pending') n += 1; }
        return n;
    }

    // ------------------------------------------------------ month mutations

    function expenseGroup (month, groupId) {
        const groups = (month.groups || []).filter((g) => g.kind === E().KIND.EXPENSE);
        return groups.find((g) => g.groupId === groupId) || groups[0] || null;
    }

    /**
     * Publish: materialize the draft as a REAL expense row. accounted is set -
     * a bank transaction already happened - and importId backlinks the item,
     * which is both the badge and the derived-status anchor.
     */
    function publish (month, item, { groupId, label, amount }) {
        const g = expenseGroup(month, groupId);
        if (!g) return null;
        const f = E().newField(E().KIND.EXPENSE);
        f.label = String(label || item.label || '');
        f.value = num(amount);
        f.accounted = true;
        f.importId = item.id;
        g.fields.push(f);
        return f;
    }

    /**
     * Merge: fill an existing row (the penciled-in "Electric") with the bank's
     * actual figure. The row keeps its label; prev is returned for revert.
     */
    function mergeInto (month, item, fieldId, { amount }) {
        const f = E().findField(month, fieldId);
        if (!f) return null;
        const prev = { value: num(f.value), accounted: E().truthy(f.accounted) };
        f.value = num(amount);
        f.accounted = true;
        f.importId = item.id;
        return prev;
    }

    /**
     * Revert a processed item inside its month: published rows are removed,
     * merged rows restored from prev. Returns true when something changed.
     */
    function revert (month, item) {
        const f = E().findField(month, item.fieldId);
        if (!f || f.importId !== item.id) return false;
        if (item.action === 'merged') {
            f.value = item.prev ? num(item.prev.value) : f.value;
            f.accounted = item.prev ? !!item.prev.accounted : f.accounted;
            delete f.importId;
            return true;
        }
        const g = E().groupOfField(month, f.id);
        if (!g) return false;
        g.fields = g.fields.filter((x) => x.id !== f.id);
        return true;
    }

    // ------------------------------------------------------------ matching

    /**
     * No rule yet: suggest a merge target in the mapped group. Deliberately
     * dumb and loose - it only PRE-SELECTS a control the user confirms, so a
     * wrong guess costs one dropdown change. Name overlap beats amount
     * proximity (±30% of a row that has a value and isn't import-filled).
     */
    function suggestTarget (month, groupId, item, takenIds) {
        const g = expenseGroup(month, groupId);
        if (!g) return null;
        const taken = takenIds || new Set();
        const candidates = g.fields.filter((f) => !f.importId && !taken.has(f.id));
        const itemNorm = normalizeMerchant(item.label);
        const itemWords = new Set(itemNorm.split(' ').filter((w) => w.length >= 4));
        for (const f of candidates) {
            const fNorm = normalizeMerchant(f.label);
            if (!fNorm) continue;
            if (itemNorm.includes(fNorm) || fNorm.includes(itemNorm)
                || fNorm.split(' ').some((w) => w.length >= 4 && itemWords.has(w))) return f;
        }
        const amt = Math.abs(num(item.amount));
        if (amt > 0) {
            for (const f of candidates) {
                const v = Math.abs(num(f.value));
                if (v > 0 && Math.abs(v - amt) <= 0.3 * Math.max(v, amt)) return f;
            }
        }
        return null;
    }

    return {
        detectDelimiter, parseCsv, parseAmount, parseDate, detectColumns,
        buildTransactions, detectExpensesNegative, applySign, withFingerprints,
        normalizeMerchant,
        ensureImports, findRule, applyOps,
        itemField, effectiveStatus, pendingCount,
        publish, mergeInto, revert, suggestTarget,
    };
});
