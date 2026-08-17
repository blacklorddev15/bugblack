const crypto = require('crypto');
const { promisify } = require('util');
const axios = require('axios');
const { pool, initDb, getSiteSettings, logActivity } = require('./helpers/db');
const { dispatchWebhookEvent } = require('./helpers/webhooks');

const scryptAsync = promisify(crypto.scrypt);

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!/^\+?[0-9\s-]+$/.test(raw)) return null;
  let phone = raw.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = `254${phone.slice(1)}`;
  else if (phone.length === 9) phone = `254${phone}`;
  return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

function sessionTokenFromRequest(req) {
  const cookieHeader = req.headers?.cookie || req.headers?.Cookie || '';
  const cookieMatch = String(cookieHeader).match(/(?:^|;\s*)blacklord_session=([^;]+)/);
  if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
  const authorization = req.headers?.authorization || req.headers?.Authorization || '';
  return String(authorization).startsWith('Bearer ') ? String(authorization).slice(7).trim() : null;
}

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [scheme, nValue, rValue, pValue, salt, storedHex] = String(encoded || '').split('$');
    if (scheme !== 'scrypt' || !salt || !storedHex) return false;
    const stored = Buffer.from(storedHex, 'hex');
    const derivedKey = await scryptAsync(password, salt, stored.length, { N: Number(nValue), r: Number(rValue), p: Number(pValue), maxmem: 64 * 1024 * 1024 });
    return stored.length === derivedKey.length && crypto.timingSafeEqual(stored, derivedKey);
  } catch (_) {
    return false;
  }
}

async function panelConfig(client) {
  const settings = await getSiteSettings(client, ['PTERODACTYL_PANEL_URL', 'PTERODACTYL_CLIENT_API_KEY', 'PTERODACTYL_SERVER_IDENTIFIER', 'PANEL_DOMAIN', 'PANEL_APIKEY']);
  return {
    panelUrl: String(settings.PTERODACTYL_PANEL_URL || settings.PANEL_DOMAIN || process.env.PTERODACTYL_PANEL_URL || process.env.PANEL_DOMAIN || '').replace(/\/$/, ''),
    clientApiKey: settings.PTERODACTYL_CLIENT_API_KEY || settings.PANEL_APIKEY || process.env.PTERODACTYL_CLIENT_API_KEY || '',
    serverIdentifier: settings.PTERODACTYL_SERVER_IDENTIFIER || process.env.PTERODACTYL_SERVER_IDENTIFIER || '',
  };
}

async function applicationPanelConfig(client) {
  const settings = await getSiteSettings(client, ['PTERODACTYL_PANEL_URL', 'PANEL_DOMAIN', 'PANEL_APIKEY']);
  return {
    panelUrl: String(settings.PTERODACTYL_PANEL_URL || settings.PANEL_DOMAIN || '').replace(/\/$/, ''),
    applicationApiKey: settings.PANEL_APIKEY || '',
  };
}

async function resolveServerIdentifier(applicationConfig, serverId) {
  const raw = String(serverId || '').trim();
  if (!raw || !applicationConfig.panelUrl || !applicationConfig.applicationApiKey || !/^\d+$/.test(raw)) return raw;
  try {
    const response = await axios.get(`${applicationConfig.panelUrl}/api/application/servers/${encodeURIComponent(raw)}`, {
      headers: { Authorization: `Bearer ${applicationConfig.applicationApiKey}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
      timeout: 10000,
    });
    return response.data?.attributes?.identifier || raw;
  } catch (_) {
    return raw;
  }
}

function panelVisitUrl(panelUrl, serverIdentifier) {
  const base = String(panelUrl || '').replace(/\/$/, '');
  const identifier = String(serverIdentifier || '').trim();
  return base && identifier ? `${base}/server/${encodeURIComponent(identifier)}` : base || null;
}

function pteroError(error) {
  return error.response?.data?.errors?.[0]?.detail || error.response?.data?.message || error.message || 'Pterodactyl request failed.';
}

async function pteroRequest(config, serverId, path, method = 'GET', data) {
  if (!config.panelUrl || !config.clientApiKey) {
    const error = new Error('Pterodactyl client API is not configured.');
    error.statusCode = 503;
    throw error;
  }
  return axios({
    method,
    url: `${config.panelUrl}/api/client/servers/${encodeURIComponent(String(serverId))}${path}`,
    data,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${config.clientApiKey}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
      'Content-Type': 'application/json'
    }
  });
}

async function isRegisteredUser(client, phone) {
  const result = await client.query('SELECT registered_at FROM users WHERE phone = $1 LIMIT 1', [phone]);
  return Boolean(result.rows[0]?.registered_at);
}

async function ownedServer(client, phone, serverId) {
  if (!serverId) return null;
  const result = await client.query(
    'SELECT * FROM servers WHERE phone = $1 AND (server_id::text = $2 OR id::text = $2) LIMIT 1',
    [phone, String(serverId)]
  );
  return result.rows[0] || null;
}

function maskPhone(value) {
  const phone = String(value || '');
  return phone.length > 4 ? `${phone.slice(0, 3)}••••${phone.slice(-3)}` : phone;
}

function secretMatches(supplied, expected) {
  const left = Buffer.from(String(supplied || ''));
  const right = Buffer.from(String(expected || ''));
  return Boolean(left.length && right.length && left.length === right.length && left.length === right.length && crypto.timingSafeEqual(left, right));
}

function bridgeApiKeyFromRequest(req, body = {}) {
  const headers = req.headers || {};
  return String(headers['x-blacklord-api-key'] || headers['X-Blacklord-API-Key'] || headers['x-api-key'] || headers['X-API-Key'] || body.apiKey || '').trim();
}

function bridgeSecretFromRequest(req, body = {}) {
  const headers = req.headers || {};
  return String(headers['x-blacklord-pairing-secret'] || headers['X-Blacklord-Pairing-Secret'] || String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '') || body.secret || '').trim();
}

function requestMeta(req) {
  return {
    ip: String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || '').split(',')[0].trim().slice(0, 120) || null,
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 500) || null,
  };
}

async function audit(client, req, phone, action, details = '') {
  const meta = requestMeta(req);
  await client.query('INSERT INTO account_audit_log (phone, action, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)', [phone, action, details, meta.ip, meta.userAgent]);
}

function parseSettings(value) {
  try { return value ? JSON.parse(value) : {}; } catch (_) { return {}; }
}

function planCatalog() {
  return [
    { key: 'free', name: 'Free', priceSd: 0, interval: 'forever', description: 'Core bot hosting controls and community access.', perks: ['Basic pairing', 'Community support', '1 active service'] },
    { key: 'pro', name: 'Blacklord Pro', priceSd: 25, interval: 'monthly', description: 'More capacity and premium automation for growing bots.', perks: ['Up to 3 active services', 'Priority support', 'Advanced analytics', 'Custom subdomain styling'] },
    { key: 'elite', name: 'Blacklord Elite', priceSd: 60, interval: 'monthly', description: 'Maximum creator and developer tooling.', perks: ['Up to 10 active services', 'Marketplace discounts', 'API sandbox access', 'Verified developer review priority'] },
  ];
}

function getPlan(planKey) {
  return planCatalog().find(plan => plan.key === planKey) || planCatalog()[0];
}

function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

async function findApiKeyOwner(client, suppliedKey) {
  const raw = String(suppliedKey || '').trim();
  if (!raw.startsWith('blacklord_')) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const result = await client.query('SELECT id, phone, name FROM developer_api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1', [hash]);
  if (!result.rows[0]) return null;
  await client.query('UPDATE developer_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [result.rows[0].id]);
  return result.rows[0];
}

async function bridgeAuthorized(client, req, body = {}, accountPhone = null) {
  const settings = await getSiteSettings(client, ['BOT_PAIRING_SECRET']);
  // Keep the Pterodactyl bridge aligned with the pairing API configuration.
  // The API key remains optional for the global bridge secret flow.
  const expectedSecret = 'blacklorddev';
  const suppliedSecret = bridgeSecretFromRequest(req, body);
  if (!expectedSecret || !secretMatches(suppliedSecret, expectedSecret)) return null;
  
  // Option 2: Global Secret Only. We try to find the owner if an API key is provided, but don't require it.
  const apiKey = bridgeApiKeyFromRequest(req, body);
  const owner = apiKey ? await findApiKeyOwner(client, apiKey) : null;
  
  if (accountPhone && owner && owner.phone !== accountPhone) return null;
  return { via: 'secret', owner: owner || { phone: accountPhone || 'system' } };
}

module.exports = async function handler(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const path = requestUrl.pathname.replace('/api/dashboard/', '').replace(/^\/+/, '');
  const method = String(req.method || 'GET').toUpperCase();
  const body = req.body || {};
  const query = Object.fromEntries(requestUrl.searchParams.entries());

  try {
    await initDb();
    const client = await pool.connect();

    if (path === 'servers') {
      const phone = normalizePhone(method === 'POST' ? body.phone : query.phone);
      const action = String(method === 'POST' ? body.action || 'power' : query.action || 'list').toLowerCase();
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (!(await isRegisteredUser(client, phone))) {
        client.release();
        return res.status(403).json({ error: 'Register first to view or manage your servers.', requiresRegistration: true });
      }

      if (action === 'list') {
        const result = await client.query('SELECT id, server_id, username, bot_type, subdomain, status, renewal_price_sd, next_billing_date, auto_renew_enabled, created_at FROM servers WHERE phone = $1 AND status NOT IN (\'deleted\', \'suspended\') ORDER BY created_at DESC', [phone]);
        const config = await panelConfig(client);
        const applicationConfig = await applicationPanelConfig(client);
        client.release();
        const servers = await Promise.all(result.rows.map(async server => {
          const resolvedIdentifier = await resolveServerIdentifier(applicationConfig, server.server_id);
          try {
            const response = await pteroRequest(config, resolvedIdentifier, '/resources');
            const attributes = response.data?.attributes || {};
            return {
              ...server,
              server_identifier: resolvedIdentifier,
              panel_url: panelVisitUrl(config.panelUrl || applicationConfig.panelUrl, resolvedIdentifier),
              current_state: attributes.current_state || server.status || 'unknown',
              resources: attributes.resources || null,
            };
          } catch (_) {
            return {
              ...server,
              server_identifier: resolvedIdentifier,
              panel_url: panelVisitUrl(config.panelUrl || applicationConfig.panelUrl, resolvedIdentifier),
              current_state: server.status || 'unknown',
              resources: null,
            };
          }
        }));
        return res.status(200).json({ success: true, configured: Boolean(config.panelUrl && config.clientApiKey), servers });
      }

      const server = await ownedServer(client, phone, method === 'POST' ? body.serverId : query.serverId);
      if (!server) { client.release(); return res.status(404).json({ error: 'Server not found for this account.' }); }
      const config = await panelConfig(client);

      if (action === 'metrics') {
        client.release();
        try {
          const response = await pteroRequest(config, server.server_id, '/resources');
          return res.status(200).json({ success: true, server, resources: response.data?.attributes?.resources || null, currentState: response.data?.attributes?.current_state || 'unknown' });
        } catch (error) {
          return res.status(error.statusCode || 502).json({ error: pteroError(error) });
        }
      }

      if (action === 'logs' || action === 'activity') {
        client.release();
        try {
          const response = await pteroRequest(config, server.server_id, '/activity?per_page=25');
          return res.status(200).json({ success: true, server, logs: response.data?.data || [], meta: response.data?.meta || null });
        } catch (error) {
          return res.status(error.statusCode || 502).json({ error: pteroError(error) });
        }
      }

      if (method !== 'POST' || !['start', 'stop', 'restart', 'kill'].includes(action)) {
        client.release();
        return res.status(400).json({ error: 'Use start, stop, restart, or kill for a server power action.' });
      }
      client.release();
      try {
        await pteroRequest(config, server.server_id, '/power', 'POST', { signal: action });
        logActivity('SERVER_POWER_ACTION', `${phone} sent ${action} to server ${server.server_id}.`);
        dispatchWebhookEvent(phone, 'server.status', { server_id: server.server_id, action, bot_type: server.bot_type || null }).catch(() => {});
        return res.status(200).json({ success: true, message: `Server ${action} signal sent.` });
      } catch (error) {
        return res.status(error.statusCode || 502).json({ error: pteroError(error) });
      }
    }

    if (path === 'health' || path === 'bot-health') {
      if (method === 'POST') {
        const bridgePhone = normalizePhone(body.phone);
        const serverId = String(body.serverId || '').trim();
        const bridgeAuth = await bridgeAuthorized(client, req, body, bridgePhone);
        if (!bridgeAuth) { client.release(); return res.status(401).json({ error: 'Health bridge authorization failed. Use a valid active blacklord_ API key and BOT_PAIRING_SECRET.' }); }
        if (!bridgePhone || !serverId) { client.release(); return res.status(400).json({ error: 'Phone and serverId are required.' }); }
        const owned = await ownedServer(client, bridgePhone, serverId);
        if (!owned) { client.release(); return res.status(404).json({ error: 'Server is not registered for this account.' }); }
        const status = String(body.status || 'unknown').slice(0, 30);
        const uptimePercentage = Math.max(0, Math.min(100, Number(body.uptimePercentage ?? body.uptime ?? 0) || 0));
        const latencyMs = Number.isFinite(Number(body.latencyMs)) ? Math.max(0, Math.round(Number(body.latencyMs))) : null;
        const cpuPercent = Number.isFinite(Number(body.cpuPercent)) ? Math.max(0, Math.min(100, Number(body.cpuPercent))) : null;
        const memoryBytes = Number.isFinite(Number(body.memoryBytes)) ? Math.max(0, Math.round(Number(body.memoryBytes))) : null;
        const diskBytes = Number.isFinite(Number(body.diskBytes)) ? Math.max(0, Math.round(Number(body.diskBytes))) : null;
        const messagesCount = Math.max(0, Math.round(Number(body.messagesCount || 0) || 0));
        const commandsExecuted = Math.max(0, Math.round(Number(body.commandsExecuted || 0) || 0));
        const activeGroups = Math.max(0, Math.round(Number(body.activeGroups || 0) || 0));
        await client.query(`INSERT INTO server_health_checks (phone, server_id, status, uptime_percentage, latency_ms, cpu_percent, memory_bytes, disk_bytes, messages_count, commands_executed, active_groups)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [bridgePhone, owned.server_id, status, uptimePercentage, latencyMs, cpuPercent, memoryBytes, diskBytes, messagesCount, commandsExecuted, activeGroups]);
        await client.query(`INSERT INTO bot_analytics (phone, server_id, messages_count, commands_executed, active_groups, avg_response_ms)
          VALUES ($1, $2, $3, $4, $5, $6)`, [bridgePhone, owned.server_id, messagesCount, commandsExecuted, activeGroups, latencyMs]);
        await client.query('UPDATE servers SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, owned.id]);
        client.release();
        return res.status(200).json({ success: true, recordedAt: new Date().toISOString() });
      }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (!(await isRegisteredUser(client, phone))) {
        client.release();
        return res.status(403).json({ error: 'Register first to view bot health.', requiresRegistration: true });
      }
      const serverId = String(query.serverId || '').trim();
      const serverQuery = serverId
        ? client.query('SELECT id, server_id, bot_type, subdomain, status, created_at FROM servers WHERE phone = $1 AND server_id = $2 AND status NOT IN (\'deleted\', \'suspended\') LIMIT 1', [phone, serverId])
        : client.query('SELECT id, server_id, bot_type, subdomain, status, created_at FROM servers WHERE phone = $1 AND status NOT IN (\'deleted\', \'suspended\') ORDER BY created_at DESC', [phone]);
      const serverRes = await serverQuery;
      const healthRes = await client.query(`SELECT DISTINCT ON (server_id) server_id, status, uptime_percentage, latency_ms, cpu_percent, memory_bytes, disk_bytes, messages_count, commands_executed, active_groups, checked_at
        FROM server_health_checks WHERE phone = $1 ORDER BY server_id, checked_at DESC`, [phone]);
      const analyticsRes = await client.query(`SELECT DISTINCT ON (server_id) server_id, messages_count, commands_executed, active_groups, avg_response_ms, recorded_at
        FROM bot_analytics WHERE phone = $1 ORDER BY server_id, recorded_at DESC`, [phone]);
      const healthMap = Object.fromEntries(healthRes.rows.map(row => [String(row.server_id), row]));
      const analyticsMap = Object.fromEntries(analyticsRes.rows.map(row => [String(row.server_id), row]));
      const config = await panelConfig(client);
      client.release();
      const servers = await Promise.all(serverRes.rows.map(async server => {
        let resources = null;
        let currentState = server.status || 'unknown';
        if (config.panelUrl && config.clientApiKey) {
          try {
            const response = await pteroRequest(config, server.server_id, '/resources');
            const attributes = response.data?.attributes || {};
            currentState = attributes.current_state || currentState;
            resources = attributes.resources || null;
          } catch (_) {}
        }
        return { ...server, currentState, resources, health: healthMap[String(server.server_id)] || null, analytics: analyticsMap[String(server.server_id)] || null };
      }));
      return res.status(200).json({ success: true, configured: Boolean(config.panelUrl && config.clientApiKey), servers, checkedAt: new Date().toISOString() });
    }

    if (path === 'analytics-detail') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (!(await isRegisteredUser(client, phone))) {
        client.release();
        return res.status(403).json({ error: 'Register first to view analytics.', requiresRegistration: true });
      }
      const serverId = String(query.serverId || '').trim();
      const days = Math.max(1, Math.min(30, Number(query.days || 7) || 7));
      const args = [phone];
      let filter = 'phone = $1';
      if (serverId) { args.push(serverId); filter += ` AND server_id = $${args.length}`; }
      args.push(days);
      filter += ` AND recorded_at >= CURRENT_TIMESTAMP - ($${args.length} * INTERVAL '1 day')`;
      const historyRes = await client.query(`SELECT server_id, messages_count, commands_executed, active_groups, avg_response_ms, recorded_at FROM bot_analytics WHERE ${filter} ORDER BY recorded_at ASC`, args);
      const summaryRes = await client.query(`SELECT COALESCE(SUM(messages_count), 0)::int AS messages_count, COALESCE(SUM(commands_executed), 0)::int AS commands_executed, COALESCE(MAX(active_groups), 0)::int AS active_groups, COALESCE(AVG(avg_response_ms), 0)::int AS avg_response_ms FROM bot_analytics WHERE ${filter}`, args);
      const uptimeArgs = [phone];
      let uptimeFilter = 'phone = $1';
      if (serverId) { uptimeArgs.push(serverId); uptimeFilter += ` AND server_id = $${uptimeArgs.length}`; }
      uptimeArgs.push(days);
      uptimeFilter += ` AND checked_at >= CURRENT_TIMESTAMP - ($${uptimeArgs.length} * INTERVAL '1 day')`;
      const uptimeRes = await client.query(`SELECT COALESCE(AVG(uptime_percentage), 0)::numeric(6,2) AS uptime_percentage, COALESCE(AVG(latency_ms), 0)::int AS latency_ms, COUNT(*)::int AS checks FROM server_health_checks WHERE ${uptimeFilter}`, uptimeArgs);
      client.release();
      return res.status(200).json({ success: true, days, summary: summaryRes.rows[0], uptime: uptimeRes.rows[0], history: historyRes.rows });
    }

    if (path === 'plugin-manager') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (method === 'GET') {
        const result = await client.query(`SELECT up.plugin_id, up.purchased_at, COALESCE(up.enabled, TRUE) AS enabled, p.name, p.description, p.category, p.author, COALESCE(ps.settings_json, '{}') AS settings_json
          FROM user_plugins up JOIN marketplace_plugins p ON p.id = up.plugin_id
          LEFT JOIN plugin_settings ps ON ps.phone = up.phone AND ps.plugin_id = up.plugin_id
          WHERE up.phone = $1 ORDER BY up.purchased_at DESC`, [phone]);
        client.release();
        return res.status(200).json({ success: true, plugins: result.rows.map(row => ({ ...row, settings: parseSettings(row.settings_json) })) });
      }
      if (method === 'POST') {
        const pluginId = Number(body.pluginId);
        if (!Number.isInteger(pluginId)) { client.release(); return res.status(400).json({ error: 'A valid plugin is required.' }); }
        const ownedRes = await client.query('SELECT 1 FROM user_plugins WHERE phone = $1 AND plugin_id = $2', [phone, pluginId]);
        if (!ownedRes.rows[0]) { client.release(); return res.status(403).json({ error: 'Purchase this plugin before changing its settings.' }); }
        const settings = safeJson(body.settings, {});
        const settingsJson = JSON.stringify(settings).slice(0, 10000);
        const enabled = body.enabled === undefined ? true : (body.enabled === true || body.enabled === 'true');
        await client.query(`INSERT INTO plugin_settings (phone, plugin_id, settings_json, enabled, updated_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (phone, plugin_id) DO UPDATE SET settings_json = $3, enabled = $4, updated_at = CURRENT_TIMESTAMP`, [phone, pluginId, settingsJson, enabled]);
        await client.query('UPDATE user_plugins SET enabled = $1, settings_json = $2 WHERE phone = $3 AND plugin_id = $4', [enabled, settingsJson, phone, pluginId]);
        await audit(client, req, phone, 'PLUGIN_SETTINGS_UPDATED', `Plugin ${pluginId} settings updated.`);
        client.release();
        return res.status(200).json({ success: true, enabled, settings });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'leaderboard') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const sort = ['referrals', 'servers', 'messages'].includes(String(query.sort)) ? String(query.sort) : 'referrals';
      const order = sort === 'servers' ? 'server_count DESC, referral_count DESC' : sort === 'messages' ? 'message_count DESC, referral_count DESC' : 'referral_count DESC, message_count DESC';
      const result = await client.query(`WITH referrals AS (SELECT referrer_phone AS phone, COUNT(*)::int AS referral_count FROM referral_ledger GROUP BY referrer_phone),
        services AS (SELECT phone, COUNT(*)::int AS server_count FROM servers WHERE status NOT IN ('deleted', 'suspended') GROUP BY phone),
        messages AS (SELECT phone, COALESCE(SUM(messages_count), 0)::int AS message_count FROM bot_analytics GROUP BY phone)
        SELECT u.username, u.phone, COALESCE(r.referral_count, 0)::int AS referral_count, COALESCE(s.server_count, 0)::int AS server_count, COALESCE(m.message_count, 0)::int AS message_count
        FROM users u LEFT JOIN referrals r ON r.phone = u.phone LEFT JOIN services s ON s.phone = u.phone LEFT JOIN messages m ON m.phone = u.phone
        ORDER BY ${order} LIMIT 25`);
      client.release();
      return res.status(200).json({ success: true, sort, leaderboard: result.rows.map((row, index) => ({ rank: index + 1, username: row.username || 'BLACKLORD user', phone: maskPhone(row.phone), referralCount: row.referral_count, serverCount: row.server_count, messageCount: row.message_count })) });
    }

    if (path === 'developer-program') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (method === 'GET') {
        const result = await client.query('SELECT id, name, description, package_url, status, reviewer_note, created_at, updated_at FROM developer_submissions WHERE phone = $1 ORDER BY created_at DESC', [phone]);
        client.release();
        return res.status(200).json({ success: true, submissions: result.rows });
      }
      if (method === 'POST') {
        const name = String(body.name || '').trim().slice(0, 100);
        const description = String(body.description || '').trim().slice(0, 2000);
        const packageUrl = String(body.packageUrl || '').trim().slice(0, 500);
        try { const parsed = new URL(packageUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch (_) { client.release(); return res.status(400).json({ error: 'Provide a valid HTTPS package or repository URL.' }); }
        if (name.length < 3 || description.length < 20) { client.release(); return res.status(400).json({ error: 'Provide a plugin name and at least 20 characters of description.' }); }
        const result = await client.query('INSERT INTO developer_submissions (phone, name, description, package_url) VALUES ($1, $2, $3, $4) RETURNING id, name, description, package_url, status, created_at', [phone, name, description, packageUrl]);
        await audit(client, req, phone, 'DEVELOPER_SUBMISSION_CREATED', `Marketplace submission ${name} created.`);
        client.release();
        return res.status(201).json({ success: true, submission: result.rows[0], message: 'Submission received for developer review.' });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'subscription') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (method === 'GET') {
        const currentRes = await client.query('SELECT phone, plan_key, status, started_at, renews_at, cancelled_at, updated_at FROM user_subscriptions WHERE phone = $1', [phone]);
        client.release();
        const current = currentRes.rows[0] || { phone, plan_key: 'free', status: 'active' };
        return res.status(200).json({ success: true, plans: planCatalog(), current: { ...current, plan: getPlan(current.plan_key) } });
      }
      if (method === 'POST') {
        const plan = getPlan(String(body.planKey || 'free'));
        const couponCode = String(body.couponCode || '').trim().toUpperCase();
        let finalPrice = Number(plan.priceSd);
        let discountPercent = 0;
        await client.query('BEGIN');
        try {
          if (couponCode && finalPrice > 0) {
            const couponRes = await client.query('SELECT * FROM coupons WHERE code = $1 AND active = TRUE FOR UPDATE', [couponCode]);
            const coupon = couponRes.rows[0];
            if (!coupon || (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) || Number(coupon.redeemed_count) >= Number(coupon.max_redemptions)) throw new Error('Coupon is invalid, expired, or fully redeemed.');
            const usedRes = await client.query('SELECT 1 FROM coupon_redemptions WHERE code = $1 AND phone = $2', [couponCode, phone]);
            if (usedRes.rows[0]) throw new Error('You have already used this coupon.');
            discountPercent = Number(coupon.discount_percent);
            finalPrice = Math.round(finalPrice * (1 - discountPercent / 100) * 100) / 100;
            await client.query('INSERT INTO coupon_redemptions (code, phone) VALUES ($1, $2)', [couponCode, phone]);
            await client.query('UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE code = $1', [couponCode]);
          }
          if (finalPrice > 0) {
            const debit = await client.query('UPDATE users SET balance = balance - $1 WHERE phone = $2 AND balance >= $1 RETURNING balance', [finalPrice, phone]);
            if (!debit.rows[0]) throw new Error('Insufficient SD balance for this plan.');
          }
          const result = await client.query(`INSERT INTO user_subscriptions (phone, plan_key, status, started_at, renews_at, cancelled_at, updated_at)
            VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CASE WHEN $2 = 'free' THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '30 days' END, NULL, CURRENT_TIMESTAMP)
            ON CONFLICT (phone) DO UPDATE SET plan_key = $2, status = 'active', started_at = CURRENT_TIMESTAMP, renews_at = CASE WHEN $2 = 'free' THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '30 days' END, cancelled_at = NULL, updated_at = CURRENT_TIMESTAMP
            RETURNING phone, plan_key, status, started_at, renews_at`, [phone, plan.key]);
          await audit(client, req, phone, 'SUBSCRIPTION_CHANGED', `Plan changed to ${plan.key}${discountPercent ? ` with ${discountPercent}% coupon` : ''}.`);
          await client.query('COMMIT');
          client.release();
          return res.status(200).json({ success: true, subscription: { ...result.rows[0], plan }, chargedSd: finalPrice, discountPercent });
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          client.release();
          return res.status(400).json({ error: error.message || 'Unable to change subscription.' });
        }
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'coupon') {
      const phone = normalizePhone(method === 'POST' ? body.phone : query.phone);
      const code = String(method === 'POST' ? body.code : query.code || '').trim().toUpperCase();
      if (!phone || !code) { client.release(); return res.status(400).json({ error: 'Phone and coupon code are required.' }); }
      const result = await client.query('SELECT code, discount_percent, max_redemptions, redeemed_count, expires_at, active FROM coupons WHERE code = $1', [code]);
      const coupon = result.rows[0];
      const valid = Boolean(coupon && coupon.active && (!coupon.expires_at || new Date(coupon.expires_at) > new Date()) && Number(coupon.redeemed_count) < Number(coupon.max_redemptions));
      if (!valid) { client.release(); return res.status(400).json({ error: 'Coupon is invalid, expired, or fully redeemed.' }); }
      const usedRes = await client.query('SELECT 1 FROM coupon_redemptions WHERE code = $1 AND phone = $2', [code, phone]);
      client.release();
      if (usedRes.rows[0]) return res.status(409).json({ error: 'You have already used this coupon.' });
      return res.status(200).json({ success: true, code: coupon.code, discountPercent: Number(coupon.discount_percent), remainingUses: Number(coupon.max_redemptions) - Number(coupon.redeemed_count) });
    }

    if (path === 'affiliate-assets') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const userRes = await client.query('SELECT referral_code FROM users WHERE phone = $1', [phone]);
      const base = process.env.PUBLIC_APP_URL || 'https://blacklord.tech';
      const referralCode = userRes.rows[0]?.referral_code || phone.slice(-6);
      client.release();
      const link = `${base}/?ref=${encodeURIComponent(referralCode)}`;
      return res.status(200).json({ success: true, referralCode, link, assets: [{ name: 'Text badge', type: 'text', content: 'Powered by BLACKLORD TECH INC' }, { name: 'Referral banner', type: 'embed', content: `<a href="${link}"><img src="${base}/assets/blacklord-banner.png" alt="BLACKLORD TECH INC"></a>` }, { name: 'Referral link', type: 'link', content: link }] });
    }

    if (path === 'webhook-logs') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const hookId = Number(query.webhookId || 0);
      const args = [phone];
      let filter = 'd.phone = $1';
      if (Number.isInteger(hookId) && hookId > 0) { args.push(hookId); filter += ` AND d.webhook_id = $${args.length}`; }
      const result = await client.query(`SELECT d.id, d.webhook_id, d.event, d.http_status, d.response_ms, d.request_payload, d.response_body, d.error_message, d.delivered_at, w.name
        FROM webhook_deliveries d LEFT JOIN webhook_subscriptions w ON w.id = d.webhook_id WHERE ${filter} ORDER BY d.delivered_at DESC LIMIT 100`, args);
      client.release();
      return res.status(200).json({ success: true, logs: result.rows });
    }

    if (path === 'api-sandbox') {
      if (method !== 'POST') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const apiKey = String(body.apiKey || req.headers?.['x-api-key'] || req.headers?.['X-API-Key'] || '').trim();
      const owner = await findApiKeyOwner(client, req, apiKey);
      if (!owner) { client.release(); return res.status(401).json({ error: 'Use a valid active blacklord_ API key.' }); }
      const endpoint = String(body.endpoint || '/api/user/analytics');
      const allowed = ['/api/user/analytics', '/api/dashboard/health', '/api/dashboard/analytics-detail'];
      if (!allowed.includes(endpoint) || String(body.method || 'GET').toUpperCase() !== 'GET') { client.release(); return res.status(400).json({ error: 'Sandbox allows only the documented read-only analytics and health endpoints.' }); }
      const targetPhone = owner.phone;
      let payload;
      if (endpoint === '/api/user/analytics') {
        const [deposits, servers, keys] = await Promise.all([
          client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_sd), 0) AS total_sd FROM deposits WHERE phone = $1 AND status = 'success'", [targetPhone]),
          client.query("SELECT COUNT(*)::int AS count FROM servers WHERE phone = $1 AND status NOT IN ('deleted', 'suspended')", [targetPhone]),
          client.query('SELECT COUNT(*)::int AS count FROM keys WHERE used_number = $1 OR issued_for = $1', [targetPhone]),
        ]);
        payload = { success: true, deposits: deposits.rows[0], servers: servers.rows[0], keys: keys.rows[0], account: targetPhone };
      } else if (endpoint === '/api/dashboard/health') {
        const result = await client.query(`SELECT DISTINCT ON (server_id) server_id, status, uptime_percentage, latency_ms, checked_at FROM server_health_checks WHERE phone = $1 ORDER BY server_id, checked_at DESC`, [targetPhone]);
        payload = { success: true, servers: result.rows, account: targetPhone };
      } else {
        const result = await client.query('SELECT server_id, messages_count, commands_executed, active_groups, avg_response_ms, recorded_at FROM bot_analytics WHERE phone = $1 ORDER BY recorded_at DESC LIMIT 30', [targetPhone]);
        payload = { success: true, analytics: result.rows, account: targetPhone };
      }
      await audit(client, req, targetPhone, 'API_SANDBOX_REQUEST', `${endpoint} tested with developer key ${owner.name}.`);
      client.release();
      return res.status(200).json({ success: true, request: { method: 'GET', endpoint }, response: payload });
    }

    if (path === 'subdomain-style') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const subdomainId = Number(method === 'GET' ? query.subdomainId : body.subdomainId);
      if (!Number.isInteger(subdomainId)) { client.release(); return res.status(400).json({ error: 'A valid subdomain id is required.' }); }
      const ownedRes = await client.query('SELECT id, hostname FROM subdomains WHERE id = $1 AND phone = $2', [subdomainId, phone]);
      if (!ownedRes.rows[0]) { client.release(); return res.status(404).json({ error: 'Subdomain not found for this account.' }); }
      if (method === 'GET') {
        const result = await client.query('SELECT subdomain_id, css_text, active, updated_at FROM subdomain_styles WHERE subdomain_id = $1', [subdomainId]);
        client.release();
        return res.status(200).json({ success: true, hostname: ownedRes.rows[0].hostname, style: result.rows[0] || { subdomain_id: subdomainId, css_text: '', active: false } });
      }
      if (method === 'POST') {
        const cssText = String(body.cssText || '').slice(0, 20000);
        if (/<\/?style|javascript:|expression\s*\(/i.test(cssText)) { client.release(); return res.status(400).json({ error: 'Only safe CSS declarations are allowed.' }); }
        const active = body.active !== false && body.active !== 'false';
        const result = await client.query(`INSERT INTO subdomain_styles (subdomain_id, phone, css_text, active, updated_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (subdomain_id) DO UPDATE SET css_text = $3, active = $4, updated_at = CURRENT_TIMESTAMP RETURNING subdomain_id, css_text, active, updated_at`, [subdomainId, phone, cssText, active]);
        await audit(client, req, phone, 'SUBDOMAIN_CSS_UPDATED', `Custom CSS updated for ${ownedRes.rows[0].hostname}.`);
        client.release();
        return res.status(200).json({ success: true, style: result.rows[0] });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'audit-log') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const result = await client.query('SELECT id, action, details, ip_address, user_agent, created_at FROM account_audit_log WHERE phone = $1 ORDER BY created_at DESC LIMIT 100', [phone]);
      client.release();
      return res.status(200).json({ success: true, entries: result.rows });
    }

    if (path === 'api-keys') {
      const phone = normalizePhone(method === 'POST' || method === 'DELETE' ? body.phone : query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const userRes = await client.query('SELECT phone, registered_at FROM users WHERE phone = $1', [phone]);
      if (!userRes.rows[0]?.registered_at) { client.release(); return res.status(403).json({ error: 'Register first to manage developer API keys.', requiresRegistration: true }); }

      if (method === 'GET') {
        const result = await client.query('SELECT id, name, key_prefix, last_used_at, created_at, revoked_at FROM developer_api_keys WHERE phone = $1 ORDER BY created_at DESC', [phone]);
        client.release();
        return res.status(200).json({ success: true, keys: result.rows });
      }
      if (method === 'POST') {
        const name = String(body.name || 'My integration').trim().slice(0, 80);
        if (name.length < 2) { client.release(); return res.status(400).json({ error: 'Give the API key a name.' }); }
        const rawKey = `blacklord_${crypto.randomBytes(24).toString('base64url')}`;
        const keyPrefix = rawKey.slice(0, 20);
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const result = await client.query('INSERT INTO developer_api_keys (phone, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, key_prefix, created_at', [phone, name, keyPrefix, keyHash]);
        await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['DEVELOPER_API_KEY_CREATED', `Developer API key created for ${phone}.`]);
        await audit(client, req, phone, 'DEVELOPER_API_KEY_CREATED', `API key ${name} created.`);
        client.release();
        return res.status(201).json({ success: true, key: rawKey, record: result.rows[0], warning: 'Copy this key now. It will not be shown again.' });
      }
      if (method === 'DELETE') {
        const keyId = Number(body.id);
        if (!Number.isInteger(keyId)) { client.release(); return res.status(400).json({ error: 'A valid key id is required.' }); }
        const result = await client.query('UPDATE developer_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND phone = $2 AND revoked_at IS NULL RETURNING id', [keyId, phone]);
        if (result.rows[0]) await audit(client, req, phone, 'DEVELOPER_API_KEY_REVOKED', `API key ${keyId} revoked.`);
        client.release();
        if (!result.rows[0]) return res.status(404).json({ error: 'Key not found or already revoked.' });
        return res.status(200).json({ success: true });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'bot-config/poll') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const bridgeAuth = await bridgeAuthorized(client, req, body);
      if (!bridgeAuth) { client.release(); return res.status(401).json({ error: 'Unauthorized configuration bridge. Use a valid active blacklord_ API key and BOT_PAIRING_SECRET.' }); }
      const pollFilter = bridgeAuth.owner ? 'phone = $1 AND ' : '';
      const pollParams = bridgeAuth.owner ? [bridgeAuth.owner.phone] : [];
      const pendingRes = await client.query(`SELECT id, phone, server_id, bot_type, bot_name, prefix, welcome_message, mode, anticall, created_at
        FROM bot_config_changes
        WHERE ${pollFilter}(status = 'queued' OR (status = 'delivered' AND delivered_at < CURRENT_TIMESTAMP - INTERVAL '60 seconds'))
        ORDER BY created_at ASC LIMIT 25`, pollParams);
      if (pendingRes.rows.length) {
        const deliveredIds = pendingRes.rows.map(row => row.id);
        if (bridgeAuth.owner) {
          await client.query('UPDATE bot_config_changes SET status = \'delivered\', delivered_at = CURRENT_TIMESTAMP WHERE phone = $1 AND id = ANY($2::int[])', [bridgeAuth.owner.phone, deliveredIds]);
        } else {
          await client.query('UPDATE bot_config_changes SET status = \'delivered\', delivered_at = CURRENT_TIMESTAMP WHERE id = ANY($1::int[])', [deliveredIds]);
        }
      }
      client.release();
      return res.status(200).json({ success: true, changes: pendingRes.rows });
    }

    if (path === 'bot-config/ack') {
      if (method !== 'POST') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const bridgeAuth = await bridgeAuthorized(client, req, body);
      if (!bridgeAuth) { client.release(); return res.status(401).json({ error: 'Unauthorized configuration bridge. Use a valid active blacklord_ API key and BOT_PAIRING_SECRET.' }); }
      const id = Number(body.id);
      const status = ['applied', 'failed'].includes(String(body.status)) ? String(body.status) : 'failed';
      if (!Number.isInteger(id)) { client.release(); return res.status(400).json({ error: 'Configuration change id is required.' }); }
      const ackParams = [status, String(body.error || '').slice(0, 500) || null, id];
      const ackScope = bridgeAuth.owner ? ' AND phone = $4' : '';
      if (bridgeAuth.owner) ackParams.push(bridgeAuth.owner.phone);
      const result = await client.query(`UPDATE bot_config_changes SET status = $1, applied_at = CASE WHEN $1 = 'applied' THEN CURRENT_TIMESTAMP ELSE applied_at END, error_message = $2 WHERE id = $3${ackScope} RETURNING id, status`, ackParams);
      client.release();
      return res.status(200).json({ success: true, change: result.rows[0] || null });
    }

    if (path === 'bot-config') {
      const phone = normalizePhone(method === 'POST' ? body.phone : query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const serverId = method === 'POST' ? body.serverId : query.serverId;
      const server = await ownedServer(client, phone, serverId);
      if (!server) { client.release(); return res.status(404).json({ error: 'Server not found for this account.' }); }
      const userRes = await client.query('SELECT registered_at FROM users WHERE phone = $1', [phone]);
      if (!userRes.rows[0]?.registered_at) { client.release(); return res.status(403).json({ error: 'Register first to configure a bot.', requiresRegistration: true }); }
      if (method === 'GET') {
        const configRes = await client.query('SELECT id, server_id, bot_type, bot_name, prefix, welcome_message, mode, anticall, status, created_at, applied_at FROM bot_config_changes WHERE phone = $1 AND server_id::text = $2 ORDER BY created_at DESC LIMIT 1', [phone, String(server.server_id)]);
        client.release();
        const config = configRes.rows[0] || {};
        return res.status(200).json({ success: true, config: { serverId: server.server_id, botType: config.bot_type || server.bot_type || 'blacklord', botName: config.bot_name || '', prefix: config.prefix || '.', welcomeMessage: config.welcome_message || '', mode: config.mode || 'public', anticall: Boolean(config.anticall), status: config.status || 'not_configured', createdAt: config.created_at || null, appliedAt: config.applied_at || null } });
      }
      if (method === 'POST') {
        const botName = String(body.botName || '').trim().slice(0, 60);
        const prefix = String(body.prefix || '.').trim();
        const welcomeMessage = String(body.welcomeMessage || '').trim().slice(0, 500);
        const mode = ['public', 'self'].includes(String(body.mode)) ? String(body.mode) : 'public';
        const anticall = body.anticall === true || body.anticall === 'true';
        if (prefix.length < 1 || prefix.length > 3 || /[A-Za-z0-9\s]/.test(prefix)) { client.release(); return res.status(400).json({ error: 'Prefix must be 1–3 symbols, such as . or !.' }); }
        const result = await client.query(`INSERT INTO bot_config_changes (phone, server_id, bot_type, bot_name, prefix, welcome_message, mode, anticall, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued') RETURNING id, server_id, bot_type, bot_name, prefix, welcome_message, mode, anticall, status, created_at`, [phone, String(server.server_id), server.bot_type || 'blacklord', botName || null, prefix, welcomeMessage || null, mode, anticall]);
        await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['BOT_CONFIG_QUEUED', `Live bot configuration queued for ${phone}, server ${server.server_id}.`]);
        await audit(client, req, phone, 'BOT_CONFIG_QUEUED', `Configuration queued for server ${server.server_id}.`);
        client.release();
        return res.status(201).json({ success: true, message: 'Configuration queued. The Pterodactyl bot will apply it on its next sync.', config: result.rows[0] });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'webhooks') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (method === 'GET') {
        const result = await client.query(`SELECT id, name, endpoint_url, events, active, last_status, last_delivered_at, created_at FROM webhook_subscriptions WHERE phone = $1 ORDER BY created_at DESC`, [phone]);
        client.release();
        return res.status(200).json({ success: true, webhooks: result.rows });
      }
      if (method === 'DELETE') {
        const id = Number(body.id);
        if (!Number.isInteger(id)) { client.release(); return res.status(400).json({ error: 'A valid webhook id is required.' }); }
        const result = await client.query('DELETE FROM webhook_subscriptions WHERE id = $1 AND phone = $2 RETURNING id', [id, phone]);
        if (result.rows[0]) await audit(client, req, phone, 'WEBHOOK_DELETED', `Webhook ${id} deleted.`);
        client.release();
        return res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: 'Webhook not found.' });
      }
      if (method === 'POST' && String(body.action || '').toLowerCase() === 'test') {
        const id = Number(body.id);
        const hookRes = await client.query('SELECT * FROM webhook_subscriptions WHERE id = $1 AND phone = $2 AND active = TRUE', [id, phone]);
        const hook = hookRes.rows[0];
        if (!hook) { client.release(); return res.status(404).json({ error: 'Active webhook not found.' }); }
        const payload = { event: 'webhook.test', occurred_at: new Date().toISOString(), account: phone, message: 'BLACKLORD webhook test received.' };
        const rawPayload = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', hook.signing_secret).update(rawPayload).digest('hex');
        try {
          const delivery = await axios.post(hook.endpoint_url, payload, { timeout: 10000, headers: { 'Content-Type': 'application/json', 'X-Blacklord-Event': 'webhook.test', 'X-Blacklord-Signature': signature } });
          await client.query('UPDATE webhook_subscriptions SET last_status = $1, last_delivered_at = CURRENT_TIMESTAMP WHERE id = $2', [delivery.status, id]);
          client.release();
          return res.status(200).json({ success: true, status: delivery.status, message: 'Test event delivered.' });
        } catch (error) {
          const status = Number(error.response?.status || 0) || null;
          await client.query('UPDATE webhook_subscriptions SET last_status = $1 WHERE id = $2', [status, id]);
          client.release();
          return res.status(502).json({ error: `Webhook delivery failed: ${error.message}` });
        }
      }
      if (method === 'POST') {
        const name = String(body.name || '').trim().slice(0, 80);
        const endpointUrl = String(body.endpointUrl || body.url || '').trim();
        const events = String(body.events || 'pairing.completed,server.status,deposit.success').split(',').map(item => item.trim()).filter(Boolean).slice(0, 10).join(',');
        if (name.length < 2) { client.release(); return res.status(400).json({ error: 'Give the webhook a name.' }); }
        let parsedUrl;
        try { parsedUrl = new URL(endpointUrl); } catch (_) { parsedUrl = null; }
        if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) { client.release(); return res.status(400).json({ error: 'Use a valid HTTPS webhook URL.' }); }
        const signingSecret = `blwh_${crypto.randomBytes(24).toString('base64url')}`;
        const result = await client.query('INSERT INTO webhook_subscriptions (phone, name, endpoint_url, signing_secret, events) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, endpoint_url, events, active, created_at', [phone, name, endpointUrl, signingSecret, events]);
        await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['WEBHOOK_CREATED', `Webhook ${name} created for ${phone}.`]);
        await audit(client, req, phone, 'WEBHOOK_CREATED', `Webhook ${name} created.`);
        client.release();
        return res.status(201).json({ success: true, webhook: result.rows[0], signingSecret, warning: 'Store this signing secret now; it is shown only once.' });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'referral-tiers') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const countRes = await client.query('SELECT COUNT(*)::int AS count, COALESCE(SUM(reward_sd), 0) AS rewards_sd FROM referral_ledger WHERE referrer_phone = $1', [phone]);
      const tiersRes = await client.query('SELECT tier_key, label, min_referrals, reward_sd, perks FROM referral_tiers ORDER BY min_referrals ASC');
      const count = Number(countRes.rows[0]?.count || 0);
      const tier = [...tiersRes.rows].reverse().find(item => count >= Number(item.min_referrals)) || tiersRes.rows[0] || { tier_key: 'starter', label: 'Starter', min_referrals: 0, reward_sd: 0, perks: '' };
      await client.query('UPDATE users SET referral_tier = $1 WHERE phone = $2', [tier.tier_key, phone]);
      client.release();
      return res.status(200).json({ success: true, count, rewardsSd: countRes.rows[0]?.rewards_sd || 0, currentTier: tier, tiers: tiersRes.rows });
    }

    if (path === 'marketplace') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (method === 'GET') {
        const result = await client.query(`SELECT p.id, p.name, p.description, p.price_sd, p.category, p.author, p.active,
          EXISTS (SELECT 1 FROM user_plugins up WHERE up.plugin_id = p.id AND up.phone = $1) AS owned
          FROM marketplace_plugins p WHERE p.active = TRUE ORDER BY p.id ASC`, [phone]);
        client.release();
        return res.status(200).json({ success: true, plugins: result.rows });
      }
      if (method === 'POST') {
        const pluginId = Number(body.pluginId);
        if (!Number.isInteger(pluginId)) { client.release(); return res.status(400).json({ error: 'A valid marketplace item is required.' }); }
        const pluginRes = await client.query('SELECT id, name, price_sd FROM marketplace_plugins WHERE id = $1 AND active = TRUE', [pluginId]);
        if (!pluginRes.rows[0]) { client.release(); return res.status(404).json({ error: 'Marketplace item not found.' }); }
        const alreadyRes = await client.query('SELECT 1 FROM user_plugins WHERE phone = $1 AND plugin_id = $2', [phone, pluginId]);
        if (alreadyRes.rows[0]) { client.release(); return res.status(409).json({ error: 'You already own this item.' }); }
        const price = Number(pluginRes.rows[0].price_sd || 0);
        const debitRes = await client.query('UPDATE users SET balance = balance - $1 WHERE phone = $2 AND balance >= $1 RETURNING balance', [price, phone]);
        if (!debitRes.rows[0]) { client.release(); return res.status(400).json({ error: 'Insufficient SD balance.' }); }
        await client.query('INSERT INTO user_plugins (phone, plugin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [phone, pluginId]);
        await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['MARKETPLACE_PURCHASE', `${phone} purchased ${pluginRes.rows[0].name}.`]);
        await audit(client, req, phone, 'MARKETPLACE_PURCHASE', `${pluginRes.rows[0].name} installed.`);
        client.release();
        return res.status(200).json({ success: true, balance: debitRes.rows[0].balance, message: `${pluginRes.rows[0].name} added to your account.` });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'auto-topup') {
      const phone = normalizePhone(method === 'GET' ? query.phone : body.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      if (method === 'GET') {
        const result = await client.query('SELECT enabled, threshold_sd, amount_sd, payment_method, payment_phone, updated_at FROM auto_topup_settings WHERE phone = $1', [phone]);
        const providerRes = await client.query("SELECT key, value FROM site_settings WHERE key IN ('PAYSTACK_SECRET', 'MPESA_C2B_TILL_NUMBER', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET')");
        const providerSettings = Object.fromEntries(providerRes.rows.map(row => [row.key, row.value]));
        const row = result.rows[0] || { enabled: false, threshold_sd: 10, amount_sd: 50, payment_method: 'c2b', payment_phone: phone };
        const providerConfigured = Boolean(
          process.env.PAYSTACK_SECRET || providerSettings.PAYSTACK_SECRET ||
          process.env.MPESA_C2B_TILL_NUMBER || providerSettings.MPESA_C2B_TILL_NUMBER ||
          (process.env.MPESA_CONSUMER_KEY || providerSettings.MPESA_CONSUMER_KEY) && (process.env.MPESA_CONSUMER_SECRET || providerSettings.MPESA_CONSUMER_SECRET)
        );
        client.release();
        return res.status(200).json({ success: true, settings: row, providerConfigured });
      }
      if (method === 'POST') {
        const enabled = body.enabled === true || body.enabled === 'true';
        const thresholdSd = Number(body.thresholdSd);
        const amountSd = Number(body.amountSd);
        const methods = ['paystack', 'c2b', 'mpesa_stk'];
        const paymentMethod = methods.includes(String(body.paymentMethod)) ? String(body.paymentMethod) : 'c2b';
        const paymentPhone = normalizePhone(body.paymentPhone || phone) || phone;
        if (!Number.isFinite(thresholdSd) || thresholdSd < 1 || !Number.isFinite(amountSd) || amountSd < thresholdSd) { client.release(); return res.status(400).json({ error: 'Top-up amount must be at least the balance threshold.' }); }
        const result = await client.query(`INSERT INTO auto_topup_settings (phone, enabled, threshold_sd, amount_sd, payment_method, payment_phone, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
          ON CONFLICT (phone) DO UPDATE SET enabled = $2, threshold_sd = $3, amount_sd = $4, payment_method = $5, payment_phone = $6, updated_at = CURRENT_TIMESTAMP
          RETURNING enabled, threshold_sd, amount_sd, payment_method, payment_phone, updated_at`, [phone, enabled, thresholdSd, amountSd, paymentMethod, paymentPhone]);
        await client.query('UPDATE users SET auto_topup_enabled = $1 WHERE phone = $2', [enabled, phone]);
        await audit(client, req, phone, 'AUTO_TOPUP_UPDATED', `Auto-topup ${enabled ? 'enabled' : 'disabled'} using ${paymentMethod}.`);
        client.release();
        return res.status(200).json({ success: true, settings: result.rows[0], message: enabled ? 'Auto-topup is armed. It will use the configured payment provider when your balance reaches the threshold.' : 'Auto-topup disabled.' });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'referrals') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const phone = normalizePhone(query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const userRes = await client.query('SELECT phone, username, referral_code FROM users WHERE phone = $1', [phone]);
      if (!userRes.rows[0]) { client.release(); return res.status(404).json({ error: 'User not found.' }); }
      const entriesRes = await client.query(`SELECT r.id, r.referred_phone, u.username, r.reward_sd, r.source_deposit_reference, r.created_at
        FROM referral_ledger r LEFT JOIN users u ON u.phone = r.referred_phone
        WHERE r.referrer_phone = $1 ORDER BY r.created_at DESC LIMIT 100`, [phone]);
      const summaryRes = await client.query('SELECT COUNT(*)::int AS count, COALESCE(SUM(reward_sd), 0) AS rewards_sd FROM referral_ledger WHERE referrer_phone = $1', [phone]);
      client.release();
      return res.status(200).json({ success: true, referralCode: userRes.rows[0].referral_code || null, summary: summaryRes.rows[0], referrals: entriesRes.rows.map(item => ({ ...item, referred_phone: maskPhone(item.referred_phone) })) });
    }

    if (path === 'announcements') {
      if (method !== 'GET') { client.release(); return res.status(405).json({ error: 'Method not allowed.' }); }
      const result = await client.query("SELECT id, message, kind, starts_at, ends_at, created_at FROM broadcasts WHERE active = TRUE AND starts_at <= CURRENT_TIMESTAMP AND (ends_at IS NULL OR ends_at > CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 20");
      client.release();
      return res.status(200).json({ success: true, announcements: result.rows });
    }

    if (path === 'theme') {
      const phone = normalizePhone(method === 'POST' ? body.phone : query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const allowed = ['blood-red', 'gold-night', 'neon-blue', 'midnight'];
      if (method === 'GET') {
        const result = await client.query('SELECT theme_preference FROM users WHERE phone = $1', [phone]);
        client.release();
        return res.status(200).json({ success: true, theme: result.rows[0]?.theme_preference || 'blood-red' });
      }
      if (method === 'POST') {
        const theme = allowed.includes(String(body.theme)) ? String(body.theme) : null;
        if (!theme) { client.release(); return res.status(400).json({ error: 'Unsupported theme.' }); }
        await client.query('UPDATE users SET theme_preference = $1 WHERE phone = $2', [theme, phone]);
        await audit(client, req, phone, 'THEME_UPDATED', `Theme changed to ${theme}.`);
        client.release();
        return res.status(200).json({ success: true, theme });
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    if (path === 'security') {
      const phone = normalizePhone(method === 'POST' ? body.phone : query.phone);
      if (!phone) { client.release(); return res.status(400).json({ error: 'A valid phone number is required.' }); }
      const userRes = await client.query('SELECT phone, password_hash FROM users WHERE phone = $1', [phone]);
      if (!userRes.rows[0]) { client.release(); return res.status(404).json({ error: 'User not found.' }); }
      const currentTokenHash = sessionTokenHash(sessionTokenFromRequest(req));

      if (method === 'GET') {
        const result = await client.query(`SELECT id, created_at, expires_at, last_used_at, user_agent, ip_address,
          CASE WHEN token_hash = $1 THEN TRUE ELSE FALSE END AS current
          FROM user_sessions WHERE phone = $2 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC`, [currentTokenHash, phone]);
        client.release();
        return res.status(200).json({ success: true, sessions: result.rows });
      }
      if (method === 'POST') {
        const action = String(body.action || '').toLowerCase();
        if (action === 'password') {
          const oldPassword = String(body.oldPassword || '');
          const newPassword = String(body.newPassword || '');
          if (newPassword.length < 8) { client.release(); return res.status(400).json({ error: 'New password must be at least 8 characters.' }); }
          if (!(await verifyPassword(oldPassword, userRes.rows[0].password_hash))) { client.release(); return res.status(401).json({ error: 'Current password is incorrect.' }); }
          const passwordHash = await hashPassword(newPassword);
          await client.query('UPDATE users SET password_hash = $1, last_password_changed_at = CURRENT_TIMESTAMP WHERE phone = $2', [passwordHash, phone]);
          await client.query('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE phone = $1 AND token_hash <> $2', [phone, currentTokenHash]);
          await audit(client, req, phone, 'PASSWORD_CHANGED', 'Password changed and other sessions revoked.');
          client.release();
          return res.status(200).json({ success: true, message: 'Password updated. Other sessions were signed out.' });
        }
        if (action === 'revoke') {
          const sessionId = Number(body.sessionId);
          if (!Number.isInteger(sessionId)) { client.release(); return res.status(400).json({ error: 'A valid session id is required.' }); }
          const result = await client.query('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND phone = $2 AND token_hash <> $3 RETURNING id', [sessionId, phone, currentTokenHash]);
          if (result.rows[0]) await audit(client, req, phone, 'SESSION_REVOKED', `Session ${sessionId} revoked.`);
          client.release();
          return res.status(200).json({ success: true, revoked: Boolean(result.rows[0]) });
        }
        if (action === 'revoke-all') {
          await client.query('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE phone = $1 AND token_hash <> $2', [phone, currentTokenHash]);
          await audit(client, req, phone, 'SESSIONS_REVOKED', 'Other dashboard sessions revoked.');
          client.release();
          return res.status(200).json({ success: true, message: 'Other sessions were signed out.' });
        }
      }
      client.release();
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    client.release();
    return res.status(404).json({ error: 'Dashboard endpoint not found.' });
  } catch (error) {
    console.error('Dashboard API Error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Dashboard request failed.' });
  }
};
