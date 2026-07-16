// Differential probe: which kind of mutation is slow?
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const macro = () => new Promise((r) => setTimeout(r, 0));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    const expGroup = m.month.groups.find((g) => g.kind === 'expense' && g.fields.length);
    const field = expGroup.fields.find((f) => !f.budgetId) || expGroup.fields[0];
    const envelope = m.month.groups.find((g) => g.kind === 'envelope' && g.fields.length).fields[0];

    const timeIt = async (fn) => {
        const t0 = performance.now();
        fn();
        await macro();
        return Math.round(performance.now() - t0);
    };

    const out = {};
    out.throwawayProp = await timeIt(() => { field._probe = (field._probe || 0) + 1; });
    out.labelChange = await timeIt(() => { field.label = field.label + ' '; });
    out.valueChange = await timeIt(() => { field.value = FinEngine.num(field.value) + 1; });
    out.budgetIdChange = await timeIt(() => { field.budgetId = envelope.id; });
    out.budgetIdClear = await timeIt(() => { field.budgetId = null; });
    out.otherMonthChange = await timeIt(() => {
        const keys = FinEngine.monthKeys(m.db);
        const other = m.db.months[keys[0]];
        other.startingSavings = FinEngine.num(other.startingSavings);
        other._probe = (other._probe || 0) + 1;
    });
    // repeat throwaway to check warmup effects
    out.throwawayAgain = await timeIt(() => { field._probe += 1; });
    return out;
})();
