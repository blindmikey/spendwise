// Stage a linked-but-$0 expense to verify the amber warning renders.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    confirmDialog = async () => true;
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);

    const env = m.month.groups.find((g) => g.kind === 'envelope');
    m.addField(env);
    Object.assign(env.fields[0], { label: 'Freelance Tax', value: 2810, avail: 24033, pinned: true });

    const exp = m.month.groups.find((g) => g.kind === 'expense');
    m.addField(exp);
    Object.assign(exp.fields[0], { label: 'Q2 Fed Est Taxes', value: 0, budgetId: env.fields[0].id });
    m.addField(exp, 0);
    Object.assign(exp.fields[1], { label: 'Q2 State Est Taxes', value: 2080, budgetId: env.fields[0].id });

    await wait(600);
    const inputs = [...document.querySelectorAll('input[type=number]')];
    const flagged = inputs.filter((i) => i.className.includes('ring-amber-400'));
    document.querySelectorAll('[x-data^="monthView"] section')[3].scrollIntoView({ block: 'center' });
    await wait(500);
    return {
        amberFlaggedInputs: flagged.length,
        envelopeSpent: m.effSpent(env.fields[0]),
    };
})();
