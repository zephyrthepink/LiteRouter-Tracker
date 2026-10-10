# LiteRouter Tracker

A SillyTavern extension for LiteRouter connections using **Chat Completion → Custom (OpenAI-compatible)**.

## Features

- **Better model search:** browse live models in Connection Profiles, filter with booru tags, and sort by price, status, speed, or requests per day. Models refresh automatically when you open API Connections or expand the LiteRouter model browser.
- **More accurate pricing:** suggestions and request confirmations count the processed prompt, including triggered lorebooks and resolved macros. Connection Profiles show a **Total Tokens** preview.
- **Simulated comparisons:** compare up to five models using a chat size you choose.
- **Model recommendations:** suggest cheaper variants of the same base model or switch automatically, retaining the built prompt. Outaged models are excluded.
- **Optional cost confirmation:** review estimated credits and inspect the prompt before sending. Merges with suggestions and price warnings; disabled by default.
- **Price-increase warnings:** warn once before sending when your selected model's price multiplier rises between pricing refreshes. Suggest mode shows the increase in red inside available recommendations. Otherwise, a separate dialog lets you cancel (the default) or continue, including in Automatic mode. Warnings are enabled by default and can be disabled under **Live data settings**.
- **Credit tracking:** see requests made, estimated credits spent and remaining, time until reset, and usage history with filters and charts.
- **Claude/Gemini Pro output tracking:** track their shared daily output limit, calculated as your daily premium credits × 20. Gemini Flash models are excluded; their requests and credit usage are still tracked.
- **Request inspection:** expand **Last request** to view the processed prompt, system and conversation (user + assistant) token estimates, and API-reported input/output counts when available. Pre-send prompt previews include the same breakdown.

Set your plan and Chat Optimization values in the extension settings to match your LiteRouter dashboard. Tracking covers requests made through SillyTavern while the extension is active; estimates do not sync with your account balance or other apps.

Flat-cost models and non-metered context variants charge the listed price once per request. Named context variants (`:32k-context`, `:64k-context`, `:128k-context`, and `:256k-context`) use their own approximate input budget, capped by the model's native window; metered variants charge per 5,000 input tokens. Requests/day rounds down to count only requests fully covered by the daily allowance. Search by `type:32k-context`, or use `context:32k-context` to include every billing type with that budget. All four named budgets are available in tag browsing and suggestions.

## Prompt and token counts

Counts use SillyTavern's tokenizers on the captured request after prompt post-processing and custom body overrides. Lorebooks and macros are already resolved; counting does not rebuild the prompt. Prompt previews stay in memory.

The breakdown groups messages by their outgoing role: **System** counts only `system`; **Conversation** counts `user` and `assistant`. Other roles (such as `tool` or `developer`) and tool definitions/response schemas appear separately when present. Role estimates include message fields and per-message formatting. Shared request padding and tokenization boundary differences appear as a formatting adjustment, so the breakdown adds up to the tokenizer estimate without duplicating request overhead. API totals do not provide this role split. Unstructured text prompts and media show unavailable role counts.

Source reference: SillyTavern builds a role-based `messages` request in [`public/scripts/openai.js`](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js). Its [chat completion backend](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js) applies prompt processing and dispatches provider conversions from [`src/prompt-converters.js`](https://github.com/SillyTavern/SillyTavern/blob/release/src/prompt-converters.js). LiteRouter's Custom route sends OpenAI-compatible messages; SillyTavern does not perform a native Claude/Gemini conversion on that route. Counting follows [`src/endpoints/tokenizers.js`](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/tokenizers.js), including its request-level padding.

Pre-send counts are **estimates**. API-reported `prompt_tokens` and `completion_tokens` take precedence for tracking. Tool/schema formatting and tokenizer differences can affect estimates; local media counts are unavailable. Missing Claude/Gemini Pro output counts are estimated from reply text.

Connection Profiles show a **Preview** based on SillyTavern's displayed total. Optional cost confirmation holds the built request for review; cancelling prevents it from being sent. Unavailable estimates and cached pricing are labelled.

## Installation

1. Open SillyTavern's **Extensions** menu.
2. Click **Install extension**.
3. Paste this repository's URL and install.

## Fixing errors

### Models do not load

In SillyTavern's `config.yaml`, set:

```yaml
enableCorsProxy: true
```

Restart SillyTavern. In the extension's **Live data settings**, choose **Automatic** and click **Refresh live data**. This works without server plugins.

### False “Streaming request finished” logs

SillyTavern's built-in proxy may print this message while fetching model and status data. It does not mean a chat request was sent or credits were spent.

The optional server plugin removes these misleading logs:

1. Copy this repository's `server/literouter-data.mjs` into `SillyTavern/plugins/`.
2. In SillyTavern's `config.yaml`, set:

   ```yaml
   enableServerPlugins: true
   ```

3. Restart SillyTavern and reload the browser.
4. In **Live data settings**, choose **SillyTavern server helper (optional; quieter logs)** and click **Refresh live data**.

The plugin only fetches public model and status data. Installing the extension does not install this server plugin automatically.

## Where your tracking data is saved

History is saved in your SillyTavern user settings on the server. With the default setup, the file is:

```text
SillyTavern/data/default-user/settings.json
```

Other users have their own folder under `data/`. If you use a custom data directory, look there instead.

Tracking history is stored under `extension_settings.literouter.usage`. It records request totals, token counts, and credit estimates. History survives reloads and daily resets, which happen at midnight **GMT+7**. Back up your user settings file to keep a copy.

To reset all LiteRouter settings and tracking history:

1. Stop SillyTavern and close its browser tabs.
2. Open your user's `settings.json` and remove only the `literouter` entry inside `extension_settings`. Keep the JSON valid.
3. Save the file and restart SillyTavern. The extension will recreate its default settings with empty history.

Public model prices and status are also cached in your browser's local storage under `st-literouter-live-v1`. To clear that cache, open SillyTavern's browser developer console and run:

```js
localStorage.removeItem('st-literouter-live-v1');
```

Reload the page to fetch fresh data.
