// 依赖：01-state.js / 02-core.js / 03-data.js / 04-chat.js
import { DEFAULT_AVATAR, state, uid } from './01-state.js';
import { $, closeModal, confirmDialog, dbDel, dbGet, dbPut, escapeHtml, now, pick, randInt, showModal, toast } from './02-core.js';
import { backFromApp, getAllContacts, getContact, openPage, saveContact } from './03-data.js';
import { renderChatMessages } from './04-chat.js';

/* ============ 本地音乐（纯本地文件，空盒子形态） ============
   索引： meta.music_index_v1  = { k, list:[{ id, name, size, addTime }] }
   音频： meta.music_track_<id> = { k, id, name, blob }   // Blob 直接存 IndexedDB
   设置： meta.music_settings_v1 = { k, volume, loop }
   播放时用 objectURL 重建，切歌/返回/删除/关页时立刻 revoke，避免 URL 泄漏。 */

const INDEX_KEY = 'music_index_v1';
const SETTINGS_KEY = 'music_settings_v1';
const TOGETHER_KEY = 'music_together_v1';
const PERSIST_KEY = 'storage_persist_v1';
const WARN_KEY = 'storage_warned_v1';

let _index = [];
let _currentId = null;
let _url = null;
let _loop = false;
let _inited = false;
let _volTimer = null;
let _seekHoldUntil = 0;
let _importHideTimer = null;
let _switching = false; // 自动连播切歌中：暂停/播放事件不驱动迷你条显隐，避免闪动
// 一起听状态：{ active:{contactId, since, trackId, inviteMsgId}|null, nextInviteAt }
let _together = { active: null, nextInviteAt: 0 };
let _togetherLoaded = false;

async function getIndex() {
  const r = await dbGet('meta', INDEX_KEY);
  return (r && Array.isArray(r.list)) ? r.list : [];
}
async function saveIndex(list) { await dbPut('meta', { k: INDEX_KEY, list }); }
function trackKey(id) { return 'music_track_' + id; }

function audioEl() { return $('music-audio'); }

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtSize(bytes) {
  if (!bytes) return '未知大小';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
// 曲库字节数：只累加索引里记录的 size，不读取任何 Blob
function audioBytes() {
  let total = 0;
  for (const t of _index) {
    const n = Number(t && t.size);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}
// 音乐占用的统一口径（音乐页与设置页共用，保证两个数字对得上）
function fmtAudioSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
// 通用容量格式化，缺字段一律「未知」，不出现 NaN/undefined
function fmtBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function renderMusicStorage() {
  const el = $('music-storage-line'); if (!el) return;
  el.textContent = `${_index.length} 首 · 共 ${fmtAudioSize(audioBytes())}`;
}

/* ============ 页面入口 / 返回 ============ */
export async function openMusicPage() {
  _index = await getIndex();
  if (!_togetherLoaded) await loadTogether();
  renderMusicShelf();
  renderMusicStorage();
  openPage('page-music');
  if (_currentId && _index.some(t => t.id === _currentId)) {
    const t = _index.find(x => x.id === _currentId);
    const a = audioEl();
    setNow(t.name, '本地音频');
    // 恢复现场：进度、播放/暂停状态都保持原样
    if (a) updateProgress(a.currentTime, a.duration);
    updatePlayBtn();
  } else {
    setNow('未播放', '从本地导入音频开始播放');
    updateProgress(0, 0);
  }
  renderTogetherBar();
  renderGlobalStorage().catch(() => {});
}
export function musicBack() {
  // 只是收起界面，不暂停、不退场、不释放 objectURL
  // A25：回到进入前的那一页；桌面兜底到聊天区，避免落到被隐藏的手机首页
  backFromApp();
}

/* ============ 导入本地音频 ============ */
// 一次可多选；逐个写入 IndexedDB，逐个更新进度，单个失败不影响其余文件
export async function musicPickFiles(input) {
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  if (!files.length) return;
  const box = $('music-import-status'), text = $('music-import-text'), fill = $('music-import-fill');
  clearTimeout(_importHideTimer);
  if (box) box.classList.remove('hide');
  if (fill) fill.style.width = '0%';
  if (text) text.textContent = `准备导入 ${files.length} 个文件…`;
  let added = 0, failed = 0, skipped = 0;
  const total = files.length;
  for (let i = 0; i < total; i++) {
    const file = files[i];
    if (text) text.textContent = `正在导入 ${i + 1}/${total}：${file.name}`;
    if (fill) fill.style.width = (i / total * 100).toFixed(0) + '%';
    // 让出主线程，保证进度条能实际绘制，界面不冻结
    await new Promise(r => setTimeout(r, 0));
    const isAudio = /^audio\//i.test(file.type || '') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma)$/i.test(file.name || '');
    if (!isAudio) {
      skipped++;
    } else {
      const id = uid();
      const name = (file.name || '未命名音频').replace(/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma)$/i, '');
      try {
        await dbPut('meta', { k: trackKey(id), id, name, blob: file });
        _index.push({ id, name, size: file.size || 0, addTime: now() });
        added++;
        // 每成功一首就落一次索引，批量导入中途失败也不会丢已完成的歌
        await saveIndex(_index);
      } catch (e) {
        console.warn('音频保存失败：', e);
        failed++;
      }
    }
    if (fill) fill.style.width = ((i + 1) / total * 100).toFixed(0) + '%';
  }
  if (fill) fill.style.width = '100%';
  if (text) text.textContent = `导入完成：新增 ${added} 首${failed ? ` · 失败 ${failed} 首` : ''}${skipped ? ` · 跳过 ${skipped} 个非音频文件` : ''}`;
  _importHideTimer = setTimeout(() => { if (box) box.classList.add('hide'); }, 2600);
  renderMusicShelf();
  renderMusicStorage();
  renderGlobalStorage().catch(() => {});
  if (added) toast(`已导入 ${added} 首本地音乐`);
  else if (failed) toast('导入失败，请重试');
}

/* ============ 播放列表 ============ */
export function renderMusicShelf() {
  const box = $('music-shelf');
  if (!box) return;
  if (!_index.length) {
    box.innerHTML = `<div class="music-empty">
      <svg class="i"><use href="#icon-music"/></svg>
      还没有歌曲<br>
      点右上角导入本地音频文件<br>
      <span style="font-size:11px;opacity:.75;">音频只保存在本机浏览器（IndexedDB），不上传、不联网</span>
    </div>`;
    return;
  }
  box.innerHTML = _index.map(t => {
    const playing = t.id === _currentId;
    return `<div class="music-track${playing ? ' playing' : ''}" onclick="musicPlayId('${t.id}')">
      <div class="music-track-cover"><svg class="i"><use href="#icon-music"/></svg></div>
      <div class="music-track-info">
        <div class="music-track-name">${escapeHtml(t.name)}</div>
        <div class="music-track-meta">${fmtSize(t.size)}${playing ? ' · 播放中' : ' · 本地音频'}</div>
      </div>
      <button class="music-track-del" onclick="event.stopPropagation();musicDelete('${t.id}')" title="删除本地歌曲">
        <svg class="i i-sm"><use href="#icon-trash"/></svg>
      </button>
    </div>`;
  }).join('');
}

/* ============ 一起听（最小形态：联系人不发言） ============ */
async function loadTogether() {
  try {
    const r = await dbGet('meta', TOGETHER_KEY);
    _together = {
      active: (r && r.active) ? r.active : null,
      nextInviteAt: Number(r && r.nextInviteAt) || 0
    };
  } catch (e) {
    _together = { active: null, nextInviteAt: 0 };
  }
  _togetherLoaded = true;
}
async function saveTogether() {
  await dbPut('meta', { k: TOGETHER_KEY, active: _together.active, nextInviteAt: _together.nextInviteAt });
}
async function renderTogetherBar() {
  const bar = $('music-together-bar'); if (!bar) return;
  if (!_together.active) { bar.classList.add('hide'); return; }
  const contacts = await getAllContacts();
  const c = contacts.find(x => x.id === _together.active.contactId);
  if (!c) { await markActiveInviteEnded(); return; }
  bar.classList.remove('hide');
  const av = $('music-together-avatar'); if (av) av.src = c.avatar || DEFAULT_AVATAR;
  const nm = $('music-together-name'); if (nm) nm.textContent = `${c.name} 和你一起听`;
  const sub = $('music-together-sub');
  const tr = _index.find(t => t.id === _together.active.trackId);
  if (sub) sub.textContent = tr ? `《${tr.name}》` : '一起听';
}
// 结束一起听：把聊天里的邀请卡标成已结束，并清掉状态（不暂停当前播放）
async function markActiveInviteEnded() {
  const a = _together.active;
  if (!a) return;
  try {
    const c = await getContact(a.contactId);
    if (c && a.inviteMsgId) {
      const m = (c.messages || []).find(x => x.id === a.inviteMsgId);
      if (m && m.type === 'musicInvite') {
        m.musicInvite = m.musicInvite || {};
        m.musicInvite.status = 'ended';
        await saveContact(c);
        if (state.currentContactId === c.id) renderChatMessages(c.id, true);
      }
    }
  } catch (e) { console.warn('结束一起听失败：', e); }
  _together.active = null;
  if (!_together.nextInviteAt || _together.nextInviteAt < now()) {
    _together.nextInviteAt = now() + randInt(4, 12) * 3600 * 1000;
  }
  await saveTogether();
  await renderTogetherBar();
}
// 开始一起听后，把其它仍在等待的邀请一并作废，避免残留多条 pending
async function rejectOtherPendingInvites(keepMsgId) {
  try {
    const contacts = await getAllContacts();
    for (const c of contacts) {
      let changed = false;
      for (const m of (c.messages || [])) {
        if (m.type === 'musicInvite' && m.musicInvite && m.musicInvite.status === 'pending' && m.id !== keepMsgId) {
          m.musicInvite.status = 'rejected';
          changed = true;
        }
      }
      if (changed) await saveContact(c);
    }
  } catch (e) { console.warn('清理邀请失败：', e); }
}

export async function musicOpenTogetherPicker() {
  if (!_index.length) return toast('先导入一首本地音乐');
  if (_together.active) return toast('已经在和联系人一起听');
  const contacts = await getAllContacts();
  if (!contacts.length) return toast('先添加一位联系人');
  const body = `<div class="together-pick-list">` + contacts.map(c =>
    `<button class="together-pick-item" onclick="closeModal();musicStartTogether('${c.id}')">
      <img src="${escapeHtml(c.avatar || DEFAULT_AVATAR)}" alt="">
      <span>${escapeHtml(c.name)}</span>
    </button>`).join('') +
    `</div><div class="together-pick-tip">也可以等对方在聊天里发来邀请。</div>`;
  showModal('和谁一起听', body);
}

export async function musicStartTogether(contactId) {
  closeModal();
  const c = await getContact(contactId);
  if (!c) return toast('联系人不存在');
  if (!_index.length) return toast('先导入一首本地音乐');
  const track = _index.find(t => t.id === _currentId) || _index[0];
  const ts = now();
  const msg = {
    id: uid(), from: 'me', type: 'musicInvite', content: '', time: ts,
    replyTo: null, snapshot: null, read: true, readAt: ts, replyAt: 0, replied: true,
    musicInvite: { status: 'accepted', trackId: track.id, trackName: track.name }
  };
  c.messages = c.messages || [];
  c.messages.push(msg);
  await saveContact(c);
  _together.active = { contactId: c.id, since: ts, trackId: track.id, inviteMsgId: msg.id };
  await saveTogether();
  await rejectOtherPendingInvites(null);
  if (_currentId !== track.id || !_url) await loadTrack(track, true);
  else {
    const a = audioEl();
    if (a && a.paused) { try { await a.play(); } catch (e) {} }
  }
  await renderTogetherBar();
  renderMusicShelf();
  if (state.currentContactId === c.id) renderChatMessages(c.id, true);
  toast(`已和 ${c.name} 一起听`);
}

export async function musicAcceptInvite(contactId, msgId) {
  const c = await getContact(contactId);
  if (!c) return toast('联系人不存在');
  const m = (c.messages || []).find(x => x.id === msgId);
  if (!m || m.type !== 'musicInvite' || !m.musicInvite || m.musicInvite.status !== 'pending') return;
  _index = await getIndex();
  const track = _index.find(t => t.id === m.musicInvite.trackId) || _index[0];
  if (!track) { toast('歌曲已被删除，无法一起听'); return; }
  m.musicInvite.status = 'accepted';
  m.musicInvite.trackId = track.id;
  m.musicInvite.trackName = track.name;
  await saveContact(c);
  const ts = now();
  _together.active = { contactId: c.id, since: ts, trackId: track.id, inviteMsgId: m.id };
  await saveTogether();
  await rejectOtherPendingInvites(m.id);
  if (_currentId !== track.id || !_url) await loadTrack(track, true);
  else {
    const a = audioEl();
    if (a && a.paused) { try { await a.play(); } catch (e) {} }
  }
  await renderTogetherBar();
  await openMusicPage();
  if (state.currentContactId === c.id) renderChatMessages(c.id, true);
  toast(`和 ${c.name} 一起听《${track.name}》`);
}

export async function musicRejectInvite(contactId, msgId) {
  const c = await getContact(contactId);
  if (!c) return;
  const m = (c.messages || []).find(x => x.id === msgId);
  if (!m || m.type !== 'musicInvite' || !m.musicInvite || m.musicInvite.status !== 'pending') return;
  m.musicInvite.status = 'rejected';
  await saveContact(c);
  if (state.currentContactId === c.id) renderChatMessages(c.id, true);
  toast('已拒绝一起听邀请');
}

export async function musicExitTogether() {
  if (!_together.active) return;
  await markActiveInviteEnded();
  renderMusicShelf();
  toast('已退出一起听');
}

/* ============ 存储状态（全应用：设置页展示；音乐占用：音乐页展示） ============ */
export async function requestPersistStorage() {
  if (!(navigator.storage && typeof navigator.storage.persist === 'function')) return;
  try {
    let granted = false;
    try { granted = await navigator.storage.persisted(); } catch (e) {}
    if (!granted) {
      try { granted = await navigator.storage.persist(); } catch (e) { granted = false; }
    }
    try { await dbPut('meta', { k: PERSIST_KEY, granted: !!granted, at: now() }); } catch (e) {}
    await renderPersistStatus();
  } catch (e) {
    console.warn('申请持久化存储失败：', e);
  }
}
async function renderPersistStatus() {
  const el = $('ss-persist'); if (!el) return;
  if (!(navigator.storage && typeof navigator.storage.persisted === 'function')) {
    el.textContent = '持久化存储：未知';
    return;
  }
  try {
    const granted = await navigator.storage.persisted();
    el.textContent = '持久化存储：' + (granted ? '已开启' : '未授予');
  } catch (e) {
    el.textContent = '持久化存储：未知';
  }
}
async function maybeWarnStorage(ratio) {
  const note = $('ss-storage-note'); if (!note) return;
  if (!Number.isFinite(ratio) || ratio < 0.8) { note.classList.add('hide'); return; }
  let warned = false;
  try { warned = !!(await dbGet('meta', WARN_KEY)); } catch (e) {}
  if (warned) { note.classList.add('hide'); return; }
  note.textContent = '存储空间已接近上限，可删除部分本地音乐或导出备份。';
  note.classList.remove('hide');
  try { await dbPut('meta', { k: WARN_KEY, at: now() }); } catch (e) {}
}
export async function renderGlobalStorage() {
  const quotaEl = $('ss-quota');
  if (quotaEl) {
    let music = audioBytes();
    try {
      const idx = await getIndex();
      music = idx.reduce((sum, t) => {
        const n = Number(t && t.size);
        return sum + (Number.isFinite(n) && n > 0 ? n : 0);
      }, 0);
    } catch (e) {}
    const musicNote = `（其中音乐 ${fmtAudioSize(music)}）`;
    if (!(navigator.storage && typeof navigator.storage.estimate === 'function')) {
      quotaEl.textContent = '存储用量：未知（当前浏览器不支持）' + musicNote;
    } else {
      try {
        const est = await navigator.storage.estimate();
        const used = Number(est && est.usage);
        const quota = Number(est && est.quota);
        if (!Number.isFinite(used)) {
          quotaEl.textContent = '存储用量：未知' + musicNote;
        } else if (Number.isFinite(quota) && quota > 0) {
          quotaEl.textContent = `存储用量：已用 ${fmtBytes(used)} / 配额 ${fmtBytes(quota)}${musicNote}`;
          await maybeWarnStorage(used / quota);
        } else {
          quotaEl.textContent = `存储用量：已用 ${fmtBytes(used)} / 配额 未知${musicNote}`;
        }
      } catch (e) {
        quotaEl.textContent = '存储用量：未知' + musicNote;
      }
    }
  }
  await renderPersistStatus();
}

/* ============ 联系人来信式的「一起听」邀请（周期生成，频率自然） ============ */
export async function checkTogetherInvites() {
  if (!_togetherLoaded) await loadTogether();
  if (_together.active) return false;
  const t = now();
  if (!_together.nextInviteAt) {
    // 首次运行不立刻打扰，先排一个自然的时间窗
    _together.nextInviteAt = t + randInt(4, 12) * 3600 * 1000;
    await saveTogether();
    return false;
  }
  if (t < _together.nextInviteAt) return false;
  _together.nextInviteAt = t + randInt(4, 12) * 3600 * 1000;
  await saveTogether();
  if (!_index.length) {
    try { _index = await getIndex(); } catch (e) {}
  }
  if (!_index.length) return false;
  const contacts = await getAllContacts();
  if (!contacts.length) return false;
  // 已有待处理邀请时不叠加，保证一次只处理一个
  const hasPending = contacts.some(c => (c.messages || []).some(m =>
    m.type === 'musicInvite' && m.musicInvite && m.musicInvite.status === 'pending'));
  if (hasPending) return false;
  const c = pick(contacts);
  const track = pick(_index);
  const ts = now();
  c.messages = c.messages || [];
  c.messages.push({
    id: uid(), from: 'other', type: 'musicInvite', content: '', time: ts,
    replyTo: null, snapshot: null, read: false, readAt: 0, replyAt: 0, replied: true,
    musicInvite: { status: 'pending', trackId: track.id, trackName: track.name }
  });
  c.unread = (c.unread || 0) + 1;
  await saveContact(c);
  if (state.currentContactId === c.id) renderChatMessages(c.id, true);
  toast(`${c.name}想和你一起听《${track.name}》`);
  return true;
}

function setNow(title, sub) {
  const a = $('music-now-title'); if (a) a.textContent = title || '未播放';
  const b = $('music-now-sub'); if (b) b.textContent = sub || '本地音频';
}
function updatePlayBtn() {
  const btn = $('music-play-btn');
  if (!btn) return;
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', audioEl() && !audioEl().paused ? '#icon-pause' : '#icon-play');
}
// 退出音乐页后仍有播放时，显示细的迷你播放条；暂停/结束自动收起
export function updateMusicMiniBar() {
  const bar = $('music-mini'); if (!bar) return;
  if (_switching) return; // 切歌过程中保持当前显隐状态
  const a = audioEl();
  const playing = !!(_currentId && a && !a.paused);
  const musicPageActive = !!($('page-music') && $('page-music').classList.contains('active'));
  const show = playing && !musicPageActive;
  bar.classList.toggle('hide', !show);
  document.body.classList.toggle('music-mini-on', show);
  if (!show) return;
  const t = _index.find(x => x.id === _currentId);
  const title = $('music-mini-title'); if (title) title.textContent = t ? t.name : '正在播放';
  const use = $('music-mini-icon'); if (use) use.setAttribute('href', '#icon-pause');
}
function updateProgress(cur, dur) {
  const seek = $('music-seek');
  if (seek && Date.now() > _seekHoldUntil) {
    seek.value = dur > 0 ? String(Math.round(cur / dur * 1000)) : '0';
  }
  const c = $('music-cur'); if (c) c.textContent = fmtTime(cur);
  const d = $('music-dur'); if (d) d.textContent = fmtTime(dur);
}

/* ============ 播放控制 ============ */
function revokeUrl() {
  const a = audioEl();
  if (a) { try { a.pause(); } catch (e) {} a.removeAttribute('src'); }
  if (_url) { try { URL.revokeObjectURL(_url); } catch (e) {} _url = null; }
}
function stopAndRevoke() {
  const a = audioEl();
  if (a) { try { a.pause(); a.currentTime = 0; } catch (e) {} }
  revokeUrl();
}
async function loadTrack(t, autoplay) {
  if (!t) return;
  const rec = await dbGet('meta', trackKey(t.id));
  if (!rec || !rec.blob) { toast('音频数据缺失，请重新导入'); return; }
  revokeUrl();
  _url = URL.createObjectURL(rec.blob);
  _currentId = t.id;
  // 一起听期间换歌：同步当前曲目，界面副标题跟着更新
  if (_together.active) {
    _together.active.trackId = t.id;
    saveTogether().catch(() => {});
    renderTogetherBar();
  }
  const a = audioEl();
  if (!a) return;
  a.loop = _loop;
  a.src = _url;
  a.load();
  setNow(t.name, '本地音频');
  renderMusicShelf();
  updateProgress(0, 0);
  if (autoplay) {
    try { await a.play(); } catch (e) { toast('无法播放该音频（浏览器可能不支持该格式）'); }
  }
  updatePlayBtn();
}

export async function musicPlayId(id) {
  const t = _index.find(x => x.id === id);
  if (!t) return;
  if (_currentId === id && _url) {
    const a = audioEl();
    if (!a) return;
    if (a.paused) { try { await a.play(); } catch (e) {} }
    else a.pause();
    updatePlayBtn();
    renderMusicShelf();
    return;
  }
  await loadTrack(t, true);
}

export async function musicTogglePlay() {
  if (!_index.length) return toast('先导入一首本地音乐');
  const a = audioEl();
  if (!a) return;
  if (!_currentId) {
    await loadTrack(_index[0], true);
    return;
  }
  if (!_url) { const t = _index.find(x => x.id === _currentId) || _index[0]; await loadTrack(t, true); return; }
  if (a.paused) { try { await a.play(); } catch (e) {} }
  else a.pause();
  updatePlayBtn();
  renderMusicShelf();
}

export async function musicPrev() {
  if (!_index.length) return;
  const i = Math.max(0, _index.findIndex(t => t.id === _currentId));
  const prev = _index[(i - 1 + _index.length) % _index.length];
  await loadTrack(prev, true);
}
export async function musicNext() {
  if (!_index.length) return;
  const i = Math.max(0, _index.findIndex(t => t.id === _currentId));
  const next = _index[(i + 1) % _index.length];
  await loadTrack(next, true);
}

export function musicSeek(v) {
  const a = audioEl();
  if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
  _seekHoldUntil = Date.now() + 800;
  a.currentTime = (Number(v) || 0) / 1000 * a.duration;
  updateProgress(a.currentTime, a.duration);
}

export function musicSetVolume(v) {
  const a = audioEl();
  if (!a) return;
  a.volume = Math.max(0, Math.min(1, (Number(v) || 0) / 100));
  clearTimeout(_volTimer);
  _volTimer = setTimeout(() => {
    dbPut('meta', { k: SETTINGS_KEY, volume: a.volume, loop: _loop }).catch(() => {});
  }, 500);
}

export async function musicToggleLoop() {
  _loop = !_loop;
  const a = audioEl();
  if (a) a.loop = _loop;
  $('music-loop-btn') && $('music-loop-btn').classList.toggle('on', _loop);
  try { await dbPut('meta', { k: SETTINGS_KEY, volume: a ? a.volume : 0.7, loop: _loop }); } catch (e) {}
  toast(_loop ? '已开启单曲循环' : '已关闭单曲循环');
}

export async function musicDelete(id) {
  const t = _index.find(x => x.id === id);
  if (!t) return;
  if (!await confirmDialog(`删除本地歌曲「${t.name}」？`)) return;
  if (_currentId === id) {
    stopAndRevoke();
    _currentId = null;
    setNow('未播放', '从本地导入音频开始播放');
    updateProgress(0, 0);
    updatePlayBtn();
  }
  try { await dbDel('meta', trackKey(id)); } catch (e) {}
  _index = _index.filter(x => x.id !== id);
  await saveIndex(_index);
  renderMusicShelf();
  renderMusicStorage();
  renderGlobalStorage().catch(() => {});
  // 一起听正在听的歌被删掉 → 一起听结束，避免残留空曲目状态
  if (_together.active && _together.active.trackId === id) {
    await markActiveInviteEnded();
    toast('歌曲已删除，一起听已结束');
    return;
  }
  toast('已删除本地歌曲');
}

/* ============ 初始化 ============ */
export async function initMusicModule() {
  if (_inited) return;
  _inited = true;
  const a = audioEl();
  if (!a) return;
  // 恢复音量 / 循环设置
  try {
    const s = await dbGet('meta', SETTINGS_KEY);
    if (s) {
      if (typeof s.volume === 'number') a.volume = Math.max(0, Math.min(1, s.volume));
      _loop = !!s.loop;
      a.loop = _loop;
      const vol = $('music-volume'); if (vol) vol.value = String(Math.round(a.volume * 100));
    } else {
      a.volume = 0.7;
    }
  } catch (e) { a.volume = 0.7; }
  $('music-loop-btn') && $('music-loop-btn').classList.toggle('on', _loop);
  a.addEventListener('timeupdate', () => updateProgress(a.currentTime, a.duration));
  a.addEventListener('loadedmetadata', () => updateProgress(a.currentTime, a.duration));
  a.addEventListener('play', () => { updatePlayBtn(); renderMusicShelf(); updateMusicMiniBar(); });
  a.addEventListener('pause', () => {
    updatePlayBtn(); renderMusicShelf();
    // 自然播完（随后自动切歌或真正停止）时不在这里收起迷你条，避免切歌瞬间闪一下
    if (!a.ended) updateMusicMiniBar();
  });
  a.addEventListener('ended', async () => {
    if (_loop) return; // audio.loop 已接管
    const i = _index.findIndex(t => t.id === _currentId);
    // 列表最后一首（或找不到位置）结束：真正停止，迷你条收起
    if (i < 0 || i >= _index.length - 1) {
      updatePlayBtn();
      renderMusicShelf();
      updateMusicMiniBar();
      return;
    }
    // 自动连播下一首
    _switching = true;
    try { await loadTrack(_index[i + 1], true); }
    finally { _switching = false; }
    updatePlayBtn();
    renderMusicShelf();
    updateMusicMiniBar();
  });
  a.addEventListener('error', () => {
    if (_currentId) toast('音频加载失败，可能是格式不被浏览器支持');
  });
  // 关页/刷新时兜底释放 objectURL，避免内存泄漏
  window.addEventListener('pagehide', () => { if (_url) { try { URL.revokeObjectURL(_url); } catch (e) {} _url = null; } });
  // 同步索引 + 恢复一起听状态
  try { _index = await getIndex(); } catch (e) {}
  await loadTogether();
  if (_together.active) {
    const tr = _index.find(t => t.id === _together.active.trackId);
    if (!tr) {
      await markActiveInviteEnded();
    } else if (!_currentId) {
      // 刷新后把当前曲目准备好（不自动播放，浏览器也会拦截）
      await loadTrack(tr, false);
    }
  }
  if (!_together.nextInviteAt) {
    _together.nextInviteAt = now() + randInt(4, 12) * 3600 * 1000;
    try { await saveTogether(); } catch (e) {}
  }
  renderMusicShelf();
  renderMusicStorage();
  renderTogetherBar();
  updateMusicMiniBar();
  renderGlobalStorage().catch(() => {});
}
