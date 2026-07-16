// Verify budget dropdowns show their saved selection on FIRST render (no interaction).
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800); // settle: no interactions, just initial render

    const out = [];
    for (const g of m.month.groups) {
        if (g.kind !== 'expense') continue;
        for (const f of g.fields) {
            if (!f.budgetId) continue;
            const row = document.querySelector(`[x-data^="monthView"] select[title="Draw this expense from an envelope"]`);
            // find THIS field's select by walking rows
            const selects = [...document.querySelectorAll('select[title="Draw this expense from an envelope"]')];
            const sel = selects.find((s) => s.value === f.budgetId) ||
                selects.find((s) => s.closest('div.mb-2\\.5')?.querySelector('input[type=text]')?.value === f.label);
            out.push({
                label: f.label.trim(),
                budgetId: !!f.budgetId,
                selectShows: sel ? (sel.selectedOptions[0] ? sel.selectedOptions[0].text : '(none)') : '(select not found)',
                valueMatches: sel ? sel.value === f.budgetId : false,
            });
            if (out.length >= 6) break;
        }
        if (out.length >= 6) break;
    }
    return out;
})();
