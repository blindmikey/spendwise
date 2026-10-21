/* global Alpine, FinEngine, FinImporter */
'use strict';

const E = FinEngine;

let _fmt = null;
function fmt (value) {
    if (!_fmt) {
        const currency = (Alpine.store('data').db?.settings?.currency) || 'USD';
        _fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
    }
    return _fmt.format(E.num(value));
}

// The app rounds to whole dollars everywhere, but places that answer "what was
// the recorded figure?" (search results) must not: $394.90 searched by its
// cents can't come back as $395. Whole amounts still read as whole.
let _fmtExact = null;
function fmtExact (value) {
    const n = E.num(value);
    if (Number.isInteger(n)) return fmt(n);
    if (!_fmtExact) {
        const currency = (Alpine.store('data').db?.settings?.currency) || 'USD';
        _fmtExact = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 });
    }
    return _fmtExact.format(n);
}

function fmtSigned (value) {
    const n = E.num(value);
    return (n > 0 ? '+' : '') + fmt(n);
}

/**
 * Number inputs under x-model.number: a paste changes the model in one jump,
 * so Alpine writes the parsed float back and "11.20" snaps to "11.2" (typing
 * survives only because the last keystroke doesn't change the number). After
 * Alpine's flush, put the user's exact text back when it's the same amount.
 */
function keepPastedText (e) {
    const el = e.target;
    const text = ((e.clipboardData && e.clipboardData.getData('text')) || '').trim();
    if (!text) return;
    // Alpine's write-back can land across more than one flush wave, so check a
    // few times until it settles; any further typing by the user wins instantly
    let skips = 1; // the paste's own input event
    let done = false;
    const onInput = () => { if (skips-- > 0) return; done = true; el.removeEventListener('input', onInput); };
    el.addEventListener('input', onInput);
    const restore = () => {
        if (done || el.value === text) return;
        if (Number(el.value) === Number(text)) el.value = text;
    };
    requestAnimationFrame(restore);
    setTimeout(restore, 120);
    setTimeout(() => { restore(); el.removeEventListener('input', onInput); }, 300);
}

function showToast (message, type = 'info', timeout = 3500) {
    const t = Alpine.store('ui').toast;
    t.message = message;
    t.type = type;
    t.timeout = timeout;
    t.show = true;
    clearTimeout(window._toastTimeout);
    window._toastTimeout = setTimeout(() => { t.show = false; }, timeout);
}

/**
 * Promise-based confirm dialog backed by the shared modal in index.html.
 * confirmDialog({ title, body, confirmText, danger, altText, list }) → Promise
 * Resolves true (confirm), false (cancel), or 'alt' when the optional
 * secondary action (altText) is chosen.
 * `list`: optional [{ label, detail }] rendered between body and buttons as
 * a bordered list that caps at ~5 rows and scrolls beyond.
 */
function confirmDialog (opts) {
    return new Promise((resolve) => {
        const c = Alpine.store('ui').confirm;
        c.title = opts.title || 'Are you sure?';
        c.body = opts.body || '';
        c.confirmText = opts.confirmText || 'Confirm';
        c.cancelText = opts.cancelText || 'Cancel';
        c.altText = opts.altText || null;
        c.list = Array.isArray(opts.list) && opts.list.length ? opts.list : null;
        c.danger = !!opts.danger;
        c.open = true;
        c.resolve = (answer) => { c.open = false; c.resolve = null; resolve(answer); };
    });
}

/**
 * SimpleFIN connection controls, shared by the Settings panel (which owns
 * connect/disconnect) and the import inbox (sync button + status): spread
 * `...simplefinControls()` into the component. Expects the host component to
 * expose `db` and `ui` getters; an optional afterSfSync(res) hook runs after
 * a sync lands. The setup token goes straight to the backend and is never
 * stored or echoed in the renderer - all it ever learns is "connected".
 */
function simplefinControls () {
    return {
        sf: { loaded: false, connected: false, lastSync: null, busy: false, token: '' },

        async loadSfStatus () {
            if (!window.api.simplefinStatus) return;
            try {
                const res = unwrap(await window.api.simplefinStatus());
                this.sf.connected = res.connected;
                this.sf.lastSync = res.lastSync;
                this.sf.loaded = true;
                this.ui.sfConnected = res.connected; // the sidebar button keys on this
            } catch { /* the panel just shows the connect form */ }
        },

        sfLastSyncLabel () {
            if (!this.sf.lastSync) return 'never synced';
            try { return 'last sync ' + new Date(this.sf.lastSync).toLocaleString(); } catch { return ''; }
        },

        async connectSf () {
            const token = this.sf.token.trim();
            if (!token || this.sf.busy || this.ui.offline) return;
            this.sf.busy = true;
            try {
                unwrap(await window.api.simplefinSetup({ token }));
                this.sf.token = '';
                this.sf.connected = true;
                this.ui.sfConnected = true;
                showToast('Connected to SimpleFIN', 'success');
                await this.syncSf();
            } catch (e) {
                showToast(e.message, 'error', 9000);
            } finally {
                this.sf.busy = false;
            }
        },

        async syncSf () {
            if (!this.sf.connected || this.ui.offline) return;
            this.sf.busy = true;
            try {
                const res = unwrap(await window.api.simplefinSync({}));
                this.db.imports = res.imports;
                this.db.meta.rev = res.rev;
                this.sf.lastSync = new Date().toISOString();
                if (this.afterSfSync) this.afterSfSync(res);
                showToast(`Synced ${res.accounts} account${res.accounts === 1 ? '' : 's'}: `
                    + `${res.added} new` + (res.skipped ? ` · ${res.skipped} already seen` : ''), 'success', 5000);
                for (const w of res.warnings || []) showToast(String(w), 'error', 8000);
            } catch (e) {
                showToast(e.message, 'error', 9000);
            } finally {
                this.sf.busy = false;
            }
        },

        async disconnectSf () {
            const okOff = await confirmDialog({
                title: 'Disconnect SimpleFIN?',
                body: 'The stored access credential is deleted. Imported items, accounts, and rules all stay - '
                    + 'reconnect anytime with a fresh setup token.',
                confirmText: 'Disconnect',
            });
            if (!okOff) return;
            try {
                unwrap(await window.api.simplefinDisconnect());
                this.sf.connected = false;
                this.sf.lastSync = null;
                this.ui.sfConnected = false;
                showToast('SimpleFIN disconnected', 'info');
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },
    };
}

/**
 * Read a bank export file (CSV or .xlsx) into rows for the import inbox's
 * mapping step. Used by the Settings "Import transactions" button; the
 * parsed rows are handed to the inbox via ui.inboxCsv.
 */
function readBankFile (file) {
    return new Promise((resolve, reject) => {
        if (/\.xls$/i.test(file.name)) {
            return reject(new Error('Legacy .xls isn\'t supported - save it as .xlsx or CSV.'));
        }
        const isXlsx = /\.xlsx$/i.test(file.name);
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.onload = async () => {
            try {
                const rows = isXlsx
                    ? await FinImporter.parseXlsx(reader.result)
                    : FinImporter.parseCsv(String(reader.result || ''));
                if (!rows.length) return reject(new Error('That file looks empty.'));
                resolve({ fileName: file.name, rows });
            } catch (e) {
                reject(e);
            }
        };
        if (isXlsx) reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
    });
}

/** Unwrap an IPC response; throws on { ok: false } and shows nothing itself. */
function unwrap (res) {
    if (!res || res.ok !== true) throw new Error(res && res.error || 'Unknown error');
    return res;
}

/** Shared prop plumbing for x-components: parent attributes become reactive data. */
function xProps (el, defaults = {}) {
    const parent = el.parentElement;
    const data = { ...defaults };
    for (const attr of parent.getAttributeNames()) data[attr] = parent.getAttribute(attr);
    return {
        ...data,
        _initProps () {
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === 'attributes') this[m.attributeName] = parent.getAttribute(m.attributeName);
                }
            });
            observer.observe(parent, { attributes: true });
        },
    };
}

function boolAttr (value) {
    return !(value === '0' || value === 'false' || value === 'null' || value === false || value === undefined || value === null || value === '');
}
