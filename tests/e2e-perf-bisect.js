// Bisect the budget-change latency by removing DOM regions and re-measuring.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settled = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(1000);

    const expGroup = m.month.groups.find((g) => g.kind === 'expense' && g.fields.length);
    const field = expGroup.fields.find((f) => !f.budgetId) || expGroup.fields[0];
    const envelope = m.month.groups.find((g) => g.kind === 'envelope' && g.fields.length).fields[0];

    const measure = async () => {
        const runs = [];
        for (let i = 0; i < 2; i++) {
            const t0 = performance.now();
            field.budgetId = (field.budgetId ? null : envelope.id);
            await settled();
            runs.push(Math.round(performance.now() - t0));
        }
        return Math.round(runs.reduce((a, b) => a + b) / runs.length);
    };

    const out = {};
    out.baseline = await measure();

    // 1: remove all budget dropdowns
    document.querySelectorAll('select[title="Draw this expense from an envelope"]').forEach((s) => s.remove());
    await wait(300);
    out.withoutSelects = await measure();

    // 2: also remove the big Budgets group section (45 envelope rows)
    const sections = [...document.querySelectorAll('[x-data^="monthView"] section')];
    const budgets = sections.find((s) => /budgets/i.test(s.querySelector('header span')?.textContent || ''));
    if (budgets) budgets.remove();
    await wait(300);
    out.withoutBudgetsSection = await measure();

    // 3: also remove every remaining group section
    document.querySelectorAll('[x-data^="monthView"] section').forEach((s) => s.remove());
    await wait(300);
    out.withoutAllGroups = await measure();

    return out;
})();
