// 拍一拍：两套文案池（我拍别人 / 对方拍我）+ 分组与批量导入 + 概率判定 + 浮层与系统提示行
// 依赖：01-state.js / 02-core.js；联系人与状态数据按需动态引入，避免模块循环
import { state, uid } from './01-state.js';
import { $, closeModal, confirmDialog, dbGet, dbPut, escapeHtml, inputDialog, now, showModal, toast } from './02-core.js';

const MINE_KEY = 'poke_mine_v1';
const THEIRS_PREFIX = 'poke_theirs_';
const CFG_PREFIX = 'poke_cfg_';
const HOUR = 3600 * 1000;
const DEFAULT_CHANCE = 20;
const DEFAULT_GROUP_NAME = '默认分组';
const DEFAULT_GID = 'g-default';

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

/* ============ 分组数据（meta: { k, v:2, groups:[{id,name,lines:[]}] }） ============ */
function makeDefaultGroups(kind) {
  return [{ id: DEFAULT_GID, name: DEFAULT_GROUP_NAME, lines: defaultsOf(kind) }];
}
function normalizeGroups(kind, rec) {
  let groups = null;
  if (rec && Array.isArray(rec.groups)) {
    groups = rec.groups.map(g => ({
      id: g && g.id ? String(g.id) : uid(),
      name: g && g.name ? String(g.name) : DEFAULT_GROUP_NAME,
      lines: g && Array.isArray(g.lines) ? g.lines.map(x => String(x)) : []
    }));
  } else if (rec && Array.isArray(rec.list)) {
    // 旧版扁平文案 → 迁入默认分组
    groups = [{ id: DEFAULT_GID, name: DEFAULT_GROUP_NAME, lines: rec.list.map(x => String(x)) }];
  }
  if (!groups || !groups.length) return makeDefaultGroups(kind);
  return groups;
}
async function getGroups(kind, cid) {
  const key = keyOf(kind, cid);
  await waitChain(key);
  const rec = await dbGet('meta', key);
  return normalizeGroups(kind, rec);
}
function putGroups(kind, cid, groups) {
  const key = keyOf(kind, cid);
  const payload = {
    k: key, v: 2,
    groups: groups.map(g => ({ id: g.id, name: g.name, lines: g.lines.slice() }))
  };
  return serialized(key, async () => { await dbPut('meta', payload); });
}

// 扁平列表：供双击面板与定时拍一拍使用
export async function getPokeMineList() {
  const groups = await getGroups('mine');
  return groups.reduce((arr, g) => arr.concat(g.lines), []);
}
export async function getPokeTheirsList(cid) {
  if (!cid) return POKE_THEIRS_DEFAULTS.slice();
  const groups = await getGroups('theirs', cid);
  return groups.reduce((arr, g) => arr.concat(g.lines), []);
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

/* ============ 分组折叠状态：只在本次进入页面内保持，重新进入恢复全部收起 ============ */
const expandedGroups = { mine: new Set(), theirs: new Set() };
function expandedOf(kind) { return expandedGroups[kind]; }
function resetExpanded(kind) { expandedGroups[kind] = new Set(); }

/* ============ 联系人设置：改编成一行入口 ============ */
export async function getPokeSectionHtml(cid) {
  const list = await getPokeTheirsList(cid);
  return `
    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-heart"/></svg> 拍一拍</div>
      <div class="cs-card">
        <div class="cs-row cs-row-link" onclick="openPokeTheirs()">
          <span class="cs-label">对方拍我时用</span>
          <span class="cs-value">${list.length} 条 · 进入设置<svg class="i i-sm"><use href="#icon-chevron-right"/></svg></span>
        </div>
        <div class="cs-hint">分组文案、概率与批量导入都在这个二级页里设置。</div>
      </div>
    </div>`;
}

/* ============ 二级页渲染（mine / theirs 共用结构） ============ */
function lineHtml(kind, gid, i, text) {
  return `<div class="poke-line">
    <span class="poke-line-text">${escapeHtml(text)}</span>
    <span class="poke-line-acts">
      <button onclick="pokeEditLine('${kind}','${gid}',${i})" title="编辑"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
      <button onclick="pokeDeleteLine('${kind}','${gid}',${i})" title="删除"><svg class="i i-sm"><use href="#icon-trash"/></svg></button>
    </span>
  </div>`;
}
function groupHtml(kind, g, open) {
  const body = open ? `<div class="poke-group-body">
    ${g.lines.length ? g.lines.map((t, i) => lineHtml(kind, g.id, i, t)).join('') : '<div class="poke-empty">该分组还没有文案</div>'}
    <button class="btn btn-ghost" style="width:100%;margin-top:8px;" onclick="pokeAddLine('${kind}','${g.id}')">＋ 添加文案</button>
  </div>` : '';
  return `<div class="poke-group${open ? ' open' : ''}" data-gid="${g.id}">
    <div class="poke-group-head" onclick="pokeToggleGroup('${kind}','${g.id}')">
      <button class="poke-group-toggle" title="展开/折叠" aria-expanded="${open ? 'true' : 'false'}"><svg class="i i-sm"><use href="#icon-chevron-down"/></svg></button>
      <span class="poke-group-name">${escapeHtml(g.name)}</span>
      <span class="poke-group-count">${g.lines.length} 条</span>
      <span class="poke-group-acts">
        <button onclick="event.stopPropagation();pokeRenameGroup('${kind}','${g.id}')" title="重命名分组"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
        <button onclick="event.stopPropagation();pokeDeleteGroup('${kind}','${g.id}')" title="删除分组"><svg class="i i-sm"><use href="#icon-trash"/></svg></button>
      </span>
    </div>
    ${body}
  </div>`;
}

function ctxCidOf(kind) {
  return kind === 'mine' ? '' : (state.currentContactSettingId || '');
}

export async function renderPokePage(kind) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const box = $(kind === 'mine' ? 'my-poke-body' : 'theirs-poke-body');
  if (!box) return;
  const groups = await getGroups(kind, cid);
  const exp = expandedOf(kind);
  const total = groups.reduce((n, g) => n + g.lines.length, 0);

  let chanceCard = '';
  if (kind === 'theirs') {
    const chance = await getPokeChance(cid);
    try {
      const { getContact } = await import('./03-data.js');
      const c = await getContact(cid);
      const title = $('poke-theirs-title');
      if (title && c) title.textContent = '对方拍我 · ' + c.name;
    } catch (e) {}
    chanceCard = `<div class="cs-card" style="margin-bottom:14px;">
      <div class="cs-row">
        <span class="cs-label">对方拍我概率</span>
        <span class="cs-value">
          <div class="range-row" style="justify-content:flex-end;">
            <input type="number" min="0" max="100" step="1" value="${chance}" id="poke-chance">
            <span class="cs-unit">%</span>
          </div>
        </span>
      </div>
      <button class="btn" style="width:100%;margin-top:10px;" onclick="pokeSaveChanceFromPage()">保存概率</button>
      <div class="cs-hint">每小时判定一次，可调 0–100；睡觉类状态不会拍。保存后立即生效。</div>
    </div>`;
  }

  const summary = `<div class="cs-card" style="margin-bottom:14px;">
    <div class="cs-row">
      <span class="cs-label">${kind === 'mine' ? '我拍别人时用' : '对方拍我时用（本联系人独立）'}</span>
      <span class="cs-value">${total} 条 · ${groups.length} 组</span>
    </div>
    <div class="poke-toolbar">
      <button class="btn btn-ghost" onclick="pokeAddGroup('${kind}')">＋ 新建分组</button>
      <button class="btn btn-ghost" onclick="openPokeImport('${kind}')">批量导入</button>
    </div>
    <div class="cs-hint">${kind === 'mine'
      ? '双击对方头像时从这里选一条发送；{name} 会替换成对方的名字。'
      : '文案中的 {name} 会替换为我的名字。'}</div>
  </div>`;

  box.innerHTML = chanceCard + summary + groups.map(g => groupHtml(kind, g, exp.has(g.id))).join('');
}

export function renderMyPokePage() { return renderPokePage('mine'); }

export async function openMyPoke() {
  resetExpanded('mine');
  await renderPokePage('mine');
  if (typeof window.openPage === 'function') window.openPage('page-my-poke');
}
export function backFromMyPoke() {
  if (typeof window.openPage === 'function') window.openPage('page-me');
}

export async function openPokeTheirs() {
  if (!state.currentContactSettingId) return toast('请先选择一位联系人');
  resetExpanded('theirs');
  await renderPokePage('theirs');
  if (typeof window.openPage === 'function') window.openPage('page-poke-theirs');
}
export async function backFromPokeTheirs() {
  const cid = state.currentContactSettingId;
  if (cid && typeof window.openContactSetting === 'function') {
    try { await window.openContactSetting(cid, state.csFromPage); return; } catch (e) {}
  }
  if (typeof window.openPage === 'function') window.openPage('page-contact-setting');
}

/* ============ 分组与文案操作 ============ */
function findGroup(groups, gid) {
  return groups.find(g => g.id === gid) || groups[0];
}
async function saveAndRender(kind, cid, groups) {
  await putGroups(kind, cid, groups);
  await renderPokePage(kind);
}

export async function pokeToggleGroup(kind, gid) {
  const exp = expandedOf(kind);
  if (exp.has(gid)) exp.delete(gid); else exp.add(gid);
  await renderPokePage(kind);
}

export async function pokeAddGroup(kind) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const r = await inputDialog('新建分组', [{ key: 'name', label: '分组名称', value: '', required: true }]);
  if (!r) return;
  const name = (r.name || '').trim();
  if (!name) return toast('分组名称不能为空');
  const groups = await getGroups(kind, cid);
  const g = { id: uid(), name, lines: [] };
  groups.push(g);
  expandedOf(kind).add(g.id);
  await saveAndRender(kind, cid, groups);
}

export async function pokeRenameGroup(kind, gid) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const groups = await getGroups(kind, cid);
  const g = groups.find(x => x.id === gid);
  if (!g) return;
  const r = await inputDialog('重命名分组', [{ key: 'name', label: '分组名称', value: g.name, required: true }]);
  if (!r) return;
  const name = (r.name || '').trim();
  if (!name) return toast('分组名称不能为空');
  g.name = name;
  await saveAndRender(kind, cid, groups);
}

export async function pokeDeleteGroup(kind, gid) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const groups = await getGroups(kind, cid);
  if (groups.length <= 1) return toast('至少保留一个分组');
  const g = groups.find(x => x.id === gid);
  if (!g) return;
  const ok = await confirmDialog(`删除分组「${g.name}」及组内 ${g.lines.length} 条文案？`);
  if (!ok) return;
  const next = groups.filter(x => x.id !== gid);
  expandedOf(kind).delete(gid);
  await saveAndRender(kind, cid, next);
}

export async function pokeAddLine(kind, gid) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const groups = await getGroups(kind, cid);
  const g = findGroup(groups, gid);
  if (!g) return;
  const r = await inputDialog('添加拍一拍文案', [{
    key: 'text', label: '文案',
    value: kind === 'mine' ? '拍了拍{name}' : '拍了拍我的头', required: true
  }]);
  if (!r) return;
  const t = (r.text || '').trim();
  if (!t) return toast('文案不能为空');
  g.lines.push(t);
  expandedOf(kind).add(g.id);
  await saveAndRender(kind, cid, groups);
}

export async function pokeEditLine(kind, gid, idx) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const groups = await getGroups(kind, cid);
  const g = findGroup(groups, gid);
  if (!g || idx < 0 || idx >= g.lines.length) return;
  const r = await inputDialog('编辑拍一拍文案', [{ key: 'text', label: '文案', value: g.lines[idx], required: true }]);
  if (!r) return;
  const t = (r.text || '').trim();
  if (!t) return toast('文案不能为空');
  g.lines[idx] = t;
  await saveAndRender(kind, cid, groups);
}

export async function pokeDeleteLine(kind, gid, idx) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const groups = await getGroups(kind, cid);
  const g = findGroup(groups, gid);
  if (!g || idx < 0 || idx >= g.lines.length) return;
  if (!await confirmDialog('删除这条拍一拍文案？')) return;
  g.lines.splice(idx, 1);
  await saveAndRender(kind, cid, groups);
}

/* ============ 批量导入（一行一条，指定分组，空行忽略，组内去重） ============ */
export async function openPokeImport(kind) {
  const cid = ctxCidOf(kind);
  if (kind === 'theirs' && !cid) return;
  const groups = await getGroups(kind, cid);
  const exp = expandedOf(kind);
  let defaultGid = groups[0].id;
  for (const g of groups) { if (exp.has(g.id)) { defaultGid = g.id; break; } }
  const options = groups.map(g =>
    `<option value="${g.id}"${g.id === defaultGid ? ' selected' : ''}>${escapeHtml(g.name)}（${g.lines.length} 条）</option>`
  ).join('');
  const body = `
    <div class="form-row">
      <label class="form-label">导入到分组</label>
      <select class="input" id="poke-import-group">${options}</select>
    </div>
    <div class="form-row">
      <label class="form-label">文案（一行一条）</label>
      <textarea class="textarea" id="poke-import-text" placeholder="拍了拍{name}的头&#10;戳了戳{name}的脸颊"></textarea>
    </div>
    <div class="cs-hint">空行忽略；首尾空格自动去掉；与组内已有内容重复的行会跳过并回报数量。</div>`;
  showModal('批量导入文案', body, [
    { label: '取消', cls: 'btn-outline', onClick: closeModal },
    { label: '导入', cls: 'btn', onClick: async () => {
      const sel = $('poke-import-group');
      const ta = $('poke-import-text');
      const gid = sel ? sel.value : '';
      const raw = ta ? ta.value : '';
      const rows = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!rows.length) return toast('没有可导入的内容');
      const list = await getGroups(kind, cid);
      const g = list.find(x => x.id === gid) || list[0];
      if (!g) return;
      const seen = new Set(g.lines);
      let added = 0, dup = 0;
      for (const t of rows) {
        if (seen.has(t)) { dup++; continue; }
        seen.add(t);
        g.lines.push(t);
        added++;
      }
      if (added) await putGroups(kind, cid, list);
      expandedOf(kind).add(g.id);
      closeModal();
      await renderPokePage(kind);
      if (!added) toast(`没有新增，跳过重复 ${dup} 条`);
      else toast(dup ? `已导入 ${added} 条，跳过重复 ${dup} 条` : `已导入 ${added} 条`);
    } }
  ]);
}

/* ============ 概率保存 ============ */
export async function pokeSaveChanceFromPage() {
  const el = $('poke-chance');
  const v = el ? el.value : '';
  const n = Number(v);
  if (!Number.isFinite(n)) return toast('请输入 0–100 的数字');
  await pokeSaveChance(n);
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
    : `<div class="poke-empty" style="padding:18px 4px;">还没有文案，先去「我的 → 我的拍一拍」里添加</div>`;
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
  if (state.currentContactId === cid && typeof window.renderChatIncremental === 'function') {
    window.renderChatIncremental(cid, { animate: false });
  }
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
