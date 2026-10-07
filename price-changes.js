const validPrice = value => Number.isFinite(value) && value >= 0;
const entries = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];

export function normalizePriceHistory(raw) {
    const prices = Object.fromEntries(entries(raw?.version === 1 ? raw.prices : null).filter(([id, price]) => id && validPrice(price)));
    const pending = Object.fromEntries(entries(raw?.version === 1 ? raw.pending : null)
        .filter(([id, change]) => Object.hasOwn(prices, id) && validPrice(change?.from) && validPrice(change?.to)
            && change.to > change.from && change.to === prices[id])
        .map(([id, change]) => [id, { from: change.from, to: change.to }]));
    return { version: 1, prices, pending };
}

// Compare successful pricing snapshots, including changes discovered by auto refresh.
// Pending increases survive reloads and unchanged refreshes until a modal opens.
export function updatePriceHistory(history, models, enabled = true) {
    const prices = new Map(models.map(model => [model.id, model.cost]));
    const pending = new Map();
    let changed = prices.size !== Object.keys(history.prices).length;
    for (const [id, price] of prices) {
        const previous = Object.hasOwn(history.prices, id) ? history.prices[id] : null;
        const change = Object.hasOwn(history.pending, id) ? history.pending[id] : null;
        if (previous !== price) changed = true;
        if (!enabled) continue;
        if (change && price > change.from) {
            pending.set(id, price === change.to ? change : { from: change.from, to: price });
        } else if (previous != null && price > previous) {
            pending.set(id, { from: previous, to: price });
        }
    }
    if (pending.size !== Object.keys(history.pending).length
        || [...pending].some(([id, change]) => history.pending[id] !== change)) changed = true;
    if (changed) {
        history.prices = Object.fromEntries(prices);
        history.pending = Object.fromEntries(pending);
    }
    return changed;
}

export function acknowledgePriceIncrease(history, model, change) {
    // A newer refresh while a modal opens must keep its own warning pending.
    if (!Object.hasOwn(history.pending, model) || history.pending[model] !== change) return false;
    delete history.pending[model];
    return true;
}
