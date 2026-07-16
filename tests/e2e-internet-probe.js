// Reproduce the user's exact report: unlink "Internet" from Utilities in the
// open month; do net / liquid savings / expenses-total move?
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    let internet = null, expGroup = null;
    for (const g of m.month.groups) {
        if (g.kind !== 'expense') continue;
        const f = g.fields.find((f) => /^internet/i.test(f.label));
        if (f) { internet = f; expGroup = g; break; }
    }
    if (!internet) return { error: 'Internet row not found', month: m.key };

    const utilities = FinEngine.findField(m.month, internet.budgetId);
    const sample = () => ({
        net: m.net,
        savings: m.currentSavings,
        expensesTotal: m.groupTotal(expGroup),
        engineExpensesTotal: FinEngine.groupTotal(m.month, expGroup),
        utilitiesEff: utilities ? FinEngine.effectiveSpent(m.month, utilities) : null,
        utilitiesOverage: utilities ? FinEngine.overage(m.month, utilities) : null,
    });

    const out = {
        month: m.key,
        internetValue: internet.value,
        internetValueType: typeof internet.value,
        budgetId: internet.budgetId,
        budgetIdType: typeof internet.budgetId,
        linkedTo: utilities ? utilities.label : '(dangling!)',
        utilitiesAvail: utilities ? utilities.avail : null,
        groupKind: expGroup.kind,
        groupTitle: expGroup.title,
    };
    out.linked = sample();
    internet.budgetId = null;
    await wait(150);
    out.unlinked = sample();
    return out;
})();
