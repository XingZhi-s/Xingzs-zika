// 依赖：01-state.js / 02-core.js / 03-data.js
import { uid } from './01-state.js';
import { $, confirmDialog, dbDel, dbGet, dbPut, escapeHtml, now, toast } from './02-core.js';
import { openPage } from './03-data.js';

/* ============ 本地音乐（纯本地文件，空盒子形态） ============
   索引： meta.music_index_v1  = { k, list:[{ id, name, size, addTime }] }
   音频： meta.music_track_<id> = { k, id, name, blob }   // Blob 直接存 IndexedDB
   设置： meta.music_settings_v1 = { k, volume, loop }
   播放时用 objectURL 重建，切歌/返回/删除/关页时立刻 revoke，避免 URL 泄漏。 */

const INDEX_KEY = 'music_index_v1';
const SETTINGS_KEY = 'music_settings_v1';

let _index = [];
let _currentId = null;
let _url = null;
let _loop = false;
let _inited = false;
let _volTimer = null;
let _seekHoldUntil = 0;

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

/* ============ 页面入口 / 返回 ============ */
export async function openMusicPage() {
  _index = await getIndex();
  renderMusicShelf();
  openPage('page-music');
  if (_currentId && _index.some(t => t.id === _currentId)) {
    const t = _index.find(x => x.id === _currentId);
    setNow(t.name, '本地音频');
  } else {
    setNow('未播放', '从本地导入音频开始播放');
    updateProgress(0, 0);
  }
}
export function musicBack() {
  stopAndRevoke();
  _currentId = null;
  renderMusicShelf();
  setNow('未播放', '从本地导入音频开始播放');
  updateProgress(0, 0);
  openPage('page-home');
}

/* ============ 导入本地音频 ============ */
export async function musicPickFiles(input) {
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  if (!files.length) return;
  let added = 0;
  for (const file of files) {
    const isAudio = /^audio\//i.test(file.type || '') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma)$/i.test(file.name || '');
    if (!isAudio) { toast(`「${file.name}」不是音频文件，已跳过`); continue; }
    const id = uid();
    const name = (file.name || '未命名音频').replace(/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma)$/i, '');
    try {
      await dbPut('meta', { k: trackKey(id), id, name, blob: file });
      _index.push({ id, name, size: file.size || 0, addTime: now() });
      added++;
    } catch (e) {
      console.warn('音频保存失败：', e);
      toast(`「${file.name}」保存失败`);
    }
  }
  if (added) {
    await saveIndex(_index);
    renderMusicShelf();
    toast(`已导入 ${added} 首本地音乐`);
  }
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
  a.addEventListener('play', () => { updatePlayBtn(); renderMusicShelf(); });
  a.addEventListener('pause', () => { updatePlayBtn(); renderMusicShelf(); });
  a.addEventListener('ended', () => {
    if (_loop) return; // audio.loop 已接管
    musicNext();
  });
  a.addEventListener('error', () => {
    if (_currentId) toast('音频加载失败，可能是格式不被浏览器支持');
  });
  // 关页/刷新时兜底释放 objectURL，避免内存泄漏
  window.addEventListener('pagehide', () => { if (_url) { try { URL.revokeObjectURL(_url); } catch (e) {} _url = null; } });
  // 首次打开音乐页时同步索引
  try { _index = await getIndex(); renderMusicShelf(); } catch (e) {}
}
