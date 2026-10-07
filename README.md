# LiteRouter Tracker

A SillyTavern extension for LiteRouter connections using **Chat Completion → Custom (OpenAI-compatible)**.

## Features

- **Better model search:** browse live models in Connection Profiles, filter with booru tags, and sort by price, status, speed, or requests per day. Models refresh automatically when you open API Connections or expand the LiteRouter model browser.
- **Cost estimates:** see credits per request and requests per day using your chat's **Total Tokens**, selected plan, and Chat Optimization settings.
- **Simulated comparisons:** compare up to five models using a chat size you choose.
- **Model recommendations:** suggest cheaper variants of the same base model before sending, or switch automatically. Outaged models are excluded.
- **Price-increase warnings:** warn once before sending when your selected model's price multiplier rises between pricing refreshes. Suggest mode shows the increase in red inside available recommendations. Otherwise, a separate dialog lets you cancel (the default) or continue, including in Automatic mode. Warnings are enabled by default and can be disabled under **Live data settings**.
- **Credit tracking:** see requests made, estimated credits spent and remaining, time until reset, and usage history with filters and charts.
- **Claude/Gemini Pro output tracking:** track their shared daily output limit, calculated as your daily premium credits × 20. Gemini Flash models are excluded; their requests and credit usage are still tracked.

Set your plan and Chat Optimization values in the extension settings to match your LiteRouter dashboard. Tracking covers requests made through SillyTavern while the extension is active; estimates do not sync with your account balance or other apps.

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
