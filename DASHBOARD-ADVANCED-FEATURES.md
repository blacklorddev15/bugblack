# BLACKLORD TECH INC — Advanced Dashboard Features

The dashboard now includes Webhooks, the existing Cloudflare-backed Subdomain Manager, Referral Tiers, a Bot Marketplace, Wallet Auto-Topup settings, and the existing Admin Broadcast system.

## Webhooks

Users create webhook subscriptions from **Dashboard → Webhooks**. New signing secrets are displayed once and should be stored privately. Each delivery includes `X-Blacklord-Event` and an HMAC-SHA256 `X-Blacklord-Signature` header. The signature is calculated over the exact JSON request body using the webhook signing secret.

Supported event names are `pairing.completed`, `pairing.failed`, `server.status`, `deposit.success`, and `webhook.test`. The backend records the latest HTTP status and delivery time for each webhook.

## Subdomains

The existing **Domain Workspace** uses `/api/domains` and Cloudflare credentials. The deployment must have the Cloudflare zone and DNS credentials configured before users can register `*.blacklord.tech` names.

## Referral Tiers

The database seeds Starter, Bronze, Silver, and Gold tiers. The dashboard computes the current tier from the verified referral ledger and records the current tier on the user account.

## Bot Marketplace

The database seeds three starter marketplace tools. Users purchase them with SD balance from **Dashboard → Bot Marketplace**. Marketplace purchases are recorded in `user_plugins` and the balance is debited atomically.

Administrators can add more catalog items through the database or a future admin catalog screen; do not insert untrusted executable code as a plugin. The current marketplace represents account entitlements and does not upload arbitrary files to Pterodactyl.

## Wallet Auto-Topup

Users can save an auto-topup threshold, amount, payment method, and payment phone. Automatic charging only runs when a supported payment provider is configured in the deployment. Saving the setting does not charge a user immediately. The payment callback must credit the existing `deposits` table exactly once before the wallet balance changes.

Relevant provider variables include the existing Blacklord STK, Paystack, or bank configuration used by `/api/user/topup`. Never commit provider secrets to GitHub.

## Deployment

The database initializer creates or extends the required tables on the next API request. Vercel already routes `/api/dashboard/*` to `api/dashboard-handler.js`. After deployment, load an account and test each section from the dashboard. The backend webhook dispatcher is best-effort and records failed delivery status without blocking pairing or payment callbacks.
