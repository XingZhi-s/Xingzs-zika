// 依赖：02-core.js、03-data.js
import { state, uid } from './01-state.js';
import { $, dbGet, dbPut, escapeHtml, now, toast } from './02-core.js';
import { getAllContacts, getStatusPool, openPage, renderContacts, saveContact } from './03-data.js';
import { renderChatMessages } from './04-chat.js';

/* ============ 经期记录（纯离线伪应用） ============
   数据存 meta store 单键 period_record_v1：
   { k, start:'YYYY-MM-DD', periodDays:5, cycleDays:28, history:[{ start, createdAt }], sent:[key...] }
   提醒：每个周期 2 条（提前 2 天 / 当天），发给全部非「睡觉」大类联系人；
   只在预约当天窗口内发送，过期不补；key = 周期日|pre|day|联系人id 保证幂等。 */

const PERIOD_KEY = 'period_record_v1';
const DAY = 86400000;
const SEND_HOUR = 9; // 提醒固定在当地 09:00 触发（含随机偏移）
const OFFSET_MIN = 30; // 同一提醒在不同联系人之间错开 0–29 分钟

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseYmd(s) {
  if (!s || typeof s !== 'string') return NaN;
  const m = s.split('-').map(Number);
  if (m.length !== 3 || !m[0] || !m[1] || !m[2]) return NaN;
  return new Date(m[0], m[1] - 1, m[2]).getTime();
}
function todayStr() { return ymd(now()); }
function fmt(s) { return s ? s.replace(/-/g, '/') : '—'; }

async function loadPeriod() {
  const r = await dbGet('meta', PERIOD_KEY);
  const p = (r && typeof r === 'object') ? r : {};
  return {
    start: p.start || '',
    periodDays: typeof p.periodDays === 'number' ? p.periodDays : 5,
    cycleDays: typeof p.cycleDays === 'number' ? p.cycleDays : 28,
    history: Array.isArray(p.history) ? p.history : [],
    sent: Array.isArray(p.sent) ? p.sent : []
  };
}
async function savePeriod(p) { await dbPut('meta', { k: PERIOD_KEY, ...p }); }

// 预测：最近最多 4 段实际间隔（只取 15–60 天合理值）的中位数修正周期，避免单条异常数据带飞
function predict(p) {
  const starts = [];
  const push = s => { if (s && !starts.includes(s)) starts.push(s); };
  (p.history || []).forEach(h => push(h && h.start));
  push(p.start);
  starts.sort();
  if (!starts.length) return null;
  const last = starts[starts.length - 1];
  const recent = starts.slice(-5);
  const intervals = [];
  for (let i = 1; i < recent.length; i++) {
    const d = Math.round((parseYmd(recent[i]) - parseYmd(recent[i - 1])) / DAY);
    if (d >= 15 && d <= 60) intervals.push(d);
  }
  let cycle = p.cycleDays;
  let source = '设置周期';
  if (intervals.length) {
    intervals.sort((a, b) => a - b);
    cycle = intervals[Math.floor(intervals.length / 2)];
    source = `最近 ${intervals.length} 段实际间隔中位数`;
  }
  const nextTs = parseYmd(last) + cycle * DAY;
  const left = Math.round((nextTs - parseYmd(todayStr())) / DAY);
  return { last, next: ymd(nextTs), cycle, source, left };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000007;
  return h;
}

/* ---------- 页面 ---------- */
export function openPeriodPage() {
  openPage('page-period');
  renderPeriodPage();
}

export async function renderPeriodPage() {
  const nextEl = $('period-next');
  if (!nextEl) return;
  const p = await loadPeriod();
  const pr = predict(p);
  $('period-start').textContent = fmt(p.start);
  $('period-days').value = String(p.periodDays);
  $('period-cycle').value = String(p.cycleDays);
  if (!pr) {
    nextEl.textContent = '—';
    $('period-left').textContent = '先记录一次开始日';
    $('period-left').classList.add('muted');
  } else {
    nextEl.textContent = fmt(pr.next);
    $('period-left').classList.remove('muted');
    $('period-left').textContent = pr.left > 0 ? `还有 ${pr.left} 天` : (pr.left === 0 ? '预计今天' : `预计已过 ${-pr.left} 天`);
  }
  const hist = (p.history || []).slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  $('period-history').innerHTML = hist.length
    ? hist.map(h => `<div class="period-hist-row"><span>${escapeHtml(fmt(h.start))}</span><span class="period-hist-tag">${h.start === p.start ? '本次' : '历史'}</span></div>`).join('')
    : '<div class="period-empty">还没有记录</div>';
}

async function addStart(p, str) {
  const ts = parseYmd(str);
  if (!Number.isFinite(ts)) return toast('请选择有效日期');
  if (ts > parseYmd(todayStr())) return toast('只能记录今天或过去的日期');
  p.history = p.history || [];
  if (!p.history.some(h => h && h.start === str)) p.history.push({ start: str, createdAt: now() });
  p.history.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  p.start = ymd(Math.max(...p.history.map(h => parseYmd(h.start))));
  await savePeriod(p);
  await renderPeriodPage();
  toast(`已记录 ${fmt(str)}`);
}

export async function periodToday() {
  const p = await loadPeriod();
  await addStart(p, todayStr());
}

export async function periodAddPast() {
  const el = $('period-past-date');
  const v = el ? el.value : '';
  if (!v) return toast('请选择要补记的日期');
  const p = await loadPeriod();
  await addStart(p, v);
}

export async function periodSaveSettings() {
  const p = await loadPeriod();
  const d = parseInt(($('period-days') || {}).value, 10);
  const c = parseInt(($('period-cycle') || {}).value, 10);
  if (!Number.isFinite(d) || !Number.isFinite(c)) return toast('请输入有效的天数');
  p.periodDays = clamp(d, 1, 15);
  p.cycleDays = clamp(c, 15, 60);
  await savePeriod(p);
  await renderPeriodPage();
  toast('已保存天数与周期');
}

/* ---------- 提醒：提前 2 天 + 当天，发全部非睡眠联系人，过期不补 ---------- */
let _checkingPeriod = false;
export async function checkPeriodReminders() {
  if (_checkingPeriod) return;
  _checkingPeriod = true;
  try {
    const p = await loadPeriod();
    const pr = predict(p);
    if (!pr) return;
    const t = now();
    const today = todayStr();
    const nextTs = parseYmd(pr.next);
    const jobs = [
      { kind: 'pre', dayStr: ymd(nextTs - 2 * DAY), at: parseYmd(ymd(nextTs - 2 * DAY)) + SEND_HOUR * 3600000, text: '预计还有 2 天到经期' },
      { kind: 'day', dayStr: pr.next, at: nextTs + SEND_HOUR * 3600000, text: '今天到经期' }
    ];
    // 只在预约当天发送：过期（哪怕只过一天）不补发，等下一周期
    const due = jobs.filter(j => j.dayStr === today && t >= j.at);
    if (!due.length) return;
    const pool = await getStatusPool();
    const contacts = await getAllContacts();
    // 只发给非「睡觉」大类的全部联系人；按 id 排序后按下标错开偏移，保证彼此不同分钟
    const awake = contacts.filter(c => {
      const st = pool.find(s => s.id === c.statusId) || pool.find(s => s.name === c.status);
      return !(st && st.category === 'sleep');
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const salt = hashStr(`${pr.next}|${due[0].kind}`);
    let fired = false;
    let changed = false;
    for (let idx = 0; idx < awake.length; idx++) {
      const c = awake[idx];
      for (const j of due) {
        const key = `${pr.next}|${j.kind}|${c.id}`;
        if (p.sent.includes(key)) continue;
        const at = j.at + ((salt + idx * 7) % OFFSET_MIN) * 60000; // 每条随机偏移，不同联系人错开
        if (t < at) continue;
        // 该提醒时间点之后才新建的联系人不补发这一轮
        if (c.createdAt && c.createdAt > j.at) continue;
        const msg = {
          id: uid(), from: 'other', type: 'reminder', content: j.text,
          reminder: { text: j.text, at, repeat: 'once', missed: false, period: true },
          time: at, replyTo: null, snapshot: null,
          read: true, readAt: at, replyAt: 0, replied: true
        };
        c.messages = c.messages || [];
        c.messages.push(msg);
        c.unread = (c.unread || 0) + 1;
        await saveContact(c);
        p.sent.push(key);
        if (p.sent.length > 60) p.sent = p.sent.slice(-60);
        changed = true;
        fired = true;
      }
    }
    if (changed) await savePeriod(p);
    if (fired) {
      renderContacts();
      if (state.currentContactId) renderChatMessages(state.currentContactId, false);
      toast('经期提醒已送达', 2400);
    }
  } catch (e) {
    console.warn('经期提醒检查失败：', e);
  } finally {
    _checkingPeriod = false;
  }
}
