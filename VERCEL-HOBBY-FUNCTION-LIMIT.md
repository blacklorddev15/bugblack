# Vercel Hobby Function Limit

The Vercel Hobby deployment is limited to **12 serverless functions per deployment**. The portal previously contained 13 JavaScript files under `api/`, which caused production builds to fail before any application code ran.

The unused diagnostic endpoint `api/test.js` has been removed from the Main and Staging repositories. No frontend, rewrite, cron, payment, dashboard, pairing, domain, or Pterodactyl integration referenced that endpoint.

## Current Main production functions

The Main repository now contains exactly 12 production candidates:

1. `api/admin-handler.js`
2. `api/c2b-handler.js`
3. `api/create-panel.js`
4. `api/cron/auto-renew.js`
5. `api/cron/subscription.js`
6. `api/dashboard-handler.js`
7. `api/domain-handler.js`
8. `api/generate.js`
9. `api/mpesa-stk-handler.js`
10. `api/paystack-handler.js`
11. `api/telegram-webhook.js`
12. `api/user-handler.js`

Files under `api/helpers/` are imported modules and are not deployed as standalone Vercel functions. The existing `vercel.json` rewrites continue routing the public paths to the grouped handlers, so no endpoint path changes are required.

## Verification

Before pushing, validate with:

```bash
find api -type f -name '*.js' ! -path 'api/helpers/*' | wc -l
node --check api/admin-handler.js
node --check api/c2b-handler.js
node --check api/create-panel.js
node --check api/cron/auto-renew.js
node --check api/cron/subscription.js
node --check api/dashboard-handler.js
node --check api/domain-handler.js
node --check api/generate.js
node --check api/mpesa-stk-handler.js
node --check api/paystack-handler.js
node --check api/telegram-webhook.js
node --check api/user-handler.js
git diff --check
```

The count must remain at or below 12 for Hobby-plan deployments. Do not add diagnostic files such as `api/test.js` to production. If a new endpoint is needed later, add it inside an existing grouped handler or upgrade the Vercel plan.
