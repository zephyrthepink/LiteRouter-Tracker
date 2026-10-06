import { SORTS, STATUS_LABELS, fmt, parseQuery, matchesQuery, sortRows, tagGroups, normalizeTag, NUMERIC_TAGS, testTag, canUse } from './core.js';

export const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const requestLabel = estimate => estimate.type === 'free' ? estimate.freeUnlimited ? 'Free · unlimited requests' : 'Free · daily limit unknown'
    : estimate.requests === Infinity ? 'No premium credit cost' : estimate.requests == null ? 'Estimate unavailable' : `${fmt(estimate.requests)} requests/day`;

// Shared booru controls for live model searches and observed credit usage.
export class TagSearch {
    constructor(element, { groups, normalize = normalizeTag, numericTags = NUMERIC_TAGS, count = () => 0, changed = () => {}, query = '' }) {
        this.element = element;
        this.getGroups = groups;
        this.normalize = normalize;
        this.numericTags = numericTags;
        this.countTag = count;
        this.changed = changed;
        this.tags = [];
        this.suggestionIndex = 0;
        this.excludeMode = false;
        this.input = element.querySelector('.lr-search');
        this.input.value = query;
        this.resetButton = element.querySelector('.lr-reset');
        this.input.addEventListener('input', () => { this.commitTags(false); this.update(true); this.suggest(); });
        this.input.addEventListener('focus', () => this.suggest());
        this.input.addEventListener('keydown', event => this.keydown(event));
        this.resetButton?.addEventListener('click', () => this.reset());
        element.querySelector('.lr-exclude-mode').addEventListener('change', event => { this.excludeMode = event.target.checked; });
        element.querySelector('.lr-tag-browser').addEventListener('toggle', () => this.renderTags());
        element.addEventListener('click', event => {
            const tag = event.target.closest('[data-lr-tag]');
            const pill = event.target.closest('[data-lr-remove]');
            const suggestion = event.target.closest('[data-lr-suggestion]');
            if (suggestion) this.acceptSuggestion(suggestion.dataset.lrSuggestion);
            else if (tag) {
                const raw = tag.dataset.lrTag, wanted = (this.excludeMode ? '-' : '') + raw;
                const existing = this.tags.findIndex(t => t === raw || t === '-' + raw);
                if (existing >= 0) {
                    if (this.tags[existing] === wanted) this.tags.splice(existing, 1);
                    else this.tags[existing] = wanted;
                } else this.tags.push(wanted);
                this.update(true);
            } else if (pill) { this.tags.splice(Number(pill.dataset.lrRemove), 1); this.update(true); }
        });
        this.commitTags(true);
        this.renderPills();
    }
    groups() { return this.getGroups(); }
    reset() {
        this.tags = []; this.input.value = ''; this.update(true);
        this.element.querySelector('.lr-suggestions').hidden = true;
    }
    query() { return [...this.tags, this.input.value].join(' ').trim(); }
    addTag(tag) {
        const raw = tag.replace(/^-/, ''), existing = this.tags.findIndex(t => t.replace(/^-/, '') === raw);
        if (existing >= 0) this.tags[existing] = tag;
        else this.tags.push(tag);
    }
    commitTags(all) {
        const words = this.input.value.split(/\s+/), tail = all ? '' : words.pop();
        const remaining = [];
        let committed = false;
        for (const word of words) {
            const tag = this.normalize(word, this.groups());
            if (tag) { this.addTag(tag); committed = true; }
            else if (word) remaining.push(word);
        }
        // Preserve spaces while typing ordinary words ("claude status:..."),
        // including the separator before the next, incomplete tag.
        if (committed) this.input.value = all ? remaining.join(' ') : [...remaining, tail].join(' ');
    }
    renderPills() {
        this.element.querySelector('.lr-pills').innerHTML = this.tags.map((tag, index) => `<button type="button" class="lr-chip ${tag.startsWith('-') ? 'lr-excluded' : ''}" data-lr-remove="${index}" aria-label="Remove ${escapeHtml(tag)}">${escapeHtml(tag)} ×</button>`).join('');
    }
    update(persist = false) {
        this.renderPills();
        this.renderTags();
        if (persist) this.changed(this.query());
    }
    renderTags() {
        if (!this.element.querySelector('.lr-tag-browser').open) return;
        const chip = tag => {
            const count = this.countTag(tag);
            const included = this.tags.includes(tag), excluded = this.tags.includes('-' + tag);
            return `<button type="button" class="lr-chip ${included ? 'lr-included' : excluded ? 'lr-excluded' : ''}" data-lr-tag="${escapeHtml(tag)}">${excluded ? '− ' : included ? '✓ ' : ''}${escapeHtml(tag)} <small>${count}</small></button>`;
        };
        this.element.querySelector('.lr-all-tags').innerHTML = this.groups().map(([key, values]) => `<div class="lr-tag-group"><b>${escapeHtml(key)}</b><div>${values.map(v => chip(`${key}:${v}`)).join('')}</div></div>`).join('')
            + `<div class="lr-tag-group"><b>Numeric examples</b><div>${this.numericTags.map(chip).join('')}</div></div>`;
    }
    suggest() {
        const token = this.input.value.match(/\S*$/)?.[0] ?? '', negative = token.startsWith('-'), query = token.replace(/^-/, '').toLowerCase();
        const tags = [...this.groups().flatMap(([key, values]) => values.map(v => `${key}:${v}`)), ...this.numericTags];
        const suggestions = tags.filter(tag => tag.includes(query) && !this.tags.includes((negative ? '-' : '') + tag)).slice(0, 8);
        const box = this.element.querySelector('.lr-suggestions');
        this.suggestionIndex = 0;
        box.hidden = !suggestions.length;
        box.innerHTML = suggestions.map((tag, i) => `<button type="button" class="${i === 0 ? 'lr-active' : ''}" data-lr-suggestion="${negative ? '-' : ''}${escapeHtml(tag)}">${negative ? '−' : ''}${escapeHtml(tag)}</button>`).join('');
    }
    acceptSuggestion(tag) {
        this.addTag(tag);
        this.input.value = this.input.value.replace(/\S*$/, '').trim();
        this.element.querySelector('.lr-suggestions').hidden = true;
        this.update(true);
        this.input.focus();
    }
    keydown(event) {
        const box = this.element.querySelector('.lr-suggestions'), buttons = [...box.querySelectorAll('button')];
        if (event.key === 'Escape') { box.hidden = true; return; }
        if (!box.hidden && buttons.length) {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                this.suggestionIndex = (this.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
                buttons.forEach((button, i) => button.classList.toggle('lr-active', i === this.suggestionIndex));
                return;
            }
            if (['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); this.acceptSuggestion(buttons[this.suggestionIndex].dataset.lrSuggestion); return; }
        }
        if (event.key === 'Enter') { event.preventDefault(); this.commitTags(true); this.update(true); }
    }
}

// The live picker is used for the active connection and the independent comparison list.
export class ModelPicker extends TagSearch {
    constructor(element, { getData, select, changed = () => {}, query = '', sort = 'name', label = 'Search LiteRouter models' }) {
        element.innerHTML = `<div class="lr-search-line"><input type="search" class="text_pole lr-search" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${escapeHtml(label)}" placeholder="claude is:reasoning -type:free"><select class="text_pole lr-sort" aria-label="Sort models">${SORTS.map(([value, title]) => `<option value="${value}">${title}</option>`).join('')}</select></div>
            <div class="lr-suggestions" role="group" aria-label="Tag suggestions" hidden></div>
            <div class="lr-pills" aria-label="Active search tags"></div>
            <div class="lr-hint">Tags in one category use OR; categories use AND. Prefix − to exclude. <button type="button" class="menu_button lr-reset">Reset</button></div>
            <details class="lr-tag-browser"><summary>Browse tags</summary><label class="checkbox_label"><input type="checkbox" class="lr-exclude-mode"> Add exclusion tags</label><div class="lr-all-tags"></div><small>Numeric filters: &gt;, &gt;=, &lt;, &lt;=, =, or ranges such as requests:50..200. TPS and latency are measured on the base model.</small></details>
            <div class="lr-count" aria-live="polite"></div><div class="lr-results" role="group" aria-label="Models"></div>`;
        super(element, { query, changed, groups: () => { const data = getData(); return tagGroups(data.rows.map(r => r.model), data.plans); },
            count: tag => {
                const { rows, plan, plans } = getData(), colon = tag.indexOf(':');
                return plan ? rows.filter(r => testTag(tag.slice(0, colon), tag.slice(colon + 1), r, plan, plans)).length : 0;
            } });
        this.getData = getData;
        this.sortInput = element.querySelector('.lr-sort');
        this.sortInput.value = SORTS.some(s => s[0] === sort) ? sort : 'name';
        this.sortInput.addEventListener('change', () => this.update(true));
        element.addEventListener('click', event => {
            const model = event.target.closest('[data-lr-model]');
            if (model) select(model.dataset.lrModel);
        });
        this.update();
    }
    update(persist = false) {
        const { rows, plan, plans, selected } = this.getData();
        this.renderPills();
        const filtered = plan ? sortRows(rows.filter(row => matchesQuery(row, parseQuery(this.query()), plan, plans)), this.sortInput.value, plans) : [];
        this.element.querySelector('.lr-count').textContent = `${filtered.length} of ${rows.length} models`;
        this.element.querySelector('.lr-results').innerHTML = filtered.map(({ model, estimate, status }) => {
            const usable = canUse(model, plan, plans);
            return `<button type="button" class="lr-model ${selected?.includes(model.id) ? 'lr-selected' : ''}" data-lr-model="${escapeHtml(model.id)}" aria-pressed="${Boolean(selected?.includes(model.id))}">
                <span class="lr-model-name">${escapeHtml(model.id)}</span><span class="lr-model-rate">${escapeHtml(requestLabel(estimate))}</span>
                <span class="lr-model-meta"><span class="lr-status lr-${status.key}">● ${STATUS_LABELS[status.key]}</span> · ${escapeHtml(estimate.type)} · ${escapeHtml(model.plan)} · ×${fmt(model.cost)} · ${model.ctx ? fmt(model.ctx) : '?'} ctx · ${status.tps == null ? 'TPS unavailable' : `${fmt(status.tps)} TPS`} · ${status.latency == null ? 'Latency unavailable' : `${fmt(status.latency)} ms`}</span>
                <span class="lr-model-detail">${estimate.cost == null ? 'Waiting for SillyTavern Total Tokens' : `${estimate.type === 'free' ? '1 free credit/request' : `${fmt(estimate.cost)} credits/request`} · optimization ${fmt(estimate.optimization)}${estimate.countedTokens == null ? '' : ` · ${fmt(estimate.countedTokens)} counted tokens`}`}${usable ? '' : ` · Requires ${escapeHtml(model.plan)} or higher`}</span></button>`;
        }).join('') || '<p class="lr-muted">No models match. Refresh live data or adjust your search.</p>';
        this.renderTags();
        if (persist) this.changed(this.query(), this.sortInput.value);
    }
}
