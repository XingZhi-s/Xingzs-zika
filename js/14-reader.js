// 依赖：03-data.js
import { uid } from './01-state.js';
import { $, closeModal, confirmDialog, dbGet, dbPut, escapeHtml, now, showModal, toast } from './02-core.js';
import { backFromApp, openPage } from './03-data.js';

/* ============ 本地沉浸式阅读与手写笔记 ============
   书籍完全由用户本地上传（TXT），存 IndexedDB meta store，大文本分页渲染防卡死：
   reader_books:    { k:'reader_books',    list:[{ id, title, pages:[第一页内容,...], addTime }] }
   reader_progress: { k:'reader_progress', map:{ [bookId]: pageIndex } }
   reader_notes:    { k:'reader_notes',    list:[{ id, bookId, quote, note, timestamp, pageIndex }] } */

const READER_MAX_FILE = 10 * 1024 * 1024; // 单文件最大 10MB
const READER_PAGE_SIZE = 3000;            // 每页约 3000 字符（尽量在换行处断开）
// DOCX 解析库：仅在需要时按需从 CDN 加载，避免拖慢首屏
const MAMMOTH_CDN = 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js';
let _mammothLoading = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (_mammothLoading) return _mammothLoading;
  _mammothLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MAMMOTH_CDN; s.async = true;
    s.onload = () => window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth 未就绪'));
    s.onerror = () => { _mammothLoading = null; reject(new Error('mammoth 加载失败')); };
    document.head.appendChild(s);
  });
  return _mammothLoading;
}

let _book = null;      // 当前打开的书对象
let _pageIdx = 0;      // 当前页码
let _selQuote = '';    // 当前划词选中的原文
let _selInited = false;

// ---- 数据读写 ----
async function getBooks() { const r = await dbGet('meta', 'reader_books'); return (r && r.list) || []; }
async function saveBooks(list) { await dbPut('meta', { k: 'reader_books', list }); }
async function getProgressMap() { const r = await dbGet('meta', 'reader_progress'); return (r && r.map) || {}; }
async function saveProgressMap(map) { await dbPut('meta', { k: 'reader_progress', map }); }
async function getNotes() { const r = await dbGet('meta', 'reader_notes'); return (r && r.list) || []; }
async function saveNotes(list) { await dbPut('meta', { k: 'reader_notes', list }); }

// ---- 页面入口 ----
export function openReaderPage() {
  _book = null;
  openPage('page-reader');
  if (!_selInited) { _selInited = true; initReaderSelection(); }
  applyReaderView();
  renderReaderShelf();
}
// 顶栏返回：阅读中 → 回书架；书架 → 回进入前的页面（桌面兜底到聊天区）
export function readerBack() {
  if (_book) { _book = null; applyReaderView(); renderReaderShelf(); }
  else backFromApp();
}
function applyReaderView() {
  $('reader-title').textContent = _book ? _book.title : '阅读';
  $('reader-shelf').classList.toggle('hide', !!_book);
  $('reader-reading').classList.toggle('hide', !_book);
  $('reader-upload-btn').classList.toggle('hide', !!_book);
  hideSelMenu();
}

// ---- 书架 ----
export async function renderReaderShelf() {
  const box = $('reader-shelf'); if (!box) return;
  const books = await getBooks();
  const prog = await getProgressMap();
  const notes = await getNotes();
  if (!books.length) {
    box.innerHTML = `<div class="empty">还没有书籍<br><span style="font-size:12px;">点右上角上传本地 TXT / DOCX 文件，开始沉浸式阅读</span></div>`;
    return;
  }
  box.innerHTML = books.map(b => {
    const p = Math.min(prog[b.id] || 0, b.pages.length - 1);
    const pct = b.pages.length > 1 ? Math.round(p / (b.pages.length - 1) * 100) : 0;
    const noteCnt = notes.filter(n => n.bookId === b.id).length;
    return `<div class="reader-book-card" onclick="openReaderBook('${b.id}')">` +
      `<div class="reader-book-cover"><svg class="i" style="width:22px;height:22px;stroke:#fff;"><use href="#icon-book"/></svg></div>` +
      `<div class="reader-book-info">` +
      `<div class="reader-book-title">${escapeHtml(b.title)}</div>` +
      `<div class="reader-book-meta">共 ${b.pages.length} 页 · 读到 ${pct}%${noteCnt ? ` · ${noteCnt} 条笔记` : ''}</div>` +
      `</div>` +
      `<button class="reader-book-del" onclick="event.stopPropagation();readerDeleteBook('${b.id}')" title="删除"><svg class="i i-sm" style="stroke:#991b1b;"><use href="#icon-trash"/></svg></button>` +
      `</div>`;
  }).join('');
}
export async function readerDeleteBook(id) {
  if (!await confirmDialog('删除这本书？相关笔记与阅读进度将一并删除！')) return;
  await saveBooks((await getBooks()).filter(b => b.id !== id));
  await saveNotes((await getNotes()).filter(n => n.bookId !== id));
  const prog = await getProgressMap(); delete prog[id]; await saveProgressMap(prog);
  toast('已删除');
  renderReaderShelf();
}

// ---- 上传 TXT / DOCX 并分页 ----
async function addReaderBook(title, text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) { toast('文档内容为空'); return; }
  const pages = splitReaderPages(clean);
  const t = title || '未命名';
  const books = await getBooks();
  books.unshift({ id: uid(), title: t, pages, addTime: now() });
  await saveBooks(books);
  toast(`《${t}》已加入书架（共 ${pages.length} 页）`);
  renderReaderShelf();
}
export function readerPickFile(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  input.value = ''; // 立刻清空，保证下次选同一文件也能触发 onchange
  if (file.size > READER_MAX_FILE) {
    showModal('无法上传', `<div style="padding:8px 0;font-size:14px;line-height:1.7;">文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请拆分后上传。<br>单文件最大支持 10MB。</div>`);
    return;
  }
  const isDocx = /\.docx$/i.test(file.name) || /wordprocessingml/i.test(file.type || '');
  if (isDocx) {
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        toast('正在解析 DOCX…', 1200);
        const mammoth = await loadMammoth();
        // 只提取纯文本，不解析图片，避免大文档内存爆掉
        const res = await mammoth.extractRawText({ arrayBuffer: rd.result });
        await addReaderBook((file.name || '未命名').replace(/\.docx$/i, ''), res.value);
      } catch (e) {
        showModal('文档解析失败', `<div style="padding:8px 0;font-size:14px;line-height:1.7;">无法解析该 DOCX 文件，可能是解析库未能从 CDN 加载（需要联网）。<br>可另存为 TXT 后再上传。</div>`);
      }
    };
    rd.onerror = () => toast('文件读取失败');
    rd.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await addReaderBook((file.name || '未命名').replace(/\.txt$/i, ''), reader.result);
    } catch (e) { toast('书籍保存失败'); }
  };
  reader.onerror = () => toast('文件读取失败');
  reader.readAsText(file, 'UTF-8');
}
// 每 3000 字符切一页，尽量在换行符处断开（断点太靠前则不找换行，直接硬切）
function splitReaderPages(text) {
  const pages = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + READER_PAGE_SIZE, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl >= i + Math.floor(READER_PAGE_SIZE / 2)) end = nl + 1;
    }
    pages.push(text.slice(i, end));
    i = end;
  }
  return pages.length ? pages : [''];
}

// ---- 打开书 / 翻页 ----
export async function openReaderBook(id) {
  const books = await getBooks();
  const b = books.find(x => x.id === id);
  if (!b) return;
  _book = b;
  const prog = await getProgressMap();
  _pageIdx = Math.min(prog[id] || 0, b.pages.length - 1);
  applyReaderView();
  await renderReaderPage();
}
async function persistProgress() {
  if (!_book) return;
  const prog = await getProgressMap();
  prog[_book.id] = _pageIdx;
  await saveProgressMap(prog);
}
export async function readerPrevPage() { if (!_book || _pageIdx <= 0) return; _pageIdx--; await renderReaderPage(); }
export async function readerNextPage() { if (!_book || _pageIdx >= _book.pages.length - 1) return; _pageIdx++; await renderReaderPage(); }

// ---- 渲染当前页（每次只渲染一页；给本页笔记加护眼虚线下划线高亮） ----
export async function renderReaderPage() {
  if (!_book) return;
  const notes = (await getNotes()).filter(n => n.bookId === _book.id && n.pageIndex === _pageIdx);
  const content = $('reader-content');
  content.innerHTML = highlightPageText(_book.pages[_pageIdx] || '', notes);
  content.scrollTop = 0;
  $('reader-page-info').textContent = `${_pageIdx + 1} / ${_book.pages.length}`;
  $('reader-prev').disabled = _pageIdx <= 0;
  $('reader-next').disabled = _pageIdx >= _book.pages.length - 1;
  hideSelMenu();
  await persistProgress();
}
function highlightPageText(pageText, notes) {
  let html = escapeHtml(pageText);
  for (const n of notes) {
    const q = escapeHtml(n.quote || '');
    if (!q) continue;
    const idx = html.indexOf(q);
    if (idx === -1) continue; // 跨页的原文在本页找不到完整匹配则跳过
    html = html.slice(0, idx) + `<span class="reader-highlight" data-note-id="${n.id}">${q}</span>` + html.slice(idx + q.length);
  }
  return html;
}

// ---- 划词写笔记 ----
function initReaderSelection() {
  const content = $('reader-content');
  if (!content) return;
  content.addEventListener('mouseup', () => setTimeout(handleReaderSelect, 10));
  // 手机端长按选词后，选区稍晚才确定，延迟再读
  content.addEventListener('touchend', () => setTimeout(handleReaderSelect, 350));
  // 点击护眼下划线高亮 → 查看笔记
  content.addEventListener('click', (e) => {
    const hl = e.target.closest('.reader-highlight');
    if (hl) openReaderNoteView(hl.dataset.noteId);
  });
  // 点菜单以外的地方收起划词菜单
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#reader-sel-menu')) hideSelMenu(); });
  document.addEventListener('touchstart', (e) => { if (!e.target.closest('#reader-sel-menu')) hideSelMenu(); }, { passive: true });
}
function handleReaderSelect() {
  if (!_book) return hideSelMenu();
  const sel = window.getSelection();
  const txt = sel ? sel.toString().trim() : '';
  const content = $('reader-content');
  if (!txt || !sel.rangeCount || !content.contains(sel.getRangeAt(0).commonAncestorContainer)) return hideSelMenu();
  _selQuote = txt;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const menu = $('reader-sel-menu');
  menu.classList.remove('hide');
  menu.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - 52, window.innerWidth - 112)) + 'px';
  menu.style.top = Math.max(8, rect.top - 46) + 'px';
}
function hideSelMenu() { const m = $('reader-sel-menu'); if (m) m.classList.add('hide'); }
// 划词菜单 → 弹出写笔记弹窗（上原文、下输入框）
export function readerOpenNote() {
  hideSelMenu();
  const quote = _selQuote;
  if (!quote || !_book) return;
  showModal('写笔记',
    `<div class="reader-quote-box">${escapeHtml(quote)}</div>` +
    `<textarea class="textarea" id="reader-note-input" rows="4" placeholder="写下你的想法…" style="resize:none;line-height:1.6;"></textarea>`,
    [
      { label: '取消', cls: 'btn-outline', onClick: closeModal },
      { label: '保存', cls: '', onClick: async () => {
        const note = ($('reader-note-input').value || '').trim();
        if (!note) return toast('笔记内容不能为空');
        const notes = await getNotes();
        notes.unshift({ id: uid(), bookId: _book.id, quote, note, timestamp: now(), pageIndex: _pageIdx });
        await saveNotes(notes);
        closeModal();
        toast('笔记已保存');
        renderReaderPage();
      } }
    ]);
  setTimeout(() => { const t = $('reader-note-input'); if (t) t.focus(); }, 50);
}
// 点击高亮查看笔记（支持删除）
export async function openReaderNoteView(noteId) {
  const notes = await getNotes();
  const n = notes.find(x => x.id === noteId);
  if (!n) return;
  showModal('我的笔记',
    `<div class="reader-quote-box">${escapeHtml(n.quote)}</div>` +
    `<div style="font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(n.note)}</div>` +
    `<div style="font-size:11px;color:var(--text-secondary);margin-top:10px;">记录于第 ${n.pageIndex + 1} 页</div>`,
    [
      { label: '删除', cls: 'btn-danger', onClick: async () => {
        await saveNotes((await getNotes()).filter(x => x.id !== noteId));
        closeModal();
        toast('笔记已删除');
        renderReaderPage();
      } },
      { label: '关闭', cls: 'btn-outline', onClick: closeModal }
    ]);
}
