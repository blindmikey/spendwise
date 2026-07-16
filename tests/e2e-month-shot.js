// Scroll the first envelope group into view for a layout screenshot.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && !Alpine.store('data').loaded; i++) await wait(100);
    await wait(500);
    const headers = [...document.querySelectorAll('[x-data^="monthView"] section header span')];
    const target = headers.find((el) => /budget/i.test(el.textContent));
    if (target) target.closest('section').scrollIntoView({ block: 'start' });

    // open the auto-fund editor on the first envelope field for the screenshot
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    const env = m.month.groups.find((g) => g.kind === 'envelope' && g.fields.length);
    if (env) m.toggleAutoEditor(env.fields[0]);

    await wait(800);
    return { scrolledTo: target ? target.textContent.trim() : null };
})();
