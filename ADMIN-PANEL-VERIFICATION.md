# Admin Panel Pterodactyl Verification

Date: 2026-08-16

The protected blacklord.tech Admin Panel was used to save the panel-creation settings. The Application API key field was populated and saved without recording the secret in this note.

Current panel-creation values:

- Panel URL: https://panels.tnppanels.top
- Nest ID: 5 (WhatsApp bot)
- Egg ID: 21 (Mzazi Tech Inc - NPM Start)
- Allocation Node ID: 1
- Deployment Location ID: 1

Non-destructive Application API checks:

- GET /api/application/nodes/1/allocations: HTTP 200
- Free allocations observed: 37
- GET /api/application/nests/5/eggs/21?include=variables: HTTP 200
- Egg 21 matched the requested ID.
- The previous configuration Nest 5 / Egg 15 returned HTTP 404 because Egg 15 belongs to the Minecraft nest.

No Pterodactyl server was created during this verification. A real creation test still requires a test account payload and would create a real user/server and consume an allocation.
