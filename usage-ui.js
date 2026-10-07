import { fmt } from './core.js';
import { escapeHtml, TagSearch } from './picker.js';
import { billingDay, nextReset, dateRange, filterUsage, usageRows, matchesUsage, usageTagGroups, normalizeUsageTag, USAGE_NUMERIC_TAGS, totalUsage, colorFor, assignColor, isSharedOutputModel, sharedOutputLimit } from './usage.js';

export class UsageView {
    constructor(root, { getSettings, getBudget, getPlan, persist, now = Date.now }) {
        this.root = root; this.getSettings = getSettings; this.getBudget = getBudget; this.getPlan = getPlan; this.persist = persist; this.now = now;
        this.period = root.querySelector('.lr-usage-period');
        this.start = root.querySelector('.lr-usage-start'); this.end = root.querySelector('.lr-usage-end');
        this.search = root.querySelector('.lr-usage-search');
        this.period.addEventListener('change', () => this.render());
        for (const input of [this.start, this.end]) input.addEventListener('input', () => this.render());
        this.tagSearch = new TagSearch(root.querySelector('.lr-usage-tag-search'), {
            groups: () => usageTagGroups(this.getSettings().usage), normalize: normalizeUsageTag, numericTags: USAGE_NUMERIC_TAGS,
            count: tag => usageRows(this.getSettings().usage).filter(row => matchesUsage(row, tag)).length,
            changed: () => this.render(),
        });
        root.querySelector('.lr-usage-reset-filters').addEventListener('click', () => {
            this.period.value = 'week'; this.start.value = ''; this.end.value = ''; this.tagSearch.reset();
        });
        root.querySelector('.lr-usage-colors').addEventListener('click', () => this.openColors());
        this.lastDay = null;
    }
    tick() {
        if (this.lastDay !== billingDay(this.now())) this.render();
        else this.renderToday();
    }
    renderToday() {
        const time = this.now(), settings = this.getSettings(), today = billingDay(time);
        const todayRows = usageRows(settings.usage).filter(row => row.date === today);
        const totals = totalUsage(todayRows), output = totalUsage(todayRows.filter(row => isSharedOutputModel(row.model)));
        const budget = this.getBudget(), seconds = Math.max(0, Math.ceil((nextReset(time) - time) / 1000));
        const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
        const permanent = totalUsage(usageRows(settings.usage)).permanent;
        const plan = this.getPlan();
        const freeAllowance = !plan ? 'Unknown' : plan.name.toLowerCase() === 'basic' ? 'Per-model limits' : 'Unlimited';
        const outputLimit = sharedOutputLimit(budget), reached = outputLimit != null && output.outputTokens >= outputLimit && output.outputTokens > 0;
        const outputValue = `${output.estimatedOutputRequests ? '≈ ' : ''}${fmt(output.outputTokens)}${output.unknownOutputRequests ? '+' : ''} / ${outputLimit == null ? 'Unknown' : fmt(outputLimit)}`;
        const outputDetail = [reached ? 'Limit reached' : 'Shared daily limit', output.estimatedOutputRequests ? `${fmt(output.estimatedOutputRequests)} estimated` : '',
            output.unknownOutputRequests ? `${fmt(output.unknownOutputRequests)} unknown` : ''].filter(Boolean).join(' · ');
        const outputState = reached ? 'reached' : outputLimit > 0 && output.outputTokens >= outputLimit * 0.8 ? 'near' : 'normal';
        this.root.querySelector('.lr-usage-day').textContent = `Today · ${today} · GMT+7 · Local estimates`;
        const stats = [
            ['premium-left', 'Daily premium left', budget == null ? 'Unknown' : fmt(Math.max(0, budget - totals.daily)), ''],
            ['reset', 'Reset in', `${hours}h ${minutes}m`, '00:00 GMT+7'],
            ['requests', 'Requests today', fmt(totals.requests), ''],
            ['free-allowance', 'Free allowance', freeAllowance, ''],
            ['shared-output', 'Claude/Gemini Pro output tokens', outputValue, outputDetail],
            ['premium-spent', 'Premium spent today', fmt(totals.premium), `${fmt(totals.daily)} daily · ${fmt(totals.permanent)} permanent`],
            ['free-spent', 'Free spent today', fmt(totals.free), ''],
            ['permanent-spent', 'Permanent spent · all time', fmt(permanent), ''],
        ];
        const markup = stats.map(([key, label, value, detail]) => `<div class="lr-usage-stat" data-lr-stat="${key}"${key === 'shared-output' ? ` data-output-state="${outputState}" title="Shared daily allowance = daily premium credits × 20. Includes observed Claude and Gemini Pro requests, all extras and variants. Gemini Flash is excluded. API totals include reasoning tokens; missing usage is estimated or marked unknown."` : ''}><dt>${label}</dt><dd>${escapeHtml(value)}${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</dd>${key === 'shared-output' && outputLimit > 0 ? `<progress class="lr-output-progress" max="${outputLimit}" value="${Math.min(output.outputTokens, outputLimit)}" aria-label="Shared Claude/Gemini Pro output token usage"></progress>` : ''}</div>`).join('');
        const summary = this.root.querySelector('.lr-usage-today');
        if (summary.innerHTML !== markup) summary.innerHTML = markup;
        const notes = this.root.querySelector('.lr-usage-notes');
        notes.textContent = [totals.unpriced ? `${totals.unpriced} unpriced requests` : '', totals.unallocated ? `${fmt(totals.unallocated)} premium credits without a known allowance` : ''].filter(Boolean).join(' · ');
        notes.hidden = !notes.textContent;
    }
    render() {
        const settings = this.getSettings(), time = this.now();
        this.tagSearch.update();
        this.lastDay = billingDay(time); this.renderToday();
        const custom = this.period.value === 'custom';
        this.root.querySelector('.lr-usage-filters > summary').textContent = `Filters · ${this.period.selectedOptions[0].textContent}`;
        this.root.querySelector('.lr-usage-dates').hidden = !custom;
        const range = dateRange(this.period.value, time, this.start.value, this.end.value);
        const reversed = range.start && range.end && range.start > range.end;
        const rows = reversed ? [] : filterUsage(settings.usage, range, this.tagSearch.query());
        const totals = totalUsage(rows);
        this.root.querySelector('.lr-usage-filter-summary').textContent = reversed ? 'Start date must be on or before end date.'
            : `${range.start || 'First tracked day'} → ${range.end || 'Last tracked day'} (GMT+7) · ${fmt(totals.premium)} premium credits · ${fmt(totals.free)} free credits · ${fmt(totals.requests)} requests${totals.unpriced ? ` · ${totals.unpriced} unpriced` : ''}`;
        this.renderChart(rows, range);
        const maximum = Math.max(1, ...rows.map(row => row.premium + row.free));
        this.root.querySelector('.lr-usage-table').innerHTML = `<thead><tr><th scope="col">Day (GMT+7)</th><th scope="col">Model</th><th scope="col">Premium credits</th><th scope="col">Free credits</th><th scope="col">Requests</th><th scope="col">Daily model usage</th></tr></thead><tbody>${rows.map(row => {
            const color = colorFor(row.model, settings.modelColors);
            const details = [`${row.apiTokens}/${row.requests} with API token counts`, row.partial ? `${row.partial} partial` : '', row.unpriced ? `${row.unpriced} unpriced` : '', row.stalePrices ? `${row.stalePrices} using stale pricing` : ''].filter(Boolean).join(' · ');
            return `<tr><th scope="row">${row.date}</th><td><span class="lr-color-swatch" style="background:${color}"></span>${escapeHtml(row.model)}<small class="lr-usage-row-details">${escapeHtml(details)}</small></td><td>${fmt(row.premium)}<small class="lr-usage-row-details">${fmt(row.daily)} daily · ${fmt(row.permanent)} permanent${row.unallocated ? ` · ${fmt(row.unallocated)} unallocated` : ''}</small></td><td>${fmt(row.free)}</td><td>${fmt(row.requests)}</td><td><div class="lr-bar-track"><div class="lr-bar-fill" style="width:${(row.premium + row.free) / maximum * 100}%;background:${color}"></div></div><small>${fmt(row.premium + row.free)} total credits</small></td></tr>`;
        }).join('') || '<tr><td colspan="6">No tracked requests match these filters.</td></tr>'}</tbody>`;
    }
    renderChart(rows, range) {
        const colors = this.getSettings().modelColors, dayMap = new Map();
        for (const row of rows) {
            if (!dayMap.has(row.date)) dayMap.set(row.date, []);
            dayMap.get(row.date).push(row);
        }
        // Show empty days in a selected week/month/custom range. Long ranges remain scrollable.
        if (range.start && range.end && range.start <= range.end) {
            const days = Math.floor((Date.parse(range.end) - Date.parse(range.start)) / 86400000);
            if (days <= 366) for (let offset = 0; offset <= days; offset++) {
                const day = new Date(Date.parse(range.start) + offset * 86400000).toISOString().slice(0, 10);
                if (!dayMap.has(day)) dayMap.set(day, []);
            }
        }
        const entries = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b));
        const maximum = Math.max(1, ...entries.map(([, values]) => values.reduce((sum, row) => sum + row.premium + row.free, 0)));
        const models = [...new Set(rows.map(row => row.model))].sort();
        this.root.querySelector('.lr-usage-legend').innerHTML = models.map(model => `<span><i class="lr-color-swatch" style="background:${colorFor(model, colors)}"></i>${escapeHtml(model)}</span>`).join('');
        this.root.querySelector('.lr-usage-chart').innerHTML = entries.length ? `<div class="lr-usage-axis">${fmt(maximum)} credits (scale maximum)</div><div class="lr-usage-chart-columns">${entries.map(([day, values]) => {
            const sum = values.reduce((total, row) => total + row.premium + row.free, 0);
            const segments = values.slice().sort((a, b) => a.model.localeCompare(b.model)).map(row => {
                const credits = row.premium + row.free;
                const description = `${day} · ${row.model} · ${fmt(row.premium)} premium + ${fmt(row.free)} free credits · ${row.requests} requests`;
                return credits ? `<div class="lr-usage-segment" tabindex="0" role="img" aria-label="${escapeHtml(description)}" title="${escapeHtml(description)}" style="height:${credits / maximum * 100}%;background:${colorFor(row.model, colors)}"></div>` : '';
            }).join('');
            return `<div class="lr-usage-column"><span class="lr-usage-column-total">${fmt(sum)}</span><div class="lr-usage-stack">${segments}</div><span class="lr-usage-column-date" title="${day}">${day.slice(5)}</span></div>`;
        }).join('')}</div>` : '<p class="lr-muted">Your daily model bars will appear after tracked requests complete.</p>';
    }
    openColors() {
        const settings = this.getSettings(), models = [...new Set(usageRows(settings.usage).map(row => row.model))].sort();
        const dialog = document.createElement('dialog'); dialog.className = 'lr-root lr-color-dialog';
        dialog.innerHTML = `<form method="dialog"><h3>Model colors</h3><p class="lr-muted">Colors apply to the daily usage chart, legend, and table bars.</p><input class="text_pole lr-color-search" type="search" aria-label="Search model colors" placeholder="Search tracked models"><div class="lr-color-list">${models.map(model => `<label data-lr-color-row="${escapeHtml(model)}"><input type="color" value="${colorFor(model, settings.modelColors)}" data-lr-color-model="${escapeHtml(model)}" aria-label="Color for ${escapeHtml(model)}"><span>${escapeHtml(model)}</span></label>`).join('') || '<p>No models tracked yet.</p>'}</div><div class="lr-toolbar"><button type="button" class="menu_button lr-color-defaults">Default colors</button><button class="menu_button" value="cancel">Cancel</button><button class="menu_button" value="save">Save colors</button></div></form>`;
        const draft = { ...settings.modelColors };
        dialog.querySelector('.lr-color-search').addEventListener('input', event => {
            for (const row of dialog.querySelectorAll('[data-lr-color-row]')) row.hidden = !row.dataset.lrColorRow.toLowerCase().includes(event.target.value.toLowerCase());
        });
        dialog.querySelectorAll('[data-lr-color-model]').forEach(input => input.addEventListener('input', () => { draft[input.dataset.lrColorModel] = input.value; }));
        dialog.querySelector('.lr-color-defaults').addEventListener('click', () => {
            for (const model of models) delete draft[model];
            for (const model of models) assignColor(model, draft);
            dialog.querySelectorAll('[data-lr-color-model]').forEach(input => { input.value = colorFor(input.dataset.lrColorModel, draft); });
        });
        dialog.addEventListener('close', () => {
            if (dialog.returnValue === 'save') { settings.modelColors = draft; this.persist(); this.render(); }
            dialog.remove();
        }, { once: true });
        document.body.append(dialog); dialog.showModal();
    }
}
