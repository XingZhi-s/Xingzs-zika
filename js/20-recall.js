// 撤回：我撤回最近 5 条 + 联系人按状态随机撤回（1~2 条）
// 依赖：01-state.js / 02-core.js；联系人数据按需动态引入
import { state } from './01-state.js';
import { $, dbGet, dbPut, now, toast } from './02-core.js';

const CFG_PREFIX = 'recall_cfg_';
const BATCH = 10;                     // 每累计 10 条「联系人自己发出的消息」给一次机会
const DEFAULT_ENABLED = true;         // 默认允许对方撤回（与旧行为一致）
const DEFAULT_CHANCE = 3;             // 默认概率 3%（旧行为工作日状态下的概率）
// 决定撤回后到真正生效的延时（毫秒）
const DELAY = { present: 1500, leisure: 5000, event: 12000, sleep: 0 };
const ALLOW_TYPES = ['text', 'image', 'sticker', 'card', 'voice', 'video'];
// 计入「联系人自己发出的消息」的类型：系统提示（未接来电/来信提醒/提醒等，带 sysKey）不计
const COUNT_TYPES = ['text', 'image', 'sticker', 'card', 'voice', 'video', 'redpacket', 'transfer', 'choice'];

function countContactAuthored(c) {
  return (c.messages || []).filter(m => m.from === 'other' && !m.sysKey && COUNT_TYPES.indexOf(m.type) !== -1).length;
}

const chains = new Map();
function serialized(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.catch(() => {}).then(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}
async function waitChain(key) {
  const p = chains.get(key);
  if (p) { try { await p; } catch (e) {} }
}
function clampChance(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_CHANCE;
  return Math.max(0, Math.min(100, n));
}

/* ============ 撤回配置（开关 + 概率，按联系人存 meta） ============ */
export async function getRecallConfig(cid) {
  if (!cid) return { enabled: DEFAULT_ENABLED, chance: DEFAULT_CHANCE, nextAt: 0, lastAt: 0 };
  const key = CFG_PREFIX + cid;
  await waitChain(key);
  const rec = await dbGet('meta', key);
  return {
    enabled: rec && typeof rec.enabled === 'boolean' ? rec.enabled : DEFAULT_ENABLED,
    chance: rec && rec.chance != null ? clampChance(rec.chance) : DEFAULT_CHANCE,
    counted: rec && typeof rec.counted === 'number' ? rec.counted : null,
    nextAt: rec && rec.nextAt ? rec.nextAt : 0,
    lastAt: rec && rec.lastAt ? rec.lastAt : 0
  };
}

/* ============ 设置页片段（联系人设置「撤回」板块） ============ */
export async function getRecallSectionHtml(cid) {
  const cfg = await getRecallConfig(cid);
  return `
    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 撤回</div>
      <div class="cs-card">
        <div class="cs-row cs-row-switch">
          <span class="cs-label">允许对方撤回</span>
          <span class="cs-value">
            <div class="switch ${cfg.enabled ? 'on' : ''}" id="recall-switch" role="switch" aria-checked="${cfg.enabled ? 'true' : 'false'}" onclick="toggleRecallEnabled()"></div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">撤回概率</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;">
              <input type="number" min="0" max="100" step="1" value="${cfg.chance}" id="recall-chance" ${cfg.enabled ? '' : 'disabled style="opacity:.45;"'} onchange="recallSaveChance(this.value)">
              <span class="cs-unit">%</span>
            </div>
          </span>
        </div>
        <div class="cs-hint">每累计 10 条对方发出的消息判定一次（只算 Ta 自己发的，不算我发的）：命中后，对方会从自己最近 5 条消息里随机撤回 1~2 条。睡觉类状态不会撤回。</div>
      </div>
    </div>`;
}

export async function toggleRecallEnabled() {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  const cfg = await getRecallConfig(cid);
  const next = !cfg.enabled;
  await updateCfg(cid, { enabled: next });
  const sw = $('recall-switch');
  if (sw) { sw.classList.toggle('on', next); sw.setAttribute('aria-checked', next ? 'true' : 'false'); }
  const inp = $('recall-chance');
  if (inp) {
    inp.disabled = !next;
    inp.style.opacity = next ? '' : '.45';
  }
  toast(next ? '已开启对方撤回' : '已关闭对方撤回');
}

export async function recallSaveChance(value) {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  const n = clampChance(value);
  await updateCfg(cid, { chance: n });
  const el = $('recall-chance');
  if (el) el.value = String(n);
  toast(`对方撤回概率：${n}%`);
}

async function enqueue(fn) {
  if (typeof window.__enqueueTask === 'function') return window.__enqueueTask(fn);
  return fn();
}

/* ============ 我撤回：仅最近 5 条我发出的消息 ============ */
export async function recallMine(msgId) {
  const lp = $('lp-menu'); if (lp) lp.classList.add('hide');
  const cid = state.currentContactId;
  if (!cid || !msgId) return false;
  const ok = await enqueue(async () => {
    const { getContact, saveContact } = await import('./03-data.js');
    const c = await getContact(cid);
    if (!c) return false;
    const msgs = c.messages || [];
    const m = msgs.find(x => x.id === msgId);
    if (!m || m.from !== 'me' || m.type === 'poke' || m.recalled) return false;
    const mine = msgs.filter(x => x.from === 'me' && x.type !== 'poke' && !x.recalled);
    if (!mine.slice(-5).some(x => x.id === msgId)) return false;
    m.recalled = true;
    m.recalledAt = now();
    m.recalledBy = 'me';
    await saveContact(c);
    return true;
  });
  if (!ok) { toast('只能撤回最近 5 条消息'); return false; }
  if (state.currentContactId === cid && typeof window.renderChatIncremental === 'function') {
    window.renderChatIncremental(cid, { animate: false });
  }
  return true;
}

/* ============ 联系人撤回：最近 5 条里随机 1~2 条 ============ */
export async function recallFromContact(cid, opts) {
  const o = opts || {};
  if (!cid) return { ok: false, reason: 'no-cid' };
  const { getContact, getStatusPool, getStatusCategories, saveContact, renderContacts } = await import('./03-data.js');
  const [c, pool, cats] = await Promise.all([getContact(cid), getStatusPool(), getStatusCategories()]);
  if (!c) return { ok: false, reason: 'no-contact' };
  const st = pool.find(s => s.id === c.statusId) || pool.find(s => s.name === c.status);
  const cat = st ? cats.find(x => x.id === st.category) : null;
  const catId = cat ? cat.id : 'present';
  if (catId === 'sleep') return { ok: false, reason: 'sleep' };
  const cfg = await getRecallConfig(cid);
  if (!cfg.enabled && !o.force) return { ok: false, reason: 'disabled' };
  const chance = cfg.chance;
  const roll = Math.random() * 100;
  if (!o.force && roll >= chance) return { ok: false, reason: 'chance', chance, roll };
  const all = (c.messages || []).filter(m => m.from === 'other' && !m.recalled && m.type !== 'poke' && m.type !== 'recall' && ALLOW_TYPES.indexOf(m.type) !== -1);
  if (!all.length) return { ok: false, reason: 'empty' };
  const poolMsgs = all.slice(-5);
  const want = Math.random() < 0.85 ? 1 : 2;
  const picked = poolMsgs.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(want, poolMsgs.length));
  const ids = picked.map(m => m.id);
  const delay = o.delay != null ? o.delay : (DELAY[catId] != null ? DELAY[catId] : DELAY.present);
  const apply = async () => {
    return enqueue(async () => {
      const cc = await getContact(cid);
      if (!cc) return 0;
      const t = now();
      let n = 0;
      for (const m of cc.messages || []) {
        if (ids.indexOf(m.id) === -1) continue;
        if (m.from !== 'other' || m.recalled) continue;
        m.recalled = true;
        m.recalledAt = t;
        m.recalledBy = 'other';
        n++;
      }
      if (n) await saveContact(cc);
      return n;
    });
  };
  const finish = async () => {
    const n = await apply();
    if (n) {
      if (state.currentContactId === cid && $('page-chat') && $('page-chat').classList.contains('active')) {
        if (typeof window.renderChatIncremental === 'function') window.renderChatIncremental(cid, { animate: false });
      } else {
        renderContacts();
      }
    }
    return n;
  };
  if (delay > 0) {
    setTimeout(() => { finish().catch(() => {}); }, delay);
    return { ok: true, ids, count: ids.length, delay, chance, roll };
  }
  const count = await finish();
  return { ok: true, ids, count, delay: 0, chance, roll };
}

/* ============ 巡检：每累计 10 条联系人消息给一次机会（首次只记基线，不补判历史） ============ */
function updateCfg(cid, patch) {
  const key = CFG_PREFIX + cid;
  return serialized(key, async () => {
    const rec = (await dbGet('meta', key)) || { k: key };
    rec.k = key;
    Object.assign(rec, patch);
    await dbPut('meta', rec);
    return rec;
  });
}

let _checking = false;
async function runRecallChecks() {
  if (_checking) return; // 上一轮还没跑完时本轮直接跳过，避免同一批 10 条被重复消费
  _checking = true;
  try {
    await runRecallChecksInner();
  } finally {
    _checking = false;
  }
}

async function runRecallChecksInner() {
  const { getAllContacts } = await import('./03-data.js');
  const list = await getAllContacts();
  for (const c of list) {
    const key = CFG_PREFIX + c.id;
    const pending = chains.get(key);
    if (pending) { try { await pending; } catch (e) {} }
    const rec = await dbGet('meta', key);
    const total = countContactAuthored(c);
    // 首次接入（或旧数据没有 counted）：以当前条数为基线，不对历史消息补判
    if (!rec || typeof rec.counted !== 'number') {
      await updateCfg(c.id, { counted: total });
      continue;
    }
    // 消息被删除后条数回退：重新对齐基线，不清零到负数
    if (total < rec.counted) { await updateCfg(c.id, { counted: total }); continue; }
    // 未满 10 条：继续累计（余数保留，不清零）
    if (total - rec.counted < BATCH) continue;
    // 满 10 条：消耗这一批，掷一次骰（每批最多一次，剩余批次留给下一分钟继续递减）
    await updateCfg(c.id, { counted: rec.counted + BATCH, lastAt: now() });
    // 已关闭该联系人的撤回：只推进计数，不判定
    if (rec.enabled === false) continue;
    try { await recallFromContact(c.id); } catch (e) {}
  }
}

let _timer = null;
export function initRecallModule() {
  if (_timer) return;
  runRecallChecks().catch(() => {});
  _timer = setInterval(() => { runRecallChecks().catch(() => {}); }, 60000);
}

// 供测试/外部使用：把某联系人的计数基线重置为当前消息条数（不影响消息、不清概率配置）
export async function resetRecallSchedule(cid) {
  if (!cid) return;
  const { getContact } = await import('./03-data.js');
  const c = await getContact(cid);
  await updateCfg(cid, { counted: c ? countContactAuthored(c) : 0 });
}
