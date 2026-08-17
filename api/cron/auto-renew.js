const axios = require('axios');
const { pool, initDb, logActivity, sendTelegramNotification } = require('../helpers/db');

export default async function handler(req, res) {
  const configuredSecret = process.env.CRON_SECRET;
  const authorization = req.headers?.authorization || '';
  if (!configuredSecret || authorization !== `Bearer ${configuredSecret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  let client;
  try {
    await initDb();
    client = await pool.connect();
    await client.query('BEGIN');
    const expiredTrialsRes = await client.query("SELECT id, server_id, phone FROM servers WHERE is_trial = TRUE AND status = 'active' AND trial_expires_at <= CURRENT_TIMESTAMP FOR UPDATE");
    for (const trial of expiredTrialsRes.rows) {
      if (trial.server_id) {
        try {
          const settingsRes = await client.query("SELECT key, value FROM site_settings WHERE key IN ('PANEL_DOMAIN', 'PANEL_APIKEY')");
          const panelSettings = Object.fromEntries(settingsRes.rows.map(row => [row.key, row.value]));
          const panelDomain = panelSettings.PANEL_DOMAIN || process.env.PANEL_DOMAIN;
          const panelApiKey = panelSettings.PANEL_APIKEY || process.env.PANEL_APIKEY;
          if (panelDomain && panelApiKey) await axios.post(`${panelDomain.replace(/\/$/, '')}/api/application/servers/${trial.server_id}/suspend`, {}, { headers: { Authorization: `Bearer ${panelApiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
        } catch (suspendError) { console.error('Trial suspend warning:', suspendError.message); }
      }
      await client.query("UPDATE servers SET status = 'suspended' WHERE id = $1", [trial.id]);
      await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['TRIAL_EXPIRED', `Three-hour trial panel ${trial.id} expired for ${trial.phone}.`]);
    }
    const eligibleRes = await client.query(`
      SELECT s.id, s.phone, s.server_id, s.renewal_price_sd, u.balance, u.username
      FROM servers s
      JOIN users u ON u.phone = s.phone
      WHERE s.status = 'active'
        AND (s.auto_renew_enabled = TRUE OR u.auto_renew_enabled = TRUE)
        AND s.next_billing_date <= CURRENT_TIMESTAMP
      FOR UPDATE
    `);
    const results = [];
    const giveawayWinners = [];

    for (const server of eligibleRes.rows) {
      const price = Number(server.renewal_price_sd || 0);
      const balance = Number(server.balance || 0);
      if (!Number.isFinite(price) || price <= 0) {
        await client.query('INSERT INTO auto_renew_log (server_id, phone, amount_sd, status, details) VALUES ($1, $2, $3, $4, $5)', [server.id, server.phone, 0, 'skipped', 'No renewal price configured']);
        results.push({ serverId: server.id, status: 'skipped', reason: 'No renewal price configured' });
        continue;
      }
      if (balance < price) {
        await client.query('INSERT INTO auto_renew_log (server_id, phone, amount_sd, status, details) VALUES ($1, $2, $3, $4, $5)', [server.id, server.phone, price, 'insufficient_funds', `Balance ${balance.toFixed(2)} SD is below renewal price ${price.toFixed(2)} SD`]);
        results.push({ serverId: server.id, status: 'insufficient_funds' });
        continue;
      }
      await client.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [price, server.phone]);
      await client.query("UPDATE servers SET next_billing_date = CURRENT_TIMESTAMP + INTERVAL '30 days', last_renewed_at = CURRENT_TIMESTAMP WHERE id = $1", [server.id]);
      await client.query('INSERT INTO auto_renew_log (server_id, phone, amount_sd, status, details) VALUES ($1, $2, $3, $4, $5)', [server.id, server.phone, price, 'success', 'Server billing date extended by 30 days']);
      await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['AUTO_RENEW_SUCCESS', `Auto-renewed server ${server.id} for ${server.phone} at ${price.toFixed(2)} SD.`]);
      results.push({ serverId: server.id, status: 'success', amountSd: price });
    }

    const insuranceRes = await client.query(`
      SELECT i.id, i.phone, i.server_id, i.price_sd, u.balance
      FROM insurance_subscriptions i
      JOIN users u ON u.phone = i.phone
      WHERE i.status = 'active' AND i.next_billing_date <= CURRENT_TIMESTAMP
      FOR UPDATE
    `);
    for (const subscription of insuranceRes.rows) {
      const price = Number(subscription.price_sd || 2);
      const balance = Number(subscription.balance || 0);
      if (balance >= price) {
        await client.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [price, subscription.phone]);
        await client.query("UPDATE insurance_subscriptions SET next_billing_date = CURRENT_TIMESTAMP + INTERVAL '30 days' WHERE id = $1", [subscription.id]);
        await client.query('INSERT INTO auto_renew_log (server_id, phone, amount_sd, status, details) VALUES ($1, $2, $3, $4, $5)', [subscription.server_id, subscription.phone, price, 'success', 'Bot insurance service plan renewed for 30 days']);
        results.push({ insuranceId: subscription.id, status: 'success', amountSd: price });
      } else {
        await client.query("UPDATE insurance_subscriptions SET status = 'past_due' WHERE id = $1", [subscription.id]);
        await client.query('INSERT INTO auto_renew_log (server_id, phone, amount_sd, status, details) VALUES ($1, $2, $3, $4, $5)', [subscription.server_id, subscription.phone, price, 'insufficient_funds', `Insurance balance ${balance.toFixed(2)} SD is below ${price.toFixed(2)} SD`]);
        results.push({ insuranceId: subscription.id, status: 'past_due' });
      }
    }

    const giveawayRes = await client.query("SELECT * FROM giveaways WHERE status IN ('scheduled', 'active') AND draw_at <= CURRENT_TIMESTAMP FOR UPDATE");
    for (const giveaway of giveawayRes.rows) {
      const winnerRes = await client.query('SELECT phone FROM giveaway_entries WHERE giveaway_id = $1 ORDER BY random() LIMIT 1', [giveaway.id]);
      if (!winnerRes.rows[0]) {
        await client.query("UPDATE giveaways SET status = 'closed', drawn_at = CURRENT_TIMESTAMP WHERE id = $1", [giveaway.id]);
        results.push({ giveawayId: giveaway.id, status: 'closed_no_entries' });
        continue;
      }
      const winnerPhone = winnerRes.rows[0].phone;
      await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE phone = $2', [giveaway.prize_sd, winnerPhone]);
      await client.query("UPDATE giveaways SET status = 'drawn', winner_phone = $1, drawn_at = CURRENT_TIMESTAMP WHERE id = $2", [winnerPhone, giveaway.id]);
      await client.query('INSERT INTO activity_logs (action, details) VALUES ($1, $2)', ['GIVEAWAY_DRAWN', `Automated giveaway ${giveaway.id} winner: ${winnerPhone}.`]);
      giveawayWinners.push({ giveawayId: giveaway.id, winnerPhone, prizeSd: Number(giveaway.prize_sd) });
      results.push({ giveawayId: giveaway.id, status: 'drawn', winnerPhone, prizeSd: Number(giveaway.prize_sd) });
    }

    await client.query('COMMIT');
    client.release();
    if (results.some(item => item.status === 'success')) sendTelegramNotification(`♻️ Auto-renewal completed for ${results.filter(item => item.status === 'success').length} service(s).`);
    for (const winner of giveawayWinners) sendTelegramNotification(`🎉 Giveaway ${winner.giveawayId} drawn. Winner: ${winner.winnerPhone}. Prize: ${winner.prizeSd} SD.`);
    return res.status(200).json({ success: true, processed: results.length, results });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
    }
    console.error(error);
    return res.status(500).json({ error: 'Auto-renewal job failed' });
  }
}
