// 数据导出 / 导入（备份）
// 依赖：01-state.js / 02-core.js / 03-data.js / 07-diy-todo.js
import { state } from './01-state.js';
import { $, closeModal, dbAll, dbDel, dbGet, dbPut, escapeHtml, estimateSizeMB, formatTime, now, showModal, toast } from './02-core.js';
import { createEmptyContact, getAllContacts, getMe, getTheme, openPage, renderContacts, renderMeBrief, saveContact, saveMe, saveTheme } from './03-data.js';
import { applyDIYVariables, renderStorageStats } from './07-diy-todo.js';

/* 备份格式版本：1 = 旧版（07-diy-todo 的导出），2 = 当前按类别导出 */
const BACKUP_VERSION = 2;

const CATS = [
  { id: 'contacts', name: '联系人与字卡', sub: '联系人资料与各项设置（含撤回）、字卡分组与文案、钱包与红包含流水、拍一拍文案与概率' },
  { id: 'chat', name: '聊天记录', sub: '文字与卡片消息；聊天图片、表情包不导出' },
  { id: 'letters', name: '信件与收信箱', sub: '我寄出的信与收到的回信' },
  { id: 'mood', name: '心情', sub: '每日心情记录与灵感随记' },
  { id: 'period', name: '经期', sub: '经期设置与历史记录' },
  { id: 'divine', name: '占卜', sub: '占卜历史记录' },
  { id: 'qa', name: '问答', sub: '问答游戏记录' },
];
const CAT_MAP = {};
CATS.forEach(c => { CAT_MAP[c.id] = c; });

const STATUS_POOL_KEY = 'status_pool_v1';
const STATUS_CAT_KEY = 'status_categories_v1';
const PERIOD_KEY = 'period_record_v1';
const DIVINE_KEY = 'divine_history';
const RECALL_PREFIX = 'recall_cfg_';
const POKE_MINE_KEY = 'poke_mine_v1';
const POKE_THEIRS_PREFIX = 'poke_theirs_';
const POKE_CFG_PREFIX = 'poke_cfg_';
const MOOD_PREFIX = 'mood:';
const INSP_KEY = 'inspirations';
const QA_PREFIX = 'qa_records_';

let _importing = false;

/* ============ 页面 ============ */
export function openBackupPage() {
  renderBackupPage();
  openPage('page-export');
}
export function backFromBackupPage() {
  openPage('page-setting');
}

function renderBackupPage() {
  const box = $('backup-body');
  if (!box) return;
  box.innerHTML = `
    <div class="cs-card" style="margin:0 0 16px;">
      <div class="section-title">选择要导出的内容</div>
      <div class="export-options" id="backup-cats">
        ${CATS.map(c => `
          <label class="export-opt checked">
            <input type="checkbox" value="${c.id}" checked onchange="backupToggleCat(this)">
            <span class="opt-main"><span>${c.name}</span><span class="opt-sub">${c.sub}</span></span>
          </label>`).join('')}
      </div>
      <div class="backup-hint" id="backup-hint"></div>
      <button class="btn" id="backup-export-btn" style="width:100%;" onclick="backupDoExport()">
        <svg class="i i-sm" style="margin-right:6px;fill:none;stroke:#fff;"><use href="#icon-download"/></svg> 导出为 JSON 文件
      </button>
    </div>
    <div class="cs-card" style="margin:0 0 16px;" id="backup-import-card">
      <div class="section-title">从备份恢复</div>
      <div class="backup-hint" style="margin:0 0 12px;">选择备份文件后会先显示摘要（导出时间、版本、文件里实际含哪几类、各类条数），确认后才写入。文件里没有的类别保持原样。</div>
      <button class="btn-outline btn" style="width:100%;" onclick="document.getElementById('backup-import-file').click()">
        <svg class="i i-sm" style="margin-right:6px;"><use href="#icon-upload"/></svg> 选择备份文件
      </button>
      <input type="file" accept="application/json,.json" id="backup-import-file" class="hide" onchange="backupDoImport(this)">
    </div>
    <div class="backup-note">不导出字卡使用统计、音乐音频和图片（头像 / 背景 / 聊天图片）。导入失败会自动回滚，不会留下半套数据。</div>
    <div style="height:20px;"></div>`;
  updateExportBtn();
}

export function backupToggleCat(cb) {
  const label = cb.closest('.export-opt');
  if (label) label.classList.toggle('checked', cb.checked);
  updateExportBtn();
}

function updateExportBtn() {
  const n = document.querySelectorAll('#backup-cats input[type=checkbox]:checked').length;
  const btn = $('backup-export-btn');
  const hint = $('backup-hint');
  if (btn) btn.disabled = n === 0;
  if (hint) hint.textContent = n ? `已选 ${n} 类，导出文件只包含勾选内容` : '请至少勾选一类才能导出';
}

/* ============ 导出 ============ */
function pickContactForBackup(c) {
  const settings = c.settings ? { ...c.settings } : {};
  // 图片不进备份：聊天背景为图片时移除此项，导入时保留本机背景
  if (settings.chatBackground && settings.chatBackground.type === 'image') delete settings.chatBackground;
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    status: c.status,
    statusId: c.statusId,
    statusAuto: c.statusAuto,
    statusSince: c.statusSince,
    nextStatusAt: c.nextStatusAt,
    nextStatusChangeAt: c.nextStatusChangeAt,
    statusSchedule: Array.isArray(c.statusSchedule) ? c.statusSchedule.slice() : [],
    pendingReplies: Array.isArray(c.pendingReplies) ? c.pendingReplies.slice() : [],
    unread: c.unread || 0,
    letterDay: c.letterDay || null,
    manualSwitchAt: c.manualSwitchAt || 0,
    settings,
    cardGroups: (c.cardGroups || []).map(g => ({
      id: g.id, name: g.name, collapsed: !!g.collapsed,
      cards: (g.cards || []).map(x => ({ id: x.id, content: x.content })),
    })),
    anniversaries: Array.isArray(c.anniversaries) ? c.anniversaries.slice() : [],
    missedCalls: Array.isArray(c.missedCalls) ? c.missedCalls.slice() : [],
  };
}

function pickMessageForBackup(m) {
  const copy = { ...m };
  // 图片 / 表情包只保留消息行，不含图片数据
  if (copy.type === 'image' || copy.type === 'sticker') copy.content = null;
  return copy;
}

// 只读取 meta 的键（openKeyCursor 不反序列化 Blob），避免把音乐音频读进内存
function scanMetaKeys(pred) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = state.db.transaction('meta', 'readonly'); } catch (e) { return reject(e); }
    const store = tx.objectStore('meta');
    const keys = [];
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (typeof cur.key === 'string' && pred(cur.key)) keys.push(cur.key);
      cur.continue();
    };
    tx.oncomplete = () => resolve(keys);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getMetaList(keys) {
  const out = [];
  for (const k of keys) {
    const v = await dbGet('meta', k);
    if (v) out.push(v);
  }
  return out;
}

async function buildBackup(cats) {
  const set = new Set(cats);
  const data = {};
  const needsContacts = set.has('contacts') || set.has('chat') || set.has('letters');
  const contacts = needsContacts ? await getAllContacts() : [];

  if (set.has('contacts')) {
    const pokeKeys = [POKE_MINE_KEY];
    const recallKeys = [];
    for (const c of contacts) {
      pokeKeys.push(POKE_THEIRS_PREFIX + c.id, POKE_CFG_PREFIX + c.id);
      recallKeys.push(RECALL_PREFIX + c.id);
    }
    const [statusPool, statusCategories, poke, recall, wallet] = await Promise.all([
      dbGet('meta', STATUS_POOL_KEY),
      dbGet('meta', STATUS_CAT_KEY),
      getMetaList(pokeKeys),
      getMetaList(recallKeys),
      dbAll('wallet'),
    ]);
    data.contacts = {
      list: contacts.map(pickContactForBackup),
      statusPool: statusPool || null,
      statusCategories: statusCategories || null,
      poke,
      recall,
      wallet,
    };
  }
  if (set.has('chat')) {
    data.chat = {
      list: contacts
        .map(c => ({ id: c.id, name: c.name, messages: (c.messages || []).map(pickMessageForBackup) }))
        .filter(x => x.messages.length),
    };
  }
  if (set.has('letters')) {
    data.letters = {
      list: contacts
        .filter(c => (c.letters || []).length)
        .map(c => ({ id: c.id, name: c.name, letters: (c.letters || []).map(l => ({ ...l })) })),
    };
  }
  if (set.has('mood')) {
    const keys = await scanMetaKeys(k => k.indexOf(MOOD_PREFIX) === 0);
    data.mood = { items: await getMetaList(keys), inspirations: (await dbGet('meta', INSP_KEY)) || null };
  }
  if (set.has('period')) {
    data.period = { record: (await dbGet('meta', PERIOD_KEY)) || null };
  }
  if (set.has('divine')) {
    data.divine = { record: (await dbGet('meta', DIVINE_KEY)) || null };
  }
  if (set.has('qa')) {
    const keys = await scanMetaKeys(k => k.indexOf(QA_PREFIX) === 0);
    data.qa = { list: await getMetaList(keys) };
  }

  return {
    app: '星之匙',
    format: 'xingz-backup',
    version: BACKUP_VERSION,
    exportTime: now(),
    categories: cats.slice(),
    data,
  };
}

export async function backupDoExport() {
  const cats = Array.from(document.querySelectorAll('#backup-cats input[type=checkbox]:checked')).map(x => x.value);
  if (!cats.length) return toast('请至少勾选一类');
  const btn = $('backup-export-btn');
  if (btn) btn.disabled = true;
  toast('正在整理导出数据…', 3000);
  try {
    const payload = await buildBackup(cats);
    let str;
    try {
      str = JSON.stringify(payload);
    } catch (e) {
      throw new Error('序列化失败：' + e.message);
    }
    const blob = new Blob([str], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const d = new Date();
    a.href = url;
    a.download = `星之匙备份_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(`已导出 ${cats.length} 类（${estimateSizeMB(str)} MB）`, 2600);
  } catch (e) {
    console.error(e);
    toast('导出失败：' + (e.message || e));
  } finally {
    updateExportBtn();
  }
}

/* ============ 导入：摘要 ============ */
function confirmSummary(html) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    showModal('导入前确认', html, [
      { label: '取消', cls: 'btn-outline', onClick: () => finish(false) },
      { label: '开始导入', cls: 'btn', onClick: () => finish(true) },
    ], () => finish(false));
  });
}

function sumCards(category) {
  const list = (category && category.list) || [];
  return list.reduce((n, c) => n + (c.cardGroups || []).reduce((m, g) => m + ((g.cards || []).length), 0), 0);
}

function countText(id, category) {
  if (!category) return '无数据';
  if (id === 'contacts') {
    const list = category.list || [];
    return `${list.length} 位联系人 · ${sumCards(category)} 张字卡`;
  }
  if (id === 'chat') {
    const list = category.list || [];
    const total = list.reduce((s, x) => s + (x.messages || []).length, 0);
    const noImg = list.reduce((s, x) => s + (x.messages || []).filter(m => (m.type === 'image' || m.type === 'sticker') && m.content == null).length, 0);
    return noImg ? `${total} 条消息（${noImg} 条不含图片）` : `${total} 条消息`;
  }
  if (id === 'letters') {
    const n = (category.list || []).reduce((s, x) => s + ((x.letters || []).length), 0);
    return `${n} 封信`;
  }
  if (id === 'mood') {
    const days = (category.items || []).length;
    const insp = category.inspirations && Array.isArray(category.inspirations.list) ? category.inspirations.list.length : 0;
    return `${days} 天记录${insp ? ` · 灵感 ${insp} 条` : ''}`;
  }
  if (id === 'period') {
    const r = category.record || {};
    const n = Array.isArray(r.history) ? r.history.length : 0;
    return `${n} 条历史`;
  }
  if (id === 'divine') {
    const r = category.record || {};
    return `${Array.isArray(r.list) ? r.list.length : 0} 条记录`;
  }
  if (id === 'qa') {
    const n = (category.list || []).reduce((s, x) => s + (Array.isArray(x.list) ? x.list.length : 0), 0);
    return `${n} 条记录`;
  }
  return '无数据';
}

function summaryHtml(metaLine, riskyHtml, rows) {
  return `<div class="backup-sum">
    <div class="backup-sum-meta">${metaLine}</div>
    ${riskyHtml || ''}
    <div class="backup-sum-list">${rows.join('')}</div>
    <div class="backup-sum-note">文件里没有的类别不会被改动。导入前会记录内存快照，任一环节失败自动回滚。</div>
  </div>`;
}

function describeNew(obj) {
  const data = obj.data || {};
  const cats = (Array.isArray(obj.categories) ? obj.categories : []).filter(id => CAT_MAP[id] && data[id]);
  const rows = cats.map(id => `<div class="backup-sum-row"><span>${CAT_MAP[id].name}</span><span>${escapeHtml(countText(id, data[id]))}</span></div>`);
  const version = Number(obj.version);
  const risky = version !== BACKUP_VERSION
    ? `<div class="backup-warn">该文件版本为 v${escapeHtml(String(obj.version))}，与本机 v${BACKUP_VERSION} 不一致，个别字段可能无法恢复，仍可继续。</div>`
    : '';
  const when = obj.exportTime ? formatTime(obj.exportTime) : '未知';
  return summaryHtml(`导出时间：${escapeHtml(when)} · 版本 v${escapeHtml(String(obj.version))} · ${cats.length} 类`, risky, rows);
}

function describeLegacy(obj) {
  const scope = (obj.meta && Array.isArray(obj.meta.exportScope)) ? obj.meta.exportScope : [];
  const contacts = Array.isArray(obj.contacts) ? obj.contacts : [];
  const rows = [];
  rows.push(`<div class="backup-sum-row"><span>联系人与字卡</span><span>${contacts.length} 位联系人${scope.includes('cards') ? ` · ${contacts.reduce((n, c) => n + (c.cardGroups || []).reduce((m, g) => m + ((g.cards || []).length), 0), 0)} 张字卡` : ''}</span></div>`);
  if (scope.includes('chat')) {
    const n = contacts.reduce((s, c) => s + ((c.messages || []).length), 0);
    rows.push(`<div class="backup-sum-row"><span>聊天记录</span><span>${n} 条消息</span></div>`);
  }
  const letters = contacts.reduce((s, c) => s + ((c.letters || []).length), 0);
  if (letters) rows.push(`<div class="backup-sum-row"><span>信件与收信箱</span><span>${letters} 封信</span></div>`);
  const moodData = Array.isArray(obj.moodData) ? obj.moodData : (Array.isArray(obj.mood) ? obj.mood : []);
  if (moodData.length) rows.push(`<div class="backup-sum-row"><span>心情</span><span>${moodData.length} 天记录</span></div>`);
  if (scope.includes('stickers') || scope.includes('images')) {
    rows.push('<div class="backup-sum-row"><span>图片 / 表情包</span><span>旧版文件含图片数据，将一并恢复</span></div>');
  }
  const when = obj.meta && obj.meta.exportTime ? formatTime(obj.meta.exportTime) : '未知';
  const risky = '<div class="backup-warn">这是旧版备份（v1），将按兼容模式恢复联系人、聊天、字卡、心情与主题，部分新版设置可能缺失。</div>';
  return summaryHtml(`导出时间：${escapeHtml(when)} · 版本 v1（旧版格式）`, risky, rows);
}

/* ============ 导入：快照与回滚 ============ */
async function takeSnapshot(plan) {
  const snap = { contacts: null, meta: new Map(), wallet: new Map(), me: new Map() };
  if (plan.contacts) snap.contacts = await dbAll('contacts');
  for (const k of plan.metaKeys) snap.meta.set(k, (await dbGet('meta', k)) || null);
  for (const k of plan.walletKeys) snap.wallet.set(k, (await dbGet('wallet', k)) || null);
  for (const k of plan.meKeys) snap.me.set(k, (await dbGet('me', k)) || null);
  return snap;
}

async function restoreSnapshot(snap) {
  if (snap.contacts) {
    const cur = await dbAll('contacts');
    for (const c of cur) await dbDel('contacts', c.id);
    for (const c of snap.contacts) await dbPut('contacts', c);
  }
  for (const [k, v] of snap.meta) { if (v == null) await dbDel('meta', k); else await dbPut('meta', v); }
  for (const [k, v] of snap.wallet) { if (v == null) await dbDel('wallet', k); else await dbPut('wallet', v); }
  for (const [k, v] of snap.me) { if (v == null) await dbDel('me', k); else await dbPut('me', v); }
}

function planFromNew(obj) {
  const data = obj.data || {};
  const cats = new Set((Array.isArray(obj.categories) ? obj.categories : []).filter(id => CAT_MAP[id] && data[id]));
  const plan = { contacts: cats.has('contacts') || cats.has('chat') || cats.has('letters'), metaKeys: [], walletKeys: [], meKeys: [] };
  const c = data.contacts || {};
  if (cats.has('contacts')) {
    plan.metaKeys.push(STATUS_POOL_KEY, STATUS_CAT_KEY);
    (c.recall || []).forEach(r => r && r.k && plan.metaKeys.push(r.k));
    (c.poke || []).forEach(r => r && r.k && plan.metaKeys.push(r.k));
    (c.wallet || []).forEach(r => r && r.k && plan.walletKeys.push(r.k));
  }
  const m = data.mood || {};
  if (cats.has('mood')) {
    (m.items || []).forEach(r => r && r.k && plan.metaKeys.push(r.k));
    if (m.inspirations && m.inspirations.k) plan.metaKeys.push(m.inspirations.k);
  }
  if (cats.has('period')) plan.metaKeys.push(PERIOD_KEY);
  if (cats.has('divine')) plan.metaKeys.push(DIVINE_KEY);
  if (cats.has('qa')) (data.qa && data.qa.list || []).forEach(r => r && r.k && plan.metaKeys.push(r.k));
  return plan;
}

function planFromLegacy(obj) {
  const moodData = Array.isArray(obj.moodData) ? obj.moodData : (Array.isArray(obj.mood) ? obj.mood : []);
  const plan = { contacts: true, metaKeys: [], walletKeys: [], meKeys: ['profile', 'theme'] };
  moodData.forEach(r => r && typeof r.k === 'string' && r.k.indexOf(MOOD_PREFIX) === 0 && plan.metaKeys.push(r.k));
  if (obj.inspirations && obj.inspirations.k) plan.metaKeys.push(obj.inspirations.k);
  return plan;
}

/* ============ 导入：写入 ============ */
function applyContactFields(cur, imp) {
  if (imp.name) cur.name = imp.name;
  for (const k of ['createdAt', 'status', 'statusId', 'statusAuto', 'statusSince', 'nextStatusAt', 'nextStatusChangeAt', 'unread', 'letterDay', 'manualSwitchAt']) {
    if (imp[k] !== undefined) cur[k] = imp[k];
  }
  if (Array.isArray(imp.statusSchedule)) cur.statusSchedule = imp.statusSchedule.slice();
  if (Array.isArray(imp.pendingReplies)) cur.pendingReplies = imp.pendingReplies.slice();
  if (imp.settings) cur.settings = { ...cur.settings, ...imp.settings };
  if (Array.isArray(imp.cardGroups)) cur.cardGroups = imp.cardGroups.map(g => ({ ...g, cards: (g.cards || []).map(x => ({ ...x })) }));
  if (Array.isArray(imp.anniversaries)) cur.anniversaries = imp.anniversaries.slice();
  if (Array.isArray(imp.missedCalls)) cur.missedCalls = imp.missedCalls.slice();
}

function mergeMessages(cur, incoming) {
  const oldById = new Map((cur.messages || []).map(m => [m.id, m]));
  const out = [];
  let written = 0;
  for (const m of incoming) {
    if ((m.type === 'image' || m.type === 'sticker') && m.content == null) {
      // 备份不含图片：本机已有同一条则保留原图，否则跳过，避免空图气泡
      const old = oldById.get(m.id);
      if (old) out.push(old);
      continue;
    }
    out.push(m);
    written++;
  }
  return { list: out, written };
}

async function executeNew(obj) {
  const data = obj.data || {};
  const cats = new Set((Array.isArray(obj.categories) ? obj.categories : []).filter(id => CAT_MAP[id] && data[id]));
  const map = new Map((await getAllContacts()).map(c => [c.id, c]));
  const counts = {};

  if (cats.has('contacts')) {
    const c = data.contacts || {};
    const list = Array.isArray(c.list) ? c.list : [];
    for (const imp of list) {
      if (!imp || !imp.id) continue;
      let cur = map.get(imp.id);
      if (!cur) {
        cur = createEmptyContact(imp.name || '导入联系人');
        cur.id = imp.id;
        map.set(imp.id, cur);
      }
      applyContactFields(cur, imp);
      await saveContact(cur);
    }
    if (c.statusPool && c.statusPool.k) await dbPut('meta', c.statusPool);
    if (c.statusCategories && c.statusCategories.k) await dbPut('meta', c.statusCategories);
    for (const r of c.recall || []) if (r && r.k) await dbPut('meta', r);
    for (const r of c.poke || []) if (r && r.k) await dbPut('meta', r);
    for (const w of c.wallet || []) if (w && w.k) await dbPut('wallet', w);
    counts.contacts = list.length;
    counts.cards = sumCards(c);
  }
  if (cats.has('chat')) {
    const list = (data.chat && data.chat.list) || [];
    let n = 0;
    for (const imp of list) {
      if (!imp || !imp.id) continue;
      let cur = map.get(imp.id);
      if (!cur) {
        cur = createEmptyContact(imp.name || '导入联系人');
        cur.id = imp.id;
        map.set(imp.id, cur);
      }
      const merged = mergeMessages(cur, Array.isArray(imp.messages) ? imp.messages : []);
      cur.messages = merged.list;
      await saveContact(cur);
      n += merged.written;
    }
    counts.messages = n;
  }
  if (cats.has('letters')) {
    const list = (data.letters && data.letters.list) || [];
    let n = 0;
    for (const imp of list) {
      if (!imp || !imp.id) continue;
      let cur = map.get(imp.id);
      if (!cur) {
        cur = createEmptyContact(imp.name || '导入联系人');
        cur.id = imp.id;
        map.set(imp.id, cur);
      }
      cur.letters = Array.isArray(imp.letters) ? imp.letters.map(l => ({ ...l })) : [];
      await saveContact(cur);
      n += cur.letters.length;
    }
    counts.letters = n;
  }
  if (cats.has('mood')) {
    const m = data.mood || {};
    let days = 0;
    for (const r of m.items || []) {
      if (!r || !r.k) continue;
      await dbPut('meta', r);
      days++;
    }
    if (m.inspirations && m.inspirations.k) await dbPut('meta', m.inspirations);
    counts.moodDays = days;
  }
  if (cats.has('period') && data.period && data.period.record && data.period.record.k) {
    await dbPut('meta', data.period.record);
    counts.period = Array.isArray(data.period.record.history) ? data.period.record.history.length : 0;
  }
  if (cats.has('divine') && data.divine && data.divine.record && data.divine.record.k) {
    await dbPut('meta', data.divine.record);
    counts.divine = Array.isArray(data.divine.record.list) ? data.divine.record.list.length : 0;
  }
  if (cats.has('qa')) {
    let n = 0;
    for (const r of (data.qa && data.qa.list) || []) {
      if (!r || !r.k) continue;
      await dbPut('meta', r);
      n += Array.isArray(r.list) ? r.list.length : 0;
    }
    counts.qa = n;
  }
  return counts;
}

async function executeLegacy(obj) {
  const scope = (obj.meta && Array.isArray(obj.meta.exportScope)) ? obj.meta.exportScope : [];
  const needChat = scope.includes('chat');
  const needCards = scope.includes('cards');
  const needStickers = scope.includes('stickers');
  const needImages = scope.includes('images');
  const counts = {};

  if (obj.me) {
    const me = await getMe();
    if (obj.me.name != null) me.name = obj.me.name;
    if (needImages && obj.me.avatar) me.avatar = obj.me.avatar;
    if (needStickers && obj.me.stickers) me.stickers = obj.me.stickers.slice();
    await saveMe(me);
  }
  if (obj.me && obj.me.theme) {
    // 合并而非整体覆盖；桌面壁纸保持本机设置
    const currentTheme = await getTheme();
    const mergedTheme = { ...currentTheme, ...obj.me.theme };
    if (currentTheme.homeBg) mergedTheme.homeBg = currentTheme.homeBg;
    else delete mergedTheme.homeBg;
    await saveTheme(mergedTheme);
    applyDIYVariables(mergedTheme);
  }
  const moodData = Array.isArray(obj.moodData) ? obj.moodData : (Array.isArray(obj.mood) ? obj.mood : []);
  let moodCnt = 0;
  for (const item of moodData) {
    if (!item || typeof item.k !== 'string' || item.k.indexOf(MOOD_PREFIX) !== 0) continue;
    await dbPut('meta', item);
    moodCnt++;
  }
  if (obj.inspirations && obj.inspirations.k === INSP_KEY) await dbPut('meta', obj.inspirations);
  if (moodCnt) counts.moodDays = moodCnt;

  const map = new Map((await getAllContacts()).map(c => [c.id, c]));
  let add = 0, upd = 0, msgCnt = 0, letterCnt = 0;
  for (const imported of Array.isArray(obj.contacts) ? obj.contacts : []) {
    if (!imported || !imported.id) continue;
    let cur = map.get(imported.id);
    const isNew = !cur;
    if (isNew) {
      cur = createEmptyContact(imported.name || '导入联系人');
      cur.id = imported.id;
      map.set(imported.id, cur);
      add++;
    } else {
      upd++;
    }
    cur.name = imported.name || cur.name;
    if (needImages && imported.avatar) cur.avatar = imported.avatar;
    if (imported.status != null) cur.status = imported.status;
    if (imported.statusAuto != null) cur.statusAuto = imported.statusAuto;
    if (imported.nextStatusChangeAt) cur.nextStatusChangeAt = imported.nextStatusChangeAt;
    if (imported.statusList) cur.statusList = imported.statusList;
    if (imported.settings) {
      if (!needImages && imported.settings.chatBackground && imported.settings.chatBackground.type === 'image') {
        imported.settings = { ...imported.settings, chatBackground: cur.settings.chatBackground };
      }
      cur.settings = { ...cur.settings, ...imported.settings };
    }
    if (imported.anniversaries) cur.anniversaries = imported.anniversaries.slice();
    if (imported.letters) {
      cur.letters = imported.letters.slice();
      letterCnt += cur.letters.length;
    }
    if (imported.missedCalls) cur.missedCalls = imported.missedCalls.slice();
    if (needChat && imported.messages) {
      const merged = mergeMessages(cur, imported.messages);
      cur.messages = merged.list;
      msgCnt += merged.written;
    }
    if (needCards && imported.cardGroups) cur.cardGroups = imported.cardGroups.map(g => ({ ...g, cards: (g.cards || []).slice() }));
    if (needStickers && imported.stickers) cur.stickers = imported.stickers.slice();
    await saveContact(cur);
  }
  counts.contacts = add + upd;
  counts.messages = msgCnt;
  counts.letters = letterCnt;
  return counts;
}

/* ============ 导入：入口 ============ */
function runQueued(fn) {
  if (typeof window.__enqueueTask === 'function') return window.__enqueueTask(fn);
  return fn();
}

function detectFormat(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.format === 'xingz-backup' && obj.data && typeof obj.data === 'object') return 'new';
  if (obj.meta && Array.isArray(obj.contacts)) return 'legacy';
  return null;
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

function resultText(counts) {
  const parts = [];
  if (counts.contacts) parts.push(`联系人 ${counts.contacts} 位`);
  if (counts.cards) parts.push(`字卡 ${counts.cards} 张`);
  if (counts.messages) parts.push(`聊天 ${counts.messages} 条`);
  if (counts.letters) parts.push(`信件 ${counts.letters} 封`);
  if (counts.moodDays) parts.push(`心情 ${counts.moodDays} 天`);
  if (counts.period) parts.push(`经期 ${counts.period} 条`);
  if (counts.divine) parts.push(`占卜 ${counts.divine} 条`);
  if (counts.qa) parts.push(`问答 ${counts.qa} 条`);
  return parts.length ? parts.join(' · ') : '文件里没有可恢复的数据';
}

async function refreshAfterImport() {
  try {
    renderMeBrief();
    await renderContacts();
    renderStorageStats();
  } catch (e) {
    console.error(e);
  }
}

function shortError(e) {
  const msg = String((e && e.message) || e || '');
  if (/not a valid key|DataError/i.test(msg)) return '数据格式异常（存在无效键值）';
  if (/quota|QuotaExceeded/i.test(msg)) return '存储空间不足';
  return msg.length > 50 ? msg.slice(0, 50) + '…' : msg;
}

export async function backupDoImport(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  input.value = '';
  if (_importing) return toast('正在导入，请稍候');
  let text;
  try {
    text = await readFileText(file);
  } catch (e) {
    return toast('读取文件失败');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return toast('文件不是有效的 JSON');
  }
  const kind = detectFormat(obj);
  if (!kind) return toast('不是可识别的备份文件');

  _importing = true;
  try {
    const html = kind === 'new' ? describeNew(obj) : describeLegacy(obj);
    if (!await confirmSummary(html)) return;

    toast('正在导入，请稍候…', 4000);
    const counts = await runQueued(async () => {
      const plan = kind === 'new' ? planFromNew(obj) : planFromLegacy(obj);
      const snap = await takeSnapshot(plan);
      try {
        return kind === 'new' ? await executeNew(obj) : await executeLegacy(obj);
      } catch (e) {
        try { await restoreSnapshot(snap); } catch (e2) { console.error('回滚失败', e2); }
        throw e;
      }
    });
    await refreshAfterImport();
    openPage('page-me');
    toast('导入完成：' + resultText(counts), 3600);
  } catch (e) {
    console.error(e);
    await refreshAfterImport();
    toast('导入失败，已回滚：' + shortError(e), 4000);
  } finally {
    _importing = false;
  }
}
