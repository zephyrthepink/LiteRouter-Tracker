import { fmt, modelType, STATUS_LABELS, CONTEXT_VARIANTS } from './core.js';
import { escapeHtml } from './picker.js';
import { processedPromptMarkup } from './request-inspector.js';

const PRICE_LABELS = { free: 'Free', metered: 'Metered', premium: 'Standard pricing', flatcost: 'Flat cost',
    ...Object.fromEntries(CONTEXT_VARIANTS.flatMap(value => {
        const label = value === 'full-context' ? 'Full context' : value.replace('k-context', 'k context');
        return [[value, label], [`metered-${value}`, `Metered · ${label}`]];
    })) };
const creditLabel = (cost, pool) => `${pool} credit${cost === 1 ? '' : 's'}`;
let recommendationSequence = 0;

function priceIncreaseMarkup(change) {
    const price = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 20 });
    return `<div class="lr-price-increase" role="alert"><b><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Model price increased</b>
        <p>Price multiplier increased from <strong>×${price(change.from)}</strong> to <strong>×${price(change.to)}</strong>.</p>
        <small>Request credits depend on your chat size. Cancelling this request is recommended.</small></div>`;
}

function cancelRequest(context, requestType) {
    try {
        // Quiet/background requests must not stop an unrelated foreground chat.
        if (['normal', 'swipe', 'continue', 'regenerate', 'impersonate'].includes(requestType)) context.stopGeneration?.();
    } finally {
        throw new DOMException('Request cancelled from LiteRouter', 'AbortError');
    }
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
}

function shownOnce(callback) {
    let shown = false;
    return () => { if (!shown) { shown = true; callback?.(); } };
}

async function showPopup(popup, signal, cancelledResult) {
    const cancelled = () => { void popup.complete(cancelledResult); };
    signal?.addEventListener('abort', cancelled, { once: true });
    try {
        const result = await popup.show();
        throwIfAborted(signal);
        return result;
    } finally { signal?.removeEventListener('abort', cancelled); }
}

function requestCostMarkup(review) {
    const cost = review.estimate?.cost;
    const amount = cost == null ? 'Cost estimate unavailable' : `≈ ${fmt(cost)} ${creditLabel(cost, review.pool ?? '')}`.trim();
    return `<div class="lr-request-cost" role="status"><span class="lr-recommendation-caption">Estimated spend for this request</span>
        <strong class="lr-cost-amount">${escapeHtml(amount)}</strong><b class="lr-cost-model">${escapeHtml(review.model)}</b>
        ${review.stale ? '<p class="lr-live-error">Using cached pricing; current prices could not be verified.</p>' : ''}
        <small>Estimate based on the built prompt. API-reported token usage takes precedence when returned.</small></div>`;
}

function requestPromptMarkup(review) {
    return `<details class="lr-prompt-preview"><summary>${review.promptProcessed ? 'Inspect processed prompt' : 'Inspect assembled prompt'}</summary>
        <p class="lr-muted">This prompt is already built. Proceeding keeps the same lorebook entries and resolved macros.</p>${processedPromptMarkup(review.prompt)}</details>`;
}

export async function showRequestConfirmation(context, review, signal, requestType) {
    throwIfAborted(signal);
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
        globalThis.toastr?.warning('Cost confirmation is unavailable. Update SillyTavern to review requests. Request cancelled.', 'LiteRouter');
        cancelRequest(context, requestType);
    }
    const content = document.createElement('div');
    content.className = 'lr-root lr-recommendations';
    content.innerHTML = `<div class="lr-recommendation-header"><div><span class="lr-recommendation-eyebrow">Before sending</span><h3>Review request</h3></div></div>
        ${requestCostMarkup(review)}${requestPromptMarkup(review)}`;
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true, okButton: 'Proceed', cancelButton: 'Cancel request', defaultResult: POPUP_RESULT.NEGATIVE,
    });
    popup.dlg.classList.add('lr-recommendation-popup', 'lr-request-confirm-popup');
    popup.cancelButton.classList.add('lr-cancel-request');
    const result = await showPopup(popup, signal, POPUP_RESULT.CANCELLED);
    if (result !== POPUP_RESULT.AFFIRMATIVE) cancelRequest(context, requestType);
    return true;
}

export async function showPriceIncrease(context, model, change, signal, requestType, onShown, review = null) {
    throwIfAborted(signal);
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
        globalThis.toastr?.warning('Model price increased. Update SillyTavern to review price warnings. Request cancelled.', 'LiteRouter');
        cancelRequest(context, requestType);
    }
    const content = document.createElement('div');
    content.className = 'lr-root lr-recommendations';
    content.innerHTML = `<div class="lr-recommendation-header"><div><span class="lr-recommendation-eyebrow">Selected model</span><h3>${escapeHtml(model)}</h3></div></div>${priceIncreaseMarkup(change)}
        ${review ? requestCostMarkup(review) + requestPromptMarkup(review) : ''}`;
    const markShown = shownOnce(onShown);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true, okButton: 'Continue (not recommended)', cancelButton: 'Cancel request (recommended)',
        defaultResult: POPUP_RESULT.NEGATIVE, onOpen: markShown, onClose: markShown,
    });
    popup.dlg.classList.add('lr-recommendation-popup', 'lr-price-increase-popup');
    popup.cancelButton.classList.add('lr-cancel-request');
    const result = await showPopup(popup, signal, POPUP_RESULT.CANCELLED);
    if (result !== POPUP_RESULT.AFFIRMATIVE) cancelRequest(context, requestType);
    return true;
}

function recommendationCard(row, index, recommendation, radioName) {
    const savings = recommendation.original.cost - row.estimate.cost;
    const percent = (savings / recommendation.original.cost * 100).toLocaleString('en-US', { maximumFractionDigits: 1 });
    const extra = row.model.id.split(':')[0].slice(recommendation.base.length).replace(/^-/, '');
    const tags = [PRICE_LABELS[modelType(row.model)], extra].filter(Boolean);
    return `<label class="lr-recommendation-choice">
        <input type="radio" name="${radioName}" value="${escapeHtml(row.model.id)}"${index === 0 ? ' checked' : ''}>
        <span class="lr-recommendation-model">
            <span class="lr-recommendation-badges">${index === 0 ? '<span class="lr-recommendation-best">Lowest cost</span>' : ''}<span class="lr-recommendation-status lr-${row.status.key}">${escapeHtml(STATUS_LABELS[row.status.key])}</span></span>
            <b>${escapeHtml(row.model.id)}</b>
            <span class="lr-recommendation-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</span>
        </span>
        <span class="lr-recommendation-price">
            <strong class="lr-recommendation-cost">${fmt(row.estimate.cost)}</strong>
            <span class="lr-recommendation-unit">${creditLabel(row.estimate.cost, recommendation.pool)}</span>
            <span class="lr-recommendation-savings">Save ${fmt(savings)} · ${percent}%</span>
        </span>
    </label>`;
}

export async function showRecommendations(context, recommendation, signal, requestType, priceIncrease = null, onShown, review = null) {
    throwIfAborted(signal);
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
        if (priceIncrease) await showPriceIncrease(context, recommendation.current.id, priceIncrease, signal, requestType, onShown, review);
        if (review) {
            globalThis.toastr?.warning('Cost confirmation is unavailable. Update SillyTavern to review requests. Request cancelled.', 'LiteRouter');
            cancelRequest(context, requestType);
        }
        globalThis.toastr?.warning('Update SillyTavern to use its native recommendation modal. Keeping your selected model.', 'LiteRouter');
        return null;
    }
    const content = document.createElement('div');
    content.className = 'lr-root lr-recommendations';
    // Separate radio groups keep concurrent native popups' selections independent.
    const radioName = `lr-recommendation-${++recommendationSequence}`;
    const selectedReview = row => ({ ...review, model: row.model.id, estimate: row.estimate, pool: recommendation.pool });
    content.innerHTML = `<div class="lr-recommendation-header"><div><span class="lr-recommendation-eyebrow">Model recommendations</span><h3>${escapeHtml(recommendation.base)}</h3></div><span class="lr-recommendation-tokens">≈ ${fmt(recommendation.inputTokens)} input tokens</span></div>
        ${priceIncrease ? priceIncreaseMarkup(priceIncrease) : ''}
        ${review ? requestCostMarkup(selectedReview(recommendation.choices[0])) + requestPromptMarkup(review)
            : recommendation.prompt ? `<details class="lr-prompt-preview"><summary>Inspect processed prompt</summary><p class="lr-muted">This prompt is already built. Choosing a model keeps the same lorebook entries and resolved macros.</p>${processedPromptMarkup(recommendation.prompt)}</details>` : ''}
        <div class="lr-recommendation-current"><div><span class="lr-recommendation-caption">Selected model</span><b>${escapeHtml(recommendation.current.id)}</b></div><div class="lr-recommendation-current-price"><strong>${fmt(recommendation.original.cost)}</strong><span>${creditLabel(recommendation.original.cost, recommendation.pool)}</span></div></div>
        <div class="lr-recommendation-list-heading"><b>Lower-cost options</b><span class="lr-muted">${recommendation.choices.length} available · Estimated per request</span></div>
        <div class="lr-recommendation-list" role="radiogroup" aria-label="Suggested models">${recommendation.choices.map((row, index) => recommendationCard(row, index, recommendation, radioName)).join('')}</div>`;
    const cancelResult = POPUP_RESULT.CUSTOM1 ?? 1001;
    const markShown = shownOnce(onShown);
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true, okButton: review ? 'Proceed with selected model' : 'Use selected model',
        cancelButton: priceIncrease ? 'Keep original model (not recommended)' : review ? 'Proceed with original model' : 'Keep original model',
        defaultResult: priceIncrease || review ? cancelResult : POPUP_RESULT.AFFIRMATIVE,
        onOpen: markShown, onClose: markShown,
        customButtons: [{ text: priceIncrease ? 'Cancel request (recommended)' : 'Cancel request', result: cancelResult, classes: ['lr-cancel-request'], appendAtEnd: true,
            tooltip: 'Stop this request without sending it to LiteRouter' }],
    });
    popup.dlg.classList.add('lr-recommendation-popup');
    if (review) {
        content.addEventListener('change', event => {
            if (event.target.name !== radioName) return;
            const row = recommendation.choices.find(value => value.model.id === event.target.value);
            if (row) content.querySelector('.lr-request-cost').outerHTML = requestCostMarkup(selectedReview(row));
        });
    }
    if (priceIncrease || review) {
        // The native close icon normally returns NEGATIVE (keep the original).
        // A warning may continue at the higher price only through an explicit choice.
        popup.closeButton.addEventListener('click', event => {
            event.stopImmediatePropagation();
            void popup.complete(cancelResult);
        }, { capture: true });
    }
    const result = await showPopup(popup, signal, POPUP_RESULT.CANCELLED);
    if (result === cancelResult || (priceIncrease || review) && result !== POPUP_RESULT.AFFIRMATIVE && result !== POPUP_RESULT.NEGATIVE) {
        cancelRequest(context, requestType);
    }
    return result === POPUP_RESULT.AFFIRMATIVE ? content.querySelector('input:checked')?.value : null;
}
