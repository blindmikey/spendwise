// Stage goals in three states (at cap / nearly full / filling) for a screenshot.
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    confirmDialog = async () => true;
    const m = Alpine.$data(document.querySelector('[x-data^="monthView"]'));
    for (let i = 0; i < 50 && !m.month; i++) await wait(100);

    const goal = m.month.groups.find((g) => g.kind === 'goal');
    m.addField(goal);
    Object.assign(goal.fields[0], { label: 'Garbage (100/2mo)', value: 50, avail: 100, target: 100, pinned: true });
    m.addField(goal, 0);
    Object.assign(goal.fields[1], { label: 'Car Insurance (600/yr)', value: 50, avail: 560, target: 600, pinned: true });
    m.addField(goal, 1);
    Object.assign(goal.fields[2], { label: 'Vacation Fund', value: 250, avail: 750, target: 2000, pinned: true });

    document.querySelectorAll('[x-data^="monthView"] section')[2].scrollIntoView({ block: 'center' });
    await wait(800);
    return {
        atCap: m.contrib(goal, goal.fields[0]),
        nearCap: m.contrib(goal, goal.fields[1]),
        filling: m.contrib(goal, goal.fields[2]),
    };
})();
