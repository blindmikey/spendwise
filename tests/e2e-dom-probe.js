/*
 * DOM reactivity probe: does the rendered month region track state changes
 * after a full db replacement (close-out)? Drives the app both by direct
 * method calls and by real DOM clicks, sampling rendered text after each step.
 */
(async () => {
    const out = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sample = (label) => {
        const badge = document.querySelector('[x-data^="monthView"] .rounded-full');
        const select = document.querySelector('[x-data^="monthView"] select');
        const incomeTotal = document.querySelector('[x-data^="monthView"] section header span.font-mono');
        out.push({
            label,
            selectText: select && select.selectedOptions[0] && select.selectedOptions[0].text.trim(),
            badge: badge && badge.textContent.trim(),
            incomeTotalDom: incomeTotal && incomeTotal.textContent.trim(),
            stateKey: Alpine.store('ui').currentKey,
            stateStatus: Alpine.store('data').db.months[Alpine.store('ui').currentKey].status,
        });
    };

    confirmDialog = async () => true;
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);

    const income = m.month.groups.find((g) => g.kind === 'income');
    m.addField(income);
    Object.assign(income.fields[0], { label: 'Paycheck', value: 3000, pinned: true });
    await wait(300);
    sample('after adding income via method');

    await m.save();
    await wait(300);
    sample('after save');

    await m.closeOut();
    await wait(600);
    sample('after closeOut via method');

    // mutate a value and see if DOM tracks it
    const income2 = m.month.groups.find((g) => g.kind === 'income');
    income2.fields[0].value = 4321;
    await wait(300);
    sample('after value mutation post-closeout');

    return out;
})();
