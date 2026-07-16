// Control: how slow is a double-rAF with NO mutation? And how fast does the
// reactive flush itself complete (setTimeout 0 after microtasks)?
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const macro = () => new Promise((r) => setTimeout(r, 0));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    const expGroup = m.month.groups.find((g) => g.kind === 'expense' && g.fields.length);
    const field = expGroup.fields.find((f) => !f.budgetId) || expGroup.fields[0];
    const envelope = m.month.groups.find((g) => g.kind === 'envelope' && g.fields.length).fields[0];

    const out = {};

    let t0 = performance.now();
    await raf2();
    out.rafOnlyNoMutationMs = Math.round(performance.now() - t0);

    t0 = performance.now();
    field.budgetId = envelope.id;
    await macro();
    out.mutationFlushMs = Math.round(performance.now() - t0);

    t0 = performance.now();
    field.budgetId = null;
    await raf2();
    out.mutationRafMs = Math.round(performance.now() - t0);

    return out;
})();
