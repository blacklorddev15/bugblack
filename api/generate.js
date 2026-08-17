const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function generateActivationKey() {
  const rnd = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `blacklord-${rnd().toLowerCase()}-${rnd().toLowerCase()}-${rnd().toLowerCase()}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, phone } = req.body || {};
  const normalizedType = String(type || '').toLowerCase();
  const normalizedPhone = String(phone || '').trim();

  if (!['free', 'premium'].includes(normalizedType) || !normalizedPhone) {
    return res.status(400).json({ error: 'A valid key type and phone are required' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Ensure tables exist (just in case).
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        username TEXT,
        balance NUMERIC DEFAULT 0,
        referred_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        used_by TEXT,
        used_number TEXT,
        used_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bot_settings (
        name TEXT PRIMARY KEY,
        value TEXT
      );
      INSERT INTO bot_settings (name, value) VALUES ('freeDays', '30') ON CONFLICT DO NOTHING;
    `);

    if (normalizedType === 'premium') {
      // Lock the user row until the key is created so concurrent requests cannot
      // bypass the wallet requirement. The current product has no separate
      // premium price configured, so any positive wallet balance is required.
      const walletRes = await client.query(
        'SELECT balance FROM users WHERE phone = $1 FOR UPDATE',
        [normalizedPhone]
      );
      const walletBalance = Number(walletRes.rows[0]?.balance || 0);
      if (walletRes.rows.length === 0 || !Number.isFinite(walletBalance) || walletBalance <= 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(402).json({
          error: 'Insufficient wallet funds. Add funds before generating a premium key.',
          requiresTopup: true
        });
      }
    }

    const settingsRes = await client.query("SELECT value FROM bot_settings WHERE name = 'freeDays'");
    const freeDays = parseInt(settingsRes.rows[0]?.value || '30', 10);
    const key = generateActivationKey();
    const expiresAt = normalizedType === 'premium'
      ? null
      : new Date(Date.now() + freeDays * 24 * 60 * 60 * 1000);

    const result = await client.query(
      'INSERT INTO keys (key, type, expires_at, used_by, used_number) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [key, normalizedType, expiresAt, null, normalizedPhone]
    );

    await client.query('COMMIT');
    client.release();

    return res.status(200).json({
      success: true,
      key: result.rows[0].key,
      type: result.rows[0].type,
      expiresAt: result.rows[0].expires_at
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
    }
    console.error(error);
    return res.status(500).json({ error: 'Database error' });
  }
}
