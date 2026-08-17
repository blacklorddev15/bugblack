# BLACKLORD TECH INC Landing Page Enhancements

The public homepage now presents BLACKLORD TECH INC as a complete bot-hosting and developer platform rather than a single pairing screen. The original wallet, registration, login, panel ordering, bot cards, and payment flows remain in place.

## New public sections

The homepage includes a live trust band with online bot count, monitored-service count, messages recorded today, and average uptime. It also includes a platform-status line, an infrastructure strip covering Pterodactyl, WhatsApp pairing, M-Pesa C2B/STK, Paystack, and signed webhooks, and a quick-menu path to the new sections.

The product showcase explains bot health, live configuration sync, the plugin marketplace, webhooks/API, custom subdomains, and referral growth. Free, Blacklord Pro, and Blacklord Elite cards match the backend plan catalog: Free is 0 SD, Pro is 25 SD monthly, and Elite is 60 SD monthly. The paid-plan CTAs route to the authenticated dashboard subscription section without attempting a payment on the public page.

The marketplace preview loads public plugin data from `GET /api/user/marketplace/plugins`. The community proof area loads privacy-safe activity summaries from `GET /api/user/activity` and top referral rows from `GET /api/user/leaderboard`. The developer teaser links to the API documentation and uses only a redacted webhook example; no secret is exposed.

The affiliate CTA explains the Starter-to-Gold referral path and sends unregistered visitors to registration. A newsletter form submits to `POST /api/user/newsletter`. Email addresses are normalized, validated, stored in `newsletter_subscribers`, and reactivated if the same address subscribes again. The endpoint does not send email by itself; it provides a clean stored subscriber list for a future approved email-delivery provider.

The FAQ now covers pairing, panel ordering, all supported payment methods, API/webhook access, and the three-hour trial. The design uses the existing dark artwork, gold accent system, frosted panels, responsive grids, reduced-motion support, and keyboard-friendly native controls.

## Public status metrics

`GET /api/user/status` now returns the existing bot list and an additional `metrics` object:

```json
{
  "messagesToday": 0,
  "registeredUsers": 0,
  "activeServices": 0
}
```

`messagesToday` is the sum of `bot_analytics.messages_count` recorded since the current database date. The homepage does not fabricate a message total when no analytics sample exists.

## Deployment notes

Deploy the updated `index.html`, `api/user-handler.js`, `api/helpers/db.js`, and this document to Vercel. Database initialization creates `newsletter_subscribers` automatically. Keep the existing payment environment variables and webhook secrets unchanged. After deployment, verify the homepage status band, marketplace preview, activity feed, leaderboard, and newsletter form from an HTTPS deployment rather than a local `file://` preview.
