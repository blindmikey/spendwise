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
        locked: false, // app-password lock screen (desktop only - web logs in at the server)
        offline: false, // web only: no server → read-only until it's back
        switching: false, // month change rendering: hides main, shows "loading…"
        settingsDirty: false, // mirrored by settingsView for the unsaved-changes gate
        currentKey: null,
        unlockedKeys: [],
        savedSnapshot: '',
        monthGoto: null, // set by monthView: header picker → goto(key)
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
            cancelText: 'Cancel', altText: null, danger: false, resolve: null,
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

function appRoot () {
    return {
        async init () {
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
                if (['month', 'insights', 'settings'].includes(saved.view)) ui.view = saved.view;
                ui.savedSnapshot = JSON.stringify(res.data.months[ui.currentKey]);
                // desktop privacy lock; web clients authenticated at the server
                ui.locked = !!(res.data.settings && res.data.settings.auth) && !window.IS_WEB;

                // reactive persistence: fires on any view/month change, whatever
                // its origin (nav, header picker, close-out advancing the month)
                Alpine.effect(() => {
                    const snap = JSON.stringify({ view: ui.view, key: ui.currentKey });
                    try { localStorage.setItem(SCREEN_KEY, snap); } catch (e) { /* private mode - session only */ }
                });
            } catch (e) {
                showToast('Failed to load data: ' + e.message, 'error', 12000);
            }
            this.watchConnection();
            this.startPolling();
            this.guardUnsaved();
            this.checkUpdate(); // deliberately not awaited - never delays first paint
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
                if (!window.__unsavedSummary()) return;
                e.preventDefault();
                e.returnValue = ''; // required by older browsers to trigger the prompt
            });
        },

        /**
         * A web client needs the server for every read and write, so losing it
         * puts the app in read-only rather than letting edits pile up with
         * nowhere to go. The desktop app talks to its own process - it is
         * never offline, even with the network down.
         */
        watchConnection () {
            if (!window.IS_WEB) return;
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
                if (!data.loaded || ui.locked) return;
                let r;
                try {
                    r = await window.api.rev();
                } catch {
                    if (window.IS_WEB) ui.offline = true; // server unreachable
                    return;
                }
                if (window.IS_WEB && r.ok) ui.offline = false;
                try {
                    if (!r.ok || r.rev === data.db.meta.rev) return;
                    const cur = ui.currentKey && data.db.months[ui.currentKey];
                    if (cur && JSON.stringify(cur) !== ui.savedSnapshot) return; // dirty - don't clobber
                    const res = unwrap(await window.api.loadDb());
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
    };
}
