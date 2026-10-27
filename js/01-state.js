// 全局状态与常量，必须最先加载

/* =======================================================================
   字卡传讯 - 单文件离线应用
   技术：原生HTML + CSS + JS + IndexedDB
   规则：纯随机、不联网、每个联系人独立、快照判定、补算机制
   ======================================================================= */

// ============ 全局状态 ============

export const DB_NAME = 'ZiKaDB';
export const DB_VERSION = 1;
export const CALL_PERSIST_KEY = 'zika_call_v1';
export const state = {
  db: null,
  currentContactId: null,
  currentPageStack: [], // 用于返回
  prevChatPage: 'page-love',
  currentStkLibTab: 'mine',
  currentLetterId: null,
  letterViewFrom: 'list', // compose/detail返回哪里
  loadMoreState: {}, // 每个联系人的加载状态
  chatTimers: {}, // 聊天相关定时器
  callState: null, // {type, contactId, incoming, startTime, intervalId, micOn?, minimized?}
  longpressTimer: null,
  lastPage: 'page-love',
  chatTypingState: {}, // contactId -> true(正在输入)/false
  replyRounds: {},
  csFromPage: 'page-me',
  currentContactSettingId: null,
  currentLetterContactId: null,
  cardLibFrom: 'page-contact-setting',
  stkLibFrom: 'page-contact-setting',
  diyCurrentSection: null,
  diyPageBackTo: 'page-love',
  diyMode: 'mobile', // 'pc' 或 'mobile'
  diyPickKey: null,
  _inputDialogResolve: null,
  _taskRunning: false,
  _lastTodoCheck: 0,
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const DEFAULT_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#f7f0d4"/><circle cx="50" cy="38" r="20" fill="#e3d9b8"/><ellipse cx="50" cy="85" rx="35" ry="28" fill="#e3d9b8"/></svg>`);
export const PRESET_COLORS = ['#6b8aff','#ec4899','#10b981','#f59e0b','#8b5cf6','#ef4444','#0ea5e9','#14b8a6','#64748b','#f43f5e','#84cc16','#f97316'];
export const PRESET_BGS = [
  { name:'默认浅灰', css:'#f5f6fa', type:'color' },
  { name:'浅蓝', css:'#eff6ff', type:'color' },
  { name:'浅粉', css:'#fdf2f8', type:'color' },
  { name:'浅绿', css:'#f0fdf4', type:'color' },
  { name:'紫粉渐变', css:'linear-gradient(135deg,#fbc2eb 0%,#a6c1ee 100%)', type:'gradient' },
  { name:'蓝天渐变', css:'linear-gradient(135deg,#89f7fe 0%,#66a6ff 100%)', type:'gradient' },
  { name:'日落渐变', css:'linear-gradient(135deg,#ffecd2 0%,#fcb69f 100%)', type:'gradient' },
  { name:'暗夜渐变', css:'linear-gradient(135deg,#232526 0%,#414345 100%)', type:'gradient' },
];

// ============ 回复调度：合并窗口（避免发1条触发1次独立回复判定/条数） ============
// 每个联系人只保留"本轮"的一次合并回复判定
// replyRounds[cid] = { rate, onlineLike, willReply, roundWillReply, roundCount(1~replyCount), mergeDeadline, typingAt, replyAt, triggered }





/* ============ 美化 DIY 编辑器：主题/背景/图标/气泡/框/按钮图片 ============ */
export const DIY_SECTIONS = {
  theme: {
    title: '美化·主题·背景',
    desc: '修改全局主题色、网页背景、内容框背景色',
    items: [
      { key: 'themeColor', label: '主题色', type: 'color', preset: ['#ff9ec6','#ffb27a','#ffd36e','#98d8aa','#7acfff','#b49ef5','#9bb4d6','#f49fb5'] },
      { key: 'pageBg',     label: '网页背景（可用上传图）', type: 'image+color', preset: ['#eef4ff','#fff2f4','#eafbf1','#fff4dc','#f0ebff','#e7faff'] },
      { key: 'frameBg',    label: '框底色 / 电脑淡黄色内框',     type: 'color',       preset: ['#fff6d5','#fff8ea','#fffdf5','#ffeaea','#e7faff','#f3efff'] },
      { key: 'contentBg',  label: '右侧内容区底色（淡黄色）',    type: 'color',       preset: ['#fffbe4','#fffdf3','#fff3ec','#eef7ff','#f2fff3','#fff2f7'] },
    ]
  },
  icon: {
    title: '图标·顶部栏/底部栏',
    desc: '上传自定义图片替换底部导航/顶部栏SVG图标，留空=默认',
    items: [
      { key: 'icon_heart',  label: '底部 love 图标', type: 'image' },
      { key: 'icon_mail',   label: '底部 写信 图标', type: 'image' },
      { key: 'icon_user',   label: '底部 me   图标', type: 'image' },
      { key: 'icon_cog',    label: '底部 设置 图标', type: 'image' },
      { key: 'icon_plus',   label: '新建 + 图标', type: 'image' },
    ]
  },
  icon2: {
    title: '图标 占位2·气泡/按钮',
    desc: '聊天气泡、发送、表情、图片、电话、视频等按钮图标',
    items: [
      { key: 'img_send',     label: '发送按钮图标', type: 'image' },
      { key: 'img_smile',    label: '表情按钮图标', type: 'image' },
      { key: 'img_image',    label: '图片按钮图标', type: 'image' },
      { key: 'img_menu',     label: '聊天菜单(☰)图标', type: 'image' },
      { key: 'img_phone',    label: '电话按钮图标', type: 'image' },
      { key: 'img_video',    label: '视频按钮图标', type: 'image' },
    ]
  },
  icon3: {
    title: '图标·装饰·字体·皮肤',
    desc: '按钮皮肤背景、气泡图片、字体、气泡样式代码',
    items: [
      { key: 'bg_btn',       label: '主按钮皮肤背景', type: 'image' },
      { key: 'bg_myBubble',  label: '我的气泡皮肤背景', type: 'image' },
      { key: 'bg_otBubble',  label: '对方气泡皮肤背景', type: 'image' },
      { key: 'customFont',   label: '自定义字体URL/名称', type: 'text', placeholder:'例："楷体" 或 https://xxx.woff2' },
      { key: 'customCSS',    label: '全局自定义代码（CSS）', type: 'textarea', placeholder:'例：body { font-family: "楷体"; }' },
      { key: 'customMyBubbleCSS', label: '我的气泡样式代码（CSS，直接写属性或选择器）', type: 'textarea', placeholder:`示例：\nborder-radius: 20px;\nborder: 2px solid #ffd166;\n--msg-bg: #ffe58a;\ncolor: #835b00;` },
      { key: 'customOtBubbleCSS', label: '对方气泡样式代码（CSS，直接写属性或选择器）', type: 'textarea', placeholder:`示例：\nborder-radius: 18px;\nbox-shadow: 0 4px 12px rgba(0,0,0,0.1);\n--msg-bg: #f5f7fb;` },
    ]
  }
};





// ============ 全局FIFO串行队列（补算，避免IndexedDB并发冲突） ============
export const _taskQueue = [];

