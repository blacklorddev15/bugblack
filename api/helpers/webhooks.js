const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('./db');

async function dispatchWebhookEvent(phone, event, data = {}) {
  if (!pool || !phone || !event) return;
  try {
    const result = await pool.query(`SELECT id, endpoint_url, signing_secret
      FROM webhook_subscriptions
      WHERE phone = $1 AND active = TRUE
        AND (',' || REPLACE(events, ' ', '') || ',') LIKE ('%,' || $2 || ',%')`, [phone, event]);
    await Promise.all(result.rows.map(async hook => {
      const payload = { event, occurred_at: new Date().toISOString(), account: phone, data };
      const rawPayload = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', hook.signing_secret).update(rawPayload).digest('hex');
      const startedAt = Date.now();
      try {
        const response = await axios.post(hook.endpoint_url, payload, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-Blacklord-Event': event,
            'X-Blacklord-Signature': signature
          }
        });
        const responseBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
        await pool.query('INSERT INTO webhook_deliveries (webhook_id, phone, event, http_status, response_ms, request_payload, response_body) VALUES ($1, $2, $3, $4, $5, $6, $7)', [hook.id, phone, event, response.status, Date.now() - startedAt, rawPayload.slice(0, 20000), responseBody.slice(0, 20000)]);
        await pool.query('UPDATE webhook_subscriptions SET last_status = $1, last_delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [response.status, hook.id]);
      } catch (error) {
        const status = Number(error.response?.status || 0) || null;
        const responseBody = error.response?.data ? (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data)) : null;
        await pool.query('INSERT INTO webhook_deliveries (webhook_id, phone, event, http_status, response_ms, request_payload, response_body, error_message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [hook.id, phone, event, status, Date.now() - startedAt, rawPayload.slice(0, 20000), responseBody ? responseBody.slice(0, 20000) : null, String(error.message || 'Webhook delivery failed').slice(0, 1000)]);
        await pool.query('UPDATE webhook_subscriptions SET last_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, hook.id]);
      }
    }));
  } catch (error) {
    console.error('Webhook dispatch error:', error.message);
  }
}

module.exports = { dispatchWebhookEvent };
