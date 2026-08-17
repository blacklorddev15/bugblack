const axios = require('axios');
const crypto = require('crypto');
const { pool, initDb, getSiteSettings, logActivity, sendTelegramNotification } = require('./helpers/db');

function adminTokenSecret() {
  return String(process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || 'blacklorddev');
}

function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({ scope: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', adminTokenSecret()).update(payload).digest('base64url');
  return `bladmin.${payload}.${signature}`;
}

function validAdminToken(value) {
  const token = String(value || '').replace(/^Bearer\s+/i, '').trim();
  const [prefix, payload, signature] = token.split('.');
  if (prefix !== 'bladmin' || !payload || !signature) return false;
  const expected = crypto.createHmac('sha256', adminTokenSecret()).update(payload).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.scope === 'admin' && Number(claims.exp) > Date.now();
  } catch (_) {
    return false;
  }
}

export default async function handler(req, res) {
  const { url, method, body = {}, headers = {} } = req;
  const requestUrl = new URL(url, 'http://localhost');
  const path = requestUrl.pathname.replace('/api/admin/', '');

  // 1. Handle Login (No auth required)
  if (path === 'login' && method === 'POST') {
    const { password } = body;
    const adminPass = process.env.ADMIN_PASSWORD || 'blacklorddev';
    if (password === adminPass) {
      return res.status(200).json({ success: true, token: createAdminToken(), expiresIn: 8 * 60 * 60 });
    } else {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }
  }

  // 2. Auth Check for all other admin routes
  const auth = headers.authorization;
  if (!validAdminToken(auth)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await initDb();
    const client = await pool.connect();

    switch (path) {
      case 'analytics':
        if (method !== 'GET') break;
        const revRes = await client.query("SELECT SUM(amount_ksh) as total_ksh, SUM(amount_sd) as total_sd FROM deposits WHERE status = 'success'");
        const srvRes = await client.query("SELECT COUNT(*) as total_servers FROM servers");
        const keyRes = await client.query("SELECT COUNT(*) as total_keys FROM keys");
        const userRes = await client.query("SELECT COUNT(*) as total_users FROM users");
        const logRes = await client.query("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 20");
        client.release();
        return res.status(200).json({
          success: true,
          stats: {
            totalKsh: revRes.rows[0]?.total_ksh || 0,
            totalSd: revRes.rows[0]?.total_sd || 0,
            totalServers: srvRes.rows[0]?.total_servers || 0,
            totalKeys: keyRes.rows[0]?.total_keys || 0,
            totalUsers: userRes.rows[0]?.total_users || 0,
          },
          logs: logRes.rows
        });

      case 'pterodactyl-test': {
        if (method !== 'POST') { client.release(); return res.status(405).json({ error: 'Method not allowed' }); }
        const settings = await getSiteSettings(client, ['PTERODACTYL_PANEL_URL', 'PTERODACTYL_CLIENT_API_KEY', 'PTERODACTYL_SERVER_IDENTIFIER', 'PANEL_DOMAIN', 'PANEL_APIKEY']);
        const panelUrl = String(settings.PTERODACTYL_PANEL_URL || settings.PANEL_DOMAIN || process.env.PTERODACTYL_PANEL_URL || process.env.PANEL_DOMAIN || '').replace(/\/$/, '');
        const clientApiKey = settings.PTERODACTYL_CLIENT_API_KEY || settings.PANEL_APIKEY || process.env.PTERODACTYL_CLIENT_API_KEY || '';
        const serverIdentifier = String(settings.PTERODACTYL_SERVER_IDENTIFIER || process.env.PTERODACTYL_SERVER_IDENTIFIER || '').trim();
        if (!panelUrl || !clientApiKey || !serverIdentifier) { client.release(); return res.status(400).json({ error: 'Panel URL, Client API Key, and Server Identifier are required.' }); }
        try {
          const response = await axios.get(`${panelUrl}/api/client/servers/${encodeURIComponent(serverIdentifier)}/resources`, {
            headers: { Authorization: `Bearer ${clientApiKey}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
            timeout: 10000
          });
          const attributes = response.data?.attributes || {};
          client.release();
          return res.status(200).json({ success: true, status: attributes.current_state || 'unknown', resources: attributes.resources || null, message: 'Pterodactyl connection is working.' });
        } catch (error) {
          client.release();
          const detail = error.response?.data?.errors?.[0]?.detail || error.response?.data?.message || error.message || 'Pterodactyl connection failed.';
          return res.status(error.response?.status || 502).json({ success: false, error: detail });
        }
      }

      case 'settings':
        if (method === 'GET') {
          const result = await client.query('SELECT * FROM site_settings');
          client.release();
          const settings = {};
          result.rows.forEach(row => { settings[row.key] = row.value; });
          return res.status(200).json({ success: true, settings });
        }
        if (method === 'POST') {
          for (const [key, value] of Object.entries(body)) {
            await client.query('INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, String(value)]);
          }
          client.release();
          return res.status(200).json({ success: true });
        }
        break;

      case 'broadcasts': {
        if (method === 'GET') {
          const broadcastRes = await client.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100');
          client.release();
          return res.status(200).json({ success: true, broadcasts: broadcastRes.rows });
        }
        if (method === 'POST') {
          if (body.action === 'delete') {
            await client.query('UPDATE broadcasts SET active = FALSE WHERE id = $1', [Number(body.id)]);
            client.release();
            return res.status(200).json({ success: true });
          }
          const message = String(body.message || '').trim();
          const kind = ['info', 'success', 'warning', 'maintenance'].includes(body.kind) ? body.kind : 'info';
          if (!message || message.length > 500) { client.release(); return res.status(400).json({ error: 'Broadcast message must be 1–500 characters.' }); }
          const result = await client.query('INSERT INTO broadcasts (message, kind, active, ends_at) VALUES ($1, $2, $3, $4) RETURNING *', [message, kind, body.active !== false, body.endsAt || null]);
          client.release();
          return res.status(200).json({ success: true, broadcast: result.rows[0] });
        }
        break;
      }

      case 'gift-cards': {
        if (method === 'GET') {
          const cardRes = await client.query('SELECT code, amount_sd, is_used, redeemed_by, expires_at, created_at FROM gift_cards ORDER BY created_at DESC LIMIT 100');
          client.release();
          return res.status(200).json({ success: true, giftCards: cardRes.rows });
        }
        if (method === 'POST') {
          const amount = Number(body.amountSD);
          if (!Number.isFinite(amount) || amount <= 0) { client.release(); return res.status(400).json({ error: 'Valid gift-card amount is required.' }); }
          const code = String(body.code || `BL-GIFT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`).toUpperCase();
          const result = await client.query('INSERT INTO gift_cards (code, amount_sd, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING code, amount_sd, expires_at', [code, amount, body.createdBy || 'admin', body.expiresAt || null]);
          client.release();
          return res.status(200).json({ success: true, giftCard: result.rows[0] });
        }
        break;
      }

      case 'resellers': {
        if (method === 'GET') {
          const resellerRes = await client.query("SELECT phone, username, balance, reseller_tier, reseller_bonus_percent, total_topup_sd FROM users WHERE registered_at IS NOT NULL ORDER BY total_topup_sd DESC NULLS LAST LIMIT 100");
          client.release();
          return res.status(200).json({ success: true, users: resellerRes.rows });
        }
        if (method === 'POST') {
          const tier = ['standard', 'silver', 'gold', 'diamond'].includes(body.tier) ? body.tier : 'standard';
          const bonusPercent = Math.min(20, Math.max(0, Number(body.bonusPercent || 0)));
          if (!body.phone || !Number.isFinite(bonusPercent)) { client.release(); return res.status(400).json({ error: 'Phone and valid bonus percentage are required.' }); }
          const result = await client.query('UPDATE users SET reseller_tier = $1, reseller_bonus_percent = $2 WHERE phone = $3 RETURNING phone, username, reseller_tier, reseller_bonus_percent', [tier, bonusPercent, body.phone]);
          client.release();
          if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });
          return res.status(200).json({ success: true, user: result.rows[0] });
        }
        break;
      }

      case 'addons': {
        if (method === 'GET') {
          const addonRes = await client.query('SELECT * FROM addons ORDER BY id ASC');
          client.release();
          return res.status(200).json({ success: true, addons: addonRes.rows });
        }
        if (method === 'POST') {
          const name = String(body.name || '').trim();
          const slug = String(body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-|-$/g, '');
          const price = Number(body.priceSD);
          if (!name || !slug || !Number.isFinite(price) || price < 0) { client.release(); return res.status(400).json({ error: 'Name and valid price are required.' }); }
          const result = await client.query('INSERT INTO addons (slug, name, description, price_sd, active) VALUES ($1, $2, $3, $4, $5) RETURNING *', [slug, name, body.description || '', price, body.active !== false]);
          client.release();
          return res.status(200).json({ success: true, addon: result.rows[0] });
        }
        break;
      }

      case 'bank-deposits':
        client.release();
        return res.status(410).json({ error: 'Manual bank deposits are disabled. Use Paystack, M-Pesa C2B Till, or M-Pesa STK Push.' });

      case 'keys':
        if (method !== 'GET') break;
        const keysRes = await client.query('SELECT * FROM keys ORDER BY created_at DESC LIMIT 100');
        client.release();
        return res.status(200).json({ success: true, keys: keysRes.rows });

      case 'vouchers':
        if (method === 'GET') {
          const result = await client.query('SELECT code, amount, is_used, used_by, used_at, expires_at, created_by, created_at FROM vouchers ORDER BY created_at DESC LIMIT 200');
          client.release();
          return res.status(200).json({ success: true, vouchers: result.rows });
        }
        if (method === 'POST') {
          const amount = Number(body.amount ?? body.amountSD);
          const createdBy = String(body.createdBy || 'admin').trim().slice(0, 120) || 'admin';
          const requestedCode = String(body.code || '').trim().toUpperCase();
          const code = requestedCode || `BL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
          const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
          if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) { client.release(); return res.status(400).json({ error: 'Enter a voucher amount greater than 0 and no more than 1,000,000 SD.' }); }
          if (!/^[A-Z0-9][A-Z0-9-]{3,47}$/.test(code)) { client.release(); return res.status(400).json({ error: 'Voucher code must be 4–48 characters using letters, numbers, or hyphens.' }); }
          if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) { client.release(); return res.status(400).json({ error: 'Expiry must be a valid future date.' }); }
          const result = await client.query('INSERT INTO vouchers (code, amount, expires_at, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING RETURNING code, amount, is_used, expires_at, created_by, created_at', [code, amount, expiresAt, createdBy]);
          client.release();
          if (!result.rows[0]) return res.status(409).json({ error: 'That voucher code already exists. Choose another code.' });
          logActivity('VOUCHER_CREATED', `Admin ${createdBy} created voucher ${code} for ${amount} SD.`);
          return res.status(201).json({ success: true, voucher: result.rows[0], code: result.rows[0].code });
        }
        if (method === 'DELETE') {
          const code = String(body.code || '').trim().toUpperCase();
          if (!code) { client.release(); return res.status(400).json({ error: 'Voucher code is required.' }); }
          const result = await client.query('DELETE FROM vouchers WHERE code = $1 AND is_used = FALSE RETURNING code', [code]);
          client.release();
          if (!result.rows[0]) return res.status(404).json({ error: 'Unused voucher not found.' });
          return res.status(200).json({ success: true, code });
        }
        break;

      case 'coupons': {
        if (method === 'GET') {
          const result = await client.query('SELECT code, discount_percent, max_redemptions, redeemed_count, expires_at, active, created_by, created_at FROM coupons ORDER BY created_at DESC LIMIT 200');
          client.release();
          return res.status(200).json({ success: true, coupons: result.rows });
        }
        if (method === 'POST') {
          const code = String(body.code || '').trim().toUpperCase();
          const discountPercent = Number(body.discountPercent);
          const maxRedemptions = Math.max(1, Math.min(1000000, Number(body.maxRedemptions || 1)));
          const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
          if (!/^[A-Z0-9][A-Z0-9-]{3,47}$/.test(code) || !Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100 || !Number.isInteger(maxRedemptions)) { client.release(); return res.status(400).json({ error: 'Enter a valid code, discount from 1–100, and redemption limit.' }); }
          if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) { client.release(); return res.status(400).json({ error: 'Expiry must be a valid future date.' }); }
          const result = await client.query('INSERT INTO coupons (code, discount_percent, max_redemptions, expires_at, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING RETURNING code, discount_percent, max_redemptions, expires_at, active, created_by, created_at', [code, discountPercent, maxRedemptions, expiresAt, body.createdBy || 'admin']);
          client.release();
          if (!result.rows[0]) return res.status(409).json({ error: 'That coupon code already exists.' });
          return res.status(201).json({ success: true, coupon: result.rows[0] });
        }
        if (method === 'DELETE') {
          const code = String(body.code || '').trim().toUpperCase();
          const result = await client.query('UPDATE coupons SET active = FALSE WHERE code = $1 RETURNING code', [code]);
          client.release();
          return res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: 'Coupon not found.' });
        }
        break;
      }

      case 'developer-submissions': {
        if (method === 'GET') {
          const result = await client.query('SELECT id, phone, name, description, package_url, status, reviewer_note, created_at, updated_at FROM developer_submissions ORDER BY created_at DESC LIMIT 200');
          client.release();
          return res.status(200).json({ success: true, submissions: result.rows });
        }
        if (method === 'POST') {
          const id = Number(body.id);
          const status = ['pending', 'approved', 'rejected'].includes(String(body.status)) ? String(body.status) : null;
          if (!Number.isInteger(id) || !status) { client.release(); return res.status(400).json({ error: 'Submission id and valid status are required.' }); }
          const result = await client.query('UPDATE developer_submissions SET status = $1, reviewer_note = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id, status, reviewer_note, updated_at', [status, String(body.reviewerNote || '').slice(0, 1000) || null, id]);
          client.release();
          return res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true, submission: result.rows[0] } : { error: 'Submission not found.' });
        }
        break;
      }

      case 'support': {
        if (method === 'GET') {
          const ticketId = requestUrl.searchParams.get('ticketId') ? Number(requestUrl.searchParams.get('ticketId')) : null;
          const adminTicketRes = ticketId
            ? await client.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId])
            : await client.query('SELECT * FROM support_tickets ORDER BY updated_at DESC, created_at DESC LIMIT 100');
          if (ticketId && adminTicketRes.rows.length === 0) { client.release(); return res.status(404).json({ error: 'Ticket not found' }); }
          if (ticketId) {
            const adminMessageRes = await client.query('SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC', [ticketId]);
            client.release();
            return res.status(200).json({ success: true, ticket: adminTicketRes.rows[0], messages: adminMessageRes.rows });
          }
          client.release();
          return res.status(200).json({ success: true, tickets: adminTicketRes.rows });
        }
        if (method === 'POST') {
          const action = String(body.action || 'reply');
          const ticketId = Number(body.ticketId);
          if (!Number.isInteger(ticketId)) { client.release(); return res.status(400).json({ error: 'Valid ticket ID required' }); }
          if (action === 'status') {
            const nextStatus = ['open', 'pending', 'resolved'].includes(body.status) ? body.status : null;
            if (!nextStatus) { client.release(); return res.status(400).json({ error: 'Invalid status' }); }
            await client.query('UPDATE support_tickets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [nextStatus, ticketId]);
            client.release();
            return res.status(200).json({ success: true });
          }
          const message = String(body.message || '').trim();
          if (!message || message.length > 4000) { client.release(); return res.status(400).json({ error: 'Message is required' }); }
          await client.query('INSERT INTO support_messages (ticket_id, sender_type, sender_name, body) VALUES ($1, $2, $3, $4)', [ticketId, 'admin', 'Admin', message]);
          await client.query("UPDATE support_tickets SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [ticketId]);
          client.release();
          return res.status(200).json({ success: true });
        }
        break;
      }

      case 'giveaways': {
        if (method === 'GET') {
          const result = await client.query(`SELECT g.*, COUNT(e.id)::int AS entries FROM giveaways g LEFT JOIN giveaway_entries e ON e.giveaway_id = g.id GROUP BY g.id ORDER BY g.created_at DESC LIMIT 100`);
          client.release();
          return res.status(200).json({ success: true, giveaways: result.rows });
        }
        if (method === 'POST') {
          const action = String(body.action || 'create');
          if (action === 'cancel') {
            await client.query("UPDATE giveaways SET status = 'cancelled' WHERE id = $1 AND status IN ('scheduled', 'active')", [Number(body.id)]);
            client.release();
            return res.status(200).json({ success: true, message: 'Giveaway cancelled.' });
          }
          if (action === 'draw') {
            const giveawayId = Number(body.id);
            try {
              await client.query('BEGIN');
              const giveawayRes = await client.query("SELECT * FROM giveaways WHERE id = $1 AND status IN ('scheduled', 'active') FOR UPDATE", [giveawayId]);
              if (!giveawayRes.rows[0]) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ error: 'Giveaway not found or already drawn.' }); }
              const winnerRes = await client.query('SELECT phone FROM giveaway_entries WHERE giveaway_id = $1 ORDER BY random() LIMIT 1', [giveawayId]);
              if (!winnerRes.rows[0]) { await client.query("UPDATE giveaways SET status = 'closed', drawn_at = CURRENT_TIMESTAMP WHERE id = $1", [giveawayId]); await client.query('COMMIT'); client.release(); return res.status(200).json({ success: true, message: 'Giveaway closed with no entries.' }); }
              const winnerPhone = winnerRes.rows[0].phone;
              await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2', [giveawayRes.rows[0].prize_sd, winnerPhone]);
              await client.query("UPDATE giveaways SET status = 'drawn', winner_phone = $1, drawn_at = CURRENT_TIMESTAMP WHERE id = $2", [winnerPhone, giveawayId]);
              await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['GIVEAWAY_DRAWN', `Giveaway ${giveawayId} winner: ${winnerPhone}.`]);
              await client.query('COMMIT');
              client.release();
              sendTelegramNotification(`🎉 Giveaway ${giveawayId} drawn. Winner: ${winnerPhone}. Prize: ${giveawayRes.rows[0].prize_sd} SD.`);
              return res.status(200).json({ success: true, winnerPhone, prizeSd: giveawayRes.rows[0].prize_sd });
            } catch (drawError) {
              try { await client.query('ROLLBACK'); } catch (_) {}
              client.release();
              throw drawError;
            }
          }
          const title = String(body.title || '').trim();
          const description = String(body.description || '').trim().slice(0, 500);
          const entryFeeSd = Number(body.entryFeeSD ?? 1);
          const prizeSd = Number(body.prizeSD);
          const drawAt = new Date(body.drawAt);
          if (!title || !Number.isFinite(entryFeeSd) || entryFeeSd < 0 || !Number.isFinite(prizeSd) || prizeSd <= 0 || Number.isNaN(drawAt.getTime()) || drawAt <= new Date()) { client.release(); return res.status(400).json({ error: 'Title, future draw time, valid entry fee, and prize are required.' }); }
          const result = await client.query("INSERT INTO giveaways (title, description, entry_fee_sd, prize_sd, draw_at, status) VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING *", [title, description, entryFeeSd, prizeSd, drawAt.toISOString()]);
          client.release();
          return res.status(201).json({ success: true, giveaway: result.rows[0] });
        }
        break;
      }

      case 'chat': {
        if (method === 'GET') {
          const result = await client.query('SELECT id, phone, username, body, is_admin, is_hidden, created_at FROM chat_messages ORDER BY created_at DESC LIMIT 200');
          client.release();
          return res.status(200).json({ success: true, messages: result.rows });
        }
        if (method === 'POST') {
          const action = String(body.action || 'hide');
          const id = Number(body.id);
          if (action === 'reply') {
            const message = String(body.body || '').trim();
            if (!message || message.length > 500) { client.release(); return res.status(400).json({ error: 'Reply must be 1–500 characters.' }); }
            const result = await client.query("INSERT INTO chat_messages (username, body, is_admin) VALUES ('Admin', $1, TRUE) RETURNING *", [message]);
            client.release();
            return res.status(201).json({ success: true, message: result.rows[0] });
          }
          if (!Number.isInteger(id)) { client.release(); return res.status(400).json({ error: 'Valid message ID required.' }); }
          const hidden = action !== 'unhide';
          await client.query('UPDATE chat_messages SET is_hidden = $1 WHERE id = $2', [hidden, id]);
          client.release();
          return res.status(200).json({ success: true, hidden });
        }
        break;
      }

      case 'status': {
        if (method === 'GET') {
          const adminStatusRes = await client.query('SELECT * FROM bot_status ORDER BY name ASC');
          client.release();
          return res.status(200).json({ success: true, bots: adminStatusRes.rows });
        }
        if (method === 'POST') {
          const slug = String(body.slug || '').trim();
          const nextStatus = ['online', 'offline', 'maintenance'].includes(body.status) ? body.status : null;
          if (!slug || !nextStatus) { client.release(); return res.status(400).json({ error: 'Slug and valid status required' }); }
          await client.query('UPDATE bot_status SET status = $1, uptime = $2, region = $3, last_ping_ms = $4, notes = $5, updated_at = CURRENT_TIMESTAMP, last_ping_at = CASE WHEN $1 = \'online\' THEN CURRENT_TIMESTAMP ELSE last_ping_at END WHERE slug = $6', [nextStatus, Number(body.uptime) || 0, body.region || 'Africa (Nairobi)', body.lastPingMs ? Number(body.lastPingMs) : null, body.notes || null, slug]);
          client.release();
          return res.status(200).json({ success: true });
        }
        break;
      }

      default:
        client.release();
        return res.status(404).json({ error: 'Admin route not found' });
    }

    client.release();
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
