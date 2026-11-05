// 依赖：03-data.js
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, compressImage, confirmDialog, countdownAnniversary, escapeHtml, formatTime, inputDialog, now, pick, randInt, showModal, toast } from './02-core.js';
import { applyNickname, getContact, getCurrentReplyRate, getMe, getReplyRateOf, getStatusCategories, getStatusPool, renderContacts, saveContact } from './03-data.js';

// 给联系人c的消息做级联已读：把最新一条"我发出的消息"及其之前所有我发出的都标已读
export function cascadeReadFromMe(cc, upToMsgId) {
  let changed = false;
  let reached = !upToMsgId;
  for (let i = cc.messages.length - 1; i >= 0; i--) {
    const m = cc.messages[i];
    if (m.from !== 'me') continue;
    if (!reached) {
      if (m.id === upToMsgId) reached = true;
      else continue;
    }
    if (!m.read) { m.read = true; changed = true; }
  }
  return changed;
}

// ============ 聊天消息渲染（支持懒加载：最后50条，往上滑加载更多） ============
export async function renderChatMessages(contactId, scrollToBottom=false) {
  // 切换联系人时清空引用条（同一联系人刷新不动）
  if (state._quoteRenderCid !== contactId) {
    state._quoteRenderCid = contactId;
    clearQuoteReply();
  }
  const [c, me] = await Promise.all([getContact(contactId), getMe()]);
  if (!c) return;
  const box = $('chat-messages');
  const msgs = c.messages || [];
  const lmState = state.loadMoreState[contactId] || { pageSize: 50 };
  const showCount = Math.min(msgs.length, lmState.pageSize);
  const slice = msgs.slice(msgs.length - showCount);
  const contactName = c.name;
  const myAvatar = (me && me.avatar) ? me.avatar : DEFAULT_AVATAR;
  const otherAvatar = c.avatar || DEFAULT_AVATAR;
  const html = slice.map(m => renderMsg(m, contactId, contactName, msgs, myAvatar, otherAvatar, state._animMsgId)).join('');
  // 输入中提示（对方正在输入）：typing-dots 包裹在真实的对方气泡里
  let typingHtml = '';
  if (state.chatTypingState[contactId]) {
    typingHtml = `<div class="msg-row other" data-type="_typing"><img class="msg-avatar" src="${escapeHtml(otherAvatar)}" alt=""><div class="msg-wrap"><div class="msg-bubble msg-typing"><span class="msg-typing-text">${escapeHtml(contactName)}正在输入</span><span class="typing-dots"><span></span><span></span><span></span></span></div></div></div>`;
  }
  box.innerHTML = html + typingHtml;
  state._animMsgId = null;
  // 加载更多按钮
  if (showCount < msgs.length) {
    const btn = document.createElement('div');
    btn.className = 'load-more';
    btn.textContent = `↑ 加载更早消息（还有${msgs.length - showCount}条）`;
    btn.onclick = async () => {
      lmState.pageSize += 50;
      state.loadMoreState[contactId] = lmState;
      await renderChatMessages(contactId, false);
      box.scrollTop = btn.offsetTop || 100;
    };
    box.insertBefore(btn, box.firstChild);
  }
  if (scrollToBottom) setTimeout(() => { box.scrollTop = box.scrollHeight; }, 30);
  // A21：会话已在聊天页实际渲染即视为“看到”，清除该会话未读；
  // 仅在聊天页处于激活态且渲染的正是当前会话时执行，不影响其它联系人计未读。
  // 用最新快照写回，避免覆盖渲染期间刚到达的新消息。
  const pageChat = $('page-chat');
  if (contactId === state.currentContactId && pageChat && pageChat.classList.contains('active')) {
    const fresh = await getContact(contactId);
    if (fresh && fresh.unread) {
      fresh.unread = 0;
      await saveContact(fresh);
      renderContacts();
    }
  }
  // 绑定长按
  bindLongpress(box);
}
// A26：增量渲染（补出消息时只插入新增节点，避免整列表重建导致画面跳动）
export async function renderChatIncremental(contactId) {
  const box = $('chat-messages');
  if (!box) return;
  const [c, me] = await Promise.all([getContact(contactId), getMe()]);
  if (!c) return;
  const msgs = c.messages || [];
  const lmState = state.loadMoreState[contactId] || { pageSize: 50 };
  const showCount = Math.min(msgs.length, lmState.pageSize);
  const slice = msgs.slice(msgs.length - showCount);
  const contactName = c.name;
  const myAvatar = (me && me.avatar) ? me.avatar : DEFAULT_AVATAR;
  const otherAvatar = c.avatar || DEFAULT_AVATAR;

  // 记录视口锚点，插入后补偿滚动，避免内容跳动
  const boxRect = box.getBoundingClientRect();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let anchor = null;
  for (const el of box.querySelectorAll('.msg-row[data-msgid]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > boxRect.top + 1) { anchor = { id: el.dataset.msgid, top: r.top }; break; }
  }

  const map = new Map();
  for (const el of Array.from(box.querySelectorAll('.msg-row[data-msgid]'))) map.set(el.dataset.msgid, el);
  const keep = new Set(slice.map(m => m.id));
  // 删除已不存在的消息节点
  for (const [id, el] of map) if (!keep.has(id)) { el.remove(); map.delete(id); }
  // 更新已读文案 + 缺失节点按真实时间位置插入
  const typingRow = box.querySelector('[data-type="_typing"]');
  let inserted = 0;
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const old = map.get(m.id);
    if (old) {
      const rl = old.querySelector('.msg-read');
      if (rl && m.from === 'me') { const txt = m.read ? '已读' : '未读'; if (rl.textContent !== txt) rl.textContent = txt; }
      continue;
    }
    const tpl = document.createElement('div');
    tpl.innerHTML = renderMsg(m, contactId, contactName, msgs, myAvatar, otherAvatar, state._animMsgId).trim();
    const node = tpl.firstElementChild;
    if (!node) continue;
    let nextEl = null;
    for (let j = i + 1; j < slice.length; j++) { const e2 = map.get(slice[j].id); if (e2) { nextEl = e2; break; } }
    if (nextEl) box.insertBefore(node, nextEl);
    else if (typingRow) box.insertBefore(node, typingRow);
    else box.appendChild(node);
    map.set(m.id, node);
    inserted++;
  }
  // 输入中提示同步
  if (state.chatTypingState[contactId]) {
    if (!typingRow) {
      const tpl = document.createElement('div');
      tpl.innerHTML = `<div class="msg-row other" data-type="_typing"><img class="msg-avatar" src="${escapeHtml(otherAvatar)}" alt=""><div class="msg-wrap"><div class="msg-bubble msg-typing"><span class="msg-typing-text">${escapeHtml(contactName)}正在输入</span><span class="typing-dots"><span></span><span></span><span></span></span></div></div></div>`;
      box.appendChild(tpl.firstElementChild);
    }
  } else if (typingRow) typingRow.remove();

  if (atBottom) box.scrollTop = box.scrollHeight;
  else if (anchor && inserted) {
    const el = box.querySelector(`[data-msgid="${anchor.id}"]`);
    if (el) box.scrollTop += el.getBoundingClientRect().top - anchor.top;
  }
  // 同步未读计数（聊天页当前会话）
  const pageChat = $('page-chat');
  if (contactId === state.currentContactId && pageChat && pageChat.classList.contains('active')) {
    const fresh = await getContact(contactId);
    if (fresh && fresh.unread) { fresh.unread = 0; await saveContact(fresh); renderContacts(); }
  }
}
export function renderMsg(m, contactId, contactName, allMsgs, myAvatar, otherAvatar, animId) {
  const isMe = m.from === 'me';
  // 判断系统提示消息（未接来电 / 通话 / 已拒接 / 取消呼叫等）
  let isSys = false;
  let sysText = m.content || '';
  let sysIcon = 'icon-phone';
  let sysName = isMe ? '我' : (contactName || '对方');
  let sysAction = '';   // 第一行后半段：来电、呼叫、已拒接XXX的来电 等等
  let sysSub = '';      // 第二行前半：通话已挂断/未接听/已取消/已结束 等
  let sysDuration = ''; // 第二行后半：时长 MM:SS
  let sysVideo = false;
  if (m.type === 'text') {
    const raw = sysText;
    const stripped = raw.replace(/^[\s\uFE0F\u260E\u{1F4DE}\u{1F3A5}\u{1F4F4}]+/gu, '').trim();
    // 来信系统提示："✉️ Ta 寄来了一封信，快去信箱看看吧。"
    if (/寄来了一封信/.test(stripped)) {
      isSys = true; sysText = stripped;
      sysIcon = 'icon-mail';
      sysName = contactName || '对方'; sysAction = '寄来了一封信'; sysSub = '快去信箱看看吧'; sysDuration = '';
    }
    else if (/(未接来电|通话|已拒接|已取消|拒接)/.test(stripped)) {
      isSys = true; sysText = stripped;
      sysVideo = /视频/.test(raw) || /🎥/.test(raw);
      sysIcon = sysVideo ? 'icon-video' : 'icon-phone';
      // 1. 拒接类
      let m1 = stripped.match(/^我拒接了(.+?)的来电$/);
      if (m1) { sysName = '我'; sysAction = `拒接了${m1[1]}来电`; sysSub = ''; sysDuration = ''; }
      // 2. 未接听
      let m2 = stripped.match(/^[（(]?(.+?)未接听[）)]?$/);
      if (!m2) m2 = stripped.match(/^(.+?)未接听/);
      if (m2) { sysName = m2[1]; sysAction = sysVideo ? '视频来电' : '来电'; sysSub = '未接听'; sysDuration = ''; }
      // 3. 未接来电（新增补全）：与“已通话”正则互斥，故不需再判 m3
      let m5 = stripped.match(/^(.+?)[（(]未接来电[）)]$/);
      if (!m5) m5 = stripped.match(/^(.+?)未接来电/);
      if (m5 && !m1 && !m2 && !/已取消呼叫/.test(stripped)) {
        sysName = m5[1].trim();
        sysAction = sysVideo ? '视频来电' : '来电';
        sysSub = '未接听';
        sysDuration = '';
      }
      // 4. 已通话 时长
      let m3 = stripped.match(/^[（(]?(?:视频)?已通话\s*(\d{1,2}:\d{2})[）)]?$/);
      if (!m3) m3 = stripped.match(/(?:视频)?已通话\s*(\d{1,2}:\d{2})/);
      if (m3) {
        sysAction = sysVideo ? '视频来电' : '来电';
        sysSub = sysVideo ? '视频通话·已结束' : '通话已挂断';
        sysDuration = m3[1];
      }
      // 5. 已取消呼叫
      if (/已取消呼叫/.test(stripped)) {
        sysAction = sysVideo ? '视频呼叫' : '呼叫';
        sysSub = '已取消';
        sysDuration = '';
      }
    }
  }
  let wrapClass = 'msg-row ';
  if (isSys) {
    wrapClass += 'msg-center';
    // 单行紧凑结构：图标 + 名字 + 动作 + · + 状态
    const sysStatus = sysSub ? (sysDuration ? `${sysSub} ${sysDuration}` : sysSub) : sysDuration;
    const sysCardHtml = `<div class="sys-card"><span class="sys-icon"><svg class="i"><use href="#${sysIcon}"/></svg></span><span class="sys-name">${escapeHtml(sysName)}</span>${sysAction ? `<span class="sys-action">${escapeHtml(sysAction)}</span>` : ''}${sysStatus ? `<span class="sys-sep">·</span><span class="sys-sub">${escapeHtml(sysStatus)}</span>` : ''}</div>`;
    const wrapInner = `<div class="msg-system">${sysCardHtml}</div>`;
    return `<div class="${wrapClass}" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="${m.type}">${wrapInner}</div>`;
  }
  wrapClass += isMe ? 'me' : 'other';
  // A17：仅本次真实发送的那条消息播放发出动画，历史/重渲染保持静态
  if (isMe && animId && m.id === animId) wrapClass += ' msg-sent-anim';
  // 引用
  let quoteHtml = '';
  if (m.replyTo) {
    const ref = allMsgs.find(x => x.id === m.replyTo);
    if (ref) {
      const refMe = ref.from === 'me';
      let refContent = '';
      if (ref.type === 'text') refContent = `<span class="multi-ellipsis">${escapeHtml(ref.content)}</span>`;
      else if (ref.type === 'image') refContent = `<img class="msg-quote-img" src="${escapeHtml(ref.content)}" alt="" onclick="event.stopPropagation();previewImg('${escapeHtml(ref.content)}')">`;
      else if (ref.type === 'sticker') refContent = `<img class="msg-quote-img" src="${escapeHtml(ref.content)}" alt="" onclick="event.stopPropagation();previewImg('${escapeHtml(ref.content)}')">`;
      else if (ref.type === 'choice') refContent = `<span><svg class="i i-sm"><use href="#icon-target"/></svg> ${escapeHtml(ref.choice.question)}</span>`;
      else if (ref.type === 'reminder') refContent = `<span><svg class="i i-sm"><use href="#icon-bell"/></svg> ${escapeHtml((ref.reminder && ref.reminder.text) || ref.content)}</span>`;
      else if (ref.type === 'musicInvite') refContent = `<span><svg class="i i-sm"><use href="#icon-headphones"/></svg> 一起听 · ${escapeHtml((ref.musicInvite && ref.musicInvite.trackName) || '本地歌曲')}</span>`;
      quoteHtml = `<div class="msg-quote" onclick="jumpToMsg('${ref.id}')"><strong style="font-size:11px;">${refMe?'我':escapeHtml(contactName)}：</strong>${refContent}</div>`;
    }
  }
  // 内容
  let contentHtml = '';
  if (m.type === 'text') contentHtml = `<div class="msg-bubble">${escapeHtml(m.content).replace(/\n/g,'<br>')}</div>`;
  else if (m.type === 'image') contentHtml = `<img class="msg-img" src="${escapeHtml(m.content)}" alt="" onclick="previewImg('${escapeHtml(m.content)}')">`;
  else if (m.type === 'sticker') contentHtml = `<img class="msg-sticker" src="${escapeHtml(m.content)}" alt="">`;
  else if (m.type === 'choice') {
    const ch = m.choice || {};
    const opts = ch.options || [];
    const question = ch.question || '';
    const questionHtml = question ? `<div class="msg-choice-question"><svg class="i i-sm"><use href="#icon-target"/></svg> ${escapeHtml(question)}</div>` : '';
    const optsHtml = opts.map((o, i) => {
      const letter = String.fromCharCode(65 + i);
      const picked = (ch.result && String(ch.result).split('、').includes(letter)) ? ' choice-picked' : '';
      return `<div class="msg-choice-option${picked}"><span class="choice-letter">${letter}</span>. ${escapeHtml(o)}</div>`;
    }).join('');
    // 已出结果时：末尾再加结果行（"X帮你选了：字母·选项"），多选时合并展示
    let resultHtml = '';
    if (ch.result) {
      const pickedLetters = String(ch.result).split('、');
      const texts = pickedLetters.map(L => opts[L.charCodeAt(0) - 65] || L);
      const who = (m.from === 'other') ? escapeHtml(contactName) : '你';
      resultHtml = `<div class="msg-choice-result">${who}帮你选了：${escapeHtml(String(ch.result))} · ${escapeHtml(texts.join('、'))}</div>`;
    }
    contentHtml = `<div class="msg-bubble"><div class="msg-choice">
      ${questionHtml}${optsHtml}${resultHtml}
    </div></div>`;
  }
  else if (m.type === 'reminder') {
    // 提醒卡片：由该联系人在聊天中发出，显示「联系人名字 提醒你 …」
    const r = m.reminder || {};
    const head = r.missed ? '补发的提醒（错过的提醒）' : '提醒';
    contentHtml = `<div class="msg-bubble"><div class="msg-choice msg-reminder${r.missed ? ' missed' : ''}">
      <div class="msg-reminder-head"><svg class="i"><use href="#icon-bell"/></svg> ${head}</div>
      <div class="msg-reminder-text">${escapeHtml(r.text || m.content)}</div>
      <div class="msg-reminder-meta">${escapeHtml(contactName)} 提醒你${r.at ? ' · ' + escapeHtml(new Date(r.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : ''}${r.missed ? ' · 应用未打开，已补发' : ''}</div>
    </div></div>`;
  }
  else if (m.type === 'musicInvite') {
    // 一起听邀请卡：名片式（左侧大号音乐图标，右侧邀请文案/歌名/状态）
    const inv = m.musicInvite || {};
    const isOut = m.from === 'me';
    const song = escapeHtml(inv.trackName || '本地歌曲');
    let statusText = '';
    if (inv.status === 'pending') statusText = isOut ? '等待回应…' : '等待你的回应';
    else if (inv.status === 'accepted') statusText = '正在一起听';
    else if (inv.status === 'rejected') statusText = '已拒绝';
    else if (inv.status === 'ended') statusText = '一起听已结束';
    const actions = (!isOut && inv.status === 'pending')
      ? `<div class="msg-invite-actions">
          <button class="btn" onclick="musicAcceptInvite('${contactId}','${m.id}')">接受</button>
          <button class="btn-outline btn" onclick="musicRejectInvite('${contactId}','${m.id}')">拒绝</button>
        </div>`
      : '';
    const title = isOut
      ? `你邀请${escapeHtml(contactName)}一起听`
      : `${escapeHtml(contactName)} 邀请你一起听`;
    contentHtml = `<div class="msg-bubble msg-music-bubble"><div class="msg-music-card">
      <div class="msg-music-card-icon"><svg class="i"><use href="#icon-music"/></svg></div>
      <div class="msg-music-card-body">
        <div class="msg-music-card-title">${title}</div>
        <div class="msg-music-card-song">《${song}》</div>
        <div class="msg-invite-status">${statusText}</div>
        ${actions}
      </div>
    </div></div>`;
  }
  const typingHtml = (m.type === '_typing') ? `<div class="msg-bubble msg-typing"><span class="msg-typing-text">${escapeHtml(contactName)}正在输入</span><span class="typing-dots"><span></span><span></span><span></span></span></div>` : '';
  if (typingHtml) return `<div class="msg-row other" data-type="_typing"><img class="msg-avatar" src="${escapeHtml(otherAvatar||DEFAULT_AVATAR)}" alt=""><div class="msg-wrap">${typingHtml}</div></div>`;
  // 时间戳和已读
  const timeHtml = `<div class="msg-time">${formatTime(m.time)}</div>`;
  const readHtml = isMe ? `<div class="msg-read">${m.read ? '已读' : '未读'}</div>` : '';
  const avImg = isMe
    ? `<img class="msg-avatar" src="${escapeHtml(myAvatar||DEFAULT_AVATAR)}" alt="">`
    : `<img class="msg-avatar" src="${escapeHtml(otherAvatar||DEFAULT_AVATAR)}" alt="">`;
  // 结构：引用块独立占第一行；主气泡（含图片/卡片）在第二行，头像只在第二行与气泡顶边对齐；时间/已读在第三行
  const mainHtml = `<div class="msg-main">${contentHtml}</div>`;
  const metaHtml = `<div class="msg-meta">${timeHtml}${readHtml}</div>`;
  if (isMe) {
    // 我：气泡在左，头像在右
    return `<div class="${wrapClass}" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="${m.type}">
      ${quoteHtml}
      ${mainHtml}
      ${metaHtml}
      ${avImg}
    </div>`;
  }
  // 对方：头像在左，气泡在右
  return `<div class="${wrapClass}" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="${m.type}">
    ${avImg}
    ${quoteHtml}
    ${mainHtml}
    ${metaHtml}
  </div>`;
}
export function jumpToMsg(id) {
  const el = document.querySelector(`[data-msgid="${id}"]`);
  if (el) { el.scrollIntoView({behavior:'smooth', block:'center'}); el.style.transition='background 0.5s'; el.style.background='rgba(107,138,255,0.2)'; setTimeout(()=>{el.style.background='';},1200); }
}
export function previewImg(src) {
  $('img-preview-img').src = src;
  $('img-preview').classList.remove('hide');
}
export function closeImgPreview() { $('img-preview').classList.add('hide'); }

// ============ 长按绑定（引用回复/删除） ============
export function bindLongpress(container) {
  const rows = container.querySelectorAll('.msg-row');
  rows.forEach(row => {
    let t = null;
    const start = (e) => {
      clearTimeout(t);
      const pt = (e.touches ? e.touches[0].clientX : e.clientX);
      const py = (e.touches ? e.touches[0].clientY : e.clientY);
      t = setTimeout(() => showLongpressMenu(row, pt, py), 500);
    };
    const cancel = () => clearTimeout(t);
    row.addEventListener('mousedown', start);
    row.addEventListener('touchstart', start, {passive:true});
    row.addEventListener('mouseup', cancel);
    row.addEventListener('mouseleave', cancel);
    row.addEventListener('touchend', cancel);
    row.addEventListener('touchmove', cancel);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showLongpressMenu(row, e.clientX, e.clientY); });
  });
}
export function showLongpressMenu(row, x, y) {
  const id = row.dataset.msgid;
  const from = row.dataset.from;
  const menu = $('lp-menu');
  menu.innerHTML = `<div onclick="quoteReply('${id}')" style="display:flex;align-items:center;gap:8px;"><svg class="i i-sm" style="transform:scaleX(-1);"><use href="#icon-back"/></svg> 引用回复</div><div onclick="deleteMsg('${id}')" style="color:var(--danger);display:flex;align-items:center;gap:8px;"><svg class="i i-sm"><use href="#icon-trash"/></svg> 删除</div>`;
  menu.classList.remove('hide');
  // 定位
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 150) + 'px';
  menu.style.top = Math.min(y, vh - 120) + 'px';
  const close = (e) => { if (!menu.contains(e.target)) { menu.classList.add('hide'); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}
export async function quoteReply(msgId) {
  const lp = $('lp-menu'); if (lp) lp.classList.add('hide');
  const c = await getContact(state.currentContactId);
  const m = (c?.messages || []).find(x => x.id === msgId);
  if (!m) return;
  const box = $('chat-input-box');
  if (!box) return;
  box.dataset.replyto = msgId;
  const bar = $('quote-bar');
  if (bar) {
    bar.classList.remove('hide');
    const qt = $('quote-text');
    const prefix = m.from === 'me' ? '我' : c.name;
    const preview = m.type === 'text' ? m.content.slice(0, 30) : (m.type === 'image' ? '[图片]' : m.type === 'sticker' ? '[表情包]' : '[消息]');
    if (qt) qt.textContent = `引用 ${prefix}：${preview}`;
  }
  box.focus();
}
export function clearQuoteReply() {
  const box = $('chat-input-box'); if (box) delete box.dataset.replyto;
  const bar = $('quote-bar'); if (bar) bar.classList.add('hide');
  const qt = $('quote-text'); if (qt) qt.textContent = '';
}
export async function deleteMsg(msgId) {
  const lp = $('lp-menu'); if (lp) lp.classList.add('hide');
  if (!await confirmDialog('确定删除这条消息吗？')) return;
  const c = await getContact(state.currentContactId);
  if (!c) return;
  c.messages = (c.messages || []).filter(m => m.id !== msgId);
  await saveContact(c);
  await renderChatMessages(state.currentContactId, true);
}

// ============ 发送消息 ============
export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
export function onChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendTextMessage();
  }
}
export async function sendTextMessage() {
  const box = $('chat-input-box');
  const text = box.value.trim();
  const replyTo = box.dataset.replyto || null;
  if (!text) return;
  box.value = '';
  autoResize(box);
  await sendMessageCore({ type:'text', content:text, replyTo });
}
export async function sendImageMessage(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  input.value = '';
  try {
    const data = await compressImage(file);
    await sendMessageCore({ type:'image', content:data, replyTo: null });
  } catch (e) { toast('图片处理失败'); }
}
export async function sendStickerMessage(data) {
  await sendMessageCore({ type:'sticker', content:data, replyTo: null });
}
export async function sendChoiceMessage(question, options, result, allowMulti) {
  await sendMessageCore({ type:'choice', choice:{ question, options, result, allowMulti: !!allowMulti }, content: '', replyTo: null });
}

// 取消联系人当前的回复定时器（A26：键全部带 cid，避免跨联系人串台）
export function cancelRoundTimers(cid) {
  for (const k in state.chatTimers) {
    if (k.indexOf('_' + cid + '_') !== -1 && (k.startsWith('rd_') || k.startsWith('rp_'))) {
      clearTimeout(state.chatTimers[k]); delete state.chatTimers[k];
    }
  }
  const keys = ['rm_'+cid, 'rt_'+cid, 'rr_'+cid];
  for (const k of keys) { if (state.chatTimers[k]) { clearTimeout(state.chatTimers[k]); delete state.chatTimers[k]; } }
  state.chatTypingState[cid] = false;
}
function clearJudgeTimers(cid, key) {
  for (const p of ['rd_', 'rp_']) {
    const k = p + cid + '_' + key;
    if (state.chatTimers[k]) { clearTimeout(state.chatTimers[k]); delete state.chatTimers[k]; }
  }
}
// 回复条数范围：旧单值 replyCount 自动扩展为 min=max；不设上限，保留 >=1 校验
export function replyCountRange(c) {
  const s = (c && c.settings) || {};
  let min = s.replyCountMin != null ? parseInt(s.replyCountMin) : parseInt(s.replyCount);
  let max = s.replyCountMax != null ? parseInt(s.replyCountMax) : parseInt(s.replyCount);
  if (!Number.isFinite(min) || min < 1) min = 1;
  if (!Number.isFinite(max) || max < 1) max = min;
  if (min > max) { const t = min; min = max; max = t; }
  return { min, max };
}
export function pickReplyCount(c) {
  const { min, max } = replyCountRange(c);
  return min === max ? min : randInt(min, max);
}
// 生成一批回复（条数由调用方决定，不超上限；时间戳=命中时刻，按 1~3 秒递增且不晚于当前）
export async function appendReplyMessages(c, anchor, count, atTime) {
  const cards = (c.cardGroups || []).flatMap(g => (g.cards || []).map(x => ({ content: x.content })));
  const stickers = c.stickers || [];
  const total = Math.max(0, count || 0);
  const base = Math.min(Number(atTime) || now(), now());
  let sent = 0;
  for (let i = 0; i < total; i++) {
    if (!cards.length && !stickers.length) break;
    const useSticker = stickers.length > 0 && Math.random() < 0.5;
    let type = 'text', content = '';
    if (useSticker) { type = 'sticker'; content = pick(stickers).data; }
    else if (cards.length) { type = 'text'; content = await applyNickname(pick(cards).content, c); }
    else continue;
    const history = (c.messages || []).filter(x => x.type === 'text' || x.type === 'image' || x.type === 'sticker' || x.type === 'choice');
    let replyTo = null;
    if (history.length && Math.random() < 0.5) replyTo = pick(history).id;
    const time = Math.min(now(), base + i * randInt(1000, 3000));
    c.messages.push({
      id: uid(), from: 'other', type, content,
      time, replyTo, snapshot: null,
      read: true, readAt: time, replyAt: 0, replied: true, replyDone: true
    });
    sent++;
  }
  return sent;
}
// 触发 N 条回复（兼容旧入口）
export async function emitRoundReplies(cid, baseMsg, count) {
  const cc = await getContact(cid); if (!cc) return;
  const sent = await appendReplyMessages(cc, baseMsg, count, now());
  await saveContact(cc);
  if (state.currentContactId === cid) renderChatIncremental(cid);
  else if (sent) { cc.unread = (cc.unread || 0) + sent; await saveContact(cc); }
  renderContacts();
  return sent;
}
// 已读/回复定时排程（实时）；补算路径由 08-main 的判定组统一处理
function scheduleJudgement(cid, key, msgIds, judgement, readAt, replyAt, replyCount) {
  clearJudgeTimers(cid, key);
  const readKey = 'rd_' + cid + '_' + key;
  const repKey = 'rp_' + cid + '_' + key;
  state.chatTimers[readKey] = setTimeout(() => {
    delete state.chatTimers[readKey];
    const task = async () => {
      const cc = await getContact(cid); if (!cc) return;
      if (!msgIds.some(id => { const m = cc.messages.find(x => x.id === id); return m && m.read; })) {
        cascadeReadFromMe(cc, msgIds[msgIds.length - 1]);
        await saveContact(cc);
      }
      if (state.currentContactId === cid) renderChatIncremental(cid);
      if (judgement === 'reply') {
        state.chatTypingState[cid] = true;
        if (state.currentContactId === cid) renderChatIncremental(cid);
      } else if (judgement === 'readNoReply') {
        state.chatTypingState[cid] = true;
        if (state.currentContactId === cid) renderChatIncremental(cid);
        const mk = 'rm_' + cid + '_' + key;
        state.chatTimers[mk] = setTimeout(() => {
          delete state.chatTimers[mk];
          state.chatTypingState[cid] = false;
          if (state.currentContactId === cid) renderChatIncremental(cid);
        }, 4000);
      }
    };
    // 与补算串行，避免定时器与补算同时生成同一条回复
    if (typeof window.__enqueueTask === 'function') window.__enqueueTask(task); else task();
  }, Math.max(0, readAt - now()));
  if (judgement !== 'reply') return;
  state.chatTimers[repKey] = setTimeout(() => {
    delete state.chatTimers[repKey];
    const task = async () => {
      const cc = await getContact(cid); if (!cc) return;
      const grp = cc.messages.filter(m => msgIds.includes(m.id));
      if (grp.some(m => m.replyDone)) { state.chatTypingState[cid] = false; return; }
      cascadeReadFromMe(cc, msgIds[msgIds.length - 1]);
      const anchor = cc.messages.find(x => x.id === msgIds[msgIds.length - 1]) || cc.messages[cc.messages.length - 1];
      const sent = await appendReplyMessages(cc, anchor, replyCount, replyAt);
      for (const m of grp) { m.replied = true; m.replyDone = true; }
      state.chatTypingState[cid] = false;
      if (state.currentContactId === cid) { await saveContact(cc); renderChatIncremental(cid); }
      else { cc.unread = (cc.unread || 0) + sent; await saveContact(cc); }
      renderContacts();
    };
    if (typeof window.__enqueueTask === 'function') window.__enqueueTask(task); else task();
  }, Math.max(800, replyAt - now()));
}
// 已读/回复判定链的公共排程：普通消息与一起听邀请共用同一套时间与规则
export function computeReadPlan(c, st, cat, baseTime, nowT) {
  const fastSec = Math.max(1, c.settings.fastSec || 5);
  const slowMin = Math.max(1, c.settings.slowMin || 3);
  const maxSec = Math.max(fastSec, slowMin * 60);
  const rate = st ? st.replyRate : 50;
  const readDelay = maxSec > fastSec ? randInt(fastSec, maxSec - 1) : maxSec;
  // 第一个骰子：该状态的 replyRate 判回不回
  const willReply = Math.random() * 100 < rate;
  let judgement = 'unread', readAt = 0, replyAt = 0, replyCount = 0;
  if (willReply) {
    const replyDelay = readDelay < maxSec ? randInt(readDelay + 1, maxSec) : readDelay;
    readAt = baseTime + readDelay * 1000;
    replyAt = baseTime + replyDelay * 1000;
    if (readAt <= nowT) { readAt = nowT + 1000; replyAt = Math.max(replyAt, readAt + 1000); }
    judgement = 'reply';
    replyCount = pickReplyCount(c);
  } else {
    // 第二个骰子：所属大类拆分判「未读 / 已读不回」
    const unreadRoll = Math.random() * 100 < (cat ? cat.unread : 100);
    if (unreadRoll) { judgement = 'unread'; readAt = 0; }
    else {
      judgement = 'readNoReply';
      readAt = baseTime + readDelay * 1000;
      if (readAt <= nowT) readAt = nowT + 1000;
    }
  }
  return { judgement, readAt, replyAt, replyCount, readDelay, maxSec, fastSec, slowMin, rate };
}
// 发送消息核心：状态驱动判定链（分节 + 两个骰子 + 挂起队列）
export async function sendMessageCore({ type, content, choice, replyTo }) {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  if (!c) return;

  if (type === 'choice' && choice && choice.result != null) {
    // 帮我选择：必回 + 延迟缩到 10秒~3分钟（独立流程不合并）
    return sendChoiceResponseFlow(c, choice);
  }

  const nowT = now();
  // 1) 记录发送时刻与当时状态（statusId 快照写入消息）
  const msg = {
    id: uid(), from:'me', type, content: content || '', choice: choice || undefined,
    time: nowT, replyTo,
    snapshot: null, read: false, readAt: 0, replyAt: 0, replied: false,
    judgement: null, judgeKey: null
  };
  c.messages.push(msg);

  // 2) 分节：连续我发出的消息 1~2 条独立，≥3 条每 3 条一节（第 3/6/9…条到达时合并成节）
  const msgs = c.messages;
  let runStart = msgs.length - 1;
  while (runStart > 0 && msgs[runStart - 1].from === 'me') runStart--;
  const runLen = msgs.length - runStart;
  let group = [msg];
  let isSection = false;
  if (runLen >= 3) {
    const local = runLen - 1;
    const gsize = (local % 3) + 1;
    if (gsize === 3) {
      const gStart = local - 2;
      const cand = [msgs[runStart + gStart], msgs[runStart + gStart + 1], msgs[runStart + gStart + 2]];
      // 只合并尚未被已读/回复的 3 条，避免覆盖已经发生的结果
      if (cand.every(m => m && !m.read && !m.replyDone)) { group = cand; isSection = true; }
    }
  }
  const judgeKey = isSection ? uid() : msg.id;
  if (isSection) {
    for (const m of group) { if (m.judgeKey) clearJudgeTimers(cid, m.judgeKey); }
    // 之前独立判定为未读的挂起项取消（同节重新判定）
    c.pendingReplies = (c.pendingReplies || []).filter(p => !(p.msgIds || []).some(id => group.some(m => m.id === id)));
  }

  const pool = await getStatusPool();
  const cats = await getStatusCategories();
  const st = pool.find(s => s.id === c.statusId) || null;
  const rate = st ? st.replyRate : 50; // status.replyRate = 已读并回复的概率（0-100）
  const cat = cats.find(x => x.id === (st && st.category)) || cats[0];

  const baseTime = isSection ? group[0].time : nowT;
  const plan = computeReadPlan(c, st, cat, baseTime, nowT);
  const judgement = plan.judgement, readAt = plan.readAt, replyAt = plan.replyAt, replyCount = plan.replyCount;
  for (const m of group) {
    m.snapshot = { status: st ? st.name : '', statusId: c.statusId, rate, category: st ? st.category : '' };
    m.judgeKey = judgeKey;
    m.judgement = judgement;
    m.sectionId = isSection ? judgeKey : null;
    m.read = false;
    m.readAt = readAt;
    m.replyAt = judgement === 'reply' ? replyAt : 0;
    m.replied = false;
    m.replyDone = false;
    m.queued = judgement === 'unread';
  }
  if (judgement === 'unread') {
    c.pendingReplies = c.pendingReplies || [];
    c.pendingReplies.push({
      id: uid(), sectionId: isSection ? judgeKey : null,
      msgIds: group.map(m => m.id), sentAt: nowT,
      statusId: c.statusId, windows: 0
    });
  }
  await saveContact(c);
  state._animMsgId = msg.id;
  await renderChatMessages(cid, true);
  clearQuoteReply();
  if (judgement === 'unread') return; // 挂起：等状态切换窗口
  scheduleJudgement(cid, judgeKey, group.map(m => m.id), judgement, readAt, replyAt, replyCount);
}

// 选择流程：先发提问消息 → 10s~3min 后对方回复选择
export async function sendChoiceResponseFlow(c, choice) {
  const cid = c.id;
  // 我的消息
  const qMsg = {
    id: uid(), from:'me', type:'choice', choice, content:'', time:now(), replyTo:null,
    snapshot: { status: c.status, rate: getCurrentReplyRate(c), willReply: true },
    read: false, readAt: now()+2000, replyAt: 0, replied: false
  };
  c.messages.push(qMsg);
  await saveContact(c);
  state._animMsgId = qMsg.id;
  if (state.currentContactId === cid) renderChatMessages(cid, true);
  // 延迟：10秒~3分钟
  const delay = randInt(10, 180);
  const replyAt = now() + delay*1000;
  // 已读
  setTimeout(async () => {
    const cc = await getContact(cid);
    const m = cc.messages.find(x => x.id === qMsg.id);
    if (m) { m.read = true; await saveContact(cc); if (state.currentContactId===cid) renderChatMessages(cid); }
  }, 2000);
  const repKey = `choice_${cid}_${qMsg.id}`;
  state.chatTimers[repKey] = setTimeout(async () => {
    const cc = await getContact(cid);
    if (!cc) { delete state.chatTimers[repKey]; return; }
    // 选择结果：允许对方多选时随机勾 2~N 项，否则单选一项
    let letters;
    if (choice.allowMulti && choice.options.length >= 2) {
      const arr = choice.options.map((_, i) => i);
      for (let k = arr.length - 1; k > 0; k--) { const j = randInt(0, k); const t = arr[k]; arr[k] = arr[j]; arr[j] = t; }
      const n = randInt(2, choice.options.length);
      letters = arr.slice(0, n).sort((a, b) => a - b).map(i => String.fromCharCode(65 + i)).join('、');
    } else {
      letters = String.fromCharCode(65 + randInt(0, choice.options.length-1));
    }
    // 回复：choice 类型特殊消息
    const all = cc.cardGroups.flatMap(g => g.cards);
    let lead = '';
    if (all.length) lead = pick(all).content + ' ';
    const resultMsg = {
      id: uid(), from:'other', type:'choice',
      choice: { question: choice.question, options: choice.options, result: letters, allowMulti: !!choice.allowMulti, leadText: lead },
      content: '',
      time: replyAt, replyTo: qMsg.id, snapshot: null,
      read: true, readAt: replyAt, replyAt: 0, replied: true
    };
    cc.messages.push(resultMsg);
    const qm = cc.messages.find(x => x.id === qMsg.id);
    if (qm) { qm.replied = true; qm.choice.result = letters; }
    await saveContact(cc);
    if (state.currentContactId === cid) renderChatMessages(cid, true);
    else { cc.unread = (cc.unread||0)+1; await saveContact(cc); }
    delete state.chatTimers[repKey];
    renderContacts();
  }, delay*1000);
}

// 触发回复：从字卡库随机抽，条数按设置范围；50%引用历史，50%概率用表情包
export async function triggerReply(c, triggerMsg) {
  return appendReplyMessages(c, triggerMsg, pickReplyCount(c), triggerMsg.replyAt || now());
}

// ============ 折叠菜单 ============
export function toggleChatMenu(e) {
  if (e) e.stopPropagation();
  const m = $('chat-menu');
  // 功能入口已迁入「＋」工具抽屉，折叠栏不再承载功能仓库；为空时直接不展开
  if (!m || !m.children.length) return;
  m.classList.toggle('hide');
  if (!m.classList.contains('hide')) {
    const close = (ev) => { if (!m.contains(ev.target) && !(ev.target.closest && ev.target.closest('[title="更多"]'))) { m.classList.add('hide'); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

export function openChoice() {
  toggleChatMenu();
  const cid = state.currentContactId;
  if (!cid) return;
  const html = `
    <div class="form-row"><label class="form-label">问题</label><input class="input" id="cw-q" placeholder="如：今天吃什么？"></div>
    <div class="form-row">
      <label class="form-label">选项（至少2个）</label>
      <div id="cw-opts">
        <div class="choice-opt"><input class="input" type="text" placeholder="A"><button onclick="this.parentNode.remove()"><svg class="i i-sm"><use href="#icon-close"/></svg></button></div>
        <div class="choice-opt"><input class="input" type="text" placeholder="B"><button onclick="this.parentNode.remove()"><svg class="i i-sm"><use href="#icon-close"/></svg></button></div>
      </div>
      <button class="btn-outline btn" style="width:100%;margin-top:8px;" onclick="addChoiceOpt()">＋ 添加选项</button>
    </div>
    <div class="form-row" style="display:flex;align-items:center;justify-content:space-between;">
      <label class="form-label" style="margin:0;">允许对方多选</label>
      <div class="switch" id="cw-multi" onclick="this.classList.toggle('on')"></div>
    </div>
  `;
  showModal('选择', html, [
    { label:'取消', cls:'btn-outline', onClick: closeModal },
    { label:'发送请对方选择', cls:'btn', onClick: async () => {
      const q = $('cw-q').value.trim();
      const opts = Array.from(document.querySelectorAll('#cw-opts input')).map(x=>x.value.trim()).filter(Boolean);
      const allowMulti = !!($('cw-multi') && $('cw-multi').classList.contains('on'));
      if (!q) return toast('请输入问题');
      if (opts.length < 2) return toast('至少2个选项');
      closeModal();
      await sendChoiceMessage(q, opts, null, allowMulti);
    }}
  ]);
}
export function addChoiceOpt() {
  const div = document.createElement('div');
  div.className = 'choice-opt';
  div.innerHTML = `<input class="input" type="text"><button onclick="this.parentNode.remove()"><svg class="i i-sm"><use href="#icon-close"/></svg></button>`;
  $('cw-opts').appendChild(div);
}

export function openAnniversary() {
  toggleChatMenu();
  const cid = state.currentContactId;
  if (!cid) return;
  renderAnniversaryPanel(cid);
}
export async function renderAnniversaryPanel(cid) {
  const c = await getContact(cid);
  const items = c.anniversaries || [];
  const rows = items.map(a => {
    const r = countdownAnniversary(a.date);
    let cls = 'anni-countdown', txt = '';
    if (r) {
      if (r.todayIsOrigin) { cls += ' anni-today'; txt = '就是今天'; }
      else if (r.diff > 0) txt = `还有${r.diff}天`;
      else { cls += ' anni-past'; txt = `已过${Math.abs(r.diff)}天`; }
    }
    return `<div class="anni-item">
      <div class="anni-info">
        <div class="anni-name">${escapeHtml(a.name)}</div>
        <div class="anni-date">${escapeHtml(a.date)}</div>
      </div>
      <div class="${cls}">${txt}</div>
      <div style="display:flex;gap:4px;margin-left:8px;">
        <button style="background:#dbeafe;color:#1e40af;width:32px;height:32px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;" onclick="editAnni('${a.id}')"><svg class="i i-sm" style="stroke:#1e40af;"><use href="#icon-pencil"/></svg></button>
        <button style="background:#fee2e2;color:#991b1b;width:32px;height:32px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;" onclick="delAnni('${a.id}')"><svg class="i i-sm" style="stroke:#991b1b;"><use href="#icon-trash"/></svg></button>
      </div>
    </div>`;
  }).join('');
  const body = `<div id="anni-list-wrap">
    ${items.length ? rows : '<div class="empty" style="padding:30px 10px;">还没有纪念日</div>'}
    <button class="btn" style="width:100%;margin-top:14px;" onclick="addAnni()">＋ 添加纪念日</button>
  </div>`;
  showModal(`${c.name}的纪念日`, body, [{label:'关闭', cls:'btn-outline', onClick:closeModal}]);
}
export async function addAnni() {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  const r = await inputDialog('添加纪念日', [
    { key: 'name', label: '纪念日名称', value: '纪念日', required: true },
    { key: 'date', label: '日期', type: 'date', value: new Date().toISOString().slice(0,10), required: true }
  ], '保存');
  if (!r) return;
  const name = (r.name || '').trim() || '纪念日';
  const date = r.date || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式错误');
  c.anniversaries = c.anniversaries || [];
  c.anniversaries.push({ id: uid(), name, date });
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
export async function editAnni(id) {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  const a = (c.anniversaries || []).find(x => x.id === id);
  if (!a) return;
  const r = await inputDialog('编辑纪念日', [
    { key: 'name', label: '纪念日名称', value: a.name, required: true },
    { key: 'date', label: '日期', type: 'date', value: a.date, required: true }
  ], '保存');
  if (!r) return;
  const date = r.date || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式错误');
  a.name = (r.name || '').trim() || a.name; a.date = date;
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
export async function delAnni(id) {
  if (!await confirmDialog('确定删除这个纪念日吗？')) return;
  const cid = state.currentContactId;
  const c = await getContact(cid);
  c.anniversaries = (c.anniversaries || []).filter(x => x.id !== id);
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
