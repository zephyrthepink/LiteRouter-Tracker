# LiteRouter Tracker

A SillyTavern extension for LiteRouter connections using **Chat Completion → Custom (OpenAI-compatible)**.

## Features

- **Better model search:** browse live models in Connection Profiles, filter with booru tags, and sort by price, status, speed, or requests per day. Models refresh automatically when you open API Connections or expand the LiteRouter model browser.
- **Cost estimates:** browse credits per request and requests per day using SillyTavern's **Total Tokens** preview, selected plan, and Chat Optimization settings. Suggestions and tracked requests count the captured, processed prompt instead.
- **Simulated comparisons:** compare up to five models using a chat size you choose.
- **Model recommendations:** suggest cheaper variants of the same base model before sending, or switch automatically. Uses the processed prompt's token estimate and offers an **Inspect processed prompt** view. Choosing a model retains the built prompt, including selected lorebook entries and resolved macros. Outaged models are excluded.
- **Optional request cost confirmation:** enable **Request cost confirmation → Confirm estimated cost before sending requests** to review estimated credits and a collapsed, read-only prompt before proceeding or cancelling. Confirmation is included in price warnings and model suggestions when they appear; otherwise it opens its own dialog. Automatic recommendations are reviewed at the chosen model's estimated price. Disabled by default.
- **Price-increase warnings:** warn once before sending when your selected model's price multiplier rises between pricing refreshes. Suggest mode shows the increase in red inside available recommendations. Otherwise, a separate dialog lets you cancel (the default) or continue, including in Automatic mode. Warnings are enabled by default and can be disabled under **Live data settings**.
- **Credit tracking:** see requests made, estimated credits spent and remaining, time until reset, and usage history with filters and charts.
- **Claude/Gemini Pro output tracking:** track their shared daily output limit, calculated as your daily premium credits × 20. Gemini Flash models are excluded; their requests and credit usage are still tracked.
- **Request inspection:** expand **Last request** in the extension settings to see processed prompt content, its tokenizer estimate, and API-reported input/output counts when available. Prompt previews stay in memory and are not saved to usage history.

Set your plan and Chat Optimization values in the extension settings to match your LiteRouter dashboard. Tracking covers requests made through SillyTavern while the extension is active; estimates do not sync with your account balance or other apps.

Flat-cost models and non-metered context variants charge the listed price once per request. Named context variants (`:32k-context`, `:64k-context`, `:128k-context`, and `:256k-context`) use their own approximate input budget, capped by the model's native window; metered variants charge per 5,000 input tokens. Requests/day rounds down to count only requests fully covered by the daily allowance. Search by `type:32k-context`, or use `context:32k-context` to include every billing type with that budget. All four named budgets are available in tag browsing and suggestions.

## Prompt and token counts

Before sending, suggestions count the messages captured from that generation, after SillyTavern's configured prompt post-processing and custom body overrides. This includes lorebook entries actually retained in the prompt, the selected random-macro values, comment removal, and trimmed whitespace. Counting does not rebuild the prompt or evaluate macros again. SillyTavern's built-in local processing and tokenizer endpoints are used; the optional LiteRouter server helper is not required.

Pre-send counts are **tokenizer estimates**, not provider billing totals. Tool/schema formatting and model tokenizer differences can affect them. Media counts are marked unavailable locally rather than guessed. If processing or tokenization fails, recommendations are skipped; enabled cost confirmation still lets you review the unavailable estimate and proceed or cancel. Tracking uses API usage when returned. LiteRouter response `usage.prompt_tokens` and `usage.completion_tokens` take precedence over local counts, including usage delivered at the end of a stream. Missing Claude/Gemini Pro output usage is estimated by encoding the captured reply text with the request's model, without adding chat-message formatting tokens. Hidden reasoning cannot be reconstructed when it is absent from both text and usage.

Opening Connection Profiles shows a **Preview** based on SillyTavern's displayed total. Building a separate preview could select different random macros or lorebook entries from the later generation. Request confirmation instead holds the actual assembled request before sending it. When a count or price is unavailable, the confirmation says so; cached pricing is labelled. Cancelling prevents that request from being sent or recorded as usage.

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
