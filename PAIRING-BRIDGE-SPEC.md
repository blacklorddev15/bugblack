# WhatsApp Pairing Bridge: Vercel & Pterodactyl Integration Specification

## Executive Summary

To achieve seamless WhatsApp bot pairing directly from the **BLACKLORD TECH INC** platform while executing the bot process persistently on a Pterodactyl panel (`panels.tnppanels.top`), we establish a secure, asynchronous communication bridge between Vercel Serverless Functions and the Pterodactyl server daemon.

| Component | Technology | Role |
|---|---|---|
| **Frontend UI** | Vanilla JS / HTML5 | Captures WhatsApp number and pairing requests, polling the Vercel API for status. |
| **Vercel API Layer** | Node.js Serverless (`api/user-handler.js`) | Validates user activation keys (`blacklord-*`), tracks pairing state in PostgreSQL, and proxies requests to Pterodactyl. |
| **Pterodactyl Panel** | Pterodactyl API (`panels.tnppanels.top`) | Manages container lifecycle, environment variables, and client-side server control. |
| **Bot Process** | Node.js (Baileys / WhatsApp Web API) | Runs persistently on Pterodactyl, handling the WebSocket connection to WhatsApp and generating pairing codes. |

---

## Architecture & Data Flow

```
+--------------------+        1. Request Pairing        +------------------------+
|                    | -------------------------------> |                        |
|  Vercel Frontend   |                                  |   Vercel API Handler   |
|  (User Dashboard)  | <------------------------------- |   (/api/user/pairing)  |
|                    |      2. Return Pairing Code      +------------------------+
+--------------------+                                              |
                                              3. Forward Command / Client API (HTTPS)
                                                                    v
                                                        +------------------------+
                                                        |   Pterodactyl Daemon   |
                                                        |  (panels.tnppanels.top)|
                                                        +------------------------+
                                                                    |
                                                                    v
                                                        +------------------------+
                                                        |    Bot Container Process|
                                                        |    (WhatsApp Session)  |
                                                        +------------------------+
```

### Security Considerations

1. **API Key Isolation**: The Pterodactyl Application/Client API keys (`ptlc_*`) are stored securely as environment variables (`PTERODACTYL_API_KEY`, `PTERODACTYL_PANEL_URL`) on Vercel and are **never exposed** to browser clients.
2. **Key Validation**: Users must present a valid, registered account or activation key (`blacklord-*`) before initiating pairing requests.
3. **Encrypted Webhooks**: Status updates and pairing codes returned from the bot container to Vercel are authenticated via shared webhook secrets.

---

*Prepared by **Manus AI** for BLACKLORD TECH INC.*
