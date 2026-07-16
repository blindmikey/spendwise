import path from 'node:path';
import fs from 'node:fs';
import '../shared/engine.js';

const E = globalThis.FinEngine;

const MONTH_NUM = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
};

const KIND_MAP = {
    income: 'income',
    budgets: 'envelope',
    expenses: 'expense',
    miscBudgets: 'goal',
};

/**
 * Import a legacy old-finances-app data directory into a fresh db shape.
 *
 * Legacy layout: one JSON file per month named `<monthname>-<yy>` containing
 * `{ form: { data: [groups], savings } }`, plus a `savings_history` file
 * keyed like "June '18". Field ids are 13-char uniqids reused across months
 * for pinned fields - we map each legacy id to one uuid so cross-month
 * identity (and budget links) survive.
 *
 * kindOverrides maps a legacy group TITLE to a kind, overriding the default
 * type mapping everywhere that group appears.
 */
export function importLegacy (dataDir, kindOverrides = {}) {
    const files = fs.readdirSync(dataDir);
    const idMap = new Map();
    const mapId = (oldId) => {
        if (!oldId) return null;
        if (!idMap.has(oldId)) idMap.set(oldId, E.uuid());
        return idMap.get(oldId);
    };

    const groupDefs = [];
    const defFor = (title, mappedKind) => {
        let def = groupDefs.find((d) => d.title === title);
        if (!def) {
            const kind = kindOverrides[title] || mappedKind;
            def = { id: E.uuid(), title, kind, order: groupDefs.length };
            if (E.isEnvelopeKind(kind)) def.strictOverspend = false;
            groupDefs.push(def);
        }
        return def;
    };

    const months = {};
    let parsed = 0;
    const warnings = [];

    for (const file of files) {
        const m = /^([a-z]+)-(\d{2})$/.exec(file);
        if (!m || !MONTH_NUM[m[1]]) continue;
        const key = `20${m[2]}-${MONTH_NUM[m[1]]}`;

        let json;
        try {
            json = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
        } catch {
            warnings.push(`${file}: unreadable JSON, skipped`);
            continue;
        }
        const form = json && json.form;
        if (!form || !Array.isArray(form.data)) {
            warnings.push(`${file}: no form data, skipped`);
            continue;
        }

        const month = {
            key,
            status: 'closed',
            startingSavings: E.num(form.savings),
            closingSavings: null,
            groups: [],
        };

        for (const legacyGroup of form.data) {
            const def = defFor(legacyGroup.title || 'Untitled', KIND_MAP[legacyGroup.type] || 'expense');
            const kind = def.kind; // may differ from the legacy type via overrides
            const group = { groupId: def.id, title: def.title, kind, fields: [] };

            for (const lf of legacyGroup.fields || []) {
                const field = {
                    id: mapId(lf.id) || E.uuid(),
                    label: lf.label || '',
                    value: E.num(lf.value),
                    pinned: E.truthy(lf.default),
                    accounted: E.truthy(lf.accounted),
                    tags: [],
                };
                if (kind === 'expense') field.budgetId = mapId(lf.budget);
                if (E.isEnvelopeKind(kind)) {
                    field.avail = E.num(lf.avail);
                    field.spent = E.num(lf.spent);
                }
                if (kind === 'goal') field.target = null;
                group.fields.push(field);
            }
            month.groups.push(group);
        }

        // Legacy 'budgets' stored spent as the DERIVED sum of linked expenses;
        // our model stores only direct/manual spending and derives the linked
        // part live - strip it so it isn't counted twice.
        for (const group of month.groups) {
            if (!E.isEnvelopeKind(group.kind)) continue;
            for (const field of group.fields) {
                field.spent = Math.max(0, E.num(field.spent) - E.linkedSpent(month, field.id));
            }
        }

        months[key] = month;
        parsed += 1;
    }

    if (!parsed) throw new Error('No legacy month files found in that folder.');

    // most recent month stays open; every closed month gets a derived closing figure
    const keys = Object.keys(months).sort();
    months[keys[keys.length - 1]].status = 'open';
    for (const key of keys) {
        if (months[key].status === 'closed') {
            months[key].closingSavings = E.savings(months[key]);
        }
    }

    // savings_history: { "June '18": "3800" } → { "2018-06": 3800 }
    const savingsHistory = {};
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'savings_history'), 'utf8'));
        for (const [label, value] of Object.entries(raw)) {
            const hm = /^([A-Za-z]+) '(\d{2})$/.exec(label.trim());
            if (!hm) continue;
            const mm = MONTH_NUM[hm[1].toLowerCase()];
            if (!mm) continue;
            savingsHistory[`20${hm[2]}-${mm}`] = E.num(value);
        }
    } catch {
        warnings.push('savings_history missing or unreadable - rebuilt from month files');
    }
    // month files are authoritative where both exist
    for (const key of keys) savingsHistory[key] = E.num(months[key].startingSavings);

    // Only groups still present in the latest month become the go-forward
    // settings; groups the user renamed/retired years ago live on inside the
    // month snapshots (months are self-describing) without cluttering new months.
    const latest = months[keys[keys.length - 1]];
    const activeGroups = latest.groups.map((g, i) => {
        const def = groupDefs.find((d) => d.id === g.groupId);
        return { ...def, order: i };
    });

    return {
        data: {
            meta: { schemaVersion: 1, rev: 0 },
            settings: {
                currency: 'USD',
                initialSavings: E.num(months[keys[0]].startingSavings),
                groups: activeGroups,
            },
            months,
            savingsHistory,
        },
        summary: {
            months: parsed,
            firstMonth: keys[0],
            lastMonth: keys[keys.length - 1],
            groups: activeGroups.map((g) => `${g.title} (${g.kind})`),
            retiredGroups: groupDefs.filter((d) => !activeGroups.some((a) => a.id === d.id))
                .map((g) => `${g.title} (${g.kind})`),
            historyEntries: Object.keys(savingsHistory).length,
            warnings,
        },
    };
}
