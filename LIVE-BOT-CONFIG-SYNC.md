# Live Bot Configuration Sync

BLACKLORD TECH INC. can queue bot configuration changes from the dashboard and deliver them to the Pterodactyl bot through the authenticated website bridge.

## Supported settings

The dashboard can queue a bot name, command prefix, welcome message, and public/self mode for a server owned by the signed-in phone number. The Pterodactyl process polls the website every two seconds by default, applies the values to the WhatsApp-number settings file, and acknowledges the change.

## Required environment variables

The Vercel project must contain:

```env
BOT_PAIRING_SECRET=replace_with_a_long_random_bot_secret
PAIRING_WEBHOOK_SECRET=replace_with_a_different_long_random_webhook_secret
```

The Pterodactyl `.env` must contain the active dashboard API key, the matching bot secret, and the deployed website URL:

```env
PORTAL_URL=https://your-website-domain.vercel.app
BLACKLORD_API_KEY=blacklord_replace_with_dashboard_key
BOT_PAIRING_SECRET=replace_with_a_long_random_bot_secret
PAIRING_WEBHOOK_SECRET=replace_with_a_different_long_random_webhook_secret
WEBSITE_CONFIG_POLL_MS=2000
```

Use the actual deployed portal URL if it differs from `blacklord.tech`. Do not use the Pterodactyl panel URL as `PORTAL_URL`.

## Flow

1. A registered user selects one of their servers in **Dashboard → Bot Config**.
2. The dashboard sends the configuration to `POST /api/dashboard/bot-config`.
3. Vercel stores the request in `bot_config_changes` with status `queued`.
4. Pterodactyl polls `GET /api/dashboard/bot-config/poll` with `X-Blacklord-API-Key` plus `BOT_PAIRING_SECRET`.
5. The bot writes the values into its per-WhatsApp-number settings file.
6. Pterodactyl acknowledges the request with `POST /api/dashboard/bot-config/ack`, again using the API key plus `BOT_PAIRING_SECRET`.
7. The dashboard displays the latest status as `queued`, `applied`, or `failed`.

## Important limitation

The website can only configure servers that exist in the website database and are linked to the same WhatsApp phone number. The Pterodactyl process must be restarted after installing the updated `index.js`; after restart, verify that the console contains:

```text
[WEBSITE CONFIG] Polling started on https://blacklord.tech every 2000ms
```

Keep `BLACKLORD_API_KEY`, `BOT_PAIRING_SECRET`, and `PAIRING_WEBHOOK_SECRET` private. Never expose them in frontend JavaScript or commit a real `.env` file.

## Key prefixes

New developer API keys begin with `blacklord_`. New Telegram activation/pairing keys begin with `BLACKLORD-`. Existing keys remain valid and are not rewritten.
