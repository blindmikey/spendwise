/* global Alpine, FinEngine, showToast, unwrap */
'use strict';

document.addEventListener('alpine:init', () => {
    Alpine.store('data', {
        loaded: false,
        path: '',
        version: '',
        db: null,
        // update check: { available, latest, url, unreachable, enabled }
        update: { available: false, latest: null, url: '', checking: false, checked: false },
    });

    Alpine.store('ui', {
        view: 'month', // month | insights | settings
        onboarding: false, // first-run wizard (fresh db - see onboarding.js)
        locked: false, // app-password lock screen (desktop only - web logs in at the server)
        // header auth control: 'web' | 'remote' → Log out, 'lock' → re-lock, null → hidden
        authKind: null,
        remoteGate: false, // locked variant: sign in to the saved remote host
        remoteHost: '',
        searchOpen: false, // Ctrl+K field search across all months
        offline: false, // web only: no server → editing continues, saving pauses
        switching: false, // month change rendering: hides main, shows "loading…"
        closingMonth: false, // close-out in flight: the rev poll must not interleave
        settingsDirty: false, // mirrored by settingsView for the unsaved-changes gate
        currentKey: null,
        unlockedKeys: [],
        savedSnapshot: '',
        monthGoto: null, // set by monthView: header picker → goto(key)
        revealField: null, // set by monthView: search hit → collapse-others + scroll + blink
        recomputeChanges: [],
        importSummary: null,
        importMap: { folder: '', groups: [] },
        modals: {
            recompute: false,
            importMap: false,
            importSummary: false,
            backups: false,
            confirm: false,
        },
        confirm: {
            open: false, title: '', body: '', confirmText: 'Confirm',
            cancelText: 'Cancel', altText: null, list: null, danger: false, resolve: null,
        },
        toast: { show: false, message: '', type: 'info', timeout: 3500 },
    });
});

// Last screen (view + month) survives reload. localStorage, not the database:
// like the theme, it is per-device state - the same db.json is shared between
// the desktop app, the web server and other machines, and one screen's
// position must not follow the data.
const SCREEN_KEY = 'spendwise-last-screen';

function loadScreen () {
    try { return JSON.parse(localStorage.getItem(SCREEN_KEY)) || {}; } catch (e) { return {}; }
}

// The screen is also mirrored into the URL hash (#month/2026-05, #insights,
// #settings) so the browser's back/forward buttons walk the navigation
// history. Hash, not path: it needs no server routing and works under
// file:// in the desktop app.
const VIEWS = ['month', 'insights', 'settings'];

function hashFor (view, key) {
    return view === 'month' && key ? `#month/${key}` : `#${view}`;
}

/**
 * pushState/replaceState resolve a bare '#hash' against the <base> element,
 * and the web server injects <base href="/renderer/"> for asset paths - a
 * bare push would rewrite the address to /renderer/#... (which even 404s on
 * reload). Pinning to the document's own path keeps the address bar at /#...
 */
function setHash (method, hash) {
    history[method](null, '', location.pathname + location.search + hash);
}

function parseHash () {
    const [view, key] = location.hash.replace(/^#\/?/, '').split('/');
    if (!VIEWS.includes(view)) return null;
    return { view, key: view === 'month' && /^\d{4}-\d{2}$/.test(key || '') ? key : null };
}

function appRoot () {
    return {
        async init () {
            // remote db with no live session (logged out, token expired or
            // undecryptable): the password gate, not a failed load. The reload
            // after signing in runs init() fresh.
            if (window.IS_REMOTE) {
                try {
                    const st = unwrap(await window.api.remoteStatus());
                    Alpine.store('ui').remoteHost = st.host || '';
                    if (st.needsLogin) {
                        Alpine.store('ui').locked = true;
                        Alpine.store('ui').remoteGate = true;
                        return;
                    }
                } catch { /* status unavailable - the load below reports it */ }
            }
            try {
                const res = unwrap(await window.api.loadDb());
                const data = Alpine.store('data');
                data.db = res.data;
                data.path = res.path;
                data.version = res.version || '';
                data.loaded = true;

                const ui = Alpine.store('ui');
                const keys = FinEngine.monthKeys(res.data);
                const open = keys.filter((k) => res.data.months[k].status === 'open');
                const saved = loadScreen(); // restore last screen, but only what still exists
                ui.currentKey = res.data.months[saved.key] ? saved.key
                    : open.length ? open[open.length - 1] : keys[keys.length - 1];
                if (VIEWS.includes(saved.view)) ui.view = saved.view;
                // a URL hash outranks the remembered screen (reload, shared link)
                const fromHash = parseHash();
                if (fromHash) {
                    ui.view = fromHash.view;
                    if (fromHash.key && res.data.months[fromHash.key]) ui.currentKey = fromHash.key;
                }
                ui.savedSnapshot = JSON.stringify(res.data.months[ui.currentKey]);
                // desktop privacy lock; web clients authenticated at the server
                // web clients log in at the server; remote desktop authenticated
                // at connect time - only a purely local db uses the lock screen
                ui.locked = !!(res.data.settings && res.data.settings.auth) && !window.IS_WEB && !window.IS_REMOTE;
                // header auth control: web and remote sessions can log out;
                // a passworded local db can re-lock; otherwise nothing shows.
                // The dev preview is "web" with no auth at all - no control.
                ui.authKind = window.IS_WEB ? (window.IS_DEV_PREVIEW ? null : 'web')
                    : window.IS_REMOTE ? 'remote'
                        : (res.data.settings && res.data.settings.auth) ? 'lock' : null;
                // a never-touched database gets the first-run wizard
                ui.onboarding = isFreshDb(res.data);

                // reactive persistence: fires on any view/month change, whatever
                // its origin (nav, header picker, close-out advancing the month).
                // Also mirrors the screen into the hash - replace on this first
                // run (booting isn't a navigation), push after that. popstate
                // needs no loop guard: by the time the effect fires, the hash
                // the browser restored already equals the desired one.
                let booting = true;
                Alpine.effect(() => {
                    const snap = JSON.stringify({ view: ui.view, key: ui.currentKey });
                    try { localStorage.setItem(SCREEN_KEY, snap); } catch (e) { /* private mode - session only */ }
                    const desired = hashFor(ui.view, ui.currentKey);
                    if (location.hash !== desired) {
                        setHash(booting ? 'replaceState' : 'pushState', desired);
                    }
                    booting = false;
                });

                // back/forward: re-apply the screen the hash describes. The
                // month switch runs through monthGoto's unsaved-edits guard -
                // on cancel (or a stale key) the URL is re-aligned with reality.
                window.addEventListener('popstate', async () => {
                    const target = parseHash();
                    if (!target || !data.loaded) return;
                    if (target.view !== ui.view) ui.view = target.view;
                    if (target.key && target.key !== ui.currentKey
                        && data.db.months[target.key] && ui.monthGoto) {
                        await ui.monthGoto(target.key);
                    }
                    const desired = hashFor(ui.view, ui.currentKey);
                    if (location.hash !== desired) setHash('replaceState', desired);
                });
            } catch (e) {
                // a dead remote session (server restarted, token revoked)
                // becomes the password gate rather than a broken screen
                if (window.IS_REMOTE && /session expired/i.test(e.message || '')) {
                    Alpine.store('ui').locked = true;
                    Alpine.store('ui').remoteGate = true;
                    return;
                }
                showToast('Failed to load data: ' + e.message, 'error', 12000);
            }
            this.watchConnection();
            this.startPolling();
            this.guardUnsaved();
            this.checkUpdate(); // deliberately not awaited - never delays first paint
        },

        /**
         * The header auth control. 'lock' just re-covers the screen (state
         * stays put); web/remote log out for real - the session is revoked
         * and the reload lands on the login page / password gate. Logging
         * out reloads, so unsaved edits get an explicit discard confirm.
         */
        async authAction () {
            const ui = Alpine.store('ui');
            if (ui.authKind === 'lock') { ui.locked = true; return; }
            const unsaved = window.__unsavedSummary && window.__unsavedSummary();
            if (unsaved) {
                const okOut = await confirmDialog({
                    title: 'Log out with unsaved changes?',
                    body: `Unsaved edits to ${unsaved} will be discarded.`,
                    confirmText: 'Discard & log out', danger: true,
                });
                if (!okOut) return;
            }
            window.__skipUnsavedGuard = true; // the browser prompt would double-ask
            try {
                if (ui.authKind === 'remote') await window.api.remoteLogout();
                else await window.api.logout();
            } catch { /* revocation is best-effort - the reload enforces the gate */ }
            window.location.reload();
        },

        /**
         * Ask the main/server process whether a newer release is tagged. Any
         * failure is a non-event: no toast, no error, the app does not need
         * GitHub. The nudge is a dot on the settings gear plus a line in
         * Settings - never a modal in the way of the books.
         */
        async checkUpdate ({ force = false } = {}) {
            const data = Alpine.store('data');
            data.update.checking = true;
            try {
                const res = unwrap(await window.api.checkUpdate({ force }));
                data.update = {
                    ...res,
                    checking: false,
                    checked: true,
                    available: !!res.available,
                };
                if (res.available) {
                    showToast(`Spend Wise ${res.latest} is available - see Settings`, 'info', 8000);
                }
            } catch {
                data.update.checking = false;
                data.update.checked = true;
                data.update.unreachable = true;
            }
        },

        async openReleases () {
            try { await window.api.openReleases(); } catch { /* nothing to do */ }
        },

        /**
         * Nothing is written until you press Update, so closing or reloading
         * with edits in flight would drop them silently.
         *
         * The web gets the browser's own leave-confirmation. Electron does NOT:
         * a beforeunload handler that returns a value there just cancels the
         * close without asking, so the desktop is gated in the main process
         * instead (main.js), which calls the hook below.
         */
        guardUnsaved () {
            window.__unsavedSummary = () => {
                const data = Alpine.store('data');
                const ui = Alpine.store('ui');
                if (!data.loaded || !data.db) return null;
                const cur = ui.currentKey && data.db.months[ui.currentKey];
                const monthDirty = !!cur && JSON.stringify(cur) !== ui.savedSnapshot;
                if (!monthDirty && !ui.settingsDirty) return null;
                const parts = [];
                if (monthDirty) parts.push(FinEngine.keyLabel(ui.currentKey));
                if (ui.settingsDirty) parts.push('Settings');
                return parts.join(' and ');
            };
            if (!window.IS_WEB) return;
            window.addEventListener('beforeunload', (e) => {
                if (window.__skipUnsavedGuard) return; // logout already confirmed the discard
                if (!window.__unsavedSummary()) return;
                e.preventDefault();
                e.returnValue = ''; // required by older browsers to trigger the prompt
            });
        },

        /**
         * A web client - or a desktop app on a remote database - needs the
         * server to persist anything, so losing it pauses saving (and the
         * immediate-persist ops: tags, close-out, unlock) while local editing
         * continues - the save-time merge reconciles with anything another
         * session did in the meantime. Only a desktop app on its own local
         * file is never offline.
         */
        watchConnection () {
            if (!window.IS_WEB && !window.IS_REMOTE) return;
            const ui = Alpine.store('ui');
            ui.offline = navigator.onLine === false;
            // instant signal for a dropped network; the rev poll below is what
            // catches "connected to wifi, but the server is gone"
            window.addEventListener('offline', () => { ui.offline = true; });
            window.addEventListener('online', () => { ui.offline = false; });
        },

        /**
         * Co-editing freshness: when another session bumps the rev while this
         * one has no unsaved edits, quietly reload. With edits in flight we
         * leave the screen alone - the merge happens at save time instead.
         */
        startPolling () {
            if (this._pollTimer || !window.api.rev) return;
            this._pollTimer = setInterval(async () => {
                const data = Alpine.store('data');
                const ui = Alpine.store('ui');
                if (!data.loaded || ui.locked || ui.closingMonth) return;
                const networked = window.IS_WEB || window.IS_REMOTE;
                let r;
                try {
                    r = await window.api.rev();
                } catch {
                    if (networked) ui.offline = true; // server unreachable (web fetch throws)
                    return;
                }
                if (networked && r.ok) ui.offline = false;
                // remote mode reports failures as { ok: false } through IPC
                // rather than throwing - an unreachable host reads as offline,
                // anything else (e.g. an expired session) surfaces on save
                if (!r.ok) {
                    if (networked && /can't reach/i.test(r.error || '')) ui.offline = true;
                    return;
                }
                try {
                    if (r.rev === data.db.meta.rev) return;
                    const cur = ui.currentKey && data.db.months[ui.currentKey];
                    if (cur && JSON.stringify(cur) !== ui.savedSnapshot) return; // dirty - don't clobber
                    const res = unwrap(await window.api.loadDb());
                    if (ui.closingMonth) return; // close-out started mid-reload - its result wins
                    data.db = res.data;
                    if (!res.data.months[ui.currentKey]) {
                        const keys = FinEngine.monthKeys(res.data);
                        ui.currentKey = keys[keys.length - 1];
                    }
                    ui.savedSnapshot = JSON.stringify(res.data.months[ui.currentKey]);
                    window.dispatchEvent(new CustomEvent('db-refreshed'));
                } catch { /* transient - next tick retries */ }
            }, 20000);
        },

        switchView (view) {
            Alpine.store('ui').view = view;
        },

        /** Ctrl/Cmd+K anywhere in the app toggles the search modal. In the
            desktop app Ctrl/Cmd+F works too; in a browser F stays the page find. */
        searchHotkey (e) {
            if (!(e.ctrlKey || e.metaKey)) return;
            const k = e.key.toLowerCase();
            if (k !== 'k' && !(k === 'f' && !window.IS_WEB)) return;
            e.preventDefault();
            const ui = Alpine.store('ui');
            if (ui.locked || ui.onboarding || !Alpine.store('data').loaded) return;
            ui.searchOpen = !ui.searchOpen;
        },
    };
}

/**
 * Ctrl+K search: matches field labels and tags across EVERY month. Results
 * split into the month being viewed (so "no matches this month" is visible
 * information) and all other months, newest first - the point is seeing, say,
 * every past Costco run even when the current month has none.
 */
function searchView () {
    return {
        q: '',
        current: [],   // hits in ui.currentKey
        others: [],    // hits in every other month, newest first
        active: 0,     // keyboard highlight across current + others
        searched: false, // a debounced run has completed for the current q
        _t: null,

        get all () { return this.current.concat(this.others); },
        get currentLabel () {
            const k = Alpine.store('ui').currentKey;
            return k ? FinEngine.keyLabel(k) : '';
        },

        onInput () {
            clearTimeout(this._t);
            this._t = setTimeout(() => this.run(), 200);
        },

        run () {
            this.active = 0;
            const db = Alpine.store('data').db;
            const q = this.q.trim().toLowerCase();
            this.current = [];
            this.others = [];
            this.searched = !!q;
            if (!db || !q) return;
            const cur = Alpine.store('ui').currentKey;
            // amount queries: "394" finds 394.xx (whole-dollar match, so 3940
            // stays out of the way); "394.9" and "$394.90" narrow by cents
            const qAmt = /^\$?\d[\d,]*(\.\d*)?$/.test(q) ? q.replace(/[$,]/g, '') : null;
            const keys = FinEngine.monthKeys(db).slice().reverse(); // newest first
            for (const key of keys) {
                for (const g of db.months[key].groups) {
                    for (const f of g.fields) {
                        const label = (f.label || '').toLowerCase();
                        const tags = (f.tags || []).join(' ').toLowerCase();
                        const amtHit = qAmt !== null && (qAmt.includes('.')
                            ? FinEngine.num(f.value).toFixed(2).startsWith(qAmt)
                            : Math.trunc(FinEngine.num(f.value)) === +qAmt);
                        if (!label.includes(q) && !tags.includes(q) && !amtHit) continue;
                        (key === cur ? this.current : this.others).push({
                            key,
                            fieldId: f.id,
                            monthLabel: FinEngine.keyLabel(key),
                            group: g.title,
                            label: f.label || '(unnamed)',
                            value: FinEngine.num(f.value),
                            tags: f.tags || [],
                        });
                    }
                }
            }
        },

        move (d) {
            if (!this.all.length) return;
            this.active = (this.active + d + this.all.length) % this.all.length;
        },

        async go (hit) {
            if (!hit) return;
            const ui = Alpine.store('ui');
            ui.searchOpen = false;
            ui.view = 'month';
            if (hit.key !== ui.currentKey && ui.monthGoto) await ui.monthGoto(hit.key);
            // landed on the hit's month (goto may have been cancelled by the
            // unsaved-edits guard) → spotlight the row
            if (hit.key === ui.currentKey && ui.revealField) ui.revealField(hit.fieldId);
        },
    };
}
