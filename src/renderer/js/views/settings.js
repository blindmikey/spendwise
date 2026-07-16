/* global Alpine, FinEngine, fmt, showToast, confirmDialog, unwrap */
'use strict';

function settingsView (primary = false) {
    return {
        // The same component is reused inside the import and backups modals for
        // its helpers. Only the full-page instance (primary) owns the
        // unsaved-changes gate and the web panel - otherwise the modal copies,
        // holding drafts cloned at page load, fight over ui.settingsDirty and
        // report phantom unsaved settings after any real save bumps the rev.
        primary,
        draft: null,
        backups: [],
        initialUnlocked: false, // opt-in to edit initial savings once history exists

        get db () { return Alpine.store('data').db; },
        get ui () { return Alpine.store('ui'); },
        get dirty () { return !!(this.draft && this.db && JSON.stringify(this.draft) !== JSON.stringify(this.db.settings)); },
        get dbPath () { return Alpine.store('data').path; },

        init () {
            this.reset();
            // db can arrive after init, or be replaced wholesale (import/restore).
            // Watch the revision - NOT `db`: Alpine's $watch JSON.stringifies the
            // watched value on every dependency change, so watching the whole db
            // made every keystroke re-stringify the entire multi-year database.
            this.$watch('db?.meta.rev', () => {
                // primary guards genuine unsaved edits; the modal reuses have
                // none worth keeping, so they always resync to the new settings
                if (!this.primary || !this.dirty) this.reset();
            });
            if (!this.primary) return;
            this.loadWebStatus();
            // sync once (the watch below only fires on change) then mirror to the
            // store so the unsaved-changes gate (app.js) can see draft edits here
            this.ui.settingsDirty = this.dirty;
            this.$watch('dirty', (v) => { this.ui.settingsDirty = v; });
        },

        reset () {
            this.draft = this.db ? FinEngine.clone(this.db.settings) : null;
            this.initialUnlocked = false;
        },

        get monthsCount () { return this.db ? FinEngine.monthKeys(this.db).length : 0; },
        // with real history, the seed is read-only until explicitly unlocked
        get initialLocked () { return this.monthsCount > 1 && !this.initialUnlocked; },

        async unlockInitial () {
            const okEdit = await confirmDialog({
                title: 'Edit initial savings?',
                body: 'This is the seed for your very first month. Changing it rewrites the starting and '
                    + 'closing savings of every month since - you almost never need to touch it after setup.',
                confirmText: 'Let me edit it',
            });
            if (okEdit) this.initialUnlocked = true;
        },

        hotkeys (e) {
            if (this.ui.view !== 'settings' || !(e.ctrlKey || e.metaKey)) return;
            if ((e.key || '').toLowerCase() === 's') {
                e.preventDefault();
                if (this.dirty) this.save();
            }
        },

        kindLabel (kind) {
            return { income: 'Income (+)', expense: 'Expenses (−)', envelope: 'Envelope budgets (−)', goal: 'Goal budgets (−)' }[kind] || kind;
        },

        // ---------------------------------------------------------- groups

        addGroup (kind) {
            const group = { id: FinEngine.uuid(), title: 'New Group', kind, order: this.draft.groups.length };
            if (kind === 'envelope') group.strictOverspend = false; // goals are never strict
            this.draft.groups.push(group);
        },

        move (index, dir) {
            const to = index + dir;
            if (to < 0 || to >= this.draft.groups.length) return;
            const [g] = this.draft.groups.splice(index, 1);
            this.draft.groups.splice(to, 0, g);
            this.draft.groups.forEach((g, i) => { g.order = i; });
        },

        async removeGroup (group) {
            let inUse = false;
            for (const key of FinEngine.monthKeys(this.db)) {
                const inst = this.db.months[key].groups.find((g) => g.groupId === group.id);
                if (inst && inst.fields.length) { inUse = true; break; }
            }
            const okRemove = await confirmDialog({
                title: `Remove group “${group.title}”?`,
                body: inUse
                    ? 'Past months that recorded fields in this group keep their data, but the group disappears from new months. '
                        + 'If its envelopes still hold money, empty them to income first so the ledger stays accurate.'
                    : 'The group is empty everywhere - safe to remove.',
                confirmText: 'Remove group', danger: inUse,
            });
            if (!okRemove) return;
            this.draft.groups = this.draft.groups.filter((g) => g.id !== group.id);
            this.draft.groups.forEach((g, i) => { g.order = i; });
        },

        async save () {
            if (this.ui.offline) return;
            const initialChanged = FinEngine.num(this.draft.initialSavings) !== FinEngine.num(this.db.settings.initialSavings);
            if (initialChanged && this.monthsCount > 1) {
                const okRewrite = await confirmDialog({
                    title: 'Rewrite the savings chain?',
                    body: `Initial savings changes from ${fmt(this.db.settings.initialSavings)} to ${fmt(this.draft.initialSavings)}. `
                        + `Every one of your ${this.monthsCount} months gets its savings figures recomputed from the beginning `
                        + '(a backup is taken first).',
                    confirmText: 'Recompute everything', danger: true,
                });
                if (!okRewrite) return;
            }
            try {
                const res = unwrap(await window.api.saveSettings({
                    settings: FinEngine.clone(this.draft),
                    expectedRev: this.db.meta.rev,
                }));
                Alpine.store('data').db = res.data;
                this.reset();
                this.ui.savedSnapshot = JSON.stringify(res.data.months[this.ui.currentKey]);
                if (res.changes && res.changes.length) {
                    this.ui.recomputeChanges = res.changes;
                    this.ui.modals.recompute = true;
                } else {
                    showToast('Settings saved', 'success');
                }
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },

        // -------------------------------------------------------- updates

        updateCheckEnabled () {
            return !(this.db && this.db.settings && this.db.settings.updateCheck === false); // default on
        },

        /**
         * Saved immediately rather than through the groups draft: the toggle
         * sits away from that form's Save button, so leaving it pending would
         * read as "it didn't take".
         */
        async setUpdateCheck (enabled) {
            if (this.ui.offline) return;
            try {
                const settings = FinEngine.clone(this.db.settings);
                settings.updateCheck = !!enabled;
                const res = unwrap(await window.api.saveSettings({ settings, expectedRev: this.db.meta.rev }));
                Alpine.store('data').db = res.data;
                this.reset();
                if (enabled) {
                    this.checkNow();
                } else {
                    Alpine.store('data').update = { available: false, latest: null, url: '', checking: false, checked: false };
                }
            } catch (e) {
                showToast(e.message, 'error', 7000);
            }
        },

        checkNow () {
            // the root component owns the call; Settings just asks for a fresh one
            const root = document.querySelector('[x-data="appRoot()"]');
            if (root && root._x_dataStack) Alpine.$data(root).checkUpdate({ force: true });
        },

        openReleases () {
            const root = document.querySelector('[x-data="appRoot()"]');
            if (root && root._x_dataStack) Alpine.$data(root).openReleases();
        },

        // ---------------------------------------------------- app password

        pwCurrent: '', pwNew: '', pwConfirm: '',
        get hasPassword () { return !!(this.db && this.db.settings && this.db.settings.auth); },
        get isWeb () { return !!window.IS_WEB; },

        async setPassword () {
            if (!this.pwNew) return showToast('Enter a new password.', 'error');
            if (this.pwNew.length < 4) return showToast('Use at least 4 characters.', 'error');
            if (this.pwNew !== this.pwConfirm) return showToast('The two passwords don’t match.', 'error');
            try {
                const res = unwrap(await window.api.authSet({ current: this.pwCurrent, next: this.pwNew }));
                await this.refreshAuthLocal();
                this.pwCurrent = this.pwNew = this.pwConfirm = '';
                showToast('App password ' + (this.hasPassword ? 'set' : 'removed'), 'success');
                return res;
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        async removePassword () {
            const okRemove = await confirmDialog({
                title: 'Remove the app password?',
                body: 'The app opens without a lock screen, and web access (if enabled) stops until a new password is set.',
                confirmText: 'Remove password', danger: true,
            });
            if (!okRemove) return;
            try {
                unwrap(await window.api.authSet({ current: this.pwCurrent, next: '' }));
                await this.refreshAuthLocal();
                this.pwCurrent = '';
                showToast('App password removed', 'success');
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        /** Pull the fresh auth block + rev without disturbing the draft. */
        async refreshAuthLocal () {
            const fresh = unwrap(await window.api.loadDb());
            for (const target of [this.db.settings, this.draft]) {
                if (!target) continue;
                if (fresh.data.settings.auth) target.auth = FinEngine.clone(fresh.data.settings.auth);
                else delete target.auth;
            }
            this.db.meta.rev = fresh.data.meta.rev;
        },

        // ------------------------------------------------------ web access

        web: { loaded: false, enabled: false, port: 4180, running: false, urls: [], hasPassword: false, trustProxy: 0, secureCookie: false },

        async loadWebStatus () {
            if (this.isWeb || !window.api.webStatus) return; // desktop only
            try {
                Object.assign(this.web, unwrap(await window.api.webStatus()), { loaded: true });
            } catch { /* main process predates web access */ }
        },

        async toggleWeb () {
            try {
                const res = unwrap(await window.api.webSet({ enabled: !this.web.enabled, port: this.web.port, trustProxy: this.web.trustProxy, secureCookie: this.web.secureCookie }));
                Object.assign(this.web, res);
                showToast(res.enabled ? 'Web access is on' : 'Web access is off', 'success');
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        async applyWebPort () {
            if (!this.web.enabled) return;
            try {
                Object.assign(this.web, unwrap(await window.api.webSet({ enabled: true, port: this.web.port, trustProxy: this.web.trustProxy, secureCookie: this.web.secureCookie })));
                showToast('Web access moved to port ' + this.web.port, 'success');
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        // reverse-proxy settings; persisted even while web access is off so
        // they're already in place the next time it's turned on
        async applyWebProxy () {
            try {
                Object.assign(this.web, unwrap(await window.api.webSet({ enabled: this.web.enabled, port: this.web.port, trustProxy: this.web.trustProxy, secureCookie: this.web.secureCookie })));
                showToast('Reverse-proxy settings saved', 'success');
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        // ------------------------------------------------------------ data

        async exportDb () {
            try {
                const res = unwrap(await window.api.exportDb());
                if (res.exported) showToast(`Exported to ${res.exported}`, 'success', 6000);
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        async changeLocation () {
            const okMove = await confirmDialog({
                title: 'Move the database?',
                body: 'Pick a new location for db.json - for example a synced folder (Dropbox, OneDrive) to share data '
                    + 'between machines. Choosing an existing db.json adopts that file instead of overwriting it.',
                confirmText: 'Choose location',
            });
            if (!okMove) return;
            try {
                const res = unwrap(await window.api.changeDbLocation());
                Alpine.store('data').db = res.data;
                Alpine.store('data').path = res.path;
                this.afterDataReplaced();
                showToast(`Database now at ${res.path}`, 'success', 6000);
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        async importLegacy () {
            const okImport = await confirmDialog({
                title: 'Import legacy data?',
                body: 'Select the old finances app’s data folder (the one with files like “january-26”). '
                    + 'You’ll get to review each group’s type before anything is written. '
                    + 'Importing REPLACES the current database - a backup of it is taken first.',
                confirmText: 'Choose folder…', danger: true,
            });
            if (!okImport) return;
            try {
                const res = unwrap(await window.api.migrateScan());
                if (!res.scanned) return;
                this.ui.importMap = { folder: res.folder, groups: res.groups.map((g) => ({ ...g })) };
                this.ui.modals.importMap = true;
            } catch (e) { showToast(e.message, 'error', 9000); }
        },

        async runImport () {
            const map = this.ui.importMap;
            const overrides = Object.fromEntries(map.groups.map((g) => [g.title, g.kind]));
            try {
                const res = unwrap(await window.api.migrateLegacy({ folder: map.folder, overrides }));
                if (!res.imported) return;
                this.ui.modals.importMap = false;
                Alpine.store('data').db = res.data;
                this.afterDataReplaced();
                this.ui.importSummary = res.summary;
                this.ui.modals.importSummary = true;
            } catch (e) { showToast(e.message, 'error', 9000); }
        },

        async loadBackups () {
            try {
                const res = unwrap(await window.api.listBackups());
                this.backups = res.backups;
                this.ui.modals.backups = true;
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        async restoreBackup (backup) {
            const okRestore = await confirmDialog({
                title: `Restore ${backup.name}?`,
                body: 'The current data is backed up first, then replaced by this snapshot.',
                confirmText: 'Restore', danger: true,
            });
            if (!okRestore) return;
            try {
                const res = unwrap(await window.api.restoreBackup({ name: backup.name }));
                Alpine.store('data').db = res.data;
                this.ui.modals.backups = false;
                this.afterDataReplaced();
                showToast('Backup restored', 'success');
            } catch (e) { showToast(e.message, 'error', 7000); }
        },

        openBackupsFolder () { window.api.openBackupsFolder(); },

        /** After the whole db is swapped, re-point the UI at a sensible month. */
        afterDataReplaced () {
            const db = this.db;
            const keys = FinEngine.monthKeys(db);
            const open = keys.filter((k) => db.months[k].status === 'open');
            this.ui.currentKey = open.length ? open[open.length - 1] : keys[keys.length - 1];
            this.ui.unlockedKeys = [];
            this.ui.savedSnapshot = JSON.stringify(db.months[this.ui.currentKey]);
            this.reset();
        },
    };
}
