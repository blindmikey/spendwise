// Isolate the ~300ms floor: is it the event loop, the reactivity engine,
// or something specific to the app's store graph?
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const macro = () => new Promise((r) => setTimeout(r, 0));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    const timeIt = async (fn) => {
        const t0 = performance.now();
        fn();
        await macro();
        return Math.round(performance.now() - t0);
    };

    const out = {};
    out.noMutation = await timeIt(() => {});
    out.noMutationAgain = await timeIt(() => {});

    const fresh = Alpine.reactive({ x: 0 });
    out.freshReactive = await timeIt(() => { fresh.x++; });

    out.uiStoreTouch = await timeIt(() => { Alpine.store('ui').toast.timeout = 3500 + Math.floor(performance.now() % 7); });

    const field = m.month.groups.find((g) => g.kind === 'expense').fields[0];
    out.monthFieldTouch = await timeIt(() => { field._probe = (field._probe || 0) + 1; });
    out.noMutationAfter = await timeIt(() => {});

    // long task attribution if available
    return out;
})();
