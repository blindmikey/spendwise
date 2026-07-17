/* global ApexCharts, FinEngine */
'use strict';

const Charts = {
    instances: {},

    destroy (id) {
        const inst = this.instances[id];
        if (inst) {
            // destroy() can throw when the chart's DOM was already torn down
            // (the Insights view is x-if gated) - the map entry must go anyway
            try { inst.destroy(); } catch (e) { /* detached DOM */ }
            delete this.instances[id];
        }
    },

    /**
     * Must run BEFORE the Insights DOM is torn down (view switch): an
     * ApexCharts instance that outlives its element keeps a ResizeObserver
     * and repaints its stale content over later renders (zombie chart).
     */
    teardownInsights () {
        ['insights-donut', 'insights-bar', 'insights-savings',
            'insights-income-donut', 'insights-income-bar'].forEach((id) => this.destroy(id));
    },

    /** Savings history line: last 12 months plus a live "Now" point - the
        longer view lives in Insights. */
    savingsLine (el, db, currentKey, currentSavings, lastN = 12) {
        const keys = Object.keys(db.savingsHistory || {}).sort()
            .filter((k) => k <= currentKey)
            .slice(-lastN);
        const labels = keys.map((k) => FinEngine.keyLabel(k).slice(0, 3) + ' ' + k.slice(2, 4));
        const values = keys.map((k) => FinEngine.num(db.savingsHistory[k]));
        labels.push('Now');
        values.push(FinEngine.num(currentSavings));

        // fast path: same months, only the values moved → update in place
        // (a full destroy/render costs hundreds of ms and ran on every edit)
        const sig = labels.join('|');
        if (this.instances.savings && this._savingsSig === sig && this._savingsEl === el) {
            this.instances.savings.updateSeries([{ name: 'Savings', data: values }], false);
            return this.instances.savings;
        }
        this._savingsSig = sig;
        this._savingsEl = el;

        const options = {
            chart: { type: 'area', height: 240, toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false }, fontFamily: 'inherit' },
            series: [{ name: 'Savings', data: values }],
            xaxis: { categories: labels, labels: { rotate: -45, style: { fontSize: '10px' } }, tickAmount: 6 },
            yaxis: { labels: { formatter: (v) => fmt(v) } },
            colors: ['#10b981'],
            stroke: { curve: 'smooth', width: 2.5 },
            fill: { type: 'gradient', gradient: { opacityFrom: 0.5, opacityTo: 0.1 } },
            dataLabels: { enabled: false },
            tooltip: { y: { formatter: (v) => fmt(v) } },
            grid: { borderColor: '#e4e4e7', strokeDashArray: 3 },
        };

        return this._render('savings', el, options);
    },

    donut (id, el, labels, values) {
        const options = {
            chart: { type: 'donut', height: 300, animations: { enabled: false }, fontFamily: 'inherit' },
            series: values,
            labels,
            legend: { position: 'bottom' },
            dataLabels: { enabled: true, formatter: (pct) => Math.round(pct) + '%' },
            tooltip: { y: { formatter: (v) => fmt(v) } },
        };
        return this._render(id, el, options);
    },

    stackedBar (id, el, categories, series) {
        const options = {
            chart: { type: 'bar', height: 320, stacked: true, toolbar: { show: false }, animations: { enabled: false }, fontFamily: 'inherit' },
            series,
            xaxis: { categories, labels: { rotate: -45, style: { fontSize: '10px' } } },
            yaxis: { labels: { formatter: (v) => fmt(v) } },
            legend: { position: 'bottom' },
            dataLabels: { enabled: false },
            tooltip: { y: { formatter: (v) => fmt(v) } },
            grid: { borderColor: '#e4e4e7', strokeDashArray: 3 },
        };
        return this._render(id, el, options);
    },

    line (id, el, categories, series, opts = {}) {
        const options = {
            chart: { type: 'line', height: 300, toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false }, fontFamily: 'inherit' },
            series,
            xaxis: { categories, labels: { rotate: -45, style: { fontSize: '10px' } }, tickAmount: 12 },
            yaxis: { labels: { formatter: (v) => fmt(v) } },
            stroke: { curve: 'smooth', width: 2.5, dashArray: opts.dashArray || 0 },
            legend: { position: 'bottom' },
            dataLabels: { enabled: false },
            tooltip: { y: { formatter: (v) => fmt(v) } },
            grid: { borderColor: '#e4e4e7', strokeDashArray: 3 },
        };
        if (opts.colors) options.colors = opts.colors;
        return this._render(id, el, options);
    },

    /**
     * Fold the current theme into a chart's options at render. theme.mode
     * carries the tooltip/data-label palette and a transparent background lets
     * the card show through; the axis-label and grid COLOURS are handled in CSS
     * (input.css) instead, keyed on html.dark - that repaints instantly when the
     * theme flips under an already-rendered chart, which updateOptions() can't.
     */
    _applyTheme (options) {
        const dark = !!(window.Theme && window.Theme.resolved() === 'dark');
        options.theme = { ...(options.theme || {}), mode: dark ? 'dark' : 'light' };
        options.chart = { ...(options.chart || {}), background: 'transparent' };
        return options;
    },

    _render (id, el, options) {
        if (!el) return null;
        this._applyTheme(options);
        // destroy + clear + create: updateOptions() does not reliably apply
        // changed label sets (donut legends stick), so a fresh instance it is
        this.destroy(id);
        el.innerHTML = ''; // never stack SVGs, even if a stale instance failed to clean up
        this.instances[id] = new ApexCharts(el, options);
        this.instances[id].render();
        return this.instances[id];
    },
};
