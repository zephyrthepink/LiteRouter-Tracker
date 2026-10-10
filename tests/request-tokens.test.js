import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, calculate } from '../core.js';
import { createRequestTokenCounter } from '../request-tokens.js';
import { installRequestRecommender } from '../recommendations.js';
import { installRequestTracker, CompletionObserver } from '../request-tracker.js';
import { processedPromptMarkup, renderRequestInspector } from '../request-inspector.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const request = () => ({ model: 'gpt-4o', type: 'normal', chat_completion_source: 'custom', custom_url: 'https://api.literouter.com/v1',
    custom_prompt_post_processing: 'strict', char_name: 'Character', user_name: 'User',
    messages: [{ role: 'system', content: 'Rules. Chosen random branch: long.' },
        { role: 'system', content: 'Included lorebook: the city is underwater.' }, { role: 'assistant', content: 'Continue.' }] });
const processed = [
    { role: 'system', content: 'Rules. Chosen random branch: long.\n\nIncluded lorebook: the city is underwater.' },
    { role: 'user', content: "Let's get started." }, { role: 'assistant', content: 'Continue.' },
];

function counterFixture({ process = () => processed, count = 60001, encode = 7 } = {}) {
    const calls = [];
    let fullLength;
    const fetcher = async (url, options) => {
        const call = { url, ...options, payload: JSON.parse(options.body) }; calls.push(call);
        if (url.endsWith('/process')) { fullLength = undefined; return json({ messages: await process(call.payload) }); }
        if (url.includes('/count?')) {
            fullLength ??= call.payload.length;
            return json({ token_count: typeof count === 'function' ? await count(call.payload)
                : call.payload.length ? 3 + Math.floor((count - 3) * call.payload.length / fullLength) : 3 });
        }
        if (url.includes('/encode?')) return json({ ids: Array.from({ length: encode }, (_, i) => i), count: encode });
        throw new Error('Unexpected network request: ' + url);
    };
    return { calls, fetcher, counter: createRequestTokenCounter({ fetcher, getHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }) }) };
}

test('counts the built prompt after server transformations, including lore and selected macros, without mutating it', async () => {
    const f = counterFixture(), input = request(), saved = structuredClone(input);
    const result = await f.counter(input);
    assert.deepEqual(input, saved);
    assert.equal(result.tokens, 60001);
    assert.equal(result.source, 'tokenizer');
    assert.deepEqual(result.messages, processed);
    assert.deepEqual(f.calls[0].payload, { messages: input.messages, type: 'strict', char_name: 'Character', user_name: 'User' });
    assert.deepEqual(f.calls[1].payload, processed); // Structured messages, not their JSON text.
    assert.equal(f.calls[1].url, '/api/tokenizers/openai/count?model=gpt-4o');
    for (const call of f.calls) {
        assert.equal(call.credentials, 'same-origin');
        assert.equal(call.headers['X-CSRF-Token'], 'csrf');
        assert(call.signal instanceof AbortSignal);
        assert(!call.url.includes('literouter.com')); // Counting never sends a generation.
    }
});

test('snapshots messages before asynchronous processing and shares counts across pricing variants', async () => {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const f = counterFixture({ process: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const input = request(), pending = f.counter(input);
    await ready;
    input.messages[0].content = 'Later chat/settings edit';
    release(processed);
    await pending;
    assert.equal(f.calls[0].payload.messages[0].content, 'Rules. Chosen random branch: long.');
    const again = await f.counter({ ...request(), model: 'gpt-4o:cheap' });
    assert.equal(again.tokens, 60001);
    assert.equal(f.calls.length, 5);
    const differentModel = f.counter({ ...request(), model: 'claude-sonnet-4.5' });
    // The process fixture is held again for this different model.
    release(processed);
    await differentModel;
});

test('a request without post-processing goes straight to the structured tokenizer', async () => {
    const f = counterFixture(), input = { ...request(), custom_prompt_post_processing: '' };
    await f.counter(input);
    assert.equal(f.calls.length, 4);
    assert.deepEqual(f.calls[0].payload, input.messages);
});

test('custom body overrides are applied after processing, and exclusions remove tools from the estimate', async () => {
    const f = counterFixture();
    const overridden = [{ role: 'user', content: 'Outgoing custom-body message' }];
    const result = await f.counter({ ...request(), custom_include_body: JSON.stringify([
        { messages: overridden }, { model: 'claude-sonnet-4.5:cheap', tools: [{ type: 'function' }] },
    ]), custom_exclude_body: '["tools"]' });
    assert.deepEqual(result.messages, overridden);
    assert.equal(result.model, 'claude-sonnet-4.5:cheap');
    assert.equal(result.tools, undefined);
    assert.deepEqual(f.calls[1].payload, overridden);
    assert.match(f.calls[1].url, /model=claude-sonnet-4.5$/);
    assert.equal(f.calls.length, 3);
});

test('missing processing support never silently counts the unprocessed prompt, and failed results can retry', async () => {
    let available = false, counts = 0;
    const counter = createRequestTokenCounter({ fetcher: async url => {
        if (url.endsWith('/process')) return available ? json({ messages: processed }) : new Response('', { status: 404 });
        counts++; return json({ token_count: 800 });
    } });
    const missing = await counter(request());
    assert.equal(missing.tokens, null);
    assert.equal(missing.source, 'unknown');
    assert.equal(missing.messages, null);
    assert.equal(counts, 0);
    available = true;
    assert.equal((await counter(request())).tokens, 800);
});

test('media is unavailable locally rather than counting a base64 image or guessing a fixed token cost', async () => {
    const f = counterFixture();
    const result = await f.counter({ ...request(), custom_prompt_post_processing: '', messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look at this.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(10000) } }] },
    ] });
    assert.equal(result.tokens, null);
    assert.equal(result.source, 'unknown');
    assert.match(result.note, /Media.*API/);
    assert.equal(f.calls.length, 0);
});

test('text parts and tool calls are countable and tool definitions are included as an estimate', async () => {
    const f = counterFixture({ count: 20 });
    const tools = [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }];
    const toolCalls = [{ id: '1', type: 'function', function: { name: 'search', arguments: '{"query":"city"}' } }];
    const result = await f.counter({ ...request(), custom_prompt_post_processing: '', tools, messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'One' }, { type: 'text', text: 'Two' }], tool_calls: toolCalls },
    ] });
    assert.equal(f.calls[0].payload[0].content, 'One\n\nTwo');
    assert.equal(f.calls[0].payload[0].tool_calls, JSON.stringify(toolCalls));
    assert.match(f.calls[1].payload.text, /search/);
    assert.equal(result.tokens, 27);
    assert.match(result.note, /Tool.*estimated/);
    assert.deepEqual(result.tools, tools);
});

test('reply fallback encodes raw text with the captured model without chat formatting tokens', async () => {
    const f = counterFixture();
    assert.equal(await f.counter.countOutputTokens('claude-sonnet-4.5:cheap', ['Thoughts\nReply', 'Other choice']), 14);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) assert.equal(call.url, '/api/tokenizers/openai/encode?model=claude-sonnet-4.5');
    assert.deepEqual(f.calls[0].payload, { text: 'Thoughts\nReply' });
    const broken = counterFixture({ encode: 0 });
    await assert.rejects(broken.counter.countOutputTokens('claude-sonnet-4.5', ['Nonempty']), /no tokens/);
});

test('API counts override the processed estimate, including native aliases and later streamed zero placeholders', async () => {
    for (const usage of [{ usage: { prompt_tokens: 222, completion_tokens: 33 } },
        { usage: { input_tokens: 222, output_tokens: 33 } },
        { usageMetadata: { promptTokenCount: 222, candidatesTokenCount: 20, thoughtsTokenCount: 13 } }]) {
        let entry;
        const observer = new CompletionObserver({ model: 'gpt-4o', startedAt: 0,
            inputTokens: Promise.resolve({ tokens: 111, source: 'tokenizer' }) }, recorded => { entry = recorded; });
        observer.accept(usage);
        observer.accept({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
        await observer.finalize(false);
        assert.equal(entry.inputTokens, 222);
        assert.equal(entry.outputTokens, 33);
        assert.equal(entry.tokenSource, 'api');
        assert.equal(entry.outputTokenSource, 'api');
    }
});

test('suggestions hold the built prompt, use its processed estimate, reuse the count, and record the model actually sent', async () => {
    const f = counterFixture(), sent = [];
    const settings = { ...DEFAULTS, plan: 'Basic', recommendEnabled: true, recommendMode: 'suggest', generalSystem: 20, generalConversation: 20 };
    const pricing = { plans: [{ name: 'Basic', cap: 100, max: 128000, claudeMax: 128000 }],
        models: [{ id: 'gpt-4o', cost: 2, plan: 'Basic', tokens: [] }, { id: 'gpt-4o:cheap', cost: 1, plan: 'Basic', tokens: ['cheap'] }] };
    const target = { location: { href: 'http://localhost' }, fetch: async (input, options) => {
        sent.push({ input, options, payload: JSON.parse(options.body) });
        return json({ choices: [{ message: { content: 'Reply' } }], usage: { prompt_tokens: 60700, completion_tokens: 100 } });
    } };
    let recorded, ready, release;
    const done = new Promise(resolve => { recorded = resolve; });
    const opened = new Promise(resolve => { ready = resolve; });
    installRequestTracker({ target, snapshot: input => ({ inputTokens: f.counter(input), settings,
        pricingModel: pricing.models.find(model => model.id === input.model), plan: pricing.plans[0] }), record: entry => recorded(entry) });
    installRequestRecommender({ target, getSettings: () => settings, refresh: async () => {},
        getData: () => ({ pricing: { data: pricing }, status: { data: { models: [] } } }), getInputTokens: f.counter,
        choose: async recommendation => {
            assert.equal(recommendation.inputTokens, 60001);
            assert.deepEqual(recommendation.prompt.messages, processed);
            ready(); return await new Promise(resolve => { release = resolve; });
        }, notify: () => {}, apply: () => {} });
    const input = request(), saved = structuredClone(input), abort = new AbortController();
    const pending = target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(input),
        headers: { 'X-Test': 'preserved' }, credentials: 'same-origin', signal: abort.signal });
    await opened;
    assert.equal(sent.length, 0);
    input.messages[0].content = 'Changed after the suggestion opened';
    release('gpt-4o:cheap');
    const response = await pending;
    assert.equal((await response.json()).usage.prompt_tokens, 60700);
    const entry = await done;
    assert.deepEqual(sent[0].payload, { ...saved, model: 'gpt-4o:cheap' });
    assert.equal(sent[0].options.signal, abort.signal);
    assert.deepEqual(sent[0].options.headers, { 'X-Test': 'preserved' });
    assert.equal(sent[0].options.credentials, 'same-origin');
    assert.equal(f.calls.length, 5); // Processing, total, baseline, and two role groups, reused by tracking.
    assert.equal(entry.model, 'gpt-4o:cheap');
    assert.equal(entry.inputTokens, 60700);
    assert.equal(entry.outputTokens, 100);
    assert.equal(entry.tokenSource, 'api');
    assert.equal(entry.cost, calculate(pricing.models[1], 60700, pricing.plans[0], settings).cost);
});

test('inspection escapes untrusted prompt text and distinguishes reported usage from its estimate', () => {
    const count = { tokens: 10, messages: [{ role: 'system', content: '<script>evil()</script>' }],
        breakdown: { systemTokens: 4, conversationTokens: 3, otherTokens: 0, extraTokens: 0, formattingTokens: 3 } };
    assert.doesNotMatch(processedPromptMarkup(count), /<script>/);
    assert.match(processedPromptMarkup(count), /&lt;script&gt;/);
    const description = {}, content = {};
    renderRequestInspector({ querySelector: selector => selector === '.lr-request-description' ? description : content },
        { model: 'gpt-4o', count, usage: { inputTokens: 12, tokenSource: 'api', outputTokens: 3, outputTokenSource: 'api' } });
    assert.match(description.textContent, /12 input tokens · API reported/);
    assert.match(content.innerHTML, /10 input tokens · Tokenizer estimate/);
    assert.match(content.innerHTML, /System \(system role\)/);
    assert.match(content.innerHTML, /Conversation \(user \+ assistant\)/);
    assert.match(content.innerHTML, /≈ 4/);
    assert.match(content.innerHTML, /≈ 3/);
    assert.match(content.innerHTML, /breakdown remains an estimate/);
});

test('counts roles after processing and keeps shared request padding out of both groups', async () => {
    const count = messages => 12 + messages.reduce((sum, message) => sum + message.content.length + 4, 0);
    const f = counterFixture({ count });
    const result = await f.counter(request());
    const systemTokens = processed[0].content.length + 4;
    const conversationTokens = processed.slice(1).reduce((sum, message) => sum + message.content.length + 4, 0);
    assert.deepEqual(result.breakdown, { systemTokens, conversationTokens, otherTokens: 0, extraTokens: 0, formattingTokens: 12 });
    assert.equal(Object.values(result.breakdown).reduce((sum, value) => sum + value, 0), result.tokens);
    assert.deepEqual(f.calls[2].payload, []);
    assert.deepEqual(f.calls[3].payload, processed.slice(0, 1));
    assert.deepEqual(f.calls[4].payload, processed.slice(1));
});

test('classifies custom override roles exactly and separates tool replies, developer instructions, and schemas', async () => {
    const f = counterFixture({ count: messages => 3 + messages.length * 10, encode: 7 });
    const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Tool call' }, { role: 'tool', content: 'Tool result' },
        { role: 'developer', content: 'Instructions' }];
    const result = await f.counter({ ...request(), custom_include_body: JSON.stringify({ messages }),
        tools: [{ type: 'function', function: { name: 'search' } }],
        json_schema: { name: 'reply', value: { type: 'object' } } });
    assert.deepEqual(result.messages, messages);
    assert.deepEqual(result.breakdown, { systemTokens: 10, conversationTokens: 20, otherTokens: 20, extraTokens: 7, formattingTokens: 3 });
    assert.equal(result.tokens, 60);
    const markup = processedPromptMarkup(result);
    assert.match(markup, /Other message roles/);
    assert.match(markup, /Tool definitions \/ response schema/);
});

test('empty and single-role prompts show zero for absent roles without redundant group requests', async () => {
    for (const role of [null, 'system', 'user', 'assistant', 'tool']) {
        const f = counterFixture({ count: messages => 3 + messages.length * 10 });
        const messages = role ? [{ role, content: 'Text' }] : [];
        const result = await f.counter({ ...request(), custom_prompt_post_processing: '', messages });
        assert.deepEqual(result.breakdown, { systemTokens: role === 'system' ? 10 : 0,
            conversationTokens: ['user', 'assistant'].includes(role) ? 10 : 0,
            otherTokens: role === 'tool' ? 10 : 0, extraTokens: 0, formattingTokens: 3 });
        assert.equal(f.calls.length, role ? 2 : 1);
        assert.match(processedPromptMarkup(result), /≈ 0/);
    }
});

test('native tokenizer boundary differences remain a signed adjustment and the total stays unchanged', async () => {
    const f = counterFixture({ count: messages => messages.length === 0 ? 0 : messages.length === 3 ? 28 : messages.length * 10 });
    const result = await f.counter({ ...request(), model: 'claude-sonnet-4.5' });
    assert.deepEqual(result.breakdown, { systemTokens: 10, conversationTokens: 20, otherTokens: 0, extraTokens: 0, formattingTokens: -2 });
    assert.equal(result.tokens, 28);
    assert.match(processedPromptMarkup(result), /≈ -2/);
});

test('a failed role count preserves the available total and marks the breakdown unavailable', async () => {
    const f = counterFixture({ count: messages => {
        if (!messages.length) throw new Error('Baseline count failed');
        return 100;
    } });
    const result = await f.counter(request());
    assert.equal(result.tokens, 100);
    assert.equal(result.source, 'tokenizer');
    assert.equal(result.breakdown, null);
    assert.match(result.breakdownNote, /Baseline count failed/);
    assert.match(processedPromptMarkup(result), /System and conversation token counts unavailable/);
});

test('unstructured prompts and media do not claim to have a role breakdown', async () => {
    for (const messages of ['Plain text prompt', [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }]]) {
        const f = counterFixture();
        const result = await f.counter({ ...request(), custom_prompt_post_processing: '', messages });
        assert.equal(result.breakdown, null);
        if (typeof messages === 'string') assert.equal(result.tokens, 7);
        else assert.equal(result.tokens, null);
        assert.match(processedPromptMarkup(result), /System and conversation token counts unavailable/);
    }
});

test('custom YAML uses the supplied ST parser and invalid YAML follows the backend ignore rule', async () => {
    const f = counterFixture();
    const counter = createRequestTokenCounter({ fetcher: f.fetcher, parseYaml: text => {
        if (text === 'invalid') throw new Error('Invalid YAML');
        assert.equal(text, 'messages: override');
        return { messages: [{ role: 'user', content: 'Parsed YAML content' }] };
    } });
    const overridden = await counter({ ...request(), custom_include_body: 'messages: override' });
    assert.deepEqual(overridden.messages, [{ role: 'user', content: 'Parsed YAML content' }]);
    const ignored = await counter({ ...request(), custom_include_body: 'invalid' });
    assert.deepEqual(ignored.messages, processed);
    assert.equal(ignored.tokens, 60001);
});

test('hardcoded custom models suppress ineffective suggestions and usage records their actual route', async () => {
    for (const model of ['gpt-4o', 'claude-sonnet-4.5:cheap']) {
        const f = counterFixture(), sent = [], notices = [];
        const input = { ...request(), custom_include_body: JSON.stringify({ model }) };
        const settings = { ...DEFAULTS, plan: 'Basic', recommendEnabled: true, recommendMode: 'suggest' };
        const target = { location: { href: 'http://localhost' }, fetch: async (_url, options) => {
            sent.push(JSON.parse(options.body)); return json({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
        } };
        const pricing = { plans: [{ name: 'Basic', cap: 100, max: 128000, claudeMax: 128000 }],
            models: [{ id: 'gpt-4o', cost: 2, plan: 'Basic', tokens: [] }, { id: 'gpt-4o:cheap', cost: 1, plan: 'Basic', tokens: ['cheap'] }] };
        let record;
        const done = new Promise(resolve => { record = resolve; });
        installRequestTracker({ target, snapshot: data => ({ model: f.counter.getModel(data), inputTokens: f.counter(data) }), record });
        installRequestRecommender({ target, getSettings: () => settings, refresh: async () => {},
            getData: () => ({ pricing: { data: pricing }, status: { data: { models: [] } } }), getInputTokens: f.counter,
            choose: () => assert.fail('A model override makes changing the top-level field ineffective'),
            notify: message => notices.push(message), apply: () => {} });
        await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(input) });
        assert.equal((await done).model, model);
        assert.deepEqual(sent[0], input);
        assert.match(notices[0], /custom request body overrides/);
    }
});

test('cancelling a held suggestion prevents generation and does not rebuild or mutate its captured messages', async () => {
    const f = counterFixture();
    let generated = 0, open;
    const opened = new Promise(resolve => { open = resolve; });
    const target = { location: { href: 'http://localhost' }, fetch: async () => { generated++; return json({}); } };
    const settings = { ...DEFAULTS, plan: 'Basic', recommendEnabled: true, recommendMode: 'suggest' };
    const pricing = { plans: [{ name: 'Basic', cap: 100, max: 128000, claudeMax: 128000 }],
        models: [{ id: 'gpt-4o', cost: 2, plan: 'Basic', tokens: [] }, { id: 'gpt-4o:cheap', cost: 1, plan: 'Basic', tokens: ['cheap'] }] };
    installRequestRecommender({ target, getSettings: () => settings, refresh: async () => {},
        getData: () => ({ pricing: { data: pricing }, status: { data: { models: [] } } }), getInputTokens: f.counter,
        choose: () => { open(); return new Promise(() => {}); }, notify: () => {}, apply: () => assert.fail('Cancelled') });
    const abort = new AbortController();
    const pending = target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(request()), signal: abort.signal });
    await opened;
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    abort.abort(); await rejected;
    assert.equal(generated, 0);
    assert.equal(f.calls.length, 5);
});

for (const stream of [false, true]) {
    test(`missing API usage falls back to the processed count (stream=${stream})`, async () => {
        const f = counterFixture({ count: 5001 });
        const payload = stream ? 'data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: [DONE]\n\n'
            : JSON.stringify({ choices: [{ message: { content: 'Reply' } }] });
        const target = { location: { href: 'http://localhost' }, fetch: async () => new Response(payload) };
        let record;
        const done = new Promise(resolve => { record = resolve; });
        installRequestTracker({ target, snapshot: data => ({ inputTokens: f.counter(data) }), record });
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ ...request(), stream }) });
        assert.equal(await response.text(), payload);
        const entry = await done;
        assert.equal(entry.inputTokens, 5001);
        assert.equal(entry.tokenSource, 'tokenizer');
        assert.equal(f.calls.length, 5);
    });
}
