// 我的头像（按联系人）：仅影响该联系人聊天里「我」发出的消息头像
// 依赖：01-state.js / 02-core.js
import { state } from './01-state.js';
import { dbDel, dbGet, dbPut, compressImage, toast } from './02-core.js';

// 用 meta 单独存一份，不写联系人整对象，避免与补算/回复的整对象写库互相覆盖
const KEY_PREFIX = 'myAvatar_';
// 按联系人串行写库
const writeChains = new Map();

function keyOf(cid) { return KEY_PREFIX + cid; }

export async function getMyAvatarFor(cid) {
  if (!cid) return '';
  const key = keyOf(cid);
  const pending = writeChains.get(key);
  if (pending) { try { await pending; } catch (e) {} }
  const rec = await dbGet('meta', key);
  return (rec && rec.data) || '';
}

function saveMyAvatar(cid, data) {
  if (!cid) return Promise.resolve();
  const key = keyOf(cid);
  const prev = writeChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (data) await dbPut('meta', { k: key, data });
    else await dbDel('meta', key);
  });
  writeChains.set(key, next);
  next.catch(() => {}).then(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  });
  return next;
}

async function refreshContactSetting(cid) {
  if (typeof window.openContactSetting === 'function') {
    try { await window.openContactSetting(cid, state.csFromPage); } catch (e) {}
  }
}

export async function csUpdateMyAvatar(input) {
  const cid = state.currentContactSettingId;
  if (!cid || !input.files || !input.files.length) return;
  const file = input.files[0];
  input.value = '';
  try {
    const d = await compressImage(file);
    await saveMyAvatar(cid, d);
    await refreshContactSetting(cid);
    toast('我的头像已更新');
  } catch (e) { toast('图片处理失败'); }
}

export async function csResetMyAvatar() {
  const cid = state.currentContactSettingId;
  if (!cid) return;
  await saveMyAvatar(cid, '');
  await refreshContactSetting(cid);
  toast('已恢复默认头像');
}
