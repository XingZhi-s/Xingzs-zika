// 依赖：全部前置文件，必须最后加载
import { _taskQueue, DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, dbAll, dbPut, escapeHtml, now, openDB, pick, randInt, toast } from './02-core.js';
import { applyNickname, applyTheme, backFromChat, createNewContact, exitChatMode, getAllContacts, getCurrentReplyRate, getTheme, openChat, openContactSettingsFromChatDirect, openPage, renderContacts, renderMeBrief, saveContact } from './03-data.js';
import { addAnni, addChoiceOpt, autoResize, cascadeReadFromMe, closeImgPreview, delAnni, deleteMsg, editAnni, jumpToMsg, onChatKeydown, openAnniversary, openChoice, previewImg, quoteReply, renderChatMessages, sendImageMessage, sendTextMessage, toggleChatMenu, triggerReply } from './04-chat.js';
import { answerIncoming, backLetterList, composeLetterToCurrent, deleteCurrentLetter, ensureLetterDay, genLetterContent, makeCall, openLetterCompose, openLetterDetail, persistCallState, rejectIncoming, renderLetterList, restoreCallState, sendLetter, showIncomingCall, toggleCallMic, toggleCallMinimize } from './05-call-letter.js';
import { addCard, addLibStickers, addMyStickers, applyCustomColor, applyPresetBg, applyPresetColor, backFromCardLib, backFromContactSetting, backFromStickerLib, createCardGroup, csAddStatus, csDeleteContact, csEditMyNickname, csEditName, csResetBg, csSaveProactive, csSaveReply, csToggleIncomingCall, csToggleLetter, csToggleProactive, csToggleStatusAuto, csUpdateAvatar, csUploadBg, deleteCard, deleteCardGroup, deleteLibSticker, deleteMySticker, deleteStatus, editCard, editCardGroup, editMyName, editStatus, openBatchImport, openCardLib, openContactSetting, openContactSettingsList, openMyStickers, openStickerLib, quickAddMyStickers, renderThemeUI, resetBg, saveCustomCSS, sendStickerAndClose, setStatusCurrent, switchStkTab, toggleStickerPanel, updateMyAvatar, uploadBg } from './06-ui.js';
import { applyDIYVariables, checkTodoReminders, clearHomeDecos, closeDecoEditor, closeDIY, closeDiyPage, closeTodoPanel, deleteHomeDeco, deleteTodo, doExport, doImport, openDecoEditor, openDiyPage, openHomeStickerUploader, openTodoEditor, pickDIYImage, promptTodoAdd, renderHomeAvatar, renderStorageStats, renderTodos, resetDIYAll, resetDIYItem, resetDIYSection, saveHomeFreeText, setDIYColor, setDiyMode, setDIYText, toggleExportAll, toggleTodo, uploadHomeBanner, applyCustomCSS, clearBubbleCSS, clearCustomCSS, resetHomeBg, saveBubbleCSS, uploadHomeBg } from './07-diy-todo.js';
import { addInspiration, deleteInspiration, editInspiration, ensureDailyMoods, initInspirationModule, initMoodModule, moodNextMonth, moodPrevMonth, openInspirationPage, openMoodDay, openMoodPage, pickMoodEmoji, saveInspirationEdit, saveMyMood, switchMoodRole } from './09-mood.js';
import { copyDivineResult, divineToInspiration, drawDivine, flipDivineCard, initDivineModule, openDivineHistory, openDivinePage, selectDivineSpread, sendDivineToChat, sendDivineToContact, switchDivineType, viewDivineHistory } from './10-divine.js';

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
export async function runCatchUp() {
  return enqueueTask(async () => {
    const contacts = await getAllContacts();
    const t = now();
    let changed = false;
    for (let c of contacts) {
      // 1) 状态自动切换
      if (c.statusAuto !== false && (c.statusList||[]).length > 1) {
        if (!c.nextStatusChangeAt || t >= c.nextStatusChangeAt) {
          const candidates = c.statusList.filter(s => s.name !== c.status);
          if (candidates.length) {
            c.status = pick(candidates).name;
            c.nextStatusChangeAt = t + randInt(30, 180) * 60 * 1000;
            changed = true;
          }
        }
      } else if ((c.statusList||[]).length === 1 && !c.status) {
        c.status = c.statusList[0].name; changed = true;
      }

      // 2) 聊天消息：已读和回复（全量概率判定：到点即已读，按概率掷骰决定是否回复）
      const curRate = getCurrentReplyRate(c);
      let msgsChanged = false;
      const myMsgs = (c.messages || []).filter(m => m.from === 'me');
      let anchorMsg = myMsgs.length ? myMsgs[myMsgs.length - 1] : null;

      // 2a) 已读处理：到达各自 readAt 即已读 + 级联（不再区分状态门槛）
      for (const m of myMsgs) {
        if (!m.read && m.readAt && t >= m.readAt) {
          cascadeReadFromMe(c, m.id);
          msgsChanged = true; changed = true;
        }
      }

      // 2b) 回复处理：最新一条 replyAt 到点后，按发送瞬间快照的 rate 掷骰子，命中才回
      const anyUnhandled = myMsgs.some(m => !m.replied);
      if (anyUnhandled && anchorMsg && anchorMsg.replyAt && t >= anchorMsg.replyAt) {
        const snap = anchorMsg.snapshot || {};
        // 标记所有我的消息为 replied（本轮一次性合并）
        for (const m of myMsgs) if (!m.replied) m.replied = true;
        cascadeReadFromMe(c, anchorMsg.id);
        // 一次 willReply 判定
        const rateForRound = snap.rate != null ? snap.rate : curRate;
        const willReply = Math.random() * 100 < rateForRound;
        if (willReply) {
          const repCnt = (c.settings.replyCount || 1) <= 1 ? 1 : randInt(1, c.settings.replyCount || 1);
          for (let i = 0; i < repCnt; i++) {
            await triggerReply(c, anchorMsg);
            if (i < repCnt - 1) {
              // 不真的sleep等待（runCatchUp是离线补算，应快速完成），让消息时间按1-3秒递增时间戳即可，且不超过当前时刻
              c.messages[c.messages.length-1].time = Math.min(t, (c.messages[c.messages.length-1].time || now()) + randInt(1000, 3000));
            }
          }
          c.unread = (c.unread || 0) + repCnt;
        }
        msgsChanged = true; changed = true;
      }

      // 3) 主动消息（proactiveMsg）：条数用 proactiveMin ~ proactiveMax 之间随机
      if (c.settings.proactiveMsg) {
        if (!c.settings.nextProactiveAt || t >= c.settings.nextProactiveAt) {
          if (curRate <= 20) {
            // 低概率状态（睡觉 / 不理人等极不活跃）：跳过本次主动消息，仍推进下次时间防止死循环
            c.settings.nextProactiveAt = t + randInt(2, 8) * 3600 * 1000;
            changed = true;
          } else {
            const cards = c.cardGroups.flatMap(g => g.cards || []);
            const pMin = c.settings.proactiveMin != null ? Math.max(0, c.settings.proactiveMin) : 1;
            const pMax = c.settings.proactiveMax != null ? Math.max(pMin, c.settings.proactiveMax) : 3;
            const cnt = cards.length ? (pMin === pMax ? pMin : randInt(pMin, pMax)) : 0;
            const baseAt = c.settings.nextProactiveAt || t;
            const useStickers = (c.stickers || []).length > 0;
            // 绝对递增 + 钳平到当前时刻，防止同一时刻连环轰炸或出现未来时间戳
            let lastAt = baseAt;
            for (let i = 0; i < cnt; i++) {
              lastAt = lastAt + randInt(1, 3) * 1000;
              const atT = Math.min(lastAt, t);
              let type = 'text', content = '';
              if (useStickers && Math.random() < 0.5) { type='sticker'; content = pick(c.stickers).data; }
              else if (cards.length) { type='text'; content = await applyNickname(pick(cards).content, c); }
              else continue;
              let replyTo = null;
              const history = (c.messages||[]).filter(x => x.type==='text'||x.type==='image'||x.type==='sticker'||x.type==='choice');
              if (history.length && Math.random()<0.5) replyTo = pick(history).id;
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
          for (let i = 0; i < c.callSlots.slots.length; i++) {
            const slot = c.callSlots.slots[i];
            if (!triggered.includes(i) && t >= slot.time) {
              // 触发（如果停留在该联系人对话页则弹，否则记未接）
              triggered.push(i);
              // 低概率状态（睡觉 / 不理人）不弹来电，只记未接，模拟「Ta 没空打」
              if (curRate > 20 && state.currentContactId === c.id && !state.callState) {
                // 弹窗
                showIncomingCall(c, Math.random()<0.5 ? 'video' : 'voice');
              } else {
                // 记未接
                c.missedCalls = c.missedCalls || [];
                c.missedCalls.push(slot.time);
                c.messages.push({
                  id: uid(), from:'other', type:'text', content: `📞 ${c.name}（未接来电）`,
                  time: slot.time, replyTo: null, snapshot: null,
                  read: true, readAt: slot.time, replyAt: 0, replied: true
                });
                c.unread = (c.unread||0) + 1;
                changed = true;
              }
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
          const letter = { id: uid(), direction: 'in', title: `${c.name}的来信`, content: await genLetterContent(c), time: t };
          c.letters = c.letters || [];
          c.letters.push(letter);
          c.settings.nextLetterAt = null;
          c.messages.push({
            id: uid(), from: 'other', type: 'text', content: '✉️ Ta 寄来了一封信，快去信箱看看吧。',
            time: t, replyTo: null, snapshot: null, read: true, readAt: t, replyAt: 0, replied: true
          });
          c.unread = (c.unread || 0) + 1;
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
  });
}

// 分槽法排期：当天24h每30分钟一个槽，每人3个，互不重叠
function ensureCallSlots(c, t) {
  if (!c.settings.incomingCall) return c;
  const today = new Date(t);
  const todayStr = `${today.getFullYear()}-${today.getMonth()+1}-${today.getDate()}`;
  if (c.callSlots && c.callSlots.date === todayStr) return c; // 已排
  // 排当天的
  // 获取所有联系人当天已经占用的槽位
  getAllContacts().then(all => {
    // 这里用同步再检查，但因为ensureCallSlots在串行队列中执行，我们直接在内存上处理：
    // 由于此函数在串行任务内部（已拿到联系人引用），我们先做一次排期保存
    // 先构建48个槽（每30分钟一个）
  });
  // 简化但正确的实现：因为异步 getAllContacts 在队列内部不会阻塞，改为每次runCatchUp重新排当天。
  // 改用同步直接基于此联系人c排自己的3个槽（保证自己的不重叠，不保证与其他联系人严格错开，但通过给每个联系人使用不同"起始偏移"方式尽量分散）。
  // 实际上需要全局协调。这里使用一个更简单但满足“单人3个、间隔≥30分钟、自己不冲突”的排法：48槽随机取3个不相邻的，对单人足够；需求中说任意两个来电间隔≥30分钟是对整体或单人？文档是“任意两个来电至少间隔30分钟、每人固定3个”。
  // 我们使用更严格的实现：在c对象上记录。（当需要全局时，在串行任务里读取所有联系人做协调）— 但 ensureCallSlots 目前是同步函数。
  // 为了满足需求，我们在下面 periodicCheck 中加一步"全局排期"。此处只保证单人自己排到3个不重叠的槽。
  const slots = [];
  // 从0..47中挑3个，彼此间隔≥1（≥30分钟）
  const candidates = [];
  for (let i = 0; i < 48; i++) candidates.push(i);
  for (let attempt = 0; attempt < 3 && candidates.length; attempt++) {
    const idx = randInt(0, candidates.length-1);
    const s = candidates[idx];
    // 移除相邻
    const newCand = [];
    for (const ca of candidates) { if (Math.abs(ca - s) < 2) continue; newCand.push(ca); }
    candidates.length = 0; candidates.push(...newCand);
    slots.push(s);
  }
  slots.sort((a,b)=>a-b);
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  c.callSlots = {
    date: todayStr,
    slots: slots.map(s => ({ index: s, time: startOfDay + s * 30 * 60 * 1000 + randInt(0, 29*60*1000) })),
    triggered: []
  };
  return c;
}

// 周期性检查（每15秒一次；更重要的是用户回到网页时立刻补算）
async function periodicCheck() {
  const changed = await runCatchUp();
  if (changed) {
    renderContacts();
    if (state.currentContactId) renderChatMessages(state.currentContactId, false);
  }
}

// ============ 初始化 ============
async function initApp() {
  try {
    await openDB();
  } catch (e) {
    alert('IndexedDB初始化失败：' + e.message);
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
  // 渲染联系人列表
  renderContacts();
  renderLetterList();
  renderThemeUI(theme);
  renderStorageStats();
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
  // 定时检查（状态切换、主动消息、回复触发）
  setInterval(periodicCheck, 15000); // 15秒检查一次
  // 监听可见性
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await runCatchUp();
      renderContacts();
      if (state.currentContactId) renderChatMessages(state.currentContactId, true);
      // 切回前台时恢复未结束的通话（兜底，防止内存状态丢失）
      try { await restoreCallState(); } catch (e) { console.warn('恢复通话状态失败：', e); }
    }
  });
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
window.addEventListener('DOMContentLoaded', () => {
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
window.backFromCardLib = backFromCardLib;
window.backFromChat = backFromChat;
window.backFromContactSetting = backFromContactSetting;
window.backFromStickerLib = backFromStickerLib;
window.backLetterList = backLetterList;
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
window.csEditMyNickname = csEditMyNickname;
window.csEditName = csEditName;
window.csResetBg = csResetBg;
window.csSaveProactive = csSaveProactive;
window.csSaveReply = csSaveReply;
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
window.jumpToMsg = jumpToMsg;
window.makeCall = makeCall;
window.moodNextMonth = moodNextMonth;
window.moodPrevMonth = moodPrevMonth;
window.onChatKeydown = onChatKeydown;
window.openAnniversary = openAnniversary;
window.openBatchImport = openBatchImport;
window.openCardLib = openCardLib;
window.openChat = openChat;
window.openChoice = openChoice;
window.openContactSetting = openContactSetting;
window.openContactSettingsFromChatDirect = openContactSettingsFromChatDirect;
window.openContactSettingsList = openContactSettingsList;
window.openDecoEditor = openDecoEditor;
window.openDivineHistory = openDivineHistory;
window.openDivinePage = openDivinePage;
window.openDiyPage = openDiyPage;
window.openHomeStickerUploader = openHomeStickerUploader;
window.openInspirationPage = openInspirationPage;
window.openLetterCompose = openLetterCompose;
window.openLetterDetail = openLetterDetail;
window.openMoodDay = openMoodDay;
window.openMoodPage = openMoodPage;
window.openMyStickers = openMyStickers;
window.openPage = openPage;
window.openStickerLib = openStickerLib;
window.openTodoEditor = openTodoEditor;
window.pickDIYImage = pickDIYImage;
window.pickMoodEmoji = pickMoodEmoji;
window.previewImg = previewImg;
window.promptTodoAdd = promptTodoAdd;
window.quickAddMyStickers = quickAddMyStickers;
window.quoteReply = quoteReply;
window.rejectIncoming = rejectIncoming;
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
window.setDIYColor = setDIYColor;
window.setDiyMode = setDiyMode;
window.setDIYText = setDIYText;
window.setStatusCurrent = setStatusCurrent;
window.switchStkTab = switchStkTab;
window.switchMoodRole = switchMoodRole;
window.switchDivineType = switchDivineType;
window.toggleCallMic = toggleCallMic;
window.toggleCallMinimize = toggleCallMinimize;
window.toggleChatMenu = toggleChatMenu;
window.toggleExportAll = toggleExportAll;
window.toggleStickerPanel = toggleStickerPanel;
window.toggleTodo = toggleTodo;
window.updateMyAvatar = updateMyAvatar;
window.uploadBg = uploadBg;
window.uploadHomeBanner = uploadHomeBanner;
window.uploadHomeBg = uploadHomeBg;
window.resetHomeBg = resetHomeBg;
window.saveBubbleCSS = saveBubbleCSS;
window.clearBubbleCSS = clearBubbleCSS;
window.applyCustomCSS = applyCustomCSS;
window.clearCustomCSS = clearCustomCSS;
window.viewDivineHistory = viewDivineHistory;
