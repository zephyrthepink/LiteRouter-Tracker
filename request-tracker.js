import { isLiteRouterConnection, calculate } from './core.js';
import { isSharedOutputModel } from './usage.js';

const textContent = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
const toolContent = calls => Array.isArray(calls) ? calls.map(call => `${call?.function?.name ?? ''}${call?.function?.arguments ?? ''}`).join('\n') : '';
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function inputTokenTotal(data) {
    const counts = [tokenCount(data?.usage?.prompt_tokens), tokenCount(data?.usage?.input_tokens),
        tokenCount(data?.usageMetadata?.promptTokenCount)];
    return counts.find(count => count > 0) ?? counts.find(count => count != null) ?? null;
}

function outputTokenTotal(data) {
    const completion = tokenCount(data?.usage?.completion_tokens);
    if (completion > 0) return completion;
    // Some compatible responses preserve upstream output usage names. These are
    // alternative request totals, never additional tokens on top of the OpenAI total.
    const output = tokenCount(data?.usage?.output_tokens);
    const metadata = data?.usageMetadata;
    const candidates = tokenCount(metadata?.candidatesTokenCount);
    const thoughts = metadata?.thoughtsTokenCount === undefined ? 0 : tokenCount(metadata.thoughtsTokenCount);
    const google = candidates != null && thoughts != null ? tokenCount(candidates + thoughts) : null;
    return [output, google].find(count => count > 0) ?? completion ?? output ?? google;
}

const GENERATE_PATH = '/api/backends/chat-completions/generate';
// Observe transport once per request: covers swipes, continues, tools and background calls,
// without relying on message events (which can fire repeatedly or never fire for quiet calls).
export function installRequestTracker({ target = globalThis, snapshot, record, onError = console.error, now = Date.now }) {
    const original = target.fetch;
    const safe = callback => { try { callback(); } catch (error) { onError(error); } };
    const wrapped = async function(input, options) {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        let request, capture;
        try {
            const pathname = new URL(url, target.location?.href ?? 'http://localhost').pathname;
            const method = options?.method ?? input?.method ?? 'GET';
            if (pathname === GENERATE_PATH && method.toUpperCase() === 'POST') {
                const body = options?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : null);
                request = typeof body === 'string' ? JSON.parse(body) : null;
                if (typeof request?.model === 'string' && request.model && isLiteRouterConnection({ mainApi: 'openai', chatCompletionSettings: { ...request, custom_model: request.model } })) {
                    capture = snapshot(request);
                    if (capture) capture = { ...capture, startedAt: now(), model: capture.model ?? request.model };
                }
            }
        } catch (error) { onError(error); }
        // Do not change request fields, credentials, headers, abort signals or errors.
        const response = await original.call(this, input, options);
        if (!capture || !response.ok) return response;
        const observer = new CompletionObserver(capture, record, onError);
        if (!request.stream) {
            // Non-stream responses are already complete; inspect a clone without consuming ST's body.
            void response.clone().json().then(data => { observer.accept(data); observer.finish(); }).catch(onError);
            return response;
        }
        if (!response.body) return response;
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        const consume = text => {
            buffer += text;
            const lines = buffer.split(/\r?\n/); buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const value = line.slice(5).trim();
                if (value === '[DONE]') { observer.finish(); continue; }
                try { observer.accept(JSON.parse(value)); } catch { /* Keep malformed data for ST to handle normally. */ }
            }
        };
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    const chunk = await reader.read();
                    if (chunk.done) { safe(() => { consume(decoder.decode() + '\n'); observer.finish(); }); controller.close(); }
                    else { safe(() => consume(decoder.decode(chunk.value, { stream: true }))); controller.enqueue(chunk.value); }
                } catch (error) { safe(() => observer.finish(true)); controller.error(error); }
            },
            cancel(reason) { safe(() => observer.finish(true)); return reader.cancel(reason); },
        });
        const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        for (const key of ['url', 'redirected', 'type']) Object.defineProperty(observed, key, { value: response[key] });
        return observed;
    };
    target.fetch = wrapped;
    return () => { if (target.fetch === wrapped) target.fetch = original; };
}

export class CompletionObserver {
    constructor(capture, record, onError = console.error) {
        this.capture = capture; this.record = record; this.onError = onError;
        this.seen = false; this.failed = false; this.finished = false; this.apiTokens = null;
        this.apiOutputTokens = null; this.outputs = new Map();
    }
    accept(data) {
        if (this.finished) return;
        if (data?.error) { this.failed = true; return; }
        if (Array.isArray(data?.choices) && data.choices.length > 0) this.seen = true;
        const inputTokens = inputTokenTotal(data);
        if (inputTokens != null) { this.apiTokens = Math.max(this.apiTokens ?? 0, inputTokens); this.seen = true; }
        const outputTokens = outputTokenTotal(data);
        if (outputTokens != null) {
            // SSE usage values are request totals, including reasoning and all choices.
            this.apiOutputTokens = Math.max(this.apiOutputTokens ?? 0, outputTokens); this.seen = true;
        }
        if (!isSharedOutputModel(this.capture.model) || !Array.isArray(data?.choices)) return;
        data.choices.forEach((choice, position) => {
            const index = Number.isSafeInteger(choice?.index) ? choice.index : position;
            const output = this.outputs.get(index) ?? { content: '', reasoning: '', tools: '' };
            const message = choice?.message ?? choice?.delta;
            if (!message) return;
            const parts = { content: textContent(message.content),
                reasoning: textContent(message.reasoning_content ?? message.reasoning ?? message.reasoning_text),
                tools: toolContent(message.tool_calls) || toolContent(message.function_call ? [{ function: message.function_call }] : []) };
            for (const [key, text] of Object.entries(parts)) {
                if (!text) continue;
                if (choice.message) output[key] = text;
                else output[key] += text;
            }
            this.outputs.set(index, output);
        });
    }
    finish(partial = false) {
        if (this.finished) return;
        this.finished = true;
        if (!this.seen) return;
        void this.finalize(partial || this.failed).catch(this.onError);
    }
    async finalize(partial) {
        const capture = this.capture;
        const fallback = this.apiTokens == null ? await capture.inputTokens : null;
        const inputTokens = this.apiTokens ?? fallback?.tokens ?? null;
        const replies = isSharedOutputModel(capture.model) ? [...this.outputs.values()]
            .map(output => [output.reasoning, output.content, output.tools].filter(Boolean).join('\n')).filter(Boolean) : [];
        // A zero alongside actual reply text is missing usage, not an empty reply.
        // In particular, an initial streamed zero must not suppress local counting.
        let outputTokens = this.apiOutputTokens === 0 && replies.length ? null : this.apiOutputTokens;
        let outputTokenSource = outputTokens == null ? 'unknown' : 'api';
        if (outputTokens == null && isSharedOutputModel(capture.model) && typeof capture.countOutputTokens === 'function') {
            if (replies.length) {
                try {
                    const count = await capture.countOutputTokens(replies);
                    if (Number.isSafeInteger(count) && count > 0) { outputTokens = count; outputTokenSource = 'tokenizer'; }
                } catch { /* Missing/failed tokenization is visible as unknown output usage. */ }
            }
        }
        this.outputs.clear();
        const estimate = capture.pricingModel && capture.plan
            ? calculate(capture.pricingModel, inputTokens, capture.plan, capture.settings, capture.rules) : null;
        this.record({ model: capture.model, startedAt: capture.startedAt, inputTokens, outputTokens, outputTokenSource, partial,
            tokenSource: this.apiTokens != null ? 'api' : fallback?.source ?? 'unknown',
            cost: estimate?.cost ?? null, type: estimate?.type ?? 'unknown', stale: capture.stale,
            premiumAllowance: capture.plan ? capture.settings.credits ?? capture.plan.cap : null }, capture);
    }
}
