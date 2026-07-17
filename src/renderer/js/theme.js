/*
 * Appearance: sets `html.dark` from the saved preference so the dark palette
 * in app.css applies. Loaded synchronously at the top of <head> (the app's CSP
 * forbids inline scripts) so the class is on the element before first paint -
 * no light-to-dark flash.
 *
 * The preference lives in localStorage, not the database: it is a per-device
 * choice, and the same db.json is shared between the desktop app, the web
 * server, and other machines - one person's dark mode must not follow the data.
 *
 *   spendwise-theme = 'system' | 'light' | 'dark'   (default 'system')
 *
 * window.Theme is the small API the Settings control drives.
 */
'use strict';

(function () {
    var KEY = 'spendwise-theme';
    var mq = window.matchMedia('(prefers-color-scheme: dark)');

    function pref () {
        try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
    }
    function isDark (p) {
        return p === 'dark' || (p === 'system' && mq.matches);
    }
    function apply () {
        document.documentElement.classList.toggle('dark', isDark(pref()));
    }

    window.Theme = {
        get: pref,
        set: function (p) {
            try { localStorage.setItem(KEY, p); } catch (e) { /* private mode - session only */ }
            apply();
        },
        resolved: function () { return isDark(pref()) ? 'dark' : 'light'; },
    };

    // follow the OS while on 'system'
    mq.addEventListener('change', function () { if (pref() === 'system') apply(); });

    apply();
}());
