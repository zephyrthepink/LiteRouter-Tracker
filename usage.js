import { baseModel, provider } from './core.js';

const OFFSET = 7 * 60 * 60 * 1000;
const DAY = 86400000;
const NUMBER_QUERY = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?$/;
const NUMERIC_FILTERS = new Set(['credits', 'premium', 'daily', 'permanent', 'free', 'requests']);
export const USAGE_NUMERIC_TAGS = ['credits:>=10', 'premium:>=10', 'daily:>=10', 'permanent:>0', 'free:>=1', 'requests:1..20'];
export const billingDay = (time = Date.now()) => new Date(Number(time) + OFFSET).toISOString().slice(0, 10);
export const nextReset = (time = Date.now()) => Date.parse(`${billingDay(time)}T00:00:00Z`) + DAY - OFFSET;
export function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function dateRange(period, time = Date.now(), start = '', end = '') {
    const today = billingDay(time), date = new Date(today + 'T00:00:00Z');
    if (period === 'custom') return { start: validDate(start) ? start : '', end: validDate(end) ? end : '' };
    if (period === 'all') return { start: '', end: today };
    if (period === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    if (period === 'month') date.setUTCDate(1);
    return { start: date.toISOString().slice(0, 10), end: today };
}
export const emptyUsage = () => ({ version: 1, days: {} });
export function isSharedOutputModel(model) {
    const family = provider(model), name = baseModel(model).toLowerCase();
    // Colon pricing variants and hyphenated extras keep the base model's quota.
    return family === 'claude' || family === 'gemini'
        && /(^|-)pro(?=-|$)/.test(name) && !/(^|-)flash(?=-|$)/.test(name);
}
export const sharedOutputLimit = credits => Number.isFinite(credits) && credits >= 0 && Number.isSafeInteger(Math.floor(credits * 20)) ? Math.floor(credits * 20) : null;
const emptyBucket = () => ({ requests: 0, premium: 0, daily: 0, permanent: 0, unallocated: 0, free: 0, unpriced: 0, partial: 0, inputTokens: 0, apiTokens: 0, stalePrices: 0,
    outputTokens: 0, apiOutputRequests: 0, estimatedOutputRequests: 0, unknownOutputRequests: 0 });
const round = n => Math.round(n * 1000) / 1000;
export function normalizeUsage(raw) {
    const usage = emptyUsage();
    if (raw?.version !== 1 || !raw.days || typeof raw.days !== 'object') return usage;
    for (const [day, models] of Object.entries(raw.days)) {
        if (!validDate(day) || !models || typeof models !== 'object') continue;
        const entries = Object.entries(models).filter(([id, bucket]) => id && bucket && typeof bucket === 'object').map(([id, bucket]) => {
            const clean = emptyBucket();
            for (const key of Object.keys(clean)) if (Number.isFinite(bucket[key]) && bucket[key] >= 0) clean[key] = bucket[key];
            // Older credit history has no recoverable reply token counts.
            if (isSharedOutputModel(id) && !Object.hasOwn(bucket, 'outputTokens')) clean.unknownOutputRequests = clean.requests;
            clean.type = typeof bucket.type === 'string' ? bucket.type : 'unknown';
            return [id, clean];
        });
        usage.days[day] = Object.fromEntries(entries);
    }
    return usage;
}
export function recordUsage(usage, { model, startedAt, cost = null, type = 'unknown', inputTokens = null, tokenSource = 'unknown', outputTokens = null, outputTokenSource = 'unknown', partial = false, stale = false, premiumAllowance = null }) {
    const day = billingDay(startedAt);
    if (!Object.hasOwn(usage.days, day)) usage.days[day] = {};
    const models = usage.days[day];
    if (!Object.hasOwn(models, model)) Object.defineProperty(models, model, { enumerable: true, configurable: true, writable: true, value: { ...emptyBucket(), type } });
    const bucket = models[model];
    if (bucket.type === 'unknown' && type !== 'unknown') bucket.type = type;
    bucket.requests++;
    if (Number.isFinite(cost) && cost >= 0) {
        const key = type === 'free' ? 'free' : 'premium';
        bucket[key] = round(bucket[key] + cost);
        if (key === 'premium') {
            if (Number.isFinite(premiumAllowance) && premiumAllowance >= 0) {
                const spentDaily = Object.values(models).reduce((sum, entry) => sum + entry.daily, 0);
                const daily = Math.min(cost, Math.max(0, premiumAllowance - spentDaily));
                bucket.daily = round(bucket.daily + daily);
                bucket.permanent = round(bucket.permanent + cost - daily);
            } else bucket.unallocated = round(bucket.unallocated + cost);
        }
    } else bucket.unpriced++;
    if (Number.isFinite(inputTokens) && inputTokens >= 0) bucket.inputTokens += inputTokens;
    if (tokenSource === 'api') bucket.apiTokens++;
    if (isSharedOutputModel(model)) {
        if (Number.isSafeInteger(outputTokens) && outputTokens >= 0) {
            bucket.outputTokens += outputTokens;
            if (outputTokenSource === 'api') bucket.apiOutputRequests++;
            else bucket.estimatedOutputRequests++;
        } else bucket.unknownOutputRequests++;
    }
    if (partial) bucket.partial++;
    if (stale) bucket.stalePrices++;
    return day;
}
export function usageRows(usage) {
    return Object.entries(usage.days).flatMap(([date, models]) => Object.entries(models).map(([model, bucket]) => ({ date, model, ...bucket })));
}
export function usageTagGroups(usage) {
    const rows = usageRows(usage), unique = values => [...new Set(values)].sort();
    return [
        ['provider', unique(rows.map(row => provider(row.model)))],
        ['type', unique(rows.map(row => row.type))],
        ['is', ['partial', 'unpriced', 'reasoning']],
        ['model', unique(rows.map(row => row.model.toLowerCase()))],
        ['date', unique(rows.map(row => row.date))],
    ];
}
export function normalizeUsageTag(token, groups) {
    const negative = token.startsWith('-'), raw = (negative ? token.slice(1) : token).toLowerCase();
    const colon = raw.indexOf(':'), key = raw.slice(0, colon), value = raw.slice(colon + 1);
    if (colon < 1 || !value) return null;
    const valid = NUMERIC_FILTERS.has(key) ? NUMBER_QUERY.test(value) : key === 'date' ? validDate(value)
        : key === 'model' || groups.some(([group, values]) => group === key && values.includes(value));
    return valid ? `${negative ? '-' : ''}${key}:${value}` : null;
}
function numeric(value, query) {
    const match = NUMBER_QUERY.exec(query);
    if (!match) return false;
    const target = Number(match[2]);
    if (match[3] !== undefined) return value >= target && value <= Number(match[3]);
    return match[1] === '>=' ? value >= target : match[1] === '<=' ? value <= target : match[1] === '>' ? value > target : match[1] === '<' ? value < target : value === target;
}
export function matchesUsage(row, query) {
    const categories = {}, required = [], excluded = [];
    for (let term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
        const negative = term.startsWith('-');
        if (negative) term = term.slice(1);
        const colon = term.indexOf(':'), key = colon < 0 ? 'word' : term.slice(0, colon), value = colon < 0 ? term : term.slice(colon + 1);
        const test = () => {
            if (key === 'word' || key === 'model') return row.model.toLowerCase().includes(value);
            if (key === 'provider') return provider(row.model) === value;
            if (key === 'type') return row.type === value;
            if (key === 'date') return row.date === value;
            if (key === 'credits') return numeric(row.premium + row.free, value);
            if (['premium', 'daily', 'permanent', 'free', 'requests'].includes(key)) return numeric(row[key], value);
            if (key === 'is') return value === 'partial' ? row.partial > 0 : value === 'unpriced' ? row.unpriced > 0 : value === 'reasoning' ? /(^|-)(r1|reasoner|reasoning|thinking)(?=-|$)/.test(baseModel(row.model)) && !row.model.includes('-non-reasoning') : false;
            return row.model.toLowerCase().includes(term);
        };
        if (negative) excluded.push(test);
        else if (['provider', 'type', 'date', 'model'].includes(key)) (categories[key] ??= []).push(test);
        else required.push(test);
    }
    return Object.values(categories).every(tests => tests.some(test => test())) && required.every(test => test()) && !excluded.some(test => test());
}
export function filterUsage(usage, range, query = '') {
    return usageRows(usage).filter(row => (!range.start || row.date >= range.start) && (!range.end || row.date <= range.end) && matchesUsage(row, query))
        .sort((a, b) => b.date.localeCompare(a.date) || b.premium - a.premium || a.model.localeCompare(b.model));
}
export function totalUsage(rows) {
    return rows.reduce((total, row) => {
        for (const key of Object.keys(total)) total[key] += row[key] || 0;
        total.premium = round(total.premium); total.free = round(total.free);
        return total;
    }, emptyBucket());
}
export function colorFor(model, overrides = {}) {
    if (Object.hasOwn(overrides, model) && /^#[0-9a-f]{6}$/i.test(overrides[model])) return overrides[model];
    let hash = 2166136261;
    for (const char of model) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const hue = (hash % 36000) / 100, saturation = 0.68, lightness = 0.62, amplitude = saturation * Math.min(lightness, 1 - lightness);
    const channel = n => {
        const phase = (n + hue / 30) % 12;
        return Math.round(255 * (lightness - amplitude * Math.max(-1, Math.min(phase - 3, 9 - phase, 1)))).toString(16).padStart(2, '0');
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
}
export function assignColor(model, colors) {
    if (Object.hasOwn(colors, model)) return colors[model];
    const existing = new Set(Object.values(colors).map(color => color.toLowerCase()));
    let candidate = colorFor(model), attempt = 0;
    while (existing.has(candidate) && attempt < 1000) candidate = colorFor(`${model}#${++attempt}`);
    Object.defineProperty(colors, model, { value: candidate, enumerable: true, writable: true, configurable: true });
    return candidate;
}
