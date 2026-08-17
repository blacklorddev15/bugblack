const crypto = require('crypto');
const axios = require('axios');
const { pool, initDb } = require('./helpers/db');
const { creditDeposit, normalizeKenyanPhone } = require('./user-handler');

function text(value, fallback = '') {
  return String(value ?? fallback).trim();
}

async function siteSettings(client) {
  const result = await client.query('SELECT key, value FROM site_settings');
  return Object.fromEntries(result.rows.map(row => [row.key, row.value]));
}

// --- Paystack Helpers ---
function safeSignatureMatch(received, expected, rawBody) {
  if (!received || !expected) return false;
  const digest = crypto.createHmac('sha512', expected).update(rawBody).digest('hex');
  const left = Buffer.from(String(received));
  const right = Buffer.from(digest);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// --- M-Pesa STK Helpers ---
function stkConfig(settings, req) {
  const environment = text(process.env.MPESA_STK_ENV || settings.MPESA_STK_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
  const baseUrl = text(process.env.MPESA_DARAJA_BASE_URL || settings.MPESA_DARAJA_BASE_URL || (environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke')).replace(/\/$/, '');
  const shortCode = text(process.env.MPESA_STK_SHORTCODE || process.env.MPESA_SHORTCODE || settings.MPESA_STK_SHORTCODE || settings.MPESA_SHORTCODE);
  const transactionType = text(process.env.MPESA_STK_TRANSACTION_TYPE || settings.MPESA_STK_TRANSACTION_TYPE || 'CustomerBuyGoodsOnline');
  const callbackFromRequest = req?.headers?.host ? `https://${req.headers.host}/api/mpesa/stk/callback` : '';
  return {
    environment, baseUrl,
    consumerKey: text(process.env.MPESA_CONSUMER_KEY || settings.MPESA_CONSUMER_KEY),
    consumerSecret: text(process.env.MPESA_CONSUMER_SECRET || settings.MPESA_CONSUMER_SECRET),
    shortCode,
    passKey: text(process.env.MPESA_STK_PASSKEY || process.env.MPESA_PASSKEY || settings.MPESA_STK_PASSKEY || settings.MPESA_PASSKEY),
    transactionType: ['CustomerBuyGoodsOnline', 'CustomerPayBillOnline'].includes(transactionType) ? transactionType : 'CustomerBuyGoodsOnline',
    partyB: text(process.env.MPESA_STK_PARTY_B || settings.MPESA_STK_PARTY_B || shortCode),
    callbackUrl: text(process.env.MPESA_STK_CALLBACK_URL || settings.MPESA_STK_CALLBACK_URL || callbackFromRequest),
    accountReference: text(process.env.MPESA_STK_ACCOUNT_REFERENCE || settings.MPESA_STK_ACCOUNT_REFERENCE || 'BLACKLORD'),
  };
}

function kenyaTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

async function stkAccessToken(config) {
  const response = await axios.get(`${config.baseUrl}/oauth/v1/generate`, {
    params: { grant_type: 'client_credentials' },
    auth: { username: config.consumerKey, password: config.consumerSecret },
    timeout: 15000,
  });
  return response.data.access_token;
}

// --- Main Handler ---
module.exports = async function handler(req, res) {
  const path = String(req.url || '').split('?')[0];
  const method = req.method;
  
  try {
    await initDb();
    const client = await pool.connect();
    try {
      // 1. Paystack Webhook
      if (path.includes('/paystack/webhook')) {
        if (method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const secretResult = await client.query("SELECT value FROM site_settings WHERE key = 'PAYSTACK_SECRET' LIMIT 1");
        const secret = process.env.PAYSTACK_SECRET || secretResult.rows[0]?.value || '';
        const signature = req.headers?.['x-paystack-signature'] || req.headers?.['X-Paystack-Signature'];
        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
        if (!safeSignatureMatch(signature, secret, rawBody)) return res.status(401).json({ error: 'Invalid Paystack signature' });
        const event = req.body || {};
        if (event.event === 'charge.success' && event.data?.status === 'success') {
          const transaction = event.data;
          const reference = String(transaction.reference || '').trim();
          if (reference) {
            const depositRes = await client.query('SELECT * FROM deposits WHERE reference = $1 AND gateway = $2 LIMIT 1', [reference, 'paystack']);
            const deposit = depositRes.rows[0];
            if (deposit && deposit.status !== 'success') {
              await client.query('UPDATE deposits SET transaction_id = $1 WHERE reference = $2', [String(transaction.id || reference).slice(0, 120), reference]);
              await creditDeposit(client, deposit, reference);
            }
          }
        }
        return res.status(200).json({ received: true });
      }

      // 2. M-Pesa C2B Routes
      if (path.includes('/c2b/')) {
        const settings = await siteSettings(client);
        if (path.endsWith('/config') && method === 'GET') {
          return res.status(200).json({ 
            success: true, 
            tillNumber: text(process.env.MPESA_C2B_TILL_NUMBER || settings.MPESA_C2B_TILL_NUMBER), 
            kesPerSd: Number(process.env.MPESA_KES_PER_SD || settings.MPESA_KES_PER_SD || 5), 
            instructions: text(process.env.MPESA_C2B_INSTRUCTIONS || settings.MPESA_C2B_INSTRUCTIONS || 'Open M-Pesa, choose Lipa na M-Pesa, Buy Goods and Services, enter the Till number, pay the KES amount, and keep the transaction code.') 
          });
        }
        if (path.endsWith('/status') && method === 'POST') {
          const phone = normalizeKenyanPhone(req.body?.phone);
          const transactionId = text(req.body?.transactionId || req.body?.transId).toUpperCase();
          if (!phone || !transactionId) return res.status(400).json({ error: 'Phone and M-Pesa code required.' });
          const result = await client.query('SELECT status, amount_sd, amount_ksh, transaction_id, created_at FROM deposits WHERE gateway = $1 AND phone = $2 AND transaction_id = $3 LIMIT 1', ['c2b', phone, transactionId]);
          if (!result.rows[0]) return res.status(404).json({ success: false, status: 'not_found' });
          return res.status(200).json({ success: true, ...result.rows[0] });
        }
        if (method === 'POST') {
          const expectedTill = text(process.env.MPESA_C2B_TILL_NUMBER || settings.MPESA_C2B_TILL_NUMBER);
          const businessShortCode = text(req.body?.BusinessShortCode || req.body?.businessShortCode || req.body?.TillNumber || req.body?.tillNumber);
          if (expectedTill && businessShortCode && expectedTill !== businessShortCode) return res.status(200).json({ ResultCode: '1', ResultDesc: 'Unknown business number' });
          if (path.endsWith('/validation')) return res.status(200).json({ ResultCode: '0', ResultDesc: 'Accepted' });
          if (path.endsWith('/confirmation')) {
            const payload = req.body || {};
            const transactionId = text(payload.TransID || payload.trans_id || payload.transactionId).toUpperCase();
            const amountKsh = Number(payload.TransAmount ?? payload.amount ?? 0);
            const phone = normalizeKenyanPhone(payload.MSISDN || payload.msisdn || payload.PhoneNumber || payload.phone);
            const billRef = text(payload.BillRefNumber || payload.billRefNumber || payload.accountReference);
            if (transactionId && amountKsh > 0 && phone) {
              const duplicate = await client.query('SELECT status FROM deposits WHERE transaction_id = $1 LIMIT 1', [transactionId]);
              if (!duplicate.rows[0]) {
                const creditedPhone = normalizeKenyanPhone(billRef) || phone;
                const amountSd = Math.round((amountKsh / Number(process.env.MPESA_KES_PER_SD || settings.MPESA_KES_PER_SD || 5)) * 100) / 100;
                const reference = `C2B-${transactionId}`;
                const deposit = await client.query(`INSERT INTO deposits (reference, phone, amount_sd, amount_ksh, checkout_request_id, transaction_id, status, gateway) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'c2b') RETURNING *`, [reference, creditedPhone, amountSd, amountKsh, reference, transactionId]);
                await creditDeposit(client, deposit.rows[0], transactionId);
              }
            }
            return res.status(200).json({ ResultCode: '0', ResultDesc: 'Accepted' });
          }
        }
      }

      // 3. M-Pesa STK Push Routes
      if (path.includes('/mpesa/stk/')) {
        const settings = await siteSettings(client);
        const config = stkConfig(settings, req);
        if (path.endsWith('/config') && method === 'GET') {
          const missing = ['consumerKey', 'consumerSecret', 'shortCode', 'passKey', 'callbackUrl'].filter(k => !config[k]);
          return res.status(200).json({ success: true, configured: missing.length === 0, environment: config.environment, transactionType: config.transactionType, shortCode: config.shortCode || null, missing });
        }
        if (path.endsWith('/initiate') && method === 'POST') {
          const phone = normalizeKenyanPhone(req.body?.phone);
          const amountSd = Number(req.body?.amountSD);
          const amountKsh = Math.round(amountSd * Number(process.env.MPESA_KES_PER_SD || settings.MPESA_KES_PER_SD || 5));
          if (!phone || amountKsh < 1 || amountKsh > 150000) return res.status(400).json({ error: 'Invalid phone or amount' });
          const timestamp = kenyaTimestamp();
          const password = Buffer.from(`${config.shortCode}${config.passKey}${timestamp}`).toString('base64');
          const token = await stkAccessToken(config);
          const response = await axios.post(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
            BusinessShortCode: config.shortCode, Password: password, Timestamp: timestamp, TransactionType: config.transactionType,
            Amount: amountKsh, PartyA: phone, PartyB: config.partyB, PhoneNumber: phone, CallBackURL: config.callbackUrl,
            AccountReference: `BL-${phone.slice(-4)}`, TransactionDesc: 'BLACKLORD Top-up'
          }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
          if (response.data?.CheckoutRequestID) {
            const reference = `BLSTK-${Date.now().toString(36).toUpperCase()}`;
            await client.query(`INSERT INTO deposits (reference, phone, amount_sd, amount_ksh, checkout_request_id, transaction_id, status, gateway) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'mpesa_stk')`, [reference, phone, amountSd, amountKsh, response.data.CheckoutRequestID, response.data.MerchantRequestID || null]);
            return res.status(200).json({ success: true, reference, checkoutRequestId: response.data.CheckoutRequestID });
          }
          return res.status(502).json({ error: 'STK initiation failed' });
        }
        if (path.endsWith('/status') && method === 'POST') {
          const phone = normalizeKenyanPhone(req.body?.phone);
          const lookupId = text(req.body?.checkoutRequestId || req.body?.reference);
          const result = await client.query(`SELECT status, amount_sd, amount_ksh, transaction_id FROM deposits WHERE gateway = 'mpesa_stk' AND phone = $1 AND (checkout_request_id = $2 OR reference = $2) ORDER BY created_at DESC LIMIT 1`, [phone, lookupId]);
          if (!result.rows[0]) return res.status(404).json({ success: false, status: 'not_found' });
          return res.status(200).json({ success: true, ...result.rows[0] });
        }
        if (path.endsWith('/callback') && method === 'POST') {
          const callbackData = req.body?.Body?.stkCallback || req.body?.stkCallback || {};
          const checkoutRequestId = text(callbackData.CheckoutRequestID);
          if (checkoutRequestId) {
            const depositRes = await client.query('SELECT * FROM deposits WHERE gateway = $1 AND checkout_request_id = $2 LIMIT 1', ['mpesa_stk', checkoutRequestId]);
            const deposit = depositRes.rows[0];
            if (deposit && deposit.status === 'pending') {
              const resultCode = Number(callbackData.ResultCode);
              const items = callbackData.CallbackMetadata?.Item || [];
              const receipt = text(items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || checkoutRequestId).toUpperCase();
              if (resultCode === 0) {
                await client.query('UPDATE deposits SET transaction_id = $1 WHERE reference = $2', [receipt, deposit.reference]);
                await creditDeposit(client, deposit, receipt);
              } else {
                await client.query('UPDATE deposits SET status = $1 WHERE reference = $2', ['failed', deposit.reference]);
              }
            }
          }
          return res.status(200).json({ ResultCode: '0', ResultDesc: 'Accepted' });
        }
      }

      return res.status(404).json({ error: 'Payment route not found' });
    } finally { client.release(); }
  } catch (error) {
    console.error('Payment handler error:', error);
    return res.status(500).json({ error: 'Internal payment processing error' });
  }
};
