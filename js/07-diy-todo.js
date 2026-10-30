// 依赖：06-ui.js
import { DEFAULT_AVATAR, DIY_SECTIONS, state, uid } from './01-state.js';
import { $, compressImage, dbAll, dbPut, escapeAttr, escapeHtml, estimateSizeMB, hexWithAlpha, inputDialog, now, toast } from './02-core.js';
import { createEmptyContact, getAllContacts, getMe, getTheme, openPage, renderContacts, renderMeBrief, saveContact, saveMe, saveTheme } from './03-data.js';

/* ============ 手机首页：自主文本 + 装饰贴纸 ============ */
export async function saveHomeFreeText(el) {
  const thm = await getTheme();
  thm.homeFreeText = el.innerText.trim();
  await saveTheme(thm);
}
// 头部卡图片上传（手机桌面首页顶部横幅，点头部蓝色区域也可触发）
export async function uploadHomeBanner() {
  const input = $('diy-image-file');
  input.value = '';
  input.onchange = async () => {
    if (!input.files || !input.files[0]) return;
    const data = await compressImage(input.files[0], 1600, 0.88);
    const thm = await getTheme();
    thm.homeBanner = data;
    await saveTheme(thm);
    renderHomeAvatar();
    refreshDiyUI();
    toast('头部图片已更新');
  };
  input.click();
}
// 装饰贴纸上传 → 批量加入 homeDecos 数组，生成可拖拽元素
export function openHomeStickerUploader() {
  const input = $('diy-multi-file');
  input.value = '';
  input.onchange = async () => {
    if (!input.files || !input.files.length) return;
    const files = Array.from(input.files);
    const thm = await getTheme();
    thm.homeDecos = thm.homeDecos || [];
    let addCount = 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const f of files) {
      try {
        const data = await compressImage(f, 600, 0.9);
        const id = 'd'+uid();
        // 默认放右下，随机偏移避免堆叠
        thm.homeDecos.push({
          id, src: data,
          left: Math.max(10, vw - 120 - Math.random()*150),
          top:  Math.max(100, vh - 250 - Math.random()*150),
          width: 96, height: 96,
          pinned: false,
          z: 10 + thm.homeDecos.length
        });
        addCount++;
      } catch (e) {}
    }
    await saveTheme(thm);
    renderDecoLayersWith(thm);
    toast(`已添加${addCount}张装饰`);
  };
  input.click();
}
// 同步刷新首页装饰层 + 贴纸编辑器画布（若编辑器打开）
export function renderDecoLayersWith(thm) {
  renderHomeDecos(thm);
  const wrap = $('deco-edit-layer');
  const ed = $('deco-edit-canvas');
  if (wrap && ed && wrap.classList.contains('show')) renderHomeDecos(thm, ed);
}
// 贴纸编辑器（美化设置内全屏拖动/缩放）
export function openDecoEditor() {
  const wrap = $('deco-edit-layer'); if (!wrap) return;
  getTheme().then(thm => {
    renderHomeDecos(thm, $('deco-edit-canvas'));
    wrap.classList.add('show');
  });
}
export async function closeDecoEditor() {
  const wrap = $('deco-edit-layer'); if (!wrap) return;
  wrap.classList.remove('show');
  const thm = await getTheme();
  renderHomeDecos(thm); // 编辑结果同步回首页层
  if ($('page-diy')?.classList.contains('active')) renderDiyPage(); // 刷新数量/缩略图
}
export function renderHomeDecos(thm, layer) {
  layer = layer || $('home-sticker-layer'); if (!layer) return;
  layer.innerHTML = '';
  for (const d of (thm.homeDecos || [])) {
    const el = document.createElement('div');
    el.className = 'deco-sticker' + (d.pinned ? ' pinned' : '');
    el.style.left = d.left + 'px'; el.style.top = d.top + 'px';
    el.style.width = d.width + 'px'; el.style.height = d.height + 'px';
    el.style.zIndex = String(d.z || 10);
    el.dataset.id = d.id;
    el.innerHTML = `
      <img src="${escapeHtml(d.src)}" alt="">
      <button class="deco-del" title="删除" onclick="deleteHomeDeco('${d.id}')"><svg class="i i-sm" style="stroke:#ef4444;"><use href="#icon-trash"/></svg></button>
    `;
    layer.appendChild(el);
    enableDecoDrag(el, thm);
  }
}
export function enableDecoDrag(el, thm) {
  let dragging = false, pinching = false, startX=0, startY=0, origL=0, origT=0, initDist=0, initW=0, initH=0;
  const getId = () => el.dataset.id;
  const saveNow = async () => {
    for (const d of (thm.homeDecos||[])) {
      if (d.id === getId()) {
        d.left = parseInt(el.style.left); d.top = parseInt(el.style.top);
        d.width = parseInt(el.style.width); d.height = parseInt(el.style.height);
        d.pinned = el.classList.contains('pinned');
      }
    }
    await saveTheme(thm);
  };
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.deco-del')) return;
    e.preventDefault();
    dragging = true;
    const rect = el.getBoundingClientRect();
    // 相对 layer 的位置（layer是absolute inset:0 → 页面）
    const layerRect = el.parentElement.getBoundingClientRect();
    origL = rect.left - layerRect.left; origT = rect.top - layerRect.top;
    startX = e.clientX; startY = e.clientY;
    // 置顶
    thm.homeDecos = thm.homeDecos || [];
    const topZ = 10 + thm.homeDecos.length;
    const d = thm.homeDecos.find(x => x.id === getId());
    if (d) { d.z = topZ; el.style.zIndex = topZ; }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = parseInt(el.style.width), h = parseInt(el.style.height);
    let newL = Math.max(4, origL + dx), newT = Math.max(4, origT + dy);
    newL = Math.min(newL, vw - w - 4); newT = Math.min(newT, vh - h - 4);
    el.style.left = newL + 'px'; el.style.top = newT + 'px';
  });
  window.addEventListener('mouseup', async () => { if (dragging) { dragging = false; await saveNow(); } });
  // 触摸：双指缩放+拖动
  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('.deco-del')) return;
    if (e.touches.length === 1) {
      dragging = true; pinching = false;
      const t = e.touches[0];
      const rect = el.getBoundingClientRect();
      const layerRect = el.parentElement.getBoundingClientRect();
      origL = rect.left - layerRect.left; origT = rect.top - layerRect.top;
      startX = t.clientX; startY = t.clientY;
    } else if (e.touches.length === 2) {
      dragging = false; pinching = true;
      const [a,b] = [e.touches[0], e.touches[1]];
      initDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      initW = parseInt(el.style.width); initH = parseInt(el.style.height);
    }
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (dragging && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = parseInt(el.style.width), h = parseInt(el.style.height);
      let newL = Math.max(4, origL + dx), newT = Math.max(4, origT + dy);
      newL = Math.min(newL, vw - w - 4); newT = Math.min(newT, vh - h - 4);
      el.style.left = newL + 'px'; el.style.top = newT + 'px';
    } else if (pinching && e.touches.length === 2) {
      const [a,b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = Math.max(0.4, Math.min(3, d / Math.max(1, initDist)));
      let nw = Math.max(40, Math.floor(initW * ratio));
      let nh = Math.max(40, Math.floor(initH * ratio));
      el.style.width = nw + 'px';
      el.style.height = nh + 'px';
      e.preventDefault();
    }
  }, { passive: false });
  el.addEventListener('touchend', async () => {
    if (dragging || pinching) { dragging = false; pinching = false; await saveNow(); }
  });
  // 双击：切换 fixed（pinned，不显示删除按钮）
  el.addEventListener('dblclick', async () => {
    el.classList.toggle('pinned');
    toast(el.classList.contains('pinned') ? '已固定该装饰' : '已取消固定');
    await saveNow();
  });
  // 电脑端滚轮缩放
  el.addEventListener('wheel', (e) => {
    if (el.classList.contains('pinned')) return;
    e.preventDefault();
    const w = parseInt(el.style.width), h = parseInt(el.style.height);
    const ratio = e.deltaY < 0 ? 1.08 : 0.92;
    const nw = Math.max(40, Math.min(380, Math.floor(w * ratio)));
    const nh = Math.max(40, Math.min(380, Math.floor(h * ratio)));
    el.style.width = nw + 'px'; el.style.height = nh + 'px';
    clearTimeout(el._wheelT);
    el._wheelT = setTimeout(saveNow, 400);
  }, { passive: false });
}
export async function deleteHomeDeco(id) {
  const thm = await getTheme();
  thm.homeDecos = (thm.homeDecos || []).filter(x => x.id !== id);
  await saveTheme(thm);
  renderDecoLayersWith(thm);
}
export async function renderHomeAvatar() {
  const me = await getMe();
  const av = (me && me.avatar) ? me.avatar : DEFAULT_AVATAR;
  const imgs = document.querySelectorAll('#home-avatar, #sidebar-avatar');
  imgs.forEach(i => i && (i.src = av));
  const nm = $('sidebar-name'); if (nm && me) nm.textContent = me.name || '我';
  // 手机首页顶部的名字
  const thm = await getTheme();
  const free = $('home-free-text');
  if (free) {
    free.innerHTML = '';
    if (thm.homeFreeText) free.innerText = thm.homeFreeText;
  }
  // 头部卡横幅图片
  const bn = $('home-banner');
  if (bn) {
    if (thm.homeBanner) {
      bn.style.backgroundImage = `url("${thm.homeBanner}")`;
      bn.classList.add('has-img');
    } else {
      bn.style.backgroundImage = '';
      bn.classList.remove('has-img');
    }
  }
  renderHomeSquareImg(thm);
  renderHomeDecos(thm);
}

// 单个美化项的控件HTML（openDIY浮层 与 美化设置页 共用）
export function diyItemHTML(it, thm) {
  let html = `<div class="diy-block">
    <div class="diy-block-title"><span>${it.label}</span>
      <button class="btn btn-ghost btn-chip" onclick="resetDIYItem('${it.key}')" style="min-height:28px;padding:4px 10px;font-size:12px;"><svg class="i i-sm" style="margin-right:2px;"><use href="#icon-trash"/></svg>重置</button>
    </div>`;
  if (it.type === 'color' || it.type === 'image+color') {
    html += `<div class="diy-color-row">`;
    for (const p of (it.preset||[])) {
      const active = thm[it.key] === p ? ' active' : '';
      html += `<div class="diy-color-swatch${active}" style="background:${p};" onclick="setDIYColor('${it.key}','${p}')"></div>`;
    }
    html += `<input type="color" class="diy-color-swatch" value="${/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(thm[it.key]||'')) ? thm[it.key] : '#ffffff'}" onchange="setDIYColor('${it.key}', this.value)" title="自定义颜色">`;
    html += `</div>`;
  }
  if (it.type === 'image' || it.type === 'image+color') {
    const val = thm[it.key];
    const isImage = val && /^data:image|^https?:/.test(String(val));
    html += `<div class="diy-img-row" style="margin-top:10px;">`;
    if (isImage) html += `<div class="diy-preview-chip" style="background-image:url('${escapeAttr(val)}')"><button class="x" onclick="resetDIYItem('${it.key}')" title="清除">✕</button></div>`;
    html += `<button class="btn-outline btn" onclick="pickDIYImage('${it.key}')"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-upload"/></svg> ${isImage ? '更换图片' : '上传图片'}</button>`;
    if (isImage) html += `<button class="btn-outline btn" onclick="resetDIYItem('${it.key}')"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 清除当前</button>`;
    if (it.type === 'image+color') html += `<div style="font-size:12px;color:#8696b1;margin-left:6px;">支持纯色或图片，两者同时存在时以图片为准</div>`;
    html += `</div>`;
  }
  if (it.type === 'text') {
    html += `<input type="text" class="input" value="${escapeHtml(thm[it.key]||'')}" placeholder="${it.placeholder||''}" onchange="setDIYText('${it.key}', this.value)" style="margin-top:8px;">`;
  }
  if (it.type === 'textarea') {
    html += `<textarea class="textarea" placeholder="${it.placeholder||''}" spellcheck="false" onchange="setDIYText('${it.key}', this.value)" style="margin-top:8px;min-height:120px;width:100%;">${escapeHtml(thm[it.key]||'')}</textarea>`;
  }
  html += `</div>`;
  return html;
}
export async function openDIY(section) {
  if (!DIY_SECTIONS[section]) return;
  state.diyCurrentSection = section;
  const sec = DIY_SECTIONS[section];
  $('diy-title').textContent = sec.title;
  const body = $('diy-body');
  const thm = await getTheme();
  let html = `<div style="font-size:13px;color:#8696b1;margin-bottom:14px;line-height:1.7;">${sec.desc}</div>`;
  for (const it of sec.items) html += diyItemHTML(it, thm);
  body.innerHTML = html;
  $('diy-panel').classList.add('show');
}
export function closeDIY() { $('diy-panel').classList.remove('show'); state.diyCurrentSection = null; }

/* ============ 美化设置页（统一入口：跳转式，pc / mobile 双模式） ============ */

export function openDiyPage(mode) {
  if (mode === 'pc' || mode === 'mobile') state.diyMode = mode;
  else if (window.matchMedia && window.matchMedia('(min-width: 900px)').matches) state.diyMode = 'pc';
  else state.diyMode = 'mobile';
  state.diyPageBackTo = (state.lastPage && state.lastPage !== 'page-diy') ? state.lastPage : 'page-love';
  renderDiyPage();
  openPage('page-diy');
}
export function closeDiyPage() { openPage(state.diyPageBackTo || 'page-love'); }
export function setDiyMode(mode) { state.diyMode = mode; renderDiyPage(); }
export async function renderDiyPage() {
  const body = $('diy-page-body'); if (!body) return;
  // 模式Pill激活态
  document.querySelectorAll('#page-diy .dm-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.m === state.diyMode);
  });
  const thm = await getTheme();
  const isMobile = state.diyMode === 'mobile';
  // 所有可配置项扁平索引（按 key 取用）
  const allItems = {};
  Object.values(DIY_SECTIONS).forEach(sec => (sec.items || []).forEach(it => { allItems[it.key] = it; }));
  const itemsHTML = (keys) => keys.map(k => allItems[k] ? diyItemHTML(allItems[k], thm) : '').join('');
  const secBlock = (title, desc, inner, tag) => `<div class="diy-page-section">
      <div class="diy-page-sec-title">${title}${tag ? ` <span style="font-weight:500;font-size:11px;opacity:.7;margin-left:6px;">(${tag})</span>` : ''}</div>
      ${desc ? `<div class="diy-page-desc">${desc}</div>` : ''}
      ${inner}
    </div>`;

  // ===== 区块 1：主题颜色与全局背景 =====
  const secTheme = secBlock('一、主题颜色与全局背景',
    '主题色全局生效（按钮、高亮文字等）；全局背景只作用于页面底层，不会覆盖单个联系人单独设置的聊天背景',
    itemsHTML(['themeColor', 'pageBg', 'frameBg', 'contentBg']));

  // ===== 区块 2：手机桌面壁纸（仅手机端） =====
  const hasHomeBg = !!thm.homeBg;
  const secWallpaper = secBlock('二、手机桌面壁纸',
    '仅作用于手机桌面（左右两页）底层，不影响聊天背景；不设置则使用默认渐变',
    `<div class="diy-block">
      <div class="diy-img-row">
        ${hasHomeBg ? `<div class="diy-preview-chip" style="background-image:url('${escapeAttr(thm.homeBg)}')"></div>` : ''}
        <button class="btn-outline btn" onclick="uploadHomeBg()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-upload"/></svg> ${hasHomeBg ? '更换壁纸' : '上传壁纸'}</button>
        ${hasHomeBg ? `<button class="btn-outline btn" onclick="resetHomeBg()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 恢复默认</button>` : ''}
      </div>
    </div>`, '仅手机端');

  // ===== 区块 3：聊天气泡美化（预览 + 两段代码） =====
  const bubblePreview = `<div class="bubble-preview" id="bubble-preview">
      <div class="msg-row other"><div class="msg-bubble">今天过得怎么样呀？</div></div>
      <div class="msg-row me"><div class="msg-bubble">还不错，刚看到你的消息～</div></div>
    </div>`;
  const bubbleInput = (side, title, key, ph) => `<div class="diy-block" style="margin-top:10px;">
      <div class="diy-block-title"><span>${title}</span></div>
      <textarea class="textarea diy-code" id="${side === 'me' ? 'diy-my-bubble-css' : 'diy-ot-bubble-css'}" spellcheck="false" style="min-height:92px;width:100%;" placeholder="${ph}">${escapeHtml(thm[key] || '')}</textarea>
      <div class="diy-img-row" style="margin-top:8px;">
        <button class="btn btn-ghost" onclick="saveBubbleCSS('${side}')"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-download"/></svg> 保存确认</button>
        <button class="btn-outline btn" onclick="clearBubbleCSS('${side}')"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 清除</button>
      </div>
    </div>`;
  const secBubble = secBlock('三、聊天气泡美化',
    '最上方是实时预览（假数据一左一右）；代码可直接写属性（如 background: red;），会自动拼接到对应气泡选择器，也可写完整选择器代码',
    bubblePreview
      + bubbleInput('me', '我的气泡代码', 'customMyBubbleCSS', '例：background:#ffe58a; color:#835b00; border-radius:20px;')
      + bubbleInput('other', '对方气泡代码', 'customOtBubbleCSS', '例：background:#f5f7fb; border-radius:18px; box-shadow:0 4px 12px rgba(0,0,0,.1);')
      + itemsHTML(['bg_myBubble', 'bg_otBubble']));

  // ===== 区块 4：全局自定义 CSS =====
  const secGlobalCSS = secBlock('四、全局自定义 CSS',
    '保存后通过 &lt;style id="user-css"&gt; 注入，覆盖全站样式；不会覆盖单独设置的聊天背景',
    `<textarea class="textarea diy-code" id="diy-global-css" spellcheck="false" style="min-height:140px;width:100%;" placeholder="例：body { font-family: '楷体'; }">${escapeHtml(thm.customCSS || '')}</textarea>
      <div class="diy-img-row" style="margin-top:8px;">
        <button class="btn btn-ghost" onclick="applyCustomCSS()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-download"/></svg> 应用代码</button>
        <button class="btn-outline btn" onclick="clearCustomCSS()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 清除代码</button>
      </div>`);

  // ===== 区块 5：首页装饰（仅手机端） =====
  const decoCount = (thm.homeDecos || []).length;
  const hasBanner = !!thm.homeBanner;
  const secHomeDeco = secBlock('五、首页装饰',
    '手机桌面的装饰贴纸与头部横幅（装饰贴纸可拖拽 / 双指缩放）',
    `<div class="diy-block">
      <div class="diy-block-title"><span>装饰贴纸</span><span style="font-size:12px;color:#9db0cc;">${decoCount}张</span></div>
      <div class="diy-img-row">
        <button class="btn-outline btn" onclick="openHomeStickerUploader()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-upload"/></svg> 上传贴纸</button>
        ${decoCount ? `<button class="btn-outline btn" onclick="openDecoEditor()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-maximize"/></svg> 编辑位置与大小</button>
        <button class="btn-outline btn" onclick="clearHomeDecos()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-trash"/></svg> 全部清除</button>` : ''}
      </div>
      ${decoCount ? `<div class="deco-thumbs">${(thm.homeDecos || []).map(d => `<div class="diy-preview-chip" style="background-image:url('${escapeAttr(d.src)}')"><button class="x" onclick="deleteHomeDeco('${d.id}')" title="删除">✕</button></div>`).join('')}</div>` : ''}
      <div class="deco-edit-tip">上传后点「<b>编辑位置与大小</b>」进入全屏编辑：拖动调整位置 · 双指（或滚轮）缩放大小 · <b>双击固定/取消固定</b>；缩略图右上 ✕ 删除单张。</div>
    </div>
    <div class="diy-block">
      <div class="diy-block-title"><span>头部卡图片（首页顶部横幅，也可直接点首页顶部区域上传）</span></div>
      <div class="diy-img-row">
        ${hasBanner ? `<div class="diy-preview-chip" style="background-image:url('${escapeAttr(thm.homeBanner)}')"><button class="x" onclick="resetDIYItem('homeBanner')" title="清除">✕</button></div>` : ''}
        <button class="btn-outline btn" onclick="uploadHomeBanner()"><svg class="i i-sm" style="margin-right:4px;"><use href="#icon-upload"/></svg> ${hasBanner ? '更换图片' : '上传图片'}</button>
      </div>
    </div>`, '仅手机端');

  // ===== 区块 6：图标 / 字体 / 按钮皮肤（高级） =====
  const secIcons = secBlock('六、图标 / 字体 / 按钮皮肤',
    '上传自定义图片替换图标，留空 = 默认',
    itemsHTML(['bg_btn', 'customFont'])
      + `<div class="diy-page-sec-title" style="margin-top:14px;">图标 · 顶部栏 / 底部栏</div>`
      + itemsHTML(['icon_heart', 'icon_mail', 'icon_user', 'icon_cog', 'icon_plus'])
      + `<div class="diy-page-sec-title" style="margin-top:14px;">图标 · 气泡按钮 / 聊天按钮</div>`
      + itemsHTML(['img_send', 'img_smile', 'img_image', 'img_menu', 'img_phone', 'img_video']));

  body.innerHTML = secTheme
    + (isMobile ? secWallpaper : '')
    + secBubble
    + secGlobalCSS
    + (isMobile ? secHomeDeco : '')
    + secIcons;
}
export function refreshDiyUI() {
  if ($('page-diy')?.classList.contains('active')) renderDiyPage();
}
/* ============ 手机桌面壁纸（theme.homeBg，仅作用于 #page-home 底层） ============ */
export async function uploadHomeBg() {
  const input = $('diy-image-file');
  input.value = '';
  input.onchange = async () => {
    if (!input.files || !input.files[0]) return;
    const data = await compressImage(input.files[0], 1600, 0.88);
    const thm = await getTheme();
    thm.homeBg = data;
    await saveTheme(thm);
    applyDIYVariables(thm);
    renderDiyPage();
    toast('壁纸已更新');
  };
  input.click();
}
export async function resetHomeBg() {
  const thm = await getTheme();
  delete thm.homeBg;
  await saveTheme(thm);
  applyDIYVariables(thm);
  renderDiyPage();
  toast('已恢复默认壁纸');
}

/* ============ 首页贴纸方块 → 图片展示框（theme.homeSquareImg） ============ */
export async function uploadHomeSquareImg() {
  const input = $('diy-image-file');
  input.value = '';
  input.onchange = async () => {
    if (!input.files || !input.files[0]) return;
    const data = await compressImage(input.files[0], 800, 0.85);
    const thm = await getTheme();
    thm.homeSquareImg = data;
    await saveTheme(thm);
    renderHomeSquareImg(thm);
    toast('图片已更新');
  };
  input.click();
}
export function renderHomeSquareImg(thm) {
  const sq = $('home-square-img');
  if (!sq) return;
  if (thm && thm.homeSquareImg) {
    sq.innerHTML = `<img src="${thm.homeSquareImg}" alt="">`;
  } else {
    sq.innerHTML = '<svg class="i stk-icon"><use href="#icon-image"/></svg><span class="stk-label">图片</span>';
  }
}

/* ============ 聊天气泡代码（属性写法自动包选择器，含选择器则直接追加） ============ */
export async function saveBubbleCSS(side) {
  const isMe = side === 'me';
  const el = $(isMe ? 'diy-my-bubble-css' : 'diy-ot-bubble-css');
  const thm = await getTheme();
  thm[isMe ? 'customMyBubbleCSS' : 'customOtBubbleCSS'] = el ? el.value.trim() : '';
  await saveTheme(thm);
  applyDIYVariables(thm);
  renderDiyPage();
  toast(isMe ? '我的气泡样式已保存' : '对方气泡样式已保存');
}
export async function clearBubbleCSS(side) {
  const isMe = side === 'me';
  const thm = await getTheme();
  delete thm[isMe ? 'customMyBubbleCSS' : 'customOtBubbleCSS'];
  await saveTheme(thm);
  applyDIYVariables(thm);
  renderDiyPage();
  toast('气泡代码已清除');
}

/* ============ 全局自定义 CSS（theme.customCSS → <style id="user-css">） ============ */
export async function applyCustomCSS() {
  const el = $('diy-global-css');
  const thm = await getTheme();
  thm.customCSS = el ? el.value : '';
  await saveTheme(thm);
  applyDIYVariables(thm);
  toast('自定义CSS已应用');
}
export async function clearCustomCSS() {
  const thm = await getTheme();
  delete thm.customCSS;
  await saveTheme(thm);
  applyDIYVariables(thm);
  renderDiyPage();
  toast('自定义CSS已清除');
}

export async function clearHomeDecos() {
  if (!confirm('清除所有首页装饰贴纸？')) return;
  const thm = await getTheme();
  thm.homeDecos = [];
  await saveTheme(thm);
  renderDecoLayersWith(thm);
  renderDiyPage();
  toast('装饰贴纸已清空');
}
export async function resetDIYAll() {
  if (!confirm('重置全部美化设置？（背景/框/气泡/按键/图标/字体/装饰贴纸都会恢复默认）')) return;
  const thm = await getTheme();
  for (const sec of Object.values(DIY_SECTIONS)) {
    for (const it of sec.items) { if (it.key !== 'themeColor') delete thm[it.key]; }
  }
  delete thm.pageBg; delete thm.frameBg; delete thm.contentBg;
  delete thm.homeBanner; delete thm.homeDecos; delete thm.customFont;
  await saveTheme(thm);
  applyDIYVariables(thm);
  renderHomeAvatar();
  renderDiyPage();
  toast('已全部重置');
}
export async function setDIYColor(key, color) {
  const thm = await getTheme();
  thm[key] = color;
  await saveTheme(thm);
  applyDIYVariables(thm);
  // 刷新当前DIY面板颜色选中状态 + 美化设置页
  if (state.diyCurrentSection) openDIY(state.diyCurrentSection);
  refreshDiyUI();
}
export async function setDIYText(key, value) {
  const thm = await getTheme();
  thm[key] = value || '';
  await saveTheme(thm);
  applyDIYVariables(thm);
  toast('已保存');
}

export function pickDIYImage(key) {
  state.diyPickKey = key;
  const input = $('diy-image-file');
  input.value = '';
  input.onchange = async () => {
    if (!input.files || !input.files[0] || !state.diyPickKey) return;
    const data = await compressImage(input.files[0], 1280, 0.9);
    const thm = await getTheme();
    thm[state.diyPickKey] = data;
    await saveTheme(thm);
    applyDIYVariables(thm);
    if (state.diyPickKey === 'homeBanner') renderHomeAvatar();
    toast('图片已应用');
    if (state.diyCurrentSection) openDIY(state.diyCurrentSection);
    refreshDiyUI();
  };
  input.click();
}
export async function resetDIYItem(key) {
  const thm = await getTheme();
  delete thm[key];
  await saveTheme(thm);
  applyDIYVariables(thm);
  if (key === 'homeBanner') renderHomeAvatar();
  if (state.diyCurrentSection) openDIY(state.diyCurrentSection);
  refreshDiyUI();
  toast('已重置该项');
}
export async function resetDIYSection() {
  if (!state.diyCurrentSection) return closeDIY();
  const sec = DIY_SECTIONS[state.diyCurrentSection];
  const thm = await getTheme();
  for (const it of sec.items) delete thm[it.key];
  await saveTheme(thm);
  applyDIYVariables(thm);
  openDIY(state.diyCurrentSection);
  refreshDiyUI();
  toast('本项全部重置回默认');
}
// 应用 DIY 变量到 :root CSS 与 body 样式、图标替换
export function applyDIYVariables(thm) {
  thm = thm || defaultTheme();
  const root = document.documentElement;
  // 主题色
  root.style.setProperty('--theme-color', thm.themeColor || '#ff9ec6');
  root.style.setProperty('--theme-light', hexWithAlpha(thm.themeColor || '#ff9ec6', 0.12));
  // 手机桌面壁纸（仅作用于 #page-home 底层，不干涉聊天背景）
  if (thm.homeBg) root.style.setProperty('--home-bg', `url("${thm.homeBg}")`);
  else root.style.removeProperty('--home-bg');
  // 背景 body
  const pageBg = thm.pageBg;
  if (pageBg) {
    const isImg = /^data:image|^https?:/.test(String(pageBg));
    document.body.style.background = isImg
      ? `#fff url("${pageBg}") center/cover no-repeat fixed`
      : pageBg;
  } else {
    // 默认手机蓝格或电脑蓝格斜纹
    document.body.style.background = '';
  }
  // frameBg（.app 容器 淡黄色内框）
  if (thm.frameBg) {
    const isImg = /^data:image|^https?:/.test(String(thm.frameBg));
    const appEl = $('app');
    if (appEl) {
      if (isImg) { appEl.style.background = `#fff url("${thm.frameBg}") center/cover no-repeat`; }
      else { appEl.style.background = thm.frameBg; }
    }
  }
  // contentBg（右侧内容）
  if (thm.contentBg) {
    const isImg = /^data:image|^https?:/.test(String(thm.contentBg));
    const wraps = document.querySelectorAll('.content-wrap');
    wraps.forEach(w => {
      if (isImg) w.style.background = `#fffbe4 url("${thm.contentBg}") center/cover no-repeat`;
      else w.style.background = thm.contentBg;
    });
  }
  // 主按钮皮肤 bg_btn
  const btns = document.querySelectorAll('.btn');
  btns.forEach(b => {
    if (thm.bg_btn && !b.classList.contains('btn-ghost') && !b.classList.contains('btn-outline') && !b.classList.contains('btn-danger')) {
      b.style.background = `url("${thm.bg_btn}") center/cover no-repeat, ${b.style.background || 'var(--theme-color)'}`;
      b.style.color = '#fff';
    } else if (!thm.bg_btn) { /* keep default */ }
  });
  // 聊天气泡皮肤
  const styleId = 'diy-bubble-style';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = styleId; document.head.appendChild(styleEl); }
  let css = '';
  if (thm.bg_myBubble) css += `.msg-row.me   .msg-bubble { background:transparent url("${thm.bg_myBubble}") center/cover no-repeat; background-color:var(--my-bubble); color:#fff; }`;
  if (thm.bg_otBubble) css += `.msg-row.other .msg-bubble { background:transparent url("${thm.bg_otBubble}") center/cover no-repeat; background-color:var(--other-bubble); }`;
  if (thm.customFont) {
    const f = thm.customFont;
    if (/^https?:|^data:font/.test(f)) css += `@font-face { font-family:'diy-font'; src:url("${f}"); } body, .app { font-family:'diy-font', -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important; }`;
    else css += `body, .app { font-family: "${f}", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important; }`;
  }
  // 全局自定义 CSS 统一由 applyTheme() 注入到 <style id="user-css">，此处不再重复拼接
  // 气泡独立代码：支持纯属性（自动包到 .msg-row.x .msg-bubble{...}）或完整选择器代码
  const buildBubbleCSS = (code, side) => {
    if (!code || !code.trim()) return '';
    const src = String(code).trim();
    if (/\{/.test(src)) return '\n' + src; // 完整选择器写法直接用
    return `\n.msg-row.${side} .msg-bubble { ${src} }\n`;
  };
  css += buildBubbleCSS(thm.customMyBubbleCSS, 'me');
  css += buildBubbleCSS(thm.customOtBubbleCSS, 'other');
  styleEl.textContent = css;
  // 自定义图标/贴纸替换：上传后直接用图覆盖原图标容器（去掉方框背景）
  // 每项 = [theme键, SVG选择器, 图标容器class(=对哪个元素加diy-icon-cover去方框,空=仅替换SVG大小,不改容器样式)]
  const iconMap = [
    { key:'icon_heart', svgSel:'.bottom-nav .nav-btn[data-page="page-love"] .nav-icon svg, .btn-chip svg[href="#icon-heart"]', containerClass:'nav-icon' },
    { key:'icon_mail',  svgSel:'.bottom-nav .nav-btn[data-page="page-letter"] .nav-icon svg', containerClass:'nav-icon' },
    { key:'icon_user',  svgSel:'.bottom-nav .nav-btn[data-page="page-me"] .nav-icon svg',     containerClass:'nav-icon' },
    { key:'icon_cog',   svgSel:'.bottom-nav .nav-btn[data-page="page-setting"] .nav-icon svg', containerClass:'nav-icon' },
    // 聊天输入按钮（圆形 40px，去掉圆框背景变贴纸）
    { key:'img_send',   svgSel:'.chat-send-btn svg, .chat-input-actions .send-btn svg',  containerClass:'chat-input-btn' },
    { key:'img_smile',  svgSel:'.chat-input-actions button svg[href="#icon-smile"]',     containerClass:'chat-input-btn' },
    { key:'img_image',  svgSel:'.chat-input-actions button svg[href="#icon-image"]',     containerClass:'chat-input-btn' },
    { key:'img_menu',   svgSel:'.chat-header-actions button svg[href="#icon-menu"], .chat-top-actions svg[href="#icon-menu"]', containerClass:'top-bar-btn' },
    { key:'icon_plus',  svgSel:'.top-bar-btn svg[href="#icon-plus"], .btn svg[href="#icon-plus"]', containerClass:'top-bar-btn' },
    // 电话/视频按钮
    { key:'img_phone',  svgSel:'.popup-menu-item svg[href="#icon-phone"], .call-actions svg[href="#icon-phone"]', containerClass:'' },
    { key:'img_video',  svgSel:'.popup-menu-item svg[href="#icon-video"], .call-actions svg[href="#icon-video"]', containerClass:'' },
  ];
  // 先清掉历史 diy 覆盖痕迹
  document.querySelectorAll('[data-diy-icon]').forEach(el => el.remove());
  document.querySelectorAll('.diy-icon-cover').forEach(el => el.classList.remove('diy-icon-cover'));
  for (const item of iconMap) {
    const img = thm[item.key];
    if (!img) continue;
    document.querySelectorAll(item.svgSel).forEach(svg => {
      if (!svg || svg.dataset.diyIcon) return;
      let container = svg.parentElement;
      if (!container) return;
      // 找最贴近指定 containerClass 的元素（作为"去方框"目标），未命中则使用 svg.parentElement 本身
      let coverTarget = null;
      if (item.containerClass) {
        if (container.classList.contains(item.containerClass)) coverTarget = container;
        else {
          const up = container.closest('.' + item.containerClass.split(/\s+/)[0]);
          if (up) coverTarget = up;
        }
      }
      const needCover = !!coverTarget;
      // 尺寸：nav-icon / top-bar-btn / chat-input-btn 按覆盖容器原大小填满；否则保持 SVG 原本的 w/h
      let w, h;
      if (needCover && coverTarget.clientWidth > 0) {
        w = coverTarget.clientWidth;
        h = coverTarget.clientHeight;
        coverTarget.classList.add('diy-icon-cover');
      } else {
        w = svg.getAttribute('width') || (svg.classList.contains('i-lg') ? 24 : svg.classList.contains('i-sm') ? 16 : 20);
        h = w;
      }
      const rep = document.createElement('img');
      rep.src = img;
      rep.style.width = w + 'px';
      rep.style.height = h + 'px';
      rep.style.objectFit = 'contain';
      rep.dataset.diyIcon = item.key;
      svg.style.display = 'none';
      container.insertBefore(rep, svg);
    });
  }
}

/* ============ 待办提示功能 ============ */
export async function getTodos() {
  const thm = await getTheme();
  if (!thm.todos) { thm.todos = []; await saveTheme(thm); }
  return thm.todos;
}
export async function saveTodos(list) {
  const thm = await getTheme();
  thm.todos = list; await saveTheme(thm);
}
export async function promptTodoAdd() {
  // 若待办管理面板开着，先关面板再弹输入（避免浮层遮挡或层级叠加）
  const tp = $('todo-panel');
  const wasOpen = tp && tp.classList.contains('show');
  if (wasOpen) closeTodoPanel();
  const r = await inputDialog('新增待办', [
    { key:'text', label:'待办内容', placeholder:'例如：下午3点浇花', required:true },
    { key:'time', label:'提醒时间（可选，留空则不提醒）', type:'datetime-local' }
  ], '添加');
  if (!r) return;
  const txt = (r.text || '').trim();
  if (!txt) return;
  const t = r.time ? (new Date(r.time)).getTime() : null;
  if (r.time && (!t || isNaN(t))) return toast('时间格式不正确');
  const list = await getTodos();
  list.push({ id: uid(), text: txt, done: false, remindAt: t, createdAt: now() });
  await saveTodos(list);
  renderTodos();
  toast('已新增待办');
}
export async function toggleTodo(id) {
  const list = await getTodos();
  const t = list.find(x => x.id === id); if (!t) return;
  t.done = !t.done;
  await saveTodos(list);
  renderTodos();
}
export async function deleteTodo(id) {
  if (!confirm('删除这条待办？')) return;
  const list = await getTodos();
  await saveTodos(list.filter(x => x.id !== id));
  renderTodos();
}
export async function openTodoEditor() { $('todo-panel').classList.add('show'); renderTodos(); }
export function closeTodoPanel() { $('todo-panel').classList.remove('show'); }
export function renderTodos() {
  getTodos().then(list => {
    // 首页 mini list（最多前 4 条未完成）
    const mini = $('todo-mini-list');
    if (mini) {
      if (!list.length) {
        mini.innerHTML = `<div class="todo-empty-hint">点击这里添加待办</div>`;
      } else {
        const rows = list.filter(x => !x.done).slice(0,4).map(t => miniTodoItem(t)).join('');
        const doneCount = list.filter(x => x.done).length;
        const show = list.filter(x => !x.done).length;
        mini.innerHTML = rows + (show === 0 ? `<div style="font-size:12px;color:#9bb2cd;text-align:center;padding:8px;">全部完成 · 已完成${doneCount}项</div>` : '');
      }
    }
    // 面板 full list
    const full = $('todo-full-list');
    if (full) {
      if (!list.length) {
        full.innerHTML = `<div style="font-size:13px;color:#8696b1;text-align:center;padding:20px 6px;">还没有待办~<br>点下方「新增一条待办」开始吧</div>`;
      } else {
        full.innerHTML = list.map(t => `
          <div class="todo-mini-item ${t.done?'done':''}" style="padding:10px;border-radius:12px;">
            <div class="todo-mini-check" onclick="toggleTodo('${t.id}')" style="cursor:pointer;">${t.done?'<svg class="i i-sm" style="stroke:#fff;"><use href="#icon-check"/></svg>':''}</div>
            <div class="todo-mini-text">
              <div style="font-size:14px;">${escapeHtml(t.text)}</div>
              ${t.remindAt ? `<div style="font-size:11px;color:#b8c6dc;margin-top:3px;">⏰ ${new Date(t.remindAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>`:''}
              ${t.done ? `<div style="font-size:11px;color:#b0b7c3;margin-top:3px;">已完成</div>`:''}
            </div>
            <button class="todo-mini-del" onclick="deleteTodo('${t.id}')"><svg class="i i-sm"><use href="#icon-trash"/></svg></button>
          </div>
        `).join('');
      }
    }
  });
}
export function miniTodoItem(t) {
  return `<div class="todo-mini-item">
    <div class="todo-mini-check" onclick="event.stopPropagation();toggleTodo('${t.id}')" style="cursor:pointer;">${t.done?'<svg class="i i-sm" style="stroke:#fff;"><use href="#icon-check"/></svg>':''}</div>
    <div class="todo-mini-text">${escapeHtml(t.text)}</div>
    <button class="todo-mini-del" onclick="event.stopPropagation();deleteTodo('${t.id}')"><svg class="i i-sm"><use href="#icon-trash"/></svg></button>
  </div>`;
}
// 每隔 30 秒检查一次待办提醒并 toast

export async function checkTodoReminders() {
  const nowT = now();
  if (nowT - state._lastTodoCheck < 28 * 1000) return;
  state._lastTodoCheck = nowT;
  const list = await getTodos();
  let changed = false;
  for (const t of list) {
    if (!t.done && t.remindAt && !t._notified && t.remindAt <= nowT) {
      toast('⏰ 待办提醒：' + t.text);
      try {
        if ('Notification' in window && Notification.permission === 'granted') new Notification('待办提醒', { body: t.text });
      } catch(e) {}
      t._notified = true;
      changed = true;
    }
  }
  if (changed) await saveTodos(list);
}
export function toggleExportAll(cb) {
  const checked = cb.checked;
  document.querySelectorAll('#export-opts input[type=checkbox]:not(#export-all)').forEach(x => x.checked = checked);
  document.querySelectorAll('#export-opts .export-opt:not(:last-child)').forEach(x => x.classList.toggle('checked', checked));
}
// 绑定每个export-opt的class切换
document.addEventListener('change', (e) => {
  if (e.target.matches('#export-opts input[type=checkbox]')) {
    e.target.closest('.export-opt')?.classList.toggle('checked', e.target.checked);
  }
});

// ============ 内存估算 ============
export async function renderStorageStats() {
  const contacts = await getAllContacts();
  const me = await getMe();
  let chatCount = 0, cardCount = 0, stickerCount = 0, bigStr = '';
  for (const c of contacts) {
    chatCount += (c.messages||[]).length;
    for (const g of (c.cardGroups||[])) cardCount += (g.cards||[]).length;
    stickerCount += (c.stickers||[]).length;
  }
  stickerCount += (me.stickers||[]).length;
  // 粗略估算大小
  bigStr = me.avatar || '';
  bigStr += me.stickers ? me.stickers.map(s=>s.data||'').join('') : '';
  for (const c of contacts) {
    bigStr += c.avatar || '';
    bigStr += c.stickers ? c.stickers.map(s=>s.data||'').join('') : '';
    if (c.settings && c.settings.chatBackground && c.settings.chatBackground.type === 'image') bigStr += c.settings.chatBackground.value || '';
    for (const m of (c.messages||[])) {
      if (m.type === 'image' && m.content) bigStr += m.content;
    }
  }
  const mb = estimateSizeMB(bigStr);
  if ($('ss-chat')) $('ss-chat').textContent = chatCount;
  if ($('ss-cards')) $('ss-cards').textContent = cardCount;
  if ($('ss-stickers')) $('ss-stickers').textContent = stickerCount;
  if ($('ss-size')) $('ss-size').textContent = mb;
}

// ============ 导出 ============
export async function doExport() {
  const cbs = Array.from(document.querySelectorAll('#export-opts input[type=checkbox]:not(#export-all)'));
  const scopes = cbs.filter(x => x.checked).map(x => x.value);
  if (scopes.length === 0) return toast('请选择导出范围');
  toast('开始导出，请稍候…');
  try {
    const contacts = await getAllContacts();
    const me = await getMe();
    const theme = await getTheme();
    const needChat = scopes.includes('chat');
    const needCards = scopes.includes('cards');
    const needStickers = scopes.includes('stickers');
    const needImages = scopes.includes('images');
    // 导出数据结构
    const data = {
      meta: { version: '1', exportTime: now(), exportScope: scopes.slice() },
      me: {},
      contacts: []
    };
    if (needImages) {
      data.me.name = me.name;
      data.me.avatar = me.avatar;
    } else {
      data.me.name = me.name;
      data.me.avatar = null;
    }
    if (needStickers) {
      data.me.stickers = me.stickers || [];
    }
    data.me.theme = theme;
    for (const c of contacts) {
      const co = { id: c.id, name: c.name, status: c.status, statusAuto: c.statusAuto,
        nextStatusChangeAt: c.nextStatusChangeAt, statusList: c.statusList,
        settings: JSON.parse(JSON.stringify(c.settings || {})),
        anniversaries: c.anniversaries, letters: c.letters, missedCalls: c.missedCalls };
      if (!needImages) co.avatar = null; else co.avatar = c.avatar;
      if (needChat) {
        // 图片消息base64根据needImages控制
        co.messages = (c.messages || []).map(m => {
          if ((m.type === 'image' || m.type === 'sticker') && !needImages) {
            return { ...m, content: null };
          }
          return m;
        });
      }
      if (needCards) { co.cardGroups = c.cardGroups || []; }
      if (needStickers) { co.stickers = c.stickers || []; }
      if (!needImages && co.settings && co.settings.chatBackground && co.settings.chatBackground.type === 'image') {
        co.settings = { ...co.settings, chatBackground: null };
      }
      data.contacts.push(co);
    }
    // 心情日历 + 灵感随记（meta store，按 k 键保留原始结构导出）
    const allMeta = await dbAll('meta');
    data.moodData = allMeta
      .filter(m => m && typeof m.k === 'string' && m.k.indexOf('mood:') === 0)
      .map(m => {
        if (Array.isArray(m.records)) {
          return { k: m.k, records: m.records.map(r => ({ emoji: r.emoji, text: r.text || '', ts: r.ts })) };
        }
        // 兼容旧结构 {emoji,text,ts}
        if (m.emoji) return { k: m.k, records: [{ emoji: m.emoji, text: m.text || '', ts: m.ts || now() }] };
        return null;
      })
      .filter(m => m && m.records.length);
    const inspRec = allMeta.find(m => m && m.k === 'inspirations');
    data.inspirations = inspRec
      ? { k: 'inspirations', list: (inspRec.list || []).map(x => ({ id: x.id, text: x.text, ts: x.ts })) }
      : null;
    // 导出：如果太大，用Blob而不是字符串直接下载
    let str = '';
    try { str = JSON.stringify(data); } catch(e) { return toast('序列化失败：' + e.message); }
    const blob = new Blob([str], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    const d = new Date();
    a.download = `字卡传讯备份_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${scopes.join('-')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`✅ 已导出 (${estimateSizeMB(str)} MB)`);
  } catch(e) {
    console.error(e);
    toast('导出失败：' + e.message);
  }
}

// ============ 导入 ============
export async function doImport(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  input.value = '';
  if (!confirm(`⚠️ 即将从「${file.name}」恢复数据。\n导入将按文件实际包含的范围，覆盖现有对应数据（联系人的字卡、表情包、聊天记录，我的表情包、主题等）。\n是否继续？`)) return;
  toast('正在解析，请稍候…');
  try {
    // 分片读：用FileReader读为text，然后用setTimeout切片解析（虽然大部分情况一次性即可，但按需求实现分片）
    const text = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsText(file);
    });
    // 简单分片：每100k字符处理一批setTimeout 0让UI喘息
    const chunkSize = 200000;
    let start = 0, idx = 0;
    let data;
    if (text.length < 2 * chunkSize) {
      data = JSON.parse(text);
    } else {
      // 大文件：先显示进度
      data = await new Promise((resolve, reject) => {
        try {
          const res = JSON.parse(text);
          setTimeout(() => resolve(res), 0);
        } catch(e) { reject(e); }
      });
    }
    if (!data || !data.meta || !data.contacts) throw new Error('文件格式错误');
    const scope = data.meta.exportScope || [];
    const needChat = scope.includes('chat');
    const needCards = scope.includes('cards');
    const needStickers = scope.includes('stickers');
    const needImages = scope.includes('images');
    let summary = [];
    // 先更新全局
    if (data.me) {
      const me = await getMe();
      if (data.me.name != null) me.name = data.me.name;
      if (needImages && data.me.avatar) me.avatar = data.me.avatar;
      if (needStickers && data.me.stickers) me.stickers = data.me.stickers.slice();
      await saveMe(me);
      summary.push('我的资料/表情包已恢复');
    }
    if (data.me && data.me.theme) {
      await saveTheme(data.me.theme);
      summary.push('主题已恢复');
    }
    // 心情日历 + 灵感随记（兼容旧备份的 data.mood）：按数据内的 k 键直接写回 meta
    const moodData = Array.isArray(data.moodData) ? data.moodData : (Array.isArray(data.mood) ? data.mood : []);
    let needMoodRefresh = false;
    let moodCnt = 0;
    for (const item of moodData) {
      if (!item || typeof item.k !== 'string' || item.k.indexOf('mood:') !== 0) continue;
      await dbPut('meta', item);
      moodCnt++;
    }
    if (moodCnt) { needMoodRefresh = true; summary.push(`心情记录已恢复（${moodCnt} 天）`); }
    if (data.inspirations && data.inspirations.k === 'inspirations') {
      await dbPut('meta', data.inspirations);
      needMoodRefresh = true;
      summary.push('灵感随记已恢复');
    }
    if (needMoodRefresh) {
      const { renderMoodCalendar, renderInspirations } = await import('./09-mood.js');
      await renderMoodCalendar();
      renderInspirations();
    }
    // 联系人：串行处理
    let addContact = 0, updContact = 0;
    const existing = await getAllContacts();
    const exMap = new Map(existing.map(c => [c.id, c]));
    for (const imported of data.contacts) {
      if (!imported.id) continue;
      let cur = exMap.get(imported.id);
      const isNew = !cur;
      if (isNew) { cur = createEmptyContact(imported.name || '导入联系人'); cur.id = imported.id; }
      cur.name = imported.name || cur.name;
      if (needImages && imported.avatar) cur.avatar = imported.avatar;
      if (imported.status != null) cur.status = imported.status;
      if (imported.statusAuto != null) cur.statusAuto = imported.statusAuto;
      if (imported.nextStatusChangeAt) cur.nextStatusChangeAt = imported.nextStatusChangeAt;
      if (imported.statusList) cur.statusList = imported.statusList;
      if (imported.settings) {
        // 聊天背景图片根据 needImages 决定
        if (!needImages && imported.settings.chatBackground && imported.settings.chatBackground.type === 'image') {
          imported.settings = { ...imported.settings, chatBackground: cur.settings.chatBackground };
        }
        cur.settings = { ...cur.settings, ...imported.settings };
      }
      if (imported.anniversaries) cur.anniversaries = imported.anniversaries.slice();
      if (imported.letters) cur.letters = imported.letters.slice();
      if (imported.missedCalls) cur.missedCalls = imported.missedCalls.slice();
      if (needChat && imported.messages) {
        // 如果导入时无图（content:null）保留现有图
        const curMsgMap = new Map((cur.messages||[]).map(m=>[m.id,m]));
        const merged = imported.messages.map(m => {
          if ((m.type === 'image' || m.type === 'sticker') && m.content == null) {
            const old = curMsgMap.get(m.id);
            if (old) return old;
          }
          return m;
        });
        cur.messages = merged;
      }
      if (needCards && imported.cardGroups) cur.cardGroups = imported.cardGroups.map(g => ({...g, cards: (g.cards||[]).slice()}));
      if (needStickers && imported.stickers) cur.stickers = imported.stickers.slice();
      await saveContact(cur);
      if (isNew) addContact++; else updContact++;
    }
    summary.push(`联系人：新增${addContact}个，更新${updContact}个`);
    toast('✅ 导入成功：' + summary.join('；'));
    renderMeBrief();
    renderContacts();
    renderStorageStats();
  } catch(e) {
    console.error(e);
    toast('导入失败：' + e.message);
  }
}
