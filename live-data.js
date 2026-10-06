import { ENDPOINTS, normalizePricing, normalizeStatus } from './core.js';

const CACHE_KEY = 'st-literouter-live-v1';
const NORMALIZERS = { pricing: normalizePricing, status: normalizeStatus };

export class LiveData {
    constructor({ fetcher = globalThis.fetch.bind(globalThis), storage = globalThis.localStorage, now = Date.now } = {}) {
        this.fetcher = fetcher;
        this.storage = storage;
        this.now = now;
        this.entries = {};
        this.transports = {};
        this.helperAvailable = null;
        this.inflight = null;
        try {
            const stored = JSON.parse(storage?.getItem(CACHE_KEY) ?? '{}');
            for (const kind of ['pricing', 'status']) {
                const entry = stored[kind];
                if (entry && Number.isFinite(entry.at) && now() - entry.at < 86400000) {
                    this.entries[kind] = { data: NORMALIZERS[kind](entry.data), at: entry.at, stale: true, error: 'Cached; awaiting live refresh' };
                }
            }
        } catch { /* A corrupt cache never substitutes for a live response. */ }
    }
    async request(url, settings) {
        const direct = { url, credentials: 'omit' };
        const kind = Object.keys(ENDPOINTS).find(key => ENDPOINTS[key] === url);
        if (!kind) throw new Error('Unknown LiteRouter metadata feed');
        const helper = { url: `/api/plugins/literouter-data/${kind}`, credentials: 'same-origin' };
        const proxy = { url: `/proxy/${encodeURIComponent(url)}`, credentials: 'same-origin' };
        let candidate = settings.transport === 'direct' ? direct
            : settings.transport === 'st-proxy' || (settings.transport === 'auto' && this.helperAvailable === false) ? proxy : helper;
        const fetchCandidate = target => {
            this.transports[kind] = target === helper ? 'helper' : target === proxy ? 'st-proxy' : settings.transport;
            return this.fetcher(target.url, {
                method: 'GET', credentials: target.credentials, cache: 'no-store', headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(12000),
            });
        };
        let response = await fetchCandidate(candidate);
        if (candidate === helper && response.status === 404) {
            this.helperAvailable = false;
            if (settings.transport === 'auto') {
                candidate = proxy;
                response = await fetchCandidate(candidate);
            }
        } else if (candidate === helper && response.ok) this.helperAvailable = true;
        if (!response.ok) {
            if (response.status === 404 && candidate === helper) {
                throw new Error('LiteRouter server helper missing: choose Automatic or SillyTavern CORS proxy to use live data without server plugins, or install the optional helper (see README.md)');
            }
            if (response.status === 404 && candidate === proxy) {
                throw new Error('SillyTavern CORS proxy unavailable: set enableCorsProxy: true in config.yaml and restart, or choose the optional server helper (see README.md)');
            }
            throw new Error(`HTTP ${response.status}${candidate === helper ? ' (LiteRouter server helper; check upstream connectivity)' : ''}`);
        }
        return await response.json();
    }
    async refresh(settings) {
        if (this.inflight) return this.inflight;
        this.inflight = this.refreshAll({ ...settings });
        try { await this.inflight; } finally { this.inflight = null; }
    }
    async refreshAll(settings) {
        await Promise.all(['pricing', 'status'].map(async kind => {
            try {
                const data = NORMALIZERS[kind](await this.request(ENDPOINTS[kind], settings));
                this.entries[kind] = { data, at: this.now(), stale: false, error: null };
            } catch (error) {
                this.entries[kind] = { ...this.entries[kind], stale: true, error: error.message || 'Fetch failed' };
            }
        }));
        try {
            this.storage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(
                Object.entries(this.entries).filter(([, entry]) => entry.data).map(([key, entry]) => [key, { data: entry.data, at: entry.at }]),
            )));
        } catch { /* Live data still works when browser storage is full or disabled. */ }
    }
    statusMap() { return new Map((this.entries.status?.data?.models ?? []).map(m => [m.name, m])); }
}
