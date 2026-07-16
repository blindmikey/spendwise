// Does linking a real (non-zero) expense to an envelope move "This Month"
// (net) and the liquid savings figure, in state AND in the rendered DOM?
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    // pick an unlinked expense with a real value, and an envelope with headroom
    let expense = null;
    for (const g of m.month.groups) {
        if (g.kind !== 'expense') continue;
        expense = g.fields.find((f) => !f.budgetId && FinEngine.num(f.value) >= 50) || expense;
    }
    let envelope = null;
    for (const g of m.month.groups) {
        if (g.kind !== 'envelope') continue;
        envelope = g.fields.find((f) =>
            FinEngine.num(f.avail) - FinEngine.effectiveSpent(m.month, f) > FinEngine.num(expense.value) + 100) || envelope;
    }

    const domNet = () => document.querySelectorAll('aside section')[1].querySelector('.text-3xl').textContent.trim();
    const domSavings = () => document.querySelectorAll('aside section')[0].querySelector('.text-3xl').textContent.trim();
    const sample = () => ({
        net: m.net, savings: m.currentSavings, withBudgets: m.withBudgets,
        domNet: domNet(), domSavings: domSavings(),
        envelopeAvail: FinEngine.num(envelope.avail),
        envelopeSpent: m.effSpent(envelope),
    });

    const out = { expense: expense.label.trim(), value: expense.value, envelope: envelope.label.trim() };
    out.before = sample();
    expense.budgetId = envelope.id;
    await wait(150);
    out.linked = sample();
    expense.budgetId = null;
    await wait(150);
    out.unlinked = sample();
    return out;
})();
