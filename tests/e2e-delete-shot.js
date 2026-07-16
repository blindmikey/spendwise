// Open the delete-choice dialog on a funded envelope for a screenshot.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(600);

    const env = m.month.groups.find((g) => g.kind === 'envelope' && g.fields.length);
    const funded = env.fields.find((f) => m.envelopeLeft(f) > 0);
    m.removeField(env, funded); // not awaited — leaves the dialog open
    await wait(600);
    return { dialogOpen: Alpine.store('ui').confirm.open, field: funded.label.trim() };
})();
