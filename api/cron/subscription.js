const axios = require('axios');
const { pool, initDb, logActivity, sendTelegramNotification } = require('../helpers/db');

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await initDb();
    const client = await pool.connect();

    // Load Pterodactyl settings
    const settingsRes = await client.query('SELECT * FROM site_settings');
    const dbSettings = {};
    settingsRes.rows.forEach(r => { dbSettings[r.key] = r.value; });

    const PANEL_DOMAIN = dbSettings.PANEL_DOMAIN || process.env.PANEL_DOMAIN || 'https://eaglegnick.tech';
    const PANEL_APIKEY = dbSettings.PANEL_APIKEY || process.env.PANEL_APIKEY || '';

    // Find active servers whose billing date has passed
    const expiredRes = await client.query("SELECT * FROM servers WHERE status = 'active' AND next_billing_date <= CURRENT_TIMESTAMP");
    const expiredServers = expiredRes.rows;

    let processedCount = 0;

    for (const srv of expiredServers) {
      // Check user balance
      const userRes = await client.query('SELECT balance FROM users WHERE phone = $1', [srv.phone]);
      const user = userRes.rows[0];
      const balance = parseFloat(user ? user.balance : 0);
      const renewalCost = 10; // Standard monthly renewal fee in SD

      if (balance >= renewalCost) {
        // Deduct balance and extend billing date by 30 days
        const newBalance = balance - renewalCost;
        await client.query('UPDATE users SET balance = $1 WHERE phone = $2', [newBalance, srv.phone]);
        await client.query("UPDATE servers SET next_billing_date = CURRENT_TIMESTAMP + INTERVAL '30 days' WHERE id = $1", [srv.id]);
        
        logActivity('RENEWAL_SUCCESS', `Server #${srv.server_id} (${srv.username}) renewed for 30 days. Deducted ${renewalCost} SD from ${srv.phone}.`);
        sendTelegramNotification(`🔄 *Server Renewed Successfully!*\n\nPhone: \`${srv.phone}\`\nServer ID: \`${srv.server_id}\`\nCost: *${renewalCost} SD*`);
      } else {
        // Suspend server due to insufficient balance
        await client.query("UPDATE servers SET status = 'suspended' WHERE id = $1", [srv.id]);

        if (PANEL_APIKEY) {
          try {
            await axios.post(
              `${PANEL_DOMAIN}/api/application/servers/${srv.server_id}/suspend`,
              {},
              { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 10000 }
            );
          } catch (e) {
            console.error(`Failed to suspend Pterodactyl server ${srv.server_id}:`, e.message);
          }
        }

        logActivity('SERVER_SUSPENDED', `Server #${srv.server_id} (${srv.username}) suspended due to insufficient balance (${balance} SD) for ${srv.phone}.`);
        sendTelegramNotification(`⚠️ *Server Suspended!*\n\nPhone: \`${srv.phone}\`\nServer ID: \`${srv.server_id}\`\nReason: Insufficient SD balance.`);
      }
      processedCount++;
    }

    client.release();
    return res.status(200).json({ success: true, processed: processedCount });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
