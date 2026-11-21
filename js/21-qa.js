// 问答：出题 → 双方各选一个 → 对方按状态延时选择 → 同时揭示 → 记录回看
// 依赖：01-state.js / 02-core.js / 03-data.js
import { state, uid } from './01-state.js';
import { $, dbGet, dbPut, escapeHtml, formatTime, now, randInt, toast } from './02-core.js';
import { getContact, getStatusCategories, getStatusPool, openChat, openPage, saveContact } from './03-data.js';

const REC_PREFIX = 'qa_records_';
const DELAY_RANGE = { present: [2000, 4000], leisure: [4000, 8000], event: [12000, 20000] };
const MAX_DELAY = 21000;

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
function recKey(cid) { return REC_PREFIX + cid; }

export async function getQaRecords(cid) {
  if (!cid) return [];
  const key = recKey(cid);
  await waitChain(key);
  const r = await dbGet('meta', key);
  return (r && Array.isArray(r.list)) ? r.list : [];
}
function saveRecords(cid, list) {
  const key = recKey(cid);
  return serialized(key, async () => {
    await dbPut('meta', { k: key, list });
    return true;
  });
}
async function enqueue(fn) {
  if (typeof window.__enqueueTask === 'function') return window.__enqueueTask(fn);
  return fn();
}
async function statusCat(c) {
  const [pool, cats] = await Promise.all([getStatusPool(), getStatusCategories()]);
  const st = pool.find(s => s.id === c.statusId) || pool.find(s => s.name === c.status);
  const cat = st ? cats.find(x => x.id === st.category) : null;
  return cat ? cat.id : 'present';
}

/* ============ 发起问答面板 ============ */
let _opts = ['', ''];
let _submitting = false;

function renderQaOptions() {
  const box = $('qa-options');
  if (!box) return;
  box.innerHTML = _opts.map((v, i) => `
    <div class="qa-opt-row">
      <span class="qa-index">${i + 1}</span>
      <input class="input qa-opt-input" value="${escapeHtml(v)}" placeholder="选项 ${i + 1}" oninput="qaOptionInput(${i},this.value)">
      ${_opts.length > 2 ? `<button class="qa-opt-del" title="删除选项" onclick="qaRemoveOption(${i})"><svg class="i i-sm"><use href="#icon-close"/></svg></button>` : ''}
    </div>`).join('');
}

export function openQaPanel() {
  if (!state.currentContactId) return toast('请先打开一位联系人');
  _opts = ['', ''];
  _submitting = false;
  const q = $('qa-question'); if (q) q.value = '';
  renderQaOptions();
  const panel = $('qa-panel');
  if (panel) panel.classList.remove('hide');
}
export function closeQaPanel() {
  const panel = $('qa-panel');
  if (panel) panel.classList.add('hide');
}
export function qaAddOption() {
  if (_opts.length >= 8) return toast('最多 8 个选项');
  _opts.push('');
  renderQaOptions();
}
export function qaRemoveOption(i) {
  if (_opts.length <= 2) return;
  _opts.splice(i, 1);
  renderQaOptions();
}
export function qaOptionInput(i, v) {
  _opts[i] = v;
}

export async function submitQa() {
  if (_submitting) return;
  const cid = state.currentContactId;
  if (!cid) return toast('请先打开一位联系人');
  const question = (($('qa-question') || {}).value || '').trim();
  if (!question) return toast('请输入问题');
  const opts = _opts.map(s => String(s || '').trim());
  if (opts.length < 2) return toast('至少需要 2 个选项');
  if (opts.some(s => !s)) return toast('选项不能为空');
  const c = await getContact(cid);
  if (!c) return;
  _submitting = true;
  try {
    const cat = await statusCat(c);
    const sleeping = cat === 'sleep';
    const recId = uid();
    const rec = {
      id: recId, cid, question, options: opts, mineIndex: null,
      otherIndex: null, status: sleeping ? 'sleep' : 'waiting',
      createdAt: now(), revealedAt: null, contactName: c.name
    };
    const list = await getQaRecords(cid);
    list.unshift(rec);
    await saveRecords(cid, list);
    const t = now();
    const ok = await enqueue(async () => {
      const cc = await getContact(cid);
      if (!cc) return false;
      cc.messages = cc.messages || [];
      cc.messages.push({
        id: uid(), from: 'me', type: 'qa', time: t, read: true, replyTo: null, snapshot: null,
        qaId: recId,
        qa: { question, options: opts.slice(), mineIndex: null, otherIndex: null, status: rec.status }
      });
      await saveContact(cc);
      return true;
    });
    if (!ok) return toast('发送失败');
    closeQaPanel();
    if (state.currentContactId === cid && typeof window.renderChatIncremental === 'function') {
      await window.renderChatIncremental(cid, { animate: false });
      const box = $('chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    }
    if (!sleeping) {
      const range = DELAY_RANGE[cat] || DELAY_RANGE.present;
      const delay = randInt(range[0], range[1]);
      scheduleReveal(cid, recId, delay);
    }
  } finally {
    _submitting = false;
  }
}

/* 双方都答完才算揭晓：在此之前任何一方都看不到对方的选择 */
function isRevealed(mineIndex, otherIndex) {
  return mineIndex != null && otherIndex != null;
}

/* 发出后我在卡片上选自己的答案；若对方已选，选完立即同时揭示 */
export async function qaPickMine(cid, qaId, idx) {
  if (!cid || !qaId) return;
  const list = await getQaRecords(cid);
  const target = list.find(r => r.id === qaId);
  if (!target) return;
  if (isRevealed(target.mineIndex, target.otherIndex)) return;
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= target.options.length) return;
  target.mineIndex = i;
  const nowReveal = isRevealed(target.mineIndex, target.otherIndex);
  if (nowReveal) {
    target.status = 'done';
    target.revealedAt = now();
  }
  await saveRecords(cid, list);
  await enqueue(async () => {
    const c = await getContact(cid);
    if (!c) return;
    const m = (c.messages || []).find(x => x.qaId === qaId);
    if (!m) return;
    m.qa = m.qa || {};
    m.qa.mineIndex = i;
    if (nowReveal) {
      m.qa.otherIndex = target.otherIndex;
      m.qa.status = 'done';
    }
    await saveContact(c);
  });
  if (state.currentContactId === cid) {
    const pc = $('page-chat');
    if (pc && pc.classList.contains('active') && typeof window.renderChatIncremental === 'function') {
      window.renderChatIncremental(cid, { animate: false });
    }
    if ($('page-qa-list') && $('page-qa-list').classList.contains('active')) renderQaList();
    if ($('page-qa-detail') && $('page-qa-detail').classList.contains('active') && state.qaDetailId === qaId) renderQaDetail(qaId);
  }
}

/* ============ 对方选择与揭示 ============ */
const timers = new Map();
function scheduleReveal(cid, recId, delay) {
  const key = cid + '|' + recId;
  if (timers.has(key)) return;
  const t = setTimeout(() => {
    timers.delete(key);
    revealQa(cid, recId).catch(() => {});
  }, Math.max(200, delay));
  timers.set(key, t);
}

async function revealQa(cid, recId) {
  const list = await getQaRecords(cid);
  const rec = list.find(r => r.id === recId);
  if (!rec || rec.otherIndex != null) return false;
  const idx = Math.floor(Math.random() * rec.options.length);
  rec.otherIndex = idx;
  // 对方已选但还没揭晓：只有我也选完，才写入揭示时间并同时展示
  const nowReveal = isRevealed(rec.mineIndex, rec.otherIndex);
  rec.status = nowReveal ? 'done' : 'waiting';
  if (nowReveal) rec.revealedAt = now();
  await saveRecords(cid, list);
  await enqueue(async () => {
    const c = await getContact(cid);
    if (!c) return;
    const m = (c.messages || []).find(x => x.qaId === recId);
    if (!m) return;
    m.qa = m.qa || {};
    m.qa.otherIndex = idx;
    m.qa.status = rec.status;
    await saveContact(c);
  });
  if (state.currentContactId === cid) {
    const pc = $('page-chat');
    if (pc && pc.classList.contains('active') && typeof window.renderChatIncremental === 'function') {
      window.renderChatIncremental(cid, { animate: false });
    }
    if ($('page-qa-list') && $('page-qa-list').classList.contains('active')) renderQaList();
    if ($('page-qa-detail') && $('page-qa-detail').classList.contains('active') && state.qaDetailId === recId) renderQaDetail(recId);
  }
  return true;
}

/* ============ 记录列表 / 详情 ============ */
export async function openQaList() {
  closeQaPanel();
  if (!state.currentContactId) return toast('请先打开一位联系人');
  await renderQaList();
  openPage('page-qa-list');
}
export function backFromQaList() {
  if (state.currentContactId) openChat(state.currentContactId);
  else openPage('page-me');
}
export async function renderQaList() {
  const box = $('qa-list');
  if (!box) return;
  const cid = state.currentContactId;
  const list = await getQaRecords(cid);
  if (!list.length) { box.innerHTML = '<div class="empty">还没有问答记录</div>'; return; }
  const c = await getContact(cid);
  box.innerHTML = `<div class="qa-list-head">${escapeHtml((c && c.name) || '')} · 共 ${list.length} 条</div>` +
    list.map(r => {
      const revealed = isRevealed(r.mineIndex, r.otherIndex);
      const st = revealed ? '已揭晓' : (r.mineIndex == null ? '待我选择' : (r.status === 'sleep' ? '对方在睡觉' : '等待对方选择'));
      return `<div class="qa-rec-item" onclick="openQaDetail('${r.id}')">
        <div class="qa-rec-q">${escapeHtml(r.question)}</div>
        <div class="qa-rec-meta"><span>${escapeHtml(formatTime(r.createdAt))}</span><span class="qa-badge">${st}</span></div>
      </div>`;
    }).join('');
}

export async function openQaDetail(id) {
  state.qaDetailId = id;
  await renderQaDetail(id);
  openPage('page-qa-detail');
}
export function backFromQaDetail() {
  openPage('page-qa-list');
  renderQaList();
}
export async function renderQaDetail(id) {
  const box = $('qa-detail');
  if (!box) return;
  const list = await getQaRecords(state.currentContactId);
  const r = list.find(x => x.id === id);
  if (!r) { box.innerHTML = '<div class="empty">记录不存在</div>'; return; }
  const revealed = isRevealed(r.mineIndex, r.otherIndex);
  const rows = r.options.map((o, i) => {
    const isMine = r.mineIndex != null && i === r.mineIndex;
    const isOther = revealed && i === r.otherIndex;
    return `<div class="qa-opt${isMine ? ' picked mine' : ''}${isOther ? ' picked other' : ''}">
      <span class="qa-opt-text">${escapeHtml(o)}</span>
      ${isMine ? '<span class="qa-tag">我</span>' : ''}
      ${isOther ? '<span class="qa-tag">对方</span>' : ''}
    </div>`;
  }).join('');
  const foot = `发起：${escapeHtml(formatTime(r.createdAt))}${revealed ? ` · 揭晓：${escapeHtml(formatTime(r.revealedAt))}` : (r.mineIndex == null ? ' · 尚未选择你的答案' : (r.status === 'sleep' ? ' · 对方在睡觉，未回答' : ' · 等待对方选择'))}`;
  box.innerHTML = `<div class="qa-detail-card">
    <div class="qa-detail-q">${escapeHtml(r.question)}</div>
    <div class="qa-opts">${rows}</div>
    <div class="qa-detail-foot">${foot}</div>
  </div>`;
}

/* ============ 启动补算：把超时未回答的问答补上 ============ */
export async function initQaModule() {
  const { getAllContacts } = await import('./03-data.js');
  const contacts = await getAllContacts();
  for (const c of contacts) {
    const list = await getQaRecords(c.id);
    if (!list.length) continue;
    const cat = await statusCat(c);
    let dirty = false;
    for (const r of list) {
      if (r.otherIndex != null) continue;
      if (cat === 'sleep') {
        if (r.status !== 'sleep') { r.status = 'sleep'; dirty = true; }
        continue;
      }
      const elapsed = now() - (r.createdAt || 0);
      if (elapsed >= MAX_DELAY) scheduleReveal(c.id, r.id, 800);
      else scheduleReveal(c.id, r.id, Math.max(800, MAX_DELAY - elapsed));
    }
    if (dirty) await saveRecords(c.id, list);
  }
}
