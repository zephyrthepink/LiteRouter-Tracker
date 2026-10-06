import { DEFAULTS, isLiteRouterConnection, fmt, optimizationWindow, calculate, modelStatus, canUse, parseTokenCount, chatSizes } from './core.js';
import { LiveData } from './live-data.js';
import { ModelPicker, escapeHtml } from './picker.js';
import { normalizeUsage, recordUsage, assignColor } from './usage.js';
import { UsageView } from './usage-ui.js';
import { installRequestTracker } from './request-tracker.js';
import { installRequestRecommender } from './recommendations.js';
import { showRecommendations } from './recommendation-ui.js';

const MODULE = 'literouter';
const context = () => SillyTavern.getContext();
let settings, settingsRoot, connectionRoot, connectionPicker, comparisonPicker, live, usageView;
let active = false, tokens = null, loading = false, lastRefresh = 0, lastSignature = '', chartTokens = null;

function pricing() { return live.entries.pricing?.data; }
function plan() { return pricing()?.plans.find(p => p.name === settings.plan) ?? pricing()?.plans[0]; }
function modelRows(inputTokens) {
    const data = pricing(), selectedPlan = plan();
    if (!data || !selectedPlan) return [];
    const statusMap = live.statusMap();
    return data.models.map(model => ({ model, status: modelStatus(model, statusMap),
        estimate: calculate(model, inputTokens, selectedPlan, settings, data.rules) }))
        .filter(row => !row.status.modality || row.status.modality === 'text');
}
function pickerData(hypothetical = false) {
    return { rows: modelRows(hypothetical ? settings.hypotheticalTokens : tokens), plan: plan(), plans: pricing()?.plans ?? [],
        selected: hypothetical ? settings.compareModels : [context().chatCompletionSettings?.custom_model] };
}
function persist() { context().saveSettingsDebounced(); }

function readTotalTokens() {
    const header = document.querySelector('#completion_prompt_manager .completion_prompt_manager_header');
    const label = header?.querySelector('[data-i18n="Total Tokens:"]');
    return parseTokenCount(label?.parentElement);
}

function liveMessage() {
    return ['pricing', 'status'].map(kind => {
        const entry = live.entries[kind];
        const title = kind === 'pricing' ? 'Models/plans' : 'Status';
        if (!entry?.data) return `${title}: ${loading ? 'loading…' : `unavailable${entry?.error ? ` (${entry.error})` : ''}`}`;
        const time = kind === 'status' ? entry.data.updated_at : entry.at;
        return `${title}: ${entry.stale ? 'STALE — last successful data' : 'live'} ${new Date(time).toLocaleString()}${entry.error ? ` (${entry.error})` : ''}`;
    }).join(' · ');
}
function renderLiveMessage() {
    const proxyUsed = settings.transport === 'st-proxy' || Object.values(live.transports).includes('st-proxy');
    for (const root of [settingsRoot, connectionRoot]) {
        const element = root?.querySelector('.lr-live-message');
        if (element) {
            element.textContent = liveMessage();
            element.classList.toggle('lr-live-error', ['pricing', 'status'].some(kind => live.entries[kind]?.stale));
        }
        const error = root?.querySelector('.lr-data-error');
        if (error) {
            error.textContent = ['pricing', 'status'].filter(kind => live.entries[kind]?.error)
                .map(kind => `${kind === 'pricing' ? 'Models/plans' : 'Status'}: ${live.entries[kind].error}`).join(' · ');
            error.hidden = !error.textContent;
        }
        const warning = root?.querySelector('.lr-proxy-warning');
        if (warning) warning.hidden = !proxyUsed;
        root?.querySelectorAll('.lr-refresh').forEach(button => { button.disabled = loading; });
    }
}

function renderConnection() {
    connectionRoot.hidden = !active;
    if (!active) return;
    const row = modelRows(tokens).find(r => r.model.id === context().chatCompletionSettings?.custom_model);
    const summary = connectionRoot.querySelector('.lr-current-model');
    summary.innerHTML = row ? estimateMarkup(row.estimate)
        + (canUse(row.model, plan(), pricing().plans) ? '' : ` · Requires ${escapeHtml(row.model.plan)} or higher`)
        : '<span class="lr-muted">Estimate unavailable</span>';
    summary.title = `${context().chatCompletionSettings?.custom_model || 'No model selected'} · ${tokens == null
        ? 'SillyTavern Total Tokens unavailable; open Chat Completion Preset to update its count'
        : `${fmt(tokens)} SillyTavern Total Tokens`}`;
    if (connectionRoot.querySelector('.lr-picker-panel').open) connectionPicker.update();
}

function renderPlan() {
    const selectedPlan = plan(), data = pricing();
    const select = settingsRoot.querySelector('[data-lr-setting="plan"]');
    const options = data?.plans.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (${escapeHtml(p.price)})</option>`).join('') ?? '<option value="">Load live plans first</option>';
    if (select.innerHTML !== options) select.innerHTML = options;
    select.disabled = !data;
    if (!selectedPlan) return;
    select.value = selectedPlan.name;
    settingsRoot.querySelector('[data-lr-setting="credits"]').placeholder = `Plan default: ${fmt(selectedPlan.cap)}`;
    const warning = settingsRoot.querySelector('.lr-plan-warning');
    warning.hidden = selectedPlan.name === settings.plan;
    warning.textContent = warning.hidden ? '' : `Saved plan “${settings.plan}” unavailable; using ${selectedPlan.name}`;
    settingsRoot.querySelector('.lr-window-info').textContent = [false, true].map(claude => {
        const win = optimizationWindow(selectedPlan, settings, claude);
        return `${claude ? 'Claude' : 'General'}: ${fmt(win.window)} tokens · score ${fmt(win.score)} · effective window ${fmt(win.effective)}${win.window > win.cap ? ' (plan cap)' : ''}`;
    }).join(' | ');
}

function estimateMarkup(estimate) {
    const rate = estimate.type === 'free' ? estimate.freeUnlimited ? 'Unlimited/day' : 'Daily limit unknown'
        : estimate.requests === Infinity ? 'No premium credit cost' : estimate.requests == null ? 'Unavailable/day' : `${fmt(estimate.requests)}/day`;
    return `<span class="lr-opt">opt ${estimate.optimization == null ? '?' : fmt(estimate.optimization)}</span> · <span class="lr-credit">${estimate.cost == null ? 'Cost unavailable' : `${fmt(estimate.cost)} ${estimate.type === 'free' ? 'free ' : ''}credits`}</span> · <span class="lr-requests">${rate}</span>`;
}
function comparisonCell(model, count) {
    const estimate = calculate(model, count, plan(), settings, pricing().rules);
    if (!canUse(model, plan(), pricing().plans)) return `Requires ${escapeHtml(model.plan)}`;
    return estimateMarkup(estimate);
}
function renderComparison() {
    const selectedIds = settings.compareModels;
    const rows = modelRows(settings.hypotheticalTokens);
    const models = selectedIds.map(id => rows.find(row => row.model.id === id)?.model).filter(Boolean);
    settingsRoot.querySelector('.lr-compared').innerHTML = selectedIds.map(id => `<button type="button" class="lr-chip" data-lr-compare-remove="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(id)} from comparison">${escapeHtml(id)}${models.some(m => m.id === id) ? '' : ' (unavailable)'} ×</button>`).join('')
        + `<p class="lr-muted">${selectedIds.length}/5 selected. Each model's requests/day assumes the entire daily premium allowance is spent on that model.</p>`;
    const output = settingsRoot.querySelector('.lr-comparison-content');
    if (!models.length || !plan()) {
        output.innerHTML = '';
        placeComparisonReset();
        return;
    }
    const max = Math.max(optimizationWindow(plan(), settings).effective, optimizationWindow(plan(), settings, true).effective);
    const sizes = chatSizes(settings.hypotheticalTokens, max);
    if (!sizes.includes(chartTokens)) chartTokens = settings.hypotheticalTokens;
    output.innerHTML = `<h4>Requests per day by chat size</h4><p class="lr-muted"><span class="lr-opt">opt = optimization</span> · <span class="lr-credit">credits/request</span> · <span class="lr-requests">requests/day</span></p>
        <div class="lr-comparison-wrap"><table class="lr-comparison-table"><thead><tr><th scope="col">Input tokens</th>${models.map(m => `<th scope="col">${escapeHtml(m.id)}</th>`).join('')}</tr></thead><tbody>${sizes.map(size => `<tr class="${size === settings.hypotheticalTokens ? 'lr-current' : ''}"><th scope="row">${fmt(size)}${size === settings.hypotheticalTokens ? ' (hypothetical)' : ''}${size === max ? ' (window max)' : ''}</th>${models.map(m => `<td>${comparisonCell(m, size)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <h4><label>Requests per day at <select class="text_pole lr-chart-size" aria-label="Chat size for requests per day bars">${sizes.map(size => `<option value="${size}"${size === chartTokens ? ' selected' : ''}>${fmt(size)} tokens</option>`).join('')}</select></label></h4>
        <div class="lr-bars"></div><p class="lr-muted">Basic free-model limits are not supplied; paid plans have unlimited free requests. Flat full-context models ignore chat size; metered full-context models use their native window. Estimates follow the calculator's caps and do not measure remaining quota.</p>`;
    placeComparisonReset();
    output.querySelector('.lr-chart-size').addEventListener('change', event => { chartTokens = Number(event.target.value); renderBars(models); });
    renderBars(models);
}
function placeComparisonReset() {
    if (!comparisonPicker) return;
    comparisonPicker.resetButton.textContent = 'Reset comparison search';
    settingsRoot.querySelector('.lr-comparison-actions').append(comparisonPicker.resetButton);
}
function renderBars(models) {
    const estimates = models.map(model => ({ model, estimate: calculate(model, chartTokens, plan(), settings, pricing().rules),
        usable: canUse(model, plan(), pricing().plans) }));
    const maximum = Math.max(1, ...estimates.filter(r => r.usable && Number.isFinite(r.estimate.requests)).map(r => r.estimate.requests));
    settingsRoot.querySelector('.lr-bars').innerHTML = estimates.map(({ model, estimate, usable }) => {
        const free = estimate.type === 'free', unlimited = estimate.requests === Infinity;
        const width = !usable ? 0 : free || unlimited ? 100 : Math.max(0, estimate.requests / maximum * 100);
        const label = !usable ? `Requires ${model.plan}` : free ? estimate.freeUnlimited ? 'Free · unlimited' : 'Free · limit unknown' : unlimited ? 'No credit cost' : `${fmt(estimate.requests)}/day`;
        return `<div class="lr-bar${free ? ' lr-free-bar' : ''}"><span class="lr-bar-name">${escapeHtml(model.id)}</span><div class="lr-bar-track" aria-hidden="true"><div class="lr-bar-fill" style="width:${width}%"></div></div><span>${escapeHtml(label)}</span></div>`;
    }).join('');
}

function render() {
    renderLiveMessage();
    renderPlan();
    renderConnection();
    if (settingsRoot.querySelector('.lr-comparison-picker').open) comparisonPicker.update();
    renderComparison();
    usageView?.render();
}

async function refresh() {
    if (loading) return live.inflight;
    loading = true;
    renderLiveMessage();
    try { await live.refresh(settings); }
    finally { loading = false; lastRefresh = Date.now(); render(); }
}

function selectConnectionModel(id) {
    if (!active || !modelRows(tokens).some(row => row.model.id === id)) return;
    setConnectionModel(id);
}
function setConnectionModel(id) {
    // Invoke native handlers so generation, saved settings and connection profiles use the model.
    const field = document.getElementById('custom_model_id');
    const select = document.getElementById('model_custom_select');
    if (!field || !select) return;
    if (![...select.options].some(option => option.value === id)) select.add(new Option(id, id));
    $(field).val(id).trigger('input');
    $(select).val(id).trigger('change');
    connectionRoot.querySelector('.lr-picker-panel').open = false;
    sync();
    renderConnection();
}
function addComparison(id) {
    if (settings.compareModels.includes(id)) return;
    if (settings.compareModels.length >= 5) { globalThis.toastr?.info('You can compare up to five models. Remove one before adding another.'); return; }
    if (!modelRows(settings.hypotheticalTokens).some(row => row.model.id === id)) return;
    settings.compareModels.push(id);
    persist();
    renderComparison();
    comparisonPicker.update();
}

function sync() {
    const current = context();
    active = settings.enabled && isLiteRouterConnection(current);
    tokens = readTotalTokens();
    usageView?.tick();
    const signature = JSON.stringify([active, tokens, current.chatCompletionSettings?.custom_model, current.chatCompletionSettings?.custom_url]);
    if (signature !== lastSignature) {
        lastSignature = signature;
        renderConnection();
    }
    const settingsVisible = settingsRoot.querySelector('.inline-drawer-content').getClientRects().length > 0;
    if ((active || settingsVisible) && document.visibilityState !== 'hidden' && Date.now() - lastRefresh >= settings.refreshSeconds * 1000) void refresh();
}

function loadSettings() {
    const store = context().extensionSettings;
    store[MODULE] = { ...structuredClone(DEFAULTS), ...store[MODULE] };
    const value = store[MODULE];
    value.compareModels = Array.isArray(value.compareModels) ? [...new Set(value.compareModels.filter(id => typeof id === 'string'))].slice(0, 5) : [];
    for (const key of ['generalSystem', 'generalConversation', 'claudeSystem', 'claudeConversation']) {
        if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 10000) value[key] = DEFAULTS[key];
    }
    if (!Number.isSafeInteger(value.hypotheticalTokens) || value.hypotheticalTokens < 0 || value.hypotheticalTokens > 2000000) value.hypotheticalTokens = DEFAULTS.hypotheticalTokens;
    if (value.credits !== null && (!Number.isSafeInteger(value.credits) || value.credits < 0)) value.credits = null;
    if (!Number.isInteger(value.refreshSeconds) || value.refreshSeconds < 30 || value.refreshSeconds > 3600) value.refreshSeconds = DEFAULTS.refreshSeconds;
    if (!['auto', 'helper', 'st-proxy', 'direct'].includes(value.transport)) value.transport = 'auto';
    for (const key of ['query', 'sort', 'plan']) if (typeof value[key] !== 'string') value[key] = DEFAULTS[key];
    value.enabled = Boolean(value.enabled);
    delete value.suffixCap;
    delete value.trackUsage;
    delete value.proxyPrefix;
    value.recommendEnabled = Boolean(value.recommendEnabled);
    value.applyRecommended = Boolean(value.applyRecommended);
    if (!['suggest', 'automatic'].includes(value.recommendMode)) value.recommendMode = 'suggest';
    value.usage = normalizeUsage(value.usage);
    value.modelColors = Object.fromEntries(Object.entries(value.modelColors && typeof value.modelColors === 'object' ? value.modelColors : {})
        .filter(([, color]) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)));
    for (const models of Object.values(value.usage.days)) for (const model of Object.keys(models)) assignColor(model, value.modelColors);
    return value;
}

async function initialize() {
    if (settingsRoot) return;
    settings = loadSettings();
    live = new LiveData();
    // Derive the installed folder, supporting renamed repositories and per-user installs.
    const folder = new URL('.', import.meta.url).pathname.split('/extensions/')[1]?.replace(/\/$/, '');
    if (!folder) throw new Error('LiteRouter must be installed as a SillyTavern third-party extension');
    const template = await context().renderExtensionTemplateAsync(folder, 'settings');
    $('#extensions_settings2').append(template);
    settingsRoot = document.getElementById('literouter_settings');
    settingsRoot.querySelectorAll('[data-lr-setting]').forEach(input => {
        const key = input.dataset.lrSetting;
        if (input.type === 'checkbox') input.checked = settings[key];
        else input.value = settings[key] ?? '';
        input.addEventListener(input.type === 'number' || input.type === 'text' ? 'input' : 'change', () => {
            let value = input.type === 'checkbox' ? input.checked : input.value;
            if (input.type === 'number') {
                if (key === 'credits' && value === '') value = null;
                else {
                    value = Number(value);
                    const maximum = key === 'hypotheticalTokens' ? 2000000 : key === 'refreshSeconds' ? 3600 : key === 'credits' ? Number.MAX_SAFE_INTEGER : 10000;
                    if (input.value === '' || !Number.isSafeInteger(value) || value < Number(input.min) || value > maximum) return;
                }
            }
            settings[key] = value;
            if (key === 'plan') { settings.credits = null; settingsRoot.querySelector('[data-lr-setting="credits"]').value = ''; }
            if (key === 'hypotheticalTokens') chartTokens = value;
            persist();
            sync();
            render();
        });
    });
    settingsRoot.addEventListener('click', event => {
        const remove = event.target.closest('[data-lr-compare-remove]');
        if (remove) { settings.compareModels = settings.compareModels.filter(id => id !== remove.dataset.lrCompareRemove); persist(); renderComparison(); comparisonPicker.update(); }
        if (event.target.closest('.lr-refresh')) void refresh();
    });

    connectionRoot = document.createElement('section');
    connectionRoot.id = 'literouter_connection';
    connectionRoot.className = 'lr-root';
    connectionRoot.hidden = true;
    connectionRoot.innerHTML = '<p class="lr-current-model" aria-live="polite"></p><details class="lr-picker-panel"><summary>Browse LiteRouter models</summary><p class="lr-live-message lr-muted" aria-live="polite"></p><p class="lr-proxy-warning lr-muted" hidden>Warning: SillyTavern’s built-in CORS proxy may print “Streaming request finished” while fetching model/status JSON. These misleading messages do not indicate chat generation or credit spending. The optional server helper avoids them.</p><div class="lr-connection-search"></div><div class="lr-toolbar lr-picker-footer"><button type="button" class="menu_button lr-refresh">Refresh live data</button></div></details>';
    const anchor = document.getElementById('model_custom_select')?.parentElement;
    if (!anchor) throw new Error('LiteRouter: native Custom model selector was not found');
    anchor.after(connectionRoot);
    connectionRoot.querySelector('.lr-refresh').addEventListener('click', () => void refresh());
    connectionRoot.querySelector('.lr-picker-panel').addEventListener('toggle', event => {
        if (event.target.open) { connectionPicker.update(); if (!pricing()) void refresh(); connectionPicker.input.focus(); }
    });
    connectionPicker = new ModelPicker(connectionRoot.querySelector('.lr-connection-search'), {
        getData: () => pickerData(), select: selectConnectionModel, query: settings.query, sort: settings.sort,
        changed: (query, sort) => { settings.query = query; settings.sort = sort; persist(); },
    });
    comparisonPicker = new ModelPicker(settingsRoot.querySelector('.lr-compare-search'), {
        getData: () => pickerData(true), select: addComparison, label: 'Search models to compare',
    });
    usageView = new UsageView(settingsRoot.querySelector('.lr-usage'), {
        getSettings: () => settings, getBudget: () => settings.credits ?? plan()?.cap ?? null, getPlan: plan, persist,
    });
    installRequestTracker({
        snapshot: request => {
            const current = context(), data = pricing();
            const sameConnection = current.chatCompletionSettings?.custom_url === request.custom_url && current.chatCompletionSettings?.custom_model === request.model;
            const displayedTokens = sameConnection && ['normal', 'swipe', 'continue', 'regenerate'].includes(request.type) ? readTotalTokens() : null;
            const inputTokens = (async () => {
                try {
                    if (displayedTokens != null) return { tokens: displayedTokens, source: 'st-total' };
                    if (typeof current.getTokenCountAsync !== 'function' || !Array.isArray(request.messages)) return null;
                    const count = await current.getTokenCountAsync(JSON.stringify(request.messages));
                    return Number.isSafeInteger(count) && count >= 0 ? { tokens: count, source: 'tokenizer' } : null;
                } catch { return null; }
            })();
            return { pricingModel: structuredClone(data?.models.find(model => model.id === request.model) ?? null),
                plan: structuredClone(plan() ?? null), rules: structuredClone(data?.rules),
                settings: Object.fromEntries(['credits', 'generalSystem', 'generalConversation', 'claudeSystem', 'claudeConversation'].map(key => [key, settings[key]])),
                inputTokens, stale: Boolean(live.entries.pricing?.stale),
                countOutputTokens: async replies => {
                    if (typeof current.getTokenCountAsync !== 'function') return null;
                    const counts = await Promise.all(replies.map(reply => current.getTokenCountAsync(reply)));
                    return counts.every(count => Number.isSafeInteger(count) && count >= 0) ? counts.reduce((total, count) => total + count, 0) : null;
                } };
        },
        record: entry => { recordUsage(settings.usage, entry); assignColor(entry.model, settings.modelColors); persist(); usageView.render(); },
        onError: error => console.warn('LiteRouter usage tracking:', error),
    });
    installRequestRecommender({
        getSettings: () => settings,
        refresh,
        getData: () => live.entries,
        getInputTokens: async request => {
            const current = context().chatCompletionSettings;
            const displayed = current.custom_url === request.custom_url && current.custom_model === request.model
                && ['normal', 'swipe', 'continue', 'regenerate'].includes(request.type) ? readTotalTokens() : null;
            if (displayed != null) return displayed;
            if (!Array.isArray(request.messages) || typeof context().getTokenCountAsync !== 'function') return null;
            return await context().getTokenCountAsync(JSON.stringify(request.messages));
        },
        choose: (recommendation, signal, request) => showRecommendations(context(), recommendation, signal, request.type),
        apply: (id, request) => {
            const current = context();
            if (isLiteRouterConnection(current) && current.chatCompletionSettings.custom_model === request.model
                && current.chatCompletionSettings.custom_url === request.custom_url) setConnectionModel(id);
        },
        notify: (message, level) => globalThis.toastr?.[level]?.(message, 'LiteRouter'),
    });
    settingsRoot.querySelector('.lr-comparison-picker').addEventListener('toggle', event => {
        if (event.target.open) { comparisonPicker.update(); if (!pricing()) void refresh(); }
    });
    $(document).on('input.literouter change.literouter', '#custom_api_url_text, #custom_model_id, #model_custom_select, #chat_completion_source, #main_api', () => queueMicrotask(sync));
    const { eventSource, event_types } = context();
    for (const name of ['MAIN_API_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED', 'SETTINGS_UPDATED', 'PRESET_CHANGED', 'CHAT_CHANGED', 'GENERATION_ENDED']) {
        if (event_types[name]) eventSource.on(event_types[name], sync);
    }
    const tokenContainer = document.getElementById('completion_prompt_manager');
    if (tokenContainer) new MutationObserver(sync).observe(tokenContainer, { childList: true, subtree: true, characterData: true });
    // Also detect programmatic endpoint/profile changes which do not dispatch DOM events.
    setInterval(sync, 1500);
    document.addEventListener('visibilitychange', sync);
    sync();
    render();
}

const { eventSource, event_types } = context();
eventSource.on(event_types.APP_READY, () => initialize().catch(error => {
    console.error('LiteRouter extension failed to initialize:', error);
    globalThis.toastr?.error(error.message, 'LiteRouter');
}));
