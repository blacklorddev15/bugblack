# ⚡ BLACKLORD TECH INC ⚡

Welcome to the professional platform for WhatsApp bot hosting and pairing. This repository contains the frontend landing page, user dashboard, and the secure Vercel-to-Pterodactyl pairing bridge. No Telegram bots or external keys are required.

---

## 🚀 Core Features

- **Public WhatsApp Pairing**: No login required. Users can generate pairing codes for **Blacklord XMD** and **Samsung XMD** directly from the landing page.
- **Secure Authentication**: Optional registration for members to access advanced dashboard features, member analytics, and bot health insurance.
- **Pairing Bridge**: A secure HTTP proxying system between Vercel (Serverless) and Pterodactyl (Bot Hosting).
- **Luxury Theme**: A professional dark-gold luxury aesthetic designed for high-end tech services.

---

## 🛠 Infrastructure Setup

### 1. Pterodactyl Bot Server
Your bots must be running on a Pterodactyl panel. The bot entrypoint (e.g., `index.js`) must be patched to handle incoming pairing requests from the Vercel bridge. Users pair directly via WhatsApp Linked Devices using the generated code.

**Required Server Info:**
- **Server IP**: Found in the *Network* or *Settings* tab of your panel.
- **Port**: Found in the *Network* tab under *Allocations*.
- **Server ID**: The 8-character code in your browser URL (e.g., `f9a091bd`).

### 2. Vercel Environment Variables
To connect the website to your bot server, you must set these variables in your Vercel Dashboard (**Settings > Environment Variables**):

| Variable | Example Value | Description |
| :--- | :--- | :--- |
| `PTERODACTYL_PANEL_URL` | `https://panels.tnppanels.top` | Your panel URL |
| `PTERODACTYL_CLIENT_API_KEY` | `ptlc_your_key_here` | Client API key from Account Settings |
| `PTERODACTYL_SERVER_IDENTIFIER` | `f9a091bd` | The 8-char server ID |
| `BOT_PAIRING_SECRET` | `your_bot_secret` | Authenticates bot polling, configuration acknowledgement, and health reports |
| `PAIRING_WEBHOOK_SECRET` | `your_webhook_secret` | Authenticates pairing-result callbacks |
| `BLACKLORD_API_KEY` | Not a global Vercel variable | Generated per account in the dashboard and stored only in the Pterodactyl bot `.env` as `blacklord_...` |
| `DATABASE_URL` | `postgres://...` | Neon PostgreSQL connection string |

---

## 🔄 How to Change Your Bot Server

If you move to a new Pterodactyl server:
1. Update `PTERODACTYL_SERVER_IDENTIFIER`, `PTERODACTYL_CLIENT_API_KEY`, and the bot's private environment variables.
2. Keep the same active `blacklord_...` API key only if the old server did not expose it; otherwise revoke it and generate a replacement in the dashboard.
3. Ensure `BOT_PAIRING_SECRET` and `PAIRING_WEBHOOK_SECRET` match between Vercel and Pterodactyl.
4. Redeploy Vercel after changing Vercel variables and restart the Pterodactyl bot.

Pairing no longer uses a direct `BOT_PAIRING_ENDPOINT`. The bot polls the website's queue and posts results back through the authenticated callback route.

---

## 📂 Project Structure

- `index.html`: The main landing page with the public pairing generator.
- `dashboard.html`: User account overview and integrated pairing card.
- `pairing.html`: Standalone pairing portal.
- `api/user-handler.js`: The backend logic for auth, pairing requests, and database interactions.
- `api/helpers/db.js`: Database schema and helper functions.

---

## ⚖️ License & Support
Managed by **Blacklord Dev**. For technical issues or feature requests, please use the support ticketing system in the User Dashboard.

**BLACKLORD TECH INC · Secure · Reliable · Relentless**
