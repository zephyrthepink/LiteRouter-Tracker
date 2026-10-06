// Calculator rules, isolated from SillyTavern and the hypothetical comparison UI.
export const ENDPOINTS = Object.freeze({
    pricing: 'https://docs.literouter.com/pricing-data',
    status: 'https://status.literouter.com/api.php',
});
export const DEFAULTS = Object.freeze({
    enabled: true, plan: 'Basic', credits: null,
    generalSystem: 5, generalConversation: 16, claudeSystem: 5, claudeConversation: 16,
    hypotheticalTokens: 15000, compareModels: [],
    query: '', sort: 'name', transport: 'auto', refreshSeconds: 60,
    usage: { version: 1, days: {} }, modelColors: {},
    recommendEnabled: false, recommendMode: 'suggest', applyRecommended: false,
});
export const SORTS = [
    ['name', 'Name A–Z'], ['reqd', 'Most requests/day'], ['requ', 'Fewest requests/day'],
    ['req', 'Lowest cost/request'], ['costa', 'Multiplier ↑'], ['costd', 'Multiplier ↓'],
    ['tpsd', 'Highest TPS'], ['tpsu', 'Lowest TPS'], ['lat', 'Lowest latency'],
    ['plan', 'Minimum plan'], ['ctx', 'Native context ↓'], ['stat', 'Status (issues first)'],
];
export const STATUS_LABELS = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'No status data' };
export const MODEL_EXTRAS = ['cheap', 'code', 'thinking', 'non-reasoning', 'flatcost', 'official', 'stable', 'fp8', 'vertex'];
const EXTRAS = MODEL_EXTRAS;
const ALIASES = { rpd: 'requests', mult: 'multiplier' };
const NUMERIC = new Set(['requests', 'multiplier', 'tps', 'latency']);
const CATEGORY = new Set(['status', 'type', 'provider', 'plan']);
const NUMBER_QUERY = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?$/;
export const baseModel = id => id.split(':')[0];
export const provider = id => id.split(/[-:]/)[0].toLowerCase();
export const fmt = value => value == null ? 'Unavailable' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
const validNumber = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));

export function isLiteRouterConnection(context) {
    const settings = context.chatCompletionSettings;
    if (context.mainApi !== 'openai' || settings?.chat_completion_source !== 'custom') return false;
    try {
        const url = new URL(settings.custom_url);
        return ['https:', 'http:'].includes(url.protocol)
            && (url.hostname === 'literouter.com' || url.hostname.endsWith('.literouter.com'));
    } catch { return false; }
}

export function normalizePricing(payload) {
    if (!Array.isArray(payload?.models) || !Array.isArray(payload?.plans)) throw new Error('Invalid pricing response');
    const plans = payload.plans.map(p => {
        if (typeof p.name !== 'string' || !p.name || !validNumber(p.cap) || Number(p.cap) < 0
            || !validNumber(p.max) || Number(p.max) <= 0 || !validNumber(p.claudeMax) || Number(p.claudeMax) < 0) {
            throw new Error('Invalid plan in pricing response');
        }
        return { name: p.name, cap: Number(p.cap), max: Number(p.max), claudeMax: Number(p.claudeMax), price: String(p.price ?? '') };
    });
    const names = new Set(plans.map(p => p.name));
    const models = payload.models.map(m => {
        if (typeof m.id !== 'string' || !m.id || !validNumber(m.cost) || Number(m.cost) < 0
            || !names.has(m.plan) || !Array.isArray(m.tokens) || !m.tokens.every(t => typeof t === 'string')
            || (m.ctx != null && (!validNumber(m.ctx) || Number(m.ctx) <= 0))) throw new Error('Invalid model in pricing response');
        return { id: m.id, cost: Number(m.cost), plan: m.plan, tokens: m.tokens, ctx: m.ctx == null ? null : Number(m.ctx) };
    });
    if (!models.length || !plans.length || new Set(models.map(m => m.id)).size !== models.length
        || names.size !== plans.length) throw new Error('Empty or duplicate pricing data');
    const rule = (key, fallback) => validNumber(payload.rules?.[key]) && Number(payload.rules[key]) > 0 ? Number(payload.rules[key]) : fallback;
    return { models, plans, rules: { premiumBase: rule('premiumBase', 15000), block: rule('block', 5000) } };
}

export function normalizeStatus(payload) {
    if (!Array.isArray(payload?.models) || !payload.models.length || typeof payload.updated_at !== 'string'
        || !Number.isFinite(Date.parse(payload.updated_at))) throw new Error('Invalid status response');
    const models = payload.models.map(m => {
        if (typeof m.name !== 'string' || !m.name) throw new Error('Invalid model in status response');
        return { name: m.name, status: Object.hasOwn(STATUS_LABELS, m.status) ? m.status : 'unknown',
            tps: validNumber(m.tps) && Number(m.tps) >= 0 ? Number(m.tps) : null,
            latency_ms: validNumber(m.latency_ms) && Number(m.latency_ms) >= 0 ? Number(m.latency_ms) : null,
            modality: typeof m.modality === 'string' ? m.modality : null };
    });
    return { models, updated_at: payload.updated_at, overall_status: String(payload.overall_status ?? 'unknown'),
        overall_message: String(payload.overall_message ?? '') };
}

export function modelStatus(model, statusMap) {
    const data = statusMap.get(baseModel(model.id));
    return { key: data?.status ?? 'unknown', tps: data?.tps ?? null, latency: data?.latency_ms ?? null, modality: data?.modality ?? null };
}
export function modelType(model) {
    const tokens = model.tokens;
    if (tokens.includes('free')) return 'free';
    if (tokens.includes('metered')) return tokens.includes('full-context') ? 'metered-full-context' : 'metered';
    return tokens.includes('full-context') ? 'full-context' : 'premium';
}
export function optimizationWindow(plan, settings, claude = false) {
    const system = Number(settings[claude ? 'claudeSystem' : 'generalSystem']);
    const conversation = Number(settings[claude ? 'claudeConversation' : 'generalConversation']);
    const window = 1250 * system + 3750 * conversation;
    const cap = claude ? plan.claudeMax || plan.max : plan.max;
    return { window, score: (system + 3 * conversation) / 4, cap, effective: Math.min(window, cap) };
}
export function canUse(model, plan, plans) {
    const required = plans.findIndex(p => p.name === model.plan);
    const selected = plans.findIndex(p => p.name === plan.name);
    return required >= 0 && selected >= required;
}

export function calculate(model, inputTokens, plan, settings, rules = { premiumBase: 15000, block: 5000 }) {
    const type = modelType(model);
    const credits = settings.credits == null ? plan.cap : Number(settings.credits);
    const result = { type, optimization: null, cost: null, requests: null, countedTokens: null };
    // Official Credits docs: Basic limits vary by model; paid plans are unlimited.
    if (type === 'free') return { ...result, optimization: 1, cost: 1,
        requests: plan.name === 'Basic' ? null : Infinity, freeUnlimited: plan.name !== 'Basic',
        countedTokens: inputTokens == null ? null : Math.min(inputTokens, 5000) };
    if (type === 'full-context') return { ...result, optimization: 1, cost: model.cost,
        requests: model.cost === 0 ? Infinity : Math.floor(credits / model.cost + 1e-9) };
    if (inputTokens == null) return result;
    let tokens = Math.max(0, inputTokens);
    if (type === 'metered-full-context') {
        if (model.ctx) tokens = Math.min(tokens, model.ctx);
    } else {
        tokens = Math.min(tokens, optimizationWindow(plan, settings, model.id.includes('claude')).effective);
    }
    const optimization = type.startsWith('metered') ? Math.max(1, Math.ceil(tokens / rules.block))
        : tokens <= rules.premiumBase ? 1 : 1 + Math.ceil((tokens - rules.premiumBase) / rules.block);
    const cost = Math.round(model.cost * optimization * 1000) / 1000;
    return { ...result, optimization, cost, countedTokens: tokens, requests: cost === 0 ? Infinity : Math.floor(credits / cost + 1e-9) };
}

export function parseTokenCount(element) {
    if (!element) return null;
    // Read only the number after the localized label, never a context limit or tokenizer estimate.
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[data-i18n]').forEach(node => node.remove());
    const text = clone.textContent.trim();
    if (!/^\d[\d,\s.\u00a0\u202f]*$/.test(text)) return null;
    const number = Number(text.replace(/[,\s.\u00a0\u202f]/g, ''));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function tagGroups(models, plans) {
    return [
        ['status', ['operational', 'degraded', 'outage', 'unknown']],
        ['type', ['premium', 'metered', 'full-context', 'metered-full-context', 'free']],
        ['plan', plans.map(p => p.name.toLowerCase())],
        ['provider', [...new Set(models.map(m => provider(m.id)))].sort()],
        ['is', ['usable', 'reasoning']], ['extra', EXTRAS],
    ];
}
export const NUMERIC_TAGS = ['requests:>=100', 'requests:<=50', 'tps:>=10', 'latency:<=6000', 'multiplier:<=20'];
export function normalizeTag(token, groups) {
    const negative = token.startsWith('-');
    const raw = (negative ? token.slice(1) : token).toLowerCase();
    const colon = raw.indexOf(':');
    if (colon < 1) return null;
    const key = ALIASES[raw.slice(0, colon)] ?? raw.slice(0, colon), value = raw.slice(colon + 1);
    if (NUMERIC.has(key) ? !NUMBER_QUERY.test(value) : !groups.find(g => g[0] === key)?.[1].includes(value)) return null;
    return `${negative ? '-' : ''}${key}:${value}`;
}
export function parseQuery(query) {
    const result = { words: [], excludedWords: [], categories: {}, required: [], excluded: [] };
    for (let token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
        const negative = token.startsWith('-');
        if (negative) token = token.slice(1);
        const colon = token.indexOf(':'), key = ALIASES[token.slice(0, colon)] ?? token.slice(0, colon), value = token.slice(colon + 1);
        if (colon > 0 && (CATEGORY.has(key) || NUMERIC.has(key) || key === 'is' || key === 'extra')) {
            if (!value || (NUMERIC.has(key) && !NUMBER_QUERY.test(value))) continue;
            if (negative) result.excluded.push([key, value]);
            else if (CATEGORY.has(key)) (result.categories[key] ??= []).push(value);
            else result.required.push([key, value]);
        } else if (!token.endsWith(':')) (negative ? result.excludedWords : result.words).push(token);
    }
    return result;
}
export function testTag(key, value, row, plan, plans) {
    const { model, estimate, status } = row;
    if (key === 'is') {
        if (value === 'usable') return canUse(model, plan, plans);
        return value === 'reasoning' && /(^|-)(r1|reasoner|reasoning|thinking)(?=-|$)/.test(baseModel(model.id))
            && !/-non-reasoning(?=-|$)/.test(baseModel(model.id));
    }
    if (key === 'extra') return [...baseModel(model.id).matchAll(/-(cheap|code|thinking|non-reasoning|flatcost|official|stable|fp8|vertex)(?=-|$)/g)].some(m => m[1] === value);
    const category = { status: status.key, type: estimate.type, provider: provider(model.id), plan: model.plan.toLowerCase() };
    if (CATEGORY.has(key)) return category[key] === value;
    const number = { requests: estimate.requests, multiplier: model.cost, tps: status.tps, latency: status.latency }[key];
    const match = NUMBER_QUERY.exec(value);
    if (number == null || !match) return false;
    const target = Number(match[2]);
    if (match[3] !== undefined) return number >= target && number <= Number(match[3]);
    switch (match[1]) {
        case '>=': return number >= target;
        case '<=': return number <= target;
        case '>': return number > target;
        case '<': return number < target;
        default: return number === target;
    }
}
export function matchesQuery(row, query, plan, plans) {
    const id = row.model.id.toLowerCase(), test = (k, v) => testTag(k, v, row, plan, plans);
    return query.words.every(w => id.includes(w)) && !query.excludedWords.some(w => id.includes(w))
        && Object.entries(query.categories).every(([key, values]) => values.some(value => test(key, value)))
        && query.required.every(([k, v]) => test(k, v)) && !query.excluded.some(([k, v]) => test(k, v));
}
export function sortRows(rows, sort, plans) {
    const rank = { outage: 0, degraded: 1, unknown: 2, operational: 3 };
    const compare = {
        name: () => 0, reqd: (a, b) => compareNullable(a.estimate.requests, b.estimate.requests, true),
        requ: (a, b) => compareNullable(a.estimate.requests, b.estimate.requests),
        req: (a, b) => compareNullable(a.estimate.type === 'free' ? 0 : a.estimate.cost, b.estimate.type === 'free' ? 0 : b.estimate.cost),
        costa: (a, b) => a.model.cost - b.model.cost, costd: (a, b) => b.model.cost - a.model.cost,
        tpsd: (a, b) => compareNullable(a.status.tps, b.status.tps, true), tpsu: (a, b) => compareNullable(a.status.tps, b.status.tps),
        lat: (a, b) => compareNullable(a.status.latency, b.status.latency),
        plan: (a, b) => plans.findIndex(p => p.name === a.model.plan) - plans.findIndex(p => p.name === b.model.plan),
        ctx: (a, b) => compareNullable(a.model.ctx, b.model.ctx, true), stat: (a, b) => rank[a.status.key] - rank[b.status.key],
    }[sort] ?? (() => 0);
    return [...rows].sort((a, b) => compare(a, b) || a.model.id.localeCompare(b.model.id));
}
function compareNullable(a, b, descending = false) {
    if (a === b) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a > b ? 1 : -1) * (descending ? -1 : 1);
}
export function chatSizes(tokens, maximum) {
    const sizes = new Set([tokens, maximum]);
    for (let size = 5000; size < maximum; size += 5000) sizes.add(size);
    return [...sizes].sort((a, b) => a - b);
}
