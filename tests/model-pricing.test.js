import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, calculate, modelType, modelWindow, optimizationWindow, tagGroups, normalizeTag, parseQuery, matchesQuery } from '../core.js';
import { recommendModels } from '../recommendations.js';

const plan = { name: 'Ultimate', cap: 5000, max: 125000, claudeMax: 50000 };
const settings = { ...DEFAULTS, plan: plan.name, generalSystem: 1, generalConversation: 1, claudeSystem: 1, claudeConversation: 1 };
const model = (id, cost = 2, ctx = 131072) => ({ id, cost, ctx, plan: plan.name, tokens: id.split(':').slice(1) });

test('listed flatcost routes keep their price at every chat size and without a token count', () => {
    const route = model('claude-sonnet-5-flatcost:full-context', 202.7, 1000000);
    for (const tokens of [null, 0, 15000, 50000, 1000000]) {
        const estimate = calculate(route, tokens, plan, settings);
        assert.equal(estimate.cost, 202.7);
        assert.equal(estimate.optimization, 1);
        assert.equal(estimate.requests, 24);
    }
    assert.equal(calculate(model('example-flatcost'), 60000, plan, settings).cost, 2);
    assert.equal(calculate(model('example-flatcost:metered:full-context'), 15001, plan, settings).cost, 8);
});

test('named variants are flat and use decimal budgets independently of chat memory', () => {
    for (const [suffix, budget] of [['32k-context', 32000], ['64k-context', 64000], ['128k-context', 128000], ['256k-context', 256000]]) {
        const route = model(`example:${suffix}`, 5.2, 1000000);
        assert.equal(modelType(route), suffix);
        assert.equal(modelWindow(route, plan, settings), budget);
        for (const input of [null, 1, 15001, 500000]) {
            const estimate = calculate(route, input, plan, settings);
            assert.equal(estimate.cost, 5.2);
            assert.equal(estimate.optimization, 1);
            assert.equal(estimate.countedTokens, input == null ? null : Math.min(input, budget));
        }
    }
    assert.equal(calculate(model('example:256k-context', 5.2, 20000), 60000, plan, settings).countedTokens, 20000);
});

test('metered named contexts use their budget and the native limit, with billing from the first token', () => {
    const route = model('example:metered:32k-context');
    assert.equal(modelType(route), 'metered-32k-context');
    for (const [tokens, units] of [[0, 1], [5000, 1], [5001, 2], [15000, 3], [32000, 7], [100000, 7]]) {
        const estimate = calculate(route, tokens, plan, settings);
        assert.equal(estimate.optimization, units);
        assert.equal(estimate.cost, units * 2);
    }
    const capped = calculate(model('example:metered:64k-context', 2, 20000), 64000, plan, settings);
    assert.equal(capped.countedTokens, 20000);
    assert.equal(capped.cost, 8);
    assert.equal(calculate(route, null, plan, settings).cost, null);
    assert.equal(calculate(model('claude-example:metered:full-context', 2, 1000000), 100000, plan, settings).cost, 40);
});

test('free context variants keep the free allowance and override the ordinary 5000-token cap', () => {
    for (const [suffix, budget] of [['', 5000], [':32k-context', 32000], [':64k-context', 64000], [':full-context', 131072]]) {
        const estimate = calculate(model(`example:free${suffix}`), 200000, plan, settings);
        assert.equal(estimate.type, 'free');
        assert.equal(estimate.cost, 1);
        assert.equal(estimate.requests, Infinity);
        assert.equal(estimate.countedTokens, budget);
    }
    assert.equal(calculate(model('example:free:32k-context', 2, 10000), 32000, plan, settings).countedTokens, 10000);
});

test('ordinary premium and metered thresholds retain managed general and Claude windows', () => {
    const wide = { ...settings, generalSystem: 100, generalConversation: 100, claudeSystem: 100, claudeConversation: 100 };
    for (const [tokens, units] of [[0, 1], [15000, 1], [15001, 2], [20000, 2], [20001, 3]]) {
        assert.equal(calculate(model('example'), tokens, plan, wide).optimization, units);
    }
    assert.equal(calculate(model('example:metered'), 5001, plan, wide).optimization, 2);
    assert.equal(calculate(model('example'), 200000, plan, wide).countedTokens, 125000);
    assert.equal(calculate(model('claude-example'), 200000, plan, wide).countedTokens, 50000);
    assert.equal(calculate(model('example'), 60000, plan, settings).countedTokens, 5000);
    assert.equal(calculate(model('example', 2, 10000), 60000, plan, wide).countedTokens, 10000);
    assert.deepEqual(optimizationWindow(plan, { ...settings, generalSystem: 20, generalConversation: 24 }),
        { window: 115000, score: 23, cap: 125000, effective: 115000 });
});

test('requests/day counts only fully covered requests and tolerates floating-point residue', () => {
    for (const [credits, cost, requests] of [[50, 20, 2], [10, 3, 3], [9, 3, 3], [0, 3, 0], [1, 3, 0], [0.3, 0.1, 3], [10, 0, Infinity]]) {
        for (const suffix of ['', ':full-context', ':32k-context', ':metered']) {
            assert.equal(calculate(model(`example${suffix}`, cost), 1, plan, { ...settings, credits }).requests, requests);
        }
    }
});

test('context and type tags support suggestions, inclusion, exclusion, and OR within categories', () => {
    const routes = ['example', 'example:32k-context', 'example:64k-context', 'example:128k-context', 'example:256k-context',
        'example:metered:32k-context', 'example:free:32k-context', 'example:full-context'].map(id => model(id));
    const groups = tagGroups(routes, [plan]);
    const rows = routes.map(route => ({ model: route, estimate: calculate(route, 5000, plan, settings), status: { key: 'unknown' } }));
    const search = query => rows.filter(row => matchesQuery(row, parseQuery(query), plan, [plan])).map(row => row.model.id);
    for (const suffix of ['32k-context', '64k-context', '128k-context', '256k-context']) {
        assert.equal(normalizeTag(`TYPE:${suffix}`, groups), `type:${suffix}`);
        assert.equal(normalizeTag(`-context:${suffix}`, groups), `-context:${suffix}`);
        assert.deepEqual(search(`type:${suffix}`), [`example:${suffix}`]);
    }
    assert.deepEqual(search('context:32k-context'), ['example:32k-context', 'example:metered:32k-context', 'example:free:32k-context']);
    assert.deepEqual(search('type:metered-32k-context'), ['example:metered:32k-context']);
    assert.deepEqual(search('context:32k-context context:64k-context -type:free -type:metered-32k-context'), ['example:32k-context', 'example:64k-context']);
    assert.equal(search('-context:32k-context').length, 5);
});

test('recommendations compare named variants using a single listed charge', () => {
    const current = model('deepseek-v3.2', 1.7), named = model('deepseek-v3.2:32k-context', 5.2);
    const result = recommendModels({ modelId: current.id, inputTokens: 60000,
        pricing: { models: [current, named], plans: [plan] }, status: { models: [] },
        settings: { ...settings, generalSystem: 20, generalConversation: 20 } });
    assert.equal(result.original.cost, 17);
    assert.equal(result.choices.length, 1);
    assert.equal(result.choices[0].estimate.cost, 5.2);
});
