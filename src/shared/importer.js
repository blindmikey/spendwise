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

    // ----------------------------------------------------------- XLSX parse

    function xmlDecode (s) {
        return String(s)
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }

    function colIndex (letters) {
        let n = 0;
        for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1;
    }

    async function inflateRaw (bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    /** Minimal ZIP reader: central directory → { path → bytes }. Handles the
        two methods .xlsx actually uses (stored, deflate). */
    async function unzip (bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65557); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('That doesn\'t look like a valid .xlsx file.');
        const count = dv.getUint16(eocd + 10, true);
        let off = dv.getUint32(eocd + 16, true);
        const dec = new TextDecoder();
        const files = new Map();
        for (let n = 0; n < count; n++) {
            if (dv.getUint32(off, true) !== 0x02014b50) break;
            const method = dv.getUint16(off + 10, true);
            const csize = dv.getUint32(off + 20, true);
            const nameLen = dv.getUint16(off + 28, true);
            const extraLen = dv.getUint16(off + 30, true);
            const commentLen = dv.getUint16(off + 32, true);
            const localOff = dv.getUint32(off + 42, true);
            const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
            // the local header's name/extra lengths can differ from the
            // central copies - trust the local ones for the data offset
            const lNameLen = dv.getUint16(localOff + 26, true);
            const lExtraLen = dv.getUint16(localOff + 28, true);
            const start = localOff + 30 + lNameLen + lExtraLen;
            const data = bytes.subarray(start, start + csize);
            if (method === 8) files.set(name, await inflateRaw(data));
            else if (method === 0) files.set(name, data);
            off += 46 + nameLen + extraLen + commentLen;
        }
        return files;
    }

    const cellText = (xml) => (xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map((t) => xmlDecode(t.replace(/<t[^>]*>|<\/t>/g, ''))).join('');

    /**
     * .xlsx (ArrayBuffer/Uint8Array) → rows of strings, like parseCsv. Reads
     * the first worksheet, resolves shared and inline strings; numeric cells
     * come through as their raw text (date serials are handled by parseDate).
     */
    async function parseXlsx (buffer) {
        const files = await unzip(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
        const dec = new TextDecoder();
        const read = (p) => { const b = files.get(p); return b ? dec.decode(b) : ''; };
        const shared = [];
        for (const si of read('xl/sharedStrings.xml').match(/<si[\s>][\s\S]*?<\/si>/g) || []) {
            shared.push(cellText(si));
        }
        const sheetPath = [...files.keys()].filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
        if (!sheetPath) throw new Error('No worksheet found in the .xlsx file.');
        const rows = [];
        for (const rowXml of read(sheetPath).match(/<row[\s>][\s\S]*?<\/row>/g) || []) {
            const row = [];
            for (const cell of rowXml.match(/<c[\s>][\s\S]*?(?:<\/c>|\/>)/g) || []) {
                const ref = /r="([A-Z]+)\d+"/.exec(cell);
                const col = ref ? colIndex(ref[1]) : row.length;
                const type = (/\st="([^"]+)"/.exec(cell) || [])[1] || 'n';
                let value;
                if (type === 'inlineStr') {
                    value = cellText(cell);
                } else {
                    const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell);
                    value = v ? xmlDecode(v[1]) : '';
                    if (type === 's') value = shared[Number(value)] !== undefined ? shared[Number(value)] : '';
                }
                row[col] = value;
            }
            for (let i = 0; i < row.length; i++) { if (row[i] === undefined) row[i] = ''; }
            if (row.some((c) => String(c).trim() !== '')) rows.push(row);
        }
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

    /** ISO / US dates (and Excel date serials) → 'YYYY-MM-DD'; else null. */
    function parseDate (s) {
        const t = String(s == null ? '' : s).trim();
        let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t); // 2026-10-04, 2026/10/4
        if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
        m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(t);   // 10/4/2026, 10-04-26
        if (m) {
            const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
            return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
        }
        // Excel stores dates as day counts from 1900 (.xlsx cells): accept a
        // bare serial in the sane modern range, 1970..2099
        if (/^\d{5}(\.\d+)?$/.test(t)) {
            const serial = Number(t);
            if (serial >= 25569 && serial < 73050) {
                return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
            }
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
                        // sfin (the SimpleFIN binding) and credit (card flag)
                        // only change when explicitly sent - a rename from the
                        // UI must not sever or reset them
                        if (a.sfin !== undefined) existing.sfin = a.sfin;
                        if (a.credit !== undefined) existing.credit = !!a.credit;
                    } else {
                        const fresh = { id: a.id || E().uuid(), label: String(a.label || ''), groupId: a.groupId || null };
                        if (a.sfin !== undefined) fresh.sfin = a.sfin;
                        if (a.credit !== undefined) fresh.credit = !!a.credit;
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

    /**
     * The month an item BELONGS to, by its transaction date (falling back to
     * when it was imported), clamped to months that exist in the db - a
     * transaction older than the books lands in the earliest month, a
     * post-dated one in the latest, so no item is ever unreachable. This is
     * the viewing scope; `item.monthKey` (where a publish landed) is set at
     * publish time and under month scoping the two coincide.
     */
    function homeMonthKey (db, item) {
        let k = String(item.date || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(k)) k = String(item.added || '').slice(0, 7);
        const keys = E().monthKeys(db);
        if (!keys.length || (db.months && db.months[k])) return k;
        if (k < keys[0]) return keys[0];
        if (k > keys[keys.length - 1]) return keys[keys.length - 1];
        // a gap inside the history (months are normally contiguous): clamp down
        for (let i = keys.length - 1; i >= 0; i--) { if (keys[i] < k) return keys[i]; }
        return keys[0];
    }

    /** Drafts awaiting review - all of them, or only one month's (monthKey). */
    function pendingCount (db, monthKey) {
        const items = (db && db.imports && db.imports.items) || [];
        let n = 0;
        for (const i of items) {
            if (effectiveStatus(db, i) !== 'pending') continue;
            if (monthKey && homeMonthKey(db, i) !== monthKey) continue;
            n += 1;
        }
        return n;
    }

    // ------------------------------------------------------ month mutations

    /** Publish/merge destinations: expense groups, and income groups (for
        credits - the ledger keeps credits negative, income rows positive).
        Unknown ids fall back to the first expense group. */
    function targetGroup (month, groupId) {
        const ok = (g) => g.kind === E().KIND.EXPENSE || g.kind === E().KIND.INCOME;
        const groups = (month.groups || []).filter(ok);
        return groups.find((g) => g.groupId === groupId)
            || groups.find((g) => g.kind === E().KIND.EXPENSE)
            || groups[0] || null;
    }

    /** Ledger amount (credits negative) → the value a row of this kind stores
        (income rows hold positive values). */
    function rowValue (kind, amount) {
        return kind === E().KIND.INCOME ? -num(amount) : num(amount);
    }

    /**
     * Publish: materialize the draft as a REAL row - an expense, or income
     * when the chosen group is income-kind (a payroll credit). accounted is
     * set - a bank transaction already happened - and importId backlinks the
     * item, which is both the badge and the derived-status anchor.
     */
    function publish (month, item, { groupId, label, amount }) {
        const g = targetGroup(month, groupId);
        if (!g) return null;
        const f = E().newField(g.kind);
        f.label = String(label || item.label || '');
        f.value = rowValue(g.kind, amount);
        f.accounted = true;
        f.importId = item.id;
        g.fields.push(f);
        return f;
    }

    /**
     * Merge: fill an existing row (the penciled-in "Electric", or an income
     * group's "Paycheck") with the bank's actual figure. The row keeps its
     * label; prev is returned for revert.
     */
    function mergeInto (month, item, fieldId, { amount }) {
        const f = E().findField(month, fieldId);
        if (!f) return null;
        const g = E().groupOfField(month, fieldId);
        const prev = { value: num(f.value), accounted: E().truthy(f.accounted) };
        f.value = rowValue(g ? g.kind : E().KIND.EXPENSE, amount);
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
        const g = targetGroup(month, groupId);
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
        detectDelimiter, parseCsv, parseXlsx, parseAmount, parseDate, detectColumns,
        buildTransactions, detectExpensesNegative, applySign, withFingerprints,
        normalizeMerchant,
        ensureImports, findRule, applyOps,
        itemField, effectiveStatus, homeMonthKey, pendingCount,
        publish, mergeInto, revert, suggestTarget,
    };
});
