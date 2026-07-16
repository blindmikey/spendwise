/*
 * Web-preview shim: when the renderer runs in a plain browser (dev-server.mjs)
 * instead of Electron, window.api is provided over HTTP. Never loaded by the
 * Electron build - the dev server injects the <script> tag when serving.
 */
'use strict';

if (!window.api) {
    window.IS_WEB = true; // renderer is running in a browser, not Electron
    const call = (method) => async (payload) => {
        const res = await fetch('/api/' + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
        });
        if (res.status === 401) {
            // session expired - reload lands on the server's login page
            window.location.reload();
            return { ok: false, error: 'Signed out - reloading…' };
        }
        return res.json();
    };
    window.api = {
        loadDb: call('loadDb'),
        rev: call('rev'),
        // routed by the dev preview server; the production web server only
        // exposes auth via its own /api/login (password mgmt is desktop-only)
        authHas: call('authHas'),
        authVerify: call('authVerify'),
        authSet: call('authSet'),
        saveMonth: call('saveMonth'),
        saveClosedMonth: call('saveClosedMonth'),
        closeMonth: call('closeMonth'),
        saveSettings: call('saveSettings'),
        applyTagsEverywhere: call('applyTagsEverywhere'),
        listBackups: call('listBackups'),
        restoreBackup: call('restoreBackup'),
        openBackupsFolder: call('openBackupsFolder'),
        exportDb: call('exportDb'),
        changeDbLocation: call('changeDbLocation'),
        migrateScan: call('migrateScan'),
        migrateLegacy: call('migrateLegacy'),
        checkUpdate: call('checkUpdate'),
        // no shell here: the browser opens the release page itself
        openReleases: async () => {
            window.open('https://github.com/blindmikey/spendwise/releases/latest', '_blank', 'noopener,noreferrer');
            return { ok: true };
        },
    };
}
