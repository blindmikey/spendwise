/* global Alpine, FinEngine, Charts, fmt */
'use strict';

function insightsView () {
    return {
        range: '12mo', // '12mo' | 'ytd' | 'all'
        projected12: null, // savings 12 months out at the current trend

        get db () { return Alpine.store('data').db; },
        get keys () { return this.db ? FinEngine.monthKeys(this.db) : []; },

        get rangeKeys () {
            const keys = this.keys;
            if (!keys.length) return [];
            const last = keys[keys.length - 1];
            if (this.range === '12mo') return keys.slice(-12);
            if (this.range === 'ytd') return keys.filter((k) => k.startsWith(last.slice(0, 4)));
            return keys;
        },

        /**
         * Spend aggregated per tag per month - computed at chart time, never
         * stored. An expense counts under the UNION of its own tags and the
         * tags of the envelope it draws from (a budget's tags are enforced on
         * its linked expenses; the expense's own tags are never overridden).
         * With no tags from either source it lands in the 'untagged' bucket.
         * Direct envelope spending counts under the envelope's own tags.
         */
        aggregate () {
            const perMonth = {}; // key → { tag → amount }
            const totals = {};   // tag → amount

            for (const key of this.rangeKeys) {
                const month = this.db.months[key];
                const bucket = {};
                const add = (tag, amount) => {
                    if (!amount) return;
                    bucket[tag] = (bucket[tag] || 0) + amount;
                    totals[tag] = (totals[tag] || 0) + amount;
                };

                // envelope tags, for inheritance by their linked expenses
                const envTags = {};
                for (const g of month.groups) {
                    if (!FinEngine.isEnvelopeKind(g.kind)) continue;
                    for (const f of g.fields) {
                        if (f.tags && f.tags.length) envTags[f.id] = f.tags;
                        // direct envelope spending under the envelope's own tags
                        if (f.tags && f.tags.length) for (const t of f.tags) add(t, FinEngine.num(f.spent));
                    }
                }

                for (const g of month.groups) {
                    if (g.kind !== 'expense') continue;
                    for (const f of g.fields) {
                        const merged = new Set([
                            ...(f.tags || []),
                            ...((f.budgetId && envTags[f.budgetId]) || []),
                        ]);
                        const tags = merged.size ? [...merged] : ['untagged'];
                        for (const t of tags) add(t, FinEngine.num(f.value));
                    }
                }
                perMonth[key] = bucket;
            }
            return { perMonth, totals };
        },

        /**
         * Income aggregated per tag per month - income streams (clients, side
         * gigs…). Only TAGGED income counts: there is deliberately no
         * 'untagged' bucket, and the whole section hides when nothing is
         * tagged. Face values; a field with several tags counts under each.
         */
        incomeAggregate () {
            const perMonth = {}; // key → { tag → amount }
            const totals = {};   // tag → amount
            for (const key of this.rangeKeys) {
                const month = this.db.months[key];
                const bucket = {};
                for (const g of month.groups) {
                    if (g.kind !== 'income') continue;
                    for (const f of g.fields) {
                        if (!f.tags || !f.tags.length) continue;
                        const amount = FinEngine.num(f.value);
                        if (!amount) continue;
                        for (const t of f.tags) {
                            bucket[t] = (bucket[t] || 0) + amount;
                            totals[t] = (totals[t] || 0) + amount;
                        }
                    }
                }
                perMonth[key] = bucket;
            }
            return { perMonth, totals };
        },

        incomeRows () {
            const { totals } = this.incomeAggregate();
            const taggedTotal = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
            const n = this.rangeKeys.length || 1;
            return Object.entries(totals)
                .sort((a, b) => b[1] - a[1])
                .map(([tag, total]) => ({
                    tag,
                    total,
                    avg: Math.round(total / n),
                    pct: Math.round(total / taggedTotal * 100),
                }));
        },

        stats () {
            const keys = this.rangeKeys;
            let income = 0, spend = 0;
            for (const key of keys) {
                const m = this.db.months[key];
                for (const g of m.groups) {
                    const t = FinEngine.groupTotal(m, g);
                    if (g.kind === 'income') income += t; else spend += t;
                }
            }
            const n = keys.length || 1;
            return {
                months: keys.length,
                avgIncome: Math.round(income / n),
                avgSpend: Math.round(spend / n),
                avgNet: Math.round((income - spend) / n),
                totalIncome: income,
                totalSpend: spend,
            };
        },

        tagRows () {
            const { totals } = this.aggregate();
            const spendTotal = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
            const n = this.rangeKeys.length || 1;
            return Object.entries(totals)
                .sort((a, b) => b[1] - a[1])
                .map(([tag, total]) => ({
                    tag,
                    total,
                    avg: Math.round(total / n),
                    pct: Math.round(total / spendTotal * 100),
                }));
        },

        /** Envelope health from the most recent month. */
        envelopes () {
            const keys = this.keys;
            if (!this.db || !keys.length) return [];
            const month = this.db.months[keys[keys.length - 1]];
            const out = [];
            for (const g of month.groups) {
                if (!FinEngine.isEnvelopeKind(g.kind)) continue;
                for (const f of g.fields) {
                    const spent = FinEngine.effectiveSpent(month, f);
                    out.push({
                        label: f.label || '(unnamed)',
                        kind: g.kind,
                        avail: FinEngine.num(f.avail),
                        spent,
                        left: FinEngine.num(f.avail) - spent,
                        target: FinEngine.num(f.target),
                        progress: g.kind === 'goal' ? FinEngine.goalProgress(month, f) : null,
                    });
                }
            }
            return out;
        },

        render () {
            if (!this.db) return;
            // resolve containers from the LIVE document - $refs go stale when
            // the x-if gate re-creates the Insights DOM (charts painted into
            // detached elements, appearing "one toggle behind")
            const donutEl = document.getElementById('insights-chart-donut');
            const barEl = document.getElementById('insights-chart-bar');
            const savingsEl = document.getElementById('insights-chart-savings');
            if (!donutEl || !barEl || !savingsEl) return; // view not mounted
            const { perMonth, totals } = this.aggregate();

            const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
            Charts.donut('insights-donut', donutEl, top.map(([t]) => t), top.map(([, v]) => Math.round(v)));

            const topTags = top.slice(0, 6).map(([t]) => t);
            const categories = this.rangeKeys.map((k) => FinEngine.keyLabel(k).slice(0, 3) + ' ' + k.slice(2, 4));
            const series = topTags.map((tag) => ({
                name: tag,
                data: this.rangeKeys.map((k) => Math.round(perMonth[k][tag] || 0)),
            }));
            Charts.stackedBar('insights-bar', barEl, categories, series);

            // income streams - only when something is tagged; the section is
            // x-show-gated on incomeRows().length so destroy stale instances
            // when the range change empties it
            const incomeDonutEl = document.getElementById('insights-chart-income-donut');
            const incomeBarEl = document.getElementById('insights-chart-income-bar');
            const inc = this.incomeAggregate();
            const incTop = Object.entries(inc.totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
            if (incTop.length && incomeDonutEl && incomeBarEl) {
                Charts.donut('insights-income-donut', incomeDonutEl,
                    incTop.map(([t]) => t), incTop.map(([, v]) => Math.round(v)));
                const incTags = incTop.slice(0, 6).map(([t]) => t);
                const incSeries = incTags.map((tag) => ({
                    name: tag,
                    data: this.rangeKeys.map((k) => Math.round(inc.perMonth[k][tag] || 0)),
                }));
                Charts.stackedBar('insights-income-bar', incomeBarEl, categories, incSeries);
            } else {
                Charts.destroy('insights-income-donut');
                Charts.destroy('insights-income-bar');
            }

            // savings history, windowed to the selected range
            const allHist = Object.keys(this.db.savingsHistory || {}).sort();
            let histKeys = allHist;
            if (this.range === '12mo') {
                histKeys = allHist.slice(-12);
            } else if (this.range === 'ytd') {
                const last = this.keys[this.keys.length - 1] || allHist[allHist.length - 1] || '';
                histKeys = allHist.filter((k) => k.startsWith(last.slice(0, 4)));
            }
            const shortLabel = (k) => FinEngine.keyLabel(k).slice(0, 3) + ' ' + k.slice(2, 4);
            const histVals = histKeys.map((k) => FinEngine.num(this.db.savingsHistory[k]));
            let savingsCats = histKeys.map(shortLabel);
            const savingsSeries = [{ name: 'Savings', data: [...histVals] }];

            // projection: least-squares trend over the selected window,
            // anchored at the latest actual point, 12 months out
            this.projected12 = null;
            const PROJ = 12;
            if (histVals.length >= 3) {
                const n = histVals.length;
                const xMean = (n - 1) / 2;
                const yMean = histVals.reduce((a, b) => a + b, 0) / n;
                let cov = 0, varx = 0;
                histVals.forEach((y, x) => { cov += (x - xMean) * (y - yMean); varx += (x - xMean) ** 2; });
                const slope = varx ? cov / varx : 0;

                let k = histKeys[histKeys.length - 1];
                const futureKeys = [];
                for (let s = 1; s <= PROJ; s++) { k = FinEngine.nextKey(k); futureKeys.push(k); }
                savingsCats = savingsCats.concat(futureKeys.map(shortLabel));

                const last = histVals[n - 1];
                savingsSeries[0].data = histVals.concat(new Array(PROJ).fill(null));
                savingsSeries.push({
                    name: 'Projected',
                    data: new Array(n - 1).fill(null)
                        .concat([last], futureKeys.map((_, s) => Math.round(last + slope * (s + 1)))),
                });
                this.projected12 = Math.round(last + slope * PROJ);
            }

            Charts.line('insights-savings', savingsEl, savingsCats, savingsSeries,
                { dashArray: [0, 6], colors: ['#3b82f6', '#8b5cf6'] });
        },
    };
}
