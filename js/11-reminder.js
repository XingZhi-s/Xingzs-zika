// 依赖：01-state.js / 02-core.js / 03-data.js / 04-chat.js / 05-call-letter.js / 06-ui.js
import { state, uid } from './01-state.js';
import { $, closeModal, confirmDialog, dbGet, dbPut, escapeHtml, formatTime, now, showModal, toast } from './02-core.js';
import { getContact, renderContacts, saveContact } from './03-data.js';
import { openAnniversary, openChoice, renderChatMessages } from './04-chat.js';
import { composeLetterToCurrent, makeCall } from './05-call-letter.js';

/* ============ 聊天工具抽屉（数组驱动，第一项固定为「提醒」） ============ */
const CHAT_TOOLS = [
  { id: 'reminder', name: '提醒', icon: 'icon-bell' },
  { id: 'choice',   name: '选择', icon: 'icon-target' },
  { id: 'anni',     name: '纪念日', icon: 'icon-calendar' },
  { id: 'letter',   name: '写信', icon: 'icon-mail' },
  { id: 'voice',    name: '电话', icon: 'icon-phone' },
  { id: 'video',    name: '视频', icon: 'icon-video' }
];

export function renderChatToolDrawer() {
  const box = $('chat-tool-grid');
  if (!box) return;
  box.innerHTML = CHAT_TOOLS.map(t => `<button class="chat-tool-item" onclick="runChatTool('${t.id}')">
    <span class="ct-icon"><svg class="i"><use href="#${t.icon}"/></svg></span>
    <span class="ct-name">${t.name}</span>
  </button>`).join('');
}
export function toggleChatToolDrawer() {
  const d = $('chat-tool-drawer');
  if (!d) return;
  if (d.classList.contains('hide')) {
    renderChatToolDrawer();
    d.classList.remove('hide');
  } else {
    closeChatToolDrawer();
  }
}
export function closeChatToolDrawer() {
  const d = $('chat-tool-drawer');
  if (d) d.classList.add('hide');
  // A25：关闭后主动失焦，避免触发按钮残留高亮/焦点
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('chat-input-btn')) {
    ae.blur();
    ae.classList.remove('active', 'focus');
  }
}
export function runChatTool(id) {
  closeChatToolDrawer();
  switch (id) {
    case 'reminder': return openReminderPanel();
    case 'choice': return openChoice();
    case 'anni': return openAnniversary();
    case 'letter': return composeLetterToCurrent();
    case 'voice': return makeCall('voice');
    case 'video': return makeCall('video');
  }
}

/* ============ 联系人提醒：数据（IndexedDB meta store） ============
   chat_reminders_v1: { k, list:[{ id, contactId, text, at, repeat:'once'|'daily'|'weekly', done, createdAt, lastFiredAt }] } */
const REMINDER_KEY = 'chat_reminders_v1';
async function getReminders() {
  const r = await dbGet('meta', REMINDER_KEY);
  return (r && Array.isArray(r.list)) ? r.list : [];
}
async function saveReminders(list) { await dbPut('meta', { k: REMINDER_KEY, list }); }

const REPEAT_LABEL = { once: '单次', daily: '每天', weekly: '每周' };

function toDatetimeLocal(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============ 提醒管理面板（查看 / 编辑 / 删除，自动绑定当前联系人） ============ */
export async function openReminderPanel() {
  const cid = state.currentContactId;
  if (!cid) return toast('请先打开一位联系人');
  const c = await getContact(cid);
  if (!c) return;
  const list = (await getReminders()).filter(r => r.contactId === cid)
    .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.at || 0) - (b.at || 0));
  const rows = list.map(r => {
    const status = r.done ? '已完成' : (r.at <= now() ? '到点，等待触发' : `将在 ${formatTime(r.at)} 触发`);
    return `<div class="reminder-row${r.done ? ' done' : ''}">
      <div class="reminder-row-body">
        <div class="reminder-row-text">${escapeHtml(r.text)}</div>
        <div class="reminder-row-meta">${REPEAT_LABEL[r.repeat] || '单次'} · ${status}</div>
      </div>
      <div class="reminder-row-actions">
        <button class="reminder-icon-btn" onclick="editReminder('${r.id}')" title="编辑"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
        <button class="reminder-icon-btn del" onclick="deleteReminder('${r.id}')" title="删除"><svg class="i i-sm"><use href="#icon-trash"/></svg></button>
      </div>
    </div>`;
  }).join('');
  const body = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">提醒由「${escapeHtml(c.name)}」名下发到聊天里；到点时若应用已关闭，会在下次打开时补发。</div>
    ${rows || '<div class="empty" style="padding:26px 10px;font-size:13px;">还没有提醒，点下方「新增提醒」创建</div>'}`;
  showModal(`${c.name} 的提醒`, body, [
    { label: '关闭', cls: 'btn-outline', onClick: closeModal },
    { label: '新增提醒', cls: 'btn', onClick: () => openReminderEditor(null) }
  ]);
}

export async function editReminder(id) { openReminderEditor(id); }

export async function deleteReminder(id) {
  const ok = await confirmDialog('确定删除这条提醒吗？');
  if (ok) {
    const list = await getReminders();
    await saveReminders(list.filter(r => r.id !== id));
    toast('提醒已删除');
  }
  openReminderPanel();
}

async function openReminderEditor(id) {
  const cid = state.currentContactId;
  if (!cid) return toast('请先打开一位联系人');
  const list = await getReminders();
  const r = id ? list.find(x => x.id === id) : null;
  const atValue = toDatetimeLocal(r ? r.at : now() + 10 * 60 * 1000);
  const repeat = r ? (r.repeat || 'once') : 'once';
  const body = `
    <div class="form-row">
      <label class="form-label">提醒内容</label>
      <input class="input" id="rm-text" placeholder="例如：记得早点休息" value="${r ? escapeHtml(r.text) : ''}">
    </div>
    <div class="form-row">
      <label class="form-label">触发时间</label>
      <input class="input" type="datetime-local" id="rm-at" value="${atValue}">
    </div>
    <div class="form-row">
      <label class="form-label">重复</label>
      <select class="input" id="rm-repeat">
        <option value="once"${repeat === 'once' ? ' selected' : ''}>单次</option>
        <option value="daily"${repeat === 'daily' ? ' selected' : ''}>每天</option>
        <option value="weekly"${repeat === 'weekly' ? ' selected' : ''}>每周</option>
      </select>
    </div>`;
  showModal(id ? '编辑提醒' : '新增提醒', body, [
    { label: '取消', cls: 'btn-outline', onClick: () => openReminderPanel() },
    { label: '保存', cls: 'btn', onClick: async () => {
      const text = ($('rm-text') && $('rm-text').value || '').trim();
      const atStr = $('rm-at') && $('rm-at').value || '';
      const rep = $('rm-repeat') && $('rm-repeat').value || 'once';
      if (!text) return toast('请输入提醒内容');
      const at = atStr ? new Date(atStr).getTime() : NaN;
      if (!Number.isFinite(at)) return toast('请选择有效的触发时间');
      const all = await getReminders();
      if (id) {
        const target = all.find(x => x.id === id);
        if (target) {
          target.text = text; target.at = at; target.repeat = rep;
          target.done = false; target.lastFiredAt = null;
        }
      } else {
        all.push({ id: uid(), contactId: cid, text, at, repeat: rep, done: false, createdAt: now(), lastFiredAt: null });
      }
      await saveReminders(all);
      toast(at <= now() ? '提醒已保存，将立即送达' : '提醒已保存');
      openReminderPanel();
    } }
  ], () => openReminderPanel());
}

/* ============ 到点触发 / 关闭期间错过 → 下次打开补发 ============
   missed=true 表示本次检查发生在启动或回到前台，到点的提醒属于「错过」，
   卡片上会明确标注「补发 / 错过的提醒」。
   同一联系人同一次检查到的多条提醒合并成 1 张卡片，避免刷屏。 */
let _checking = false;
export async function checkReminders(missed = false) {
  if (_checking) return;
  _checking = true;
  try {
    const t = now();
    const list = await getReminders();
    const due = list.filter(r => !r.done && r.at && r.at <= t);
    if (!due.length) return;
    const byContact = new Map();
    for (const r of due) {
      if (!byContact.has(r.contactId)) byContact.set(r.contactId, []);
      byContact.get(r.contactId).push(r);
    }
    let fired = false;
    for (const [cid, items] of byContact) {
      const c = await getContact(cid);
      if (!c) {
        // 联系人已被删除：直接作废这些提醒，避免反复检查
        items.forEach(r => { r.done = true; });
        continue;
      }
      const text = items.map(x => x.text).join('；');
      const at = Math.min(...items.map(x => x.at));
      const msg = {
        id: uid(), from: 'other', type: 'reminder', content: text,
        reminder: { text, at, repeat: items.length === 1 ? items[0].repeat : 'mix', missed: !!missed },
        time: t, replyTo: null, snapshot: null,
        read: true, readAt: t, replyAt: 0, replied: true
      };
      c.messages = c.messages || [];
      c.messages.push(msg);
      // 提醒卡片始终带未读标记（打开该会话后按既有逻辑清零）
      c.unread = (c.unread || 0) + 1;
      await saveContact(c);
      items.forEach(r => advanceReminder(r, t));
      fired = true;
    }
    await saveReminders(list);
    if (fired) {
      renderContacts();
      if (state.currentContactId) renderChatMessages(state.currentContactId, false);
      toast(missed ? '错过的提醒已补发到对应聊天' : '提醒已送达对应聊天', 2600);
    }
  } catch (e) {
    console.warn('提醒检查失败：', e);
  } finally {
    _checking = false;
  }
}

// 单次 → done；每天/每周 → 推进到下一个未来时间点（离线错过多次也只补 1 次）
function advanceReminder(r, t) {
  if (r.repeat === 'daily' || r.repeat === 'weekly') {
    const step = (r.repeat === 'daily' ? 1 : 7) * 86400000;
    const n = Math.floor((t - r.at) / step) + 1;
    r.at += n * step;
  } else {
    r.done = true;
  }
  r.lastFiredAt = t;
}

export function initReminderModule() {
  renderChatToolDrawer();
}
