import { MODEL_EXTRAS, baseModel, calculate, canUse, modelStatus, modelType, isLiteRouterConnection } from './core.js';

// Status feeds identify extra-specific routes; recommendation families strip extras too.
export function recommendationBase(id) {
    let name = baseModel(id);
    const extras = MODEL_EXTRAS.slice().sort((a, b) => b.length - a.length);
    while (true) {
        const extra = extras.find(value => name.endsWith('-' + value));
        if (!extra) return name;
        name = name.slice(0, -extra.length - 1);
    }
}

export function recommendModels({ modelId, inputTokens, pricing, status, settings }) {
    const current = pricing?.models.find(model => model.id === modelId);
    const plan = pricing?.plans.find(value => value.name === settings.plan);
    if (!current || !plan || !Number.isSafeInteger(inputTokens) || inputTokens < 0) return null;
    const base = recommendationBase(modelId), statuses = new Map(status.models.map(value => [value.name, value]));
    const original = calculate(current, inputTokens, plan, settings, pricing.rules);
    // Free and premium credits are separate allowances; do not compare unlike credit pools.
    const pool = modelType(current) === 'free' ? 'free' : 'premium';
    const choices = pricing.models.filter(model => recommendationBase(model.id) === base && model.id !== modelId
        && canUse(model, plan, pricing.plans) && (modelType(model) === 'free' ? 'free' : 'premium') === pool)
        .map(model => ({ model, status: modelStatus(model, statuses), estimate: calculate(model, inputTokens, plan, settings, pricing.rules) }))
        .filter(row => row.status.key !== 'outage' && (!row.status.modality || row.status.modality === 'text')
            && row.estimate.cost != null && row.estimate.cost < original.cost)
        .sort((a, b) => a.estimate.cost - b.estimate.cost || a.model.id.localeCompare(b.model.id));
    return { base, current, original, inputTokens, pool, choices };
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError');
}

export function abortable(promise, signal) {
    if (!signal) return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}

// Install outside the usage observer so it prices/records the model actually sent.
export function installRequestRecommender({ target = globalThis, getSettings, refresh, getData, getInputTokens, choose, apply, notify,
    getPriceIncrease, acknowledgePriceIncrease = () => {}, warnPriceIncrease }) {
    const original = target.fetch;
    const warningsEnabled = () => getSettings().priceWarnEnabled !== false
        && typeof getPriceIncrease === 'function' && typeof warnPriceIncrease === 'function';
    // Serialize held decisions so concurrent requests cannot display the same warning.
    let decisionQueue = Promise.resolve();
    const wrapped = async function(input, options) {
        if (!getSettings().recommendEnabled && !warningsEnabled()) return original.call(this, input, options);
        let data;
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        try {
            if (new URL(url, target.location?.href ?? 'http://localhost').pathname !== '/api/backends/chat-completions/generate'
                || (options?.method ?? input?.method ?? 'GET').toUpperCase() !== 'POST') return original.call(this, input, options);
            const raw = options?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : null);
            data = typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch { return original.call(this, input, options); }
        if (typeof data?.model !== 'string' || !data.model
            || !isLiteRouterConnection({ mainApi: 'openai', chatCompletionSettings: { ...data, custom_model: data.model } })) {
            return original.call(this, input, options);
        }
        const signal = options?.signal ?? input?.signal;
        throwIfAborted(signal);
        const preceding = decisionQueue;
        let release;
        const unlocked = new Promise(resolve => { release = resolve; });
        decisionQueue = preceding.then(() => unlocked);
        try {
            await abortable(preceding, signal);
            if (!getSettings().recommendEnabled && !warningsEnabled()) return original.call(this, input, options);
            let recommendation;
            try {
                await abortable(refresh(), signal);
            } catch {
                throwIfAborted(signal);
                notify('Live data could not be refreshed before this request.', 'warning');
            }
            const settings = structuredClone(getSettings()), live = getData();
            if (settings.recommendEnabled) {
                try {
                    if (live.pricing?.stale || live.status?.stale || !live.pricing?.data || !live.status?.data) {
                        notify('Recommendation skipped: live pricing or status is unavailable. Using your selected model.', 'warning');
                    } else {
                        const tokens = await abortable(getInputTokens(data), signal);
                        recommendation = recommendModels({ modelId: data.model, inputTokens: tokens,
                            pricing: live.pricing.data, status: live.status.data, settings });
                    }
                } catch {
                    throwIfAborted(signal);
                    notify('Recommendation skipped: request pricing could not be checked. Using your selected model.', 'warning');
                }
            }
            throwIfAborted(signal);
            const change = warningsEnabled() ? getPriceIncrease(data) : null;
            const onShown = () => { if (change) acknowledgePriceIncrease(data, change); };
            const suggest = getSettings().recommendEnabled && settings.recommendMode === 'suggest' && recommendation?.choices.length;
            let selected;
            if (suggest) {
                selected = await abortable(choose(recommendation, signal, data, change, onShown), signal);
            } else {
                if (change && !await abortable(warnPriceIncrease(change, signal, data, onShown), signal)) {
                    throw new DOMException('Request cancelled after a model price increase', 'AbortError');
                }
                if (getSettings().recommendEnabled && settings.recommendMode === 'automatic' && recommendation?.choices.length) {
                    selected = recommendation.choices[0].model.id;
                }
            }
            throwIfAborted(signal);
            // Validate modal output against this request's captured recommendations.
            if (!selected || !getSettings().recommendEnabled || !recommendation?.choices.some(row => row.model.id === selected)) {
                return original.call(this, input, options);
            }
            const body = JSON.stringify({ ...data, model: selected });
            let outgoing = input, init;
            if (typeof input?.clone === 'function') {
                outgoing = new Request(input, { ...options, body });
            } else init = { ...options, body };
            if (settings.applyRecommended) apply(selected, data);
            if (settings.recommendMode === 'automatic') notify(`LiteRouter model changed: ${data.model} → ${selected}`, 'info');
            return original.call(this, outgoing, init);
        } finally { release(); }
    };
    target.fetch = wrapped;
    return () => { if (target.fetch === wrapped) target.fetch = original; };
}
