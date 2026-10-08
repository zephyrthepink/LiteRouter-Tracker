import { fmt } from './core.js';
import { escapeHtml } from './picker.js';

export function processedPromptMarkup(count) {
    if (!count) return '<p class="lr-muted">Counting the processed prompt…</p>';
    const label = count.tokens == null ? 'Token estimate unavailable' : `≈ ${fmt(count.tokens)} input tokens · Tokenizer estimate`;
    const prompt = { messages: count.messages };
    if (count.tools != null) prompt.tools = count.tools;
    if (count.responseFormat != null) prompt.response_format = count.responseFormat;
    return `<p class="lr-muted">${escapeHtml(label)}${count.note ? `<br>${escapeHtml(count.note)}` : ''}</p>
        ${count.messages != null ? `<pre class="lr-processed-prompt" tabindex="0">${escapeHtml(JSON.stringify(prompt, null, 2))}</pre>` : ''}`;
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
