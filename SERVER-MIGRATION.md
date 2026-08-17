# BLACKLORD TECH INC — Pterodactyl Server Migration & Connection Guide

When moving the bot to a new Pterodactyl server, update the website and the bot environment together. The platform now uses **one website-managed pairing bridge**: the bot polls the website for pending pairing requests, and the bot posts pairing results back to the website. The old direct `BOT_PAIRING_ENDPOINT` flow is no longer used.

## 1. Connection credentials

| Variable | Configure in | Purpose |
|---|---|---|
| `BLACKLORD_API_KEY` | Pterodactyl bot `.env` | An active `blacklord_...` key generated in the Blacklord dashboard. It identifies the account that owns the pending requests and must never be committed to GitHub. |
| `BOT_PAIRING_SECRET` | Vercel and Pterodactyl `.env` | The secret for bot-to-website polling, configuration acknowledgement, and health reporting. The bot sends it as `X-Blacklord-Pairing-Secret`. |
| `PAIRING_WEBHOOK_SECRET` | Vercel and Pterodactyl `.env` | The separate secret for pairing-result callbacks. The bot sends it as `X-Blacklord-Pairing-Secret` to the callback route. |
| `PTERODACTYL_PANEL_URL` | Vercel | Your panel base URL, such as `https://panels.example.com`. |
| `PTERODACTYL_CLIENT_API_KEY` | Vercel | The Pterodactyl client key beginning with `ptlc_...`, used by the dashboard for server resources and power controls. |
| `PTERODACTYL_SERVER_IDENTIFIER` | Vercel | The short identifier of the server container used by the dashboard. |
| `PORTAL_URL` | Pterodactyl bot `.env` | The public website URL that the bot polls, such as `https://your-domain.vercel.app`. |

> **Do not add `BOT_PAIRING_ENDPOINT` to Vercel or the bot.** Pairing requests are queued in the website database and consumed through `/api/user/pairing/poll`; pairing results are sent to `/api/user/pairing/callback`.

## 2. Generate the Blacklord API key

Open the Blacklord dashboard, go to the **API Keys** or **Developer API** section, and create an active key. Copy the complete value immediately; for security, the dashboard stores only its hash and cannot display the complete key again. If the key is lost, revoke it and generate a replacement.

The key must begin with `blacklord_`. Use the key only in the Pterodactyl server's private environment. Do not place it in frontend JavaScript, screenshots, public documentation, Git commits, or a Telegram message.

## 3. Configure the website from the Admin Panel

For panel creation, open the website's protected **Admin Panel → Pterodactyl Infrastructure** section and enter the **Panel URL**, **Application API Key**, **Egg ID**, **Nest ID**, **Allocation Node ID**, and **Deployment Location ID**. Click **Save Global Configuration**. These six panel-creation values are stored in the protected `site_settings` database table and are the only values used by the server-creation endpoint; the endpoint refuses to create a server when any of them is missing.

The same Admin Panel also contains separate **Client Panel URL**, **Pterodactyl Client API Key**, and **Server Identifier** fields for dashboard resource and power-control features. Those client credentials are not used to create new servers. `BOT_PAIRING_SECRET` and `PAIRING_WEBHOOK_SECRET` are separate pairing-bridge settings.

The panel-creation endpoint does not read `PANEL_DOMAIN`, `PANEL_APIKEY`, `PANEL_EGG`, `PANEL_NEST`, `PANEL_NODE_ID`, or `PANEL_LOCATION_ID` from Vercel environment variables. Keep these values in the protected Admin Panel settings. Vercel environment variables may still be used by unrelated dashboard or pairing features where documented, but they are not a fallback for panel creation.

`BOT_PAIRING_SECRET` and `PAIRING_WEBHOOK_SECRET` should be different long random values. They must match the corresponding values in the Pterodactyl bot environment. The Blacklord API key is **not** a global Vercel variable; it is generated per account and supplied by the Pterodactyl bot in the `X-Blacklord-API-Key` header.

## 4. Configure the Pterodactyl bot

In the Pterodactyl server's environment variables or private `.env` file, set:

```env
PORTAL_URL=https://your-website-domain.vercel.app
BLACKLORD_API_KEY=blacklord_replace_with_the_active_dashboard_key
BOT_PAIRING_SECRET=replace_with_the_same_bot_secret_as_vercel
PAIRING_WEBHOOK_SECRET=replace_with_the_same_webhook_secret_as_vercel
WEBSITE_HEALTH_PHONE=254712345678
PTERODACTYL_SERVER_ID=replace_with_the_server_identifier
```

Restart the Pterodactyl server after saving the variables. The bot uses the following single bridge routes internally:

| Purpose | Website route | Required credentials |
|---|---|---|
| Read pending website pairing request | `GET /api/user/pairing/poll` | `X-Blacklord-API-Key` + `BOT_PAIRING_SECRET` |
| Submit pairing result | `POST /api/user/pairing/callback` | `X-Blacklord-API-Key` + `PAIRING_WEBHOOK_SECRET` |
| Report bot health | `POST /api/dashboard/health` | `X-Blacklord-API-Key` + `BOT_PAIRING_SECRET` |
| Poll dashboard configuration | `GET /api/dashboard/bot-config/poll` | `X-Blacklord-API-Key` + `BOT_PAIRING_SECRET` |
| Acknowledge configuration | `POST /api/dashboard/bot-config/ack` | `X-Blacklord-API-Key` + `BOT_PAIRING_SECRET` |

The API key is sent in the `X-Blacklord-API-Key` header. The route-specific secret is sent in the `X-Blacklord-Pairing-Secret` header and may also be sent as a Bearer token.

## 5. Test the connection

First restart the bot and inspect its logs. Successful startup should show the website pairing polling and health reporting bridges starting. If pairing polling repeatedly returns `401`, check `BLACKLORD_API_KEY` and `BOT_PAIRING_SECRET`. If callbacks return `401`, check `BLACKLORD_API_KEY` and `PAIRING_WEBHOOK_SECRET`.

Then open the dashboard, choose a bot type, enter a WhatsApp number, and request a pairing code. The website should show a queued request immediately; the running Pterodactyl bot should consume it and post the generated code back within a few seconds.

## 6. What changes when the server changes

When changing Pterodactyl servers, update the **Admin Panel → Pterodactyl Infrastructure** values and the new server's private environment. The Blacklord API key can remain the same if it is still active, but generate a new key if the old server may have exposed it. Update `PTERODACTYL_SERVER_IDENTIFIER`, `PTERODACTYL_CLIENT_API_KEY`, `PTERODACTYL_SERVER_ID`, and the bot environment values, save and test the Admin Panel connection, then restart the new bot. A Vercel redeploy is only needed when changing the fallback environment variables, not when saving database-backed Admin Panel settings.

Do not use the old direct bot URL, a public pairing endpoint, or a shared API key embedded in browser code. The website dashboard remains the user-facing pairing interface, while the Pterodactyl bot performs the background polling and callback work.

## References

- [Pterodactyl Client API documentation](https://pterodactyl-api-docs.netvpx.com/)
- [Vercel environment variables documentation](https://vercel.com/docs/environment-variables)
