// 依赖：全部前置文件，必须最后加载
import { _taskQueue, DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, dbAll, dbDel, dbGet, dbPut, escapeHtml, now, openDB, pick, randInt, showModal, toast } from './02-core.js';
import { applyNickname, applyTheme, backFromApp, backFromChat, createNewContact, exitChatMode, getAllContacts, getCurrentReplyRate, getStatusCategories, getStatusPool, getTheme, normalizeContactStatus, openChat, openContactSettingsFromChatDirect, openPage, recordStatusWindow, renderContacts, renderMeBrief, saveContact } from './03-data.js';
import { addAnni, addChoiceOpt, appendReplyMessages, autoResize, cascadeReadFromMe, clearQuoteReply, closeImgPreview, delAnni, deleteMsg, editAnni, jumpToMsg, onChatKeydown, openAnniversary, openChoice, pickQuoteId, pickReplyCount, previewImg, processChoiceQuestions, quoteReply, renderChatIncremental, renderChatMessages, replyCountRange, sendImageMessage, sendTextMessage, toggleChatMenu, triggerReply } from './04-chat.js';
import { answerIncoming, backLetterDetail, backLetterList, composeLetterToCurrent, deleteCurrentLetter, ensureLetterDay, genLetterContent, makeCall, openLetterCompose, openLetterDetail, openLetterInbox, persistCallState, pushMissedCall, rejectIncoming, renderLetterList, restoreCallState, sendLetter, showIncomingCall, toggleCallMic, toggleCallMinimize } from './05-call-letter.js';
import { addCard, addLibStickers, addMyStickers, applyCustomColor, applyPresetBg, applyPresetColor, backFromCardLib, backFromChatSearch, backFromContactSetting, backFromStickerLib, createCardGroup, csAddStatus, csDeleteContact, csEditMyNickname, csEditName, csResetBg, csSaveCallRate, csSaveProactive, csSaveReply, csSearchChat, csSearchChatRender, csSearchJump, csSetBgPos, csSetSplit, csToggleIncomingCall, csToggleLetter, csToggleProactive, csToggleStatusAuto, csUpdateAvatar, csUploadBg, deleteCard, deleteCardGroup, deleteLibSticker, deleteMySticker, deleteStatus, editCard, editCardGroup, editMyName, editStatus, filterCardLib, openBatchImport, openCardLib, openContactSetting, openContactSettingsList, openMyStickers, openStickerLib, quickAddMyStickers, renderThemeUI, resetBg, saveCustomCSS, sendStickerAndClose, setBgPos, setStatusCurrent, switchStkTab, toggleStatusHelp, toggleStickerPanel, updateMyAvatar, uploadBg, closeStickerPanel } from './06-ui.js';
import { applyDIYVariables, checkTodoReminders, clearHomeDecos, closeDecoEditor, closeDIY, closeDiyPage, closeTodoPanel, deleteHomeDeco, deleteTodo, doExport, doImport, openDecoEditor, openDiyPage, openHomeStickerUploader, openTodoEditor, pickDIYImage, previewDIYFontSize, promptTodoAdd, renderHomeAvatar, saveDIYFontSize, renderStorageStats, renderTodos, resetDIYAll, resetDIYItem, resetDIYSection, saveHomeFreeText, setDIYColor, setDiyMode, setDIYText, toggleExportAll, toggleTodo, uploadHomeBanner, applyCustomCSS, clearBubbleCSS, clearCustomCSS, resetHomeBg, saveBubbleCSS, uploadHomeBg, uploadHomeSquareImg } from './07-diy-todo.js';
import { addInspiration, deleteInspiration, editInspiration, ensureDailyMoods, initInspirationModule, initMoodModule, inspClearSearch, inspSearch, moodNextMonth, moodPrevMonth, openInspirationPage, openLoveMoodDay, openLoveMoodPage, openMoodDay, openMoodPage, pickMoodEmoji, pickMoodRole, renderLoveMoodCalendar, renderMoodDrawer, saveInspirationEdit, saveMyMood, switchMoodRole, toggleMoodDrawer } from './09-mood.js';
import { clearDivineHistory, copyDivineResult, deleteDivineHistory, divineBackStep, divineConfirmSpread, divinePickKind, divineRestart, divineToInspiration, drawDivine, dvImgError, flipDivineCard, initDivineModule, openDivineCardMeaning, openDivineHistory, openDivinePage, selectDivineSpread, sendDivineToChat, sendDivineToContact, setDivineDrawMode, startDivineDraw, switchDivineType, toggleDivineMeaning, viewDivineHistory } from './10-divine.js';
import { checkReminders, closeChatToolDrawer, deleteReminder, editReminder, initReminderModule, openReminderPanel, runChatTool, toggleChatToolDrawer } from './11-reminder.js';
import { checkTogetherInvites, initMusicModule, musicAcceptInvite, musicBack, musicDelete, musicExitTogether, musicNext, musicOpenTogetherPicker, musicPickFiles, musicPlayId, musicPrev, musicRejectInvite, musicSeek, musicSetVolume, musicStartTogether, musicToggleLoop, musicTogglePlay, openMusicPage, renderGlobalStorage, requestPersistStorage, updateMusicMiniBar } from './12-music.js';
import { checkPeriodReminders, openPeriodPage, periodAddPast, periodSaveSettings, periodToday, renderPeriodPage } from './13-period.js';
import { openReaderBook, openReaderNoteView, openReaderPage, readerBack, readerDeleteBook, readerNextPage, readerOpenNote, readerPickFile, readerPrevPage, renderReaderPage, renderReaderShelf } from './14-reader.js';
import { initWalletModule, walletResume } from './15-wallet.js';

export function enqueueTask(fn) {
  return new Promise((resolve, reject) => {
    _taskQueue.push({ fn, resolve, reject });
    if (!state._taskRunning) processQueue();
  });
}
async function processQueue() {
  if (state._taskRunning) return;
  state._taskRunning = true;
  try {
    while (_taskQueue.length) {
      const t = _taskQueue.shift();
      try { const r = await t.fn(); t.resolve(r); }
      catch(e) { t.reject(e); }
    }
  } finally { state._taskRunning = false; }
}

// ============ 关闭网页补算 + 周期检查 ============
const CATCHUP_LOCK_KEY = 'catchup_lock_v1';
const MAX_STATUS_SEGMENTS = 60; // 状态回放硬上限：超过直接跳到当下（常数级工作量）
function tabId() { if (!state._tabId) state._tabId = uid(); return state._tabId; }
async function acquireCatchUpLock() {
  const t = now();
  const rec = await dbGet('meta', CATCHUP_LOCK_KEY);
  if (rec && rec.owner !== tabId()) {
    const age = t - rec.at;
    // 其它标签页刚跑过（或时间回拨但仍在锁窗口）→ 跳过，避免重复补算/补发
    if ((age >= 0 && age < 8000) || (age < 0 && age > -5000)) return false;
  }
  await dbPut('meta', { k: CATCHUP_LOCK_KEY, at: t, owner: tabId() });
  return true;
}
async function releaseCatchUpLock() {
  const rec = await dbGet('meta', CATCHUP_LOCK_KEY);
  if (rec && rec.owner === tabId()) await dbDel('meta', CATCHUP_LOCK_KEY);
}
// 状态回放：按 2–8 小时逐段推进到现在，写作息表（每联系人独立）；返回切换窗口（新状态）
function replayStatus(c, pool, t) {
  const windows = [];
  if (!pool.length) return windows;
  // 手动切换（自动切换关闭时）：在切换时刻用新状态处理一次挂起队列
  if (c.manualSwitchAt) {
    windows.push({ at: c.manualSwitchAt, statusId: c.statusId });
    c.manualSwitchAt = 0;
    return windows;
  }
  if (c.statusAuto === false) return windows;
  if (!c.statusSince) c.statusSince = Math.min(t, (c.nextStatusAt || t) - 1000);
  let next = c.nextStatusAt;
  if (!next || next <= c.statusSince) next = c.statusSince + randInt(120, 480) * 60 * 1000;
  let count = 0;
  while (next <= t && count < MAX_STATUS_SEGMENTS) {
    recordStatusWindow(c, c.statusId, c.statusSince, next);
    const nextId = pick(pool).id;
    windows.push({ at: next, statusId: nextId });
    c.statusId = nextId;
    const st = pool.find(s => s.id === nextId);
    if (st) c.status = st.name;
    c.statusSince = next;
    next = next + randInt(120, 480) * 60 * 1000;
    count++;
  }
  if (count >= MAX_STATUS_SEGMENTS && next <= t) {
    // 离开太久：不再逐段回放，直接跳到当下（挂起消息仍用已生成的 60 个有效窗口处理）
    if (c.statusSince < t) recordStatusWindow(c, c.statusId, c.statusSince, t);
    c.statusSince = t;
    c.nextStatusAt = t + randInt(120, 480) * 60 * 1000;
  } else {
    c.nextStatusAt = next;
  }
  if (c.nextStatusAt < c.statusSince) c.nextStatusAt = c.statusSince + randInt(120, 480) * 60 * 1000;
  c.nextStatusChangeAt = c.nextStatusAt;
  return windows;
}
// 挂起消息按作息表窗口判定（只遍历该联系人的挂起队列，不扫全部消息）
async function processPending(c, windows, pool, cats) {
  if (!c.pendingReplies || !c.pendingReplies.length || !windows.length) return false;
  let changed = false;
  const remain = [];
  for (const p of c.pendingReplies) {
    let resolved = false;
    for (const w of windows) {
      if (w.at <= (p.sentAt || 0)) continue;
      const st = pool.find(s => s.id === w.statusId) || null;
      const cat = cats.find(x => x.id === (st && st.category)) || cats[0];
      const seen = Math.random() * 100 >= (cat ? cat.unread : 100);
      if (!seen) {
        p.windows = (p.windows || 0) + 1;
        // 连续 3 个窗口未看 → 收尾已读不回；睡觉类（readNoReply=0）不在睡觉时判已读不回
        if (p.windows >= 3 && cat && cat.readNoReply > 0) {
          markPendingRead(c, p, w.at, 'readNoReply');
          resolved = true; changed = true; break;
        }
        continue;
      }
      markPendingRead(c, p, w.at, 'read');
      const rate = st ? st.replyRate : 50; // 已读并回复的概率
      if (Math.random() * 100 < rate) {
        const cnt = pickReplyCount(c);
        const anchorId = (p.msgIds || [])[(p.msgIds || []).length - 1];
        const anchor = c.messages.find(x => x.id === anchorId) || c.messages[c.messages.length - 1];
        const sent = await appendReplyMessages(c, anchor, cnt, w.at);
        for (const id of (p.msgIds || [])) { const m = c.messages.find(x => x.id === id); if (m) { m.replied = true; m.replyDone = true; } }
        if (sent && state.currentContactId !== c.id) c.unread = (c.unread || 0) + sent;
      }
      resolved = true; changed = true; break;
    }
    if (!resolved) remain.push(p);
  }
  // 已读单调：被其它判读级联标已读的挂起项直接结束（不再补回复）
  const nextPending = [];
  for (const p of remain) {
    const ms = (p.msgIds || []).map(id => c.messages.find(x => x.id === id)).filter(Boolean);
    if (ms.length && ms.every(m => m.read)) continue;
    nextPending.push(p);
  }
  c.pendingReplies = nextPending;
  return changed;
}
function markPendingRead(c, p, at, reason) {
  const ids = p.msgIds || [];
  const anchorId = ids[ids.length - 1];
  if (anchorId) cascadeReadFromMe(c, anchorId);
  for (const id of ids) {
    const m = c.messages.find(x => x.id === id);
    if (!m) continue;
    if (!m.readAt) m.readAt = at;
    m.queued = false;
    if (reason !== 'reply') m.replied = true;
  }
}
// 判定组（实时定时器之外的补算）：回/已读不回 到点结算，同一节共用判定
async function processJudgedMessages(c, t) {
  const groups = new Map();
  for (const m of c.messages) {
    if (m.from !== 'me' || !m.judgeKey || !m.judgement || m.judgement === 'unread') continue;
    let g = groups.get(m.judgeKey);
    if (!g) { g = { msgs: [], judgement: m.judgement, readAt: m.readAt || 0, replyAt: m.replyAt || 0, replyDone: false }; groups.set(m.judgeKey, g); }
    g.msgs.push(m);
    if (m.replyDone) g.replyDone = true;
    if (!g.readAt && m.readAt) g.readAt = m.readAt;
    if (!g.replyAt && m.replyAt) g.replyAt = m.replyAt;
  }
  let changed = false;
  for (const g of groups.values()) {
    const anchorId = g.msgs[g.msgs.length - 1].id;
    if (g.readAt && t >= g.readAt && g.msgs.some(m => !m.read)) {
      cascadeReadFromMe(c, anchorId);
      for (const m of g.msgs) if (m.judgement === 'readNoReply') m.replied = true;
      changed = true;
    }
    if (g.judgement === 'reply' && !g.replyDone && g.replyAt && t >= g.replyAt) {
      cascadeReadFromMe(c, anchorId);
      const anchor = c.messages.find(x => x.id === anchorId) || c.messages[c.messages.length - 1];
      const sent = await appendReplyMessages(c, anchor, pickReplyCount(c), g.replyAt);
      for (const m of g.msgs) { m.replied = true; m.replyDone = true; }
      if (sent && state.currentContactId !== c.id) c.unread = (c.unread || 0) + sent;
      changed = true;
    }
  }
  return changed;
}
export async function runCatchUp(onlyCid) {
  return enqueueTask(async () => {
    const t = now();
    if (!await acquireCatchUpLock()) return false;
    try {
    // B1：进入单个聊天时只补该联系人，避免每次点击都全量扫描 20 个联系人
    let contacts = await getAllContacts();
    if (onlyCid) contacts = contacts.filter(c => c.id === onlyCid);
    // A25/A26：状态共享池（内置 + 自定义，所有联系人通用）
    const statusPool = await getStatusPool();
    const cats = await getStatusCategories();
    let changed = false;
    for (let c of contacts) {
      // 记录本轮补算开始时的消息长度：用于找出本轮新补出的回复，主动消息排在它们之后
      const preReplyLen = (c.messages || []).length;
      // 0) 先与共享池/作息表/挂起队列对齐（状态为空或不在池内 → 池内随机并写回）
      await normalizeContactStatus(c, statusPool);
      // 1) 状态逐段回放（含离线期间错过的切换）+ 挂起消息按窗口判定
      const windows = replayStatus(c, statusPool, t);
      if (windows.length) changed = true;
      if (await processPending(c, windows, statusPool, cats)) changed = true;

      // 2) 聊天消息：已读和回复（新判定组走状态链；旧消息保持原逻辑）
      const curRate = getCurrentReplyRate(c);
      let msgsChanged = false;
      const myMsgs = (c.messages || []).filter(m => m.from === 'me');
      let anchorMsg = myMsgs.length ? myMsgs[myMsgs.length - 1] : null;

      // 2a) 已读处理：到达各自 readAt 即已读 + 级联（仅旧数据）
      for (const m of myMsgs) {
        if (m.judgement == null && !m.queued && !m.read && m.readAt && t >= m.readAt) {
          cascadeReadFromMe(c, m.id);
          msgsChanged = true; changed = true;
        }
      }

      // 2b) 新链判定组到点结算
      if (await processJudgedMessages(c, t)) { msgsChanged = true; changed = true; }

      // 2c) 旧数据回复处理：最新一条 replyAt 到点后按快照 rate 掷骰子，命中才回
      const anyUnhandled = myMsgs.some(m => !m.replied && m.judgement == null && !m.queued);
      if (anyUnhandled && anchorMsg && anchorMsg.replyAt && anchorMsg.judgement == null && t >= anchorMsg.replyAt) {
        const snap = anchorMsg.snapshot || {};
        for (const m of myMsgs) if (!m.replied && m.judgement == null) m.replied = true;
        cascadeReadFromMe(c, anchorMsg.id);
        const rateForRound = snap.rate != null ? snap.rate : curRate;
        const willReply = Math.random() * 100 < rateForRound;
        if (willReply) {
          const range = replyCountRange(c);
          const repCnt = range.min === range.max ? range.min : randInt(range.min, range.max);
          const sent = await appendReplyMessages(c, anchorMsg, repCnt, anchorMsg.replyAt);
          c.unread = (c.unread || 0) + sent;
        }
        msgsChanged = true; changed = true;
      }

      // 2d) 「选择」提问到点补算：离线/切后台导致定时器丢失时补出结果
      if (await processChoiceQuestions(c, t)) { msgsChanged = true; changed = true; }

      // 本轮新补出的对方消息（回复/选择结果）中最晚的时间：主动消息必须排在它之后
      let lastReplyAt = 0;
      for (let i = preReplyLen; i < c.messages.length; i++) {
        const m = c.messages[i];
        if (m.from === 'other' && Number.isFinite(m.time)) lastReplyAt = Math.max(lastReplyAt, m.time);
      }

      // 3) 主动消息（proactiveMsg）：条数用 proactiveMin ~ proactiveMax 之间随机
      if (c.settings.proactiveMsg) {
        if (!c.settings.nextProactiveAt || t >= c.settings.nextProactiveAt) {
          // 还有未到点的回复排队：先等回复发出，避免主动消息抢在回复前面
          const pendingReplyAt = myMsgs.reduce((mx, m) => {
            if (m.judgement === 'reply' && !m.replyDone && m.replyAt && m.replyAt > t) return Math.max(mx, m.replyAt);
            return mx;
          }, 0);
          if (pendingReplyAt) {
            // 本轮不排，保持 nextProactiveAt 原值，等回复到点后的下一次检查再发
          } else if (curRate <= 20) {
            // 低概率状态（睡觉 / 不理人等极不活跃）：跳过本次主动消息，仍推进下次时间防止死循环
            c.settings.nextProactiveAt = t + randInt(2, 8) * 3600 * 1000;
            changed = true;
          } else {
            const cards = c.cardGroups.flatMap(g => g.cards || []);
            const pMin = c.settings.proactiveMin != null ? Math.max(0, c.settings.proactiveMin) : 1;
            const pMax = c.settings.proactiveMax != null ? Math.max(pMin, c.settings.proactiveMax) : 3;
            const cnt = cards.length ? (pMin === pMax ? pMin : randInt(pMin, pMax)) : 0;
            // 起点取「应发时刻」与「本轮回复最后时间」中较晚者：回复先出，主动消息后出
            const baseAt = Math.max(c.settings.nextProactiveAt || t, lastReplyAt || 0);
            const useStickers = (c.stickers || []).length > 0;
            // 绝对递增 + 钳平到当前时刻，防止同一时刻连环轰炸或出现未来时间戳
            let lastAt = baseAt;
            for (let i = 0; i < cnt; i++) {
              // 与上一条回复/主动消息留 1~2 秒（首条）或 1~3 秒（后续）间隔
              lastAt = lastAt + (i === 0 && lastReplyAt ? randInt(1000, 2000) : randInt(1000, 3000));
              let atT = Math.min(lastAt, t);
              if (atT <= baseAt && i === 0) atT = Math.min(t, baseAt + 1);
              lastAt = atT;
              let type = 'text', content = '';
              if (useStickers && Math.random() < 0.5) { type='sticker'; content = pick(c.stickers).data; }
              else if (cards.length) { type='text'; content = await applyNickname(pick(cards).content, c); }
              else continue;
              const replyTo = Math.random() < 0.5 ? pickQuoteId(c) : null;
              c.messages.push({
                id: uid(), from:'other', type, content,
                time: atT, replyTo, snapshot: null,
                read: true, readAt: atT, replyAt: 0, replied: true
              });
            }
            c.settings.nextProactiveAt = t + randInt(2, 8) * 3600 * 1000;
            if (cnt > 0) { c.unread = (c.unread||0) + cnt; changed = true; }
          }
        }
      }

      // 4) 写信回信（_pendingLetters）
      if (c._pendingLetters && c._pendingLetters.length) {
        const remain = [];
        for (const pl of c._pendingLetters) {
          if (t >= pl.replyAt) {
            c.letters = c.letters || [];
            c.letters.push(pl.letter);
            changed = true;
          } else remain.push(pl);
        }
        c._pendingLetters = remain;
      }

      // 5) 来电分槽法 + 触发
      c = ensureCallSlots(c, t);
      if (c.settings.incomingCall && c.callSlots) {
        const today = new Date(t); const todayStr = `${today.getFullYear()}-${today.getMonth()+1}-${today.getDate()}`;
        if (c.callSlots.date === todayStr) {
          const triggered = c.callSlots.triggered || [];
          const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
          const dayEnd = dayStart + 24 * 3600 * 1000;
          for (let i = 0; i < c.callSlots.slots.length; i++) {
            const slot = c.callSlots.slots[i];
            if (triggered.includes(i) || t < slot.time) continue;
            // 睡觉类状态不打扰（沿用现有作息限制）：顺延 1~3 小时，当天排不下就作废
            if (isSleepingStatus(c)) {
              const next = slot.time + randInt(60, 180) * 60 * 1000;
              if (next < dayEnd) { slot.time = next; changed = true; }
              else triggered.push(i);
              continue;
            }
            // 触发（如果停留在该联系人对话页则弹，否则记未接）
            triggered.push(i);
            // 低概率状态（睡觉 / 不理人）不弹来电，只记未接，模拟「Ta 没空打」
            if (curRate > 20 && state.currentContactId === c.id && !state.callState) {
              // 弹窗
              showIncomingCall(c, Math.random()<0.5 ? 'video' : 'voice');
            } else {
              // 记未接（多个联系人的未接都留下，不作废；同一联系人最多 3 条系统消息防雪崩）
              pushMissedCall(c, slot.time);
              changed = true;
            }
          }
          c.callSlots.triggered = triggered;
        }
      }

      // 6) 主动来信：每日 50% 判定 + 到点生成信件并入信箱，同步推一条聊天系统提示
      c = ensureLetterDay(c, t);
      if (c.settings.letterEnabled && c.settings.nextLetterAt && t >= c.settings.nextLetterAt) {
        if (curRate <= 20) {
          // 低概率状态（睡觉 / 不理人）：本次不写来信，顺延到下一个时段再判定
          c.settings.nextLetterAt = t + randInt(2, 8) * 3600 * 1000;
          changed = true;
        } else {
          const letter = { id: uid(), direction: 'in', title: `${c.name}的来信`, content: await genLetterContent(c), time: t, read: false };
          c.letters = c.letters || [];
          c.letters.push(letter);
          c.settings.nextLetterAt = null;
          const letterSysKey = 'letter:' + letter.id;
          if (!(c.messages || []).some(m => m.sysKey === letterSysKey)) {
            c.messages.push({
              id: uid(), from: 'other', type: 'text', content: 'Ta 寄来了一封信，快去信箱看看吧。',
              time: t, replyTo: null, snapshot: null, read: true, readAt: t, replyAt: 0, replied: true,
              sysKey: letterSysKey
            });
            c.unread = (c.unread || 0) + 1;
          }
          changed = true;
        }
      }

      // 7) 每日随机心情补算（30% 留白 / 70% 抽字卡+Emoji，写入 meta 的 mood 键）
      try { await ensureDailyMoods(c, t); } catch (e) { console.warn('心情补算失败：', e); }

      // 8) 钳平未来时间戳 + 按 time 升序稳定排序，防止离线补算造成聊天记录乱序
      for (const m of c.messages) { if (m.time > t) m.time = t; }
      c.messages.sort((a, b) => a.time - b.time);

      await saveContact(c);
    } // end contacts loop
    return changed;
    } finally {
      await releaseCatchUpLock();
    }
  });
}

// 供 03-data.openChat 在进入聊天页之前调用（一次完成补算并落库）
window.__runCatchUp = runCatchUp;
// 供调试/测试直接构造系统消息（纯函数，不落库）
window.pushMissedCall = pushMissedCall;
// 供 04-chat 的定时器复用串行队列，避免与补算并发写同一联系人
window.__enqueueTask = enqueueTask;

// 来访概率：读联系人各自的设置，缺省/非法按 50，夹到 0–100 整数
function contactCallRate(c) {
  const raw = c && c.settings ? c.settings.callRate : null;
  if (raw === null || raw === undefined || raw === '') return 50;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// 当天排期：每个联系人每天独立按「来电概率」掷一次 —— 命中才在当天随机一个时刻打一通，没中当天不打
function ensureCallSlots(c, t) {
  if (!c.settings || !c.settings.incomingCall) return c;
  const today = new Date(t);
  const todayStr = `${today.getFullYear()}-${today.getMonth()+1}-${today.getDate()}`;
  if (c.callSlots && c.callSlots.date === todayStr) return c; // 今天已掷过，绝不重复掷骰 / 重复打
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const rate = contactCallRate(c);
  const slots = [];
  if (rate > 0 && Math.random() * 100 < rate) {
    // 命中：时刻按 30 分钟槽随机（同一时段多人也各自独立抽，不会压在同一点）
    const s = randInt(0, 47);
    slots.push({ index: s, time: startOfDay + s * 30 * 60 * 1000 + randInt(0, 29 * 60 * 1000) });
  }
  c.callSlots = { date: todayStr, slots, triggered: [] };
  return c;
}

// 当前是否处于「睡觉」大类状态（沿用现有作息限制：睡觉类不打扰）
function isSleepingStatus(c) {
  if (!c.statusList || !c.status) return false;
  const s = c.statusList.find(x => x.name === c.status);
  return !!(s && s.category === 'sleep');
}

// 周期性检查（保持低频 60s；更重要的是用户打开页面/切页/回到前台时补算一次）
async function periodicCheck() {
  const changed = await runCatchUp();
  if (changed) {
    renderContacts();
    if (state.currentContactId) renderChatIncremental(state.currentContactId, { animate: false });
  }
  // 联系人提醒到点触发（串行执行，避免和 runCatchUp 同时写联系人）
  try { await enqueueTask(() => checkReminders(false)); } catch (e) { console.warn('提醒检查失败：', e); }
  // 联系人的「一起听」邀请（同样串行，避免并发写联系人）
  try { await enqueueTask(() => checkTogetherInvites()); } catch (e) { console.warn('一起听邀请检查失败：', e); }
  // 经期提醒（每个周期 2 条；过期不补，仅在预约当天窗口内发送）
  try { await enqueueTask(() => checkPeriodReminders()); } catch (e) { console.warn('经期提醒检查失败：', e); }
}

// ============ 初始化 ============
async function initApp() {
  try {
    await openDB();
  } catch (e) {
    showModal('初始化失败', `<div style="font-size:14px;line-height:1.7;">IndexedDB 初始化失败：${escapeHtml(e.message)}</div>`);
    return;
  }
  // 应用主题
  const theme = await getTheme();
  applyTheme(theme);
  // 迁移修复：旧版联系人默认头像二次编码损坏，统一替换
  const _oldContacts = await dbAll('contacts');
  for (const _c of _oldContacts) {
    if (_c.avatar && _c.avatar.indexOf('%2523') !== -1) {
      _c.avatar = DEFAULT_AVATAR;
      await dbPut('contacts', _c);
    }
  }
  // 渲染我的头像
  await renderMeBrief();
  // 启动时先补算（失败不阻塞后续初始化）
  try { await runCatchUp(); } catch (e) { console.warn('补算失败：', e); }
  // 启动补发：应用关闭期间到点的联系人提醒，明确标注为「补发 / 错过」
  try { await enqueueTask(() => checkReminders(true)); } catch (e) { console.warn('提醒补发失败：', e); }
  try { await enqueueTask(() => checkPeriodReminders()); } catch (e) { console.warn('经期提醒检查失败：', e); }
  // 全应用请求持久化存储（不阻塞启动，失败只记录）
  requestPersistStorage().catch(() => {});
  // 渲染联系人列表
  renderContacts();
  renderLetterList();
  renderThemeUI(theme);
  renderStorageStats();
  renderGlobalStorage().catch(() => {});
  // 恢复刷新前未结束的通话（失败不阻塞后续初始化）
  try { await restoreCallState(); } catch (e) { console.warn('恢复通话状态失败：', e); }
  // 手机端默认进入手机桌面页
  if (window.matchMedia('(max-width: 899px)').matches) openPage('page-home');
  // 底部导航点击（事件绑定式，兼容手机触屏；再次点击已激活的键 = 回手机桌面）
  window.__initBound = 0;
  document.querySelectorAll('.bottom-nav .nav-btn').forEach(btn => {
    btn.__boundTag = 'bound-' + (++window.__initBound);
    btn.addEventListener('click', () => {
      const id = btn.dataset.page;
      const cur = document.querySelector('.page.active');
      const wasActive = btn.classList.contains('active') && cur && cur.id === id;
      openPage(id);
      if (wasActive && window.matchMedia('(max-width: 899px)').matches) openPage('page-home');
    });
  });
  // 定时检查（保持低频 60s；状态切换/主动消息/挂起结算不新增高频定时器）
  setInterval(periodicCheck, 60000); // 60 秒检查一次
  // 监听可见性
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await runCatchUp();
      try { await enqueueTask(() => checkReminders(true)); } catch (e) { console.warn('提醒补发失败：', e); }
      try { await enqueueTask(() => checkTogetherInvites()); } catch (e) { console.warn('一起听邀请检查失败：', e); }
      try { await enqueueTask(() => checkPeriodReminders()); } catch (e) { console.warn('经期提醒检查失败：', e); }
      try { await walletResume(); } catch (e) { console.warn('红包补算失败：', e); }
      renderContacts();
      if (state.currentContactId) renderChatIncremental(state.currentContactId, { animate: false });
      // 切回前台时恢复未结束的通话（兜底，防止内存状态丢失）
      try { await restoreCallState(); } catch (e) { console.warn('恢复通话状态失败：', e); }
    }
  });
  // 冻结恢复 / bfcache 恢复 / 窗口重新聚焦：手机熄屏、切出网站后可能不触发
  // visibilitychange（或定时器被冻结丢弃），这里统一补一次补算，保证「选择」结果等
  // 到点内容能补出，而不是一直缺失。
  let _resumeSyncAt = 0;
  const resumeSync = async (reason) => {
    const t = now();
    if (t - _resumeSyncAt < 1500) return;
    _resumeSyncAt = t;
    try { await runCatchUp(); } catch (e) { console.warn(`恢复补算失败(${reason})：`, e); }
    try { await enqueueTask(() => checkReminders(true)); } catch (e) { console.warn('提醒补发失败：', e); }
    try { await enqueueTask(() => checkTogetherInvites()); } catch (e) { console.warn('一起听邀请检查失败：', e); }
    try { await enqueueTask(() => checkPeriodReminders()); } catch (e) { console.warn('经期提醒检查失败：', e); }
    try { await walletResume(); } catch (e) { console.warn('红包补算失败：', e); }
    renderContacts();
    if (state.currentContactId) renderChatIncremental(state.currentContactId, { animate: false });
  };
  document.addEventListener('resume', () => { resumeSync('resume'); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) resumeSync('pageshow'); });
  // 页面关闭/刷新前兜底持久化通话状态
  window.addEventListener('pagehide', () => { persistCallState(); });
  // 绑定导出选项点击
  document.querySelectorAll('#export-opts input[type=checkbox]:not(#export-all)').forEach(cb => {
    cb.addEventListener('change', () => {
      const all = document.querySelectorAll('#export-opts input[type=checkbox]:not(#export-all)');
      const allChecked = Array.from(all).every(x => x.checked);
      $('export-all').checked = allChecked;
    });
  });
  // DIY 变量应用
  applyDIYVariables(theme);
  // 首页
  renderHomeAvatar();
  renderTodos();
  // 手机桌面左右滑动双页
  initHomeSwiper();
  // 心情日历 & 灵感随记模块初始化
  initMoodModule();
  initInspirationModule();
  // 占卜模块初始化
  initDivineModule();
  // 聊天「＋」工具抽屉 & 联系人提醒模块
  initReminderModule();
  // 钱包 + 红包（纯本地记账）
  initWalletModule();
  // 本地音乐模块（空盒子，等待用户导入）
  initMusicModule();
  // 每 30 秒检查待办提醒
  setInterval(checkTodoReminders, 30_000);
  setTimeout(checkTodoReminders, 2000);
}

// ============ 手机桌面：左右滑动双页 ============
export function initHomeSwiper() {
  const wrapper = document.querySelector('.home-swiper-wrapper');
  if (!wrapper) return;
  const dots = Array.from(document.querySelectorAll('#page-home .home-dots .dot'));
  if (!dots.length) return;
  let rafId = 0;
  const update = () => {
    rafId = 0;
    const w = wrapper.offsetWidth || 1;
    const index = Math.max(0, Math.min(dots.length - 1, Math.round(wrapper.scrollLeft / w)));
    dots.forEach((d, i) => d.classList.toggle('active', i === index));
  };
  wrapper.addEventListener('scroll', () => {
    if (!rafId) rafId = requestAnimationFrame(update);
  }, { passive: true });
  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => {
      wrapper.scrollTo({ left: i * wrapper.offsetWidth, behavior: 'smooth' });
    });
  });
  window.addEventListener('resize', update);
  update();
}

// ============ 启动 ============
// 全局只保留输入框的原生菜单；阅读正文等区域由自建选区/笔记菜单处理原生 contextmenu
// Android Chrome 的「点按搜索/放大镜/复制菜单」都由 contextmenu 触发，这里统一拦截
function installSelectionGuards() {
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
  }, { capture: true });
}

// 顶栏固定：把每个页面顶栏之后的内容收进独立滚动容器，滚动条只出现在内容区
function setupPageScrollContainers() {
  document.querySelectorAll('.page').forEach(page => {
    if (page.id === 'page-chat') return; // 聊天页已有 chat-messages 独立滚动
    if (page.querySelector('.page-scroll')) return;
    let top = null;
    for (const ch of Array.from(page.children)) {
      if (ch.classList && ch.classList.contains('top-bar')) { top = ch; break; }
    }
    if (!top) return;
    const box = document.createElement('div');
    box.className = 'page-scroll';
    const siblings = [];
    let node = top.nextElementSibling;
    while (node) { siblings.push(node); node = node.nextElementSibling; }
    for (const n of siblings) box.appendChild(n);
    page.appendChild(box);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  installSelectionGuards();
  setupPageScrollContainers();
  initApp().catch(e => {
    console.error(e);
    toast('初始化失败：' + e.message);
  });
});

// ======== 以下为 HTML 内联事件（onclick 等）直接调用的函数：ES Module 下必须挂载到 window ========
// 内联事件（如挂断按钮 onclick="state.callState && ..."）需要访问模块作用域的 state 对象
window.state = state;
window.addAnni = addAnni;
window.addInspiration = addInspiration;
window.addCard = addCard;
window.addChoiceOpt = addChoiceOpt;
window.addLibStickers = addLibStickers;
window.addMyStickers = addMyStickers;
window.answerIncoming = answerIncoming;
window.applyCustomColor = applyCustomColor;
window.applyPresetBg = applyPresetBg;
window.applyPresetColor = applyPresetColor;
window.autoResize = autoResize;
window.backFromApp = backFromApp;
window.backFromCardLib = backFromCardLib;
window.backFromChat = backFromChat;
window.backFromContactSetting = backFromContactSetting;
window.backFromStickerLib = backFromStickerLib;
window.backLetterList = backLetterList;
window.backLetterDetail = backLetterDetail;
window.renderLetterList = renderLetterList;
window.clearHomeDecos = clearHomeDecos;
window.closeDecoEditor = closeDecoEditor;
window.closeDIY = closeDIY;
window.closeDiyPage = closeDiyPage;
window.closeImgPreview = closeImgPreview;
window.closeModal = closeModal;
window.closeTodoPanel = closeTodoPanel;
window.composeLetterToCurrent = composeLetterToCurrent;
window.copyDivineResult = copyDivineResult;
window.createCardGroup = createCardGroup;
window.createNewContact = createNewContact;
window.csAddStatus = csAddStatus;
window.csDeleteContact = csDeleteContact;
window.csSearchJump = csSearchJump;
window.csEditMyNickname = csEditMyNickname;
window.csEditName = csEditName;
window.csResetBg = csResetBg;
window.csSaveCallRate = csSaveCallRate;
window.csSaveProactive = csSaveProactive;
window.csSaveReply = csSaveReply;
window.csSetSplit = csSetSplit;
window.toggleStatusHelp = toggleStatusHelp;
window.csSearchChat = csSearchChat;
window.csSearchChatRender = csSearchChatRender;
window.backFromChatSearch = backFromChatSearch;
window.csSetBgPos = csSetBgPos;
window.csToggleIncomingCall = csToggleIncomingCall;
window.csToggleLetter = csToggleLetter;
window.csToggleProactive = csToggleProactive;
window.csToggleStatusAuto = csToggleStatusAuto;
window.csUpdateAvatar = csUpdateAvatar;
window.csUploadBg = csUploadBg;
window.delAnni = delAnni;
window.deleteCard = deleteCard;
window.deleteCardGroup = deleteCardGroup;
window.deleteCurrentLetter = deleteCurrentLetter;
window.deleteHomeDeco = deleteHomeDeco;
window.deleteInspiration = deleteInspiration;
window.deleteLibSticker = deleteLibSticker;
window.deleteMsg = deleteMsg;
window.deleteMySticker = deleteMySticker;
window.deleteStatus = deleteStatus;
window.deleteTodo = deleteTodo;
window.divinePickKind = divinePickKind;
window.divineRestart = divineRestart;
window.divineConfirmSpread = divineConfirmSpread;
window.divineBackStep = divineBackStep;
window.openDivineCardMeaning = openDivineCardMeaning;
window.deleteDivineHistory = deleteDivineHistory;
window.divineToInspiration = divineToInspiration;
window.doExport = doExport;
window.doImport = doImport;
window.drawDivine = drawDivine;
window.editAnni = editAnni;
window.editInspiration = editInspiration;
window.editCard = editCard;
window.editCardGroup = editCardGroup;
window.editMyName = editMyName;
window.editStatus = editStatus;
window.escapeHtml = escapeHtml;
window.exitChatMode = exitChatMode;
window.flipDivineCard = flipDivineCard;
window.toggleDivineMeaning = toggleDivineMeaning;
window.dvImgError = dvImgError;
window.jumpToMsg = jumpToMsg;
window.makeCall = makeCall;
window.moodNextMonth = moodNextMonth;
window.moodPrevMonth = moodPrevMonth;
window.onChatKeydown = onChatKeydown;
window.openAnniversary = openAnniversary;
window.openBatchImport = openBatchImport;
window.openCardLib = openCardLib;
window.openChat = openChat;
window.renderChatIncremental = renderChatIncremental;
window.openChoice = openChoice;
window.openContactSetting = openContactSetting;
window.openContactSettingsFromChatDirect = openContactSettingsFromChatDirect;
window.openContactSettingsList = openContactSettingsList;
window.openDecoEditor = openDecoEditor;
window.openDivineHistory = openDivineHistory;
window.clearDivineHistory = clearDivineHistory;
window.openDivinePage = openDivinePage;
window.openDiyPage = openDiyPage;
window.openHomeStickerUploader = openHomeStickerUploader;
window.openInspirationPage = openInspirationPage;
window.inspSearch = inspSearch;
window.inspClearSearch = inspClearSearch;
window.openLetterCompose = openLetterCompose;
window.openLetterInbox = openLetterInbox;
window.openLetterDetail = openLetterDetail;
window.openMoodDay = openMoodDay;
window.openMoodPage = openMoodPage;
window.openLoveMoodDay = openLoveMoodDay;
window.openLoveMoodPage = openLoveMoodPage;
window.renderLoveMoodCalendar = renderLoveMoodCalendar;
window.openMyStickers = openMyStickers;
window.openPage = openPage;
window.openStickerLib = openStickerLib;
window.openTodoEditor = openTodoEditor;
window.pickDIYImage = pickDIYImage;
window.pickMoodEmoji = pickMoodEmoji;
window.pickMoodRole = pickMoodRole;
window.previewImg = previewImg;
window.promptTodoAdd = promptTodoAdd;
window.quickAddMyStickers = quickAddMyStickers;
window.quoteReply = quoteReply;
window.clearQuoteReply = clearQuoteReply;
window.filterCardLib = filterCardLib;
window.rejectIncoming = rejectIncoming;
window.renderMoodDrawer = renderMoodDrawer;
window.resetBg = resetBg;
window.resetDIYAll = resetDIYAll;
window.resetDIYItem = resetDIYItem;
window.resetDIYSection = resetDIYSection;
window.saveCustomCSS = saveCustomCSS;
window.saveHomeFreeText = saveHomeFreeText;
window.saveInspirationEdit = saveInspirationEdit;
window.saveMyMood = saveMyMood;
window.selectDivineSpread = selectDivineSpread;
window.sendDivineToChat = sendDivineToChat;
window.sendDivineToContact = sendDivineToContact;
window.sendImageMessage = sendImageMessage;
window.sendLetter = sendLetter;
window.sendStickerAndClose = sendStickerAndClose;
window.sendTextMessage = sendTextMessage;
window.setBgPos = setBgPos;
window.setDIYColor = setDIYColor;
window.setDiyMode = setDiyMode;
window.setDIYText = setDIYText;
window.previewDIYFontSize = previewDIYFontSize;
window.saveDIYFontSize = saveDIYFontSize;
window.setStatusCurrent = setStatusCurrent;
window.startDivineDraw = startDivineDraw;
window.setDivineDrawMode = setDivineDrawMode;
window.switchStkTab = switchStkTab;
window.switchMoodRole = switchMoodRole;
window.switchDivineType = switchDivineType;
window.toggleCallMic = toggleCallMic;
window.toggleCallMinimize = toggleCallMinimize;
window.toggleChatMenu = toggleChatMenu;
window.toggleExportAll = toggleExportAll;
window.toggleMoodDrawer = toggleMoodDrawer;
window.toggleStickerPanel = toggleStickerPanel;
window.closeStickerPanel = closeStickerPanel;
window.toggleTodo = toggleTodo;
window.updateMyAvatar = updateMyAvatar;
window.uploadBg = uploadBg;
window.uploadHomeBanner = uploadHomeBanner;
window.uploadHomeBg = uploadHomeBg;
window.uploadHomeSquareImg = uploadHomeSquareImg;
window.resetHomeBg = resetHomeBg;
window.saveBubbleCSS = saveBubbleCSS;
window.clearBubbleCSS = clearBubbleCSS;
window.applyCustomCSS = applyCustomCSS;
window.clearCustomCSS = clearCustomCSS;
window.viewDivineHistory = viewDivineHistory;
window.openReaderPage = openReaderPage;
window.readerBack = readerBack;
window.renderReaderShelf = renderReaderShelf;
window.openReaderBook = openReaderBook;
window.readerDeleteBook = readerDeleteBook;
window.readerPickFile = readerPickFile;
window.readerPrevPage = readerPrevPage;
window.readerNextPage = readerNextPage;
window.renderReaderPage = renderReaderPage;
window.readerOpenNote = readerOpenNote;
window.openReaderNoteView = openReaderNoteView;
// 聊天工具抽屉 & 联系人提醒
window.toggleChatToolDrawer = toggleChatToolDrawer;
window.closeChatToolDrawer = closeChatToolDrawer;
window.runChatTool = runChatTool;
window.openReminderPanel = openReminderPanel;
window.editReminder = editReminder;
window.deleteReminder = deleteReminder;
// 本地音乐
window.openMusicPage = openMusicPage;
// 经期记录
window.openPeriodPage = openPeriodPage;
window.periodToday = periodToday;
window.periodAddPast = periodAddPast;
window.periodSaveSettings = periodSaveSettings;
window.renderPeriodPage = renderPeriodPage;
window.checkPeriodReminders = checkPeriodReminders;
window.musicBack = musicBack;
window.musicPickFiles = musicPickFiles;
window.musicTogglePlay = musicTogglePlay;
window.musicPrev = musicPrev;
window.musicNext = musicNext;
window.musicSeek = musicSeek;
window.musicSetVolume = musicSetVolume;
window.musicToggleLoop = musicToggleLoop;
window.musicPlayId = musicPlayId;
window.musicDelete = musicDelete;
window.musicOpenTogetherPicker = musicOpenTogetherPicker;
window.musicStartTogether = musicStartTogether;
window.musicAcceptInvite = musicAcceptInvite;
window.musicRejectInvite = musicRejectInvite;
window.musicExitTogether = musicExitTogether;
window.renderGlobalStorage = renderGlobalStorage;
window.requestPersistStorage = requestPersistStorage;
window.updateMusicMiniBar = updateMusicMiniBar;
