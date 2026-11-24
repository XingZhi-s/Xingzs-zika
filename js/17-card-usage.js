// 字卡使用率：按联系人统计字卡被抽中的次数
// 依赖：01-state.js / 02-core.js / 03-data.js
import { state } from './01-state.js';
import { dbGet, dbPut, escapeHtml } from './02-core.js';
import { getContact, openPage } from './03-data.js';

const META_PREFIX = 'cardUsage_';
// 按联系人串行写库：补算与实时回复可能同时命中，避免读改写互相覆盖
const writeChains = new Map();

function usageKey(cid) { return META_PREFIX + cid; }

// 记录一次字卡使用（cardId 为字卡条目 id，name 为抽中时的文本快照）
export function recordCardUsage(cid, cardId, name) {
  if (!cid || !cardId) return Promise.resolve();
  const key = usageKey(cid);
  const prev = writeChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const rec = (await dbGet('meta', key)) || { k: key, total: 0, cards: {} };
    rec.k = key;
    rec.cards = rec.cards || {};
    const item = rec.cards[cardId] || { count: 0, name: '' };
    item.count = (item.count || 0) + 1;
    if (name) item.name = name;
    rec.cards[cardId] = item;
    rec.total = Object.keys(rec.cards).reduce((s, id) => s + (rec.cards[id].count || 0), 0);
    await dbPut('meta', rec);
  });
  writeChains.set(key, next);
  // 队列清空后移除引用，避免长期占用内存
  next.catch(() => {}).then(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  });
  return next;
}

// 读取某联系人的统计（先等该联系人的待写队列完成）
export async function getCardUsage(cid) {
  if (!cid) return { total: 0, cards: {} };
  const key = usageKey(cid);
  const pending = writeChains.get(key);
  if (pending) { try { await pending; } catch (e) {} }
  const rec = await dbGet('meta', key);
  if (!rec || !rec.cards) return { total: 0, cards: {} };
  return rec;
}

// 百分比：最多 1 位小数，整数不带 .0
function fmtPercent(p) {
  const n = Math.round(p * 10) / 10;
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

// 词云字号：13px（最少）~ 30px（最多），sqrt 缓和极端差距
const FONT_MIN = 13;
const FONT_MAX = 30;
function cloudFontSize(count, min, max) {
  if (max === min) return (FONT_MIN + FONT_MAX) / 2;
  const t = Math.sqrt((count - min) / (max - min));
  return FONT_MIN + t * (FONT_MAX - FONT_MIN);
}

export async function renderCardUsage() {
  const box = document.getElementById('card-usage-body');
  if (!box) return;
  const cid = state.currentContactSettingId;
  if (!cid) {
    box.innerHTML = `<div class="empty">请先选择一个联系人</div>`;
    return;
  }
  const [c, usage] = await Promise.all([getContact(cid), getCardUsage(cid)]);
  const entries = Object.keys(usage.cards || {}).map(id => {
    const item = usage.cards[id] || {};
    return { id, count: item.count || 0, name: item.name || '' };
  }).filter(x => x.count > 0);
  const total = entries.reduce((s, x) => s + x.count, 0);
  if (!total) {
    box.innerHTML = `<div class="empty">还没有字卡使用记录<br><span style="font-size:12px;">联系人用字卡回复后，这里会开始统计</span></div>`;
    return;
  }

  // 用当前字卡库解析文本：改名后显示新文本；卡已删除则回退到快照并标注
  const live = new Map();
  for (const g of ((c && c.cardGroups) || [])) {
    for (const card of (g.cards || [])) live.set(card.id, card.content);
  }
  const rows = entries.map(x => {
    const has = live.has(x.id);
    return {
      id: x.id,
      count: x.count,
      deleted: !has,
      text: has ? (live.get(x.id) || '') : (x.name || '（旧字卡）')
    };
  }).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'zh'));

  // 云图只展示使用次数最多的前 10 张（不足 10 张有多少显示多少）；清单仍列出全部
  const cloudRows = rows.slice(0, 10);
  const counts = cloudRows.map(r => r.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);

  const cloudHtml = cloudRows.map(r => {
    const fs = cloudFontSize(r.count, min, max);
    const op = 0.62 + 0.38 * ((fs - FONT_MIN) / (FONT_MAX - FONT_MIN));
    return `<span class="cu-word" style="font-size:${fs.toFixed(1)}px;opacity:${op.toFixed(2)};">${escapeHtml(r.text)}${r.deleted ? '<span class="cu-del">已删除</span>' : ''}</span>`;
  }).join('');

  const listHtml = rows.map(r => `<div class="cu-item">
      <div class="cu-text">${escapeHtml(r.text)}${r.deleted ? '<span class="cu-del">已删除</span>' : ''}</div>
      <div class="cu-meta"><span class="cu-count">${r.count} 次</span><br>${fmtPercent(r.count / total * 100)}</div>
    </div>`).join('');

  box.innerHTML = `
    <div class="cu-section">
      <div class="section-title">高频字卡</div>
      <div class="cu-cloud">${cloudHtml}</div>
    </div>
    <div class="cu-section">
      <div class="section-title">字卡清单<span class="cu-total">共 ${total} 次字卡回复</span></div>
      <div class="cu-list">${listHtml}</div>
    </div>`;
}

export async function openCardUsage() {
  if (!state.currentContactSettingId) return;
  await renderCardUsage();
  openPage('page-card-usage');
}

export function backFromCardUsage() {
  openPage('page-contact-setting');
}
