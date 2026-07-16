// Measure the cost of a JSON.stringify(month) INSIDE a tracked Alpine effect.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const macro = () => new Promise((r) => setTimeout(r, 0));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    const month = Alpine.store('data').db.months[Alpine.store('ui').currentKey];
    const runs = [];
    Alpine.effect(() => {
        const t0 = performance.now();
        JSON.stringify(month);
        runs.push(Math.round((performance.now() - t0) * 10) / 10);
    });

    const smallRuns = [];
    const firstField = month.groups.find((g) => g.fields.length).fields[0];
    Alpine.effect(() => {
        const t0 = performance.now();
        JSON.stringify(firstField);
        smallRuns.push(Math.round((performance.now() - t0) * 100) / 100);
    });

    const field = month.groups.find((g) => g.kind === 'expense').fields[0];
    field._probe = (field._probe || 0) + 1;
    await macro();
    field._probe += 1;
    await macro();

    return { fullMonthStringifyInEffectMs: runs, singleFieldStringifyInEffectMs: smallRuns, rawStringifyMs: (() => { const r = Alpine.raw ? 'raw-available' : 'no-raw'; const t0 = performance.now(); JSON.stringify(JSON.parse(JSON.stringify(month))); return { note: r, ms: Math.round((performance.now() - t0) * 10) / 10 }; })() };
})();
