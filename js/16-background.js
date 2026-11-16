// 依赖：02-core.js
import { dbGet, dbPut, toast } from './02-core.js';

/* ============ 后台能力（不改变任何聊天/钱包业务规则） ============
   1) 静音保活：用「全零采样 WAV」循环播放，尽量拖住后台页面；首次用户交互后才起播。
   2) 消息通知：页面不在前台时，把新消息/红包/转账/来信合并成一条系统通知，带限流。 */

const NOTIFY_KEY = 'notify_enabled_v1';
const NOTIFY_MIN_GAP = 8000;   // 两次系统通知的最小间隔
const NOTIFY_MERGE_DELAY = 1200; // 首批消息到达后的合并窗口

let _enabled = false;
let _gestureDone = false;
let _keepAudio = null;
let _keepUrl = null;
let _silentBlob = null;
let _pending = new Map(); // cid -> { name, count, kinds:Set, lastText }
let _flushTimer = null;
let _lastNotifyAt = 0;

/* ============ 静音保活 ============ */
// 0.5s / 8kHz / 16bit 单声道 / 采样全 0：任何音量下都不会发出声音
function buildSilentWav() {
  const sampleRate = 8000;
  const seconds = 0.5;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);          // fmt 块长度
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // 单声道
  dv.setUint32(24, sampleRate, true);  // 采样率
  dv.setUint32(28, sampleRate * 2, true); // 字节率
  dv.setUint16(32, 2, true);           // 块对齐
  dv.setUint16(34, 16, true);          // 位深
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  // ArrayBuffer 初始即为 0，采样天然全零，无需再写
  return new Blob([buf], { type: 'audio/wav' });
}

function musicElement() { return document.getElementById('music-audio'); }
function musicPlaying() {
  const a = musicElement();
  return !!(a && !a.paused && !a.ended && a.readyState > 0);
}
function ensureKeepAudio() {
  if (_keepAudio) return _keepAudio;
  _silentBlob = buildSilentWav();
  _keepUrl = URL.createObjectURL(_silentBlob);
  const a = new Audio(_keepUrl);
  a.loop = true;
  a.volume = 1;      // 不使用 muted：采样本身全零，音量不为 0 更利于后台保活
  a.preload = 'auto';
  a.setAttribute('playsinline', '');
  a.addEventListener('error', () => {});
  _keepAudio = a;
  return a;
}
async function startKeepAlive() {
  if (!_gestureDone) return;
  // 正在放歌时不另起一路，避免和音乐模块抢播
  if (musicPlaying()) return;
  const a = ensureKeepAudio();
  if (!a.paused) return;
  try { await a.play(); } catch (e) { /* 浏览器仍要求交互时静默失败，下次再试 */ }
}
function stopKeepAlive() {
  if (_keepAudio && !_keepAudio.paused) { try { _keepAudio.pause(); } catch (e) {} }
}
function onFirstGesture() {
  if (_gestureDone) return;
  _gestureDone = true;
  document.removeEventListener('pointerdown', onFirstGesture, true);
  document.removeEventListener('keydown', onFirstGesture, true);
  startKeepAlive();
}
function bindMusicMutex() {
  const m = musicElement();
  if (!m || m.__kaBound) return;
  m.__kaBound = true;
  m.addEventListener('play', stopKeepAlive);
  m.addEventListener('pause', () => { if (!musicPlaying()) startKeepAlive(); });
  m.addEventListener('ended', () => { startKeepAlive(); });
}

/* ============ 消息通知 ============ */
const KIND_LABEL = {
  sticker: '[表情]', image: '[图片]', redpacket: '[红包]',
  transfer: '[转账]', letter: '[信件]', choice: '[选择回复]'
};
function truncate(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
}
function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}
function permissionGranted() {
  return notifySupported() && Notification.permission === 'granted';
}
function renderNotifyState() {
  const el = document.getElementById('notify-switch');
  if (!el) return;
  const on = _enabled && permissionGranted();
  el.classList.toggle('on', on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}
function clearPending() {
  _pending.clear();
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
}
async function toggleNotify() {
  if (!notifySupported()) { toast('当前浏览器不支持系统通知'); return; }
  if (_enabled) {
    _enabled = false;
    clearPending();
    try { await dbPut('meta', { k: NOTIFY_KEY, enabled: false }); } catch (e) {}
    renderNotifyState();
    toast('已关闭消息通知');
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    renderNotifyState();
    toast('未获得通知权限，请在浏览器设置中允许');
    return;
  }
  _enabled = true;
  try { await dbPut('meta', { k: NOTIFY_KEY, enabled: true }); } catch (e) {}
  renderNotifyState();
  toast('已开启消息通知');
}
function notifyBody(rec) {
  if (rec.lastText) return truncate(rec.lastText, 24);
  const kinds = Array.from(rec.kinds);
  if (kinds.length === 1) return KIND_LABEL[kinds[0]] || '[新消息]';
  return '[新消息]';
}
function scheduleFlush(delay) {
  if (_flushTimer) clearTimeout(_flushTimer);
  const wait = Math.max(delay, _lastNotifyAt + NOTIFY_MIN_GAP - Date.now(), 0);
  _flushTimer = setTimeout(flushNotifications, wait);
}
function flushNotifications() {
  _flushTimer = null;
  const entries = Array.from(_pending.entries());
  _pending.clear();
  if (!entries.length) return;
  // 页面回到前台或中途关闭：积压直接丢弃，不补发
  if (!_enabled || !permissionGranted() || document.visibilityState === 'visible') return;
  const total = entries.reduce((n, [, r]) => n + r.count, 0);
  let title, body, targetCid;
  if (entries.length === 1) {
    const [cid, rec] = entries[0];
    targetCid = cid;
    title = rec.name || '新消息';
    const brief = notifyBody(rec);
    body = rec.count > 1 ? `${rec.count} 条新消息 · ${brief}` : brief;
  } else {
    targetCid = entries[entries.length - 1][0];
    const names = entries.map(([, r]) => r.name || '联系人');
    title = `星之匙 · ${total} 条新消息`;
    body = `${names.slice(0, 3).join('、')}${entries.length > 3 ? `等 ${entries.length} 人` : ''}发来消息`;
  }
  try {
    const n = new Notification(title, {
      body: truncate(body, 60),
      tag: 'zika-new-msg',
      renotify: false
    });
    _lastNotifyAt = Date.now();
    n.onclick = () => {
      try { window.focus(); } catch (e) {}
      try { if (typeof window.openChat === 'function') window.openChat(targetCid); } catch (e) {}
      try { n.close(); } catch (e) {}
    };
  } catch (e) {
    console.warn('系统通知发送失败：', e);
  }
}
// 各消息生成点调用：只上报「到达了什么」，是否真正发通知由本模块统一判定
function pushIncoming(cid, name, items) {
  if (!_enabled || !permissionGranted()) return;
  if (document.visibilityState === 'visible') return;
  if (!cid || !Array.isArray(items) || !items.length) return;
  const rec = _pending.get(cid) || { name: name || '联系人', count: 0, kinds: new Set(), lastText: '' };
  if (name) rec.name = name;
  for (const it of items) {
    if (!it) continue;
    rec.count++;
    const kind = it.kind || 'text';
    rec.kinds.add(kind);
    if (kind === 'text' && it.text) rec.lastText = it.text;
    if (kind === 'choice' && it.text) rec.lastText = it.text;
  }
  _pending.set(cid, rec);
  scheduleFlush(NOTIFY_MERGE_DELAY);
}

/* ============ 初始化 ============ */
export async function initBackgroundModule() {
  try {
    const r = await dbGet('meta', NOTIFY_KEY);
    _enabled = !!(r && r.enabled);
  } catch (e) { _enabled = false; }
  renderNotifyState();
  bindMusicMutex();
  document.addEventListener('pointerdown', onFirstGesture, { capture: true });
  document.addEventListener('keydown', onFirstGesture, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startKeepAlive();
  });
  // 开屏兜底：CSS 已在 2s 内自行隐藏，这里只负责在 2.2s 后把节点移除
  const splash = document.getElementById('splash-screen');
  if (splash) setTimeout(() => { try { splash.remove(); } catch (e) {} }, 2200);

  window.toggleNotify = toggleNotify;
  window.renderNotifyState = renderNotifyState;
  window.__notifyIncoming = pushIncoming;
  window.__notifyActive = () => _enabled && permissionGranted();
  // 仅测试/排查用：查看保活音频与限流状态，不参与业务
  window.__keepAliveState = () => ({
    gesture: _gestureDone,
    playing: !!(_keepAudio && !_keepAudio.paused),
    loop: _keepAudio ? _keepAudio.loop : false,
    muted: _keepAudio ? _keepAudio.muted : null,
    volume: _keepAudio ? _keepAudio.volume : null,
    src: _keepUrl || ''
  });
  window.__keepAliveBlob = () => _silentBlob;
  window.__notifyDebug = () => ({ enabled: _enabled, pending: _pending.size, lastNotifyAt: _lastNotifyAt });
}
