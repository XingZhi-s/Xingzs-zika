// 依赖：04-chat.js
import { CALL_PERSIST_KEY, DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, escapeHtml, formatTime, now, pick, randInt, toast } from './02-core.js';
import { applyNickname, backFromChat, getAllContacts, getContact, getMe, openPage, renderContacts, saveContact } from './03-data.js';
import { renderChatMessages, toggleChatMenu } from './04-chat.js';

// ============ 电话/视频 ============
export function makeCall(type) {
  toggleChatMenu();
  const cid = state.currentContactId;
  if (!cid) return;
  startOutgoingCall(cid, type);
}
export async function startOutgoingCall(cid, type) {
  const c = await getContact(cid);
  showCallScreen({
    name: c.name, avatar: c.avatar || DEFAULT_AVATAR,
    status: `正在${type==='video'?'视频':'电话'}呼叫…`,
    showAnswer: false, timer: false
  });
  // 2~5秒后50%接通
  const d = randInt(2, 5);
  let connected = false;
  const pickUpTimer = setTimeout(() => {
    connected = Math.random() < 0.5;
    if (connected) {
      // 接通：开始计时（长尾随机时长）
      const dur = randomCallDuration();
      updateCallStatus('通话中…', true);
      state.callState.startTime = now();
      startCallInterval(dur);
      persistCallState();
    } else {
      // 未接
      updateCallStatus(`${c.name}未接听`, false);
      // 记录一条消息 + 1.5秒后自动关闭
      setTimeout(async () => {
        closeCallScreen();
        const cc = await getContact(cid);
        cc.messages.push({
          id: uid(), from:'other', type:'text', content: `（${type==='video'?'视频':'电话'}未接听）`,
          time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
        });
        await saveContact(cc);
        if (state.currentContactId === cid) renderChatMessages(cid, true);
      }, 1500);
    }
  }, d * 1000);
  state.callState = { type, contactId: cid, incoming: false, startTime: 0, pickUpTimer, intervalId: null, connected:false, micOn:true, _name:c.name, _avatar:c.avatar||DEFAULT_AVATAR, hang:() => {
    clearTimeout(pickUpTimer);
    if (state.callState.intervalId) clearInterval(state.callState.intervalId);
    // 如果接通了：挂断，记一条消息 + 时长
    setTimeout(async () => {
      const wasConnected = state.callState ? state.callState.connected : false;
      const startTime0 = state.callState ? state.callState.startTime : 0;
      closeCallScreen();
      const cc = await getContact(cid);
      let txt = '';
      if (wasConnected) {
        const s = Math.floor((now() - startTime0)/1000);
        const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
        txt = `（已通话 ${mm}:${ss}）`;
      } else {
        txt = '（已取消呼叫）';
      }
      cc.messages.push({
        id: uid(), from:'me', type:'text', content: txt,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, true);
    }, 0);
  } };
  persistCallState();
  // 连接后续判断
  setTimeout(() => {
    if (state.callState) { state.callState.connected = connected; persistCallState(); }
  }, d*1000 + 50);
}

// 聊天菜单：写信给当前联系人
export function composeLetterToCurrent() {
  if (!state.currentContactId) return;
  const cid = state.currentContactId;
  const wasDesktop = window.matchMedia('(min-width: 900px)').matches;
  if (!wasDesktop) backFromChat();
  openPage('page-letter');
  setTimeout(async () => {
    openLetterCompose();
    const sel = $('letter-recipient');
    if (sel) {
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === cid) { sel.selectedIndex = i; break; }
      }
    }
  }, 50);
  toggleChatMenu();
}

export function showCallScreen({name, avatar, status, showAnswer, timer}) {
  let el = $('call-screen');
  if (!el) { el = document.createElement('div'); el.id = 'call-screen'; el.className = 'call-screen'; document.body.appendChild(el); }
  const isMini = el.classList.contains('mini');
  const isVideo = !!(state.callState && state.callState.type === 'video');
  const topIcon = isVideo ? '<svg class="i i-lg"><use href="#icon-video"/></svg>' : '<svg class="i i-lg"><use href="#icon-phone"/></svg>';
  const videoPreview = isVideo ? `<div class="call-video-placeholder" id="call-video-placeholder"><div class="call-video-remote"></div><div class="call-video-self"></div></div>` : `<img class="call-avatar" src="${escapeHtml(avatar)}" alt="">`;
  const micOn = state.callState ? (state.callState.micOn !== false) : true;
  const miniHtml = isMini ? `<img class="call-avatar call-avatar-mini" src="${escapeHtml(avatar)}" alt=""><div class="call-timer" id="call-timer">00:00</div><button class="call-mic-mini ${micOn ? '' : 'off'}" onclick="event.stopPropagation(); toggleCallMic()" title="麦克风开关"><svg class="i"><use href="#${micOn ? 'icon-mic' : 'icon-mic-off'}"/></svg></button>` : `<div class="call-top-bar"><span>${state.callState && state.callState.type==='video' ? '视频通话' : '语音通话'}</span><button class="call-top-btn" onclick="toggleCallMinimize()" title="最小化"><svg class="i i-sm"><use href="#icon-minimize"/></svg></button></div><div style="opacity:0.8;margin-top:4px;display:flex;align-items:center;gap:6px;font-size:13px;">${topIcon} <span>${state.callState && state.callState.type==='video' ? '视频通话' : '语音通话'}</span></div>${videoPreview}<div class="call-name">${escapeHtml(name)}</div><div class="call-status" id="call-status">${escapeHtml(status)}</div><div class="call-timer hide" id="call-timer">00:00</div><div style="flex:1;"></div><div class="call-extra-actions" id="call-extra-actions"></div><div class="call-actions">${showAnswer ? `<button class="call-btn answer" onclick="answerIncoming()" title="接听"><svg class="i i-lg"><use href="#icon-call-answer"/></svg></button>` : ''}${showAnswer ? `<button class="call-btn reject" onclick="rejectIncoming()" title="拒接"><svg class="i i-lg"><use href="#icon-call-reject"/></svg></button>` : `<button class="call-btn hang" onclick="state.callState && state.callState.hang && state.callState.hang()" title="挂断"><svg class="i i-lg" style="transform:rotate(135deg);"><use href="#icon-call-answer"/></svg></button>`}</div>`;
  el.innerHTML = miniHtml;
  if (isMini) { el.classList.add('mini'); el.style.transform = ''; if (state.callState && state.callState._pos) { el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.left = state.callState._pos.left + 'px'; el.style.top = state.callState._pos.top + 'px'; } enableCallDrag(el); } else { el.classList.remove('mini'); el.style.transform = ''; el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; }
  if (state.callState && state.callState.connected) renderCallConnectedControls();
}

// 通话悬浮拖动（pointer 事件，支持鼠标/触摸，requestAnimationFrame 节流）
export function enableCallDrag(el) {
  if (!el) return;
  if (el._dragBound) return;
  el._dragBound = true;
  let dragging = false; let startX = 0, startY = 0; let baseLeft = 0, baseTop = 0; let pendingFrame = 0, nextDx = 0, nextDy = 0;
  const isBtn = (t) => !!(t.closest && t.closest('.call-actions button,.call-extra-actions button,.call-mic-mini,.call-top-btn'));
  const onDown = (e) => {
    if (isBtn(e.target)) return;
    dragging = true; el._dragMoved = false; startX = e.clientX; startY = e.clientY;
    const rect = el.getBoundingClientRect(); baseLeft = rect.left; baseTop = rect.top;
    el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.left = baseLeft + 'px'; el.style.top = baseTop + 'px'; el.style.transform = '';
    if (state.callState) state.callState._pos = { left: baseLeft, top: baseTop };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  };
  const applyMove = () => {
    pendingFrame = 0; const vw = window.innerWidth, vh = window.innerHeight; const w = el.offsetWidth, h = el.offsetHeight;
    const newL = Math.min(Math.max(8, baseLeft + nextDx), vw - w - 8); const newT = Math.min(Math.max(8, baseTop + nextDy), vh - h - 8);
    el.style.transform = `translate(${newL - baseLeft}px, ${newT - baseTop}px)`;
    if (state.callState) state.callState._pos = { left: newL, top: newT };
  };
  const onMove = (e) => { if (!dragging) return; nextDx = e.clientX - startX; nextDy = e.clientY - startY; if (!pendingFrame) pendingFrame = requestAnimationFrame(applyMove); };
  const onUp = (e) => {
    if (!dragging) return; dragging = false; if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform || ''); const dx = m ? parseFloat(m[1]) : 0, dy = m ? parseFloat(m[2]) : 0;
    el.style.transform = ''; el.style.left = (baseLeft + dx) + 'px'; el.style.top = (baseTop + dy) + 'px';
    if (state.callState) { state.callState._pos = { left: baseLeft + dx, top: baseTop + dy }; persistCallState(); }
    el._dragMoved = Math.abs(dx) > 2 || Math.abs(dy) > 2;
    try { el.releasePointerCapture && el.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
}
export function renderCallConnectedControls() {
  const box = $('call-extra-actions'); if (!box) return;
  if (!state.callState || !state.callState.connected) { box.innerHTML = ''; return; }
  const micOn = state.callState.micOn !== false;
  const micTitle = micOn ? '麦克风：开启（点击静音）' : '麦克风：静音（点击开启）';
  const micIcon = micOn ? '#icon-mic' : '#icon-mic-off';
  box.innerHTML = `<button class="call-btn round small ${micOn?'mic-on':'mic-off'}" onclick="toggleCallMic()" title="${micTitle}"><svg class="i"><use href="${micIcon}"/></svg></button>`;
}
export function toggleCallMic() {
  if (!state.callState) return;
  state.callState.micOn = (state.callState.micOn === false) ? true : false;
  renderCallConnectedControls();
  persistCallState();
  toast(state.callState.micOn ? '麦克风已开启（模拟）' : '麦克风已静音（模拟）');
}
export function toggleCallMinimize() {
  const el = $('call-screen'); if (!el || !state.callState) return;
  const goingMini = !el.classList.contains('mini'); el.classList.toggle('mini', goingMini); state.callState.minimized = goingMini; persistCallState();
  const name = state.callState._name || '', av = state.callState._avatar || DEFAULT_AVATAR; const stat = $('call-status') ? $('call-status').textContent : '通话中…';
  showCallScreen({ name, avatar: av, status: stat, showAnswer: false, timer: false });
  if (goingMini) { bindMiniClickToRestore(el); } else { el.onclick = null; }
}

// ============ 通话状态持久化（刷新恢复机制） ============
export function persistCallState() {
  try { if (!state.callState) { localStorage.removeItem(CALL_PERSIST_KEY); return; } localStorage.setItem(CALL_PERSIST_KEY, JSON.stringify({ contactId: state.callState.contactId, type: state.callState.type || 'voice', incoming: !!state.callState.incoming, connected: !!state.callState.connected, startTime: state.callState.startTime || 0, duration: state.callState.duration || 0, micOn: state.callState.micOn !== false, minimized: !!state.callState.minimized, pos: state.callState._pos || null, savedAt: now() })); } catch (e) {}
}
export function clearPersistedCall() { try { localStorage.removeItem(CALL_PERSIST_KEY); } catch (e) {} }
export function bindMiniClickToRestore(el) {
  el.onclick = (e) => {
    if (e.target.closest('.call-actions') || e.target.closest('.call-extra-actions') || e.target.closest('.call-mic-mini') || e.target.closest('.call-top-btn')) return;
    if (el._dragMoved) { el._dragMoved = false; return; }
    if (el.classList.contains('mini')) toggleCallMinimize();
  };
}

// 通话计时器：接通后开始，每秒刷新计时，到达时长自动挂断
function startCallInterval(dur) {
  if (!state.callState) return;
  if (state.callState.intervalId) clearInterval(state.callState.intervalId);
  state.callState.duration = dur;
  state.callState.intervalId = setInterval(() => {
    if (!state.callState) return;
    const s = Math.floor((now() - state.callState.startTime)/1000);
    updateCallTimer(s);
    if (s >= dur) remoteHangUp();
  }, 1000);
}

// 通话时长：长尾随机分布（30% 10~60秒 / 50% 1~5分钟 / 20% 5~30分钟），每次通话截然不同
function randomCallDuration() {
  const r = Math.random();
  if (r < 0.3) return randInt(10, 60);
  if (r < 0.8) return randInt(60, 300);
  return randInt(300, 1800);
}

// 对方主动挂断（通话时长到期自动触发），生成 from:'other' 的系统通话消息
function remoteHangUp() {
  const cs = state.callState;
  if (!cs) return;
  if (cs.intervalId) { clearInterval(cs.intervalId); cs.intervalId = null; }
  if (cs.timeoutId) { clearTimeout(cs.timeoutId); cs.timeoutId = null; }
  if (cs.pickUpTimer) { clearTimeout(cs.pickUpTimer); cs.pickUpTimer = null; }
  const cid = cs.contactId;
  const isVideo = cs.type === 'video';
  const startTime = cs.startTime || now();
  setTimeout(async () => {
    closeCallScreen();
    const cc = await getContact(cid);
    if (!cc) return;
    const s = Math.max(0, Math.floor((now() - startTime)/1000));
    const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
    cc.messages.push({
      id: uid(), from:'other', type:'text', content: `${isVideo ? '（视频已通话 ' : '（已通话 '}${mm}:${ss}）`,
      time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
    });
    await saveContact(cc);
    if (state.currentContactId === cid) renderChatMessages(cid, true);
  }, 0);
}

// 刷新恢复后重建挂断回调（原闭包已丢失，按持久化状态重建）
function buildRestoredHang(cid) {
  return () => {
    const cs = state.callState;
    if (!cs) return;
    if (cs.intervalId) clearInterval(cs.intervalId);
    if (cs.timeoutId) clearTimeout(cs.timeoutId);
    if (cs.pickUpTimer) clearTimeout(cs.pickUpTimer);
    const wasConnected = !!cs.connected;
    const wasIncoming = !!cs.incoming;
    const startTime = cs.startTime || 0;
    const name = cs._name || '对方';
    setTimeout(async () => {
      closeCallScreen();
      const cc = await getContact(cid);
      if (!cc) return;
      let txt, from;
      if (wasConnected) {
        const s = Math.floor((now() - startTime)/1000);
        const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
        txt = `（已通话 ${mm}:${ss}）`;
        from = wasIncoming ? 'other' : 'me';
      } else if (wasIncoming) {
        txt = `（我拒接了${name}的来电）`;
        from = 'me';
      } else {
        txt = '（已取消呼叫）';
        from = 'me';
      }
      cc.messages.push({
        id: uid(), from, type:'text', content: txt,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, true);
    }, 0);
  };
}

// 刷新/切回前台时恢复未结束的通话（读取 localStorage 持久化状态）
export async function restoreCallState() {
  if (state.callState) return; // 内存中已有进行中的通话，直接沿用
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CALL_PERSIST_KEY) || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.contactId) return;
  const c = await getContact(saved.contactId);
  if (!c) { clearPersistedCall(); return; } // 联系人已被删除
  const cid = saved.contactId;
  const type = saved.type === 'video' ? 'video' : 'voice';
  const name = c.name, av = c.avatar || DEFAULT_AVATAR;
  // 未接通的振铃状态超过 60 秒视为陈旧残留（页面被直接杀掉等），清除不恢复
  if (!saved.connected && now() - (saved.savedAt || 0) > 60 * 1000) { clearPersistedCall(); return; }
  state.callState = {
    type, contactId: cid,
    incoming: !!saved.incoming,
    connected: !!saved.connected,
    startTime: saved.startTime || 0,
    duration: saved.duration || 0,
    intervalId: null, pickUpTimer: null, timeoutId: null,
    micOn: saved.micOn !== false,
    minimized: !!saved.minimized,
    _pos: saved.pos || null,
    _name: name, _avatar: av,
    hang: null,
  };
  const statusText = state.callState.connected ? '通话中…'
    : (state.callState.incoming ? `来电中…（${type==='video'?'视频':'电话'}）` : `正在${type==='video'?'视频':'电话'}呼叫…`);
  if (state.callState.connected) {
    // 已接通：补算时长；若离线期间已超过通话时长，直接按自动挂断补记
    const dur = state.callState.duration || randomCallDuration();
    const elapsed = Math.floor((now() - state.callState.startTime) / 1000);
    if (elapsed >= dur) {
      const mm = String(Math.floor(dur/60)).padStart(2,'0'), ss = String(dur%60).padStart(2,'0');
      c.messages.push({
        id: uid(), from: 'other', type:'text', content: `${type==='video' ? '（视频已通话 ' : '（已通话 '}${mm}:${ss}）`,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(c);
      state.callState = null;
      clearPersistedCall();
      if (state.currentContactId === cid) renderChatMessages(cid, true);
      return;
    }
    showCallScreen({ name, avatar: av, status: statusText, showAnswer: false, timer: true });
    updateCallStatus('通话中…', true);
    updateCallTimer(elapsed);
    startCallInterval(dur);
  } else if (state.callState.incoming) {
    // 来电振铃中：恢复接听界面 + 超时自动接/不接
    showCallScreen({ name, avatar: av, status: statusText, showAnswer: true, timer: false });
    state.callState.timeoutId = setTimeout(async () => {
      if (!state.callState || !state.callState.incoming || state.callState.connected) return;
      if (Math.random() < 0.5) {
        answerIncomingReal();
        persistCallState();
      } else {
        // 未接：记录 + 关闭
        closeCallScreen();
        const cc = await getContact(cid);
        if (cc) {
          cc.missedCalls = cc.missedCalls || [];
          cc.missedCalls.push(now());
          cc.messages.push({
            id: uid(), from:'other', type:'text', content: `📞 ${name}（未接来电）`,
            time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
          });
          cc.unread = (cc.unread||0)+1;
          await saveContact(cc);
          renderContacts();
          if (state.currentContactId === cid) renderChatMessages(cid, true);
        }
      }
    }, randInt(8, 15) * 1000);
  } else {
    // 去电振铃中：恢复界面并重新走一遍接通判定
    showCallScreen({ name, avatar: av, status: statusText, showAnswer: false, timer: false });
    state.callState.pickUpTimer = setTimeout(() => {
      if (!state.callState) return;
      if (Math.random() < 0.5) {
        state.callState.connected = true;
        state.callState.startTime = now();
        updateCallStatus('通话中…', true);
        startCallInterval(randomCallDuration());
      } else {
        updateCallStatus(`${name}未接听`, false);
        setTimeout(async () => {
          closeCallScreen();
          const cc = await getContact(cid);
          if (cc) {
            cc.messages.push({
              id: uid(), from:'other', type:'text', content: `（${type==='video'?'视频':'电话'}未接听）`,
              time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
            });
            await saveContact(cc);
            if (state.currentContactId === cid) renderChatMessages(cid, true);
          }
        }, 1500);
      }
      persistCallState();
    }, randInt(2, 5) * 1000);
  }
  state.callState.hang = buildRestoredHang(cid);
  // 恢复 mini 悬浮窗形态与位置（showCallScreen 依据 mini 类与 _pos 渲染）
  if (state.callState.minimized) {
    const el = $('call-screen');
    if (el && !el.classList.contains('mini')) {
      el.classList.add('mini');
      showCallScreen({ name, avatar: av, status: statusText, showAnswer: false, timer: !!state.callState.connected });
      bindMiniClickToRestore(el);
    }
  }
  persistCallState();
}
export function updateCallStatus(text, showTimer) {
  const s = $('call-status'), t = $('call-timer');
  if (s) s.textContent = text;
  if (t) t.classList.toggle('hide', !showTimer);
  // 进入通话中：刷新扩展按钮（视频麦开关、最小化）
  renderCallConnectedControls();
}
export function updateCallTimer(secs) {
  const t = $('call-timer'); if (!t) return;
  const mm = String(Math.floor(secs/60)).padStart(2,'0'), ss = String(secs%60).padStart(2,'0');
  t.textContent = `${mm}:${ss}`;
  // mini 模式下 call-timer 始终可见（纵向胶囊：计时器独立元素）
  const el = $('call-screen');
  if (el && el.classList.contains('mini')) t.classList.remove('hide');
}
export function closeCallScreen() {
  const el = $('call-screen'); if (el) el.remove(); state.callState = null;
  clearPersistedCall();
}

// 接听
export async function answerIncoming() {
  if (!state.callState || !state.callState.incoming) return;
  const cid = state.callState.contactId;
  const dur = randomCallDuration();
  const startTime = now();
  updateCallStatus('通话中…', true);
  state.callState.startTime = startTime;
  state.callState.connected = true;
  startCallInterval(dur);
  persistCallState();
  state.callState.hang = () => {
    if (state.callState.intervalId) clearInterval(state.callState.intervalId);
    setTimeout(async () => {
      closeCallScreen();
      const cc = await getContact(cid);
      const s = Math.floor((now() - startTime)/1000);
      const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
      cc.messages.push({
        id: uid(), from:'other', type:'text', content: `（已通话 ${mm}:${ss}）`,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, true);
    }, 0);
  };
}
export function rejectIncoming() {
  if (!state.callState || !state.callState.incoming) return;
  setTimeout(async () => {
    const cid = state.callState.contactId;
    const name = state.callState._name || '对方';
    closeCallScreen();
    const cc = await getContact(cid);
    if (cc) {
      cc.messages.push({
        id: uid(), from:'me', type:'text', content: `（我拒接了${name}的来电）`,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, true);
    }
    toast(`已拒接${name}的来电`);
  }, 0);
}
export function hangUpCall() { if (state.callState && state.callState.hang) state.callState.hang(); }

// 联系人主动来电（停留在对话页时弹出）
export async function showIncomingCall(c, type='voice') {
  const cid = c.id;
  // 仅当停留在该联系人对话页时弹
  if (state.currentContactId !== cid) {
    // 错过：记未接来电 + 一条系统消息
    c.missedCalls = c.missedCalls || [];
    c.missedCalls.push(now());
    c.messages.push({
      id: uid(), from:'other', type:'text', content: `📞 ${c.name}（未接来电）`,
      time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
    });
    c.unread = (c.unread||0)+1;
    await saveContact(c);
    renderContacts();
    return;
  }
  showCallScreen({
    name: c.name, avatar: c.avatar || DEFAULT_AVATAR,
    status: `来电中…（${type==='video'?'视频':'电话'}）`,
    showAnswer: true, timer: false
  });
  // 用户不操作，几秒后50%接/不接
  const timeout = randInt(8, 15);
  let done = false;
  state.callState = {
    type, contactId: cid, incoming: true, connected: false, intervalId: null, startTime: 0,
    micOn: true, _name: c.name, _avatar: c.avatar || DEFAULT_AVATAR,
    hang: () => {}, // 占位
    timeoutId: setTimeout(async () => {
      if (done) return;
      const accept = Math.random() < 0.5;
      done = true;
      if (accept) answerIncoming();
      else {
        // 未接
        closeCallScreen();
        const cc = await getContact(cid);
        cc.missedCalls = cc.missedCalls || [];
        cc.missedCalls.push(now());
        cc.messages.push({
          id: uid(), from:'other', type:'text', content: `📞 ${c.name}（未接来电）`,
          time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
        });
        cc.unread = (cc.unread||0)+1;
        await saveContact(cc);
        renderContacts();
        if (state.currentContactId === cid) renderChatMessages(cid, true);
      }
    }, timeout*1000)
  };
  state.callState.hang = () => {
    done = true;
    if (state.callState.timeoutId) clearTimeout(state.callState.timeoutId);
    rejectIncoming();
  };
  persistCallState();
  // 替换接听/拒接的回调，确保 done=true
  window.answerIncoming = () => {
    if (!state.callState || !state.callState.incoming) return;
    done = true;
    if (state.callState.timeoutId) clearTimeout(state.callState.timeoutId);
    answerIncomingReal();
  };
  window.rejectIncoming = () => {
    if (!state.callState || !state.callState.incoming) return;
    done = true;
    if (state.callState.timeoutId) clearTimeout(state.callState.timeoutId);
    rejectIncomingReal();
  };
}
export function answerIncomingReal() {
  // 真实接听
  const cid = state.callState.contactId;
  const dur = randomCallDuration();
  const startTime = now();
  updateCallStatus('通话中…', true);
  state.callState.startTime = startTime;
  state.callState.connected = true;
  startCallInterval(dur);
  persistCallState();
  state.callState.hang = () => {
    if (state.callState.intervalId) clearInterval(state.callState.intervalId);
    setTimeout(async () => {
      closeCallScreen();
      const cc = await getContact(cid);
      const s = Math.floor((now() - startTime)/1000);
      const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
      cc.messages.push({
        id: uid(), from:'other', type:'text', content: `（已通话 ${mm}:${ss}）`,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, true);
    }, 0);
  };
}
export function rejectIncomingReal() {
  setTimeout(async () => {
    const cid = state.callState ? state.callState.contactId : null;
    if (!cid) return;
    const name = state.callState._name || '对方';
    closeCallScreen();
    toast(`已拒接${name}的来电`);
    const cc = await getContact(cid);
    if (cc) {
      cc.messages.push({
        id: uid(), from:'me', type:'text', content: `（我拒接了${name}的来电）`,
        time: now(), replyTo: null, snapshot: null, read: true, readAt: now(), replyAt: 0, replied: true
      });
      await saveContact(cc);
      if (state.currentContactId === cid) renderChatMessages(cid, true);
    }
  }, 0);
}

// ============ 写信 ============
// 主动来信：生成信件正文（从字卡库抽 20~30 句，中文标点拼接，末句以。或！结尾）
export async function genLetterContent(c) {
  const cards = (c.cardGroups || []).flatMap(g => g.cards || []).map(x => x.content).filter(Boolean);
  const fallback = ['今天过得还好吗', '忽然想给你写点什么', '最近总想起你', '天气不错', '要照顾好自己', '期待下次聊天', '今天也有好好吃饭', '有点想你'];
  const pool = cards.length ? cards : fallback;
  const n = randInt(20, 30);
  const puncts = ['，', '。', '！', '？', '；', '、'];
  let out = '';
  for (let i = 0; i < n; i++) {
    // 去掉字卡自带的尾标点，避免重复
    const s = pick(pool).replace(/[，。！？；、~～…\s]+$/g, '');
    out += s + (i === n - 1 ? pick(['。', '！']) : pick(puncts));
  }
  return await applyNickname(out, c);
}
// 主动来信：每日首次补算时判定（50% 触发，触发则在当前时刻~当天23:59 之间随机选时）
export function ensureLetterDay(c, t) {
  if (!c.settings.letterEnabled) return c;
  const d = new Date(t);
  const todayStr = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (c.letterDay === todayStr) return c;
  c.letterDay = todayStr;
  if (Math.random() < 0.5) {
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59).getTime();
    c.settings.nextLetterAt = t + Math.floor(Math.random() * Math.max(1, end - t));
  } else {
    c.settings.nextLetterAt = null;
  }
  return c;
}
export async function renderLetterList() {
  const contacts = await getAllContacts();
  // 汇总所有联系人的信件
  let all = [];
  for (const c of contacts) {
    const list = c.letters || [];
    list.forEach(l => all.push({ ...l, contactId: c.id, contactName: c.name }));
  }
  all.sort((a,b) => b.time - a.time);
  const box = $('letter-list');
  if (!box) return;
  if (!all.length) {
    box.innerHTML = `<div class="empty">还没有信件，点击右上角 <svg class="i i-sm" style="vertical-align:-2px;"><use href="#icon-pencil"/></svg> 写新信</div>`;
    return;
  }
  box.innerHTML = all.map(l => {
    const dir = l.direction === 'out' ? 'out' : 'in';
    const from = l.direction === 'out' ? `我 → ${escapeHtml(l.contactName)}` : `${escapeHtml(l.contactName)} → 我`;
    return `<div class="letter-card ${dir}" onclick="openLetterDetail('${escapeHtml(l.contactId)}','${escapeHtml(l.id)}')">
      <div class="letter-time">${formatTime(l.time)}</div>
      <div class="letter-title">${escapeHtml(l.title || '(无标题)')}</div>
      <div class="letter-from">${from}</div>
      <div class="letter-preview multi-ellipsis">${escapeHtml(l.content)}</div>
    </div>`;
  }).join('');
}
export function openLetterCompose() {
  // 填充收件人选框
  getAllContacts().then(list => {
    const sel = $('letter-recipient');
    // 最近聊过的默认
    list.sort((a,b) => {
      const la = a.messages.length ? a.messages[a.messages.length-1].time : 0;
      const lb = b.messages.length ? b.messages[b.messages.length-1].time : 0;
      return lb - la;
    });
    sel.innerHTML = list.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') || '<option value="">请先创建联系人</option>';
    $('letter-title').value = '';
    $('letter-content').value = '';
    $('letter-list-view').classList.add('hide');
    $('letter-compose-view').classList.remove('hide');
    $('letter-detail-view').classList.add('hide');
  });
}
export function backLetterList() {
  $('letter-list-view').classList.remove('hide');
  $('letter-compose-view').classList.add('hide');
  $('letter-detail-view').classList.add('hide');
  renderLetterList();
}
export async function sendLetter() {
  const cid = $('letter-recipient').value;
  if (!cid) return toast('请选择收件人');
  const title = $('letter-title').value.trim();
  const content = $('letter-content').value.trim();
  if (!content) return toast('请输入正文');
  const c = await getContact(cid);
  if (!c) return;
  const cards = c.cardGroups.flatMap(g => g.cards);
  const willReply = cards.length > 0;
  if (!willReply) {
    if (!confirm(`该联系人没有字卡，无法回信。是否仍然发送？`)) return;
  }
  // 存发出去的信
  const letter = { id: uid(), direction:'out', title, content, time: now() };
  c.letters = c.letters || [];
  c.letters.push(letter);
  // 回信：8~12小时随机时间
  if (willReply) {
    const delay = (8 + Math.random()*4) * 3600 * 1000;
    const replyAt = Math.floor(now() + delay);
    // 复用 genLetterContent（20~30 句字卡拼接 + 专属称呼替换）
    const replyContent = await genLetterContent(c);
    // 存一封“待到点出现”的回信：把replyAt存到letter的pendingReply里？简单起见，直接在 c 上挂待办
    c._pendingLetters = c._pendingLetters || [];
    c._pendingLetters.push({
      replyAt,
      letter: { id: uid(), direction:'in', title: title ? `Re: ${title}` : '回信', content: replyContent, time: replyAt }
    });
  }
  await saveContact(c);
  toast('信件已寄出');
  backLetterList();
}
export async function openLetterDetail(cid, lid) {
  const c = await getContact(cid);
  if (!c) return;
  const l = (c.letters || []).find(x => x.id === lid);
  if (!l) return;
  state.currentLetterId = lid;
  state.currentLetterContactId = cid;
  $('letter-detail-title').textContent = l.title || '(无标题)';
  // 信纸视图：亲爱的 xx：正文 —— 署名 · 日期
  const me = await getMe();
  const isOut = l.direction === 'out';
  const nick = (c.settings && c.settings.myNickname) || me.name || '我';
  const greetName = isOut ? c.name : nick;
  const signName = isOut ? (me.name || '我') : c.name;
  $('letter-detail-content').innerHTML = `<div class="letter-paper">` +
    `<div class="lp-greet">亲爱的 ${escapeHtml(greetName)}：</div>` +
    `<div class="lp-body">${escapeHtml(l.content).replace(/\n/g, '<br>')}</div>` +
    `<div class="lp-sign">—— ${escapeHtml(signName)} · ${formatTime(l.time)}</div></div>`;
  $('letter-list-view').classList.add('hide');
  $('letter-compose-view').classList.add('hide');
  $('letter-detail-view').classList.remove('hide');
}

export async function deleteCurrentLetter() {
  if (!state.currentLetterId || !state.currentLetterContactId) return;
  if (!confirm('确定删除这封信吗？')) return;
  const c = await getContact(state.currentLetterContactId);
  c.letters = (c.letters || []).filter(x => x.id !== state.currentLetterId);
  await saveContact(c);
  toast('已删除');
  backLetterList();
}
