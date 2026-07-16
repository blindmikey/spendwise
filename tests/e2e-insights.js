// Switch to the Insights view and let the charts render (screenshot follows).
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && !Alpine.store('data').loaded; i++) await wait(100);
    Alpine.store('ui').view = 'insights';
    await wait(1500);
    return { view: Alpine.store('ui').view, months: Object.keys(Alpine.store('data').db.months).length };
})();
