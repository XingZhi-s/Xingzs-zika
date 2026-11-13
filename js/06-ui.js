// 依赖：04-chat.js
import { DEFAULT_AVATAR, PRESET_BGS, PRESET_COLORS, state, uid } from './01-state.js';
import { $, closeModal, compressImage, confirmDialog, escapeHtml, formatTime, inputDialog, now, randInt, showModal, toast } from './02-core.js';
import { applyChatBg, deleteContact, getAllContacts, getContact, getMe, getStatusCategories, getStatusPool, getTheme, normalizeContactStatus, openChat, openPage, rateColor, recordStatusWindow, renderContacts, renderMeBrief, saveContact, saveMe, saveStatusCategories, saveStatusPool, saveTheme } from './03-data.js';
import { renderChatMessages, sendStickerMessage } from './04-chat.js';
import { runCatchUp } from './08-main.js';

// ============ ME 页功能 ============
export async function updateMyAvatar(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  input.value = ''; // 立刻清空，保证下次选同一文件也能触发 onchange
  try {
    const d = await compressImage(file);
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
    <button class="del" onclick="deleteMySticker('${escapeHtml(s.id)}')"><svg class="i i-sm"><use href="#icon-close"/></svg></button>
    ${s.name ? `<div class="name">${escapeHtml(s.name)}</div>` : ''}
  </div>`).join('');
}
export async function deleteMySticker(id) {
  if (!await confirmDialog('删除这张表情包？')) return;
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
  closeStickerPanel();
  await sendStickerMessage(decodeURIComponent(encData));
}
// A15：表情面板可随时关闭（再点表情按钮 / 点外部 / 关闭按钮 / Esc），不发送任何消息
let _stickerDocBound = false;
function onStickerOutside(e) {
  const p = $('sticker-panel');
  if (!p || p.classList.contains('hide')) return;
  if (e.target.closest && (e.target.closest('#sticker-panel') || e.target.closest('#chat-sticker-toggle'))) return;
  closeStickerPanel();
}
function onStickerEsc(e) {
  if (e.key === 'Escape' || e.key === 'Esc') closeStickerPanel();
}
export function openStickerPanel() {
  const p = $('sticker-panel'); if (!p) return;
  p.classList.remove('hide');
  if (!_stickerDocBound) {
    document.addEventListener('pointerdown', onStickerOutside, true);
    document.addEventListener('keydown', onStickerEsc);
    _stickerDocBound = true;
  }
}
export function closeStickerPanel() {
  const p = $('sticker-panel'); if (!p) return;
  p.classList.add('hide');
  // A25：关闭后主动失焦，避免触发按钮残留高亮/焦点
  const btn = $('chat-sticker-toggle');
  if (btn) { btn.blur(); btn.classList.remove('active', 'focus'); }
  if (_stickerDocBound) {
    document.removeEventListener('pointerdown', onStickerOutside, true);
    document.removeEventListener('keydown', onStickerEsc);
    _stickerDocBound = false;
  }
}
export function toggleStickerPanel() {
  const p = $('sticker-panel'); if (!p) return;
  if (p.classList.contains('hide')) openStickerPanel(); else closeStickerPanel();
}

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
  // A25：状态来自共享池；为空/不在池内时随机取一个并写回
  const pool = await getStatusPool();
  await normalizeContactStatus(c, pool);
  const box = $('cs-content'); if (!box) return;
  const bgPos = (c.settings && c.settings.chatBgPos) || 'center';
  const cats = await getStatusCategories();
  // A18/A26：当前生效状态以 statusId 为准（兼容旧 status 名）
  const currentSid = (c.statusId && pool.some(s => s.id === c.statusId))
    ? c.statusId : (pool.find(s => s.name === c.status)?.id);
  // B1：只显示状态名与「当前」标记；大类与拆分比例仅在新建/编辑弹窗内设置
  const statusRows = pool.map(s => {
    const isCurrent = !!currentSid && s.id === currentSid;
    return `
      <div class="status-item${isCurrent ? ' current' : ''}">
        <div class="status-info">
          <div class="status-name">${escapeHtml(s.name)} ${isCurrent ? '<span class="tag" style="background:var(--theme-color);color:#fff;border:none;">当前</span>' : ''}</div>
        </div>
        <div class="status-actions">
          <button onclick="setStatusCurrent('${escapeHtml(s.id)}')" title="设为当前" style="display:flex;align-items:center;justify-content:center;"><svg class="i i-sm"><use href="#icon-check"/></svg></button>
          <button onclick="editStatus('${escapeHtml(s.id)}')" title="编辑" style="display:flex;align-items:center;justify-content:center;"><svg class="i i-sm"><use href="#icon-pencil"/></svg></button>
          <button style="background:#fee2e2;color:#991b1b;display:flex;align-items:center;justify-content:center;" onclick="deleteStatus('${escapeHtml(s.id)}')" title="删除"><svg class="i i-sm" style="stroke:#991b1b;"><use href="#icon-trash"/></svg></button>
        </div>
      </div>`;
  }).join('');
  const autoMode = c.statusAuto !== false;
  // 钱包与红包：只保留一行入口，具体参数在独立二级页（15-wallet.js）
  const walletEntryHtml = `
    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-wallet"/></svg> 钱包与红包</div>
      <div class="cs-card">
        <div class="cs-row cs-row-link" onclick="openContactWalletSettings()">
          <span class="cs-label">共用卡与红包参数</span>
          <span class="cs-value">进入设置<svg class="i i-sm"><use href="#icon-chevron-right"/></svg></span>
        </div>
      </div>
    </div>`;
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

    <div class="cs-search-bar">
      <svg class="i i-sm" style="stroke:var(--text-secondary);"><use href="#icon-search"/></svg>
      <input class="cs-search-input" id="cs-search-input" placeholder="搜索设置项，如：回复、背景、字卡、来电" oninput="csSearchJump(this.value)">
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-cog"/></svg> 生活状态</div>
      <div class="cs-card status-card">
        <div class="cs-row cs-row-switch">
          <span class="cs-label">自动切换</span>
          <span class="cs-value">
            <div class="switch ${autoMode?'on':''}" onclick="csToggleStatusAuto()"></div>
          </span>
        </div>
        ${statusRows || '<div style="padding:20px 0;text-align:center;color:var(--text-secondary);">还没有状态，点击下方按钮添加</div>'}
        <button class="btn btn-ghost" style="width:100%;margin-top:10px;" onclick="csAddStatus()">＋ 添加状态</button>
        <div id="cs-status-help" class="status-help hide">
          <div><b>已读并回复</b>：按该状态的「已读并回复的概率」掷骰，命中后会先已读，再发字卡回复。</div>
          <div><b>已读不回</b>：看到了消息，但这次不回复。</div>
          <div><b>未读</b>：一直没看，留到下次状态切换再判定；连续 3 个窗口未看会收尾为已读不回。睡觉类永远不会出现已读不回。</div>
        </div>
        <button class="status-help-btn status-help-corner" onclick="toggleStatusHelp()" title="状态说明">?</button>
        <div class="cs-hint status-hint">每 2~8 小时随机切换</div>
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
          <span class="cs-label">回复条数范围</span>
          <span class="cs-value" style="text-align:right;">
            <div class="range-row" style="justify-content:flex-end;">
              <input type="number" min="1" value="${(() => { const s=c.settings; let mn = s.replyCountMin != null ? s.replyCountMin : (s.replyCount||1); let mx = s.replyCountMax != null ? s.replyCountMax : mn; return mn; })()}" id="cs-repc-min">
              <span class="cs-unit">~</span>
              <input type="number" min="1" value="${(() => { const s=c.settings; let mn = s.replyCountMin != null ? s.replyCountMin : (s.replyCount||1); let mx = s.replyCountMax != null ? s.replyCountMax : mn; return mx; })()}" id="cs-repc-max">
              <span class="cs-unit">条</span>
            </div>
          </span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="csSaveReply()"><svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存回复设置</button>
        <div class="cs-hint">多条连发，每条间隔 1-3 秒</div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-heart"/></svg> 主动消息</div>
      <div class="cs-card">
        <div class="cs-row cs-row-switch">
          <span class="cs-label">主动发消息</span>
          <span class="cs-value">
            <div class="switch ${c.settings.proactiveMsg?'on':''}" onclick="csToggleProactive()"></div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">每批条数范围</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;gap:6px;">
              <input type="number" min="0" max="20" value="${c.settings.proactiveMin!=null?c.settings.proactiveMin:1}" id="cs-pmin">
              <span class="cs-unit">~</span>
              <input type="number" min="0" max="20" value="${c.settings.proactiveMax!=null?c.settings.proactiveMax:3}" id="cs-pmax">
              <span class="cs-unit">条</span>
            </div>
          </span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="csSaveProactive()"><svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存主动消息设置</button>
        <div class="cs-hint">开启后每 2~8 小时随机主动发一批；条数 0 表示该批次不发送</div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-mail"/></svg> 主动来信</div>
      <div class="cs-card">
        <div class="cs-row cs-row-switch">
          <span class="cs-label">Ta 主动写信</span>
          <span class="cs-value">
            <div class="switch ${c.settings.letterEnabled?'on':''}" onclick="csToggleLetter()"></div>
          </span>
        </div>
        <div class="cs-hint">开启后每天 50% 概率寄来一封信</div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-phone"/></svg> 来电设置</div>
      <div class="cs-card">
        <div class="cs-row cs-row-switch">
          <span class="cs-label">主动来电</span>
          <span class="cs-value">
            <div class="switch ${c.settings.incomingCall?'on':''}" onclick="csToggleIncomingCall()"></div>
          </span>
        </div>
        <div class="cs-row">
          <span class="cs-label">来电概率</span>
          <span class="cs-value">
            <div class="range-row" style="justify-content:flex-end;">
              <input type="number" min="0" max="100" step="1" value="${(c.settings && Number.isFinite(Number(c.settings.callRate))) ? Math.max(0, Math.min(100, Math.round(Number(c.settings.callRate)))) : 50}" id="cs-callrate">
              <span class="cs-unit">%</span>
            </div>
          </span>
        </div>
        <button class="btn" style="width:100%;margin-top:10px;" onclick="csSaveCallRate()"><svg class="i i-sm" style="margin-right:4px;stroke:#fff;"><use href="#icon-check"/></svg> 保存来电设置</button>
        <div class="cs-hint">每个联系人每天按此概率来电一次，睡觉类状态会顺延</div>
      </div>
    </div>

    ${walletEntryHtml}

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
        <div class="cs-row">
          <span class="cs-label">显示位置</span>
          <span class="cs-value">
            <div style="display:flex;gap:8px;justify-content:flex-end;width:100%;">
              <button class="bg-pos-btn${bgPos==='top'?' sel':''}" style="flex:0 0 auto;min-width:62px;" onclick="csSetBgPos('top')">靠上</button>
              <button class="bg-pos-btn${bgPos==='center'?' sel':''}" style="flex:0 0 auto;min-width:62px;" onclick="csSetBgPos('center')">居中</button>
              <button class="bg-pos-btn${bgPos==='bottom'?' sel':''}" style="flex:0 0 auto;min-width:62px;" onclick="csSetBgPos('bottom')">靠下</button>
            </div>
          </span>
        </div>
      </div>
    </div>

    <div class="cs-section">
      <div class="section-title"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-search"/></svg> 聊天记录</div>
      <div class="cs-card">
        <button class="btn btn-outline" style="width:100%;" onclick="csSearchChat()"><svg class="i i-sm"><use href="#icon-search"/></svg> 聊天记录查询</button>
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
  const file = input.files[0];
  input.value = ''; // 立刻清空，保证下次选同一文件也能触发 onchange
  try {
    const d = await compressImage(file);
    // 压缩完成后重新读取最新联系人数据再改，避免拿旧对象覆盖掉期间的其它写入
    const latestC = await getContact(state.currentContactSettingId);
    if (!latestC) return;
    latestC.avatar = d;
    await saveContact(latestC);
    renderContactSetting(state.currentContactSettingId);
    // 刷新联系人列表 + 若正在与该联系人聊天，同步刷新聊天界面头像
    renderContacts();
    if (state.currentContactId === latestC.id) await renderChatMessages(latestC.id, false);
    toast('头像已更新');
  } catch(e) { toast('图片处理失败'); }
}
export async function csEditName() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const r = await inputDialog('修改名字', [{ key: 'name', label: '联系人名字', value: c.name, required: true }], '保存');
  if (!r) return;
  const nm = (r.name || '').trim();
  if (!nm) return toast('名字不能为空');
  c.name = nm;
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
  // 刷新联系人列表 + 聊天界面顶栏/头像
  renderContacts();
  if (state.currentContactId === c.id) {
    $('chat-header-name').textContent = nm;
    await renderChatMessages(c.id, false);
  }
}
export async function csDeleteContact() {
  if (!await confirmDialog('确定删除这个联系人？所有聊天记录、字卡、表情包都将永久删除！')) return;
  await deleteContact(state.currentContactSettingId);
  toast('已删除');
  state.currentContactSettingId = null;
  openPage('page-love');
  renderContacts();
}
export async function setStatusCurrent(sid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const pool = await getStatusPool();
  const s = pool.find(x => x.id === sid);
  if (!s) return;
  const t = now();
  // 手动切换也是一次状态窗口：先记上一段，再以新状态开始新窗口
  recordStatusWindow(c, c.statusId, c.statusSince || t, t);
  c.statusId = s.id;
  c.status = s.name;
  c.statusAuto = false;
  c.statusSince = t;
  c.nextStatusAt = t + randInt(120, 480) * 60 * 1000;
  c.nextStatusChangeAt = c.nextStatusAt;
  c.manualSwitchAt = t;
  await saveContact(c);
  // 切到更活跃状态后，立刻补算积压的未读+回复（概率<10%时被暂停的）
  // runCatchUp 内部已自行入队，不要再包一层 enqueueTask（否则队列自锁）
  runCatchUp().catch(() => {});
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
  if (state.currentContactId === c.id) {
    const rate = (typeof s.replyRate === 'number') ? s.replyRate : ({ '秒回': 97, '常回': 80, '看心情': 50, '很少回': 20, '不理人': 5 }[s.tier] || 50);
    $('chat-header-status').innerHTML = `<span class="status-dot" style="background:${rateColor(rate)};"></span>${escapeHtml(s.name)}`;
  }
  toast(`已设为「${s.name}」`);
}
// A26：状态编辑弹窗（选大类 + 名称 + 已读并回复的概率）
function statusFormDialog(title, initial, cats) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    const catOpts = cats.map(x => `<option value="${escapeHtml(x.id)}"${x.id === initial.category ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
    const body = `
      <div class="status-form">
        <label class="status-form-row"><span>所属大类</span>
          <select id="_st-cat" class="input">${catOpts}</select>
        </label>
        <label class="status-form-row"><span>状态名称</span>
          <input id="_st-name" class="input" value="${escapeHtml(initial.name || '')}" placeholder="例如：读书、追剧">
        </label>
        <label class="status-form-row"><span>已读并回复的概率</span>
          <input id="_st-rate" class="input" type="number" min="0" max="100" value="${initial.rate != null ? initial.rate : 80}">
        </label>
        <div class="cs-hint">该数字表示「对方看到消息后，选择回复」的概率（0-100）：100 必回，0 从不回复。</div>
      </div>`;
    showModal(title, body, [
      { label: '取消', cls: 'btn-outline', onClick: () => finish(null) },
      { label: '保存', cls: 'btn', onClick: () => {
        const category = $('_st-cat').value;
        const name = ($('_st-name').value || '').trim();
        const rate = parseInt($('_st-rate').value);
        if (!name) return toast('请输入状态名');
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) return toast('概率无效，请填 0-100 的整数');
        if (!cats.some(x => x.id === category)) return toast('请选择所属大类');
        finish({ category, name, rate });
      } }
    ], () => finish(null));
  });
}
export async function editStatus(sid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const pool = await getStatusPool();
  const cats = await getStatusCategories();
  const s = pool.find(x => x.id === sid); if (!s) return;
  const oldRate = (typeof s.replyRate === 'number') ? s.replyRate : 50;
  const r = await statusFormDialog('编辑状态', {
    name: s.name,
    rate: oldRate,
    category: s.category || (cats[0] && cats[0].id)
  }, cats);
  if (!r) return;
  const oldName = s.name;
  const oldCategory = s.category;
  const newName = (r.name || '').trim() || s.name;
  if (newName !== oldName && pool.some(x => x.id !== sid && x.name === newName)) return toast('状态名已存在');
  s.name = newName;
  s.replyRate = r.rate;
  s.category = r.category;
  delete s.tier;
  // 改名时把正在使用旧名字的联系人一起改名，避免变成无效状态
  if (newName !== oldName) {
    const all = await getAllContacts();
    for (const x of all) if (x.status === oldName) { x.status = newName; await saveContact(x); }
  }
  await saveStatusPool(pool);
  if (oldCategory !== r.category) runCatchUp().catch(() => {});
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
export async function deleteStatus(sid) {
  if (!await confirmDialog('删除这个状态？')) return;
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const pool = await getStatusPool();
  if (pool.length <= 1) return toast('至少保留一个状态');
  if (!pool.some(x => x.id === sid)) return;
  const nextPool = pool.filter(x => x.id !== sid);
  await saveStatusPool(nextPool);
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
export async function csAddStatus() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const pool = await getStatusPool();
  const cats = await getStatusCategories();
  const r = await statusFormDialog('添加状态', { name: '', rate: 80, category: cats[0] && cats[0].id }, cats);
  if (!r) return;
  const nm = (r.name || '').trim();
  if (!nm) return toast('请输入状态名');
  if (pool.some(x => x.name === nm)) return toast('状态已存在');
  pool.push({ id: uid(), name: nm, category: r.category, replyRate: r.rate });
  await saveStatusPool(pool);
  renderContactSetting(state.currentContactSettingId);
  renderContacts();
}
// A26：大类拆分比例输入（两项联动，和为 100）
export async function csSetSplit(catId, key, value) {
  const cats = await getStatusCategories();
  const cat = cats.find(x => x.id === catId); if (!cat) return;
  let v = parseInt(value);
  if (!Number.isFinite(v)) v = 0;
  v = Math.max(0, Math.min(100, v));
  if (key === 'unread') { cat.unread = v; cat.readNoReply = 100 - v; }
  else { cat.readNoReply = v; cat.unread = 100 - v; }
  await saveStatusCategories(cats);
  renderContactSetting(state.currentContactSettingId);
}
export function toggleStatusHelp() {
  const el = $('cs-status-help');
  if (el) el.classList.toggle('hide');
}
export async function csToggleStatusAuto() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.statusAuto = (c.statusAuto !== false) ? false : true;
  const t = now();
  c.statusSince = t;
  c.nextStatusAt = t + randInt(120, 480) * 60 * 1000;
  c.nextStatusChangeAt = c.nextStatusAt;
  await saveContact(c);
  renderContactSetting(state.currentContactSettingId);
}
export async function csSaveReply() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const fast = parseInt($('cs-fast').value) || 1;
  const slow = parseInt($('cs-slow').value) || 1;
  let mn = parseInt($('cs-repc-min').value);
  let mx = parseInt($('cs-repc-max').value);
  // 条数不设上限，只保留 >=1 的输入校验；min/max 填反时自动交换
  if (isNaN(mn) || mn < 1) mn = 1;
  if (isNaN(mx) || mx < 1) mx = mn;
  if (mn > mx) { const t = mn; mn = mx; mx = t; }
  if (fast > slow*60) return toast('最快不能大于最慢');
  c.settings.fastSec = fast;
  c.settings.slowMin = slow;
  c.settings.replyCountMin = mn;
  c.settings.replyCountMax = mx;
  c.settings.replyCount = mx; // 旧字段兼容
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
// 来电概率：0–100 整数，非法/空回落到默认 50；今天还没触发过来电则立即按新概率重掷，已打过则明天生效
export async function csSaveCallRate() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const el = $('cs-callrate');
  let v = parseInt(el ? el.value : '', 10);
  if (isNaN(v)) v = 50;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  c.settings.callRate = v;
  const d = new Date(now());
  const todayStr = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  const fired = !!(c.callSlots && c.callSlots.date === todayStr && (c.callSlots.triggered || []).length);
  if (c.callSlots && c.callSlots.date === todayStr && !fired) c.callSlots = null;
  await saveContact(c);
  if (el) el.value = String(v); // 回填夹取后的值，避免输入框里留着非法值
  toast(`来电概率已保存：${v}%`);
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
  const file = input.files[0];
  input.value = ''; // 立刻清空，保证下次选同一文件也能触发 onchange
  try {
    const d = await compressImage(file, 1600, 0.82);
    // 压缩完成后重新读取最新联系人数据再改，避免拿旧对象覆盖掉期间的其它写入
    const latestC = await getContact(state.currentContactSettingId);
    if (!latestC) return;
    latestC.settings.chatBackground = { type:'image', value: d };
    await saveContact(latestC);
    toast('背景已更新');
    applyChatBg(latestC);
  } catch(e) { toast('图片处理失败'); }
}
export async function csResetBg() {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.settings.chatBackground = null;
  await saveContact(c);
  toast('已清除');
  applyChatBg(c);
}
// 聊天背景显示位置：top / center / bottom
export async function csSetBgPos(pos) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  c.settings.chatBgPos = pos;
  await saveContact(c);
  applyChatBg(c);
  renderContactSetting(state.currentContactSettingId);
}

// ============ 聊天记录查询（独立页面，纯文本渲染防卡顿） ============
const CHAT_SEARCH_MAX = 500; // 单次最多渲染条数，避免海量历史撑爆 DOM
// 转为纯文本摘要：图片/表情包绝不渲染 Base64，长文本截断 50 字
function chatSearchDisplay(m) {
  const t = m.type || 'text';
  if (t === 'image') return { text: '[图片]', full: '[图片]' };
  if (t === 'sticker') return { text: '[表情包]', full: '[表情包]' };
  if (t === 'choice') {
    const q = String((m.choice && m.choice.question) || '').replace(/\s+/g, ' ').trim();
    return { text: '[选择] ' + (q.length > 50 ? q.slice(0, 50) + '...' : q), full: '[选择] ' + q };
  }
  const raw = String(m.content || '').replace(/\s+/g, ' ').trim();
  return { text: raw ? (raw.length > 50 ? raw.slice(0, 50) + '...' : raw) : '（空消息）', full: raw };
}
export function csSearchChat() {
  if (!state.currentContactSettingId) return;
  state.chatSearchContactId = state.currentContactSettingId;
  openPage('page-chat-search');
  const i = $('chat-search-input'); if (i) i.value = '';
  csSearchChatRender('');
  setTimeout(() => { if (i) i.focus(); }, 80);
}
export function backFromChatSearch() { openPage('page-contact-setting'); }
export async function csSearchChatRender(kw) {
  const box = $('chat-search-list'); if (!box) return;
  const c = await getContact(state.chatSearchContactId || state.currentContactSettingId); if (!c) { box.innerHTML = ''; return; }
  const q = (kw || '').trim().toLowerCase();
  const all = c.messages || [];
  const hits = q ? all.filter(m => chatSearchDisplay(m).full.toLowerCase().includes(q)) : all;
  const shown = hits.slice(-CHAT_SEARCH_MAX);
  const tip = $('chat-search-tip');
  if (tip) {
    tip.textContent = q
      ? `找到 ${hits.length} 条${hits.length > CHAT_SEARCH_MAX ? `（仅显示最近 ${CHAT_SEARCH_MAX} 条）` : ''}`
      : `共 ${all.length} 条聊天记录${all.length > CHAT_SEARCH_MAX ? `（仅显示最近 ${CHAT_SEARCH_MAX} 条）` : ''}`;
  }
  if (!shown.length) {
    box.innerHTML = `<div class="chat-search-empty">${q ? '没有找到匹配的记录' : '暂无聊天记录'}</div>`;
    return;
  }
  box.innerHTML = shown.map(m => {
    const mine = m.from === 'me';
    const d = chatSearchDisplay(m);
    return `<div class="chat-search-row${mine ? ' me' : ''}">
      <div class="csr-meta"><span class="csr-name">${mine ? '我' : escapeHtml(c.name)}</span><span class="csr-time">${formatTime(m.time)}</span></div>
      <div class="csr-text">${escapeHtml(d.text)}</div>
    </div>`;
  }).join('');
  // 未搜索时定位到最新一条（列表底部）
  if (!q) {
    const body = box.closest('.chat-search-body');
    if (body) body.scrollTop = body.scrollHeight;
  }
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
      <button class="del" onclick="event.stopPropagation();deleteCard('${escapeHtml(g.id)}','${escapeHtml(card.id)}')"><svg class="i i-sm"><use href="#icon-close"/></svg></button>
      <div class="multi-ellipsis">${escapeHtml(card.content)}</div>
    </div>`).join('');
    // 默认折叠：所有分组初始都收起，点标题再展开
    return `<div class="group-block collapsed" id="grp-${escapeHtml(g.id)}">
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
// 联系人设置项搜索：不隐藏任何模块，命中后平滑滚动到该模块并短暂高亮
export function csSearchJump(kw) {
  const q = (kw || '').trim().toLowerCase();
  const box = $('cs-content');
  if (!box || !q) return;
  const secs = Array.from(box.querySelectorAll('.cs-section'));
  const hit = secs.find(s => s.textContent.toLowerCase().includes(q));
  if (!hit) { toast('没有找到匹配的设置项'); return; }
  hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
  hit.classList.remove('cs-flash');
  void hit.offsetWidth;
  hit.classList.add('cs-flash');
  setTimeout(() => hit.classList.remove('cs-flash'), 900);
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
  const r = await inputDialog('新建分组', [{ key: 'name', label: '分组名', value: '新分组', required: true }], '创建');
  if (!r) return;
  const nm = (r.name || '').trim(); if (!nm) return toast('请输入分组名');
  c.cardGroups = c.cardGroups || [];
  c.cardGroups.push({ id: uid(), name: nm, cards: [] });
  await saveContact(c);
  renderCardLib();
}
export async function editCardGroup(gid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  const r = await inputDialog('分组改名', [{ key: 'name', label: '分组名', value: g.name, required: true }], '保存');
  if (!r) return;
  const nm = (r.name || '').trim(); if (!nm) return toast('请输入分组名');
  g.name = nm;
  await saveContact(c);
  renderCardLib();
}
export async function deleteCardGroup(gid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  if (!await confirmDialog(`删除分组「${g.name}」？组内${(g.cards||[]).length}张字卡将一并删除！`)) return;
  c.cardGroups = (c.cardGroups||[]).filter(x => x.id !== gid);
  await saveContact(c);
  renderCardLib();
}
export async function addCard(gid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  const r = await inputDialog('添加字卡', [{ key:'content', label:'字卡内容（一句话）', placeholder:'例如：我想你了' }]);
  if (!r) return;
  const s = (r.content || '').trim(); if (!s) return toast('请输入内容');
  g.cards = g.cards || [];
  // 去重：同分组内已存在相同内容则拦截
  if (g.cards.some(x => x.content === s)) return toast('该分组已有相同内容的字卡');
  g.cards.push({ id: uid(), content: s });
  await saveContact(c);
  renderCardLib();
}
export async function editCard(gid, cid) {
  const c = await getContact(state.currentContactSettingId); if (!c) return;
  const g = (c.cardGroups||[]).find(x => x.id === gid); if (!g) return;
  const card = (g.cards||[]).find(x => x.id === cid); if (!card) return;
  const r = await inputDialog('编辑字卡', [{ key:'content', label:'字卡内容', value: card.content }]);
  if (!r) return;
  const s = (r.content || '').trim(); if (!s) return toast('内容不能为空');
  // 去重：改成与同组其它字卡相同的内容则拦截
  if (g.cards.some(x => x.id !== cid && x.content === s)) return toast('该分组已有相同内容的字卡');
  card.content = s;
  await saveContact(c);
  renderCardLib();
}
export async function deleteCard(gid, cid) {
  if (!await confirmDialog('删除这张字卡？')) return;
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
      let add = 0, dupList = [];
      for (const l of lines) {
        if (exist.has(l)) { dupList.push(l); continue; }
        g.cards.push({ id: uid(), content: l });
        exist.add(l);
        add++;
      }
      await saveContact(c);
      closeModal();
      toast(`导入${add}张${dupList.length?`，跳过重复${dupList.length}张：${dupList.slice(0,3).join(' / ')}${dupList.length>3?'…':''}`:''}`);
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
    <button class="del" onclick="deleteLibSticker('${escapeHtml(s.id)}','${s._owner}')"><svg class="i i-sm"><use href="#icon-close"/></svg></button>
    ${s.name ? `<div class="name">${escapeHtml(s.name)}</div>` : ''}
  </div>`).join('');
}
export async function deleteLibSticker(id, owner) {
  if (!await confirmDialog('删除这张表情包？')) return;
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
    // 同步背景位置按钮选中态
    const pos = thm.backgroundPos || 'center';
    for (const p of ['top', 'center', 'bottom']) {
      const btn = $('bg-pos-' + p);
      if (btn) btn.classList.toggle('sel', p === pos);
    }
  });
}
// 全局背景图显示位置：top / center / bottom
export async function setBgPos(pos) {
  const thm = await getTheme();
  thm.backgroundPos = pos;
  await saveTheme(thm);
  renderBgGrid(thm);
  toast('背景位置已更新');
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
  const file = input.files[0];
  input.value = ''; // 立刻清空，保证下次选同一文件也能触发 onchange
  try {
    const d = await compressImage(file, 1600, 0.82);
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
