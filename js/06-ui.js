// 依赖：04-chat.js
import { DEFAULT_AVATAR, PRESET_BGS, PRESET_COLORS, state, uid } from './01-state.js';
import { $, closeModal, compressImage, escapeHtml, inputDialog, now, randInt, showModal, toast } from './02-core.js';
import { applyChatBg, deleteContact, getAllContacts, getContact, getMe, getTheme, openChat, openPage, rateColor, renderContacts, renderMeBrief, saveContact, saveMe, saveTheme } from './03-data.js';
import { sendStickerMessage } from './04-chat.js';
import { enqueueTask, runCatchUp } from './08-main.js';

// ============ ME 页功能 ============
export async function updateMyAvatar(input) {
  if (!input.files || !input.files.length) return;
  try {
    const d = await compressImage(input.files[0]);
    input.value = '';
    const m = await getMe();
    m.avatar = d;
    await saveMe(m);
    renderMeBrief();
    toast('头像已更新');
  } catch(e) { toast('图片处理失败'); }
}
export async function editMyName() {
  const m = await getMe();
  const r = await inputDialog('修改名字', [{ key:'name', label:'我的名字', value:m.name||'', required:true }]);
  if (!r) return;
  const nm = (r.name || '').trim();
  if (!nm) return toast('名字不能为空');
  m.name = nm;
  await saveMe(m);
  renderMeBrief();
}
export function openMyStickers() { openPage('page-my-stickers'); }
export async function renderMyStickersGrid() {
  const m = await getMe();
  const list = m.stickers || [];
  const grid = $('my-stickers-grid');
  if (!grid) return;
  if (!list.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">还没有表情包，点击右上角 ＋ 添加</div>`; return; }
  grid.innerHTML = list.map(s => `<div class="sticker-mgr-item">
    <img src="${escapeHtml(s.data)}" alt="">
    <button class="del" onclick="deleteMySticker('${escapeHtml(s.id)}')">✕</button>
    ${s.name ? `<div class="name">${escapeHtml(s.name)}</div>` : ''}
  </div>`).join('');
}
export async function deleteMySticker(id) {
  if (!confirm('删除这张表情包？')) return;
  const m = await getMe();
  m.stickers = (m.stickers || []).filter(x => x.id !== id);
  await saveMe(m);
  renderMyStickersGrid();
}
export async function addMyStickers(input) {
  if (!input.files || !input.files.length) return;
  const files = Array.from(input.files);
  input.value = '';
  const m = await getMe();
  m.stickers = m.stickers || [];
  const existSet = new Set(m.stickers.map(s => s.data));
  let added = 0, dup = 0;
  for (const f of files) {
    try {
      const d = await compressImage(f, 800, 0.85);
      if (existSet.has(d)) { dup++; continue; }
      m.stickers.push({ id: uid(), name:'', data: d });
      existSet.add(d);
      added++;
    } catch(e) {}
  }
  await saveMe(m);
  toast(`添加${added}张${dup?`，跳过重复${dup}张`:''}`);
  // 我的表情包页面：添加后立刻刷新
  if (document.getElementById('page-my-stickers')?.classList.contains('active')) renderMyStickersGrid();
}
export async function quickAddMyStickers(input) {
  await addMyStickers(input);
  renderStickerPanel();
}
export async function renderStickerPanel() {
  const m = await getMe();
  const list = m.stickers || [];
  const grid = $('sticker-panel-grid');
  if (!grid) return;
  if (!list.length) { grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-secondary);">还没有表情包，先添加吧</div>`; return; }
  grid.innerHTML = list.map(s => `<div class="sticker-item" onclick="sendStickerAndClose('${encodeURIComponent(s.data)}')"><img src="${escapeHtml(s.data)}" alt=""></div>`).join('');
}
export async function sendStickerAndClose(encData) {
  $('sticker-panel').classList.add('hide');
  await sendStickerMessage(decodeURIComponent(encData));
}
export function toggleStickerPanel() { $('sticker-panel').classList.toggle('hide'); }

// ============ 联系人设置页功能 ============

export function openContactSettingsList() { openPage('page-contact-settings-list'); }
export async function renderContactSettingsList() {
  const list = await getAllContacts();
  const box = $('cs-list'); if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="empty">还没有联系人</div>`; return; }
  box.innerHTML = list.map(c => `
    <div class="setting-item" onclick="openContactSetting('${c.id}','page-contact-settings-list')">
      <div class="setting-label">
        <img class="avatar" src="${escapeHtml(c.avatar || DEFAULT_AVATAR)}" alt="">
        <span>${escapeHtml(c.name)}</span>
      </div>
      <span class="setting-arrow">›</span>
    </div>
  `).join('');
}
export async function openContactSetting(id, fromPage) {
  state.currentContactSettingId = id;
  state.csFromPage = fromPage || 'page-me';
  await renderContactSetting(id);
  openPage('page-contact-setting');
}
export function backFromContactSetting() {
  if (state.currentContactId && state.csFromPage === 'page-chat') {
    openChat(state.currentContactId);
  } else {
    openPage(state.csFromPage);
  }
}
export async function renderContactSetting(id) {
  const c = await getContact(id); if (!c) return;
  const box = $('cs-content'); if (!box) return;
  const tiers = ['秒回','常回','看心情','很少回','不理人'];
  const statusRows = (c.statusList || []).map(s => {
    const rate = (typeof s.replyRate === 'number') ? s.replyRate : ({ '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 }[s.tier] || 50);
    return `
    <div class="status-item">
      <div class="status-info">
        <div class="status-name">${escapeHtml(s.name)} ${c.status===s.name ? '<span class="tag tier-秒回" style="background:'+rateColor(rate)+';color:#fff;border:none;">当前</span>' : ''}</div>
        <div class="status-tier" style="color:var(--text-secondary);font-size:12px;">回复概率 ${rate}%</div>
      </div>
      <div class="status-actions">
        <button onclick="setStatusCurrent('${escapeHtml(s.id)}')" title="设为当前" style="display:flex;align-items:center;justify-content:center;"><svg class="i i-sm"><use href="#icon-check"/></svg></button>
        <button onclick="editStatus('${escapeHtml(s.id)}')" title="编辑" style="display:flex;align-items:center;justify-content:center;"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
        <button style="background:#fee2e2;color:#991b1b;display:flex;align-items:center;justify-content:center;" onclick="deleteStatus('${escapeHtml(s.id)}')" title="删除"><svg class="i i-sm" style="stroke:#991b1b;"><use href="#icon-trash"/></svg></button>
      </div>
    </div>
  `;}).join('');
  const autoMode = c.statusAuto !== false;
  box.innerHTML = `
    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-user"/></svg> 资料</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">头像</span>
          <span class="cs-value" style="display:flex;justify-content:flex-end;gap:10px;align-items:center;">
            <img class="avatar" style="width:52px;height:52px;" src="${escapeHtml(c.avatar||DEFAULT_AVATAR)}" alt="">
            <button class="btn btn-ghost" style="min-height:36px;padding:6px 12px;" onclick="document.getElementById('cs-avatar-file').click()">更换</button>
            <input type="file" accept="image/*" id="cs-avatar-file" class="hide" onchange="csUpdateAvatar(this)">
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">名字</span>
          <span class="cs-value" style="display:flex;justify-content:flex-end;gap:10px;align-items:center;">
            <span>${escapeHtml(c.name)}</span>
            <button class="btn-outline btn" style="min-height:36px;padding:6px 12px;" onclick="csEditName()">修改</button>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">对我的专属称呼</span>
          <span class="cs-value" style="display:flex;justify-content:flex-end;gap:10px;align-items:center;">
            <span>${escapeHtml(c.settings.myNickname || '（默认：我的名字）')}</span>
            <button class="btn-outline btn" style="min-height:36px;padding:6px 12px;" onclick="csEditMyNickname()">修改</button>
          </span>
        </div>
        <div class="cs-row" style="color:var(--danger);">
          <span class="cs-label">危险操作</span>
          <span class="cs-value" style="text-align:right;">
            <button class="btn btn-danger" style="min-height:36px;padding:6px 16px;" onclick="csDeleteContact()"><svg class="i i-sm" style="margin-right:4px;fill:none;stroke:#fff;"><use href="#icon-trash"/></svg> 删除联系人</button>
          </span>
        </div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-cog"/></svg> 生活状态</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">自动切换</span>
          <span class="cs-value" style="text-align:right;">
            <div class="switch ${autoMode?'on':''}" onclick="csToggleStatusAuto()"></div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">每 30 分钟~3 小时随机切换</div>
          </span>
        </div>
        ${statusRows || '<div style="padding:20px 0;text-align:center;color:var(--text-secondary);">还没有状态，点击下方按钮添加</div>'}
        <button class="btn btn-ghost" style="width:100%;margin-top:10px;" onclick="csAddStatus()">＋ 添加状态</button>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-chat"/></svg> 回复设置</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">最快回复</span>
          <span class="cs-value" style="text-align:right;">
            <div class="range-row" style="justify-content:flex-end;"><input type="number" min="1" value="${c.settings.fastSec||5}" id="cs-fast"> <span style="font-size:12px;color:var(--text-secondary);">秒</span></div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">最慢回复</span>
          <span class="cs-value" style="text-align:right;">
            <div class="range-row" style="justify-content:flex-end;"><input type="number" min="1" value="${c.settings.slowMin||3}" id="cs-slow"> <span style="font-size:12px;color:var(--text-secondary);">分钟</span></div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">回复条数</span>
          <span class="cs-value" style="text-align:right;">
            <div class="range-row" style="justify-content:flex-end;"><input type="number" min="1" max="10" value="${c.settings.replyCount||1}" id="cs-repc"> <span style="font-size:12px;color:var(--text-secondary);">条（多条连发，每条间隔1-3秒）</span></div>
          </span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="csSaveReply()"><svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存回复设置</button>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-heart"/></svg> 主动消息</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">主动发消息</span>
          <span class="cs-value" style="text-align:right;">
            <div class="switch ${c.settings.proactiveMsg?'on':''}" onclick="csToggleProactive()"></div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">开启后每 2~8 小时随机主动发一批</div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">每批条数范围</span>
          <span class="cs-value" style="text-align:right;">
            <div class="range-row" style="justify-content:flex-end;gap:6px;">
              <input type="number" min="0" max="20" value="${c.settings.proactiveMin!=null?c.settings.proactiveMin:1}" id="cs-pmin">
              <span style="color:var(--text-secondary);">~</span>
              <input type="number" min="0" max="20" value="${c.settings.proactiveMax!=null?c.settings.proactiveMax:3}" id="cs-pmax">
              <span style="font-size:12px;color:var(--text-secondary);">条（0 表示该批次不发送）</span>
            </div>
          </span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="csSaveProactive()"><svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存主动消息设置</button>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-mail"/></svg> 主动来信</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">Ta 主动写信</span>
          <span class="cs-value" style="text-align:right;">
            <div class="switch ${c.settings.letterEnabled?'on':''}" onclick="csToggleLetter()"></div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">开启后每天 50% 概率寄来一封信</div>
          </span>
        </div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-phone"/></svg> 来电设置</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">主动来电</span>
          <span class="cs-value" style="text-align:right;">
            <div class="switch ${c.settings.incomingCall?'on':''}" onclick="csToggleIncomingCall()"></div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">每天每联系人3次，时间间隔≥30分钟</div>
          </span>
        </div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-palette"/></svg> 聊天背景（仅本联系人）</div>
      <div class="cs-card">
        <div class="cs-row">
          <span class="cs-label">聊天背景</span>
          <span class="cs-value" style="text-align:right;">
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button class="btn-outline btn" style="min-height:36px;padding:6px 14px;" onclick="document.getElementById('cs-bg-file').click()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-upload"/></svg> 上传图片</button>
              <input type="file" accept="image/*" id="cs-bg-file" class="hide" onchange="csUploadBg(this)">
              <button class="btn-outline btn" style="min-height:36px;padding:6px 14px;" onclick="csResetBg()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 清除</button>
            </div>
          </span>
        </div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-storage"/></svg> 内容库入口</div>
      <div class="cs-card">
        <div class="setting-item" style="padding:14px 0;box-shadow:none;" onclick="openCardLib()">
          <div class="setting-label"><span class="setting-icon"><svg class="i"><use href="#icon-pencil"/></svg></span><span>字卡库（${c.cardGroups.reduce((s,g)=>s+(g.cards?g.cards.length:0),0)} 张）</span></div>
          <span class="setting-arrow"><svg class="i i-sm"><use href="#icon-chevron-right"/></svg></span>
        </div>
        <div class="setting-item" style="padding:14px 0;border-top:1px solid var(--border-color);box-shadow:none;" onclick="openStickerLib('contact')">
          <div class="setting-label"><span class="setting-icon"><svg class="i"><use href="#icon-smile"/></svg></span><span>${escapeHtml(c.name)}的表情包（${(c.stickers||[]).length} 张）</span></div>
          <span class="setting-arrow"><svg class="i i-sm"><use href="#icon-chevron-right"/></svg></span>
        </div>
      </div>
    </div>
  `;
}
export async function csUpdateAvatar(input) {
  if (!input.files || !input.files.length) return;
  try {
    const d = await compressImage(input.files[0]);
    input.value = '';
    const c = await getContact(state.currentContactSettingId);
    c.avatar = d;
    await saveContact(c);
    renderContactSetting(state.currentContactSettingId);
    toast('头像已更新');
  } catch(e) { toast('图片处理失败'); }
}
export async function csEditName() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const name = prompt('修改名字：', c.name);
  if (name == null) return;
  const nm = name.trim();
  if (!nm) return toast('名字不能为空');
  c.name = nm;
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
export async function csDeleteContact() {
  if (!confirm('⚠️ 确定删除这个联系人？所有聊天记录、字卡、表情包都将永久删除！')) return;
  await deleteContact(state.currentContactSettingId);
  toast('已删除');
  state.currentContactSettingId = null;
  openPage('page-love');
  renderContacts();
}
export async function setStatusCurrent(sid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const s = (c.statusList||[]).find(x => x.id === sid);
  if (!s) return;
  c.status = s.name;
  c.statusAuto = false;
  c.nextStatusChangeAt = now() + randInt(30, 180) * 60 * 1000;
  await saveContact(c);
  // 切到更活跃状态后，立刻补算积压的未读+回复（概率<10%时被暂停的）
  enqueueTask(async () => await runCatchUp());
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
  if (state.currentContactId === c.id) {
    const rate = (typeof s.replyRate === 'number') ? s.replyRate : ({ '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 }[s.tier] || 50);
    $('chat-header-status').innerHTML = `<span class="status-dot" style="background:${rateColor(rate)};"></span>${escapeHtml(s.name)}`;
  }
  toast(`已设为「${s.name}」`);
}
export async function editStatus(sid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const s = (c.statusList||[]).find(x => x.id === sid); if (!s) return;
  const oldRate = (typeof s.replyRate === 'number') ? s.replyRate : ({ '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 }[s.tier] || 50);
  const name = prompt('状态名称：', s.name);
  if (name == null) return;
  const rrRaw = prompt('回复概率（0 到 100 的整数，单位%）：', String(oldRate));
  if (rrRaw == null) return;
  const rr = parseInt(rrRaw);
  if (isNaN(rr) || rr < 0 || rr > 100) return toast('概率无效，请填 0-100 的整数');
  s.name = name.trim() || s.name;
  s.replyRate = rr;
  delete s.tier;
  await saveContact(c);
  enqueueTask(async () => await runCatchUp());
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
export async function deleteStatus(sid) {
  if (!confirm('删除这个状态？')) return;
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const s = (c.statusList||[]).find(x => x.id === sid);
  c.statusList = (c.statusList||[]).filter(x => x.id !== sid);
  if (s && c.status === s.name) { c.status = c.statusList[0] ? c.statusList[0].name : ''; }
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
export async function csAddStatus() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const name = prompt('新状态名（如：读书、追剧、睡觉）：', '');
  if (name == null) return;
  const nm = name.trim();
  if (!nm) return toast('请输入状态名');
  const rrRaw = prompt('回复概率（0 到 100 的整数，建议：95=秒回 80=常回 50=看心情 15=很少回 3=不理人）：', '80');
  if (rrRaw == null) return;
  const rr = parseInt(rrRaw);
  if (isNaN(rr) || rr < 0 || rr > 100) return toast('概率无效，请填 0-100 的整数');
  c.statusList = c.statusList || [];
  c.statusList.push({ id: uid(), name: nm, replyRate: rr });
  if (!c.status) c.status = nm;
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
export async function csToggleStatusAuto() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.statusAuto = !(c.statusAuto !== false ? false : true);
  c.statusAuto = c.statusAuto ? false : true;
  // 上面的写法会混乱，直接用：当前是开，就变关，反之亦然
  // 重新读取保证准确
  const cc = await getContact(state.currentContactSettingId);
  cc.statusAuto = (cc.statusAuto !== false) ? false : true;
  cc.nextStatusChangeAt = now() + randInt(30, 180) * 60 * 1000;
  await saveContact(cc);
  renderContactSetting(state.currentContactSettingId);
}
export async function csSaveReply() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const fast = parseInt($('cs-fast').value) || 1;
  const slow = parseInt($('cs-slow').value) || 1;
  const repc = Math.min(10, Math.max(1, parseInt($('cs-repc').value) || 1));
  if (fast > slow*60) return toast('最快不能大于最慢');
  c.settings.fastSec = fast;
  c.settings.slowMin = slow;
  c.settings.replyCount = repc;
  await saveContact(c);
  toast('已保存');
}
export async function csSaveProactive() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  let mn = parseInt($('cs-pmin').value);
  let mx = parseInt($('cs-pmax').value);
  if (isNaN(mn) || mn < 0) mn = 0;
  if (isNaN(mx) || mx < 0) mx = 0;
  if (mn > mx) { const t = mn; mn = mx; mx = t; }
  if (mx > 50) mx = 50;
  c.settings.proactiveMin = mn;
  c.settings.proactiveMax = mx;
  if (c.settings.proactiveMsg) c.settings.nextProactiveAt = now() + randInt(2, 8) * 3600 * 1000;
  await saveContact(c);
  toast('主动消息设置已保存');
}
export async function csToggleProactive() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.settings.proactiveMsg = !c.settings.proactiveMsg;
  if (c.settings.proactiveMsg) {
    c.settings.nextProactiveAt = now() + randInt(2, 8) * 3600 * 1000;
  }
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
}
export async function csToggleIncomingCall() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.settings.incomingCall = !c.settings.incomingCall;
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
}
// 对我的专属称呼
export async function csEditMyNickname() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const r = await inputDialog('对我的专属称呼', [{ key: 'nick', label: '留空则使用「我的名字」', value: c.settings.myNickname || '', placeholder: '例如：宝贝、亲爱的' }], '保存');
  if (r == null) return;
  c.settings.myNickname = r.nick.trim();
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
  toast('专属称呼已保存');
}
// 主动来信开关：开启时随机 30 分钟~12 小时后寄出第一封，并标记今天已判定
export async function csToggleLetter() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.settings.letterEnabled = !c.settings.letterEnabled;
  if (c.settings.letterEnabled) {
    c.settings.nextLetterAt = now() + randInt(30, 720) * 60000;
    const d = new Date();
    c.letterDay = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  } else {
    c.settings.nextLetterAt = null;
  }
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
}
export async function csUploadBg(input) {
  if (!input.files || !input.files.length) return;
  try {
    const d = await compressImage(input.files[0], 1600, 0.82);
    input.value = '';
    const c = await getContact(state.currentContactSettingId);
    c.settings.chatBackground = { type:'image', value: d };
    await saveContact(c);
    toast('背景已更新');
    applyChatBg(c);
  } catch(e) { toast('图片处理失败'); }
}
export async function csResetBg() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.settings.chatBackground = null;
  await saveContact(c);
  toast('已清除');
  applyChatBg(c);
}

// ============ 字卡库 ============

export function openCardLib() {
  if (!state.currentContactSettingId) return;
  state.cardLibFrom = 'page-contact-setting';
  renderCardLib();
  openPage('page-card-lib');
}
export function backFromCardLib() { openPage(state.cardLibFrom); }
export async function renderCardLib() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  $('card-lib-title').textContent = `${c.name}的字卡库`;
  const box = $('card-groups');
  const groups = c.cardGroups || [];
  if (!groups.length) { box.innerHTML = `<div class="empty">还没有分组，点击上方按钮新建</div>`; return; }
  box.innerHTML = groups.map(g => {
    const count = (g.cards||[]).length;
    const cardsHtml = (g.cards||[]).map(card => `<div class="card-item" onclick="editCard('${escapeHtml(g.id)}','${escapeHtml(card.id)}')">
      <button class="del" onclick="event.stopPropagation();deleteCard('${escapeHtml(g.id)}','${escapeHtml(card.id)}')">✕</button>
      <div class="multi-ellipsis">${escapeHtml(card.content)}</div>
    </div>`).join('');
    return `<div class="group-block" id="grp-${escapeHtml(g.id)}">
      <div class="group-header" onclick="document.getElementById('grp-${escapeHtml(g.id)}').classList.toggle('collapsed')">
        <span><svg class="i i-sm collapse-arrow" style="width:14px;height:14px;transition:transform .2s;"><use href="#icon-chevron-down"/></svg> ${escapeHtml(g.name)}（${count}张）</span>
        <span class="group-actions">
          <button onclick="event.stopPropagation();addCard('${escapeHtml(g.id)}')" title="加字卡" style="display:flex;align-items:center;justify-content:center;"><svg class="i i-sm"><use href="#icon-plus"/></svg></button>
          <button onclick="event.stopPropagation();editCardGroup('${escapeHtml(g.id)}')" title="改名" style="display:flex;align-items:center;justify-content:center;"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
          <button onclick="event.stopPropagation();deleteCardGroup('${escapeHtml(g.id)}')" title="删分组" style="background:#fee2e2;color:#991b1b;display:flex;align-items:center;justify-content:center;"><svg class="i i-sm" style="stroke:#991b1b;"><use href="#icon-trash"/></svg></button>
        </span>
      </div>
      <div class="group-content">
        <div class="cards-grid">${cardsHtml || '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-secondary);">组内暂无字卡</div>'}</div>
      </div>
    </div>`;
  }).join('');
}
export function filterCardLib(keyword) {
  const box = $('card-groups');
  if (!box) return;
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) { renderCardLib(); return; }
  box.querySelectorAll('.group-block').forEach(group => {
    let hasVisible = false;
    group.querySelectorAll('.card-item').forEach(card => {
      const hit = card.textContent.toLowerCase().includes(kw);
      card.style.display = hit ? 'block' : 'none';
      if (hit) hasVisible = true;
    });
    group.style.display = hasVisible ? 'block' : 'none';
    if (hasVisible) group.classList.remove('collapsed');
  });
}
export async function createCardGroup() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const name = prompt('分组名：', '新分组');
  if (name == null) return;
  const nm = name.trim(); if (!nm) return toast('请输入分组名');
  c.cardGroups = c.cardGroups || [];
  c.cardGroups.push({ id: uid(), name: nm, cards: [] });
  await saveContact(c);
  renderCardLib();
}
export async function editCardGroup(gid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  const name = prompt('分组名：', g.name);
  if (name == null) return;
  const nm = name.trim(); if (!nm) return toast('请输入分组名');
  g.name = nm;
  await saveContact(c);
  renderCardLib();
}
export async function deleteCardGroup(gid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  if (!confirm(`删除分组「${g.name}」？组内${(g.cards||[]).length}张字卡将一并删除！`)) return;
  c.cardGroups = (c.cardGroups||[]).filter(x => x.id !== gid);
  await saveContact(c);
  renderCardLib();
}
export async function addCard(gid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  const content = prompt('字卡内容（一句话）：', '');
  if (content == null) return;
  const s = content.trim(); if (!s) return toast('请输入内容');
  g.cards = g.cards || [];
  g.cards.push({ id: uid(), content: s });
  await saveContact(c);
  renderCardLib();
}
export async function editCard(gid, cid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  const card = (g.cards||[]).find(x => x.id === cid); if (!card) return;
  const content = prompt('字卡内容：', card.content);
  if (content == null) return;
  const s = content.trim(); if (!s) return toast('内容不能为空');
  card.content = s;
  await saveContact(c);
  renderCardLib();
}
export async function deleteCard(gid, cid) {
  if (!confirm('删除这张字卡？')) return;
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  g.cards = (g.cards||[]).filter(x => x.id !== cid);
  await saveContact(c);
  renderCardLib();
}
export function openBatchImport() {
  const html = `<div class="form-row">
    <label class="form-label">导入到分组</label>
    <select class="input" id="bi-grp"></select>
  </div>
  <div class="form-row">
    <label class="form-label">粘贴字卡（每行一张）</label>
    <textarea class="textarea" id="bi-txt" placeholder="你好呀&#10;今天也要加油&#10;晚安～" style="min-height:220px;"></textarea>
  </div>`;
  showModal('批量导入字卡', html, [
    { label:'取消', cls:'btn-outline', onClick:closeModal },
    { label:'开始导入', cls:'btn', onClick: async () => {
      const c = await getContact(state.currentContactSettingId); if (!c) return;
      const gid = $('bi-grp').value;
      const txt = $('bi-txt').value;
      const g = (c.cardGroups||[]).find(x => x.id === gid);
      if (!g) return toast('请选择分组');
      if (!txt.trim()) return toast('请输入内容');
      const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) return toast('没有有效内容');
      // 查重
      const exist = new Set((g.cards||[]).map(x => x.content));
      let add = 0, dup = 0;
      for (const l of lines) {
        if (exist.has(l)) { dup++; continue; }
        g.cards.push({ id: uid(), content: l });
        exist.add(l);
        add++;
      }
      await saveContact(c);
      closeModal();
      toast(`导入${add}张${dup?`，跳过重复${dup}张`:''}`);
      renderCardLib();
    }}
  ]);
  // 填充下拉
  setTimeout(async () => {
    const c = await getContact(state.currentContactSettingId); if (!c) return;
    const sel = $('bi-grp'); if (!sel) return;
    if ((c.cardGroups||[]).length === 0) {
      // 自动建一个默认分组
      c.cardGroups = [{ id: uid(), name:'默认', cards: [] }];
      await saveContact(c);
    }
    sel.innerHTML = (c.cardGroups||[]).map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  }, 0);
}

// ============ 表情包库（管理页，两个tab） ============

export function openStickerLib(defaultTab='contact') {
  state.currentStkLibTab = defaultTab;
  state.stkLibFrom = 'page-contact-setting';
  // 设置tab名称
  const contactTabBtn = $('stk-tab-contact-name');
  if (state.currentContactSettingId) {
    getContact(state.currentContactSettingId).then(c => { if (c && contactTabBtn) contactTabBtn.textContent = `${c.name}的表情包`; });
  }
  switchStkTab(defaultTab, true);
  openPage('page-sticker-lib');
}
export function backFromStickerLib() { openPage(state.stkLibFrom); }
export function switchStkTab(tab, first=false) {
  state.currentStkLibTab = tab;
  document.querySelectorAll('.stk-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  renderStkLibGrid();
  if (!first) {}
}
export async function renderStkLibGrid() {
  const grid = $('stk-lib-grid'); if (!grid) return;
  let list = [];
  if (state.currentStkLibTab === 'mine') {
    const m = await getMe();
    list = (m.stickers || []).map(s => ({...s, _owner:'me'}));
  } else {
    const c = await getContact(state.currentContactSettingId);
    if (!c) return;
    list = (c.stickers || []).map(s => ({...s, _owner:'contact'}));
  }
  if (!list.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">还没有表情包</div>`; return; }
  grid.innerHTML = list.map(s => `<div class="sticker-mgr-item">
    <img src="${escapeHtml(s.data)}" alt="">
    <button class="del" onclick="deleteLibSticker('${escapeHtml(s.id)}','${s._owner}')">✕</button>
    ${s.name ? `<div class="name">${escapeHtml(s.name)}</div>` : ''}
  </div>`).join('');
}
export async function deleteLibSticker(id, owner) {
  if (!confirm('删除这张表情包？')) return;
  if (owner === 'me') {
    const m = await getMe();
    m.stickers = (m.stickers||[]).filter(x => x.id !== id);
    await saveMe(m);
  } else {
    const c = await getContact(state.currentContactSettingId); if (!c) return;
    c.stickers = (c.stickers||[]).filter(x => x.id !== id);
    await saveContact(c);
  }
  renderStkLibGrid();
}
export async function addLibStickers(input) {
  if (!input.files || !input.files.length) return;
  const files = Array.from(input.files);
  input.value = '';
  let added = 0, dup = 0;
  if (state.currentStkLibTab === 'mine') {
    const m = await getMe();
    m.stickers = m.stickers || [];
    const ex = new Set(m.stickers.map(s => s.data));
    for (const f of files) {
      try {
        const d = await compressImage(f, 800, 0.85);
        if (ex.has(d)) { dup++; continue; }
        m.stickers.push({ id: uid(), name:'', data:d });
        ex.add(d); added++;
      } catch(e) {}
    }
    await saveMe(m);
  } else {
    const c = await getContact(state.currentContactSettingId); if (!c) return;
    c.stickers = c.stickers || [];
    const ex = new Set(c.stickers.map(s => s.data));
    for (const f of files) {
      try {
        const d = await compressImage(f, 800, 0.85);
        if (ex.has(d)) { dup++; continue; }
        c.stickers.push({ id: uid(), name:'', data:d });
        ex.add(d); added++;
      } catch(e) {}
    }
    await saveContact(c);
  }
  renderStkLibGrid();
  toast(`添加${added}张${dup?`，跳过重复${dup}张`:''}`);
}

// ============ 设置页 UI ============
export function renderThemeUI(curTheme) {
  const t = curTheme && curTheme.themeColor ? curTheme : { themeColor: getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim() };
  const tc = t.themeColor || '#6b8aff';
  const tg = $('theme-grid'); if (tg) {
    tg.innerHTML = PRESET_COLORS.map(c =>
      `<div class="theme-color-swatch ${c===tc?'selected':''}" style="background:${c};" onclick="applyPresetColor('${c}')"></div>`
    ).join('');
  }
  const cc = $('custom-color'); if (cc) cc.value = tc;
  // 背景
  renderBgGrid(t);
  // CSS
  getTheme().then(thm => {
    const css = $('custom-css'); if (css) css.value = thm.customCSS || '';
  });
}
export function renderBgGrid(theme) {
  const bg = $('bg-grid'); if (!bg) return;
  getTheme().then(thm => {
    const cur = thm.background;
    bg.innerHTML = PRESET_BGS.map((b,i) => {
      let isSel = false;
      if (cur && cur.type === b.type && cur.value === b.css) isSel = true;
      if (!cur && i === 0) isSel = true;
      return `<div class="bg-swatch ${isSel?'selected':''}" style="background:${b.css};" title="${escapeHtml(b.name)}" onclick="applyPresetBg(${i})"></div>`;
    }).join('');
  });
}
export async function applyPresetColor(c) {
  const thm = await getTheme();
  thm.themeColor = c;
  await saveTheme(thm);
  renderThemeUI(thm);
}
export async function applyCustomColor(c) {
  const thm = await getTheme();
  thm.themeColor = c;
  await saveTheme(thm);
  renderThemeUI(thm);
}
export async function applyPresetBg(i) {
  const thm = await getTheme();
  const b = PRESET_BGS[i];
  thm.background = { type: b.type, value: b.css };
  await saveTheme(thm);
  renderBgGrid(thm);
}
export async function uploadBg(input) {
  if (!input.files || !input.files.length) return;
  try {
    const d = await compressImage(input.files[0], 1600, 0.82);
    input.value = '';
    const thm = await getTheme();
    thm.background = { type:'image', value: d };
    await saveTheme(thm);
    renderBgGrid(thm);
    toast('背景已更换');
  } catch(e) { toast('图片处理失败'); }
}
export async function resetBg() {
  const thm = await getTheme();
  thm.background = { type:'color', value: PRESET_BGS[0].css };
  await saveTheme(thm);
  renderBgGrid(thm);
  toast('已重置');
}
export async function saveCustomCSS() {
  const thm = await getTheme();
  thm.customCSS = $('custom-css').value || '';
  await saveTheme(thm);
  toast('自定义CSS已生效');
}
