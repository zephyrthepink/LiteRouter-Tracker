# LiteRouter server helper (optional)

Fetches public model prices and status for the extension without the misleading “Streaming request finished” logs from SillyTavern's CORS proxy. The extension also works without this plugin.

1. Copy `literouter-data.mjs` from this folder into **`SillyTavern/plugins/`**. If using `LiteRouter-Server-Helper.zip`, extract it into your SillyTavern root folder instead.
2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
3. Restart SillyTavern and reload the browser.
4. In **Extensions → LiteRouter → Live data settings**, select **SillyTavern server helper (optional; quieter logs)** and click **Refresh live data**.
