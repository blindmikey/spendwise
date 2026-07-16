// Switch to the Settings view (screenshot follows).
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && !Alpine.store('data').loaded; i++) await wait(100);
    Alpine.store('ui').view = 'settings';
    await wait(800);
    return { view: 'settings' };
})();
