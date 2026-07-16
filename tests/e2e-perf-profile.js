// Time individual computations to find where ~470ms hides.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);
    await wait(800);

    const time = (fn, n = 5) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        return Math.round((performance.now() - t0) / n * 100) / 100;
    };

    const month = m.month;
    const raw = JSON.parse(JSON.stringify(month)); // non-reactive copy

    return {
        stringifyProxyMs: time(() => JSON.stringify(month)),
        stringifyRawMs: time(() => JSON.stringify(raw)),
        monthNetProxyMs: time(() => FinEngine.monthNet(month)),
        monthNetRawMs: time(() => FinEngine.monthNet(raw)),
        optionsSignatureMs: time(() => m.optionsSignature),
        linkedSignatureMs: time(() => m.linkedSignature),
        isDirtyMs: time(() => m.isDirty),
        currentSavingsMs: time(() => m.currentSavings),
        withBudgetsMs: time(() => m.withBudgets),
        fieldCount: FinEngine.allFields(month).length,
    };
})();
