const PROCESS_PATH = '/api/backends/chat-completions/process';
const TOKENIZER_PATH = '/api/tokenizers/openai';
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const tokenizerModel = model => String(model ?? '').split(':')[0];

// Mirror the Custom backend's YAML merge/exclusion rules. These strings have
// already had their macros expanded by ST; never evaluate prompt macros here.
function yamlValue(text, parseYaml) {
    if (!text) return null;
    if (parseYaml) {
        try { return parseYaml(text); } catch { return null; } // ST ignores invalid YAML.
    }
    return JSON.parse(text);
}

function overrides(request, parseYaml) {
    const included = yamlValue(request.custom_include_body, parseYaml);
    const body = Object.create(null);
    for (const item of Array.isArray(included) ? included : [included]) {
        if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(body, item);
    }
    const excluded = yamlValue(request.custom_exclude_body, parseYaml);
    const keys = Array.isArray(excluded) ? excluded : typeof excluded === 'string' ? [excluded]
        : excluded && typeof excluded === 'object' ? Object.keys(excluded) : [];
    return { body, keys };
}

function countableMessages(messages) {
    return messages.map(message => {
        const result = {};
        for (const [key, value] of Object.entries(message)) {
            if (value == null) continue;
            if (key === 'content' && Array.isArray(value)) {
                // Counting a base64 image URL as text produces enormous, false
                // counts. Media needs provider accounting, not a fixed estimate.
                if (value.some(part => part?.type !== 'text' || typeof part.text !== 'string')) {
                    throw new Error('Media token usage requires API-reported counts.');
                }
                result.content = value.map(part => part.text).join('\n\n');
            } else result[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
        return result;
    });
}

export function createRequestTokenCounter({ fetcher = globalThis.fetch.bind(globalThis), getHeaders, parseYaml } = {}) {
    // Share completed/pending counts between the held recommendation and usage
    // observer. Bound the in-memory cache; no prompts are saved to user settings.
    const cache = new Map();
    async function post(path, body, signal) {
        const response = await fetcher(path, { method: 'POST', headers: getHeaders?.() ?? { 'Content-Type': 'application/json' },
            credentials: 'same-origin', body: JSON.stringify(body), signal });
        if (!response.ok) throw new Error(`SillyTavern prompt counting failed (HTTP ${response.status}).`);
        return await response.json();
    }
    async function encode(text, model, signal) {
        if (!text) return 0;
        const result = await post(`${TOKENIZER_PATH}/encode?model=${encodeURIComponent(model)}`, { text }, signal);
        // ST returns an empty result on tokenizer failure. Don't silently turn a
        // nonempty prompt or reply into zero tokens.
        if (!Array.isArray(result.ids) || !result.ids.length) throw new Error('SillyTavern tokenizer returned no tokens.');
        return result.ids.length;
    }
    async function measure(captured, signal) {
        const result = { tokens: null, source: 'unknown', model: captured.model, messages: null };
        try {
            let messages = structuredClone(captured.messages);
            if (Array.isArray(messages) && captured.custom_prompt_post_processing) {
                const processed = await post(PROCESS_PATH, { messages, type: captured.custom_prompt_post_processing,
                    char_name: captured.char_name, user_name: captured.user_name, group_names: captured.group_names }, signal);
                if (!Array.isArray(processed.messages)) throw new Error('SillyTavern returned an invalid processed prompt.');
                messages = processed.messages;
            }
            const { body, keys } = overrides(captured, parseYaml);
            // Custom includes are applied after prompt processing. ST overrides
            // included tool definitions when the assembled request has tools.
            const outgoing = { messages, model: captured.model, ...body };
            if (Array.isArray(captured.tools) && captured.tools.length) outgoing.tools = captured.tools;
            if (captured.json_schema?.value) outgoing.response_format = { type: 'json_schema', json_schema: {
                name: captured.json_schema.name, strict: captured.json_schema.strict ?? true, schema: captured.json_schema.value } };
            for (const key of keys) delete outgoing[key];
            result.model = outgoing.model;
            result.modelOverridden = Object.hasOwn(body, 'model') || keys.includes('model');
            result.messages = outgoing.messages ?? null;
            result.tools = outgoing.tools;
            result.responseFormat = outgoing.response_format;
            const model = tokenizerModel(outgoing.model);
            if (!model) throw new Error('The outgoing model is unavailable.');
            let tokens;
            if (typeof outgoing.messages === 'string') {
                tokens = await encode(outgoing.messages, model, signal);
            } else if (Array.isArray(outgoing.messages)) {
                const counted = await post(`${TOKENIZER_PATH}/count?model=${encodeURIComponent(model)}`,
                    countableMessages(outgoing.messages), signal);
                tokens = counted.token_count;
                if (!validCount(tokens) || tokens === 0 && outgoing.messages.length) throw new Error('SillyTavern returned an invalid token count.');
            } else throw new Error('The outgoing messages are unavailable.');
            // Provider tool/schema framing is proprietary. Include their text in
            // the estimate rather than omitting it or mis-tokenizing JSON arrays.
            const extra = [outgoing.tools, outgoing.response_format].filter(value => value != null);
            if (extra.length) tokens += await encode(extra.map(value => JSON.stringify(value)).join('\n'), model, signal);
            if (!validCount(tokens)) throw new Error('SillyTavern returned an invalid token count.');
            result.tokens = tokens;
            result.source = 'tokenizer';
            result.note = extra.length ? 'Tool and schema formatting is estimated; API usage takes precedence.' : null;
        } catch (error) { result.note = error.message || 'Processed prompt count unavailable.'; }
        return result;
    }
    function countRequest(request, signal) {
        // Snapshot before the first await so later settings/model changes cannot
        // affect this request's selected lorebook entries or macro values.
        const captured = structuredClone(Object.fromEntries(['model', 'messages', 'custom_prompt_post_processing',
            'char_name', 'user_name', 'group_names', 'custom_include_body', 'custom_exclude_body', 'tools', 'json_schema']
            .map(key => [key, request[key]])));
        const key = JSON.stringify({ ...captured, model: tokenizerModel(captured.model) });
        if (cache.has(key)) return cache.get(key);
        const timeout = AbortSignal.timeout(12000);
        const countingSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const pending = measure(captured, countingSignal);
        cache.set(key, pending);
        while (cache.size > 8) cache.delete(cache.keys().next().value);
        void pending.then(result => { if (result.tokens == null && cache.get(key) === pending) cache.delete(key); });
        return pending;
    }
    countRequest.countOutputTokens = async (model, replies) => {
        const signal = AbortSignal.timeout(12000);
        const counts = await Promise.all(replies.map(reply => encode(reply, tokenizerModel(model), signal)));
        return counts.reduce((sum, count) => sum + count, 0);
    };
    countRequest.getModel = request => {
        try {
            const { body, keys } = overrides(request, parseYaml);
            const model = Object.hasOwn(body, 'model') ? body.model : request.model;
            return !keys.includes('model') && typeof model === 'string' && model ? model : null;
        } catch { return null; }
    };
    return countRequest;
}
