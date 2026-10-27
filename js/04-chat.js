// 依赖：03-data.js
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, compressImage, countdownAnniversary, escapeHtml, formatTime, now, pick, randInt, showModal, toast } from './02-core.js';
import { applyNickname, getContact, getCurrentReplyRate, getMe, getReplyRateOf, renderContacts, saveContact } from './03-data.js';
import { runCatchUp } from './08-main.js';

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
  const html = slice.map(m => renderMsg(m, contactName, msgs, myAvatar, otherAvatar)).join('');
  // 输入中提示气泡（对方正在输入）
  let typingHtml = '';
  if (state.chatTypingState[contactId]) {
    typingHtml = `<div class="msg-row other" data-type="_typing"><img class="msg-avatar" src="${escapeHtml(otherAvatar)}" alt=""><div class="msg-wrap"><div class="msg-typing">${escapeHtml(contactName)}正在输入<span class="typing-dots"><span></span><span></span><span></span></span></div></div></div>`;
  }
  box.innerHTML = html + typingHtml;
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
  // 绑定长按
  bindLongpress(box);
}
export function renderMsg(m, contactName, allMsgs, myAvatar, otherAvatar) {
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
    const stripped = raw.replace(/^[\s📞🎥📴☎️✉️]/g,'').trim();
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
      // 1. 拒接类："（我拒接了XXX的来电）" → 第一行：我 拒接了XXX来电  第二行：无时长
      let m1 = stripped.match(/^我拒接了(.+?)的来电$/);
      if (m1) { sysName = '我'; sysAction = `拒接了${m1[1]}来电`; sysSub = ''; sysDuration = ''; }
      // 2. 未接听 → 第一行：姓名 来电  第二行：未接听
      let m2 = stripped.match(/^[（(]?(.+?)未接听[）)]?$/);
      if (!m2) m2 = stripped.match(/^(.+?)未接听/);
      if (m2) { sysName = m2[1]; sysAction = sysVideo ? '视频来电' : '来电'; sysSub = '未接听'; sysDuration = ''; }
      // 3. 已通话 时长 → 第一行：姓名 来电  第二行：通话已挂断·时长 XX:XX
      let m3 = stripped.match(/^[（(]?(?:视频)?已通话\s*(\d{1,2}:\d{2})[）)]?$/);
      if (!m3) m3 = stripped.match(/(?:视频)?已通话\s*(\d{1,2}:\d{2})/);
      if (m3) {
        sysAction = sysVideo ? '视频来电' : '来电';
        sysSub = sysVideo ? '视频通话·已结束' : '通话已挂断';
        sysDuration = m3[1];
      }
      // 4. 已取消呼叫
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
    // 单行紧凑结构：图标 + 姓名 + 动作 · 说明 · 时长
    const sysCardHtml = `<div class="sys-card">
      <span class="sys-icon"><svg class="i"><use href="#${sysIcon}"/></svg></span>
      <span class="sys-name">${escapeHtml(sysName)}</span>
      ${sysAction ? `<span class="sys-action">${escapeHtml(sysAction)}</span>` : ''}
      ${sysSub ? `<span>· ${escapeHtml(sysSub)}</span>` : ''}
      ${sysDuration ? `<span>· 时长<span class="sys-dur">${escapeHtml(sysDuration)}</span></span>` : ''}
    </div>`;
    const wrapInner = `<div class="msg-system">${sysCardHtml}</div>`;
    return `<div class="${wrapClass}" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="${m.type}">${wrapInner}</div>`;
  }
  wrapClass += isMe ? 'me' : 'other';
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
      const picked = (ch.result && ch.result === letter) ? ' choice-picked' : '';
      return `<div class="msg-choice-option${picked}"><span class="choice-letter">${letter}</span>. ${escapeHtml(o)}</div>`;
    }).join('');
    // 已出结果时：末尾再加结果行（"X帮你选了：字母·选项"），但选项+问题依然保留问卷形式显示
    let resultHtml = '';
    if (ch.result) {
      const resultIndex = ch.result.charCodeAt(0) - 65;
      const resultText = opts[resultIndex] || ch.result;
      const who = (m.from === 'other') ? escapeHtml(contactName) : '你';
      resultHtml = `<div class="msg-choice-result">${who}帮你选了：${escapeHtml(String(ch.result))} · ${escapeHtml(resultText)}</div>`;
    }
    contentHtml = `<div class="msg-bubble"><div class="msg-choice">
      ${questionHtml}${optsHtml}${resultHtml}
    </div></div>`;
  }
  const typingHtml = (m.type === '_typing') ? `<div class="msg-typing">${escapeHtml(contactName)}正在输入<span class="typing-dots"><span></span><span></span><span></span></span></div>` : '';
  if (typingHtml) return `<div class="msg-row other" data-type="_typing"><img class="msg-avatar" src="${escapeHtml(otherAvatar||DEFAULT_AVATAR)}" alt=""><div class="msg-wrap">${typingHtml}</div></div>`;
  // 时间戳和已读
  const timeHtml = `<div class="msg-time">${formatTime(m.time)}</div>`;
  const readHtml = isMe ? `<div class="msg-read">${m.read ? '已读' : '未读'}</div>` : '';
  const avImg = isMe
    ? `<img class="msg-avatar" src="${escapeHtml(myAvatar||DEFAULT_AVATAR)}" alt="">`
    : `<img class="msg-avatar" src="${escapeHtml(otherAvatar||DEFAULT_AVATAR)}" alt="">`;
  if (isMe) {
    // 我：气泡在左，头像在右
    return `<div class="${wrapClass}" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="${m.type}">
      <div class="msg-wrap">
        ${quoteHtml}
        ${contentHtml}
        ${timeHtml}
        ${readHtml}
      </div>
      ${avImg}
    </div>`;
  }
  // 对方：头像在左，气泡在右
  return `<div class="${wrapClass}" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="${m.type}">
    ${avImg}
    <div class="msg-wrap">
      ${quoteHtml}
      ${contentHtml}
      ${timeHtml}
      ${readHtml}
    </div>
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
  if (!confirm('确定删除这条消息吗？')) return;
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
export async function sendChoiceMessage(question, options, result) {
  await sendMessageCore({ type:'choice', choice:{ question, options, result }, content: '', replyTo: null });
}

// 取消联系人当前的回复定时器（取消合并窗口排程）
export function cancelRoundTimers(cid) {
  const keys = ['rm_'+cid, 'rt_'+cid, 'rr_'+cid];
  for (const k of keys) { if (state.chatTimers[k]) { clearTimeout(state.chatTimers[k]); delete state.chatTimers[k]; } }
  state.chatTypingState[cid] = false;
}
// 触发 N 条回复（1 ~ roundCount），每条间隔 1~3 秒
export async function emitRoundReplies(cid, baseMsg, count) {
  const cc = await getContact(cid); if (!cc) return;
  const repCount = Math.max(1, Math.min(20, count || 1));
  let totalSent = 0;
  for (let i = 0; i < repCount; i++) {
    await triggerReply(cc, baseMsg); // 每次抽一条字卡/表情
    if (i < repCount - 1) await new Promise(r => setTimeout(r, randInt(1000, 3000)));
    totalSent++;
  }
  await saveContact(cc);
  if (state.currentContactId === cid) renderChatMessages(cid, true);
  else { cc.unread = (cc.unread || 0) + totalSent; await saveContact(cc); }
  renderContacts();
  return totalSent;
}
// 发送消息核心：保存消息 + 已读独立触发 + 合并回复窗口排程
export async function sendMessageCore({ type, content, choice, replyTo }) {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  if (!c) return;

  if (type === 'choice' && choice && choice.result != null) {
    // 帮我选择：必回 + 延迟缩到 10秒~3分钟（独立流程不合并）
    return sendChoiceResponseFlow(c, choice);
  }

  // 快照：发送瞬间的状态 + 回复概率（0-100）
  const statusName = c.status;
  const rate = getReplyRateOf(c, statusName);

  // 回复延迟：严格取「最快回复(fastSec 秒) ~ 最慢回复(slowMin 分钟)」区间随机，与状态概率完全解耦
  const fastSec = Math.max(1, c.settings.fastSec || 5);
  const slowMin = Math.max(1, c.settings.slowMin || 3);
  const maxSec = Math.max(fastSec, slowMin * 60); // 统一转为秒

  const nowT = now();
  const delaySec = randInt(fastSec, maxSec);
  // 已读时间：落在回复延迟的 10%~50% 处（任何概率都会正常已读）
  const readAt = nowT + Math.floor(delaySec * 1000 * randInt(10, 50) / 100);
  const replyAt = nowT + delaySec * 1000;

  // 保存消息
  const msg = {
    id: uid(), from:'me', type, content: content || '', choice: choice || undefined,
    time: nowT, replyTo,
    snapshot: { status: statusName, rate },
    read: false, readAt, replyAt, replied: false
  };
  c.messages.push(msg);
  await saveContact(c);
  await renderChatMessages(cid, true);
  clearQuoteReply();

  // 已读定时器（每条独立，不再按 rate 门槛跳过）
  const readKey = `r_${cid}_${msg.id}`;
  state.chatTimers[readKey] = setTimeout(async () => {
    const cc = await getContact(cid);
    if (!cc) return;
    const m = cc.messages.find(x => x.id === msg.id);
    if (m && !m.read) {
      cascadeReadFromMe(cc, msg.id);
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, false);
    }
    delete state.chatTimers[readKey];
  }, Math.max(0, readAt - nowT));

  // ========== 合并窗口回复排程 ==========
  // 该联系人是否已有在等待中的回复轮次？
  let round = state.replyRounds[cid];
  const repCountSetting = c.settings.replyCount || 1;

  if (!round || round.triggered) {
    // 新的一轮
    const willReply = Math.random() * 100 < rate;
    const roundCount = willReply ? (repCountSetting <= 1 ? 1 : randInt(1, repCountSetting)) : 0;
    round = {
      rate,
      willReply, // 本轮是否回复（决定显示输入中/要不要写回复消息）
      roundCount, // 回复条数（1~replyCount）
      anchorMsgId: msg.id, // 用最后一条 anchor 做级联已读锚
      triggered: false
    };
    state.replyRounds[cid] = round;
  } else {
    // 已有一轮在等待 → 合并：锚更新为最新一条，回复时间按最新消息重新计时
    round.anchorMsgId = msg.id;
    // 重新计算回复条数（以发送瞬间rate的replyCount为准）
    if (round.willReply) {
      round.roundCount = repCountSetting <= 1 ? 1 : randInt(1, repCountSetting);
    }
  }

  // 取消旧定时器（每次新消息都重新排程一次）
  cancelRoundTimers(cid);

  // 「正在输入」只跟本轮是否回复绑定（不再受 rate 门槛限制）
  const showTyping = round.willReply;

  // 回复严格落在设置区间内；「正在输入」按同一延迟比例（60% 处）出现
  const replyStartAt = replyAt;
  const typingStartAt = showTyping ? (nowT + Math.floor(delaySec * 1000 * 0.6)) : 0;

  // 排程：输入中提示（若要显示）
  if (typingStartAt > nowT) {
    state.chatTimers['rt_'+cid] = setTimeout(() => {
      state.chatTypingState[cid] = true;
      if (state.currentContactId === cid) renderChatMessages(cid, false);
    }, Math.max(500, typingStartAt - nowT));
  }

  // 排程：最终回复/已读不回
  state.chatTimers['rr_'+cid] = setTimeout(async () => {
    const cc = await getContact(cid);
    const rd = state.replyRounds[cid];
    if (!cc || !rd || rd.triggered) { cancelRoundTimers(cid); delete state.replyRounds[cid]; return; }
    rd.triggered = true;
    state.chatTypingState[cid] = false;

    // 级联已读（锚=最新一条）
    cascadeReadFromMe(cc, rd.anchorMsgId);
    // 将所有之前积累的未 replied 我的消息全部标已处理
    for (const m of cc.messages) {
      if (m.from === 'me' && !m.replied && m.snapshot) m.replied = true;
    }

    let sentCount = 0;
    if (rd.willReply && rd.roundCount > 0) {
      // 生成 1~roundCount 条回复（间隔1~3秒），逐条写入db
      const cnt = Math.max(1, rd.roundCount);
      let anchor = cc.messages.find(x => x.id === rd.anchorMsgId) || cc.messages[cc.messages.length-1];
      for (let i = 0; i < cnt; i++) {
        await triggerReply(cc, anchor);
        if (i < cnt - 1) await new Promise(r => setTimeout(r, randInt(1000, 3000)));
      }
      sentCount = cnt;
    }
    await saveContact(cc);
    if (state.currentContactId === cid) renderChatMessages(cid, true);
    else if (sentCount > 0) { cc.unread = (cc.unread || 0) + sentCount; await saveContact(cc); }
    cancelRoundTimers(cid);
    delete state.replyRounds[cid];
    renderContacts();
  }, Math.max(800, replyStartAt - nowT));
}

// 帮我选择流程：先发提问消息 → 10s~3min 后对方回复选择
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
    // 选择一个选项（随机）
    const i = randInt(0, choice.options.length-1);
    const letter = String.fromCharCode(65+i);
    // 回复：choice 类型特殊消息
    const all = cc.cardGroups.flatMap(g => g.cards);
    let lead = '';
    if (all.length) lead = pick(all).content + ' ';
    const resultMsg = {
      id: uid(), from:'other', type:'choice',
      choice: { question: choice.question, options: choice.options, result: letter, leadText: lead },
      content: '',
      time: replyAt, replyTo: qMsg.id, snapshot: null,
      read: true, readAt: replyAt, replyAt: 0, replied: true
    };
    cc.messages.push(resultMsg);
    const qm = cc.messages.find(x => x.id === qMsg.id);
    if (qm) { qm.replied = true; qm.choice.result = letter; }
    await saveContact(cc);
    if (state.currentContactId === cid) renderChatMessages(cid, true);
    else { cc.unread = (cc.unread||0)+1; await saveContact(cc); }
    delete state.chatTimers[repKey];
    renderContacts();
  }, delay*1000);
}

// 触发回复：从字卡库抽，按回复条数，50%引用历史，50%概率用表情包
export async function triggerReply(c, triggerMsg) {
  const cid = c.id;
  const cards = c.cardGroups.flatMap(g => g.cards.map(c2 => ({content: c2.content, type:'text'})));
  const hasCards = cards.length > 0;
  const hasStickers = (c.stickers || []).length > 0;
  let count = Math.max(1, c.settings.replyCount || 1);
  for (let i = 0; i < count; i++) {
    let gap = i === 0 ? 0 : randInt(1, 3);
    // 钳平到当前时刻，防止补算时给出未来时间戳导致乱序
    const atTime = Math.min((triggerMsg.replyAt || now()) + gap * 1000, now());
    // 50%引用历史消息
    let replyTo = null;
    const history = (c.messages || []).filter(x => x.type === 'text' || x.type === 'image' || x.type === 'sticker' || x.type === 'choice');
    if (history.length > 0 && Math.random() < 0.5) replyTo = pick(history).id;
    // 生成内容
    let type = 'text', content = '';
    const useSticker = hasStickers && Math.random() < 0.5;
    if (useSticker) {
      type = 'sticker';
      content = pick(c.stickers).data;
    } else {
      if (!hasCards) {
        // 无字卡，不回复（该条跳过）
        continue;
      }
      type = 'text';
      content = pick(cards).content;
      content = await applyNickname(content, c);
    }
    const reply = {
      id: uid(), from:'other', type, content,
      time: atTime, replyTo, snapshot: null,
      read: true, readAt: atTime, replyAt: 0, replied: true
    };
    c.messages.push(reply);
  }
}

// ============ 折叠菜单 ============
export function toggleChatMenu(e) {
  if (e) e.stopPropagation();
  const m = $('chat-menu');
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
        <div class="choice-opt"><input class="input" type="text" placeholder="A"><button onclick="this.parentNode.remove()">✕</button></div>
        <div class="choice-opt"><input class="input" type="text" placeholder="B"><button onclick="this.parentNode.remove()">✕</button></div>
      </div>
      <button class="btn-outline btn" style="width:100%;margin-top:8px;" onclick="addChoiceOpt()">＋ 添加选项</button>
    </div>
  `;
  showModal('帮我选择', html, [
    { label:'取消', cls:'btn-outline', onClick: closeModal },
    { label:'发送请对方选择', cls:'btn', onClick: async () => {
      const q = $('cw-q').value.trim();
      const opts = Array.from(document.querySelectorAll('#cw-opts input')).map(x=>x.value.trim()).filter(Boolean);
      if (!q) return toast('请输入问题');
      if (opts.length < 2) return toast('至少2个选项');
      closeModal();
      await sendChoiceMessage(q, opts, null);
    }}
  ]);
}
export function addChoiceOpt() {
  const div = document.createElement('div');
  div.className = 'choice-opt';
  div.innerHTML = `<input class="input" type="text"><button onclick="this.parentNode.remove()">✕</button>`;
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
      if (r.todayIsOrigin) { cls += ' anni-today'; txt = '🎉 就是今天'; }
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
  const name = prompt('纪念日名称：', '纪念日');
  if (!name) return;
  const date = prompt('日期（YYYY-MM-DD）：', new Date().toISOString().slice(0,10));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式错误');
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
  const name = prompt('纪念日名称：', a.name);
  if (name == null) return;
  const date = prompt('日期（YYYY-MM-DD）：', a.date);
  if (date == null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式错误');
  a.name = name; a.date = date;
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
export async function delAnni(id) {
  if (!confirm('确定删除这个纪念日吗？')) return;
  const cid = state.currentContactId;
  const c = await getContact(cid);
  c.anniversaries = (c.anniversaries || []).filter(x => x.id !== id);
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
