import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionPreview } from '../connection-preview.js';
import { createRequestTokenCounter } from '../request-tokens.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixture(countRequest = async request => ({ tokens: request.messages[0].content.length, model: request.model })) {
    const context = {
        mainApi: 'openai', characterId: 1, chatId: 'chat-a', name1: 'User', name2: 'Megumin',
        chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://api.literouter.com/v1',
            custom_model: 'gpt-4o', custom_prompt_post_processing: 'strict', custom_include_body: '', custom_exclude_body: '' },
        substituteParams: () => assert.fail('The observer must not evaluate any macros'),
        generate: () => assert.fail('The observer must not request a prompt build'),
    };
    const calls = [], updates = [];
    let enabled = true;
    const preview = createConnectionPreview({ getContext: () => context, isEnabled: () => enabled,
        countRequest: request => { calls.push(request); return countRequest(request); },
        onChange: () => updates.push(preview.read(10)) });
    return { context, calls, updates, preview, disable: () => { enabled = false; } };
}

test('counts a dry-run prompt after asynchronous Megumin replacements and server processing', async () => {
    const network = [];
    const counter = createRequestTokenCounter({ fetcher: async (url, options) => {
        const body = JSON.parse(options.body);
        network.push({ url, body });
        let result;
        if (url.endsWith('/process')) {
            result = { messages: [{ role: 'system', content: body.messages.map(message => message.content).join('\n\n') }] };
        } else if (url.includes('/count?')) {
            result = { token_count: 3 + body.reduce((sum, message) => sum + message.content.length + 4, 0) };
        } else assert.fail(`Preview must not send a completion: ${url}`);
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    } });
    const f = fixture(counter), data = { prompt: [
        { role: 'system', content: '[[main]]' }, { role: 'system', content: '[[long-Memory]]' },
    ] };
    const engine = 'Configured engine instructions. '.repeat(40), memory = 'Retrieved memory. '.repeat(12);
    // ST awaits CHAT_COMPLETION_PROMPT_READY before emitting GENERATE_AFTER_DATA.
    await (async () => { await Promise.resolve(); data.prompt[0].content = engine; data.prompt[1].content = memory; })();
    const saved = structuredClone(data);
    assert.deepEqual(f.preview.read(10), { tokens: 10, source: 'native' });
    f.preview.capture(data, true);
    assert.equal(f.preview.read(10).source, 'counting');
    await settle();
    assert.equal(f.preview.read(10).tokens, engine.length + memory.length + 2 + 4 + 3);
    assert.equal(f.preview.read(10).source, 'assembled');
    assert.deepEqual(network[0].body.messages, saved.prompt);
    assert.deepEqual(data, saved);
    assert.equal(f.calls.length, 1, 'Counting must not rerun prompt assembly');
    assert.ok(network.every(call => !call.url.includes('/generate')));
});

test('works without Megumin and preserves the native fallback until a dry run is available', async () => {
    const f = fixture();
    assert.equal(f.context.extensionSettings, undefined);
    assert.deepEqual(f.preview.read(37), { tokens: 37, source: 'native' });
    f.preview.capture({ prompt: [{ role: 'system', content: 'Plain preset rules.' }] }, true);
    await settle();
    assert.equal(f.preview.read(37).tokens, 'Plain preset rules.'.length);
});

test('real and quiet/background requests cannot overwrite the connection preview', async () => {
    const f = fixture();
    f.preview.capture({ prompt: [{ role: 'system', content: 'Roleplay rules' }] }, true);
    await settle();
    const saved = f.preview.read(10);
    for (const dryRun of [false, undefined]) {
        f.preview.capture({ prompt: [{ role: 'user', content: 'Summarize memory instead' }] }, dryRun);
    }
    f.preview.capture({ prompt: null }, true);
    assert.deepEqual(f.preview.read(10), saved);
    assert.equal(f.calls.length, 1);
});

test('a slower earlier count cannot replace a newer assembled preview', async () => {
    const first = deferred(), second = deferred();
    const f = fixture(request => request.messages[0].content === 'first' ? first.promise : second.promise);
    f.preview.capture({ prompt: [{ role: 'system', content: 'first' }] }, true);
    f.preview.capture({ prompt: [{ role: 'system', content: 'second' }] }, true);
    second.resolve({ tokens: 200 });
    await settle();
    first.resolve({ tokens: 100 });
    await settle();
    assert.equal(f.preview.read(10).tokens, 200);
});

test('switching chat, model, endpoint or processing settings discards stale async results', async () => {
    const changes = [context => { context.chatId = 'chat-b'; },
        context => { context.chatCompletionSettings.custom_model = 'claude-sonnet-4.5'; },
        context => { context.chatCompletionSettings.custom_url = 'https://other.literouter.com/v1'; },
        context => { context.chatCompletionSettings.custom_include_body = '{"messages": []}'; }];
    for (const change of changes) {
        const pending = deferred(), f = fixture(() => pending.promise);
        f.preview.capture({ prompt: [{ role: 'system', content: 'Old chat' }] }, true);
        change(f.context);
        pending.resolve({ tokens: 999 });
        await settle();
        assert.deepEqual(f.preview.read(23), { tokens: 23, source: 'native' });
    }
});

test('invalidating edited settings or chat content discards pending counts', async () => {
    const pending = deferred(), f = fixture(() => pending.promise);
    f.preview.capture({ prompt: [{ role: 'system', content: 'Before edit' }] }, true);
    f.preview.invalidate();
    pending.resolve({ tokens: 999 });
    await settle();
    assert.deepEqual(f.preview.read(20), { tokens: 20, source: 'native' });
});

test('disabled tracking and non-LiteRouter connections skip counting', async () => {
    for (const change of [f => f.disable(), f => { f.context.mainApi = 'textgenerationwebui'; },
        f => { f.context.chatCompletionSettings.custom_url = 'https://other.example/v1'; }]) {
        const f = fixture();
        change(f);
        f.preview.capture({ prompt: [{ role: 'system', content: 'Rules' }] }, true);
        await settle();
        assert.equal(f.calls.length, 0);
        assert.equal(f.preview.read(10).source, 'native');
    }
});

test('unavailable or failed tokenization does not silently show the unexpanded native total', async () => {
    for (const count of [() => ({ tokens: null, note: 'Media requires API counts.' }),
        () => { throw new Error('Tokenizer offline'); }]) {
        const f = fixture(count);
        f.preview.capture({ prompt: [{ role: 'system', content: 'Expanded rules' }] }, true);
        await settle();
        assert.equal(f.preview.read(10).tokens, null);
        assert.equal(f.preview.read(10).source, 'assembled');
        assert.ok(f.preview.read(10).note);
    }
});

test('captures settings, group names and static body overrides without touching messages', async () => {
    const f = fixture();
    f.context.groupId = 'group-a';
    f.context.groups = [{ id: 'group-a', members: ['megumin.png', 'kazuma.png'] }];
    f.context.characters = [{ avatar: 'megumin.png', name: 'Megumin' }, { avatar: 'kazuma.png', name: 'Kazuma' }];
    f.context.chatCompletionSettings.custom_include_body = '{"model":"gpt-4o:cheap","user":"Megumin"}';
    const data = { prompt: [{ role: 'system', content: 'Already chosen macro value' }] };
    f.preview.capture(data, true);
    data.prompt[0].content = 'Changed after capture';
    await settle();
    assert.deepEqual(f.calls[0].group_names, ['Megumin', 'Kazuma']);
    assert.equal(f.calls[0].custom_include_body, '{"model":"gpt-4o:cheap","user":"Megumin"}');
    assert.equal(f.calls[0].custom_prompt_post_processing, 'strict');
    assert.equal(f.calls[0].messages[0].content, 'Already chosen macro value');
});

test('preserves Megumin dice and random results exactly, including any unexpanded literal macros', async () => {
    const f = fixture();
    const content = 'Megumin dice: 6. Chosen random mode: gentle. Literal {{random::a::b}} and {{roll:1d20}}.';
    const data = { prompt: [{ role: 'system', content }] };
    f.preview.capture(data, true);
    await settle();
    assert.equal(f.calls[0].messages[0].content, content);
    assert.equal(data.prompt[0].content, content);
    assert.equal(f.preview.read(10).tokens, content.length);
});

test('defers custom body macros until ST resolves them, then reuses the actual request count', async () => {
    const f = fixture();
    f.context.chatCompletionSettings.custom_include_body = '{"messages":[{"role":"system","content":"{{roll:1d20}}"}]}';
    const messages = [{ role: 'system', content: 'Megumin rolled 6; selected random style: gentle.' }];
    f.preview.capture({ prompt: messages }, true);
    await settle();
    assert.equal(f.calls.length, 0, 'Do not price an override before ST has resolved its macros');
    assert.equal(f.preview.read(10).tokens, null);
    assert.match(f.preview.read(10).note, /once SillyTavern builds/);

    const request = { model: 'gpt-4o', custom_url: f.context.chatCompletionSettings.custom_url,
        type: 'normal', messages, custom_include_body: '{"messages":[{"role":"system","content":"6"}]}' };
    const saved = structuredClone(request);
    f.preview.captureRequest(request, Promise.resolve({ tokens: 44, model: 'gpt-4o', messages: [{ role: 'system', content: '6' }] }));
    await settle();
    assert.equal(f.calls.length, 0, 'Reuse the actual request count without another count or macro evaluation');
    assert.equal(f.preview.read(10).tokens, 44);
    assert.equal(f.preview.read(10).source, 'request');
    assert.deepEqual(request, saved);
});

test('observed utility requests and requests for another connection cannot replace the preview', async () => {
    const f = fixture();
    f.preview.capture({ prompt: [{ role: 'system', content: 'Dice: 6' }] }, true);
    await settle();
    const saved = f.preview.read(10);
    const request = { type: 'normal', model: 'gpt-4o', custom_url: f.context.chatCompletionSettings.custom_url,
        messages: [{ role: 'user', content: 'Background request' }] };
    for (const change of [{ type: 'quiet' }, { model: 'other-model' }, { custom_url: 'https://other.example/v1' }]) {
        f.preview.captureRequest({ ...request, ...change }, Promise.resolve({ tokens: 999 }));
    }
    await settle();
    assert.deepEqual(f.preview.read(10), saved);
});
