// 依赖：03-data.js
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, anniversaryView, closeModal, compressImage, confirmDialog, defaultAnniMode, escapeHtml, formatTime, inputDialog, now, pick, randInt, showModal, toast } from './02-core.js';
import { applyNickname, clearContactUnread, getContact, getContactCardPool, getCurrentReplyRate, getMe, getReplyRateOf, getStatusCategories, getStatusPool, renderContacts, saveContact } from './03-data.js';
import { recordCardUsage } from './17-card-usage.js';
import { getMyAvatarFor } from './18-my-avatar.js';
import { openPokePanel } from './19-poke.js';

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
  const [c, me, myAv] = await Promise.all([getContact(contactId), getMe(), getMyAvatarFor(contactId)]);
  if (!c) return;
  const box = $('chat-messages');
  const msgs = c.messages || [];
  const lmState = state.loadMoreState[contactId] || { pageSize: 50 };
  const showCount = Math.min(msgs.length, lmState.pageSize);
  const slice = msgs.slice(msgs.length - showCount);
  const contactName = c.name;
  const myAvatar = myAv || (me && me.avatar) || DEFAULT_AVATAR;
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
  // 用「单事务只改 unread」的原子写，避免整对象回写覆盖渲染期间刚到达的新消息/回复。
  const pageChat = $('page-chat');
  if (contactId === state.currentContactId && pageChat && pageChat.classList.contains('active')) {
    if (await clearContactUnread(contactId)) renderContacts();
  }
  // 绑定长按
  bindLongpress(box);
}
// A26：增量渲染（补出消息时只插入新增节点，避免整列表重建导致画面跳动）
export async function renderChatIncremental(contactId, opts = {}) {
  const allowSeq = opts.animate !== false;
  const box = $('chat-messages');
  if (!box) return;
  const [c, me, myAv] = await Promise.all([getContact(contactId), getMe(), getMyAvatarFor(contactId)]);
  if (!c) return;
  const msgs = c.messages || [];
  const lmState = state.loadMoreState[contactId] || { pageSize: 50 };
  const showCount = Math.min(msgs.length, lmState.pageSize);
  const slice = msgs.slice(msgs.length - showCount);
  const contactName = c.name;
  const myAvatar = myAv || (me && me.avatar) || DEFAULT_AVATAR;
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
  const hadNodes = map.size > 0;
  const keep = new Set(slice.map(m => m.id));
  // 删除已不存在的消息节点
  for (const [id, el] of map) if (!keep.has(id)) { el.remove(); map.delete(id); }
  // 更新已读文案 + 缺失节点按真实时间位置插入
  const typingRow = box.querySelector('[data-type="_typing"]');
  let inserted = 0;
  const newNodes = [];
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const old = map.get(m.id);
    if (old) {
      // 撤回/问答状态变化需要更新已有节点（增量渲染默认不动已有节点）
      const qaRevealed = m.type === 'qa' ? ((m.qa && m.qa.mineIndex != null && m.qa.otherIndex != null) ? '1' : '0') : '';
      const qaMine = m.type === 'qa' ? String((m.qa && m.qa.mineIndex != null) ? m.qa.mineIndex : '') : '';
      const needReplace = (m.recalled && old.dataset.type !== 'recall')
        || (m.type === 'qa' && (old.dataset.type !== 'qa' || old.dataset.revealed !== qaRevealed || old.dataset.qaMine !== qaMine));
      if (needReplace) {
        const rt = document.createElement('div');
        rt.innerHTML = renderMsg(m, contactId, contactName, msgs, myAvatar, otherAvatar, null).trim();
        const rn = rt.firstElementChild;
        if (rn) { box.replaceChild(rn, old); map.set(m.id, rn); }
        continue;
      }
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
    newNodes.push({ node, m });
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

  // 多条回复逐条呈现：仅本次新增的对方消息，按 400–700ms 依次淡入上移
  if (allowSeq && hadNodes && inserted) {
    const seq = newNodes.filter(x => x.m.from === 'other' && x.m.type !== 'redpacket' && x.m.type !== 'transfer' && x.m.type !== 'poke' && !x.m.recalled);
    if (seq.length > 1) {
      for (const x of seq) x.node.classList.add('msg-seq-wait');
      let delay = 0;
      for (const x of seq) {
        setTimeout(() => {
          if (!x.node.isConnected) return;
          x.node.classList.remove('msg-seq-wait');
          x.node.classList.add('msg-seq-in');
          setTimeout(() => { if (x.node.isConnected) x.node.classList.remove('msg-seq-in'); }, 380);
          const b = $('chat-messages');
          if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 80) b.scrollTop = b.scrollHeight;
        }, delay);
        delay += randInt(400, 700);
      }
    }
  }

  // 同步「加载更早」按钮：条数变化后更新文案，缺失时补上（避免增量渲染后剩余条数不准/无法展开更早消息）
  const moreCount = msgs.length - showCount;
  let moreBtn = box.querySelector('.load-more');
  if (moreCount > 0) {
    if (!moreBtn) {
      moreBtn = document.createElement('div');
      moreBtn.className = 'load-more';
      moreBtn.onclick = async () => {
        lmState.pageSize += 50;
        state.loadMoreState[contactId] = lmState;
        await renderChatMessages(contactId, false);
        const b = $('chat-messages');
        if (b) b.scrollTop = moreBtn.offsetTop || 100;
      };
      box.insertBefore(moreBtn, box.firstChild);
    }
    const moreTxt = `↑ 加载更早消息（还有${moreCount}条）`;
    if (moreBtn.textContent !== moreTxt) moreBtn.textContent = moreTxt;
  } else if (moreBtn) {
    moreBtn.remove();
  }

  if (atBottom) box.scrollTop = box.scrollHeight;
  else if (anchor && inserted) {
    const el = box.querySelector(`[data-msgid="${anchor.id}"]`);
    if (el) box.scrollTop += el.getBoundingClientRect().top - anchor.top;
  }
  // 同步未读计数（聊天页当前会话）：同样只做原子的 unread 清零，不整对象回写
  const pageChat = $('page-chat');
  if (contactId === state.currentContactId && pageChat && pageChat.classList.contains('active')) {
    if (await clearContactUnread(contactId)) renderContacts();
  }
}
export function renderMsg(m, contactId, contactName, allMsgs, myAvatar, otherAvatar, animId) {
  const isMe = m.from === 'me';
  // 拍一拍系统提示行：居中细字，不是聊天气泡
  if (m.type === 'poke') {
    return `<div class="msg-row msg-center" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="poke"><div class="msg-poke-line">${escapeHtml(m.content || '')}</div></div>`;
  }
  // 撤回提示行：居中细字，原气泡位置保留
  if (m.recalled) {
    const txt = m.from === 'me' ? '你撤回了一条消息' : `${contactName || '对方'} 撤回了一条消息`;
    return `<div class="msg-row msg-center" data-msgid="${escapeHtml(m.id)}" data-from="${m.from}" data-type="recall"><div class="msg-recall-line">${escapeHtml(txt)}</div></div>`;
  }
  // 问答卡：我的气泡；双方都选完才同时揭示对方选择
  if (m.type === 'qa' && m.qa) {
    const q = m.qa;
    const revealed = q.mineIndex != null && q.otherIndex != null;
    const selectable = !revealed;
    const rows = (q.options || []).map((o, i) => {
      const isMine = q.mineIndex != null && i === q.mineIndex;
      const isOther = revealed && i === q.otherIndex;
      return `<div class="qa-opt${selectable ? ' selectable' : ''}${isMine ? ' picked mine' : ''}${isOther ? ' picked other' : ''}"${selectable ? ` onclick="qaPickMine('${contactId}','${m.qaId}',${i})"` : ''}>
        <span class="qa-opt-text">${escapeHtml(o)}</span>
        ${isMine ? '<span class="qa-tag">我</span>' : ''}
        ${isOther ? '<span class="qa-tag">对方</span>' : ''}
      </div>`;
    }).join('');
    const foot = revealed ? '双方已选择' : (q.mineIndex == null ? '点击选项选择你的答案，双方都选完后同时揭晓' : (q.status === 'sleep' ? '对方正在睡觉，暂时不会回答' : '等待对方选择…'));
    return `<div class="msg-row me" data-msgid="${escapeHtml(m.id)}" data-from="me" data-type="qa" data-revealed="${revealed ? 1 : 0}" data-qa-mine="${q.mineIndex == null ? '' : q.mineIndex}"><img class="msg-avatar" src="${escapeHtml(myAvatar)}" alt=""><div class="msg-wrap"><div class="msg-bubble qa-bubble"><div class="qa-q">${escapeHtml(q.question || '')}</div><div class="qa-opts">${rows}</div><div class="qa-foot">${foot}</div></div><div class="msg-read">${m.read ? '已读' : '未读'}</div></div></div>`;
  }
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
    // 我主动呼出的通话结束提示：方向明确为「我 呼叫」，不套用「来电」
    if (m.callDir === 'out') {
      isSys = true; sysText = stripped;
      sysVideo = /视频/.test(raw);
      sysIcon = sysVideo ? 'icon-video' : 'icon-phone';
      sysName = '我';
      sysAction = sysVideo ? '视频呼叫' : '呼叫';
      const mOut = stripped.match(/已通话\s*(\d{1,2}:\d{2})/);
      if (mOut) { sysSub = sysVideo ? '视频通话·已结束' : '通话已挂断'; sysDuration = mOut[1]; }
      else if (/未接听/.test(stripped)) { sysSub = '未接听'; sysDuration = ''; }
      else if (/已取消/.test(stripped)) { sysSub = '已取消'; sysDuration = ''; }
      else { sysSub = '已结束'; sysDuration = ''; }
    }
    // 来信系统提示："✉️ Ta 寄来了一封信，快去信箱看看吧。"
    else if (/寄来了一封信/.test(stripped)) {
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
      if (m2) { const nm = String(m2[1] || '').replace(/[（()）\s]/g, ''); sysName = nm || (contactName || '对方'); sysAction = sysVideo ? '视频来电' : '来电'; sysSub = '未接听'; sysDuration = ''; }
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
  else if (m.type === 'redpacket') {
    // 红包卡片：金额未点开前遮盖，点开后显示
    const rp = m.redPacket || {};
    const isOut = m.from === 'me';
    const done = rp.status === 'opened' || rp.status === 'expired' || rp.status === 'returned';
    const fmt = n => { const s = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); };
    const statusText = rp.status === 'opened' ? '已领取'
      : rp.status === 'expired' ? '已过期'
      : rp.status === 'returned' ? '已退回'
      : (isOut ? '等待对方领取' : '点开领取');
    contentHtml = `<div class="msg-bubble msg-rp-bubble"><div class="msg-rp-card${done ? ' done' : ''}" data-rpid="${escapeHtml(m.id)}" onclick="openRedPacket('${contactId}','${m.id}')">
      <div class="msg-rp-ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 8.5l9 6 9-6"/><circle cx="12" cy="12.5" r="1.6"/></svg></div>
      <div class="msg-rp-body">
        <div class="msg-rp-title">红包</div>
        <div class="msg-rp-amount">${done ? '¥' + fmt(rp.amount) : '¥ ••.••'}</div>
        <div class="msg-rp-status">${statusText}</div>
      </div>
    </div></div>`;
  }
  else if (m.type === 'transfer') {
    // 联系人往共用卡转账：沿用红包卡片的视觉语言，不点击、不显示操作
    const tr = m.transfer || {};
    const isMe = m.from === 'me';
    const fmt = n => { const s = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); };
    contentHtml = `<div class="msg-bubble msg-rp-bubble"><div class="msg-rp-card msg-trans-card">
      <div class="msg-rp-ic"><svg class="i"><use href="#icon-wallet"/></svg></div>
      <div class="msg-rp-body">
        <div class="msg-rp-title">${isMe ? '你' : escapeHtml(contactName)} 往共用卡转了</div>
        <div class="msg-rp-amount">¥${fmt(tr.amount)}</div>
        <div class="msg-rp-status">已存入共用卡</div>
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
// 容器级事件委托：消息列表整体重建或增量插入新行都无需重新绑定；
// 触摸滚动只在位移超过 12px 时取消，避免手指轻微抖动导致长按失效。
const LP_HOLD_MS = 500;
const LP_MOVE_TOL = 12;
let _lpSuppressUntil = 0;
let _lpSuppressRowId = null;
export function bindLongpress(container) {
  if (!container || container._lpBound) return;
  container._lpBound = true;
  let timer = null, row = null, startX = 0, startY = 0;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const point = (e) => (e.touches && e.touches[0]) ? e.touches[0] : e;
  const start = (e) => {
    if (e.button != null && e.button !== 0) return;
    const tgt = e.target.closest ? e.target.closest('.msg-row') : null;
    if (!tgt || !container.contains(tgt)) return;
    clear();
    // 新手势开始：上一轮长按的吞点击窗口失效
    _lpSuppressUntil = 0;
    _lpSuppressRowId = null;
    row = tgt;
    const pt = point(e);
    startX = pt ? pt.clientX : 0;
    startY = pt ? pt.clientY : 0;
    timer = setTimeout(() => {
      timer = null;
      if (!row) return;
      _lpSuppressUntil = now() + 800;
      _lpSuppressRowId = row.dataset.msgid;
      showLongpressMenu(row, startX, startY);
    }, LP_HOLD_MS);
  };
  const move = (e) => {
    if (!row) return;
    const pt = point(e);
    if (!pt || pt.clientX == null) return;
    if (Math.abs(pt.clientX - startX) > LP_MOVE_TOL || Math.abs(pt.clientY - startY) > LP_MOVE_TOL) {
      clear();
      row = null;
    }
  };
  const end = () => { clear(); row = null; };
  // 长按后紧跟的这一次 click 是松手产生的：仅吞掉同一条消息上的那一次，
  // 不影响其它行的点击（图片查看/跳转等），也不会把刚弹出的菜单关掉。
  const swallowClick = (e) => {
    const tgt = e.target.closest ? e.target.closest('.msg-row') : null;
    if (_lpSuppressRowId && tgt && tgt.dataset.msgid === _lpSuppressRowId && now() < _lpSuppressUntil) {
      _lpSuppressUntil = 0;
      _lpSuppressRowId = null;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const menu = $('lp-menu');
    if (menu && !menu.classList.contains('hide') && !menu.contains(e.target)) menu.classList.add('hide');
  };
  container.addEventListener('mousedown', start);
  container.addEventListener('pointerdown', start);
  container.addEventListener('touchstart', start, {passive:true});
  container.addEventListener('mousemove', move);
  container.addEventListener('pointermove', move);
  container.addEventListener('touchmove', move, {passive:true});
  container.addEventListener('mouseup', end);
  container.addEventListener('pointerup', end);
  container.addEventListener('touchend', end);
  container.addEventListener('touchcancel', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('mouseleave', end);
  container.addEventListener('click', swallowClick, true);
  // 双击对方头像：打开「我拍别人」文案选择面板
  container.addEventListener('dblclick', (e) => {
    const av = e.target.closest ? e.target.closest('.msg-row.other .msg-avatar') : null;
    if (!av) return;
    e.preventDefault();
    openPokePanel();
  });
  container.addEventListener('contextmenu', (e) => {
    const tgt = e.target.closest ? e.target.closest('.msg-row') : null;
    if (!tgt) return;
    e.preventDefault();
    _lpSuppressUntil = now() + 800;
    _lpSuppressRowId = tgt.dataset.msgid;
    showLongpressMenu(tgt, e.clientX, e.clientY);
  });
  // 菜单外按下即关闭（不用 click，避免松手那一下把刚弹出的菜单关掉）
  document.addEventListener('pointerdown', (e) => {
    const menu = $('lp-menu');
    if (menu && !menu.classList.contains('hide') && !menu.contains(e.target)) menu.classList.add('hide');
  }, true);
}
function canRecallRow(row) {
  if (!row || row.dataset.from !== 'me') return false;
  if (row.dataset.type === 'poke' || row.dataset.type === 'recall' || row.dataset.type === 'qa') return false;
  const mine = Array.from(document.querySelectorAll('#chat-messages .msg-row[data-from="me"]'))
    .filter(el => el.dataset.type !== 'poke' && el.dataset.type !== 'recall');
  return mine.slice(-5).indexOf(row) !== -1;
}
export function showLongpressMenu(row, x, y) {
  if (!row) return;
  const id = row.dataset.msgid;
  const menu = $('lp-menu');
  if (!menu) return;
  if (row.dataset.type === 'poke' || row.dataset.type === 'recall') return;
  menu.innerHTML = `<div onclick="quoteReply('${id}')" style="display:flex;align-items:center;gap:8px;"><svg class="i i-sm" style="transform:scaleX(-1);"><use href="#icon-back"/></svg> 引用回复</div><div onclick="deleteMsg('${id}')" style="color:var(--danger);display:flex;align-items:center;gap:8px;"><svg class="i i-sm"><use href="#icon-trash"/></svg> 删除</div>`;
  if (canRecallRow(row)) {
    const d = document.createElement('div');
    d.setAttribute('onclick', "recallMsg('" + id + "')");
    d.style.cssText = 'display:flex;align-items:center;gap:8px;';
    d.innerHTML = '<svg class="i i-sm" style="transform:scaleX(-1);"><use href="#icon-back"/></svg> 撤回';
    menu.insertBefore(d, menu.firstChild);
  }
  menu.classList.remove('hide');
  // 定位
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 150) + 'px';
  menu.style.top = Math.min(y, vh - 170) + 'px';
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
  const cid = state.currentContactId;
  if (!await confirmDialog('确定删除这条消息吗？')) return;
  const task = async () => {
    const c = await getContact(cid);
    if (!c) return;
    c.messages = (c.messages || []).filter(m => m.id !== msgId);
    await saveContact(c);
    await renderChatMessages(cid, true);
  };
  // 与补算串行：删除同样是「读-改-写」整对象，入队避免与 runCatchUp 互相覆盖
  if (typeof window.__enqueueTask === 'function') await window.__enqueueTask(task); else await task();
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

/* ============ 表情包回收：对方已读我发的表情包后，按概率收进他自己的表情包库 ============
   规则：
   - 只在消息 read=true（对方已读）之后才掷概率；未读永远不判定
   - 命中后延迟几分钟（2~6 分钟，基于已读时刻）才到账，不立刻收
   - 同一张图已在其库中则跳过，不重复添加；库不设上限
   - 收进去的是复制品（同 data 的新对象），我之后删原图不影响
   - 全程不写任何聊天消息，只改联系人自己的 stickers
   判定结果写在消息上（recycleRolled/recycleHit/recycleDueAt/recycleDone），刷新后可续。 */
const STICKER_RECYCLE_DEFAULT = 30;
const STICKER_RECYCLE_DELAY_MIN = 2; // 分钟
const STICKER_RECYCLE_DELAY_MAX = 6;

export function stickerRecycleRate(c) {
  const raw = c && c.settings ? c.settings.stickerRecycleRate : undefined;
  if (raw === undefined || raw === null || raw === '') return STICKER_RECYCLE_DEFAULT;
  let v = Number(raw);
  if (!Number.isFinite(v)) return STICKER_RECYCLE_DEFAULT;
  v = Math.round(v);
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  return v;
}

export function processStickerRecycle(c, t) {
  if (!c) return false;
  const at = Number.isFinite(Number(t)) ? Number(t) : now();
  let changed = false;
  for (const m of (c.messages || [])) {
    if (m.from !== 'me' || m.type !== 'sticker' || !m.content || m.recalled || m.recycleDone) continue;
    if (!m.read) continue; // 对方没读之前不判定
    if (!m.recycleRolled) {
      m.recycleRolled = true;
      m.recycleHit = Math.random() * 100 < stickerRecycleRate(c);
      changed = true;
      if (!m.recycleHit) { m.recycleDone = true; continue; }
      const base = Number(m.readAt) || at;
      m.recycleDueAt = base + randInt(STICKER_RECYCLE_DELAY_MIN, STICKER_RECYCLE_DELAY_MAX) * 60000;
    }
    if (m.recycleHit && m.recycleDueAt && at >= m.recycleDueAt) {
      const lib = c.stickers || (c.stickers = []);
      if (!lib.some(s => s && s.data === m.content)) {
        lib.push({ id: uid(), name: '', data: m.content });
      }
      m.recycleDone = true;
      changed = true;
    } else if (m.recycleHit && m.recycleDueAt) {
      armStickerRecycleTimer(c.id, m.id, m.recycleDueAt);
    }
  }
  return changed;
}

// 到点自动入账（定时器丢失时由补算/周期检查兜底）
function armStickerRecycleTimer(cid, msgId, dueAt) {
  const key = 'rk_' + cid + '_' + msgId;
  if (state.chatTimers[key]) return;
  const remain = Math.max(0, Number(dueAt) - now());
  state.chatTimers[key] = setTimeout(() => {
    delete state.chatTimers[key];
    const task = async () => {
      const cc = await getContact(cid);
      if (!cc) return;
      if (!processStickerRecycle(cc, now())) return;
      await saveContact(cc);
      if (document.getElementById('page-sticker-lib')?.classList.contains('active')) {
        if (typeof window.renderStkLibGrid === 'function') {
          window.renderStkLibGrid(state.currentStkLibTab, state.currentContactSettingId);
        }
      }
    };
    if (typeof window.__enqueueTask === 'function') window.__enqueueTask(task); else task();
  }, remain);
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
// 引用候选：本条会话内最近 20 条消息（双方、系统提示、邀请卡都算），不足 20 条用全部
// 拍一拍、撤回提示这类系统行不进入引用池
export function pickQuoteId(c) {
  const msgs = (c && c.messages) || [];
  const cand = msgs.filter(m => m.type !== 'poke' && m.type !== 'recall' && !m.recalled);
  if (!cand.length) return null;
  return pick(cand.slice(-20)).id;
}
// 生成一批回复（条数由调用方决定，不超上限；时间戳=命中时刻，按 1~3 秒递增且不晚于当前）
export async function appendReplyMessages(c, anchor, count, atTime) {
  const cards = getContactCardPool(c);
  const stickers = c.stickers || [];
  const total = Math.max(0, count || 0);
  const base = Math.min(Number(atTime) || now(), now());
  let sent = 0;
  const notifyItems = [];
  for (let i = 0; i < total; i++) {
    if (!cards.length && !stickers.length) break;
    const useSticker = stickers.length > 0 && Math.random() < 0.5;
    let type = 'text', content = '';
    if (useSticker) { type = 'sticker'; content = pick(stickers).data; }
    else if (cards.length) {
      const picked = pick(cards);
      type = 'text';
      content = await applyNickname(picked.content, c);
      // 只统计字卡抽出的回复；写库失败不影响消息生成
      recordCardUsage(c.id, picked.id, picked.content).catch(() => {});
    }
    else continue;
    let replyTo = null;
    if ((c.messages || []).length && Math.random() < 0.5) replyTo = pickQuoteId(c);
    const time = Math.min(now(), base + i * randInt(1000, 3000));
    c.messages.push({
      id: uid(), from: 'other', type, content,
      time, replyTo, snapshot: null,
      read: true, readAt: time, replyAt: 0, replied: true, replyDone: true
    });
    notifyItems.push({ kind: type === 'sticker' ? 'sticker' : 'text', text: type === 'text' ? content : '' });
    sent++;
  }
  if (sent && typeof window.__notifyIncoming === 'function') {
    try { window.__notifyIncoming(c.id, c.name, notifyItems); } catch (e) {}
  }
  return sent;
}
// 触发 N 条回复（兼容旧入口）
export async function emitRoundReplies(cid, baseMsg, count) {
  const task = async () => {
    const cc = await getContact(cid); if (!cc) return 0;
    const sent = await appendReplyMessages(cc, baseMsg, count, now());
    await saveContact(cc);
    if (state.currentContactId === cid) renderChatIncremental(cid);
    else if (sent) { cc.unread = (cc.unread || 0) + sent; await saveContact(cc); }
    renderContacts();
    return sent;
  };
  // 与补算串行，避免同一联系人的整对象写互相覆盖
  if (typeof window.__enqueueTask === 'function') return window.__enqueueTask(task);
  return task();
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
      // 已读后：我发出的表情包按概率被他收进自己的库（延迟几分钟到账，无聊天提示）
      if (processStickerRecycle(cc, now())) await saveContact(cc);
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
// 与补算串行：发送是「读-改-写」整对象，必须在同一条队列里执行，否则会被 runCatchUp 的旧快照回写覆盖
export async function sendMessageCore(payload) {
  if (typeof window.__enqueueTask === 'function') return window.__enqueueTask(() => sendMessageCoreInner(payload));
  return sendMessageCoreInner(payload);
}
async function sendMessageCoreInner({ type, content, choice, replyTo }) {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  if (!c) return;

  if (type === 'choice' && choice && choice.result == null) {
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

// 选择结果结算（幂等）：同一提问只补出一条结果，时间戳恒为「应回时刻」
// 实时定时器与离线补算共用；已结算过（标记或已有结果消息）直接跳过。
export function resolveChoiceQuestion(c, qMsg, atTime) {
  if (!c || !qMsg || qMsg.type !== 'choice' || !qMsg.choice) return 0;
  if (qMsg.choiceResolved || qMsg.choice.result != null) return 0;
  if ((c.messages || []).some(m => m.from === 'other' && m.replyTo === qMsg.id)) return 0;
  const choice = qMsg.choice;
  const options = choice.options || [];
  if (!options.length) return 0;
  const at = Math.min(Number(atTime) || now(), now());
  // 选择结果：允许对方多选时随机勾 2~N 项，否则单选一项
  let letters;
  if (choice.allowMulti && options.length >= 2) {
    const arr = options.map((_, i) => i);
    for (let k = arr.length - 1; k > 0; k--) { const j = randInt(0, k); const t = arr[k]; arr[k] = arr[j]; arr[j] = t; }
    const n = randInt(2, options.length);
    letters = arr.slice(0, n).sort((a, b) => a - b).map(i => String.fromCharCode(65 + i)).join('、');
  } else {
    letters = String.fromCharCode(65 + randInt(0, options.length - 1));
  }
  const all = getContactCardPool(c);
  let lead = '';
  if (all.length) lead = pick(all).content + ' ';
  c.messages.push({
    id: uid(), from: 'other', type: 'choice',
    choice: { question: choice.question, options, result: letters, allowMulti: !!choice.allowMulti, leadText: lead },
    content: '',
    time: at, replyTo: qMsg.id, snapshot: null,
    read: true, readAt: at, replyAt: 0, replied: true
  });
  qMsg.replied = true;
  qMsg.choiceResolved = true;
  if (typeof window.__notifyIncoming === 'function') {
    try { window.__notifyIncoming(c.id, c.name, [{ kind: 'choice', text: '选择了 ' + letters }]); } catch (e) {}
  }
  return 1;
}
// 选择结果实时定时器（幂等挂载）：文档冻结/切后台可能丢弃定时器，
// 补算入口在扫描时用同一函数把未到点的提问重新挂上，避免回来早于应回时刻就永远不结算。
export function armChoiceResultTimer(c, qMsg, replyAt) {
  if (!c || !qMsg) return false;
  const cid = c.id;
  const key = `choice_${cid}_${qMsg.id}`;
  if (state.chatTimers[key]) return false;
  const at = Number(replyAt != null ? replyAt : qMsg.choiceReplyAt) || 0;
  if (!at) return false;
  const remain = at - now();
  if (remain <= 0) return false;
  state.chatTimers[key] = setTimeout(() => {
    delete state.chatTimers[key];
    const task = async () => {
      const cc = await getContact(cid);
      if (!cc) return;
      const q = cc.messages.find(x => x.id === qMsg.id);
      if (!q) return;
      const sent = resolveChoiceQuestion(cc, q, q.choiceReplyAt || at);
      if (!sent) return;
      if (state.currentContactId !== cid) cc.unread = (cc.unread || 0) + sent;
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatIncremental(cid);
      renderContacts();
    };
    // 与补算串行，避免定时器与补算同时补出两条结果
    if (typeof window.__enqueueTask === 'function') window.__enqueueTask(task); else task();
  }, remain);
  return true;
}
// 补算入口：离线/切后台期间到点的选择提问统一结算
export async function processChoiceQuestions(c, t) {
  let changed = false;
  for (const m of (c.messages || [])) {
    if (m.from !== 'me' || m.type !== 'choice' || !m.choice) continue;
    if (m.choiceResolved || m.choice.result != null) continue;
    const at = Number(m.choiceReplyAt) || 0;
    if (!at) continue;
    if (t < at) { armChoiceResultTimer(c, m, at); continue; }
    if (resolveChoiceQuestion(c, m, at)) changed = true;
  }
  return changed;
}

// 选择流程：先发提问消息 → 10s~3min 后对方回复选择
export async function sendChoiceResponseFlow(c, choice) {
  const cid = c.id;
  const nowT = now();
  // 延迟：10秒~3分钟；应回时刻落库，切后台/关页后由补算补出
  const delay = randInt(10, 180);
  const replyAt = nowT + delay * 1000;
  // 我的消息
  const qMsg = {
    id: uid(), from:'me', type:'choice', choice, content:'', time: nowT, replyTo:null,
    snapshot: { status: c.status, rate: getCurrentReplyRate(c), willReply: true },
    read: false, readAt: nowT + 2000, replyAt: 0, replied: false,
    choiceReplyAt: replyAt, choiceResolved: false
  };
  c.messages.push(qMsg);
  await saveContact(c);
  state._animMsgId = qMsg.id;
  if (state.currentContactId === cid) renderChatMessages(cid, true);
  // 已读（实时）；定时器丢失时由补算 2a 按 readAt 兜底
  const readKey = `choiceRead_${cid}_${qMsg.id}`;
  state.chatTimers[readKey] = setTimeout(() => {
    delete state.chatTimers[readKey];
    const task = async () => {
      const cc = await getContact(cid);
      if (!cc) return;
      const m = cc.messages.find(x => x.id === qMsg.id);
      if (m && !m.read) {
        m.read = true;
        await saveContact(cc);
        if (state.currentContactId === cid) renderChatIncremental(cid);
      }
    };
    // 与补算串行，避免整对象回写覆盖并发写入
    if (typeof window.__enqueueTask === 'function') window.__enqueueTask(task); else task();
  }, 2000);
  // 结果（实时）；与补算共用同一幂等结算，时间戳=choiceReplyAt
  armChoiceResultTimer(c, qMsg, replyAt);
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
  // 置顶仅影响展示顺序：置顶组在上，组内保持原有顺序；取消置顶回到原位
  const order = new Map(items.map((x, i) => [x.id, i]));
  const sorted = items.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || order.get(a.id) - order.get(b.id));
  const rows = sorted.map(a => {
    const v = anniversaryView(a);
    return `<div class="anni-item">
      <div class="anni-info">
        <div class="anni-name">${escapeHtml(a.name)}</div>
        <div class="anni-date">${escapeHtml(a.date)}</div>
      </div>
      <div class="${v.cls}">${v.text}</div>
      <div style="display:flex;gap:4px;margin-left:8px;">
        <button class="anni-pin${a.pinned ? ' on' : ''}" title="${a.pinned ? '取消置顶' : '置顶'}" onclick="toggleAnniPin('${a.id}')"><svg class="i i-sm"><use href="#icon-star"/></svg></button>
        <button style="background:#dbeafe;color:#1e40af;width:32px;height:32px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;" onclick="editAnni('${a.id}')"><svg class="i i-sm" style="stroke:#1e40af;"><use href="#icon-pencil"/></svg></button>
        <button style="background:#fee2e2;color:#991b1b;width:32px;height:32px;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;" onclick="delAnni('${a.id}')"><svg class="i i-sm" style="stroke:#991b1b;"><use href="#icon-trash"/></svg></button>
      </div>
    </div>`;
  }).join('');
  // 联系人条目展示：单选，未指定则不显示；可选范围是该联系人的全部纪念日
  const feature = items.length ? `<div class="anni-feature">
      <div class="anni-feature-label">联系人条目展示</div>
      <select class="input anni-feature-select" onchange="setContactAnni(this.value)">
        <option value=""${!c.contactAnniId ? ' selected' : ''}>不显示</option>
        ${items.map(a => `<option value="${a.id}"${c.contactAnniId === a.id ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
    </div>` : '';
  const body = `<div id="anni-list-wrap">
    ${feature}
    ${items.length ? rows : '<div class="empty" style="padding:30px 10px;">还没有纪念日</div>'}
    <button class="btn" style="width:100%;margin-top:14px;" onclick="addAnni()">＋ 添加纪念日</button>
  </div>`;
  showModal(`${c.name}的纪念日`, body, [{label:'关闭', cls:'btn-outline', onClick:closeModal}]);
}
const ANNI_MODE_OPTIONS = [
  { value: 'countdown', label: '倒数（还有 N 天）' },
  { value: 'countup', label: '正数（已经 N 天）' }
];
export async function addAnni() {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  const p = inputDialog('添加纪念日', [
    { key: 'name', label: '纪念日名称', value: '纪念日', required: true },
    { key: 'date', label: '日期', type: 'date', value: new Date().toISOString().slice(0,10), required: true },
    { key: 'mode', label: '计算方式', type: 'select', value: 'countup', options: ANNI_MODE_OPTIONS }
  ], '保存');
  // 默认值按名称走：未手动改过下拉时，名称含「生日」自动切倒数，其余正数
  try {
    const box = $('input-dialog-fields');
    const nameInp = box && box.querySelector('input[data-ik="name"]');
    const modeSel = box && box.querySelector('select[data-ik="mode"]');
    if (nameInp && modeSel) {
      let touched = false;
      modeSel.addEventListener('change', () => { touched = true; });
      nameInp.addEventListener('input', () => { if (!touched) modeSel.value = defaultAnniMode(nameInp.value); });
    }
  } catch (e) {}
  const r = await p;
  if (!r) return;
  const name = (r.name || '').trim() || '纪念日';
  const date = r.date || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式错误');
  c.anniversaries = c.anniversaries || [];
  c.anniversaries.push({ id: uid(), name, date, mode: r.mode === 'countdown' ? 'countdown' : 'countup' });
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
    { key: 'date', label: '日期', type: 'date', value: a.date, required: true },
    { key: 'mode', label: '计算方式', type: 'select', value: a.mode || defaultAnniMode(a.name), options: ANNI_MODE_OPTIONS }
  ], '保存');
  if (!r) return;
  const date = r.date || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('日期格式错误');
  a.name = (r.name || '').trim() || a.name; a.date = date;
  a.mode = r.mode === 'countdown' ? 'countdown' : 'countup';
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
export async function delAnni(id) {
  if (!await confirmDialog('确定删除这个纪念日吗？')) return;
  const cid = state.currentContactId;
  const c = await getContact(cid);
  c.anniversaries = (c.anniversaries || []).filter(x => x.id !== id);
  // 被指定展示的那条被删除时一并清空，避免联系人条目引用不存在的纪念日
  if (c.contactAnniId === id) c.contactAnniId = '';
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
// 置顶开关：多条可同时置顶，独立存于每条纪念日上
export async function toggleAnniPin(id) {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  const a = (c.anniversaries || []).find(x => x.id === id);
  if (!a) return;
  a.pinned = !a.pinned;
  await saveContact(c);
  renderAnniversaryPanel(cid);
}
// 联系人条目展示哪一条：独立存于联系人的 contactAnniId，空值表示不显示
export async function setContactAnni(id) {
  const cid = state.currentContactId;
  const c = await getContact(cid);
  if (id && !(c.anniversaries || []).some(x => x.id === id)) return;
  c.contactAnniId = id || '';
  await saveContact(c);
  renderAnniversaryPanel(cid);
  renderContacts();
}
