// 依赖：01-state.js / 02-core.js / 03-data.js / 04-chat.js
// 钱包 + 红包：纯本地记账模拟，不联网、不接任何支付
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, dbGet, dbPut, escapeHtml, formatTime, now, randInt, showModal, toast } from './02-core.js';
import { getAllContacts, getContact, getStatusPool, openPage, saveContact } from './03-data.js';
import { renderChatIncremental } from './04-chat.js';

const DAY = 86400000;
const MIN = 60000;

const WALLET_KEY = 'wallet_v1';
const LEDGER_KEY = 'wallet_ledger_v1';
const CONTACT_PREFIX = 'cwallet_';
const LEDGER_MAX = 300;

const QUICK_AMOUNTS = [5.20, 13.14, 52, 66.6, 88.8];
const LUCKY_AMOUNTS = [5.20, 6.66, 8.88, 9.99, 13.14, 52, 66.6, 88.8, 99.99];

// 本地串行队列：红包/钱包写入不与自身并发冲突
let _chain = Promise.resolve();
function serialize(fn) {
  const p = _chain.then(fn, fn);
  _chain = p.catch(() => {});
  return p;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fmtMoney(n) {
  const s = round2(n).toFixed(2);
  return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
function clamp(n, a, b) { n = Number(n); if (!Number.isFinite(n)) n = a; return Math.max(a, Math.min(b, n)); }
function monthKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}`; }
function monthsPassed(fromKey, toKey) {
  const [fy, fm] = String(fromKey || '').split('-').map(Number);
  const [ty, tm] = String(toKey || '').split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return 0;
  return Math.max(0, (ty - fy) * 12 + (tm - fm));
}

// ============ 我的卡（全局配置） ============
async function settleWallet(w) {
  const cur = monthKey(now());
  const n = monthsPassed(w.month, cur);
  if (n <= 0) return false;
  if (w.mode === 'accumulate') w.balance = round2(w.balance + w.monthly * n);
  else w.balance = round2(w.monthly);
  w.month = cur;
  return true;
}
async function getWallet() {
  let w = await dbGet('wallet', WALLET_KEY);
  if (!w) {
    w = { k: WALLET_KEY, mode: 'reset', monthly: 1000, start: 1000, balance: 1000, month: monthKey(now()) };
    await dbPut('wallet', w);
    return w;
  }
  w.mode = w.mode === 'accumulate' ? 'accumulate' : 'reset';
  w.monthly = round2(clamp(w.monthly, 0, 99999999));
  w.start = round2(clamp(w.start, 0, 99999999));
  w.balance = round2(clamp(w.balance, 0, 99999999));
  if (!w.month) w.month = monthKey(now());
  if (await settleWallet(w)) await dbPut('wallet', w);
  return w;
}

// ============ 每个联系人的共用卡 + 红包参数 ============
function normalizeCW(rec, cid) {
  const w = Object.assign({
    k: CONTACT_PREFIX + cid, cid,
    shared: 200,
    rpEnabled: true,
    prob: 60,
    gapMin: 1,
    gapMax: 4,
    inMin: 1,
    inMax: 50,
    outMin: 1,
    outMax: 20,
    nextAt: 0,
  }, rec || {});
  w.shared = round2(clamp(w.shared, 0, 99999999));
  w.prob = Math.round(clamp(w.prob, 0, 100));
  w.gapMin = Math.max(1, Math.round(clamp(w.gapMin, 1, 720)));
  w.gapMax = Math.max(w.gapMin, Math.round(clamp(w.gapMax, 1, 720)));
  w.inMin = round2(Math.max(0.01, clamp(w.inMin, 0.01, 999999)));
  w.inMax = round2(Math.max(w.inMin, clamp(w.inMax, 0.01, 999999)));
  w.outMin = round2(Math.max(0.01, clamp(w.outMin, 0.01, 999999)));
  w.outMax = round2(Math.max(w.outMin, clamp(w.outMax, 0.01, 999999)));
  w.rpEnabled = w.rpEnabled !== false;
  if (!w.nextAt) w.nextAt = now() + randInt(2, 10) * MIN;
  return w;
}
async function getContactWallet(cid) {
  const rec = await dbGet('wallet', CONTACT_PREFIX + cid);
  const w = normalizeCW(rec, cid);
  if (!rec || JSON.stringify(rec) !== JSON.stringify(w)) await dbPut('wallet', w);
  return w;
}

async function getLedger() {
  const rec = await dbGet('wallet', LEDGER_KEY);
  return (rec && Array.isArray(rec.list)) ? rec.list : [];
}
async function addLedger(entry) {
  const list = await getLedger();
  list.push(Object.assign({ id: uid() }, entry));
  const trimmed = list.length > LEDGER_MAX ? list.slice(-LEDGER_MAX) : list;
  await dbPut('wallet', { k: LEDGER_KEY, list: trimmed });
}

// ============ 金额与状态 ============
function randAmount(min, max) {
  const lo = round2(Math.max(0.01, Number(min) || 0.01));
  const hi = round2(Math.max(lo, Number(max) || lo));
  if (Math.random() < 0.45) {
    const pool = LUCKY_AMOUNTS.filter(v => v >= lo && v <= hi);
    if (pool.length) return pool[randInt(0, pool.length - 1)];
  }
  return round2(lo + Math.random() * (hi - lo));
}
function currentCategory(c, pool) {
  const st = pool.find(s => s.id === c.statusId) || pool.find(s => s.name === c.status);
  return st ? st.category : 'present';
}
// 对方来领我发的红包所需时间（跟随对方当前状态）
function claimDelay(cat) {
  if (cat === 'sleep') return 0;               // 睡觉不领，醒来再领
  if (cat === 'event') return randInt(10, 50) * MIN;
  return randInt(3, 60) * 1000;                // 在场 / 悠闲：几秒到一分钟
}
function rpStatusText(rp, isOut) {
  if (rp.status === 'opened') return isOut ? '已领取' : '已领取';
  if (rp.status === 'expired') return '已过期';
  if (rp.status === 'returned') return '已退回';
  return isOut ? '等待对方领取' : '点开领取';
}
function rpCovered(rp) {
  return rp.status !== 'opened';
}
// 增量渲染只补新节点，已存在的卡片状态需单独刷新
function refreshRpCard(m) {
  if (!m || m.type !== 'redpacket') return;
  const rp = m.redPacket || {};
  const isOut = m.from === 'me';
  const done = rp.status === 'opened' || rp.status === 'expired' || rp.status === 'returned';
  const card = document.querySelector(`.msg-rp-card[data-rpid="${m.id}"]`);
  if (!card) return;
  card.classList.toggle('done', done);
  const amt = card.querySelector('.msg-rp-amount');
  if (amt) amt.textContent = done ? '¥' + fmtMoney(rp.amount) : '¥ ••.••';
  const st = card.querySelector('.msg-rp-status');
  if (st) {
    st.textContent = rp.status === 'opened' ? '已领取'
      : rp.status === 'expired' ? '已过期'
      : rp.status === 'returned' ? '已退回'
      : (isOut ? '等待对方领取' : '点开领取');
  }
}

// ============ 补算：生成联系人的红包 / 对方领取我发的红包 / 24h 过期 ============
const _running = new Set();
export async function walletTick(cid) {
  if (!cid || _running.has(cid)) return;
  _running.add(cid);
  try {
    await serialize(() => tickInner(cid));
  } catch (e) {
    console.warn('钱包补算失败：', e);
  } finally {
    _running.delete(cid);
  }
}

async function tickInner(cid) {
  const c = await getContact(cid);
  if (!c) return;
  const t = now();
  const w = await getWallet();
  const cw = await getContactWallet(cid);
  const pool = await getStatusPool();
  const msgs = c.messages || (c.messages = []);
  let contactChanged = false, myChanged = false, cwChanged = false;

  // 1) 我发出的红包：对方按状态时刻自动领取；超过 24 小时未领取退回原卡
  for (const m of msgs) {
    if (m.type !== 'redpacket' || !m.redPacket || m.from !== 'me') continue;
    const rp = m.redPacket;
    if (rp.status !== 'unopened') continue;
    const created = Number(rp.createdAt) || Number(m.time) || t;
    if (t >= created + DAY) {
      rp.status = 'returned';
      rp.returnedAt = created + DAY;
      const refundCard = rp.card === 'shared' ? 'shared' : 'mine';
      if (refundCard === 'mine') { w.balance = round2(w.balance + (Number(rp.amount) || 0)); myChanged = true; }
      else { cw.shared = round2(cw.shared + (Number(rp.amount) || 0)); cwChanged = true; }
      await addLedger({ time: rp.returnedAt, peer: c.name, amount: rp.amount, dir: 'in' });
      contactChanged = true;
      continue;
    }
    if (!rp.claimAt) {
      // 生成时对方在睡觉：醒来（切到非睡觉状态）后才领
      if (currentCategory(c, pool) !== 'sleep') {
        rp.status = 'opened';
        rp.openedAt = t;
        m.read = true;
        contactChanged = true;
      }
    } else if (t >= rp.claimAt) {
      rp.status = 'opened';
      rp.openedAt = rp.claimAt;
      m.read = true;
      if (!m.readAt) m.readAt = rp.claimAt;
      contactChanged = true;
    }
  }

  // 2) 联系人发给我的红包：24 小时未领取 → 作废
  for (const m of msgs) {
    if (m.type !== 'redpacket' || !m.redPacket || m.from === 'me') continue;
    const rp = m.redPacket;
    if (rp.status !== 'unopened') continue;
    const created = Number(rp.createdAt) || Number(m.time) || t;
    if (t >= created + DAY) {
      rp.status = 'expired';
      rp.expiredAt = created + DAY;
      contactChanged = true;
    }
  }

  // 3) 按概率 + 间隔生成联系人发来的红包（一次补算最多 3 条，时间戳用真正命中时刻）
  let generated = 0;
  if (cw.rpEnabled && cw.nextAt && t >= cw.nextAt) {
    let at = cw.nextAt;
    let guard = 0;
    while (at <= t && guard < 8 && generated < 3) {
      // 超过 24 小时的旧红包直接作废，不再补出卡片
      if (at > t - DAY) {
        if (Math.random() * 100 < cw.prob) {
          const amount = randAmount(cw.inMin, cw.inMax);
          const hitAt = Math.min(at, t);
          msgs.push({
            id: uid(), from: 'other', type: 'redpacket', content: '',
            time: hitAt, replyTo: null, snapshot: null,
            read: true, readAt: hitAt, replyAt: 0, replied: true,
            redPacket: { amount, status: 'unopened', direction: 'in', createdAt: hitAt, expiresAt: hitAt + DAY }
          });
          if (state.currentContactId !== cid) c.unread = (c.unread || 0) + 1;
          generated++;
          contactChanged = true;
        }
      }
      at += randInt(cw.gapMin, cw.gapMax) * 3600000;
      guard++;
    }
    // 长离线补完之后不继续堆在过期区间：直接从现在重新排期
    if (at <= t) at = t + randInt(cw.gapMin, cw.gapMax) * 3600000;
    cw.nextAt = at;
    cwChanged = true;
  }

  if (generated) {
    msgs.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
  }
  if (contactChanged) await saveContact(c);
  if (myChanged) await dbPut('wallet', w);
  if (cwChanged) await dbPut('wallet', cw);
  if (contactChanged && state.currentContactId === cid) {
    const pg = $('page-chat');
    if (pg && pg.classList.contains('active')) {
      await renderChatIncremental(cid);
      for (const m of msgs) if (m.type === 'redpacket') refreshRpCard(m);
    }
  }
}

// ============ 钱包页 ============
export function openWallet() {
  openPage('page-wallet');
}

export async function renderWalletPage() {
  const box = $('wallet-body');
  if (!box) return;
  const w = await getWallet();
  const contacts = await getAllContacts();
  const rows = [];
  for (const c of contacts) {
    const cw = await getContactWallet(c.id);
    rows.push({ c, cw });
  }
  rows.sort((a, b) => b.cw.shared - a.cw.shared);
  const sharedHtml = rows.length ? rows.map(({ c, cw }) => `
    <div class="wallet-shared-row" onclick="openContactSetting('${c.id}','page-wallet')">
      <img class="avatar" src="${escapeHtml(c.avatar || DEFAULT_AVATAR)}" alt="">
      <div class="ws-info">
        <div class="ws-name">${escapeHtml(c.name)}</div>
        <div class="ws-sub">共用卡</div>
      </div>
      <div class="ws-bal">¥${fmtMoney(cw.shared)}</div>
      <svg class="i i-sm ws-arrow"><use href="#icon-chevron-right"/></svg>
    </div>`).join('') : `<div class="wallet-empty">还没有联系人</div>`;
  const ledger = (await getLedger()).slice().sort((a, b) => b.time - a.time).slice(0, 30);
  const ledgerHtml = ledger.length ? ledger.map(x => `
    <div class="wallet-ledger-row">
      <div class="wl-main">
        <span class="wl-peer">${escapeHtml(x.peer || '—')}</span>
        <span class="wl-time">${formatTime(x.time)}</span>
      </div>
      <div class="wl-amt ${x.dir === 'in' ? 'in' : 'out'}">${x.dir === 'in' ? '+' : '-'}¥${fmtMoney(x.amount)}</div>
    </div>`).join('') : `<div class="wallet-empty">还没有流水</div>`;

  box.innerHTML = `
    <div class="wallet-hero">
      <svg class="wallet-hero-svg" viewBox="0 0 320 160" aria-hidden="true">
        <rect x="6" y="26" width="250" height="128" rx="18" fill="none" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.6"/>
        <rect x="42" y="6" width="250" height="128" rx="18" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.6"/>
        <line x1="66" y1="40" x2="150" y2="40" stroke="currentColor" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round"/>
        <line x1="66" y1="52" x2="120" y2="52" stroke="currentColor" stroke-opacity="0.3" stroke-width="2" stroke-linecap="round"/>
        <circle cx="252" cy="104" r="16" fill="none" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.6"/>
        <circle cx="266" cy="104" r="16" fill="none" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.6"/>
      </svg>
      <div class="wallet-hero-label">我的卡 · 余额</div>
      <div class="wallet-hero-bal">¥${fmtMoney(w.balance)}</div>
      <div class="wallet-hero-sub">${w.mode === 'accumulate' ? '每月累计' : '每月清零'} · 每月 ¥${fmtMoney(w.monthly)}</div>
    </div>

    <div class="wallet-section">
      <div class="wallet-section-title">共用卡</div>
      <div class="wallet-card-list">${sharedHtml}</div>
    </div>

    <div class="wallet-section">
      <div class="wallet-section-title">流水</div>
      <div class="wallet-ledger">${ledgerHtml}</div>
    </div>

    <div class="wallet-section">
      <div class="wallet-section-title">每月规则</div>
      <div class="wallet-settings">
        <div class="cs-row">
          <span class="cs-label">模式</span>
          <span class="cs-value">
            <select class="input" id="wallet-mode" style="width:auto;min-height:38px;padding:6px 10px;">
              <option value="reset"${w.mode === 'reset' ? ' selected' : ''}>清零（每月重置为设定金额）</option>
              <option value="accumulate"${w.mode === 'accumulate' ? ' selected' : ''}>累计（每月加上设定金额）</option>
            </select>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">每月金额</span>
          <span class="cs-value"><div class="range-row" style="justify-content:flex-end;"><span class="cs-unit">¥</span><input type="number" min="0" step="0.01" id="wallet-monthly" value="${fmtMoney(w.monthly)}"></div></span>
        </div>
        <div class="cs-row">
          <span class="cs-label">起点余额</span>
          <span class="cs-value"><div class="range-row" style="justify-content:flex-end;"><span class="cs-unit">¥</span><input type="number" min="0" step="0.01" id="wallet-start" value="${fmtMoney(w.start)}"></div></span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="walletSaveSettings()">
          <svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存设置
        </button>
        <div class="cs-hint">清零：每月把余额重置为每月金额；累计：每月在余额上累加。修改起点余额会把我的卡余额重置为该值。</div>
      </div>
    </div>
  `;
}

export async function walletSaveSettings() {
  return serialize(async () => {
    const w = await getWallet();
    const modeEl = $('wallet-mode');
    const monthlyEl = $('wallet-monthly');
    const startEl = $('wallet-start');
    w.mode = modeEl && modeEl.value === 'accumulate' ? 'accumulate' : 'reset';
    w.monthly = round2(clamp(monthlyEl ? monthlyEl.value : w.monthly, 0, 99999999));
    const start = round2(clamp(startEl ? startEl.value : w.start, 0, 99999999));
    if (start !== w.start) { w.start = start; w.balance = start; }
    w.month = monthKey(now());
    await dbPut('wallet', w);
    toast('钱包设置已保存');
    await renderWalletPage();
  });
}

// ============ 联系人设置页：共用卡 + 红包参数 ============
export async function walletSettingsHtml(cid) {
  const cw = await getContactWallet(cid);
  return `
    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-wallet"/></svg> 钱包与红包</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">共用卡余额</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;"><span class="cs-unit">¥</span><input type="number" min="0" step="0.01" value="${fmtMoney(cw.shared)}" id="wc-shared"></div>
          </span>
        </div>
        <div class="cs-row cs-row-switch">
          <span class="cs-label">Ta 会发红包</span>
          <span class="cs-value"><div class="switch ${cw.rpEnabled ? 'on' : ''}" id="wc-rp-switch" onclick="walletToggleRp()"></div></span>
        </div>
        <div class="cs-row">
          <span class="cs-label">发红包概率</span>
          <span class="cs-value"><div class="range-row" style="justify-content:flex-end;"><input type="number" min="0" max="100" step="1" value="${cw.prob}" id="wc-prob"><span class="cs-unit">%</span></div></span>
        </div>
        <div class="cs-row">
          <span class="cs-label">间隔</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;">
              <input type="number" min="1" step="1" value="${cw.gapMin}" id="wc-gap-min"><span class="cs-unit">~</span>
              <input type="number" min="1" step="1" value="${cw.gapMax}" id="wc-gap-max"><span class="cs-unit">小时</span>
            </div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Ta 发我的金额</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;">
              <span class="cs-unit">¥</span><input type="number" min="0.01" step="0.01" value="${fmtMoney(cw.inMin)}" id="wc-in-min"><span class="cs-unit">~</span>
              <input type="number" min="0.01" step="0.01" value="${fmtMoney(cw.inMax)}" id="wc-in-max">
            </div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">我发红包默认金额</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;">
              <span class="cs-unit">¥</span><input type="number" min="0.01" step="0.01" value="${fmtMoney(cw.outMin)}" id="wc-out-min"><span class="cs-unit">~</span>
              <input type="number" min="0.01" step="0.01" value="${fmtMoney(cw.outMax)}" id="wc-out-max">
            </div>
          </span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="walletSaveContactSettings()">
          <svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存钱包设置
        </button>
        <div class="cs-hint">每段间隔到点按概率决定是否发红包；对方按当前状态决定领取时间，睡觉不领、醒来再领；24 小时未领取作废。</div>
      </div>
    </div>`;
}

export async function walletSaveContactSettings() {
  return serialize(async () => {
    const cid = state.currentContactSettingId;
    if (!cid) return;
    const cw = await getContactWallet(cid);
    const num = (id, dft) => {
      const el = $(id);
      const v = parseFloat(el ? el.value : '');
      return Number.isFinite(v) ? v : dft;
    };
    cw.shared = round2(clamp(num('wc-shared', cw.shared), 0, 99999999));
    cw.prob = Math.round(clamp(num('wc-prob', cw.prob), 0, 100));
    let gMin = Math.max(1, Math.round(clamp(num('wc-gap-min', cw.gapMin), 1, 720)));
    let gMax = Math.max(1, Math.round(clamp(num('wc-gap-max', cw.gapMax), 1, 720)));
    if (gMin > gMax) { const tmp = gMin; gMin = gMax; gMax = tmp; }
    cw.gapMin = gMin; cw.gapMax = gMax;
    let inMin = round2(Math.max(0.01, num('wc-in-min', cw.inMin)));
    let inMax = round2(Math.max(0.01, num('wc-in-max', cw.inMax)));
    if (inMin > inMax) { const tmp = inMin; inMin = inMax; inMax = tmp; }
    cw.inMin = inMin; cw.inMax = inMax;
    let outMin = round2(Math.max(0.01, num('wc-out-min', cw.outMin)));
    let outMax = round2(Math.max(0.01, num('wc-out-max', cw.outMax)));
    if (outMin > outMax) { const tmp = outMin; outMin = outMax; outMax = tmp; }
    cw.outMin = outMin; cw.outMax = outMax;
    await dbPut('wallet', cw);
    toast('钱包设置已保存');
  });
}

export function walletToggleRp() {
  return serialize(async () => {
    const cid = state.currentContactSettingId;
    if (!cid) return;
    const cw = await getContactWallet(cid);
    cw.rpEnabled = !cw.rpEnabled;
    if (cw.rpEnabled && (!cw.nextAt || cw.nextAt < now())) {
      cw.nextAt = now() + randInt(cw.gapMin, cw.gapMax) * 3600000;
    }
    await dbPut('wallet', cw);
    const sw = $('wc-rp-switch');
    if (sw) sw.classList.toggle('on', cw.rpEnabled);
  });
}

// ============ 发红包 ============
let _rpDraft = { cid: null, card: 'mine', amount: 0 };

export async function openRedPacketPanel() {
  const cid = state.currentContactId;
  if (!cid) return toast('请先打开一位联系人');
  const c = await getContact(cid);
  if (!c) return;
  const w = await getWallet();
  const cw = await getContactWallet(cid);
  const card = w.balance > 0 ? 'mine' : (cw.shared > 0 ? 'shared' : '');
  _rpDraft = { cid, card, amount: randAmount(cw.outMin, cw.outMax) };
  const opt = (key, name, bal) => `
    <button type="button" class="rp-card-opt${card === key ? ' sel' : ''}${bal <= 0 ? ' disabled' : ''}"
      data-card="${key}" onclick="rpSelectCard('${key}')">
      <span class="rp-opt-name">${name}</span>
      <span class="rp-opt-bal">¥${fmtMoney(bal)}</span>
    </button>`;
  const body = `
    <div class="rp-panel">
      <div class="rp-panel-label">选择卡片</div>
      <div class="rp-card-opts">
        ${opt('mine', '我的卡', w.balance)}
        ${opt('shared', `我和${escapeHtml(c.name)}的共用卡`, cw.shared)}
      </div>
      <div class="rp-panel-label" style="margin-top:14px;">金额</div>
      <div class="rp-amount-row">
        <span>¥</span>
        <input id="rp-amount" type="number" min="0.01" step="0.01" value="${fmtMoney(_rpDraft.amount)}">
      </div>
      <div class="rp-quick-row">
        ${QUICK_AMOUNTS.map(v => `<button type="button" class="rp-quick" onclick="rpQuick(${v})">${v}</button>`).join('')}
      </div>
      <div class="rp-hint">默认金额来自该联系人的「我发红包默认金额」区间；发出后会从所选卡片扣除。</div>
    </div>`;
  showModal('发红包', body, [
    { label: '取消', cls: 'btn-outline', onClick: closeModal },
    { label: '装进红包', cls: 'btn', onClick: () => sendRedPacket() }
  ]);
}

export function rpSelectCard(card) {
  const el = document.querySelector(`.rp-card-opt[data-card="${card}"]`);
  if (!el || el.classList.contains('disabled')) return;
  document.querySelectorAll('.rp-card-opt').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  _rpDraft.card = card;
}
export function rpQuick(v) {
  const input = $('rp-amount');
  if (input) input.value = v;
}

export async function sendRedPacket() {
  return serialize(async () => {
    const cid = _rpDraft.cid || state.currentContactId;
    if (!cid) return toast('请先打开一位联系人');
    const c = await getContact(cid);
    if (!c) return;
    const input = $('rp-amount');
    let amount = round2(parseFloat(input ? input.value : ''));
    if (!Number.isFinite(amount) || amount <= 0) return toast('请输入有效金额');
    const w = await getWallet();
    const cw = await getContactWallet(cid);
    const card = _rpDraft.card === 'shared' ? 'shared' : 'mine';
    const bal = card === 'mine' ? w.balance : cw.shared;
    if (bal <= 0) return toast('这张卡没有余额了');
    if (amount > bal) return toast('余额不足');
    if (card === 'mine') w.balance = round2(w.balance - amount);
    else cw.shared = round2(cw.shared - amount);
    const t = now();
    const cat = currentCategory(c, await getStatusPool());
    const delay = claimDelay(cat);
    c.messages = c.messages || [];
    c.messages.push({
      id: uid(), from: 'me', type: 'redpacket', content: '',
      time: t, replyTo: null, snapshot: null,
      read: false, readAt: 0, replyAt: 0, replied: true,
      redPacket: {
        amount, card, status: 'unopened', direction: 'out',
        createdAt: t, claimAt: delay ? t + delay : 0, expiresAt: t + DAY
      }
    });
    await saveContact(c);
    await dbPut('wallet', w);
    await dbPut('wallet', cw);
    await addLedger({ time: t, peer: c.name, amount, dir: 'out' });
    closeModal();
    if (state.currentContactId === cid) renderChatIncremental(cid);
    toast('红包已发出');
  });
}

// ============ 点开红包卡片 ============
export async function openRedPacket(cid, msgId) {
  return serialize(async () => {
    const c = await getContact(cid);
    if (!c) return;
    const m = (c.messages || []).find(x => x.id === msgId);
    if (!m || m.type !== 'redpacket' || !m.redPacket) return;
    const rp = m.redPacket;
    if (rp.status === 'expired') return toast('红包已过期');
    if (rp.status === 'returned') return toast('红包已退回');
    if (rp.status === 'opened') return toast(`已领取 ¥${fmtMoney(rp.amount)}`);
    if (m.from === 'me') {
      // 我发出的红包：点开只揭晓金额，钱已在发出时扣除
      rp.status = 'opened';
      rp.openedAt = now();
      m.read = true;
      await saveContact(c);
      if (state.currentContactId === cid) { await renderChatIncremental(cid); refreshRpCard(m); }
      return;
    }
    // 联系人发来的红包：点开领取，进余额并记流水
    const t = now();
    const created = Number(rp.createdAt) || Number(m.time) || t;
    if (t >= created + DAY) {
      rp.status = 'expired';
      rp.expiredAt = created + DAY;
      await saveContact(c);
      if (state.currentContactId === cid) { await renderChatIncremental(cid); refreshRpCard(m); }
      return toast('红包已过期');
    }
    const w = await getWallet();
    const amount = round2(rp.amount);
    w.balance = round2(w.balance + amount);
    rp.status = 'opened';
    rp.openedAt = t;
    m.read = true;
    await dbPut('wallet', w);
    await addLedger({ time: t, peer: c.name, amount, dir: 'in' });
    await saveContact(c);
    if (state.currentContactId === cid) { await renderChatIncremental(cid); refreshRpCard(m); }
    toast(`已领取 ¥${fmtMoney(amount)}`);
  });
}

export function walletResume() {
  return state.currentContactId ? walletTick(state.currentContactId) : Promise.resolve();
}

// ============ 初始化（延迟挂 window，供内联事件调用） ============
export function initWalletModule() {
  window.openWallet = openWallet;
  window.renderWalletPage = renderWalletPage;
  window.walletSaveSettings = walletSaveSettings;
  window.walletSaveContactSettings = walletSaveContactSettings;
  window.walletToggleRp = walletToggleRp;
  window.openRedPacketPanel = openRedPacketPanel;
  window.rpSelectCard = rpSelectCard;
  window.rpQuick = rpQuick;
  window.sendRedPacket = sendRedPacket;
  window.openRedPacket = openRedPacket;
  window.__walletOnChatOpen = (cid) => walletTick(cid);
  window.__walletResume = walletResume;
  window.__walletSettingsHtml = (cid) => walletSettingsHtml(cid);

  // 聊天页打开时低频检查当前联系人（只读这一位，不进 60 秒全量补算）
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const pg = $('page-chat');
    if (!pg || !pg.classList.contains('active')) return;
    const cid = state.currentContactId;
    if (!cid) return;
    walletTick(cid);
  }, 20000);
}
