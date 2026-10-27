// 依赖：03-data.js
import { state, uid } from './01-state.js';
import { $, closeModal, dbGet, dbPut, escapeHtml, formatTime, now, showModal, toast } from './02-core.js';
import { getAllContacts, openPage, saveContact } from './03-data.js';

/* ============ 占卜（塔罗 / 雷诺曼） ============
   历史记录存 meta store 单键 divine_history：{ k, list:[{id,ts,dtype,spread,text}] }，最多保留 30 条 */

// ---- 塔罗牌库（22 大阿尔卡那 + 56 小阿尔卡那） ----
const TAROT_DECK = [
  { name:'愚者', up:'核心：踏入全新领域的起点，保持开放与纯真的心态，勇敢迈出第一步', rev:'核心：鲁莽冲动、缺乏规划，或因恐惧而裹足不前' },
  { name:'魔术师', up:'核心：拥有实现目标的全部能力与资源，行动力与创造力正旺', rev:'核心：才华浪费、注意力涣散，或遇到花言巧语的欺骗' },
  { name:'女祭司', up:'核心：连接内在直觉与潜意识，静心倾听内心的声音', rev:'核心：忽略内在声音，认知片面，被表象蒙蔽' },
  { name:'皇后', up:'核心：生命力与创造力蓬勃生长，享受丰盛与滋养', rev:'核心：创造力受阻，过度依赖他人，忽略自我照顾' },
  { name:'皇帝', up:'核心：以理性与规则建立秩序，稳重掌控局面', rev:'核心：专制独裁、僵化固执，规则反而成为枷锁' },
  { name:'教皇', up:'核心：遵循传统与规则，寻求正统的指引与信仰', rev:'核心：打破常规，挑战权威，走自己的路' },
  { name:'恋人', up:'核心：深刻的情感联结与灵魂共鸣，面临重要的真心选择', rev:'核心：价值观冲突，错误的选择，关系失去平衡' },
  { name:'战车', up:'核心：凭借强大的意志力与自律性战胜困难，勇往直前', rev:'核心：失去掌控力，方向混乱，内心矛盾冲突' },
  { name:'力量', up:'核心：以温柔与耐心化解冲突，内在的勇气胜过蛮力', rev:'核心：自我怀疑，内心软弱，被情绪牵着走' },
  { name:'隐者', up:'核心：退隐独处，向内探索，在寂静中寻找答案', rev:'核心：孤僻封闭，逃避现实，或不合时宜的孤立' },
  { name:'命运之轮', up:'核心：命运的齿轮转动，顺势而为，迎接转机', rev:'核心：厄运循环，时机不利，需静待时局变化' },
  { name:'正义', up:'核心：公正客观，真相大白，承担自己行为的后果', rev:'核心：不公、偏见、逃避责任，天平失衡' },
  { name:'倒吊人', up:'核心：换个角度看问题，自愿的暂停与牺牲带来新领悟', rev:'核心：无谓的牺牲，固执己见，白白消耗自己' },
  { name:'死神', up:'核心：旧的事物彻底终结，为新生腾出空间，蜕变开始', rev:'核心：抗拒改变，停滞不前，拖着不肯翻篇' },
  { name:'节制', up:'核心：找到平衡与和谐，循序渐进，中庸之道', rev:'核心：失衡、过度、缺乏耐心，走极端' },
  { name:'恶魔', up:'核心：被欲望与执念束缚，看清自己给自己戴上的锁链', rev:'核心：挣脱束缚，摆脱依赖，重获自由' },
  { name:'高塔', up:'核心：突发的剧变与冲击，虚假的结构轰然倒塌', rev:'核心：避免灾难，或是抗拒必要的剧变' },
  { name:'星星', up:'核心：经历磨难之后迎来希望与光明，被宇宙温柔治愈', rev:'核心：失去希望，信心崩塌，感到迷茫' },
  { name:'月亮', up:'核心：事物表象模糊，充满未知与不安，直觉是唯一向导', rev:'核心：迷雾散去，真相大白，恐惧逐渐消退' },
  { name:'太阳', up:'核心：充满光明与活力，成功圆满，纯粹的快乐', rev:'核心：快乐打折，成功延迟，乐观被暂时遮蔽' },
  { name:'审判', up:'核心：人生的复盘与觉醒，听见内心的召唤', rev:'核心：逃避觉醒，拒绝改变，困于自我批判' },
  { name:'世界', up:'核心：目标圆满达成，一个周期的完美落幕', rev:'核心：完成度不足，留有遗憾，最后一公里未走完' },
  // ---- 小阿尔卡那 · 权杖（火·行动） ----
  { name:'权杖一', up:'核心：新的行动火花点燃，充满热情与机遇的开端', rev:'核心：热情受阻，计划延迟，动力不足' },
  { name:'权杖二', up:'核心：运筹帷幄，规划未来蓝图，站在选择的关口', rev:'核心：犹豫不决，计划不周，害怕未知' },
  { name:'权杖三', up:'核心：事业初见成效，前景开阔，合作远航', rev:'核心：进展受挫，目光短浅，合作不顺' },
  { name:'权杖四', up:'核心：庆祝与稳定，家庭和睦，阶段性收获', rev:'核心：根基不稳，庆祝推迟，归属感缺失' },
  { name:'权杖五', up:'核心：竞争与冲突，意见纷杂，需要磨合', rev:'核心：避免冲突，内耗严重，矛盾逐渐缓和' },
  { name:'权杖六', up:'核心：胜利与认可，自信满满，众人拥护', rev:'核心：失败受挫，自负傲慢，认可延迟' },
  { name:'权杖七', up:'核心：坚守立场，迎接挑战，以一敌多', rev:'核心：压力过载，节节败退，立场动摇' },
  { name:'权杖八', up:'核心：事情飞速进展，消息即至，行动果断', rev:'核心：进展停滞，行程延误，节奏混乱' },
  { name:'权杖九', up:'核心：带伤坚守，谨慎防御，已接近目标', rev:'核心：防御过度，精疲力竭，固执死守' },
  { name:'权杖十', up:'核心：负担沉重，责任压身，仍坚持到底', rev:'核心：不堪重负，学会放手，卸下重担' },
  { name:'权杖侍从', up:'核心：好消息与新热情，探索精神，跃跃欲试', rev:'核心：三分钟热度，消息延迟，心浮气躁' },
  { name:'权杖骑士', up:'核心：勇往直前的行动派，热烈追求目标', rev:'核心：冲动鲁莽，方向不明，虎头蛇尾' },
  { name:'权杖王后', up:'核心：热情自信，魅力四射，温暖而有感染力', rev:'核心：嫉妒猜疑，情绪波动，自信受挫' },
  { name:'权杖国王', up:'核心：领袖风范，远见卓识，掌控全局', rev:'核心：专横独断，急功近利，领导力受损' },
  // ---- 小阿尔卡那 · 圣杯（水·情感） ----
  { name:'圣杯一', up:'核心：新的情感萌芽，爱意涌现，心灵富足', rev:'核心：情感空虚，爱意受阻，自我封闭' },
  { name:'圣杯二', up:'核心：两情相悦，平等互信，关系确立', rev:'核心：关系失衡，误会丛生，感情疏离' },
  { name:'圣杯三', up:'核心：欢聚庆祝，友谊深厚，分享喜悦', rev:'核心：过度放纵，聚会取消，小团体矛盾' },
  { name:'圣杯四', up:'核心：情感倦怠，对现状不满，忽视眼前的机会', rev:'核心：走出低迷，重新接纳，把握新机遇' },
  { name:'圣杯五', up:'核心：沉浸于失去，悲伤遗憾，别忽视身后的希望', rev:'核心：接受现实，走出悲伤，重拾希望' },
  { name:'圣杯六', up:'核心：怀旧温情，旧友重逢，纯真的回忆', rev:'核心：沉溺过去，停滞不前，该向前看了' },
  { name:'圣杯七', up:'核心：幻想与选择过多，需看清自己真正所求', rev:'核心：幻象破灭，回归现实，做出抉择' },
  { name:'圣杯八', up:'核心：离开旧有，去追寻更深层的意义', rev:'核心：徘徊不定，害怕改变，勉强留守' },
  { name:'圣杯九', up:'核心：心愿达成，满足富足，美梦成真', rev:'核心：贪得无厌，表面满足，内心空虚' },
  { name:'圣杯十', up:'核心：家庭圆满，情感和谐，幸福长久', rev:'核心：家庭失和，期望落空，关系表面化' },
  { name:'圣杯侍从', up:'核心：情感消息，浪漫邀约，富有想象力', rev:'核心：情感幼稚，多愁善感，消息不实' },
  { name:'圣杯骑士', up:'核心：浪漫的追求者，温柔体贴，带着诚意而来', rev:'核心：虚情假意，情绪化，承诺难兑现' },
  { name:'圣杯王后', up:'核心：温柔共情，直觉敏锐，情感滋养', rev:'核心：情绪泛滥，过度敏感，失去自我' },
  { name:'圣杯国王', up:'核心：情绪成熟稳重，宽厚包容，情感导师', rev:'核心：情绪压抑，冷漠疏离，情感操控' },
  // ---- 小阿尔卡那 · 宝剑（风·思维） ----
  { name:'宝剑一', up:'核心：真相与清晰，思维突破，新的认知诞生', rev:'核心：思维混乱，信息失真，判断失误' },
  { name:'宝剑二', up:'核心：两难抉择，回避真相，僵持的平衡', rev:'核心：抉择迫近，信息过载，僵局被打破' },
  { name:'宝剑三', up:'核心：心碎与伤痛，真相刺痛，也是必经的成长', rev:'核心：疗愈开始，释放伤痛，走出阴霾' },
  { name:'宝剑四', up:'核心：休整静养，暂时退隐，积蓄力量', rev:'核心：休息不足，重新出发，缓慢复原' },
  { name:'宝剑五', up:'核心：争执与算计，惨胜如败，得不偿失', rev:'核心：放下争执，和解止损，反思教训' },
  { name:'宝剑六', up:'核心：渡过难关，渐行渐远，走向平静', rev:'核心：困于原地，旧事缠身，转变受阻' },
  { name:'宝剑七', up:'核心：策略与谋略，剑走偏锋，暗中行事', rev:'核心：阴谋败露，良心不安，回归正道' },
  { name:'宝剑八', up:'核心：自我设限，束缚困局，其实都是心牢', rev:'核心：挣脱束缚，重获自由，看清出路' },
  { name:'宝剑九', up:'核心：深夜焦虑，忧思过度，噩梦缠身', rev:'核心：焦虑缓解，直面恐惧，黎明将至' },
  { name:'宝剑十', up:'核心：触底终结，伤痛至极，也是转机之始', rev:'核心：缓慢复苏，抗拒结束，痛而不休' },
  { name:'宝剑侍从', up:'核心：好奇心旺盛，思维敏捷，新消息与学习', rev:'核心：言语轻率，八卦是非，思维浮躁' },
  { name:'宝剑骑士', up:'核心：思维迅捷，雷厉风行，直截了当', rev:'核心：言语伤人，急躁冒进，考虑不周' },
  { name:'宝剑王后', up:'核心：理性独立，洞察敏锐，明辨是非', rev:'核心：刻薄冷漠，偏见固执，理性过度' },
  { name:'宝剑国王', up:'核心：理智权威，公正严明，逻辑清晰', rev:'核心：冷酷专断，滥用权力，逻辑诡辩' },
  // ---- 小阿尔卡那 · 星币（土·物质） ----
  { name:'星币一', up:'核心：新的财富机会，务实起步，打下物质根基', rev:'核心：机会流失，计划不务实，财务需谨慎' },
  { name:'星币二', up:'核心：灵活平衡，多方兼顾，弹性应对', rev:'核心：顾此失彼，财务失衡，疲于应付' },
  { name:'星币三', up:'核心：专业协作，技能精进，团队成事', rev:'核心：合作不畅，技艺粗糙，缺乏规划' },
  { name:'星币四', up:'核心：守成与稳定，掌控财务，略显保守', rev:'核心：过度吝啬，执念物质，或学会放手' },
  { name:'星币五', up:'核心：财务困顿，缺乏安全感，需寻求援助', rev:'核心：困境好转，援助到来，重拾信心' },
  { name:'星币六', up:'核心：慷慨给予，资源流动，施与受的平衡', rev:'核心：施舍失衡，债务纠葛，付出不对等' },
  { name:'星币七', up:'核心：耐心等待收获，长期耕耘，评估进展', rev:'核心：回报不佳，急功近利，需调整方向' },
  { name:'星币八', up:'核心：精益求精，专注打磨，技能变现', rev:'核心：敷衍了事，缺乏热情，原地踏步' },
  { name:'星币九', up:'核心：独立富足，自律换来的精致生活', rev:'核心：财务依赖，过度消费，安全感缺失' },
  { name:'星币十', up:'核心：家族富足，长远基业，物质圆满', rev:'核心：家产纠纷，长远规划失误，根基动摇' },
  { name:'星币侍从', up:'核心：学习实务，新工作机会，脚踏实地', rev:'核心：学习懈怠，好高骛远，机会把握不足' },
  { name:'星币骑士', up:'核心：踏实勤恳，稳步推进，值得信赖', rev:'核心：固执僵化，进展缓慢，缺乏变通' },
  { name:'星币王后', up:'核心：务实持家，富足安稳，滋养他人', rev:'核心：过度操劳，物质焦虑，忽略自我' },
  { name:'星币国王', up:'核心：事业有成，财富稳健，务实的领袖', rev:'核心：唯利是图，固执守财，事业波动' },
];

// ---- 雷诺曼牌库（36 张，无正逆位） ----
const LENORMAND_DECK = [
  { name:'骑士', meaning:'消息传来、新访客、动向' },
  { name:'四叶草', meaning:'小幸运、机缘、轻松好事' },
  { name:'船', meaning:'远行、变动、贸易与离开' },
  { name:'房子', meaning:'家庭、安稳、居所与根基' },
  { name:'树', meaning:'健康、成长、根深蒂固' },
  { name:'云', meaning:'困惑迷雾、暂时不明朗' },
  { name:'蛇', meaning:'曲折、小人、诱惑纠葛' },
  { name:'棺材', meaning:'结束、病痛、一段事收尾' },
  { name:'花束', meaning:'喜悦、礼物、邀请与善意' },
  { name:'镰刀', meaning:'断然决断、突变与切断' },
  { name:'鞭子', meaning:'争执、重复、劳累冲突' },
  { name:'小鸟', meaning:'交谈、成双、短讯往来' },
  { name:'小孩', meaning:'新开始、天真、小事物' },
  { name:'狐狸', meaning:'机敏提防、工作上的算计' },
  { name:'熊', meaning:'强者、上司、保护与压力' },
  { name:'星星', meaning:'希望、指引、名声与理想' },
  { name:'鹳', meaning:'转变、迁移、境况改善' },
  { name:'狗', meaning:'朋友、忠诚、陪伴支持' },
  { name:'塔', meaning:'机构、长久、官方与孤独' },
  { name:'花园', meaning:'公众、聚会、圈子社交' },
  { name:'山', meaning:'阻碍、延迟、远距离' },
  { name:'十字路口', meaning:'选择、分岔、多条路径' },
  { name:'老鼠', meaning:'损耗、焦虑、暗中蚕食' },
  { name:'心', meaning:'爱情、喜欢、真心相待' },
  { name:'戒指', meaning:'承诺、合约、关系闭环' },
  { name:'书', meaning:'秘密、学习、未揭之事' },
  { name:'信', meaning:'讯息、文件、通知到来' },
  { name:'男人', meaning:'关键男性、问卜者本身' },
  { name:'女人', meaning:'关键女性、问卜者本身' },
  { name:'百合', meaning:'成熟耐心、大器晚成' },
  { name:'太阳', meaning:'成功明朗、活力充沛' },
  { name:'月亮', meaning:'情绪、认可、名声与夜班' },
  { name:'钥匙', meaning:'解答、关键、肯定无疑' },
  { name:'鱼', meaning:'钱财、丰足、生意机会' },
  { name:'锚', meaning:'稳定、工作、靠岸坚守' },
  { name:'十字架', meaning:'负担、信念、宿命考验' }
];

// ---- 牌阵定义 ----
const DIVINE_SPREADS = {
  tarot: [
    { n:1, name:'单张', positions:['核心提示'] },
    { n:3, name:'三张', positions:['过去','现在','未来'] },
    { n:5, name:'五张', positions:['现状','阻碍','建议','环境','结果'] }
  ],
  lenormand: [
    { n:1, name:'单张', positions:['当日指引'] },
    { n:3, name:'三张', positions:['现状','建议','结果'] },
    { n:5, name:'五张', positions:['过去','现在','发展','建议','结果'] }
  ]
};

// ---- 洗牌算法 ----
function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ---- 页面入口与渲染（分步流程：1 选牌种 → 2 选牌阵+问题 → 3 结果） ----
export function openDivinePage() {
  // 每次进入页面都重置回第一步
  state.divineStep = 1;
  state.divineQuestion = '';
  openPage('page-divine');
  const q = $('divine-question'); if (q) q.value = '';
  renderDivinePage();
}
function applyDivineStep() {
  const s = state.divineStep || 1;
  for (const n of [1, 2, 3]) {
    const el = $(`divine-step-${n}`);
    if (el) el.classList.toggle('hide', n !== s);
  }
}
export function renderDivinePage() {
  applyDivineStep();
  const s = state.divineStep || 1;
  if (s === 2) {
    const t2 = $('divine-step2-title');
    if (t2) t2.textContent = `${state.divineType === 'tarot' ? '塔罗牌' : '雷诺曼'} · 选择牌阵`;
    const sl = $('divine-spread-list');
    if (sl) {
      sl.innerHTML = DIVINE_SPREADS[state.divineType].map((sp, i) =>
        `<button class="mood-role-tab${state.divineSpreadIdx[state.divineType] === i ? ' sel' : ''}" onclick="selectDivineSpread(${i})">${sp.name}</button>`
      ).join('');
    }
  } else if (s === 3) {
    renderDivine();
  }
}
// 第一步：选择牌种 → 进入第二步
export function divinePickKind(t) {
  state.divineType = t;
  state.divineStep = 2;
  renderDivinePage();
}
export function switchDivineType(t) {
  state.divineType = t;
  renderDivinePage();
}
export function selectDivineSpread(i) {
  state.divineSpreadIdx[state.divineType] = i;
  renderDivinePage();
}
// 第二步：记录问题并抽牌 → 进入第三步
export async function startDivineDraw() {
  const q = $('divine-question');
  state.divineQuestion = q ? q.value.trim() : '';
  await drawDivine();
  state.divineStep = 3;
  renderDivinePage();
}
// 重新抽牌：清空问题并回到第一步
export function divineRestart() {
  state.divineStep = 1;
  state.divineQuestion = '';
  const q = $('divine-question'); if (q) q.value = '';
  renderDivinePage();
}

// ---- 抽牌 ----
export async function drawDivine() {
  const type = state.divineType;
  const deck = type === 'tarot' ? TAROT_DECK : LENORMAND_DECK;
  const spread = DIVINE_SPREADS[type][state.divineSpreadIdx[type]];
  const drawn = shuffleArr(deck).slice(0, spread.n).map((card, i) => {
    const upright = type === 'tarot' ? Math.random() < 0.5 : true;
    return { pos: spread.positions[i], name: card.name, upright, meaning: type === 'tarot' ? (upright ? card.up : card.rev) : card.meaning };
  });
  const result = { id: uid(), ts: now(), dtype: type, spread: spread.name, question: state.divineQuestion || '', cards: drawn };
  const text = buildDivineText(result);
  state._lastDivine = { result, text };
  await pushDivineHistory(result, text);
  renderDivine();
}
function buildDivineText(r) {
  const title = r.dtype === 'tarot' ? '塔罗占卜' : '雷诺曼占卜';
  const lines = r.cards.map(c => r.dtype === 'tarot'
    ? `【${c.pos}】${c.name}（${c.upright ? '正位' : '逆位'}）\n${c.meaning}`
    : `【${c.pos}】${c.name}\n${c.meaning}`);
  const qLine = r.question ? `问题：${r.question}\n` : '';
  return `${qLine}🔮 ${title} · ${r.spread}\n${lines.join('\n')}`;
}

// ---- 结果渲染（牌面卡片 + 翻转牌义） ----
export function renderDivine() {
  const box = $('divine-result'); if (!box) return;
  const cur = state._lastDivine;
  if (!cur || cur.result.dtype !== state.divineType) {
    box.innerHTML = '<div class="insp-empty">静心默念所问之事，然后点击下方按钮抽牌</div>';
    return;
  }
  box.innerHTML = divineResultHtml(cur.result);
}
export function divineResultHtml(r) {
  const isTarot = r.dtype === 'tarot';
  const cards = r.cards.map(c =>
    `<button class="dv-card" onclick="flipDivineCard(this)"><div class="dv-card-inner">` +
    `<div class="dv-face dv-front"><svg class="i" style="width:26px;height:26px;stroke:#fff;"><use href="#icon-sparkles"/></svg><span class="dv-front-pos">${escapeHtml(c.pos)}</span></div>` +
    `<div class="dv-face dv-back"><div class="dv-pos">${escapeHtml(c.pos)}</div>` +
    `<div class="dv-name">${escapeHtml(c.name)}${isTarot ? `<span class="dv-ori ${c.upright ? 'up' : 'rev'}">${c.upright ? '正位' : '逆位'}</span>` : ''}</div>` +
    `<div class="dv-meaning">${escapeHtml(c.meaning)}</div></div>` +
    `</div></button>`
  ).join('');
  return `<div class="dv-cards">${cards}</div>` +
    `<div class="dv-hint">点击牌面翻转查看牌义</div>` +
    `<div class="dv-actions">` +
    `<button class="btn btn-outline" onclick="copyDivineResult()">复制结果</button>` +
    `<button class="btn btn-outline" onclick="sendDivineToChat()">发送到聊天</button>` +
    `<button class="btn" onclick="divineToInspiration()">存入灵感随记</button></div>`;
}
export function flipDivineCard(el) {
  el.classList.toggle('flipped');
}

// ---- 历史记录（IndexedDB meta: divine_history） ----
async function pushDivineHistory(result, text) {
  const r = await dbGet('meta', 'divine_history');
  const list = (r && r.list) || [];
  list.unshift({ id: result.id, ts: result.ts, dtype: result.dtype, spread: result.spread, text });
  if (list.length > 30) list.length = 30;
  await dbPut('meta', { k: 'divine_history', list });
}
export async function openDivineHistory() {
  const r = await dbGet('meta', 'divine_history');
  const list = (r && r.list) || [];
  window._divineHist = list;
  if (!list.length) { showModal('占卜历史', '<div class="insp-empty">还没有占卜记录</div>'); return; }
  const body = list.map((h, i) =>
    `<div class="insp-item" onclick="viewDivineHistory(${i})">` +
    `<div class="it-text">${h.dtype === 'tarot' ? '塔罗牌' : '雷诺曼'} · ${escapeHtml(h.spread)}</div>` +
    `<div class="it-time">${formatTime(h.ts)}</div></div>`
  ).join('');
  showModal('占卜历史', `<div style="max-height:55vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;">${body}</div>`);
}
export function viewDivineHistory(i) {
  const h = (window._divineHist || [])[i]; if (!h) return;
  showModal(`${h.dtype === 'tarot' ? '塔罗占卜' : '雷诺曼占卜'} · ${h.spread}`,
    `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.7;margin:0;">${escapeHtml(h.text)}</pre>`,
    [
      { label: '返回列表', cls: 'btn-outline', onClick: openDivineHistory },
      { label: '关闭', onClick: closeModal }
    ]);
}

// ---- 结果操作：复制 / 发送到聊天 / 存入灵感随记 ----
export async function copyDivineResult() {
  if (!state._lastDivine) { toast('请先抽牌'); return; }
  try {
    await navigator.clipboard.writeText(state._lastDivine.text);
    toast('已复制到剪贴板');
  } catch (e) {
    toast('复制失败，请手动选择文本复制');
  }
}
export async function sendDivineToChat() {
  if (!state._lastDivine) { toast('请先抽牌'); return; }
  const contacts = await getAllContacts();
  if (!contacts.length) { toast('暂无联系人'); return; }
  const body = contacts.map(c =>
    `<button class="btn btn-outline" style="width:100%;margin-bottom:8px;" onclick="sendDivineToContact('${c.id}')">${escapeHtml(c.name)}</button>`
  ).join('');
  showModal('发送到聊天', body, [{ label: '取消', cls: 'btn-outline', onClick: closeModal }]);
}
export async function sendDivineToContact(cid) {
  if (!state._lastDivine) return;
  const contacts = await getAllContacts();
  const c = contacts.find(x => x.id === cid);
  if (!c) return;
  c.messages = c.messages || [];
  c.messages.push({
    id: uid(), from: 'me', type: 'text', content: state._lastDivine.text,
    time: now(), replyTo: null, snapshot: null,
    read: false, readAt: 0, replyAt: 0, replied: false
  });
  await saveContact(c);
  closeModal();
  toast(`已发送到与「${c.name}」的聊天`);
}
// 联动灵感随记：跳转页面 + 预填引导语与结果文本 + 聚焦并选中引导语
export function divineToInspiration() {
  if (!state._lastDivine) { toast('请先抽牌'); return; }
  openPage('page-inspiration');
  const ta = $('insp-input');
  if (!ta) return;
  const guide = '在这里写下你对这次占卜的解读或感悟...';
  const prefix = `【占卜复盘】\n（`;
  ta.value = `${prefix}${guide}）\n\n---\n\n${state._lastDivine.text}`;
  ta.focus();
  const start = prefix.length;
  ta.setSelectionRange(start, start + guide.length);
}

// ---- 模块初始化（由 08-main.js 的 initApp 调用） ----
export function initDivineModule() {
  state.divineType = 'tarot';
  state.divineSpreadIdx = { tarot: 0, lenormand: 0 };
  state.divineStep = 1;
  state.divineQuestion = '';
  state._lastDivine = null;
}
