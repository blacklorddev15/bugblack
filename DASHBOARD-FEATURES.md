# BLACKLORD TECH INC Dashboard Feature Suite

The dashboard now combines bot operations, analytics, developer tooling, monetization, referrals, marketplace workflows, and account transparency in one authenticated workspace. **Two-factor authentication is intentionally not included.**

## Operational visibility

The Bot Health panel reads the latest server health snapshots and detailed bot analytics. A Pterodactyl process may report health to `POST /api/dashboard/health` using the shared `BOT_PAIRING_SECRET` and the account phone associated with the server. The dashboard stores uptime, latency, memory, message, command, and active-group samples in PostgreSQL. The browser can optionally display an offline notification when a service is not reporting a running state.

The read-only analytics endpoint is `GET /api/dashboard/analytics-detail?phone=<phone>&days=7&serverId=<optional-server-id>`. The health summary endpoint is `GET /api/dashboard/health?phone=<phone>`. Existing session management remains available under `GET/POST /api/dashboard/security`; password changes and session revocations are recorded in the audit log.

## Marketplace and community

Users can purchase marketplace plugins through the existing Marketplace panel and configure owned plugins through `GET/POST /api/dashboard/plugin-manager`. Plugin settings are stored as JSON and each installed plugin has an enabled flag. The community leaderboard is available at `GET /api/dashboard/leaderboard?sort=referrals`, with supported sort values of `referrals`, `servers`, and `messages`.

The Verified Developer Program accepts repository or package URLs through `POST /api/dashboard/developer-program`. Submissions are kept in a pending state until an administrator reviews them in the Admin Panel. Admin review is performed through `GET/POST /api/admin/developer-submissions`.

## Monetization and growth

Blacklord Pro plan definitions and the current subscription are returned by `GET /api/dashboard/subscription?phone=<phone>`. A plan change is submitted through `POST /api/dashboard/subscription` and charges the user’s SD wallet. The supported plan keys are `free`, `pro`, and `elite`. Coupon validation is available through `GET /api/dashboard/coupon?phone=<phone>&code=<code>`, while administrators create or deactivate campaigns with `POST/DELETE /api/admin/coupons`.

Affiliate materials are returned by `GET /api/dashboard/affiliate-assets?phone=<phone>`. The response includes the referral code, a referral URL, a text badge, and an embeddable banner snippet that can be copied from the dashboard.

## Developer tools

Developer API keys continue to use the required `blacklord_` prefix. The API Sandbox accepts an active key and only exposes read-only analytics and health examples. It is intentionally restricted to these endpoints:

| Sandbox endpoint | Purpose |
|---|---|
| `/api/user/analytics` | Account-level deposit, service, and key counts |
| `/api/dashboard/health` | Latest health snapshot per service |
| `/api/dashboard/analytics-detail` | Detailed message and command history |

Webhook delivery logs are stored in `webhook_deliveries` and displayed by `GET /api/dashboard/webhook-logs?phone=<phone>`. The existing HMAC-SHA256 signature format remains unchanged. The Subdomain CSS panel stores safe, user-owned CSS through `GET/POST /api/dashboard/subdomain-style` and rejects script-like style payloads.

## Account audit history

Important changes are recorded in `account_audit_log`, including password changes, session revocations, API key creation and revocation, webhook changes, bot configuration changes, marketplace purchases, auto-topup changes, theme updates, plugin settings changes, subscription changes, developer submissions, API Sandbox requests, and subdomain CSS updates. The user-facing history is returned by `GET /api/dashboard/audit-log?phone=<phone>`.

## Pterodactyl health configuration

Add these values to the live Pterodactyl `.env` file. The phone must match the portal account that owns the server, and the server identifier must match the `servers.server_id` value stored by the website.

```env
PORTAL_URL=https://blacklord.tech
BOT_PAIRING_SECRET=the_same_private_value_as_vercel
PAIRING_WEBHOOK_SECRET=the_same_private_value_as_vercel
WEBSITE_HEALTH_PHONE=254700000000
PTERODACTYL_SERVER_ID=your_panel_server_identifier
WEBSITE_HEALTH_REPORT_MS=60000
```

The reporter posts to `https://blacklord.tech/api/dashboard/health` and does not expose the shared secret to WhatsApp users. If the required health variables are missing, the bot continues running and logs that health reporting is disabled.

## Database initialization

`api/helpers/db.js` creates the additional tables on startup: `server_health_checks`, `bot_analytics`, `plugin_settings`, `developer_submissions`, `user_subscriptions`, `coupons`, `coupon_redemptions`, `webhook_deliveries`, `subdomain_styles`, and `account_audit_log`. It also migrates stale auto-topup provider values to the supported `c2b` default. The payment system remains limited to Paystack, M-Pesa C2B Till, and Daraja STK Push.

## Deployment checklist

Set `DATABASE_URL`, the payment provider secrets, the Pterodactyl panel values, and the pairing bridge secrets in Vercel. Keep the Pterodactyl `.env` private, upload the updated root `index.js`, `.env.example`, and supporting helper files, then restart the server. Confirm the portal API and Pterodactyl startup logs before enabling browser health notifications.
