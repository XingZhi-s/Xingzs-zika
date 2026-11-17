// 依赖：02-core.js
import { dbGet, dbPut, toast } from './02-core.js';

/* ============ 后台能力（不改变任何聊天/钱包业务规则） ============
   1) 静音保活：用「全零采样 WAV」循环播放，尽量拖住后台页面；首次用户交互后才起播。
   2) 消息通知：页面不在前台时把新消息发成系统通知。每条消息一条独立通知（tag 唯一、
      互不覆盖），不做合并与汇总；折叠由系统自行处理。跨批次仍限流。 */

const NOTIFY_KEY = 'notify_enabled_v1';
const KEEPALIVE_KEY = 'keepalive_enabled_v1';
const NOTIFY_MIN_GAP = 8000;   // 两次系统通知的最小间隔
const NOTIFY_MERGE_DELAY = 1200; // 首批消息到达后的合并窗口

let _enabled = false;
let _keepEnabled = true;   // 后台保活开关（默认开启，用户可关；关闭后释放音频资源）
let _gestureDone = false;
let _keepAudio = null;
let _keepUrl = null;
let _silentBlob = null;
let _pending = new Map(); // cid -> { name, items:[{id,kind,text}] }
let _flushTimer = null;
let _lastNotifyAt = 0;
let _swReg = null;
let _swPromise = null;
let _lastMethod = '';
let _lastError = '';
let _lastBatch = [];      // 最近一批实际发出的通知（排查/测试用）
let _notifySeq = 0;       // 消息没有 id 时用它保证 tag 唯一

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
  if (!_keepEnabled) return;
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
// 关闭保活时彻底释放：停播、断开音频源、回收 Blob URL，避免继续占用解码器/内存
function releaseKeepAlive() {
  if (_keepAudio) {
    try { _keepAudio.pause(); } catch (e) {}
    try { _keepAudio.removeAttribute('src'); _keepAudio.load(); } catch (e) {}
  }
  if (_keepUrl) { try { URL.revokeObjectURL(_keepUrl); } catch (e) {} }
  _keepAudio = null;
  _keepUrl = null;
  _silentBlob = null;
}
function renderKeepAliveState() {
  const el = document.getElementById('keepalive-switch');
  if (!el) return;
  el.classList.toggle('on', _keepEnabled);
  el.setAttribute('aria-checked', _keepEnabled ? 'true' : 'false');
}
async function toggleKeepAlive() {
  _keepEnabled = !_keepEnabled;
  renderKeepAliveState();
  try { await dbPut('meta', { k: KEEPALIVE_KEY, enabled: _keepEnabled }); } catch (e) {}
  if (_keepEnabled) {
    startKeepAlive();
    toast('已开启后台保活');
  } else {
    releaseKeepAlive();
    toast('已关闭后台保活');
  }
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
// 页面是否正在前台被使用：标签隐藏或窗口失焦都算「不在前台」
function pageIsActive() {
  try { return !document.hidden && document.hasFocus(); } catch (e) { return document.visibilityState === 'visible'; }
}
// 注册最小作用域 Service Worker（安卓 Chrome 只能用 registration.showNotification 弹通知）
function ensureSW() {
  if (_swReg) return Promise.resolve(_swReg);
  if (_swPromise) return _swPromise;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
  _swPromise = (async () => {
    try {
      const url = new URL('./sw.js', location.href).href;
      const reg = await navigator.serviceWorker.register(url, { scope: './' });
      await navigator.serviceWorker.ready;
      _swReg = reg;
      return reg;
    } catch (e) {
      _lastError = 'Service Worker 注册失败：' + (e && e.message ? e.message : e);
      console.warn(_lastError);
      return null;
    } finally {
      _swPromise = null;
    }
  })();
  return _swPromise;
}
function focusWindow() {
  try { window.focus(); } catch (e) {}
}
function openChatById(cid) {
  if (!cid) return;
  try { if (typeof window.openChat === 'function') window.openChat(cid); } catch (e) { console.warn('打开聊天失败：', e); }
}
// 统一发送入口：优先 SW（安卓必需），桌面浏览器 SW 不可用时退回页面 Notification
async function showSystemNotification(title, options) {
  const opt = options || {};
  if (!permissionGranted()) throw new Error('未获得通知权限');
  const cid = opt.cid || '';
  const reg = await ensureSW();
  if (reg && typeof reg.showNotification === 'function') {
    await reg.showNotification(title, {
      body: opt.body || '',
      tag: opt.tag || 'zika-new-msg',
      renotify: !!opt.renotify,
      data: { cid, kind: opt.kind || 'msg' },
      silent: false
    });
    return 'sw';
  }
  if (typeof Notification === 'function') {
    const n = new Notification(title, { body: opt.body || '', tag: opt.tag || 'zika-new-msg' });
    n.onclick = () => { focusWindow(); openChatById(cid); try { n.close(); } catch (e) {} };
    return 'page';
  }
  throw new Error('当前环境不支持系统通知');
}
async function notifyTest() {
  try {
    const method = await showSystemNotification('通知已开启', {
      body: '有新消息时会在系统通知栏提醒你', tag: 'zika-notify-test', cid: ''
    });
    _lastMethod = method;
    _lastError = '';
    toast(method === 'sw' ? '测试通知已发送（Service Worker）' : '测试通知已发送');
  } catch (e) {
    _lastError = '测试通知失败：' + (e && e.message ? e.message : e);
    console.warn(_lastError);
    toast('测试通知发送失败：' + (e && e.message ? e.message : '未知错误'));
  }
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
  if (!window.isSecureContext) {
    toast('系统通知需要 https 或 localhost 打开，当前环境无法发送');
    return;
  }
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
    try { perm = await Notification.requestPermission(); } catch (e) {
      _lastError = '权限申请失败：' + (e && e.message ? e.message : e);
      perm = 'denied';
    }
  }
  if (perm !== 'granted') {
    renderNotifyState();
    toast(perm === 'denied'
      ? '通知已被浏览器拒绝，请在地址栏站点设置中允许通知后重试'
      : '未获得通知权限');
    return;
  }
  _enabled = true;
  try { await dbPut('meta', { k: NOTIFY_KEY, enabled: true }); } catch (e) {}
  renderNotifyState();
  toast('已开启消息通知');
  // 立刻发一条测试通知：用户当场就能确认整条链路是否通
  notifyTest();
}
function previewOf(it) {
  if (!it) return '[新消息]';
  if (it.text) return truncate(it.text, 24);
  return KIND_LABEL[it.kind] || '[新消息]';
}
// 每条消息一条通知，tag 互不相同（消息 id 优先，缺失时用自增序号），互不覆盖、历史保留。
// Web Notification 没有 group/setGroup：是否折叠由 Android 自己决定，这里不做也不假装能做。
function buildNotifyBatch(entries) {
  const batch = [];
  for (const [cid, rec] of entries) {
    if (!cid) continue;
    for (const it of rec.items) {
      _notifySeq++;
      batch.push({
        title: rec.name || '新消息',
        body: previewOf(it),
        tag: `zika-msg-${cid}-${it.id || _notifySeq}`,
        cid,
        kind: 'msg'
      });
    }
  }
  return batch;
}
function scheduleFlush(delay) {
  if (_flushTimer) clearTimeout(_flushTimer);
  const wait = Math.max(delay, _lastNotifyAt + NOTIFY_MIN_GAP - Date.now(), 0);
  _flushTimer = setTimeout(flushNotifications, wait);
}
async function flushNotifications() {
  _flushTimer = null;
  const entries = Array.from(_pending.entries());
  _pending.clear();
  if (!entries.length) return;
  // 页面回到前台或中途关闭：积压直接丢弃，不补发
  if (!_enabled || !permissionGranted() || pageIsActive()) return;
  const batch = buildNotifyBatch(entries);
  if (!batch.length) return;
  // 冷却从整批开始时刻重新起算
  _lastNotifyAt = Date.now();
  _lastBatch = [];
  for (const item of batch) {
    try {
      const method = await showSystemNotification(item.title, {
        body: truncate(item.body, 60),
        tag: item.tag,
        renotify: true,
        cid: item.cid,
        kind: item.kind
      });
      _lastMethod = method;
      _lastError = '';
      _lastBatch.push({ title: item.title, body: truncate(item.body, 60), tag: item.tag, cid: item.cid, kind: item.kind });
    } catch (e) {
      _lastError = '通知发送失败：' + (e && e.message ? e.message : e);
      console.warn(_lastError, e);
      break;
    }
  }
}
// 各消息生成点调用：只上报「到达了什么」，是否真正发通知由本模块统一判定
function pushIncoming(cid, name, items) {
  if (!_enabled || !permissionGranted()) return;
  if (pageIsActive()) return;
  if (!cid || !Array.isArray(items) || !items.length) return;
  const rec = _pending.get(cid) || { name: name || '联系人', items: [] };
  if (name) rec.name = name;
  for (const it of items) {
    if (!it) continue;
    rec.items.push({ id: it.id || '', kind: it.kind || 'text', text: it.text || '' });
  }
  _pending.set(cid, rec);
  scheduleFlush(NOTIFY_MERGE_DELAY);
}

/* ============ 初始化 ============ */
export async function initBackgroundModule() {
  let stored = false;
  try {
    const r = await dbGet('meta', NOTIFY_KEY);
    if (r) { _enabled = !!r.enabled; stored = true; }
  } catch (e) {}
  // 首次使用：浏览器已授权就默认开启；用户主动关过（有记录）则尊重记录
  if (!stored && permissionGranted()) {
    _enabled = true;
    try { await dbPut('meta', { k: NOTIFY_KEY, enabled: true }); } catch (e) {}
  }
  try {
    const k = await dbGet('meta', KEEPALIVE_KEY);
    // 没有记录时按默认值（开启）处理，与用户预期一致
    _keepEnabled = !(k && k.enabled === false);
  } catch (e) { _keepEnabled = true; }
  renderNotifyState();
  renderKeepAliveState();
  bindMusicMutex();
  document.addEventListener('pointerdown', onFirstGesture, { capture: true });
  document.addEventListener('keydown', onFirstGesture, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startKeepAlive();
  });
  // 通知走 SW：提前注册，点击通知时由 SW 通知页面打开对应聊天
  if (_enabled && permissionGranted()) ensureSW();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'zika-open-chat' && d.cid) {
        focusWindow();
        openChatById(d.cid);
      }
    });
  }

  window.toggleNotify = toggleNotify;
  window.renderNotifyState = renderNotifyState;
  window.toggleKeepAlive = toggleKeepAlive;
  window.renderKeepAliveState = renderKeepAliveState;
  window.__notifyIncoming = pushIncoming;
  window.__notifyActive = () => _enabled && permissionGranted();
  // 仅测试/排查用：查看保活音频与限流状态，不参与业务
  window.__keepAliveState = () => ({
    enabled: _keepEnabled,
    gesture: _gestureDone,
    playing: !!(_keepAudio && !_keepAudio.paused),
    hasAudio: !!_keepAudio,
    hasBlob: !!_silentBlob,
    loop: _keepAudio ? _keepAudio.loop : false,
    muted: _keepAudio ? _keepAudio.muted : null,
    volume: _keepAudio ? _keepAudio.volume : null,
    src: _keepUrl || ''
  });
  window.__keepAliveBlob = () => _silentBlob;
  window.__notifyTest = notifyTest;
  window.__notifyDebug = () => ({
    enabled: _enabled,
    pending: _pending.size,
    lastNotifyAt: _lastNotifyAt,
    permission: notifySupported() ? Notification.permission : 'unsupported',
    secure: !!window.isSecureContext,
    swActive: !!(_swReg && _swReg.active),
    swScope: _swReg ? _swReg.scope : '',
    method: _lastMethod,
    lastError: _lastError,
    pageActive: pageIsActive(),
    lastBatch: _lastBatch
  });
}
