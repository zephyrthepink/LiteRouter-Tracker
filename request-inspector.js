import { fmt } from './core.js';
import { escapeHtml } from './picker.js';

function tokenBreakdownMarkup(count) {
    const breakdown = count.breakdown;
    if (!breakdown) return `<p class="lr-muted">System and conversation token counts unavailable.${count.breakdownNote ? ` ${escapeHtml(count.breakdownNote)}` : ''}</p>`;
    const rows = [['System (system role)', breakdown.systemTokens],
        ['Conversation (user + assistant)', breakdown.conversationTokens]];
    if (breakdown.otherTokens) rows.push(['Other message roles', breakdown.otherTokens]);
    if (breakdown.extraTokens) rows.push(['Tool definitions / response schema', breakdown.extraTokens]);
    if (breakdown.formattingTokens) rows.push(['Shared formatting / tokenization adjustment', breakdown.formattingTokens]);
    return `<div class="lr-token-breakdown" aria-label="Prompt token breakdown"><p class="lr-muted">Tokens by role · Tokenizer estimates</p>
        <dl>${rows.map(([label, tokens]) => `<div><dt>${escapeHtml(label)}</dt><dd>≈ ${escapeHtml(fmt(tokens))}</dd></div>`).join('')}</dl>
        <small class="lr-muted">Role counts include message fields and per-message formatting. API usage reports the total; this breakdown remains an estimate.</small></div>`;
}

export function processedPromptMarkup(count) {
    if (!count) return '<p class="lr-muted">Counting the processed prompt…</p>';
    const label = count.tokens == null ? 'Token estimate unavailable' : `≈ ${fmt(count.tokens)} input tokens · Tokenizer estimate`;
    const prompt = { messages: count.messages };
    if (count.tools != null) prompt.tools = count.tools;
    if (count.responseFormat != null) prompt.response_format = count.responseFormat;
    return `<p class="lr-muted">${escapeHtml(label)}${count.note ? `<br>${escapeHtml(count.note)}` : ''}</p>
        ${tokenBreakdownMarkup(count)}
        ${count.messages != null ? `<textarea class="text_pole lr-processed-prompt" readonly rows="12" aria-label="Request prompt">${escapeHtml(JSON.stringify(prompt, null, 2))}</textarea>` : ''}`;
}

export function renderRequestInspector(root, request) {
    const description = root.querySelector('.lr-request-description');
    const content = root.querySelector('.lr-request-content');
    if (!request) return;
    const usage = request.usage;
    const input = usage?.tokenSource === 'api' ? `${fmt(usage.inputTokens)} input tokens · API reported`
        : request.count?.tokens != null ? `≈ ${fmt(request.count.tokens)} input tokens · Tokenizer estimate`
            : request.count ? 'Input count unavailable' : 'Counting input tokens…';
    const output = usage?.outputTokens != null ? ` · ${usage.outputTokenSource === 'api' ? '' : '≈ '}${fmt(usage.outputTokens)} output tokens · ${usage.outputTokenSource === 'api' ? 'API reported' : 'Tokenizer estimate'}` : '';
    description.textContent = `${request.model} · ${input}${output}${usage?.partial ? ' · Partial response' : ''}`;
    content.innerHTML = processedPromptMarkup(request.count);
}
