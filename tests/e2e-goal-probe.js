// Probe the capped-contribution suffix rendering.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    confirmDialog = async () => true;
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);

    const goal = m.month.groups.find((g) => g.kind === 'goal');
    m.addField(goal);
    Object.assign(goal.fields[0], { label: 'Car Insurance', value: 50, avail: 560, target: 600, pinned: true });
    await wait(500);

    const field = goal.fields[0];
    const spans = [...document.querySelectorAll('[x-data^="monthView"] .text-\\[11px\\]')];
    return {
        contrib: m.contrib(goal, field),
        rateOf: m.rateOf(field),
        cmp: m.contrib(goal, field) < m.rateOf(field),
        renderedTexts: spans.map((s) => s.textContent.trim()).filter(Boolean),
    };
})();
