// Standalone SillyTavern server plugin. No npm dependencies or frontend imports.
export const info = {
    id: 'literouter-data',
    name: 'LiteRouter live data',
    description: 'Buffered public LiteRouter pricing and status feeds for the LiteRouter extension.',
};

const SOURCES = {
    pricing: 'https://docs.literouter.com/pricing-data',
    status: 'https://status.literouter.com/api.php',
};

// Exported factory lets tests exercise the production handlers without contacting LiteRouter.
export function createHandlers({ fetcher = globalThis.fetch.bind(globalThis), now = Date.now, cacheMs = 30000 } = {}) {
    const cache = new Map();
    const inflight = new Map();
    async function read(kind) {
        const saved = cache.get(kind);
        if (saved && now() - saved.at < cacheMs) return saved.data;
        if (inflight.has(kind)) return inflight.get(kind);
        const pending = (async () => {
            const upstream = await fetcher(SOURCES[kind], {
                method: 'GET', headers: { accept: 'application/json' },
                credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
            });
            if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);
            const data = await upstream.json();
            if (!data || !Array.isArray(data.models) || (kind === 'pricing' && !Array.isArray(data.plans))) {
                throw new Error('Unexpected upstream JSON schema');
            }
            cache.set(kind, { data, at: now() });
            return data;
        })();
        inflight.set(kind, pending);
        try { return await pending; } finally { inflight.delete(kind); }
    }
    return Object.fromEntries(Object.keys(SOURCES).map(kind => [kind, async (_request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        try {
            // Buffer JSON rather than using SillyTavern's chat-stream forwarding utility.
            response.json(await read(kind));
        } catch (error) {
            const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
            response.status(timeout ? 504 : 502).json({ error: `LiteRouter ${kind} feed unavailable`,
                detail: timeout ? 'Upstream request timed out' : 'The public feed could not be fetched or validated' });
        }
    }]));
}

export async function init(router) {
    const handlers = createHandlers();
    router.get('/pricing', handlers.pricing);
    router.get('/status', handlers.status);
}
