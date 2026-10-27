// 依赖：01-state.js, 02-core.js
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, countdownAnniversary, dbAll, dbDel, dbGet, dbPut, escapeHtml, formatTime, inputDialog, now, randInt, toast } from './02-core.js';
import { autoResize, cancelRoundTimers, renderChatMessages } from './04-chat.js';
import { renderLetterList } from './05-call-letter.js';
import { openContactSetting, renderContactSettingsList, renderMyStickersGrid, renderStickerPanel, renderThemeUI } from './06-ui.js';
import { renderHomeAvatar, renderStorageStats, renderTodos } from './07-diy-todo.js';

// ============ 我的资料读写 ============
export async function getMe() {
  let m = await dbGet('me', 'profile');
  if (!m) {
    m = { k:'profile', name:'我', avatar:DEFAULT_AVATAR, stickers:[] };
    await dbPut('me', m);
  }
  // 迁移修复：旧版默认头像fill被二次编码(%2523)导致解析失败显示黑色，替换为新默认头像
  if (m.avatar && m.avatar.indexOf('%2523') !== -1) {
    m.avatar = DEFAULT_AVATAR;
    await dbPut('me', m);
  }
  return m;
}
export async function saveMe(m) { m.k = 'profile'; await dbPut('me', m); }

export async function getTheme() {
  let t = await dbGet('me', 'theme');
  if (!t) {
    t = { k:'theme', themeColor:'#6b8aff', background:{type:'color', value:'#f5f6fa'}, customCSS:'' };
    await dbPut('me', t);
  }
  return t;
}
export async function saveTheme(t) { t.k = 'theme'; await dbPut('me', t); applyTheme(t); }

// ============ 联系人读写 ============
export async function getAllContacts() { return await dbAll('contacts'); }
export async function getContact(id) { return await dbGet('contacts', id); }
export async function saveContact(c) { await dbPut('contacts', c); }
export async function deleteContact(id) { await dbDel('contacts', id); }

export function createEmptyContact(name) {
  return {
    id: uid(),
    name: name || '新联系人',
    avatar: DEFAULT_AVATAR,
    status: '',
    statusAuto: true,
    nextStatusChangeAt: now() + randInt(30, 180) * 60 * 1000,
    statusList: [],
    settings: {
      fastSec: 5, slowMin: 3, replyCount: 1,
      incomingCall: true, proactiveMsg: false,
      proactiveMin: 1, proactiveMax: 3,
      nextProactiveAt: now() + randInt(2, 8) * 3600 * 1000,
      chatBackground: null,
      myNickname: '',
      letterEnabled: false, nextLetterAt: null
    },
    letterDay: null, // 当日主动来信是否已判定：'YYYY-M-D'
    cardGroups: [],
    stickers: [],
    anniversaries: [],
    messages: [],
    letters: [],
    missedCalls: [],
    unread: 0,
    callSlots: null, // 当日来电槽位：{date, slots:[{contactId,time}]}
  };
}

// ============ 主题应用 ============
export function applyTheme(theme) {
  const r = document.documentElement;
  r.style.setProperty('--theme-color', theme.themeColor);
  // 衍生浅色
  const c = theme.themeColor;
  r.style.setProperty('--theme-light', hexToRgba(c, 0.12));
  r.style.setProperty('--my-bubble', theme.themeColor);
  // 背景
  if (theme.background) {
    const bg = theme.background;
    let cssVal = '';
    if (bg.type === 'color') cssVal = bg.value;
    else if (bg.type === 'gradient') cssVal = bg.value;
    else if (bg.type === 'image') cssVal = `url("${bg.value}") center/cover no-repeat fixed`;
    document.body.style.background = cssVal;
    // 背景可能深色，浅色模式下的一些面板用变量的 card-bg 保持白色即可
  }
  // 自定义CSS
  const old = document.getElementById('user-css');
  if (old) old.remove();
  if (theme.customCSS) {
    const s = document.createElement('style');
    s.id = 'user-css';
    s.textContent = theme.customCSS;
    document.head.appendChild(s);
  }
}
export function hexToRgba(hex, a) {
  let h = hex.replace('#','');
  if (h.length === 3) h = h.split('').map(c => c+c).join('');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ============ 我的资料简要渲染 ============
export async function renderMeBrief() {
  const m = await getMe();
  const av = $('sidebar-avatar'); if (av) av.src = m.avatar || DEFAULT_AVATAR;
  const n = $('sidebar-name'); if (n) n.textContent = m.name;
  const ma = $('me-avatar'); if (ma) ma.src = m.avatar || DEFAULT_AVATAR;
  const mn = $('me-name'); if (mn) mn.textContent = m.name;
}

// ============ 页面切换 ============
export function openPage(id, pushPrev=false) {
  // 关闭聊天菜单等
  $('chat-menu').classList.add('hide');
  $('sticker-panel').classList.add('hide');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pg = $(id);
  if (pg) pg.classList.add('active');
  // 聊天页激活时手机端隐藏底部导航栏
  document.body.classList.toggle('page-chat-active', id === 'page-chat');
  // 底部导航状态
  document.querySelectorAll('.bottom-nav .nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === id);
  });
  // 进入me页时刷新显示
  if (id === 'page-me') renderMeBrief();
  if (id === 'page-letter') renderLetterList();
  if (id === 'page-setting') { renderThemeUI(getThemeSync()); renderStorageStats(); }
  if (id === 'page-my-stickers') renderMyStickersGrid();
  if (id === 'page-contact-settings-list') renderContactSettingsList();
  if (id === 'page-love' || id === 'page-chat') renderContacts();
  if (id === 'page-home') { renderHomeAvatar(); renderTodos(); }
  state.lastPage = id;
}
export function getThemeSync() {
  // 用于页面渲染时快速获取（非异步），实际存储用async
  return { themeColor: getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim() || '#6b8aff' };
}

// ============ 联系人列表渲染（手机版 + 电脑侧栏） ============
export function filterContacts(query) { renderContacts(query); }
export async function renderContacts(search='') {
  const list = await getAllContacts();
  const q = (search || '').trim().toLowerCase();
  const filtered = q ? list.filter(c => c.name.toLowerCase().includes(q)) : list;
  // 按最后消息时间倒序
  filtered.sort((a,b) => {
    const la = a.messages.length ? a.messages[a.messages.length-1].time : 0;
    const lb = b.messages.length ? b.messages[b.messages.length-1].time : 0;
    return lb - la;
  });
  const renderCard = (c) => {
    const last = c.messages.length ? c.messages[c.messages.length-1] : null;
    let preview = last ? (last.type === 'text' ? last.content : last.type === 'image' ? '[图片]' : last.type === 'sticker' ? '[表情包]' : last.type === 'choice' ? '[帮我选择]' : '') : '还没有消息，点击开始聊天';
    const anni = getNearestAnniversary(c.anniversaries);
    const anniHtml = anni ? `<div class="contact-card-anni">${anni.text}</div>` : '';
    const mc = (c.missedCalls && c.missedCalls.length > 0) ? `<div class="missed-call-badge"><svg class="i i-sm" style="margin-right:2px;"><use href="#icon-phone"/></svg>${c.missedCalls.length}个未接</div>` : '';
    const unread = c.unread ? `<span class="badge" style="margin-left:4px;"></span>` : '';
    return `<div class="contact-card" onclick="openChat('${c.id}')">
      <img class="avatar" src="${escapeHtml(c.avatar || DEFAULT_AVATAR)}" alt="">
      <div class="contact-card-info">
        <div class="contact-card-name">${escapeHtml(c.name)}${unread}</div>
        <div class="contact-card-status">
          ${c.status ? `<span class="status-dot" style="background:var(--success);"></span>${escapeHtml(c.status)}` : '<span style="color:var(--text-secondary);">未设置状态</span>'}
        </div>
        <div class="contact-card-preview ellipsis">${escapeHtml(preview)}</div>
        ${anniHtml}
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div class="contact-card-time">${last ? formatTime(last.time) : ''}</div>
      </div>
      ${mc}
    </div>`;
  };
  const html = filtered.length ? filtered.map(renderCard).join('') : `<div class="empty">还没有联系人，点击右上角"+"新建</div>`;
  const mc = $('mobile-contacts'); if (mc) mc.innerHTML = html;
  const sc = $('sidebar-contacts'); if (sc) sc.innerHTML = filtered.length ? filtered.map(renderCard).join('') : `<div class="empty" style="font-size:13px;">暂无联系人</div>`;
}
export function getNearestAnniversary(list) {
  if (!list || !list.length) return null;
  let min = Infinity, nearest = null;
  for (const a of list) {
    const r = countdownAnniversary(a.date);
    if (!r) continue;
    if (r.diff < min) { min = r.diff; nearest = { ...a, diff: r.diff, today: r.todayIsOrigin }; }
  }
  if (!nearest) return null;
  const t = nearest.today ? '🎉 就是今天' : (nearest.diff === 0 ? '🎉 就是今天' : (nearest.diff > 0 ? `还有${nearest.diff}天` : `已过${Math.abs(nearest.diff)}天`));
  return { name: nearest.name, text: `${escapeHtml(nearest.name)} · ${t}` };
}

// ============ 新建联系人 ============
export async function createNewContact() {
  const r = await inputDialog('新建联系人', [{ key:'name', label:'联系人名字', placeholder:'请输入名字', required:true }]);
  if (!r) return;
  const nm = (r.name || '').trim() || '新联系人';
  const c = createEmptyContact(nm);
  await saveContact(c);
  renderContacts();
  toast('联系人已创建');
  // 进入聊天
  openChat(c.id);
}

// 专属称呼替换：把文本中的 [我的名字] / [昵称] / {name} 替换为专属称呼（未设置则用我的名字）
export async function applyNickname(text, c) {
  if (!text) return text;
  if (!/\[我的名字\]|\[昵称\]|\{name\}/.test(text)) return text;
  const nick = (c.settings && c.settings.myNickname) || (await getMe()).name || '我';
  return text.replace(/\[我的名字\]|\[昵称\]|\{name\}/g, nick);
}
// 回复概率：直接使用每个状态的 replyRate 属性（0-100 整数百分比）
// 颜色映射：按概率区间给出绿→红的状态点颜色
export function rateColor(rate) {
  const r = Number(rate) || 0;
  if (r >= 90) return '#10b981';  // 秒回级：绿
  if (r >= 60) return '#3b82f6';  // 常回级：蓝
  if (r >= 30) return '#f59e0b';  // 看心情：黄橙
  if (r >= 10) return '#f97316';  // 很少回：橙
  return '#6b7280';                // <10%：灰（离线/不理）
}

// ============ 退出聊天模式（左栏点击我/设置时调用，电脑端回到空态） ============
export function exitChatMode() {
  if (!state.currentContactId) return;
  const prevId = state.currentContactId;
  cancelRoundTimers(prevId);
  delete state.replyRounds[prevId];
  state.chatTypingState[prevId] = false;
  state.currentContactId = null;
  for (const k in state.chatTimers) { clearTimeout(state.chatTimers[k]); delete state.chatTimers[k]; }
  // 切换空态显示
  const isDesktop = window.matchMedia('(min-width: 900px)').matches;
  if (isDesktop) {
    const ec = $('empty-chat');
    const cw = $('chat-content-wrap');
    if (ec) ec.classList.add('show');
    if (cw) cw.classList.add('hide');
  }
}
// ============ 打开聊天 ============
export async function openChat(contactId) {
  state.currentContactId = contactId;
  const c = await getContact(contactId);
  if (!c) return;
  c.unread = 0;
  if (c.missedCalls && c.missedCalls.length > 0) {
    toast(`${c.name}有${c.missedCalls.length}个未接来电`);
    c.missedCalls = [];
  }
  await saveContact(c);
  // 先激活聊天页（激活display:flex）
  openPage('page-chat');
  // 显示聊天内容，隐藏空态（电脑端）
  const ec = $('empty-chat');
  const cw = $('chat-content-wrap');
  if (ec) ec.classList.remove('show');
  if (cw) {
    cw.classList.remove('hide');
    cw.style.display = 'flex';
    cw.style.flexDirection = 'column';
    cw.style.flex = '1';
    cw.style.minHeight = '0';
    cw.style.overflow = 'hidden';
  }
  // 渲染顶栏
  $('chat-header-name').textContent = c.name;
  const rate = getCurrentReplyRate(c);
  $('chat-header-status').innerHTML = c.status
    ? `<span class="status-dot" style="background:${rateColor(rate)};"></span>${escapeHtml(c.status)}`
    : '未设置状态';
  state.loadMoreState[contactId] = { loaded: false, pageSize: 50 };
  await renderChatMessages(contactId, true);
  applyChatBg(c);
  renderStickerPanel();
  $('chat-input-box').value = '';
  autoResize($('chat-input-box'));
  renderContacts();
}
export function tierColor(t) {
  // 旧 tierColor 兼容：将 tier 转换为概率后用 rateColor
  const tierMap = { '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 };
  const r = (typeof t === 'number') ? t : (tierMap[t] != null ? tierMap[t] : 50);
  return rateColor(r);
}
export function applyChatBg(c) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  const bg = c.settings && c.settings.chatBackground;
  let val = '';
  if (bg) {
    if (bg.type === 'color') val = bg.value;
    else if (bg.type === 'image') val = `url("${bg.value}") center/cover no-repeat fixed`;
  }
  // 防覆盖：联系人单独设置的聊天背景以行内 !important 写入，优先级高于全局主题背景 / 全局自定义 CSS
  if (val) msgs.style.setProperty('background', val, 'important');
  else {
    msgs.style.removeProperty('background');
    msgs.style.removeProperty('background-image');
  }
}
export function getCurrentReplyRate(c) {
  if (!c.statusList || !c.status) return 50; // 默认50%
  const s = c.statusList.find(x => x.name === c.status);
  // 兼容老 tier 数据：若无replyRate则从tier映射
  if (s) {
    if (typeof s.replyRate === 'number') return s.replyRate;
    const tierMap = { '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 };
    return tierMap[s.tier] != null ? tierMap[s.tier] : 50;
  }
  return 50;
}
export function getReplyRateOf(c, statusName) {
  if (!c.statusList || !statusName) return 50;
  const s = c.statusList.find(x => x.name === statusName);
  if (s) {
    if (typeof s.replyRate === 'number') return s.replyRate;
    const tierMap = { '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 };
    return tierMap[s.tier] != null ? tierMap[s.tier] : 50;
  }
  return 50;
}
export function backFromChat() {
  const wasDesktop = window.matchMedia('(min-width: 900px)').matches;
  const prevId = state.currentContactId;
  if (prevId) { cancelRoundTimers(prevId); delete state.replyRounds[prevId]; state.chatTypingState[prevId] = false; }
  state.currentContactId = null;
  for (const k in state.chatTimers) { clearTimeout(state.chatTimers[k]); delete state.chatTimers[k]; }
  if (wasDesktop) {
    // 电脑端：回到空态
    const ec = $('empty-chat');
    const cw = $('chat-content-wrap');
    if (ec) ec.classList.add('show');
    if (cw) cw.classList.add('hide');
  } else {
    // 手机端：回到love页
    openPage('page-love');
  }
}
// 聊天设置按钮直接打开（避免onclick内async await无法等待的问题）
export function openContactSettingsFromChatDirect() {
  if (!state.currentContactId) return;
  openContactSetting(state.currentContactId, 'page-chat');
}

export async function openContactSettingsFromChat() {
  if (!state.currentContactId) return;
  await openContactSetting(state.currentContactId, 'page-chat');
}
