// 依赖：03-data.js
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, dbAll, dbGet, dbPut, escapeHtml, formatTime, now, pick, randInt, showModal, toast } from './02-core.js';
import { getAllContacts, getMe, openPage } from './03-data.js';

/* ============ 心情日历 + 灵感随记 ============
   存储（meta store，keyPath 'k'）：
   - 我的心情：mood:me:YYYY-MM-DD → { k, emoji, text, ts }
   - 联系人心情：mood:{contactId}:YYYY-MM-DD → { k, emoji, text, ts }（skip:true 表示当天判定为留白）
   - 灵感随记：inspirations → { k, list:[{id,text,ts}] } */

const MOOD_GROUPS = [
  { label: '开心', emojis: ['😊', '🥳', '😍', '😎', '😌', '🤗'] },
  { label: '负面', emojis: ['😢', '😭', '😡', '😰', '😔', '😤', '🥺'] },
  { label: '日常', emojis: ['😐', '🥱', '🤔', '🤒', '😵', '🤯', '🥴'] },
];
const ALL_MOOD_EMOJIS = MOOD_GROUPS.flatMap(g => g.emojis);
const DEFAULT_MOOD_TEXTS = ['今天也是平常的一天～', '晚安～', '天气不错', '有点想你', '忙碌的一天', '随便逛逛'];

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function moodKey(role, ds) { return `mood:${role}:${ds}`; }
// 兼容旧结构：{emoji,text,ts} → {records:[{emoji,text,ts}]}，返回统一结构，无有效记录返回 null
function normMood(r) {
  if (!r || r.skip) return null;
  if (Array.isArray(r.records)) {
    const recs = r.records
      .filter(x => x && x.emoji)
      .map(x => ({ emoji: x.emoji, text: x.text || '', ts: x.ts || r.ts || now() }));
    return recs.length ? { k: r.k, records: recs } : null;
  }
  if (r.emoji) return { k: r.k, records: [{ emoji: r.emoji, text: r.text || '', ts: r.ts || now() }] };
  return null;
}
// 取最新一条记录（日历格子展示用）
function lastRecord(m) {
  return (m && m.records && m.records.length) ? m.records[m.records.length - 1] : null;
}
function timeHM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
async function getMood(role, ds) {
  return normMood(await dbGet('meta', moodKey(role, ds)));
}
async function getMonthMoods(role, y, m) {
  const prefix = `mood:${role}:${y}-${String(m + 1).padStart(2, '0')}-`;
  const all = await dbAll('meta');
  const map = {};
  for (const r of all) {
    if (r.k && r.k.startsWith(prefix) && !r.skip) {
      const n = normMood(r);
      if (n) map[r.k.slice(prefix.length)] = n;
    }
  }
  return map;
}

// ---- 页面入口与角色切换（抽屉式联系人菜单） ----
export async function openMoodPage() {
  openPage('page-mood');
  // 当前选中的联系人可能已被删除，回退到“我的心情”
  if (state.moodRole !== 'me') {
    const contacts = await getAllContacts();
    if (!contacts.some(c => c.id === state.moodRole)) state.moodRole = 'me';
  }
  renderMoodCalendar();
}
// 抽屉：渲染“我的心情” + 全部联系人（头像 + 名字）
export async function renderMoodDrawer() {
  const list = $('mood-drawer-list'); if (!list) return;
  const me = await getMe();
  const contacts = await getAllContacts();
  const items = [
    { id: 'me', name: '我的心情', avatar: (me && me.avatar) || DEFAULT_AVATAR },
    ...contacts.map(c => ({ id: c.id, name: c.name, avatar: c.avatar || DEFAULT_AVATAR }))
  ];
  if (!items.some(t => t.id === state.moodRole)) state.moodRole = 'me';
  list.innerHTML = items.map(t =>
    `<button class="mood-drawer-item${state.moodRole === t.id ? ' sel' : ''}" onclick="pickMoodRole('${t.id}')">` +
    `<img src="${escapeHtml(t.avatar)}" alt=""><span class="md-name">${escapeHtml(t.name)}</span></button>`
  ).join('');
}
export function toggleMoodDrawer(open) {
  const m = $('mood-drawer'); if (!m) return;
  if (open) {
    renderMoodDrawer();
    m.classList.remove('hide');
  } else {
    m.classList.add('hide');
  }
}
// 抽屉中点选某个人：关闭抽屉并切换日历数据
export function pickMoodRole(role) {
  state.moodRole = role;
  toggleMoodDrawer(false);
  renderMoodCalendar();
}
export function switchMoodRole(role) {
  state.moodRole = role;
  renderMoodDrawer();
  renderMoodCalendar();
}

// ---- 日历渲染 ----
export function moodPrevMonth() { shiftMoodMonth(-1); }
export function moodNextMonth() { shiftMoodMonth(1); }
function shiftMoodMonth(d) {
  const c = state.moodCursor;
  let m = c.m + d, y = c.y;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.moodCursor = { y, m };
  renderMoodCalendar();
}
export async function renderMoodCalendar() {
  const grid = $('mood-cal-grid'); if (!grid) return;
  const { y, m } = state.moodCursor;
  $('mood-cal-title').textContent = `${y}年${m + 1}月`;
  const records = await getMonthMoods(state.moodRole, y, m);
  const days = new Date(y, m + 1, 0).getDate();
  const todayDs = dateStr(new Date());
  let html = '';
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) html += '<div class="mood-day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const dStr = String(d).padStart(2, '0');
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${dStr}`;
    const rec = records[dStr];
    const last = lastRecord(rec);
    html += `<button class="mood-day${ds === todayDs ? ' today' : ''}" onclick="openMoodDay('${ds}')">` +
      `<span class="d-num">${d}</span><span class="d-emoji">${last ? last.emoji : ''}</span></button>`;
  }
  grid.innerHTML = html;
}

// ---- 点击日期：我 → 时间线 + 追加面板；联系人 → 只读时间线 ----
// 今日心情时间线（升序）
function moodTimelineHtml(mood, who) {
  const recs = mood && mood.records ? mood.records.slice().sort((a, b) => a.ts - b.ts) : [];
  if (!recs.length) {
    return `<div class="mood-tl-empty">今天还没有记录哦</div>`;
  }
  const title = who ? `${who} 的心情时间线` : '今日心情时间线';
  return `<div class="mood-tl-title">${escapeHtml(title)} · ${recs.length} 条</div>` +
    `<div class="mood-timeline">` +
    recs.map(r =>
      `<div class="mood-tl-item">` +
      `<span class="tl-time">${timeHM(r.ts)}</span>` +
      `<span class="tl-emoji">${r.emoji}</span>` +
      `<span class="tl-text">${escapeHtml(r.text || '')}</span>` +
      `</div>`
    ).join('') +
    `</div>`;
}
// 追加新心情面板
function moodAppendHtml() {
  return `<div class="mood-tl-title" style="margin-top:18px;">追加新心情</div>` +
    MOOD_GROUPS.map(g =>
      `<div class="mood-emoji-group"><div class="g-label">${g.label}</div><div class="mood-emoji-row">` +
      g.emojis.map(e =>
        `<button class="mood-emoji-btn" data-e="${e}" onclick="pickMoodEmoji('${e}')">${e}</button>`
      ).join('') + `</div></div>`
    ).join('') +
    `<textarea class="textarea" id="mood-edit-text" placeholder="写一句当时的想法…" style="min-height:70px;width:100%;margin-top:8px;"></textarea>`;
}
export async function openMoodDay(ds) {
  const role = state.moodRole || 'me';
  const mood = await getMood(role, ds);
  if (role === 'me') {
    state._moodEdit = { date: ds, emoji: null };
    showModal(`${ds} 心情记录`, moodTimelineHtml(mood) + moodAppendHtml(), [
      { label: '关闭', cls: 'btn-outline', onClick: closeModal },
      { label: '保存新增', onClick: saveMyMood }
    ]);
  } else {
    if (!mood) { toast('Ta 这一天没有留下心情'); return; }
    const contacts = await getAllContacts();
    const c = contacts.find(x => x.id === role);
    showModal(`${c ? escapeHtml(c.name) : 'Ta'} · ${ds}`, moodTimelineHtml(mood, c ? c.name : 'Ta'));
  }
}
export function pickMoodEmoji(e) {
  if (!state._moodEdit) return;
  state._moodEdit.emoji = e;
  document.querySelectorAll('.mood-emoji-btn').forEach(b => b.classList.toggle('sel', b.dataset.e === e));
}
// 追加保存：在 records 末尾 push 一条，历史不覆盖
export async function saveMyMood() {
  const ed = state._moodEdit; if (!ed) return;
  if (!ed.emoji) { toast('先选一个心情 Emoji'); return; }
  const textEl = $('mood-edit-text');
  const text = (textEl ? textEl.value : '').trim();
  const key = moodKey('me', ed.date);
  const cur = normMood(await dbGet('meta', key)) || { k: key, records: [] };
  const recs = cur.records.slice();
  recs.push({ emoji: ed.emoji, text, ts: now() });
  await dbPut('meta', { k: key, records: recs });
  state._moodEdit = null;
  renderMoodCalendar();
  toast('心情已记录');
  // 重新打开弹窗，让新记录出现在时间线里
  await openMoodDay(ed.date);
}

// ---- 联系人每日随机心情补算（由 08-main.js 的 runCatchUp 调用） ----
export async function ensureDailyMoods(c, t) {
  const d = new Date(t);
  const key = moodKey(c.id, dateStr(d));
  const exist = await dbGet('meta', key);
  if (exist) return;
  // 30% 概率留白：写入 skip 标记，保证当天不会重复判定
  if (Math.random() < 0.3) {
    await dbPut('meta', { k: key, skip: true, ts: t });
    return;
  }
  const cards = (c.cardGroups || []).flatMap(g => g.cards || []);
  const text = cards.length ? pick(cards).content : pick(DEFAULT_MOOD_TEXTS);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 时间戳：当天 8:00 ~ 23:00 之间的随机时间（不超过当前时刻）
  let ts = startOfDay + randInt(8 * 3600, 23 * 3600) * 1000 + randInt(0, 59999);
  if (ts > t) ts = t;
  await dbPut('meta', { k: key, records: [{ emoji: pick(ALL_MOOD_EMOJIS), text, ts }] });
}

/* ============ 灵感随记 ============ */
async function getInspirations() {
  const r = await dbGet('meta', 'inspirations');
  return (r && r.list) || [];
}
async function saveInspirations(list) {
  await dbPut('meta', { k: 'inspirations', list });
}
export function openInspirationPage() {
  openPage('page-inspiration');
  renderInspirations();
}
export async function renderInspirations() {
  const box = $('insp-list'); if (!box) return;
  const list = (await getInspirations()).slice().sort((a, b) => b.ts - a.ts);
  if (!list.length) {
    box.innerHTML = '<div class="insp-empty">还没有灵感随记，在上方写下第一条吧</div>';
    return;
  }
  box.innerHTML = list.map(it =>
    `<div class="insp-item" onclick="editInspiration('${it.id}')">` +
    `<div class="it-text">${escapeHtml(it.text)}</div>` +
    `<div class="it-time">${formatTime(it.ts)}</div></div>`
  ).join('');
}
export async function addInspiration() {
  const inp = $('insp-input'); if (!inp) return;
  const text = inp.value.trim();
  if (!text) { toast('先写点内容'); return; }
  const list = await getInspirations();
  list.push({ id: uid(), text, ts: now() });
  await saveInspirations(list);
  inp.value = '';
  renderInspirations();
  toast('已记录');
}
export async function editInspiration(id) {
  const list = await getInspirations();
  const it = list.find(x => x.id === id);
  if (!it) return;
  state._inspEditId = id;
  const body = `<textarea class="textarea" id="insp-edit-text" style="min-height:120px;width:100%;">${escapeHtml(it.text)}</textarea>`;
  showModal('编辑灵感', body, [
    { label: '删除', cls: 'btn-danger', onClick: deleteInspiration },
    { label: '取消', cls: 'btn-outline', onClick: closeModal },
    { label: '保存', onClick: saveInspirationEdit }
  ]);
}
export async function saveInspirationEdit() {
  const id = state._inspEditId; if (!id) return;
  const textEl = $('insp-edit-text');
  const text = (textEl ? textEl.value : '').trim();
  if (!text) { toast('内容不能为空'); return; }
  const list = await getInspirations();
  const it = list.find(x => x.id === id);
  if (it) { it.text = text; await saveInspirations(list); }
  state._inspEditId = null;
  closeModal();
  renderInspirations();
  toast('已保存');
}
export async function deleteInspiration() {
  const id = state._inspEditId; if (!id) return;
  const list = (await getInspirations()).filter(x => x.id !== id);
  await saveInspirations(list);
  state._inspEditId = null;
  closeModal();
  renderInspirations();
  toast('已删除');
}

// ---- 模块初始化（由 08-main.js 的 initApp 调用） ----
export function initMoodModule() {
  const n = new Date();
  state.moodRole = 'me';
  state.moodCursor = { y: n.getFullYear(), m: n.getMonth() };
}
export function initInspirationModule() {
  renderInspirations();
}
