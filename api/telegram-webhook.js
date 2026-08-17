const { pool } = require('./helpers/db');
const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).json({ ok: true });
  }

  const chatId = update.message.chat.id;
  const text = String(update.message.text || '').trim();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  async function sendTelegramMessage(msgText) {
    if (!botToken) return;
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: msgText,
        parse_mode: 'Markdown'
      });
    } catch (e) {
      console.error('Telegram send error:', e.message);
    }
  }

  if (text === '/start' || text === '/help') {
    await sendTelegramMessage(
      `🌹 *BLACKLORD TECH INC* 🌹\n\n` +
      `Website pairing is now the active pairing method. Open the Blacklord dashboard, choose your bot, enter the WhatsApp number, and request a pairing code there.`
    );
    return res.status(200).json({ ok: true });
  }

  if (text.startsWith('/pair')) {
    const parts = text.split(/\s+/);
    const phone = parts[1];
    const botType = (parts[2] || 'blacklord').toLowerCase();

    if (!phone) {
      await sendTelegramMessage(`❌ Please provide your phone number.\nUsage: \`/pair 254712345678 blacklord\``);
      return res.status(200).json({ ok: true });
    }

    const allowedBots = ['blacklord', 'samsung', 'talkless', 'mzazi', 'skylar', 'rita', 'titan', 'nxra'];
    if (!allowedBots.includes(botType)) {
      await sendTelegramMessage(`❌ Invalid bot type. Choose from: ${allowedBots.join(', ')}`);
      return res.status(200).json({ ok: true });
    }

    await sendTelegramMessage(`Website pairing is now active. Open the Blacklord dashboard to choose ${botType.toUpperCase()}, enter ${phone}, and generate the code.`);
    return res.status(200).json({ ok: true });
  }

  await sendTelegramMessage(`🤖 Unknown command. Send /start to see available commands.`);
  return res.status(200).json({ ok: true });
};
