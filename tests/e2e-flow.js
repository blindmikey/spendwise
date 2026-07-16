/*
 * End-to-end driver, executed inside the running app (renderer main world) by
 * main.js when FINANCES_E2E points at this file. Exercises the real stack:
 * Alpine UI state → preload IPC → engine → lowdb on disk.
 * Returns [{ name, pass, detail }] which main logs as JSON.
 */
(async () => {
    const results = [];
    const assert = (name, cond, detail) =>
        results.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });

    try {
        // auto-accept every confirm dialog
        confirmDialog = async () => true;

        const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
        for (let i = 0; i < 50 && !m.month; i++) await new Promise((r) => setTimeout(r, 100));
        assert('data loaded', !!m.month, m.key);
        assert('4 default groups', m.month.groups.length === 4, m.month.groups.map((g) => g.kind).join(','));

        const income = m.month.groups.find((g) => g.kind === 'income');
        const env = m.month.groups.find((g) => g.kind === 'envelope');
        const goal = m.month.groups.find((g) => g.kind === 'goal');
        const exp = m.month.groups.find((g) => g.kind === 'expense');

        // ---- populate the month --------------------------------------
        m.addField(income);
        Object.assign(income.fields[0], { label: 'Paycheck', value: 3000, pinned: true });
        m.addField(env);
        Object.assign(env.fields[0], { label: 'Grocery', value: 500, avail: 500, pinned: true });
        m.addField(goal);
        Object.assign(goal.fields[0], { label: 'Car Insurance', value: 100, avail: 0, target: 600, pinned: true });
        m.addField(exp);
        Object.assign(exp.fields[0], { label: 'Rent', value: 1200, pinned: true });
        m.addField(exp, 0);
        Object.assign(exp.fields[1], { label: 'Groceries run', value: 560, budgetId: env.fields[0].id });
        await new Promise((r) => setTimeout(r, 0)); // let the linkedMap watcher flush

        // ---- live avail tracking ---------------------------------------
        // raising the monthly allotment tops the envelope up immediately
        env.fields[0].value = 600;
        await new Promise((r) => setTimeout(r, 0));
        assert('raising allotment raises available live', env.fields[0].avail === 600, env.fields[0].avail);
        env.fields[0].value = 500;
        await new Promise((r) => setTimeout(r, 0));
        assert('lowering allotment lowers available live', env.fields[0].avail === 500, env.fields[0].avail);

        // ---- live math ------------------------------------------------
        // income 3000 − envelope (500 + 60 overage) − goal 100 − rent 1200 = 1140
        assert('overspent envelope flagged', m.overBudget(env.fields[0]) === true);
        assert('net counts overage once, linked expense excluded', m.net === 1140, m.net);
        m.month.startingSavings = 5000;
        assert('savings = start + net', m.currentSavings === 6140, m.currentSavings);
        assert('goal progress 0%', m.progress(goal.fields[0]).pct === 0);

        // ---- dropdown placeholder integrity ------------------------------
        // Alpine drops the value ATTRIBUTE for empty-string bindings; if the
        // placeholder option has none, choosing "—" commits its TEXT into
        // budgetId (truthy + dangling = expense vanishes from both pockets).
        await new Promise((r) => setTimeout(r, 50));
        const anyOption = document.querySelector('select[title="Draw this expense from an envelope"] option');
        assert('placeholder option has a real value attribute', anyOption && anyOption.hasAttribute('value') && anyOption.value === '');
        const sel = document.querySelector('select[title="Draw this expense from an envelope"]');
        const garbage = document.createElement('option');
        garbage.textContent = '—'; // no value attr → value falls back to text
        sel.appendChild(garbage);
        sel.value = '—';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 50));
        assert('garbage select values are rejected, not stored', exp.fields[0].budgetId === null, exp.fields[0].budgetId);
        garbage.remove();

        // ---- save + optimistic concurrency ----------------------------
        await m.save();
        assert('save clears dirty flag', !m.isDirty);
        const stale = await window.api.saveMonth({ key: m.key, month: FinEngine.clone(m.month), expectedRev: 999 });
        assert('stale rev rejected', stale.ok === false && /stale/i.test(stale.error), stale.error);

        // ---- close out -------------------------------------------------
        const firstKey = m.key;
        await m.closeOut();
        assert('advanced to next month', m.key === FinEngine.nextKey(firstKey), m.key);
        assert('previous month closed', m.db.months[firstKey].status === 'closed');
        assert('closingSavings recorded', m.db.months[firstKey].closingSavings === 6140, m.db.months[firstKey].closingSavings);

        const env2 = m.month.groups.find((g) => g.kind === 'envelope');
        const goal2 = m.month.groups.find((g) => g.kind === 'goal');
        const exp2 = m.month.groups.find((g) => g.kind === 'expense');
        assert('default mode: no overspend penalty next month', env2.fields[0].avail === 500, env2.fields[0].avail);
        assert('goal accumulates allotment', goal2.fields[0].avail === 100, goal2.fields[0].avail);
        assert('unpinned expense dropped, pinned kept', exp2.fields.length === 1 && exp2.fields[0].label === 'Rent');
        assert('next startingSavings = closing savings', m.month.startingSavings === 6140, m.month.startingSavings);
        assert('savings history recorded', m.db.savingsHistory[firstKey] === 5000 && m.db.savingsHistory[m.key] === 6140);

        // ---- goal reached + empty budget -------------------------------
        goal2.fields[0].avail = 600;
        assert('goal reached at target', m.progress(goal2.fields[0]).reached === true);
        assert('goal at cap contributes nothing', m.contrib(goal2, goal2.fields[0]) === 0);
        goal2.fields[0].spent = 600; // goal used up → headroom reopens
        assert('spending reopens contributions same month', m.contrib(goal2, goal2.fields[0]) === 100);
        goal2.fields[0].spent = 0;
        goal2.fields[0].avail = 100;

        m.addField(env2);
        Object.assign(env2.fields[1], { label: 'Vacation', value: 0, avail: 250 });
        await m.removeField(env2, env2.fields[1]); // stubbed confirm → "Return to Income & remove"
        const returned = m.month.groups.find((g) => g.kind === 'income').fields
            .find((f) => f.label === 'Returned from budget: Vacation');
        assert('deleting a funded envelope can return balance to income',
            !!returned && returned.value === 250 && returned.tags.length === 0
            && !!returned.returnedFrom && FinEngine.num(returned.returnBase) === 250);

        m.addField(env2);
        Object.assign(env2.fields[env2.fields.length - 1], { label: 'Old Fund', value: 0, avail: 90 });
        confirmDialog = async () => 'alt'; // choose "Discard balance"
        await m.removeField(env2, env2.fields[env2.fields.length - 1]);
        confirmDialog = async () => true;
        assert('deleting can also discard the balance',
            !env2.fields.some((f) => f.label === 'Old Fund')
            && !m.month.groups.find((g) => g.kind === 'income').fields.some((f) => f.label === 'Returned from budget: Old Fund'));

        // ---- tags -------------------------------------------------------
        const rent = exp2.fields[0];
        m.toggleTagEditor(rent);
        m.newTag = 'housing';
        m.addTag(rent);
        assert('tag added + normalized', rent.tags.includes('housing'));
        await new Promise((r) => setTimeout(r, 200)); // let the tag sync settle
        await m.save();

        // ---- scheduled goal: due date drives the deposit ------------------
        m.addField(goal2);
        const sched = goal2.fields[goal2.fields.length - 1];
        const dueNext = FinEngine.nextKey(m.key);
        Object.assign(sched, { label: 'Garbage Bill', target: 120, freqMonths: 12 });
        sched.dueKey = dueNext;
        await new Promise((r) => setTimeout(r, 50)); // schedule watcher materializes
        assert('scheduled goal materializes its deposit', sched.value === 60 && sched.avail === 60,
            { value: sched.value, avail: sched.avail });
        assert('scheduled deposit is the month charge', m.contrib(goal2, sched) === 60);
        m.removeField(goal2, sched); // clean up (returnable 0 → silent delete)
        await new Promise((r) => setTimeout(r, 50));

        // ---- auto-funded envelope (SE-tax-style rule) --------------------
        const grocery2 = env2.fields[0];
        const incomeGid = m.month.groups.find((g) => g.kind === 'income').groupId;
        m.toggleAutoEditor(grocery2);
        m.setAutoPct(grocery2, 33);
        m.toggleAutoGroup(grocery2, incomeGid);
        await new Promise((r) => setTimeout(r, 0));
        // August income: paycheck 3000 + returned 250 = 3250 → 33% = 1073
        assert('auto-funded value derived live', m.rateOf(grocery2) === 1073, m.rateOf(grocery2));
        assert('auto flag active', m.isAuto(grocery2) === true);
        assert('auto rate change adjusts available live', grocery2.avail === 500 + (1073 - 500), grocery2.avail);
        await m.save();
        const disk = await window.api.loadDb();
        const diskGroc = FinEngine.findField(disk.data.months[m.key], grocery2.id);
        assert('auto value materialized on save', diskGroc && diskGroc.value === 1073, diskGroc && diskGroc.value);
        m.clearAuto(grocery2);
        grocery2.value = 500;
        await new Promise((r) => setTimeout(r, 0));
        assert('clearing auto restores available', grocery2.avail === 500, grocery2.avail);
        await m.save();

        // ---- keyboard shortcuts: undo / redo / save ----------------------
        const rentField = exp2.fields[0];
        const rentBefore = rentField.value;
        rentField.value = 4444;
        await new Promise((r) => setTimeout(r, 500)); // let the history step record
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        await new Promise((r) => setTimeout(r, 100));
        assert('Ctrl+Z reverts the last edit', m.month.groups.find((g) => g.kind === 'expense').fields[0].value === rentBefore,
            m.month.groups.find((g) => g.kind === 'expense').fields[0].value);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
        await new Promise((r) => setTimeout(r, 100));
        assert('Ctrl+Y re-applies it', m.month.groups.find((g) => g.kind === 'expense').fields[0].value === 4444);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        await new Promise((r) => setTimeout(r, 100));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        await new Promise((r) => setTimeout(r, 300));
        assert('Ctrl+S saves the month', !m.isDirty);

        // ---- edit a closed month + recompute forward --------------------
        await m.goto(firstKey);
        assert('closed month is read-only', m.key === firstKey && m.readonly === true);
        await m.unlock();
        assert('unlock enables editing', m.unlocked === true && m.readonly === false);

        m.month.groups.find((g) => g.kind === 'income').fields[0].value = 3200; // +200
        const nextK = FinEngine.nextKey(firstKey);
        const beforeStart = m.db.months[nextK].startingSavings;
        await m.saveClosed();
        const afterStart = m.db.months[nextK].startingSavings;
        assert('recompute propagated +200 to next month', afterStart === beforeStart + 200, { beforeStart, afterStart });
        assert('recompute summary modal shown', Alpine.store('ui').modals.recompute === true);
        assert('relocked after recompute save', m.readonly === true);
        Alpine.store('ui').modals.recompute = false;

        // ---- backups -----------------------------------------------------
        const backups = await window.api.listBackups();
        assert('automatic backups taken', backups.ok && backups.backups.length >= 2, backups.backups.length);

        // ---- initial-savings setting drives the whole chain ---------------
        const settings2 = FinEngine.clone(m.db.settings);
        settings2.initialSavings = 9000; // first month was seeded at 5000
        const resIS = await window.api.saveSettings({ settings: settings2, expectedRev: m.db.meta.rev });
        assert('initial savings updates first month',
            resIS.ok && resIS.data.months[firstKey].startingSavings === 9000,
            resIS.ok && resIS.data.months[firstKey].startingSavings);
        assert('initial savings shifts later months by the difference',
            resIS.data.months[nextK].startingSavings === afterStart + 4000,
            resIS.data.months[nextK].startingSavings);
        assert('initial savings change reports recompute summary', resIS.changes.length >= 1);
        Alpine.store('data').db = resIS.data;
        m.snapshot();

        // back to the open month for the final screenshot; let the DOM paint
        await m.goto(nextK);
        await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
        results.push({ name: 'UNCAUGHT', pass: false, detail: String(err && err.stack || err) });
    }

    const failed = results.filter((r) => !r.pass);
    return { total: results.length, failed: failed.length, results: failed.length ? results : results.map((r) => r.name + ' ✓') };
})();
