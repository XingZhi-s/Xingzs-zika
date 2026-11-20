// 撤回：我撤回最近 5 条 + 联系人按状态随机撤回（1~2 条）
// 依赖：01-state.js / 02-core.js；联系人数据按需动态引入
import { state } from './01-state.js';
import { $, dbGet, dbPut, now, toast } from './02-core.js';

const CFG_PREFIX = 'recall_cfg_';
const TICK = 10 * 60 * 1000;          // 每 10 分钟一次机会
const HOUR = 3600 * 1000;
// 按状态大类的触发概率（%）
const CHANCE = { present: 3, leisure: 2, event: 1, sleep: 0 };
// 决定撤回后到真正生效的延时（毫秒）
const DELAY = { present: 1500, leisure: 5000, event: 12000, sleep: 0 };
const ALLOW_TYPES = ['text', 'image', 'sticker', 'card', 'voice', 'video'];

const chains = new Map();
function serialized(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.catch(() => {}).then(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
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
  const chance = typeof CHANCE[catId] === 'number' ? CHANCE[catId] : CHANCE.present;
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

/* ============ 定时巡检（每 10 分钟给一次机会；首次只排期） ============ */
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

async function runRecallChecks() {
  const { getAllContacts } = await import('./03-data.js');
  const list = await getAllContacts();
  const t = now();
  for (const c of list) {
    const key = CFG_PREFIX + c.id;
    const pending = chains.get(key);
    if (pending) { try { await pending; } catch (e) {} }
    const rec = await dbGet('meta', key);
    if (!rec || !rec.nextAt) { await updateCfg(c.id, { nextAt: t + TICK }); continue; }
    if (t < rec.nextAt) continue;
    await updateCfg(c.id, { nextAt: t + TICK, lastAt: t });
    try { await recallFromContact(c.id); } catch (e) {}
  }
}

let _timer = null;
export function initRecallModule() {
  if (_timer) return;
  runRecallChecks().catch(() => {});
  _timer = setInterval(() => { runRecallChecks().catch(() => {}); }, 60000);
}

// 供测试/外部使用：清除某联系人的排期（不影响消息）
export async function resetRecallSchedule(cid) {
  if (!cid) return;
  await updateCfg(cid, { nextAt: now() + TICK });
}
