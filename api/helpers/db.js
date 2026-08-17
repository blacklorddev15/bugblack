const { Pool } = require('pg');

let pool;
const dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
  pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.warn('DATABASE_URL is not set. Database operations will fail.');
}

async function initDb() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    // Basic setup
    await client.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        username TEXT,
        balance NUMERIC DEFAULT 0,
        referred_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS referral_ledger (
        id SERIAL PRIMARY KEY,
        referrer_phone TEXT NOT NULL,
        referred_phone TEXT NOT NULL UNIQUE,
        source_deposit_reference TEXT,
        reward_sd NUMERIC NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS developer_api_keys (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bot_config_changes (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        server_id TEXT NOT NULL,
        bot_type TEXT DEFAULT 'blacklord',
        bot_name TEXT,
        prefix TEXT DEFAULT '.',
        welcome_message TEXT,
        mode TEXT DEFAULT 'public',
        status TEXT DEFAULT 'queued',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        applied_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        username TEXT,
        subject TEXT NOT NULL,
        category TEXT DEFAULT 'General',
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS support_messages (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        sender_type TEXT NOT NULL,
        sender_name TEXT,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS servers (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        server_id TEXT NOT NULL,
        username TEXT,
        bot_type TEXT,
        subdomain TEXT,
        status TEXT DEFAULT 'active',
        renewal_price_sd NUMERIC DEFAULT 0,
        is_trial BOOLEAN DEFAULT FALSE,
        trial_expires_at TIMESTAMP,
        next_billing_date TIMESTAMP,
        auto_renew_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pairing_requests (
        id SERIAL PRIMARY KEY,
        request_id TEXT UNIQUE NOT NULL,
        phone TEXT,
        whatsapp_phone TEXT NOT NULL,
        server_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        pairing_code TEXT,
        pairing_expires_at TIMESTAMP,
        bot_session_id TEXT,
        bot_type TEXT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        action TEXT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        reference TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        amount_sd NUMERIC NOT NULL DEFAULT 0,
        amount_ksh NUMERIC NOT NULL DEFAULT 0,
        checkout_request_id TEXT,
        transaction_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        username TEXT,
        gateway TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS vouchers (
        code TEXT PRIMARY KEY,
        amount NUMERIC NOT NULL CHECK (amount > 0),
        is_used BOOLEAN NOT NULL DEFAULT FALSE,
        used_by TEXT,
        used_at TIMESTAMP,
        expires_at TIMESTAMP,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        used_number TEXT,
        used_by TEXT,
        used_at TIMESTAMP,
        expires_at TIMESTAMP,
        issued_for TEXT DEFAULT 'telegram',
        telegram_user TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS subdomains (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        label TEXT NOT NULL,
        hostname TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        cloudflare_record_id TEXT,
        price_sd NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS broadcasts (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'info',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        starts_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ends_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS referral_tiers (
        id SERIAL PRIMARY KEY,
        tier_key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        min_referrals INTEGER NOT NULL DEFAULT 0,
        reward_sd NUMERIC NOT NULL DEFAULT 0,
        perks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        signing_secret TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT 'pairing.completed,server.status,deposit.success',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_status INTEGER,
        last_delivered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS marketplace_plugins (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price_sd NUMERIC NOT NULL DEFAULT 0,
        category TEXT DEFAULT 'Bot Tools',
        author TEXT DEFAULT 'BLACKLORD TECH INC',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_plugins (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        plugin_id INTEGER NOT NULL REFERENCES marketplace_plugins(id) ON DELETE CASCADE,
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        settings_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(phone, plugin_id)
      );
      CREATE TABLE IF NOT EXISTS auto_topup_settings (
        phone TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        threshold_sd NUMERIC NOT NULL DEFAULT 10,
        amount_sd NUMERIC NOT NULL DEFAULT 50,
        payment_method TEXT NOT NULL DEFAULT 'c2b',
        payment_phone TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bot_status (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'WhatsApp Bot',
        status TEXT NOT NULL DEFAULT 'offline',
        uptime NUMERIC DEFAULT 0,
        region TEXT DEFAULT 'Africa (Nairobi)',
        last_ping_ms INTEGER,
        last_ping_at TIMESTAMP,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bot_analytics (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        server_id TEXT,
        messages_count INTEGER NOT NULL DEFAULT 0,
        commands_executed INTEGER NOT NULL DEFAULT 0,
        active_groups INTEGER NOT NULL DEFAULT 0,
        avg_response_ms INTEGER,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS server_health_checks (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        server_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        uptime_percentage NUMERIC DEFAULT 0,
        latency_ms INTEGER,
        cpu_percent NUMERIC,
        memory_bytes BIGINT,
        disk_bytes BIGINT,
        messages_count INTEGER DEFAULT 0,
        commands_executed INTEGER DEFAULT 0,
        active_groups INTEGER DEFAULT 0,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id SERIAL PRIMARY KEY,
        webhook_id INTEGER,
        phone TEXT NOT NULL,
        event TEXT NOT NULL,
        http_status INTEGER,
        response_ms INTEGER,
        request_payload TEXT,
        response_body TEXT,
        error_message TEXT,
        delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plugin_settings (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        plugin_id INTEGER NOT NULL REFERENCES marketplace_plugins(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone, plugin_id)
      );
      CREATE TABLE IF NOT EXISTS developer_submissions (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        package_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewer_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        phone TEXT PRIMARY KEY,
        plan_key TEXT NOT NULL DEFAULT 'free',
        status TEXT NOT NULL DEFAULT 'active',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        renews_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS coupons (
        code TEXT PRIMARY KEY,
        discount_percent NUMERIC NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
        max_redemptions INTEGER NOT NULL DEFAULT 1,
        redeemed_count INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMP,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS coupon_redemptions (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(code, phone)
      );
      CREATE TABLE IF NOT EXISTS subdomain_styles (
        id SERIAL PRIMARY KEY,
        subdomain_id INTEGER UNIQUE NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        css_text TEXT NOT NULL DEFAULT '',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS account_audit_log (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        email TEXT PRIMARY KEY,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        source TEXT DEFAULT 'landing_page',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_bot_analytics_phone_recorded ON bot_analytics(phone, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_server_health_phone_checked ON server_health_checks(phone, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_phone_delivered ON webhook_deliveries(phone, delivered_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_phone_created ON account_audit_log(phone, created_at DESC);
    `);
    // Add columns one by one to avoid total failure if one exists
    const columns = [
      ['users', 'firstname', 'TEXT'],
      ['users', 'lastname', 'TEXT'],
      ['users', 'email', 'TEXT'],
      ['users', 'password_hash', 'TEXT'],
      ['users', 'last_login_at', 'TIMESTAMP'],
      ['users', 'registered_at', 'TIMESTAMP'],
      ['users', 'total_topup_sd', 'NUMERIC DEFAULT 0'],
      ['users', 'auto_renew_enabled', 'BOOLEAN DEFAULT FALSE'],
      ['users', 'reseller_bonus_percent', 'NUMERIC DEFAULT 0'],
      ['users', 'referral_code', 'TEXT'],
      ['users', 'reseller_tier', "TEXT DEFAULT 'standard'"],
      ['users', 'theme_preference', "TEXT DEFAULT 'blood-red'"],
      ['users', 'last_password_changed_at', 'TIMESTAMP'],
      ['newsletter_subscribers', 'active', 'BOOLEAN DEFAULT TRUE'],
      ['newsletter_subscribers', 'source', "TEXT DEFAULT 'landing_page'"],
      ['newsletter_subscribers', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['developer_api_keys', 'phone', 'TEXT'],
      ['developer_api_keys', 'name', 'TEXT'],
      ['developer_api_keys', 'key_prefix', 'TEXT'],
      ['developer_api_keys', 'key_hash', 'TEXT'],
      ['developer_api_keys', 'last_used_at', 'TIMESTAMP'],
      ['developer_api_keys', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['developer_api_keys', 'revoked_at', 'TIMESTAMP'],
      ['user_plugins', 'enabled', 'BOOLEAN DEFAULT TRUE'],
      ['user_plugins', 'settings_json', "TEXT DEFAULT '{}'"],
      ['auto_topup_settings', 'payment_method', "TEXT DEFAULT 'c2b'"],
      ['referral_ledger', 'referrer_phone', 'TEXT'],
      ['referral_ledger', 'referred_phone', 'TEXT'],
      ['referral_ledger', 'source_deposit_reference', 'TEXT'],
      ['referral_ledger', 'reward_sd', 'NUMERIC DEFAULT 0'],
      ['referral_ledger', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['deposits', 'reference', 'TEXT'],
      ['deposits', 'phone', 'TEXT'],
      ['deposits', 'amount_sd', 'NUMERIC DEFAULT 0'],
      ['deposits', 'amount_ksh', 'NUMERIC DEFAULT 0'],
      ['deposits', 'checkout_request_id', 'TEXT'],
      ['deposits', 'transaction_id', 'TEXT'],
      ['deposits', 'status', "TEXT DEFAULT 'pending'"],
      ['deposits', 'username', 'TEXT'],
      ['deposits', 'gateway', 'TEXT'],
      ['deposits', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['bot_config_changes', 'phone', 'TEXT'],
      ['bot_config_changes', 'server_id', 'TEXT'],
      ['bot_config_changes', 'bot_type', "TEXT DEFAULT 'blacklord'"],
      ['bot_config_changes', 'bot_name', 'TEXT'],
      ['bot_config_changes', 'prefix', "TEXT DEFAULT '.'"],
      ['bot_config_changes', 'welcome_message', 'TEXT'],
      ['bot_config_changes', 'mode', "TEXT DEFAULT 'public'"],
      ['bot_config_changes', 'status', "TEXT DEFAULT 'queued'"],
      ['bot_config_changes', 'error_message', 'TEXT'],
      ['bot_config_changes', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['bot_config_changes', 'delivered_at', 'TIMESTAMP'],
      ['bot_config_changes', 'applied_at', 'TIMESTAMP'],
      ['bot_config_changes', 'anticall', 'BOOLEAN DEFAULT FALSE'],
      ['support_tickets', 'phone', 'TEXT'],
      ['support_tickets', 'username', 'TEXT'],
      ['support_tickets', 'subject', 'TEXT'],
      ['support_tickets', 'category', 'TEXT DEFAULT \'General\''],
      ['support_tickets', 'priority', "TEXT DEFAULT 'normal'"],
      ['support_tickets', 'status', "TEXT DEFAULT 'open'"],
      ['support_tickets', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['support_tickets', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['support_messages', 'ticket_id', 'INTEGER'],
      ['support_messages', 'sender_type', 'TEXT'],
      ['support_messages', 'sender_name', 'TEXT'],
      ['support_messages', 'body', 'TEXT'],
      ['support_messages', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['servers', 'phone', 'TEXT'],
      ['servers', 'server_id', 'TEXT'],
      ['servers', 'username', 'TEXT'],
      ['servers', 'bot_type', 'TEXT'],
      ['servers', 'subdomain', 'TEXT'],
      ['servers', 'status', "TEXT DEFAULT 'active'"],
      ['servers', 'renewal_price_sd', 'NUMERIC DEFAULT 0'],
      ['servers', 'is_trial', 'BOOLEAN DEFAULT FALSE'],
      ['servers', 'trial_expires_at', 'TIMESTAMP'],
      ['servers', 'next_billing_date', 'TIMESTAMP'],
      ['servers', 'auto_renew_enabled', 'BOOLEAN DEFAULT FALSE'],
      ['servers', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['servers', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['pairing_requests', 'bot_type', 'TEXT'],
      ['vouchers', 'amount', 'NUMERIC'],
      ['vouchers', 'is_used', 'BOOLEAN DEFAULT FALSE'],
      ['vouchers', 'used_by', 'TEXT'],
      ['vouchers', 'used_at', 'TIMESTAMP'],
      ['vouchers', 'expires_at', 'TIMESTAMP'],
      ['vouchers', 'created_by', 'TEXT'],
      ['vouchers', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['keys', 'type', 'TEXT'],
      ['keys', 'used_number', 'TEXT'],
      ['keys', 'used_by', 'TEXT'],
      ['keys', 'used_at', 'TIMESTAMP'],
      ['keys', 'expires_at', 'TIMESTAMP'],
      ['keys', 'issued_for', "TEXT DEFAULT 'telegram'"],
      ['keys', 'telegram_user', 'TEXT'],
      ['keys', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['subdomains', 'phone', 'TEXT'],
      ['subdomains', 'label', 'TEXT'],
      ['subdomains', 'hostname', 'TEXT'],
      ['subdomains', 'target', 'TEXT'],
      ['subdomains', 'cloudflare_record_id', 'TEXT'],
      ['subdomains', 'price_sd', 'NUMERIC DEFAULT 0'],
      ['subdomains', 'status', "TEXT DEFAULT 'active'"],
      ['subdomains', 'expires_at', 'TIMESTAMP'],
      ['subdomains', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['subdomains', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['users', 'referral_tier', "TEXT DEFAULT 'starter'"],
      ['users', 'auto_topup_enabled', 'BOOLEAN DEFAULT FALSE'],
      ['broadcasts', 'message', 'TEXT'],
      ['broadcasts', 'kind', "TEXT DEFAULT 'info'"],
      ['broadcasts', 'active', 'BOOLEAN DEFAULT TRUE'],
      ['broadcasts', 'starts_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['broadcasts', 'ends_at', 'TIMESTAMP'],
      ['broadcasts', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['referral_tiers', 'tier_key', 'TEXT'],
      ['referral_tiers', 'label', 'TEXT'],
      ['referral_tiers', 'min_referrals', 'INTEGER DEFAULT 0'],
      ['referral_tiers', 'reward_sd', 'NUMERIC DEFAULT 0'],
      ['referral_tiers', 'perks', 'TEXT'],
      ['webhook_subscriptions', 'phone', 'TEXT'],
      ['webhook_subscriptions', 'name', 'TEXT'],
      ['webhook_subscriptions', 'endpoint_url', 'TEXT'],
      ['webhook_subscriptions', 'signing_secret', 'TEXT'],
      ['webhook_subscriptions', 'events', "TEXT DEFAULT 'pairing.completed,server.status,deposit.success'"],
      ['webhook_subscriptions', 'active', 'BOOLEAN DEFAULT TRUE'],
      ['webhook_subscriptions', 'last_status', 'INTEGER'],
      ['webhook_subscriptions', 'last_delivered_at', 'TIMESTAMP'],
      ['webhook_subscriptions', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['webhook_subscriptions', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['marketplace_plugins', 'name', 'TEXT'],
      ['marketplace_plugins', 'description', 'TEXT'],
      ['marketplace_plugins', 'price_sd', 'NUMERIC DEFAULT 0'],
      ['marketplace_plugins', 'category', "TEXT DEFAULT 'Bot Tools'"],
      ['marketplace_plugins', 'author', "TEXT DEFAULT 'BLACKLORD TECH INC'"],
      ['marketplace_plugins', 'active', 'BOOLEAN DEFAULT TRUE'],
      ['marketplace_plugins', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['user_plugins', 'phone', 'TEXT'],
      ['user_plugins', 'plugin_id', 'INTEGER'],
      ['user_plugins', 'purchased_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['user_plugins', 'settings_json', "TEXT DEFAULT '{}'"],
      ['user_plugins', 'enabled', 'BOOLEAN DEFAULT TRUE'],
      ['auto_topup_settings', 'phone', 'TEXT'],
      ['auto_topup_settings', 'enabled', 'BOOLEAN DEFAULT FALSE'],
      ['auto_topup_settings', 'threshold_sd', 'NUMERIC DEFAULT 10'],
      ['auto_topup_settings', 'amount_sd', 'NUMERIC DEFAULT 50'],
      ['auto_topup_settings', 'payment_method', "TEXT DEFAULT 'c2b'"],
      ['auto_topup_settings', 'payment_phone', 'TEXT'],
      ['auto_topup_settings', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
      ['auto_topup_settings', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP']
    ];
    for (const [table, col, type] of columns) {
      try {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`);
      } catch (e) {
        // Ignore errors for existing columns
      }
    }
    try {
      await client.query("UPDATE auto_topup_settings SET payment_method = 'c2b' WHERE payment_method IN ('blacklord_paybill', 'bank', 'courtney', 'pesapal') OR payment_method IS NULL");
    } catch (e) {
      console.warn('Auto-topup payment method migration skipped:', e.message);
    }
    await client.query(`
      INSERT INTO referral_tiers (tier_key, label, min_referrals, reward_sd, perks)
      SELECT 'starter', 'Starter', 0, 1, 'Basic referral rewards'
      WHERE NOT EXISTS (SELECT 1 FROM referral_tiers WHERE tier_key = 'starter');
      INSERT INTO referral_tiers (tier_key, label, min_referrals, reward_sd, perks)
      SELECT 'bronze', 'Bronze', 5, 2, 'Higher rewards and priority support'
      WHERE NOT EXISTS (SELECT 1 FROM referral_tiers WHERE tier_key = 'bronze');
      INSERT INTO referral_tiers (tier_key, label, min_referrals, reward_sd, perks)
      SELECT 'silver', 'Silver', 15, 3, 'Premium bot tools and higher rewards'
      WHERE NOT EXISTS (SELECT 1 FROM referral_tiers WHERE tier_key = 'silver');
      INSERT INTO referral_tiers (tier_key, label, min_referrals, reward_sd, perks)
      SELECT 'gold', 'Gold', 30, 5, 'Elite support and maximum referral rewards'
      WHERE NOT EXISTS (SELECT 1 FROM referral_tiers WHERE tier_key = 'gold');
      INSERT INTO marketplace_plugins (name, description, price_sd, category, author)
      SELECT 'Auto Reply Pack', 'Ready-made auto-reply commands for your WhatsApp bot.', 5, 'Bot Tools', 'BLACKLORD TECH INC'
      WHERE NOT EXISTS (SELECT 1 FROM marketplace_plugins WHERE name = 'Auto Reply Pack');
      INSERT INTO marketplace_plugins (name, description, price_sd, category, author)
      SELECT 'Welcome Messages Pack', 'Professional group welcome and goodbye templates.', 8, 'Engagement', 'BLACKLORD TECH INC'
      WHERE NOT EXISTS (SELECT 1 FROM marketplace_plugins WHERE name = 'Welcome Messages Pack');
      INSERT INTO marketplace_plugins (name, description, price_sd, category, author)
      SELECT 'Admin Tools Pack', 'Extra moderation and group administration commands.', 12, 'Moderation', 'BLACKLORD TECH INC'
      WHERE NOT EXISTS (SELECT 1 FROM marketplace_plugins WHERE name = 'Admin Tools Pack');
    `);
  } finally {
    client.release();
  }
}

async function getSiteSettings(client, keys = null) {
  const keyList = Array.isArray(keys) ? keys.filter(Boolean).map(String) : null;
  const result = keyList?.length
    ? await client.query('SELECT key, value FROM site_settings WHERE key = ANY($1::text[])', [keyList])
    : await client.query('SELECT key, value FROM site_settings');
  return Object.fromEntries(result.rows.map(row => [row.key, row.value]));
}

function settingInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the Application API settings used to create and manage servers.
 * Every value used for panel creation is read only from the protected
 * Admin Panel site_settings table. Missing values are returned as null so
 * the creation endpoint can stop safely and tell the administrator what to fill in.
 */
async function getPterodactylApplicationSettings(client) {
  const dbSettings = await getSiteSettings(client, [
    'PANEL_DOMAIN',
    'PANEL_APIKEY',
    'PANEL_EGG',
    'PANEL_NEST',
    'PANEL_LOC',
    'PANEL_NODE_ID',
    'PANEL_LOCATION_ID',
  ]);

  const rawPanelDomain = String(dbSettings.PANEL_DOMAIN || '').trim();
  const panelDomain = rawPanelDomain ? rawPanelDomain.replace(/\/+$/, '') : null;

  // Never read the Application API key from Vercel environment variables.
  // It must be entered and saved through Admin Panel → Pterodactyl Infrastructure.
  const panelApiKey = String(dbSettings.PANEL_APIKEY || '').trim();

  const legacyLocation = dbSettings.PANEL_LOC || null;
  const nodeId = settingInt(dbSettings.PANEL_NODE_ID || legacyLocation, null);
  const locationId = settingInt(dbSettings.PANEL_LOCATION_ID || legacyLocation, null);

  return {
    panelDomain,
    panelApiKey,
    panelEgg: settingInt(dbSettings.PANEL_EGG, null),
    panelNest: settingInt(dbSettings.PANEL_NEST, null),
    nodeId,
    locationId,
  };
}

async function logActivity(action, details) {
  try {
    if (!pool) return;
    await pool.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', [action, details]);
  } catch (e) {
    console.error('Log Activity Error:', e);
  }
}

async function sendTelegramNotification(message) {
  // Placeholder for Telegram notifications
  console.log('Telegram Notification:', message);
}

module.exports = {
  query: (text, params) => {
    if (!pool) throw new Error('DATABASE_URL is not configured');
    return pool.query(text, params);
  },
  initDb,
  getSiteSettings,
  getPterodactylApplicationSettings,
  logActivity,
  sendTelegramNotification,
  pool // Export pool directly so destructuring works
};
