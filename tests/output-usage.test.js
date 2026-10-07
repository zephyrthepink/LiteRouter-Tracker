import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../core.js';
import { emptyUsage, billingDay, isSharedOutputModel, normalizeUsage, recordUsage, totalUsage, usageRows } from '../usage.js';
import { CompletionObserver, installRequestTracker } from '../request-tracker.js';
import { UsageView } from '../usage-ui.js';

const startedAt = Date.parse('2026-10-06T12:00:00Z');
const day = billingDay(startedAt);

test('shared output includes Claude and Gemini Pro variants only', () => {
    for (const model of ['claude-sonnet-4.5', 'claude-opus-4.1-thinking:cheap', 'claude-haiku-4.5:free',
        'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-2.5-pro-vertex:metered', 'GEMINI-2.5-PRO:free']) {
        assert.equal(isSharedOutputModel(model), true, model);
    }
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-thinking:cheap', 'gemini-2.5-flash-lite:free',
        'gemini-3-flash-preview', 'gemini-2.5-flash:pro', 'gemini-2.5-flash-pro', 'gemini-2.5',
        'gemini-2.5-professional', 'deepseek-v3', 'gpt-4.1']) {
        assert.equal(isSharedOutputModel(model), false, model);
    }
});

test('Flash requests still record credits and input usage without output quota or unknown counts', () => {
    const usage = emptyUsage();
    for (const outputTokens of [900, null]) recordUsage(usage, {
        model: 'gemini-2.5-flash:cheap', startedAt, cost: 2, type: 'premium', premiumAllowance: 100,
        inputTokens: 400, tokenSource: 'api', outputTokens, outputTokenSource: 'api',
    });
    const bucket = usage.days[day]['gemini-2.5-flash:cheap'];
    assert.equal(bucket.requests, 2);
    assert.equal(bucket.premium, 4);
    assert.equal(bucket.daily, 4);
    assert.equal(bucket.inputTokens, 800);
    assert.equal(bucket.apiTokens, 2);
    assert.equal(bucket.outputTokens, 0);
    assert.equal(bucket.apiOutputRequests, 0);
    assert.equal(bucket.estimatedOutputRequests, 0);
    assert.equal(bucket.unknownOutputRequests, 0);
});

test('API, estimated, and unknown output counts remain tracked for eligible models', () => {
    const usage = emptyUsage(), model = 'gemini-2.5-pro-thinking:cheap';
    for (const [outputTokens, outputTokenSource] of [[100, 'api'], [75, 'tokenizer'], [null, 'unknown']]) {
        recordUsage(usage, { model, startedAt, outputTokens, outputTokenSource });
    }
    const bucket = usage.days[day][model];
    assert.equal(bucket.outputTokens, 175);
    assert.equal(bucket.apiOutputRequests, 1);
    assert.equal(bucket.estimatedOutputRequests, 1);
    assert.equal(bucket.unknownOutputRequests, 1);
});

test('saved Flash history is preserved while excluded from the daily shared output summary', () => {
    const raw = { version: 1, days: { [day]: {
        'gemini-2.5-flash': { requests: 3, premium: 9, daily: 9, outputTokens: 9000, estimatedOutputRequests: 1, unknownOutputRequests: 2 },
        'gemini-2.5-pro:cheap': { requests: 1, premium: 4, daily: 4, outputTokens: 100, apiOutputRequests: 1 },
        'claude-sonnet-4.5': { requests: 1, premium: 5, daily: 5, outputTokens: 200, apiOutputRequests: 1 },
    } } };
    const usage = normalizeUsage(raw);
    assert.equal(usage.days[day]['gemini-2.5-flash'].outputTokens, 9000);
    const rows = usageRows(usage);
    assert.equal(totalUsage(rows).premium, 18);
    const output = totalUsage(rows.filter(row => isSharedOutputModel(row.model)));
    assert.equal(output.outputTokens, 300);
    assert.equal(output.unknownOutputRequests, 0);
    assert.equal(output.estimatedOutputRequests, 0);
    // Exercise the actual visible summary, including its progress and warning state.
    const elements = new Map();
    const view = Object.assign(Object.create(UsageView.prototype), {
        root: { querySelector: selector => {
            if (!elements.has(selector)) elements.set(selector, {});
            return elements.get(selector);
        } },
        getSettings: () => ({ usage }), getBudget: () => 100, getPlan: () => ({ name: 'Basic' }), now: () => startedAt,
    });
    view.renderToday();
    const markup = elements.get('.lr-usage-today').innerHTML;
    assert.match(markup, /Claude\/Gemini Pro output tokens/);
    assert.match(markup, /300 \/ 2,000/);
    assert.match(markup, /data-output-state="normal"/);
    assert.match(markup, /max="2000" value="300"/);
    assert.doesNotMatch(markup, /Limit reached|\d+ estimated|\d+ unknown/);
});

test('legacy history marks only Claude and Gemini Pro output as unknown', () => {
    const usage = normalizeUsage({ version: 1, days: { [day]: {
        'gemini-2.5-flash': { requests: 3, premium: 9 },
        'gemini-2.5-pro:cheap': { requests: 2, premium: 4 },
        'claude-sonnet-4.5': { requests: 1, premium: 5 },
    } } });
    assert.equal(usage.days[day]['gemini-2.5-flash'].unknownOutputRequests, 0);
    assert.equal(usage.days[day]['gemini-2.5-pro:cheap'].unknownOutputRequests, 2);
    assert.equal(usage.days[day]['claude-sonnet-4.5'].unknownOutputRequests, 1);
});

test('reply tokenizer fallback runs for Pro and Claude but skips Flash', async () => {
    for (const model of ['gemini-2.5-pro:cheap', 'claude-sonnet-4.5-thinking', 'gemini-2.5-flash-thinking']) {
        let calls = 0, recorded;
        const observer = new CompletionObserver({
            model, startedAt, inputTokens: Promise.resolve({ tokens: 50, source: 'tokenizer' }),
            countOutputTokens: async replies => { calls++; assert.deepEqual(replies, ['Thinking\nHello']); return 12; },
        }, entry => { recorded = entry; });
        observer.accept({ choices: [{ message: { content: 'Hello', reasoning_content: 'Thinking' } }] });
        await observer.finalize(false);
        const eligible = model !== 'gemini-2.5-flash-thinking';
        assert.equal(calls, eligible ? 1 : 0, model);
        assert.equal(recorded.outputTokens, eligible ? 12 : null, model);
        assert.equal(recorded.inputTokens, 50, model);
        const usage = emptyUsage(); recordUsage(usage, recorded);
        assert.equal(usage.days[day][model].requests, 1);
        assert.equal(usage.days[day][model].unknownOutputRequests, 0);
    }
});

test('Gemini Pro upstream output totals include thinking tokens once', async () => {
    let recorded;
    const observer = new CompletionObserver({ model: 'gemini-2.5-pro', startedAt }, entry => { recorded = entry; });
    observer.accept({ usageMetadata: { candidatesTokenCount: 20, thoughtsTokenCount: 30 } });
    observer.accept({ usage: { completion_tokens: 50 }, usageMetadata: { candidatesTokenCount: 20, thoughtsTokenCount: 30 } });
    await observer.finalize(false);
    assert.equal(recorded.outputTokens, 50);
    assert.equal(recorded.outputTokenSource, 'api');
});

test('streamed Flash and Pro keep their response and credits, but only Pro spends output quota', async () => {
    for (const model of ['gemini-2.5-flash:cheap', 'gemini-2.5-pro:cheap']) {
        const usage = emptyUsage();
        const payload = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25}}\n\ndata: [DONE]\n\n';
        const target = { location: { href: 'http://localhost' }, fetch: async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }) };
        let recorded;
        const done = new Promise(resolve => { recorded = resolve; });
        const restore = installRequestTracker({ target, now: () => startedAt,
            snapshot: () => ({ pricingModel: { id: model, cost: 2, plan: 'Basic', tokens: [] },
                plan: { name: 'Basic', cap: 100, max: 128000, claudeMax: 128000 }, settings: DEFAULTS }),
            record: entry => { recordUsage(usage, entry); recorded(); },
        });
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST',
            body: JSON.stringify({ model, stream: true, chat_completion_source: 'custom', custom_url: 'https://api.literouter.com/v1' }) });
        assert.equal(await response.text(), payload);
        await done; restore();
        const bucket = usage.days[day][model];
        assert.equal(bucket.requests, 1);
        assert.equal(bucket.premium, 2);
        assert.equal(bucket.inputTokens, 100);
        assert.equal(bucket.outputTokens, model.includes('-flash') ? 0 : 25);
    }
});
