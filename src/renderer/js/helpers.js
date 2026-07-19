/* global Alpine, FinEngine */
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

function fmtSigned (value) {
    const n = E.num(value);
    return (n > 0 ? '+' : '') + fmt(n);
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
