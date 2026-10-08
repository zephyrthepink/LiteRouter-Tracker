import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../core.js';
import { installRequestRecommender, requestReview, recommendModels } from '../recommendations.js';
import { showRequestConfirmation, showPriceIncrease, showRecommendations } from '../recommendation-ui.js';

const input = { model: 'gpt-4o', type: 'normal', chat_completion_source: 'custom', custom_url: 'https://api.literouter.com/v1',
    messages: [{ role: 'system', content: 'Chosen random variant. Included lorebook content.' }, { role: 'user', content: 'Hello' }] };
const counted = { tokens: 50001, source: 'tokenizer', model: input.model, messages: structuredClone(input.messages) };

function fixture({ confirm = true, recommendations = false, mode = 'suggest', warning = false, alternatives = true,
    stale = false, tokens = counted } = {}) {
    const settings = { ...structuredClone(DEFAULTS), confirmCostEnabled: confirm, recommendEnabled: recommendations,
        recommendMode: mode, priceWarnEnabled: warning };
    const pricing = { plans: [{ name: 'Basic', cap: 100, max: 128000, claudeMax: 128000 }], models: [
        { id: 'gpt-4o', cost: 2, plan: 'Basic', tokens: [] },
        ...(alternatives ? [{ id: 'gpt-4o:cheap', cost: 1, plan: 'Basic', tokens: ['cheap'] }] : []),
    ] };
    const calls = { sent: [], warnings: [], suggestions: [], confirmations: [], counted: 0, refresh: 0, apply: [], notice: [], acknowledged: 0 };
    const target = { location: { href: 'http://localhost' }, fetch: async (url, options) => {
        calls.sent.push({ url, options }); return new Response('reply');
    } };
    const config = { target, getSettings: () => settings, refresh: async () => { calls.refresh++; },
        getData: () => ({ pricing: { data: pricing, stale }, status: { data: { models: [] } } }),
        getInputTokens: async () => { calls.counted++; return structuredClone(tokens); },
        getPriceIncrease: () => warning ? { from: 1, to: 2 } : null,
        acknowledgePriceIncrease: () => { calls.acknowledged++; },
        warnPriceIncrease: async (_change, _signal, _data, onShown, review) => { calls.warnings.push(review); onShown(); return true; },
        choose: async (recommendation, _signal, _data, _change, onShown, review) => {
            calls.suggestions.push({ recommendation, review }); onShown(); return recommendation.choices[0].model.id;
        },
        confirmRequest: async review => { calls.confirmations.push(review); return true; },
        apply: model => calls.apply.push(model), notify: message => calls.notice.push(message),
    };
    const send = (data = input, options = {}) => target.fetch('/api/backends/chat-completions/generate', {
        method: 'POST', headers: { 'X-Test': 'yes' }, credentials: 'same-origin', ...options, body: JSON.stringify(data),
    });
    return { config, calls, settings, pricing, target, send };
}

test('cost confirmation is optional and disabled by default', async () => {
    assert.equal(DEFAULTS.confirmCostEnabled, false);
    const f = fixture({ confirm: false }); installRequestRecommender(f.config); await f.send();
    assert.equal(f.calls.refresh, 0);
    assert.equal(f.calls.counted, 0);
    assert.equal(f.calls.confirmations.length, 0);
    assert.equal(f.calls.sent.length, 1);
});

for (const scenario of [
    { name: 'standalone', confirmations: 1, warnings: 0, suggestions: 0, sentModel: 'gpt-4o' },
    { name: 'suggestion', recommendations: true, confirmations: 0, warnings: 0, suggestions: 1, sentModel: 'gpt-4o:cheap' },
    { name: 'warning', warning: true, confirmations: 0, warnings: 1, suggestions: 0, sentModel: 'gpt-4o' },
    { name: 'suggestion plus warning', recommendations: true, warning: true, confirmations: 0, warnings: 0, suggestions: 1, sentModel: 'gpt-4o:cheap' },
    { name: 'no cheaper option plus warning', recommendations: true, warning: true, alternatives: false, confirmations: 0, warnings: 1, suggestions: 0, sentModel: 'gpt-4o' },
    { name: 'no cheaper option', recommendations: true, alternatives: false, confirmations: 1, warnings: 0, suggestions: 0, sentModel: 'gpt-4o' },
    { name: 'automatic', recommendations: true, mode: 'automatic', confirmations: 1, warnings: 0, suggestions: 0, sentModel: 'gpt-4o:cheap' },
    { name: 'automatic plus warning', recommendations: true, mode: 'automatic', warning: true, confirmations: 0, warnings: 1, suggestions: 0, sentModel: 'gpt-4o:cheap' },
]) {
    test(`one cost decision per request: ${scenario.name}`, async () => {
        const f = fixture(scenario); installRequestRecommender(f.config); await f.send();
        assert.equal(f.calls.confirmations.length, scenario.confirmations);
        assert.equal(f.calls.warnings.length, scenario.warnings);
        assert.equal(f.calls.suggestions.length, scenario.suggestions);
        assert.equal(f.calls.counted, 1);
        assert.equal(f.calls.sent.length, 1);
        assert.deepEqual(JSON.parse(f.calls.sent[0].options.body), { ...input, model: scenario.sentModel });
        const review = f.calls.confirmations[0] ?? f.calls.warnings[0] ?? f.calls.suggestions[0].review;
        assert.equal(review.inputTokens, 50001);
        assert.deepEqual(review.prompt.messages, input.messages);
        assert.equal(review.promptProcessed, true);
        if (!scenario.suggestions) {
            assert.equal(review.model, scenario.sentModel);
            assert.equal(review.estimate.cost, scenario.sentModel.endsWith(':cheap') ? 9 : 18);
        }
    });
}

test('standalone approval holds the captured request, preserves transport options and prevents a macro reroll', async () => {
    const f = fixture(); let opened, release;
    const ready = new Promise(resolve => { opened = resolve; });
    f.config.confirmRequest = async review => { f.calls.confirmations.push(review); opened(); return await new Promise(resolve => { release = resolve; }); };
    installRequestRecommender(f.config);
    const abort = new AbortController(), data = structuredClone(input), saved = structuredClone(data);
    const pending = f.send(data, { signal: abort.signal }); await ready;
    assert.equal(f.calls.sent.length, 0);
    data.messages[0].content = 'Changed while approval is open';
    release(true); await pending;
    assert.deepEqual(JSON.parse(f.calls.sent[0].options.body), saved);
    assert.equal(f.calls.sent[0].options.signal, abort.signal);
    assert.deepEqual(f.calls.sent[0].options.headers, { 'X-Test': 'yes' });
    assert.equal(f.calls.sent[0].options.credentials, 'same-origin');
});

test('cancel, abort, failed popup and missing confirmation handler all prevent transport and automatic application', async () => {
    for (const result of ['cancel', 'abort', 'failed', 'missing']) {
        const f = fixture({ recommendations: true, mode: 'automatic' }); f.settings.applyRecommended = true;
        const abort = new AbortController();
        f.config.confirmRequest = async () => {
            if (result === 'abort') abort.abort();
            if (result === 'failed') throw new Error('Popup failed');
            return false;
        };
        if (result === 'missing') delete f.config.confirmRequest;
        installRequestRecommender(f.config);
        await assert.rejects(f.send(input, { signal: abort.signal }));
        assert.equal(f.calls.sent.length, 0, result);
        assert.equal(f.calls.apply.length, 0, result);
    }
});

test('unknown counts and pricing still require an explicit decision, with an assembled prompt fallback', async () => {
    const f = fixture({ tokens: { tokens: null, source: 'unknown', messages: null, note: 'Tokenizer unavailable' } });
    f.config.getData = () => ({});
    f.config.confirmRequest = async review => {
        assert.equal(review.estimate, null);
        assert.equal(review.inputTokens, null);
        assert.equal(review.promptProcessed, false);
        assert.deepEqual(review.prompt.messages, input.messages);
        assert.match(review.prompt.note, /Tokenizer unavailable.*assembled prompt/);
        return false;
    };
    installRequestRecommender(f.config); await assert.rejects(f.send(), { name: 'AbortError' });
    assert.equal(f.calls.sent.length, 0);
});

test('cached pricing is labelled and suppresses suggestions, while confirmation remains active', async () => {
    const f = fixture({ recommendations: true, stale: true }); installRequestRecommender(f.config); await f.send();
    assert.equal(f.calls.suggestions.length, 0);
    assert.equal(f.calls.confirmations.length, 1);
    assert.equal(f.calls.confirmations[0].stale, true);
    assert.equal(f.calls.confirmations[0].estimate.cost, 18);
});

test('keeping the original in suggestions does not add a second confirmation', async () => {
    const f = fixture({ recommendations: true });
    f.config.choose = async (_recommendation, _signal, _data, _change, _shown, review) => {
        assert.equal(review.estimate.cost, 18); return null;
    };
    installRequestRecommender(f.config); await f.send();
    assert.equal(JSON.parse(f.calls.sent[0].options.body).model, input.model);
    assert.equal(f.calls.confirmations.length, 0);
});

test('an approved suggested route stays fixed if recommendation settings change during its dialog', async () => {
    const f = fixture({ recommendations: true });
    f.config.choose = async recommendation => { f.settings.recommendEnabled = false; return recommendation.choices[0].model.id; };
    installRequestRecommender(f.config); await f.send();
    assert.equal(JSON.parse(f.calls.sent[0].options.body).model, 'gpt-4o:cheap');
});

test('an invalid confirmed choice cannot silently send the original higher-cost request', async () => {
    const f = fixture({ recommendations: true }); f.config.choose = async () => 'unrecognized-model';
    installRequestRecommender(f.config); await assert.rejects(f.send(), { name: 'AbortError' });
    assert.equal(f.calls.sent.length, 0);
});

test('non-LiteRouter requests bypass cost confirmation', async () => {
    const f = fixture(); installRequestRecommender(f.config); await f.send({ ...input, custom_url: 'https://other.example/v1' });
    assert.equal(f.calls.confirmations.length, 0);
    assert.equal(f.calls.counted, 0);
});

function nativeFixture(result = 1) {
    const original = globalThis.document, popups = [];
    const elements = [];
    globalThis.document = { createElement: () => {
        const events = new Map(), cost = {}, selected = { value: 'gpt-4o:cheap' };
        const element = { innerHTML: '', events, cost, selected,
            addEventListener: (type, callback) => events.set(type, callback),
            querySelector: selector => selector === '.lr-request-cost' ? cost : selected };
        elements.push(element); return element;
    } };
    const context = { POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1, CUSTOM1: 1001 }, stopped: 0,
        stopGeneration: () => { context.stopped++; }, Popup: class {
            constructor(content, _type, _text, options) {
                this.content = content; this.options = options; this.value = result;
                this.dlg = { classList: { add() {} } }; this.cancelButton = { classList: { add() {} } };
                this.closeButton = { addEventListener: (_name, callback) => { this.close = callback; } };
                popups.push(this);
            }
            async complete(value) { this.value = value; }
            async show() {
                this.options.onOpen?.();
                if (typeof result === 'function') await result(this);
                this.options.onClose?.(); return this.value;
            }
        } };
    return { context, popups, elements, restore: () => { if (original === undefined) delete globalThis.document; else globalThis.document = original; } };
}

function reviews({ secondChoice = false } = {}) {
    const f = fixture({ recommendations: true });
    if (secondChoice) f.pricing.models.push({ id: 'gpt-4o:metered', cost: 1, plan: 'Basic', tokens: ['metered'] });
    const review = requestReview({ request: input, counted, pricing: f.pricing, settings: f.settings });
    const recommendation = recommendModels({ modelId: input.model, inputTokens: counted.tokens, pricing: f.pricing,
        status: { models: [] }, settings: f.settings });
    recommendation.prompt = counted;
    return { review, recommendation };
}

test('native standalone confirmation displays estimated credits and a collapsed read-only escaped textarea', async () => {
    const f = nativeFixture();
    try {
        const { review } = reviews();
        review.prompt = { ...counted, messages: [{ role: 'user', content: '</textarea><script>unsafe</script>' }] };
        assert.equal(await showRequestConfirmation(f.context, review, null, 'normal'), true);
        assert.equal(f.popups.length, 1);
        const markup = f.popups[0].content.innerHTML;
        assert.match(markup, /≈ 18 premium credits/);
        assert.match(markup, /<details class="lr-prompt-preview">/);
        assert.doesNotMatch(markup, /<details[^>]* open/);
        assert.match(markup, /<textarea[^>]*readonly/);
        assert.doesNotMatch(markup, /<script>/);
        assert.match(markup, /&lt;\/textarea&gt;/);
        assert.equal(f.popups[0].options.okButton, 'Proceed');
        assert.equal(f.popups[0].options.cancelButton, 'Cancel request');
        assert.equal(f.popups[0].options.defaultResult, 0);
    } finally { f.restore(); }
});

test('native warning merges the request cost and prompt into its existing popup', async () => {
    const f = nativeFixture();
    try {
        const { review } = reviews(); let shown = 0;
        await showPriceIncrease(f.context, input.model, { from: 1, to: 2 }, null, 'normal', () => { shown++; }, review);
        assert.equal(f.popups.length, 1);
        assert.match(f.popups[0].content.innerHTML, /Model price increased/);
        assert.match(f.popups[0].content.innerHTML, /≈ 18 premium credits/);
        assert.match(f.popups[0].content.innerHTML, /textarea[^>]*readonly/);
        assert.equal(shown, 1);
    } finally { f.restore(); }
});

test('native suggestions merge confirmation and update the displayed spend with the selected radio choice', async () => {
    const f = nativeFixture(async popup => {
        const content = popup.content, radioName = /name="([^"]+)"/.exec(content.innerHTML)[1];
        content.selected.value = 'gpt-4o:metered';
        content.events.get('change')({ target: { name: radioName, value: 'gpt-4o:metered' } });
        assert.match(content.cost.outerHTML, /≈ 11 premium credits/);
        assert.match(content.cost.outerHTML, /gpt-4o:metered/);
        popup.value = 1;
    });
    try {
        const { review, recommendation } = reviews({ secondChoice: true });
        assert.equal(await showRecommendations(f.context, recommendation, null, 'normal', null, null, review), 'gpt-4o:metered');
        assert.equal(f.popups.length, 1);
        assert.match(f.popups[0].content.innerHTML, /≈ 9 premium credits/);
        assert.match(f.popups[0].content.innerHTML, /textarea[^>]*readonly/);
        assert.equal(f.popups[0].options.defaultResult, 1001);
        assert.equal(f.popups[0].options.okButton, 'Proceed with selected model');
    } finally { f.restore(); }
});

test('dismissal cancels standalone confirmation and suggested confirmation; quiet cancellation does not stop foreground generation', async () => {
    for (const suggestions of [false, true]) {
        for (const type of ['normal', 'quiet']) {
            const f = nativeFixture(-1);
            try {
                const { review, recommendation } = reviews();
                const pending = suggestions ? showRecommendations(f.context, recommendation, null, type, null, null, review)
                    : showRequestConfirmation(f.context, review, null, type);
                await assert.rejects(pending, { name: 'AbortError' });
                assert.equal(f.context.stopped, type === 'normal' ? 1 : 0);
            } finally { f.restore(); }
        }
    }
});

test('a native suggestion close icon cancels the request rather than proceeding with the original', async () => {
    const f = nativeFixture(async popup => { popup.close({ stopImmediatePropagation() {} }); });
    try {
        const { review, recommendation } = reviews();
        await assert.rejects(showRecommendations(f.context, recommendation, null, 'normal', null, null, review), { name: 'AbortError' });
    } finally { f.restore(); }
});

test('missing native popup support cannot silently bypass enabled cost confirmation', async () => {
    const { review, recommendation } = reviews();
    const context = { stopGeneration() {} };
    await assert.rejects(showRequestConfirmation(context, review, null, 'normal'), { name: 'AbortError' });
    await assert.rejects(showRecommendations(context, recommendation, null, 'normal', null, null, review), { name: 'AbortError' });
});
