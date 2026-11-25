// 依赖：01-state.js
import { DB_NAME, DB_VERSION, state } from './01-state.js';

export const $ = (id) => document.getElementById(id);

// ============ IndexedDB 封装 ============
export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('me')) d.createObjectStore('me', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('wallet')) d.createObjectStore('wallet', { keyPath: 'k' });
    };
    req.onsuccess = (e) => { state.db = e.target.result; resolve(state.db); };
    req.onerror = (e) => reject(e.target.error);
  });
}
export function dbPut(store, val) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).put(val);
    // 必须等整个事务提交完成再 resolve（r.onsuccess 时事务可能尚未落盘，连续写入会互相覆盖/丢失）
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export function dbDel(store, key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
export function dbAll(store) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
// 单事务内「读 → 改 → 写」：同一 store 的 readwrite 事务由浏览器严格串行，
// 因此 mutator 读到的就是提交瞬间的最新数据，可在其中把并发写入合并进来，避免整对象回写互相覆盖。
// mutator 返回 undefined 表示「无需改动」（不写盘），返回对象则写回该对象。
export function dbUpdate(store, key, mutator) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const tx = state.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    let out;
    const req = os.get(key);
    req.onsuccess = () => {
      try {
        out = mutator(req.result);
        if (out !== undefined && out !== null) os.put(out);
      } catch (e) {
        try { tx.abort(); } catch (_) {}
        fail(e);
      }
    };
    req.onerror = () => fail(req.error);
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(out); } };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('transaction aborted'));
  });
}

// ============ 工具函数 ============

export function now() { return Date.now(); }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function escapeAttr(s) { return escapeHtml(s).replace(/\n/g,' '); }
export function hexWithAlpha(hex, alpha) {
  if (!hex) return `rgba(255, 158, 198, ${alpha})`;
  // Accept #rgb or #rrggbb or rgb(...) or rgba
  if (hex.startsWith('#')) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c+c).join('');
    if (h.length === 6) {
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return hex;
}
export function toast(msg, ms=2000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('toast-box').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ============ 通用输入弹窗（替代原生 prompt，手机端友好） ============
   用法: const r = await inputDialog('标题', [{key,label,type,placeholder,value,required}], '确定文字');
   返回 {key:value,...} 或取消返回 null */

export function inputDialog(title, fields, okText='确定') {
  return new Promise(resolve => {
    state._inputDialogResolve = resolve;
    $('input-dialog-title').textContent = title;
    const box = $('input-dialog-fields');
    box.innerHTML = fields.map(f => `
      <div style="margin-bottom:12px;">
        <div style="font-size:13px;color:#7f96b8;margin-bottom:6px;">${f.label}</div>
        ${f.type === 'select'
          ? `<select class="input" data-ik="${f.key}" ${f.required?'required':''}>${(f.options||[]).map(o => `<option value="${escapeHtml(String(o.value))}"${String(o.value)===String(f.value)?' selected':''}>${escapeHtml(String(o.label!=null?o.label:o.value))}</option>`).join('')}</select>`
          : `<input type="${f.type||'text'}" class="input" data-ik="${f.key}" value="${f.value!=null?escapeHtml(String(f.value)):''}" placeholder="${f.placeholder||''}" ${f.required?'required':''}>`}
      </div>`).join('');
    $('input-dialog-ok').textContent = okText;
    $('input-dialog').classList.remove('hide');
    const first = box.querySelector('input');
    if (first) setTimeout(() => { first.focus(); if (first.type === 'text') first.select(); }, 80);
  });
}
export function _closeInputDialog(result) {
  const dlg = $('input-dialog');
  if (dlg.classList.contains('hide')) return;
  dlg.classList.add('hide');
  if (state._inputDialogResolve) { state._inputDialogResolve(result); state._inputDialogResolve = null; }
}
export function _confirmInputDialog() {
  const box = $('input-dialog-fields');
  const values = {};
  let ok = true;
  box.querySelectorAll('[data-ik]').forEach(inp => {
    values[inp.dataset.ik] = inp.value;
    if (inp.required && !inp.value.trim()) { inp.style.borderColor = '#ef4444'; ok = false; }
    else inp.style.borderColor = '';
  });
  if (!ok) return;
  _closeInputDialog(values);
}
(function _initInputDialog() {
  $('input-dialog-ok').addEventListener('click', _confirmInputDialog);
  $('input-dialog-cancel').addEventListener('click', () => _closeInputDialog(null));
  $('input-dialog').addEventListener('click', (e) => { if (e.target === $('input-dialog')) _closeInputDialog(null); });
  $('input-dialog-fields').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'datetime-local') { e.preventDefault(); _confirmInputDialog(); }
  });
})();

export function formatTime(ts) {
  const d = new Date(ts), nowD = new Date();
  const sameY = d.getFullYear() === nowD.getFullYear();
  const sameDay = sameY && d.getMonth() === nowD.getMonth() && d.getDate() === nowD.getDate();
  const yD = new Date(nowD); yD.setDate(yD.getDate() - 1);
  const yest = d.getFullYear() === yD.getFullYear() && d.getMonth() === yD.getMonth() && d.getDate() === yD.getDate();
  const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
  if (sameDay) return `${hh}:${mm}`;
  if (yest) return `昨天 ${hh}:${mm}`;
  if (sameY) return `${d.getMonth()+1}月${d.getDate()}日 ${hh}:${mm}`;
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${hh}:${mm}`;
}
export function countdownAnniversary(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const [y, m, d] = dateStr.split('-').map(Number);
  let target = new Date(today.getFullYear(), m-1, d);
  target.setHours(0,0,0,0);
  if (target < today) target = new Date(today.getFullYear()+1, m-1, d);
  const diff = Math.round((target - today) / 86400000);
  // 判断今天就是
  const origin = new Date(y, m-1, d); origin.setHours(0,0,0,0);
  const todayIsOrigin = today.getMonth()+1 === m && today.getDate() === d;
  return { diff, todayIsOrigin };
}
// 纪念日计算方式：生日默认倒数（还有 N 天），其余默认正数（已经 N 天）
export function defaultAnniMode(name) {
  return /生日/.test(String(name || '')) ? 'countdown' : 'countup';
}
// 纪念日展示：{ cls, text }；mode 缺省按名称判定（兼容旧数据）
export function anniversaryView(a) {
  if (!a || !a.date) return { cls: 'anni-countdown', text: '' };
  const mode = a.mode === 'countdown' || a.mode === 'countup' ? a.mode : defaultAnniMode(a.name);
  if (mode === 'countdown') {
    const r = countdownAnniversary(a.date);
    if (!r) return { cls: 'anni-countdown', text: '' };
    if (r.todayIsOrigin) return { cls: 'anni-countdown anni-today', text: '就是今天' };
    return { cls: 'anni-countdown', text: `还有${r.diff}天` };
  }
  const [y, m, d] = String(a.date).split('-').map(Number);
  if (!y || !m || !d) return { cls: 'anni-countdown', text: '' };
  const today = new Date(); today.setHours(0,0,0,0);
  const origin = new Date(y, m-1, d); origin.setHours(0,0,0,0);
  const days = Math.round((today - origin) / 86400000);
  if (days === 0) return { cls: 'anni-countdown anni-today', text: '就是今天' };
  if (days < 0) return { cls: 'anni-countdown', text: `还有${-days}天` };
  return { cls: 'anni-countdown', text: `已经${days}天` };
}
// 图片压缩
export function compressImage(file, maxSide=1280, quality=0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h && w > maxSide) { h = h * maxSide / w; w = maxSide; }
        else if (h >= w && h > maxSide) { w = w * maxSide / h; h = maxSide; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
export function estimateSizeMB(str) {
  return (new Blob([str]).size / 1024 / 1024).toFixed(2);
}

/* ============ 表情包专用压缩：WebP + 保留透明 + 长边 320 + 动图保留动画 ============
   浏览器本地完成，不依赖第三方库：
   - 静图：canvas 等比缩放到长边 320 → toDataURL('image/webp')，透明通道保留
   - 动图：ImageDecoder 逐帧解码（GIF / 动图 WebP / APNG），逐帧编码为 WebP 后
     按 RIFF/ANMF 容器拼成动态 WebP，帧数与每帧时长原样保留
   - 已是合规尺寸（长边 ≤320）的 WebP 直接原样入库，避免二次编码导致体积变大 */
export function compressSticker(file, maxSide = 320, quality = 0.85) {
  return (async () => {
    const src = await readFileAsDataURL(file);
    const img = await loadImgEl(src).catch(() => null);
    if (!img) return src;
    const sw = img.naturalWidth || img.width || 0;
    const sh = img.naturalHeight || img.height || 0;
    if (!sw || !sh) return src;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    if (/^data:image\/webp/i.test(src) && scale === 1) return src;
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    if (typeof ImageDecoder === 'function') {
      const anim = await encodeAnimatedSticker(file, w, h, quality).catch(() => null);
      if (anim) return anim;
    }
    return encodeStillSticker(img, w, h, quality);
  })();
}
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function loadImgEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function encodeStillSticker(img, w, h, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/webp', quality);
  // 极老浏览器不支持 WebP 编码时退回 PNG（仍保留透明，绝不转 JPEG）
  return /^data:image\/webp/i.test(out) ? out : canvas.toDataURL('image/png');
}
async function encodeAnimatedSticker(file, w, h, quality) {
  const type = file.type || '';
  if (!/^image\/(gif|webp|png|apng)$/i.test(type)) return null;
  const buf = await file.arrayBuffer();
  const dec = new ImageDecoder({ data: buf, type });
  try {
    if (dec.tracks && dec.tracks.ready) await dec.tracks.ready;
    else await dec.completed;
    const track = dec.tracks && (dec.tracks.selectedTrack || dec.tracks[0]);
    if (!track || !track.animated || !(track.frameCount > 1)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const frames = [];
    let lastDur = 100000;
    for (let i = 0; i < track.frameCount; i++) {
      const res = await dec.decode({ frameIndex: i });
      const frame = res && (res.image || res);
      if (!frame) continue;
      const durUs = Number(frame.duration) || lastDur;
      lastDur = durUs;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(frame, 0, 0, w, h);
      if (typeof frame.close === 'function') frame.close();
      const url = canvas.toDataURL('image/webp', quality);
      const chunks = /^data:image\/webp/i.test(url) ? extractWebpBitstream(url) : null;
      if (!chunks) return null;
      frames.push({ chunks, duration: Math.max(10, Math.round(durUs / 1000)) });
    }
    if (frames.length < 2) return null;
    const loop = Number.isFinite(track.repetitionCount) ? Math.max(0, Math.min(65535, track.repetitionCount)) : 0;
    return assembleAnimatedWebp(frames, w, h, loop);
  } finally {
    try { dec.close(); } catch (e) {}
  }
}
function extractWebpBitstream(dataUrl) {
  const i = dataUrl.indexOf(',');
  if (i < 0) return null;
  const bin = atob(dataUrl.slice(i + 1));
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  if (bytes.length < 12) return null;
  let off = 12, alpha = null, vp8 = null;
  while (off + 8 <= bytes.length) {
    const cc = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const size = bytes[off + 4] | (bytes[off + 5] << 8) | (bytes[off + 6] << 16) | (bytes[off + 7] << 24);
    const s = off + 8, e = s + size;
    if (e > bytes.length) break;
    if (cc === 'ALPH') alpha = bytes.slice(s, e);
    else if (cc === 'VP8 ' || cc === 'VP8L') vp8 = bytes.slice(s, e);
    off = e + (size & 1);
  }
  if (!vp8) return null;
  return { alpha, vp8 };
}
function u16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
function u24(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255]); }
function u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
function chunkBytes(fourcc, data) {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i);
  out.set(u32(data.length), 4);
  out.set(data, 8);
  return out;
}
function concatBytes(list) {
  let n = 0;
  for (const b of list) n += b.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}
function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function assembleAnimatedWebp(frames, w, h, loop) {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x12; // 动画 + 透明
  vp8x.set(u24(w - 1), 4);
  vp8x.set(u24(h - 1), 7);
  const anim = new Uint8Array(6);
  anim.set(u16(loop), 4);
  const parts = [chunkBytes('VP8X', vp8x), chunkBytes('ANIM', anim)];
  for (const f of frames) {
    const head = new Uint8Array(16);
    head.set(u24(0), 0); head.set(u24(0), 3);
    head.set(u24(w - 1), 6); head.set(u24(h - 1), 9);
    head.set(u24(f.duration), 12);
    head[15] = 0x02; // 不混合：整帧覆盖，避免透明区露出上一帧
    const bodyParts = [head];
    if (f.chunks.alpha) bodyParts.push(chunkBytes('ALPH', f.chunks.alpha));
    bodyParts.push(chunkBytes('VP8 ', f.chunks.vp8));
    parts.push(chunkBytes('ANMF', concatBytes(bodyParts)));
  }
  const body = concatBytes(parts);
  const file = new Uint8Array(12 + body.length);
  file.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  file.set(u32(4 + body.length), 4);
  file.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  file.set(body, 12);
  return 'data:image/webp;base64,' + bytesToBase64(file);
}

// ============ 通用弹窗 ============
export function showModal(title, bodyHtml, buttons, onClose) {
  // 清理旧的
  const old = $('_modal'); if (old) old.remove();
  const m = document.createElement('div');
  m.id = '_modal'; m.className = 'overlay';
  const btns = (buttons || [{label:'关闭', cls:'btn-outline', onClick:closeModal}]).map((b,i) =>
    `<button class="btn ${b.cls||''}" onclick="window._modalBtns[${i}] && window._modalBtns[${i}]()">${escapeHtml(b.label)}</button>`
  ).join('');
  m.innerHTML = `<div class="modal">
    <div class="modal-header"><span>${escapeHtml(title||'')}</span><button class="close-btn" onclick="(window._modalOnClose||closeModal)()"><svg class="i i-sm"><use href="#icon-close"/></svg></button></div>
    <div class="modal-body">${bodyHtml||''}</div>
    <div class="modal-footer">${btns}</div>
  </div>`;
  document.body.appendChild(m);
  window._modalBtns = (buttons||[]).map(b => b.onClick || closeModal);
  window._modalOnClose = onClose || closeModal;
}
export function closeModal() { const m = $('_modal'); if (m) m.remove(); window._modalBtns = []; window._modalOnClose = null; }

// 替代原生 confirm()：返回 Promise<boolean>，点右上角 × 或遮罩等同于取消
export function confirmDialog(msg, okText = '确定') {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    showModal('请确认',
      `<div style="font-size:14px;line-height:1.7;color:var(--text-primary);white-space:pre-wrap;">${escapeHtml(msg)}</div>`,
      [
        { label: '取消', cls: 'btn-outline', onClick: () => finish(false) },
        { label: okText, cls: 'btn', onClick: () => finish(true) }
      ],
      () => finish(false)
    );
  });
}
