import { fmt, modelType, STATUS_LABELS } from './core.js';
import { escapeHtml } from './picker.js';

const PRICE_LABELS = { free: 'Free', metered: 'Metered', 'metered-full-context': 'Metered · Full context', 'full-context': 'Full context', premium: 'Standard pricing' };
const creditLabel = (cost, pool) => `${pool} credit${cost === 1 ? '' : 's'}`;
let recommendationSequence = 0;

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

export async function showRecommendations(context, recommendation, signal, requestType) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
        globalThis.toastr?.warning('Update SillyTavern to use its native recommendation modal. Keeping your selected model.', 'LiteRouter');
        return null;
    }
    const content = document.createElement('div');
    content.className = 'lr-root lr-recommendations';
    // Separate radio groups keep concurrent native popups' selections independent.
    const radioName = `lr-recommendation-${++recommendationSequence}`;
    content.innerHTML = `<div class="lr-recommendation-header"><div><span class="lr-recommendation-eyebrow">Model recommendations</span><h3>${escapeHtml(recommendation.base)}</h3></div><span class="lr-recommendation-tokens">${fmt(recommendation.inputTokens)} input tokens</span></div>
        <div class="lr-recommendation-current"><div><span class="lr-recommendation-caption">Selected model</span><b>${escapeHtml(recommendation.current.id)}</b></div><div class="lr-recommendation-current-price"><strong>${fmt(recommendation.original.cost)}</strong><span>${creditLabel(recommendation.original.cost, recommendation.pool)}</span></div></div>
        <div class="lr-recommendation-list-heading"><b>Lower-cost options</b><span class="lr-muted">${recommendation.choices.length} available · Estimated per request</span></div>
        <div class="lr-recommendation-list" role="radiogroup" aria-label="Suggested models">${recommendation.choices.map((row, index) => recommendationCard(row, index, recommendation, radioName)).join('')}</div>`;
    const cancelResult = POPUP_RESULT.CUSTOM1 ?? 1001;
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true, okButton: 'Use selected model', cancelButton: 'Keep original model',
        customButtons: [{ text: 'Cancel request', result: cancelResult, classes: ['lr-cancel-request'], appendAtEnd: true,
            tooltip: 'Stop this request without sending it to LiteRouter' }],
    });
    popup.dlg.classList.add('lr-recommendation-popup');
    const cancelled = () => { void popup.complete(POPUP_RESULT.CANCELLED); };
    signal?.addEventListener('abort', cancelled, { once: true });
    try {
        if (signal?.aborted) return null;
        const result = await popup.show();
        signal?.removeEventListener('abort', cancelled);
        if (result === cancelResult) {
            // Use Prompt Inspector's native stop hook for foreground generations.
            // Quiet/background requests must not stop an unrelated active chat.
            try {
                if (['normal', 'swipe', 'continue', 'regenerate', 'impersonate'].includes(requestType)) context.stopGeneration?.();
            } finally {
                // Reject this held fetch before model changes or the usage observer run.
                throw new DOMException('Request cancelled from model recommendations', 'AbortError');
            }
        }
        return result === POPUP_RESULT.AFFIRMATIVE ? content.querySelector('input:checked')?.value : null;
    } finally { signal?.removeEventListener('abort', cancelled); }
}
