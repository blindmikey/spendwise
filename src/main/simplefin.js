/*
 * SimpleFIN Bridge client: the live source that feeds the import inbox
 * (shared/importer.js). Electron-free, node-side only - the renderer never
 * talks to SimpleFIN (its CSP forbids it) and never sees the access URL.
 *
 * Protocol (https://www.simplefin.org/protocol.html):
 *  - the user gets a SETUP TOKEN from bridge.simplefin.org: base64 of a
 *    one-time claim URL
 *  - POST the claim URL once → the permanent ACCESS URL, with credentials
 *    embedded (https://user:pass@host/simplefin)
 *  - GET {access}/accounts?start-date=... with Basic auth → accounts, each
 *    with transactions { id, posted, amount, description, payee, pending? }
 *
 * The access URL is a read-only credential to transaction data; it is kept
 * in db.imports.simplefin and stripped from every snapshot that leaves the
 * process (see api-core), the same way settings.auth never travels.
 */
'use strict';

const TIMEOUT_MS = 30000;

/**
 * Accept what users actually paste: a setup token (base64 claim URL), a bare
 * claim URL, or a ready access URL (credentials@host). Returns
 * { kind: 'access', url } or { kind: 'claim', url }.
 */
export function parseSetupInput (input) {
    const t = String(input || '').trim();
    if (!t) throw new Error('Paste your SimpleFIN setup token first.');
    if (/^https?:\/\//i.test(t)) {
        return t.includes('@') ? { kind: 'access', url: t } : { kind: 'claim', url: t };
    }
    let decoded = '';
    try { decoded = Buffer.from(t, 'base64').toString('utf8').trim(); } catch { /* falls through */ }
    if (/^https?:\/\//i.test(decoded)) {
        return decoded.includes('@') ? { kind: 'access', url: decoded } : { kind: 'claim', url: decoded };
    }
    throw new Error('That doesn\'t look like a SimpleFIN setup token or URL.');
}

/** Split an access URL into a credential-free base + Basic auth header.
    (fetch refuses URLs with embedded credentials, so they must be lifted.) */
export function accessParts (accessUrl) {
    let u;
    try { u = new URL(accessUrl); } catch { throw new Error('Invalid SimpleFIN access URL.'); }
    const user = decodeURIComponent(u.username || '');
    const pass = decodeURIComponent(u.password || '');
    u.username = '';
    u.password = '';
    const base = u.toString().replace(/\/+$/, '');
    const headers = {};
    if (user || pass) headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    return { base, headers };
}

/** One-time claim: POST the claim URL, the body is the access URL. */
export async function claimAccessUrl (claimUrl, fetchImpl = fetch) {
    let res;
    try {
        res = await fetchImpl(claimUrl, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
        throw new Error(`Can't reach SimpleFIN - ${(e.cause && e.cause.code) || e.message}`);
    }
    const body = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//i.test(body)) {
        throw new Error('SimpleFIN rejected the setup token - tokens are single-use, so get a fresh one from your SimpleFIN account.');
    }
    return body;
}

/** GET /accounts with transactions since startDate (unix seconds). */
export async function fetchAccounts (accessUrl, { startDate, fetchImpl = fetch } = {}) {
    const { base, headers } = accessParts(accessUrl);
    const q = startDate ? `?start-date=${Math.floor(startDate)}` : '';
    let res;
    try {
        res = await fetchImpl(`${base}/accounts${q}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
        throw new Error(`Can't reach SimpleFIN - ${(e.cause && e.cause.code) || e.message}`);
    }
    if (res.status === 403 || res.status === 401) {
        throw new Error('SimpleFIN refused the stored credentials - reconnect with a fresh setup token.');
    }
    if (!res.ok) throw new Error(`SimpleFIN error (HTTP ${res.status}).`);
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.accounts)) throw new Error('SimpleFIN sent an unexpected response.');
    return data;
}

/**
 * SimpleFIN accounts → ledger-ready batches for importer.applyOps.
 * Pending transactions are skipped (only posted ever enters the ledger),
 * amounts flip sign (SimpleFIN outflows are negative; the ledger keeps
 * expenses positive), and the fingerprint is the BANK's transaction id -
 * stable across syncs, so re-syncing never duplicates.
 */
export function toLedgerBatches (accounts) {
    const out = [];
    for (const a of accounts || []) {
        const org = (a.org && a.org.name) || '';
        const label = org && a.name && !a.name.includes(org) ? `${org} ${a.name}` : (a.name || org || 'Account');
        const items = [];
        for (const t of a.transactions || []) {
            if (t.pending === true) continue;
            const amount = -Number(t.amount);
            if (!Number.isFinite(amount)) continue;
            const posted = Number(t.posted) || 0;
            const date = posted ? new Date(posted * 1000).toISOString().slice(0, 10) : null;
            items.push({
                fp: `sf:${t.id}`,
                date,
                dateRaw: date || '',
                label: String(t.payee || t.description || t.memo || 'Transaction').trim(),
                amount,
            });
        }
        out.push({ sfinId: String(a.id), label, items });
    }
    return out;
}
