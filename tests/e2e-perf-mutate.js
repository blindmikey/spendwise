// Minimal workload for CPU profiling: a handful of field mutations.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const macro = () => new Promise((r) => setTimeout(r, 0));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(500);

    const field = m.month.groups.find((g) => g.kind === 'expense').fields[0];
    const timings = [];
    for (let i = 0; i < 6; i++) {
        const t0 = performance.now();
        field._probe = (field._probe || 0) + 1;
        await macro();
        timings.push(Math.round(performance.now() - t0));
    }
    return { timings };
})();
