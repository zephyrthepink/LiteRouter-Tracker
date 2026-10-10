import { isLiteRouterConnection } from './core.js';

const requestFields = ['custom_prompt_post_processing', 'custom_include_body', 'custom_exclude_body'];

function identity(context) {
    const settings = context.chatCompletionSettings;
    return JSON.stringify([context.mainApi, context.characterId, context.groupId, context.chatId,
        context.name1, context.name2, settings?.custom_url, settings?.custom_model,
        ...requestFields.map(key => settings?.[key])]);
}

// Observe ST's existing dry runs after CHAT_COMPLETION_PROMPT_READY has finished.
// Megumin (and other prompt injectors) has already replaced its placeholders here.
// Never run an injector ourselves or send a completion to obtain a preview.
export function createConnectionPreview({ getContext, isEnabled, countRequest, onChange }) {
    let currentIdentity, preview = null, revision = 0;
    const available = context => isEnabled() && isLiteRouterConnection(context);

    function invalidate() {
        revision++;
        preview = null;
    }

    function read(nativeTokens) {
        const context = getContext(), nextIdentity = identity(context);
        if (nextIdentity !== currentIdentity || !available(context)) {
            invalidate();
            currentIdentity = nextIdentity;
        }
        return preview ?? { tokens: nativeTokens, source: 'native' };
    }

    function observe(request, counted, note, source = 'assembled') {
        read(null);
        const capturedIdentity = currentIdentity, capturedRevision = ++revision;
        // Snapshot only the supplied, already assembled request. Neither this
        // observer nor the token counter may expand macros or roll dice.
        const captured = structuredClone(request);
        preview = { tokens: null, source: 'counting' };
        onChange();
        void Promise.resolve().then(() => counted ?? countRequest(captured)).catch(error => ({ tokens: null, note: error.message })).then(count => {
            if (capturedRevision !== revision || capturedIdentity !== identity(getContext()) || !available(getContext())) return;
            preview = { tokens: Number.isSafeInteger(count?.tokens) && count.tokens >= 0 ? count.tokens : null,
                source, note: [note, count?.note].filter(Boolean).join(' ') || null, model: count?.model ?? captured.model };
            onChange();
        });
    }

    function capture(data, dryRun) {
        const context = getContext();
        // Only observe dry runs ST already performs; never request a new build.
        if (dryRun !== true || !available(context) || !Array.isArray(data?.prompt)) return;
        const settings = context.chatCompletionSettings;
        const members = context.groups?.find(group => group.id == context.groupId)?.members;
        const unresolvedOverrides = ['custom_include_body', 'custom_exclude_body']
            .some(key => String(settings[key] ?? '').includes('{{'));
        const request = {
            model: settings.custom_model, messages: data.prompt,
            custom_prompt_post_processing: settings.custom_prompt_post_processing,
            // ST resolves these only when building the actual request. If they
            // contain macros, wait for that request rather than evaluating them.
            custom_include_body: unresolvedOverrides ? undefined : settings.custom_include_body,
            custom_exclude_body: unresolvedOverrides ? undefined : settings.custom_exclude_body,
            char_name: context.name2, user_name: context.name1,
            group_names: context.groupId && Array.isArray(members)
                ? members.map(avatar => context.characters?.find(character => character.avatar === avatar)?.name).filter(Boolean) : [],
        };
        observe(request, unresolvedOverrides ? Promise.resolve({ tokens: null, model: request.model }) : null, unresolvedOverrides
            ? 'Custom body overrides contain macros; they are included once SillyTavern builds the actual request.' : null);
    }

    function captureRequest(request, counted) {
        const context = getContext();
        if (!available(context) || request.type === 'quiet'
            || request.custom_url !== context.chatCompletionSettings.custom_url
            || request.model !== context.chatCompletionSettings.custom_model) return;
        observe(request, counted, null, 'request');
    }

    return { capture, captureRequest, read, invalidate };
}
