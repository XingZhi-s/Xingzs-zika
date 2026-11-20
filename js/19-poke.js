// 拍一拍：两套文案池（我拍别人 / 对方拍我）+ 概率判定 + 浮层与系统提示行
// 依赖：01-state.js / 02-core.js；联系人与状态数据按需动态引入，避免模块循环
import { state, uid } from './01-state.js';
import { $, confirmDialog, dbGet, dbPut, escapeHtml, inputDialog, now, toast } from './02-core.js';

const MINE_KEY = 'poke_mine_v1';
const THEIRS_PREFIX = 'poke_theirs_';
const CFG_PREFIX = 'poke_cfg_';
const HOUR = 3600 * 1000;
const DEFAULT_CHANCE = 20;

export const POKE_MINE_DEFAULTS = ['拍了拍{name}的头', '戳了戳{name}的脸颊', '拍了拍{name}的肩膀'];
export const POKE_THEIRS_DEFAULTS = ['拍了拍我的头', '戳了戳我的脸颊', '拍了拍我的肩膀'];

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

function keyOf(kind, cid) {
  return kind === 'mine' ? MINE_KEY : THEIRS_PREFIX + cid;
}
function defaultsOf(kind) {
  return (kind === 'mine' ? POKE_MINE_DEFAULTS : POKE_THEIRS_DEFAULTS).slice();
}
function clampChance(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_CHANCE;
  return Math.max(0, Math.min(100, n));
}

async function getList(kind, cid) {
  const key = keyOf(kind, cid);
  await waitChain(key);
  const rec = await dbGet('meta', key);
  if (!rec) return defaultsOf(kind);
  return Array.isArray(rec.list) ? rec.list.slice() : defaultsOf(kind);
}
function putList(kind, cid, list) {
  const key = keyOf(kind, cid);
  return serialized(key, async () => { await dbPut('meta', { k: key, list: list.slice() }); });
}

export function getPokeMineList() { return getList('mine'); }
export function getPokeTheirsList(cid) {
  if (!cid) return Promise.resolve(POKE_THEIRS_DEFAULTS.slice());
  return getList('theirs', cid);
}

export async function getPokeChance(cid) {
  if (!cid) return DEFAULT_CHANCE;
  const key = CFG_PREFIX + cid;
  await waitChain(key);
  const rec = await dbGet('meta', key);
  return rec && typeof rec.chance === 'number' ? clampChance(rec.chance) : DEFAULT_CHANCE;
}

function updateCfg(cid, patch) {
  const key = CFG_PREFIX + cid;
  return serialized(key, async () => {
    const rec = (await dbGet('meta', key)) || { k: key, chance: DEFAULT_CHANCE };
    rec.k = key;
    Object.assign(rec, patch);
    await dbPut('meta', rec);
    return rec;
  });
}

/* ============ 设置页片段（联系人设置「拍一拍」板块） ============ */
function lineHtml(kind, i, text) {
  return `<div class="poke-line">
    <span class="poke-line-text">${escapeHtml(text)}</span>
    <span class="poke-line-acts">
      <button onclick="pokeEditLine('${kind}',${i})" title="编辑"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
      <button onclick="pokeDeleteLine('${kind}',${i})" title="删除"><svg class="i i-sm"><use href="#icon-trash"/></svg></button>
    </span>
  </div>`;
}
function linesHtml(kind, list) {
  if (!list.length) return `<div class="poke-empty">还没有文案，点击下方按钮添加</div>`;
  return `<div class="poke-list">${list.map((t, i) => lineHtml(kind, i, t)).join('')}</div>`;
}

export async function getPokeSectionHtml(cid) {
  const [mine, theirs, chance] = await Promise.all([getPokeMineList(), getPokeTheirsList(cid), getPokeChance(cid)]);
  return `
    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-heart"/></svg> 拍一拍</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">我拍别人时用（全局共用）</span>
          <span class="cs-value">${mine.length} 条</span>
        </div>
        ${linesHtml('mine', mine)}
        <button class="btn btn-ghost" style="width:100%;margin:8px 0 4px;" onclick="pokeAddLine('mine')">＋ 添加文案</button>
        <div class="cs-row" style="border-top:1px solid var(--border-color);">
          <span class="cs-label">对方拍我时用（本联系人独立）</span>
          <span class="cs-value">${theirs.length} 条</span>
        </div>
        ${linesHtml('theirs', theirs)}
        <button class="btn btn-ghost" style="width:100%;margin:8px 0 4px;" onclick="pokeAddLine('theirs')">＋ 添加文案</button>
        <div class="cs-row" style="border-top:1px solid var(--border-color);">
          <span class="cs-label">对方拍我概率</span>
          <span class="cs-value" style="gap:6px;">
            <input type="number" min="0" max="100" step="1" value="${chance}" id="poke-chance" style="width:70px;" onchange="pokeSaveChance(this.value)">
            <span class="cs-unit">%</span>
          </span>
        </div>
        <div class="cs-hint">每小时判定一次，可调 0–100；睡觉类状态不会拍。文案中的 {name} 会替换为对方名字或我的名字。</div>
      </div>
    </div>`;
}

async function refreshSettings(cid) {
  if (typeof window.openContactSetting === 'function') {
    try { await window.openContactSetting(cid, state.csFromPage); } catch (e) {}
  }
}

export async function pokeAddLine(kind) {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  const r = await inputDialog('添加拍一拍文案', [{
    key: 'text', label: '文案',
    value: kind === 'mine' ? '拍了拍{name}' : '拍了拍我的头', required: true
  }]);
  if (!r) return;
  const t = (r.text || '').trim();
  if (!t) return toast('文案不能为空');
  const list = await getList(kind, cid);
  list.push(t);
  await putList(kind, cid, list);
  await refreshSettings(cid);
}

export async function pokeEditLine(kind, idx) {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  const list = await getList(kind, cid);
  if (idx < 0 || idx >= list.length) return;
  const r = await inputDialog('编辑拍一拍文案', [{ key: 'text', label: '文案', value: list[idx], required: true }]);
  if (!r) return;
  const t = (r.text || '').trim();
  if (!t) return toast('文案不能为空');
  list[idx] = t;
  await putList(kind, cid, list);
  await refreshSettings(cid);
}

export async function pokeDeleteLine(kind, idx) {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  const list = await getList(kind, cid);
  if (idx < 0 || idx >= list.length) return;
  if (!await confirmDialog('删除这条拍一拍文案？')) return;
  list.splice(idx, 1);
  await putList(kind, cid, list);
  await refreshSettings(cid);
}

export async function pokeSaveChance(value) {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  const n = clampChance(value);
  await updateCfg(cid, { chance: n });
  const el = $('poke-chance');
  if (el) el.value = String(n);
  toast(`对方拍我概率：${n}%`);
}

/* ============ 我拍对方：头像双击 → 面板选择 ============ */
export async function openPokePanel() {
  const cid = state.currentContactId;
  if (!cid) return toast('请先打开一位联系人');
  const { getContact } = await import('./03-data.js');
  const c = await getContact(cid);
  if (!c) return;
  const list = await getPokeMineList();
  const panel = $('poke-panel');
  const body = $('poke-panel-list');
  if (!panel || !body) return;
  body.innerHTML = list.length
    ? list.map((t, i) => `<button class="poke-opt" onclick="doPokeFromPanel(${i})">${escapeHtml(t.replace(/\{name\}/g, c.name))}</button>`).join('')
    : `<div class="poke-empty" style="padding:18px 4px;">还没有文案，先去联系人设置的「拍一拍」里添加</div>`;
  panel.classList.remove('hide');
  const box = $('chat-messages');
  if (box) box.scrollTop = box.scrollHeight;
}
export function closePokePanel() {
  const panel = $('poke-panel');
  if (panel) panel.classList.add('hide');
}

export async function doPokeFromPanel(idx) {
  closePokePanel();
  const cid = state.currentContactId;
  if (!cid) return;
  const list = await getPokeMineList();
  const tpl = list[idx];
  if (!tpl) return;
  const text = await enqueue(async () => {
    const { getContact, saveContact } = await import('./03-data.js');
    const c = await getContact(cid);
    if (!c) return '';
    const line = '我' + tpl.replace(/\{name\}/g, c.name);
    const t = now();
    c.messages = c.messages || [];
    c.messages.push({
      id: uid(), from: 'me', type: 'poke', content: line, time: t, replyTo: null, snapshot: null,
      read: true, readAt: t, replyAt: 0, replied: true, replyDone: true
    });
    await saveContact(c);
    return line;
  });
  if (!text) return;
  showPokeFloat(text);
  if (state.currentContactId === cid && typeof window.renderChatIncremental === 'function') {
    window.renderChatIncremental(cid, { animate: false });
  }
}

/* ============ 浮层提示（不是聊天气泡） ============ */
let _floatTimer = null;
export function showPokeFloat(text) {
  const page = $('page-chat');
  if (!page || !page.classList.contains('active')) return;
  let el = $('poke-float');
  if (!el) {
    el = document.createElement('div');
    el.id = 'poke-float';
    el.className = 'poke-float hide';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove('hide');
  // 重新触发淡入
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  if (_floatTimer) clearTimeout(_floatTimer);
  _floatTimer = setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
  }, 2800);
}

/* ============ 对方拍我：每小时概率判定 ============ */
async function enqueue(fn) {
  if (typeof window.__enqueueTask === 'function') return window.__enqueueTask(fn);
  return fn();
}

export async function rollPokeFor(cid) {
  if (!cid) return { ok: false, reason: 'no-cid' };
  const { getContact, getStatusPool, getStatusCategories, getMe, saveContact, renderContacts } = await import('./03-data.js');
  const [c, pool, cats, me] = await Promise.all([getContact(cid), getStatusPool(), getStatusCategories(), getMe()]);
  if (!c) return { ok: false, reason: 'no-contact' };
  const st = pool.find(s => s.id === c.statusId) || pool.find(s => s.name === c.status);
  const cat = st ? cats.find(x => x.id === st.category) : null;
  if (cat && cat.id === 'sleep') return { ok: false, reason: 'sleep' };
  const chance = await getPokeChance(cid);
  const roll = Math.random() * 100;
  if (roll >= chance) return { ok: false, reason: 'chance', chance, roll };
  const list = await getPokeTheirsList(cid);
  if (!list.length) return { ok: false, reason: 'empty' };
  const tpl = list[Math.floor(Math.random() * list.length)];
  const line = c.name + tpl.replace(/\{name\}/g, (me && me.name) || '我');
  const chatOpen = state.currentContactId === cid && $('page-chat') && $('page-chat').classList.contains('active');
  const added = await enqueue(async () => {
    const cc = await getContact(cid);
    if (!cc) return false;
    const t = now();
    cc.messages = cc.messages || [];
    cc.messages.push({
      id: uid(), from: 'other', type: 'poke', content: line, time: t, replyTo: null, snapshot: null,
      read: true, readAt: t, replyAt: 0, replied: true, replyDone: true
    });
    if (!chatOpen) cc.unread = (cc.unread || 0) + 1;
    await saveContact(cc);
    return true;
  });
  if (!added) return { ok: false, reason: 'save-failed' };
  if (chatOpen) {
    showPokeFloat(line);
    if (typeof window.renderChatIncremental === 'function') window.renderChatIncremental(cid, { animate: false });
  } else {
    renderContacts();
  }
  return { ok: true, text: line, chance, roll };
}

async function runPokeChecks() {
  const { getAllContacts } = await import('./03-data.js');
  const list = await getAllContacts();
  const t = now();
  for (const c of list) {
    const key = CFG_PREFIX + c.id;
    await waitChain(key);
    const rec = await dbGet('meta', key);
    if (!rec || !rec.nextAt) {
      await updateCfg(c.id, { nextAt: t + HOUR });
      continue;
    }
    if (t < rec.nextAt) continue;
    await updateCfg(c.id, { nextAt: t + HOUR, lastAt: t });
    try { await rollPokeFor(c.id); } catch (e) {}
  }
}

let _pokeTimer = null;
export function initPokeModule() {
  if (_pokeTimer) return;
  runPokeChecks().catch(() => {});
  _pokeTimer = setInterval(() => { runPokeChecks().catch(() => {}); }, 60000);
}
