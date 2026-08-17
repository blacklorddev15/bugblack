const axios = require('axios');
const {
  pool,
  initDb,
  getPterodactylApplicationSettings,
  logActivity,
  sendTelegramNotification,
} = require('./helpers/db');

const MAX_SERVER_QUANTITY = 4;
const USERNAME_MAX_LENGTH = 32;

function requestError(status, message, payload = {}) {
  const error = new Error(message);
  error.status = status;
  error.payload = payload;
  return error;
}

function generatedUsernames(baseUsername, quantity) {
  const names = [];
  for (let index = 0; index < quantity; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const maxBaseLength = USERNAME_MAX_LENGTH - suffix.length;
    names.push(`${baseUsername.slice(0, maxBaseLength)}${suffix}`);
  }
  return names;
}

function pteroConfig(panelDomain, panelApiKey) {
  return {
    baseURL: `${String(panelDomain).replace(/\/$/, '')}/api/application`,
    headers: {
      Authorization: `Bearer ${panelApiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    phone,
    firstName,
    lastName,
    username,
    password,
    ram,
    disk,
    cpu,
    isAdmin,
    price,
    bot,
    quantity = 1,
    trial = false,
  } = req.body || {};

  if (!phone || !username || !password) {
    return res.status(400).json({ error: 'Phone, Username, and Password are required' });
  }

  const parsedQuantity = Number(quantity);
  if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > MAX_SERVER_QUANTITY) {
    return res.status(400).json({ error: `Server quantity must be between 1 and ${MAX_SERVER_QUANTITY}.` });
  }

  const baseUsername = String(username).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(baseUsername)) {
    return res.status(400).json({ error: 'Base username must be 3–32 characters using letters, numbers, hyphens, or underscores.' });
  }

  const isTrial = trial === true || trial === 'true';
  if (isTrial && parsedQuantity > 1) {
    return res.status(400).json({ error: 'The 3-hour trial supports one server per phone number.' });
  }

  const parsedPrice = isTrial ? 0 : Number(price);
  const panelRam = isTrial ? 512 : Number(ram);
  const panelDisk = isTrial ? 1024 : Number(disk);
  const panelCpu = isTrial ? 20 : Number(cpu);
  const adminPanel = isAdmin === true || isAdmin === 'true';
  const totalPrice = parsedPrice * parsedQuantity;
  const generatedNames = generatedUsernames(baseUsername, parsedQuantity);
  const remoteCreated = [];

  let client = null;
  let transactionOpen = false;
  let databaseCommitted = false;

  const cleanupRemote = async (config) => {
    for (const created of [...remoteCreated].reverse()) {
      const remoteServerId = created.pterodactylId || created.serverId;
      if (remoteServerId) {
        try { await axios.delete(`${config.baseURL}/servers/${remoteServerId}`, config); } catch (error) { console.error('Rollback server warning:', error.message); }
      }
      if (created.userId) {
        try { await axios.delete(`${config.baseURL}/users/${created.userId}`, config); } catch (error) { console.error('Rollback user warning:', error.message); }
      }
    }
  };

  try {
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0 || !Number.isFinite(panelRam) || !Number.isFinite(panelDisk) || !Number.isFinite(panelCpu)) {
      throw requestError(400, 'Invalid panel price or resource values.');
    }

    await initDb();
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    const userRes = await client.query(
      'SELECT balance, username as wallet_username, registered_at FROM users WHERE phone = $1 FOR UPDATE',
      [phone]
    );
    const user = userRes.rows[0];
    if (!user?.registered_at) {
      throw requestError(403, 'Registration is required before creating a panel.', { requiresRegistration: true });
    }

    const balance = parseFloat(user.balance || 0);
    const walletUsername = user.wallet_username || 'unknown';
    if (!isTrial && balance < totalPrice) {
      throw requestError(402, `Insufficient balance. You need ${totalPrice} SD for ${parsedQuantity} server${parsedQuantity === 1 ? '' : 's'}, but you only have ${balance} SD.`);
    }

    if (isTrial) {
      const trialClaimRes = await client.query('SELECT phone FROM trial_claims WHERE phone = $1', [phone]);
      if (trialClaimRes.rows.length > 0) {
        throw requestError(409, 'This phone number has already used its 3-hour trial.');
      }
    }

    const {
      panelDomain: PANEL_DOMAIN,
      panelApiKey: PANEL_APIKEY,
      panelEgg: PANEL_EGG,
      panelNest: PANEL_NEST,
      nodeId: PANEL_NODE_ID,
      locationId: PANEL_LOCATION_ID,
    } = await getPterodactylApplicationSettings(client);

    const missingPanelSettings = [];
    if (!PANEL_DOMAIN) missingPanelSettings.push('Panel URL');
    if (!PANEL_APIKEY) missingPanelSettings.push('Application API Key');
    if (!Number.isInteger(PANEL_EGG)) missingPanelSettings.push('Egg ID');
    if (!Number.isInteger(PANEL_NEST)) missingPanelSettings.push('Nest ID');
    if (!Number.isInteger(PANEL_NODE_ID)) missingPanelSettings.push('Allocation Node ID');
    if (!Number.isInteger(PANEL_LOCATION_ID)) missingPanelSettings.push('Deployment Location ID');
    if (missingPanelSettings.length > 0) {
      throw requestError(500, `Admin must configure these Pterodactyl panel-creation settings: ${missingPanelSettings.join(', ')}.`, { missingSettings: missingPanelSettings });
    }

    const config = pteroConfig(PANEL_DOMAIN, PANEL_APIKEY);
    const allocationResponse = await axios.get(`${config.baseURL}/nodes/${PANEL_NODE_ID}/allocations`, config);
    const availableAllocations = (allocationResponse.data.data || [])
      .filter(item => item.attributes?.assigned === false)
      .slice(0, parsedQuantity);
    if (availableAllocations.length < parsedQuantity) {
      throw requestError(409, `Only ${availableAllocations.length} allocation${availableAllocations.length === 1 ? '' : 's'} available; ${parsedQuantity} required.`);
    }

    const eggResponse = await axios.get(`${config.baseURL}/nests/${PANEL_NEST}/eggs/${PANEL_EGG}?include=variables`, config);
    const eggDetails = eggResponse.data.attributes || {};
    const environment = {};
    for (const variable of eggDetails.relationships?.variables?.data || []) {
      const key = variable.attributes?.env_variable;
      if (key) environment[key] = variable.attributes.default_value || '';
    }
    environment.NODE_VERSION = '18';
    environment.INST = 'npm';
    environment.CMD_RUN = 'npm start';

    for (let index = 0; index < generatedNames.length; index += 1) {
      const generatedUsername = generatedNames[index];
      const email = `${generatedUsername}@blacklord.tech`;
      let pterodactylUserId;

      try {
        const userCreateResponse = await axios.post(`${config.baseURL}/users`, {
          email,
          username: generatedUsername,
          first_name: firstName || generatedUsername,
          last_name: lastName || (adminPanel ? 'Admin' : 'Bulky'),
          root_admin: adminPanel,
          language: 'en',
          password,
        }, config);
        pterodactylUserId = userCreateResponse.data.attributes.id;
      } catch (error) {
        throw new Error(`User ${generatedUsername} creation failed: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
      }

      const serverData = {
        name: `${generatedUsername}-${isTrial ? 'trial' : (adminPanel ? 'admin' : 'bulky')}`,
        user: pterodactylUserId,
        egg: PANEL_EGG,
        docker_image: eggDetails.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_18',
        startup: eggDetails.startup || 'npm start',
        environment,
        limits: { memory: panelRam, swap: 0, disk: panelDisk, io: 500, cpu: panelCpu },
        feature_limits: { databases: 1, backups: 1 },
        allocation: { default: availableAllocations[index].attributes.id },
        deployment: { locations: [PANEL_LOCATION_ID] },
        start_on_completion: true,
      };

      try {
        const serverResponse = await axios.post(`${config.baseURL}/servers`, serverData, config);
        const attributes = serverResponse.data.attributes || {};
        remoteCreated.push({
          userId: pterodactylUserId,
          pterodactylId: attributes.id,
          serverId: attributes.identifier || attributes.uuid || String(attributes.id),
        });
      } catch (error) {
        remoteCreated.push({ userId: pterodactylUserId, serverId: null });
        throw new Error(`Server ${generatedUsername} creation failed: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
      }
    }

    const newBalance = balance - totalPrice;
    if (!isTrial) await client.query('UPDATE users SET balance = $1 WHERE phone = $2', [newBalance, phone]);
    const trialExpiresAt = isTrial ? new Date(Date.now() + 3 * 60 * 60 * 1000) : null;
    for (const created of remoteCreated) {
      const generatedUsername = generatedNames[remoteCreated.indexOf(created)];
      await client.query(
        'INSERT INTO servers (phone, server_id, username, bot_type, renewal_price_sd, is_trial, trial_expires_at, next_billing_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [phone, created.serverId, generatedUsername, bot || 'blacklord', parsedPrice, isTrial, trialExpiresAt, trialExpiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]
      );
    }
    if (isTrial) await client.query('INSERT INTO trial_claims (phone, server_id) VALUES ($1, $2)', [phone, remoteCreated[0].serverId]);

    await client.query('COMMIT');
    transactionOpen = false;
    databaseCommitted = true;
    client.release();
    client = null;

    const responseServers = remoteCreated.map((created, index) => ({
      serverId: created.serverId,
      pterodactylId: created.pterodactylId,
      username: generatedNames[index],
      password,
      ram: panelRam,
      disk: panelDisk,
      cpu: panelCpu,
      panelDomain: PANEL_DOMAIN,
      isAdmin: adminPanel,
      isTrial,
    }));

    try {
      await logActivity(
        isTrial ? 'TRIAL_PANEL_CREATE' : 'SERVER_CREATE',
        `User ${walletUsername} (${phone}) created ${parsedQuantity} ${isTrial ? 'trial' : (adminPanel ? 'admin' : 'bulky')} panel(s). Bot: ${bot || 'blacklord'}`
      );
    } catch (error) { console.error('Activity log warning:', error.message); }
    try {
      await sendTelegramNotification(
        `🖥️ *New Panel Order*\n\nWallet Username: \`${walletUsername}\`\nPhone: \`${phone}\`\nQuantity: *${parsedQuantity}*\nTier: *${isTrial ? '3-hour Trial' : (adminPanel ? 'Admin' : 'Bulky')}*\nCost: *${isTrial ? 'Free' : `${totalPrice} SD`}*\nBot: \`${bot || 'blacklord'}\`\nPanel Usernames: \`${generatedNames.join(', ')}\``
      );
    } catch (error) { console.error('Telegram notification warning:', error.message); }

    return res.status(200).json({
      success: true,
      quantity: parsedQuantity,
      totalPrice,
      username: generatedNames[0],
      password,
      panelDomain: PANEL_DOMAIN,
      serverId: responseServers[0].serverId,
      ram: panelRam,
      disk: panelDisk,
      cpu: panelCpu,
      isAdmin: adminPanel,
      isTrial,
      newBalance,
      servers: responseServers,
    });
  } catch (error) {
    if (transactionOpen && client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    if (!databaseCommitted && remoteCreated.length) {
      try {
        const rollbackSettings = client ? await getPterodactylApplicationSettings(client) : null;
        if (rollbackSettings?.panelDomain && rollbackSettings?.panelApiKey) {
          await cleanupRemote(pteroConfig(rollbackSettings.panelDomain, rollbackSettings.panelApiKey));
        }
      } catch (rollbackError) {
        console.error('Remote rollback warning:', rollbackError.message);
      }
    }
    if (client) client.release();

    console.error(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    const payload = error.payload || {};
    return res.status(status).json({ error: `Server creation failed: ${error.message}`, ...payload });
  }
}
