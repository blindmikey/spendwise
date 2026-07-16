// Measure UI settle time when assigning/unassigning an expense to a budget.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settled = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(1000);

    const expGroup = m.month.groups.find((g) => g.kind === 'expense' && g.fields.length);
    const field = expGroup.fields.find((f) => !f.budgetId) || expGroup.fields[0];
    const envelope = m.month.groups.find((g) => g.kind === 'envelope' && g.fields.length).fields[0];

    const timings = [];
    for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        field.budgetId = (i % 2 === 0) ? envelope.id : null;
        await settled();
        timings.push(Math.round(performance.now() - t0));
    }
    return { field: field.label, timingsMs: timings };
})();
