// Diagnose where an envelope's spent comes from after import.
import fs from 'node:fs';
import '../src/shared/engine.js';
const E = globalThis.FinEngine;

const db = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const key = process.argv[3] || E.monthKeys(db).pop();
const month = db.months[key];

const allIds = new Set(E.allFields(month).map((f) => f.id));
const report = { month: key, envelopes: [], danglingLinks: [] };

for (const g of month.groups) {
    if (E.isEnvelopeKind(g.kind)) {
        for (const f of g.fields) {
            if (!/utilit/i.test(f.label)) continue;
            report.envelopes.push({
                group: g.title, label: f.label, id: f.id,
                manualSpent: f.spent, linked: E.linkedSpent(month, f.id),
                effective: E.effectiveSpent(month, f), avail: f.avail,
            });
        }
    }
    if (g.kind === 'expense') {
        for (const f of g.fields) {
            if (f.budgetId && !allIds.has(f.budgetId)) {
                report.danglingLinks.push({ group: g.title, label: f.label, value: f.value, budgetId: f.budgetId });
            }
        }
    }
}

// also: which expenses link to the utilities envelope(s)?
report.linkedToUtilities = [];
for (const env of report.envelopes) {
    for (const g of month.groups) {
        if (g.kind !== 'expense') continue;
        for (const f of g.fields) {
            if (f.budgetId === env.id) report.linkedToUtilities.push({ label: f.label, value: f.value });
        }
    }
}

console.log(JSON.stringify(report, null, 2));
