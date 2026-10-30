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
        <input type="${f.type||'text'}" class="input" data-ik="${f.key}" value="${f.value!=null?escapeHtml(String(f.value)):''}" placeholder="${f.placeholder||''}" ${f.required?'required':''}>
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
  box.querySelectorAll('input[data-ik]').forEach(inp => {
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

// ============ 通用弹窗 ============
export function showModal(title, bodyHtml, buttons) {
  // 清理旧的
  const old = $('_modal'); if (old) old.remove();
  const m = document.createElement('div');
  m.id = '_modal'; m.className = 'overlay';
  const btns = (buttons || [{label:'关闭', cls:'btn-outline', onClick:closeModal}]).map((b,i) =>
    `<button class="btn ${b.cls||''}" onclick="window._modalBtns[${i}] && window._modalBtns[${i}]()">${escapeHtml(b.label)}</button>`
  ).join('');
  m.innerHTML = `<div class="modal">
    <div class="modal-header"><span>${escapeHtml(title||'')}</span><button class="close-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">${bodyHtml||''}</div>
    <div class="modal-footer">${btns}</div>
  </div>`;
  document.body.appendChild(m);
  window._modalBtns = (buttons||[]).map(b => b.onClick || closeModal);
}
export function closeModal() { const m = $('_modal'); if (m) m.remove(); window._modalBtns = []; }
