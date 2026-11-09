// 依赖：03-data.js
import { state, uid } from './01-state.js';
import { $, closeModal, confirmDialog, dbGet, dbPut, escapeHtml, formatTime, now, showModal, toast } from './02-core.js';
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
// 塔罗牌阵：layout 使用归一化几何坐标（卡宽 1 单位、卡高 1.6 单位，slots 为 [左, 上, 旋转角度]）；
// cols/rows 是牌阵外框的宽高单位数，渲染时换算成百分比绝对定位。
const TAROT_SPREADS = [
  { name:'三张牌 · 身心灵', n:3, positions:['身体','心智','灵性'],
    layout:{ cols:4.7, rows:2.6, slots:[[0.5,0.5],[1.85,0.5],[3.2,0.5]] } },
  { name:'圣三角', n:3, positions:['过去的经验·问题成因','问题的状况','事件结果'],
    layout:{ cols:4.0, rows:4.5, slots:[[1.5,2.4],[0.4,0.5],[2.6,0.5]] } },
  { name:'他心知', n:3, positions:['对你的潜意识感受','对你的想法打算','对你的态度方式'],
    layout:{ cols:3.5, rows:6.0, slots:[[2.1,4.0],[0.3,2.2],[2.0,0.4]] } },
  { name:'全能无牌阵', n:4, positions:['牌位一','牌位二','牌位三','指引牌'],
    layout:{ cols:4.0, rows:4.7, slots:[[0.4,2.4],[1.5,2.7],[2.6,2.4],[1.5,0.4]] } },
  { name:'二选一', n:5, positions:['现状','A·发展','A·结果','B·发展','B·结果'],
    layout:{ cols:4.7, rows:6.3, slots:[[2.0,4.3],[0.8,2.2],[0.8,0.4],[3.2,2.2],[3.2,0.4]] } },
  { name:'脉轮 · 七张', n:7, positions:['海底轮','脐轮','太阳轮','心轮','喉轮','眉心轮','顶轮'],
    layout:{ cols:5.0, rows:13.1, slots:[[2.0,11.0],[2.0,9.25],[2.0,7.5],[2.0,5.75],[2.0,4.0],[2.0,2.25],[2.0,0.5]] } },
  { name:'每周牌阵 · 七天', n:7, positions:['周日','周一','周二','周三','周四','周五','周六'],
    layout:{ cols:5.75, rows:4.45, slots:[[0.5,0.5],[1.75,0.5],[3.0,0.5],[4.25,0.5],[1.125,2.35],[2.375,2.35],[3.625,2.35]] } },
  { name:'友谊检测', n:7, positions:['对方真实性格','对方对我的真实想法','对方对你是否有隐瞒','对方对你的不满','对方是否有在背后吐槽你','关系发展趋势','指引/建议'],
    layout:{ cols:6.0, rows:5.7, slots:[[0.65,1.9],[3.25,1.9],[0.25,3.7],[1.65,3.7],[3.05,3.7],[4.45,3.7],[1.95,0.3]] } },
  { name:'心之声', n:8, positions:['感情现状','不久的未来','对你的印象（内在）','对你的印象（外在）','对方心态','对你的期望','你的心态','建议'],
    layout:{ cols:5.6, rows:7.4, slots:[[2.3,0.3],[2.3,5.4],[0.2,3.0],[4.4,3.0],[0.9,1.6],[3.7,4.4],[3.7,1.6],[0.9,4.4]] } },
  { name:'凯尔特十字', n:10, positions:['现状','阻碍/助力','潜意识根源','过去影响','近期可能','即将到来','自我认知','外部影响','希望与恐惧','最终结果'],
    layout:{ cols:5.9, rows:7.7, slots:[[1.9,2.1],[1.9,2.1,90],[1.9,4.0],[0.5,2.1],[1.9,0.2],[3.3,2.1],[4.7,5.9],[4.7,4.0],[4.7,2.1],[4.7,0.2]] } }
];
// 雷诺曼牌阵（按参考图的位置关系；沿用塔罗的归一化几何坐标写法）
// H 型：三列，左列自己情况 1-3（上→下），中列关联（纽带）居中 1 张，右列对方情况 5-7（上→下）
// 选择：三列一行一组，A/B/C 每组 3 张；二选一用 A+B 共 6 张，三选一用 A+B+C 共 9 张
const LENORMAND_SPREADS = [
  { name:'H型牌阵', n:7,
    positions:['自己情况·1','自己情况·2','自己情况·3','关联（纽带）','对方情况·1','对方情况·2','对方情况·3'],
    layout:{ cols:4.1, rows:5.4, slots:[[0.2,0.2],[0.2,2.0],[0.2,3.8],[1.55,2.0],[2.9,0.2],[2.9,2.0],[2.9,3.8]] } },
  { name:'选择牌阵 · 二选一', n:6,
    positions:['选择A·1','选择A·2','选择A·3','选择B·1','选择B·2','选择B·3'],
    layout:{ cols:4.1, rows:3.8, slots:[[0.2,0.2],[1.55,0.2],[2.9,0.2],[0.2,2.0],[1.55,2.0],[2.9,2.0]] } },
  { name:'选择牌阵 · 三选一', n:9,
    positions:['选择A·1','选择A·2','选择A·3','选择B·1','选择B·2','选择B·3','选择C·1','选择C·2','选择C·3'],
    layout:{ cols:4.1, rows:5.4, slots:[[0.2,0.2],[1.55,0.2],[2.9,0.2],[0.2,2.0],[1.55,2.0],[2.9,2.0],[0.2,3.8],[1.55,3.8],[2.9,3.8]] } },
  // 五张牌：一行横排，五张同尺寸（列宽固定，空间不足时整排随牌阵等比缩小，不出现大小混排）
  { name:'五张牌阵', n:5,
    positions:['牌位一','牌位二','牌位三','牌位四','牌位五'],
    layout:{ cols:5.8, rows:2.3, slots:[[0.2,0.2],[1.35,0.2],[2.5,0.2],[3.65,0.2],[4.8,0.2]] } }
];
const DIVINE_SPREADS = {
  tarot: TAROT_SPREADS,
  lenormand: LENORMAND_SPREADS
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

// ---- 页面入口与渲染（塔罗 / 雷诺曼统一：1 选牌种 → 2 选牌阵 → 3 输问题 → 4 结果） ----
export function openDivinePage() {
  // 每次进入页面都重置回第一步
  dvClearTimers();
  state._dvDraw = null;
  state._dvRevealed = false;
  state.divineMode = 'auto'; // 默认自动抽
  state.divineStep = 1;
  state.divineQuestion = '';
  openPage('page-divine');
  const q = $('divine-question'); if (q) q.value = '';
  renderDivinePage();
}
function applyDivineStep() {
  const s = state.divineStep || 1;
  for (const n of [1, 2, 3, 4]) {
    const el = $(`divine-step-${n}`);
    if (el) el.classList.toggle('hide', n !== s);
  }
  // 第三步的输入区与「洗牌 / 选牌」区互斥：抽牌中隐藏问题块，显示牌背
  const drawing = s === 3 && !!state._dvDraw;
  const stage = $('divine-draw-stage');
  if (stage) stage.classList.toggle('hide', !drawing);
  const block = $('divine-question-block');
  if (block) block.classList.toggle('hide', drawing);
  const back3 = $('divine-back-3');
  if (back3) back3.classList.toggle('hide', drawing);
  // 抽牌中收起底部留白，让牌扇底边贴近页面底部
  const step3 = $('divine-step-3');
  if (step3) step3.classList.toggle('dv-drawing', drawing);
  const body = document.querySelector('.divine-body');
  if (body) body.classList.toggle('dv-drawing', drawing);
  const scroller = step3 && step3.closest('.page-scroll');
  if (scroller) scroller.classList.toggle('dv-drawing', drawing);
  document.querySelectorAll('.dv-mode-btn').forEach(b => b.classList.toggle('sel', b.dataset.mode === (state.divineMode || 'auto')));
}
// 问题输入块始终是同一个实例，固定放在第三步（已输入内容不丢）
function placeQuestionBlock() {
  const block = $('divine-question-block');
  if (!block) return;
  const slot = $('divine-q-slot-3');
  if (slot && block.parentElement !== slot) slot.appendChild(block);
}
function renderSpreadStep() {
  const isTarot = state.divineType === 'tarot';
  const t2 = $('divine-step2-title');
  if (t2) t2.textContent = `${isTarot ? '塔罗牌' : '雷诺曼'} · 选择牌阵`;
  const sl = $('divine-spread-list');
  const idx = state.divineSpreadIdx[state.divineType] || 0;
  const spreads = isTarot ? TAROT_SPREADS : LENORMAND_SPREADS;
  if (sl) {
    sl.className = 'dv-spread-list';
    sl.innerHTML = spreads.map((sp, i) =>
      `<button class="dv-spread-item${idx === i ? ' sel' : ''}" onclick="selectDivineSpread(${i})">` +
      `<span class="dv-spread-name">${escapeHtml(sp.name)}</span>` +
      `<span class="dv-spread-meta">${sp.n} 张</span></button>`
    ).join('');
  }
  const next = $('divine-spread-next');
  if (next) next.classList.remove('hide');
}
export function renderDivinePage() {
  applyDivineStep();
  placeQuestionBlock();
  const s = state.divineStep || 1;
  if (s === 2) renderSpreadStep();
  else if (s === 4) renderDivine();
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
// 牌阵选好（塔罗 / 雷诺曼一致）→ 进入输问题步骤
export function divineConfirmSpread() {
  state.divineStep = 3;
  renderDivinePage();
}
export function divineBackStep() {
  if ((state.divineStep || 1) <= 1) return;
  // 抽牌途中返回：取消计时器与牌池，回到问题输入
  dvClearTimers();
  state._dvDraw = null;
  state.divineStep -= 1;
  renderDivinePage();
}
// 输问题后抽牌 → 先洗牌（1.2s 可跳过）→ 自己抽 / 自动抽 → 统一翻牌 → 结果
export function setDivineDrawMode(m) {
  state.divineMode = (m === 'manual') ? 'manual' : 'auto';
  document.querySelectorAll('.dv-mode-btn').forEach(b => b.classList.toggle('sel', b.dataset.mode === state.divineMode));
}
function dvClearTimers() {
  (state._dvTimers || []).forEach(id => clearTimeout(id));
  state._dvTimers = [];
  dvFanCancel();
}
function dvLater(fn, ms) {
  const id = setTimeout(fn, ms);
  if (!state._dvTimers) state._dvTimers = [];
  state._dvTimers.push(id);
  return id;
}
// 牌背：塔罗 / 雷诺曼各用各的，绝不串种
const DV_BACK_LENORMAND = './assets/divine/lenormand/back.webp';
function dvBackArt(dtype) {
  if (dtype === 'tarot') {
    return '<svg class="dv-front-art" viewBox="0 0 64 100" aria-hidden="true"><use href="#dv-card-back-tarot"/></svg>';
  }
  return `<img class="dv-back-art-img" src="${DV_BACK_LENORMAND}" alt="" draggable="false" onerror="dvImgError(this)">`;
}
function shuffleMarkup() {
  const cards = Array.from({ length: 7 }, (_, i) =>
    `<div class="dv-shuffle-card" style="--i:${i}">${dvBackArt(state.divineType)}</div>`).join('');
  return `<div class="dv-draw-head"><span class="dv-draw-status" id="dv-draw-status">正在洗牌…</span>` +
    `<button class="dv-skip-btn" data-act="skip" type="button">跳过洗牌</button></div>` +
    `<div class="dv-shuffle on" id="dv-shuffle">${cards}</div>`;
}
// 底部牌扇：整副牌是洗好的一条循环队列，屏幕上只保留 21 个连续牌位（中间 1 + 左右各 10）。
// 拖动/惯性只改窗口在队列上的浮点位置 fanX（单位=牌位），21 个槽位按「离中心的槽距」重算倾角与弧高 →
// 牌沿弧滚动、越靠两侧越斜，像拨动转盘；因为队列循环取模，任意牌都能转到任意位上。
const DV_SLOTS = 21;                          // 屏幕上保留的牌位数
const DV_PEEK = 17;                           // 相邻牌位的横向步进目标（露出的可点宽度），窄屏按可容纳宽度收缩
const DV_FAN_MAXA = 24;                       // 最外侧牌位的倾角（度）
const DV_ARC_H = 116;                         // 弧线落差：中间那张最高（y=0），向两侧逐渐降低到 116
let dvFanDrag = null;       // { pointerId, wrap, startX, startY, startFanX, moved, card, lastX, lastT, vx }
let dvFanRAF = 0;           // 位置刷新 rAF
let dvFanGlideRAF = 0;      // 松手惯性 rAF
function dvFanStop() {
  if (dvFanRAF) cancelAnimationFrame(dvFanRAF); dvFanRAF = 0;
  if (dvFanGlideRAF) cancelAnimationFrame(dvFanGlideRAF); dvFanGlideRAF = 0;
}
function dvFanCancel() { dvFanStop(); dvFanDrag = null; }
function dvFanMod(v, n) { return ((v % n) + n) % n; }
// 把 21 个槽位按当前窗口位置落到弧上；槽位上的牌是从队列里循环取的一段连续牌
function dvFanPlace() {
  const track = $('dv-fan-track'), d = state._dvDraw;
  const m = d && d._fan;
  if (!track || !m) return;
  const n = m.n;
  const pos = dvFanMod(d.fanX || 0, n);
  const q0 = Math.floor(pos), frac = pos - q0;
  const cards = track.children;
  for (let k = 0; k < cards.length; k++) {
    const el = cards[k];
    const qi = (q0 + k) % n;
    // 槽距（含小数部分）→ 归一化到 [-1,1]：中间竖直、两侧 ±24°，纵向按落差抛物线抬起
    const t = Math.max(-1, Math.min(1, (k - (DV_SLOTS - 1) / 2 - frac) / ((DV_SLOTS - 1) / 2)));
    const x = m.base + (k - frac) * m.step;
    const y = DV_ARC_H * t * t;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${(t * DV_FAN_MAXA).toFixed(2)}deg)`;
    if (el._qi !== qi) {
      el._qi = qi;
      el.dataset.pool = String(qi);
      const idx = d.picked.indexOf(qi);
      el.classList.toggle('is-picked', idx >= 0);
      const no = el.querySelector('.dv-pool-no');
      if (no) no.textContent = idx >= 0 ? String(idx + 1) : '';
    }
  }
}
function dvFanSchedule() {
  if (dvFanRAF) return;
  dvFanRAF = requestAnimationFrame(() => { dvFanRAF = 0; dvFanPlace(); });
}
// 松手惯性：按横向速度继续拨动窗口，指数衰减到静止（队列循环，没有端点）
function dvFanGlideStart(vx) {
  if (!isFinite(vx) || Math.abs(vx) < 0.05) return;
  if (dvFanGlideRAF) cancelAnimationFrame(dvFanGlideRAF);
  let v = vx, last = performance.now(), acc = 0;
  const step = ts => {
    const dt = Math.max(1, Math.min(64, ts - last)); last = ts;
    const d = state._dvDraw;
    if (!d) { dvFanGlideRAF = 0; return; }
    const stp = (d._fan && d._fan.step) || DV_PEEK;
    d.fanX = dvFanMod((d.fanX || 0) - (v * dt) / stp, d.pool.length);
    dvFanPlace();
    v *= Math.pow(0.9955, dt);      // 阻尼：约每 100ms 衰减到原来的 64%
    acc += dt;
    if (Math.abs(v) < 0.015 || acc > 1600) { dvFanGlideRAF = 0; return; }
    dvFanGlideRAF = requestAnimationFrame(step);
  };
  dvFanGlideRAF = requestAnimationFrame(step);
}
// 牌扇几何：卡宽按视口宽取值（桌面封顶 96），21 个牌位居中排开、两侧留出旋转外溢；扇区高度 = 弧线落差 + 整张牌高 + 旋转外扩
function dvFanLayout(stage) {
  const wrap = stage.querySelector('.dv-fan-wrap');
  const track = stage.querySelector('.dv-fan-track');
  const d = state._dvDraw;
  if (!wrap || !track || !d) return;
  const w = wrap.clientWidth || stage.clientWidth;
  if (!w) return;
  const vw = window.innerWidth || w;
  const cw = Math.max(72, Math.min(96, Math.round(vw * 0.22)));
  const ch = Math.round(cw * 1.6);
  const rad = DV_FAN_MAXA * Math.PI / 180;
  const sinA = Math.sin(rad), cosA = Math.cos(rad);
  // 整张牌旋转后会比牌宽多出 overhang，两侧都要留出来，首末张才不会被屏幕边缘切掉
  const overhang = Math.ceil((cw / 2) * cosA + (ch / 2) * sinA - cw / 2);
  // 21 个牌位整排铺满且不越界；窄屏按可容纳宽度收缩步进
  const step = Math.max(8, Math.min(DV_PEEK, Math.floor((w - cw - overhang * 2) / (DV_SLOTS - 1))));
  const fanW = (DV_SLOTS - 1) * step + cw;
  const base = Math.round((w - fanW) / 2);
  // 整张牌都显示：扇区高度 = 弧线落差 + 牌高 + 旋转后上下外扩，底边正好是扇区下沿
  const fanH = Math.ceil((DV_ARC_H + (ch / 2) * (1 + cosA) + (cw / 2) * sinA) * 100) / 100;
  stage.style.setProperty('--dv-cw', `${cw}px`);
  wrap.style.height = `${fanH}px`;
  track.style.width = `${fanW + step}px`;
  for (let k = 0; k < track.children.length; k++) {
    const el = track.children[k];
    el.style.clipPath = '';
    el.style.zIndex = String(DV_SLOTS - Math.abs(k - (DV_SLOTS - 1) / 2));
  }
  d._fan = { n: d.pool.length, cw, ch, step, base, fanH, w };
  if (typeof d.fanX !== 'number') d.fanX = Math.floor((d.pool.length - DV_SLOTS) / 2);  // 默认窗口居中
  d.fanX = dvFanMod(d.fanX || 0, d.pool.length);
  dvFanPlace();
}
// 牌阵按可用区域等比缩放，保证牌阵与底部牌扇在同一屏内都能看到
function dvFitBoard(stage) {
  const target = stage.querySelector('.dv-target');
  const board = target && target.querySelector('.dv-board');
  if (!target || !board) return;
  const tw = target.clientWidth, th = target.clientHeight;
  if (!tw || !th) return;
  const ratio = parseFloat(getComputedStyle(board).getPropertyValue('--dv-ratio')) || 0.6;
  let w = Math.min(tw, 600);
  const availH = Math.max(120, th - 6);
  if (w / ratio > availH) w = availH * ratio;
  board.style.width = `${Math.floor(w)}px`;
  board.style.maxWidth = '100%';
}
// 点选 / 拖动事件都只在 stage 上委托一次，不给每张牌单独挂监听
function bindDrawStage() {
  const stage = $('divine-draw-stage');
  if (!stage || stage.dataset.bound === '1') return;
  stage.dataset.bound = '1';
  // 牌扇只认「轻点」：松手位移小于阈值才选中；拖动改 fanX 让牌沿弧滚，不会误选
  stage.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (t && t.dataset.act === 'skip') finishDivineShuffle();
  });
  stage.addEventListener('pointerdown', e => {
    const wrap = e.target.closest('.dv-fan-wrap');
    const d = state._dvDraw;
    if (!wrap || !d || d.phase !== 'pick' || state.divineMode !== 'manual') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dvFanCancel();
    const ts = performance.now();
    dvFanDrag = {
      pointerId: e.pointerId, wrap, startX: e.clientX, startY: e.clientY,
      startFanX: d.fanX || 0, moved: 0, card: e.target.closest('.dv-pool-card'),
      lastX: e.clientX, lastT: ts, vx: 0
    };
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stage.addEventListener('pointermove', e => {
    const s = dvFanDrag; const d = state._dvDraw;
    if (!s || s.pointerId !== e.pointerId || !d) return;
    const dx = e.clientX - s.startX, dy = e.clientY - s.startY;
    s.moved = Math.max(s.moved, Math.hypot(dx, dy));
    const ts = performance.now();
    const dt = ts - s.lastT;
    if (dt > 0) { s.vx = (e.clientX - s.lastX) / dt; s.lastX = e.clientX; s.lastT = ts; }
    const stp = (d._fan && d._fan.step) || DV_PEEK;
    d.fanX = dvFanMod(s.startFanX - dx / stp, d.pool.length);   // 窗口在循环队列上平移
    dvFanSchedule();
  });
  const endDrag = e => {
    const s = dvFanDrag;
    if (!s || s.pointerId !== e.pointerId) return;
    dvFanDrag = null;
    try { if (s.wrap.hasPointerCapture(e.pointerId)) s.wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    if (s.moved < 8) {
      if (s.card) pickDivinePool(s.card);
      return;
    }
    // 刚松手且还有速度 → 保留惯性继续沿弧滑
    if (performance.now() - s.lastT < 120) dvFanGlideStart(s.vx);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
}
function renderDivineDrawStage() {
  const d = state._dvDraw; if (!d) return;
  const stage = $('divine-draw-stage'); if (!stage) return;
  bindDrawStage();
  const manual = state.divineMode === 'manual';
  // 目标牌位只渲染牌背；翻牌前不给任何牌名
  const skeleton = { dtype: d.type, spread: d.spread.name, cards: Array.from({ length: d.spread.n }, () => ({ name: '', upright: true })) };
  const board = divineResultHtml(skeleton, { interactive: false, drawing: true, bare: true });
  // 只渲染 21 个牌位；每位的牌号（data-pool=队列下标）由 dvFanPlace 按窗口位置动态写入，
  // 牌背全同，换位时不必重建 DOM
  const pool = manual
    ? `<div class="dv-fan-wrap" id="dv-fan-wrap"><div class="dv-fan-track" id="dv-fan-track">${Array.from({ length: DV_SLOTS }, () =>
        `<button class="dv-pool-card" type="button" data-pool="">${dvBackArt(d.type)}<span class="dv-pool-no"></span></button>`).join('')}</div></div>`
    : '';
  stage.innerHTML =
    `<div class="dv-draw-head"><span class="dv-draw-status" id="dv-draw-status">` +
      (manual ? `左右滑动下方牌扇，轻点依次选 ${d.spread.n} 张牌` : '正在自动抽牌…') + `</span>` +
      `<span class="dv-draw-count" id="dv-draw-count">` +
      (manual ? `已选 0 / ${d.spread.n}` : `已选 ${d.spread.n} / ${d.spread.n}`) + `</span></div>` +
    `<div class="dv-target">${board}</div>${pool}`;
  // 先定扇高（决定剩余高度），再按剩余高度缩放牌阵
  if (manual) dvFanLayout(stage);
  dvFitBoard(stage);
  const step = stage.closest('.divine-step');
  if (step) step.scrollTop = 0;
  if (manual) return;
  // 自动抽：按顺序落位，再统一翻牌
  d.picked = Array.from({ length: d.spread.n }, (_, i) => i);
  d.picked.forEach((pi, i) => dvLater(() => {
    const card = stage.querySelector(`.dv-board .dv-card[data-ci="${i}"]`);
    if (card) card.classList.add('is-placed');
  }, 70 * i));
  dvLater(finishDivineFlip, 70 * d.spread.n + 240);
}
function finishDivineShuffle() {
  const d = state._dvDraw;
  if (!d || d.phase !== 'shuffle') return;
  dvClearTimers();
  d.phase = 'pick';
  renderDivineDrawStage();
}
function pickDivinePool(el) {
  const d = state._dvDraw;
  if (!d || d.phase !== 'pick' || state.divineMode !== 'manual') return;
  if (d.picked.length >= d.spread.n) return;
  if (el.dataset.pool === '') return;                    // 槽位还没绑定牌（尚未布局）
  const pi = Number(el.dataset.pool);
  if (!Number.isInteger(pi) || pi < 0 || pi >= d.pool.length || d.picked.includes(pi)) return;
  d.picked.push(pi);
  el.classList.add('is-picked');
  const no = el.querySelector('.dv-pool-no');
  if (no) no.textContent = String(d.picked.length);
  const k = d.picked.length - 1;
  const stage = $('divine-draw-stage');
  const card = stage && stage.querySelector(`.dv-board .dv-card[data-ci="${k}"]`);
  if (card) card.classList.add('is-placed');
  const cnt = $('dv-draw-count');
  if (cnt) cnt.textContent = `已选 ${d.picked.length} / ${d.spread.n}`;
  if (d.picked.length >= d.spread.n) {
    d.phase = 'flip';
    const st = $('dv-draw-status'); if (st) st.textContent = '已选满，正在翻牌…';
    const sk = stage && stage.querySelector('.dv-skip-btn'); if (sk) sk.classList.add('hide');
    dvLater(finishDivineFlip, 220);
  }
}
// 统一翻牌：先起翻牌动画，中段换牌面，翻完才写牌名并进入结果页
function finishDivineFlip() {
  const d = state._dvDraw;
  if (!d || d.phase === 'done') return;
  const stage = $('divine-draw-stage'); if (!stage) return;
  const cards = d.picked.map((pi, i) => {
    const card = d.pool[pi];
    const upright = d.type === 'tarot' ? Math.random() < 0.5 : true;
    const out = { pos: d.spread.positions[i], name: card.name, upright, meaning: d.type === 'tarot' ? (upright ? card.up : card.rev) : card.meaning };
    if (d.type === 'tarot') { out.up = card.up; out.rev = card.rev; }
    return out;
  });
  const result = { id: uid(), ts: now(), dtype: d.type, spread: d.spread.name, question: state.divineQuestion || '', cards };
  const text = buildDivineText(result);
  state._lastDivine = { result, text };
  d.phase = 'done';
  d.flipT0 = performance.now();
  const els = Array.from(stage.querySelectorAll('.dv-board .dv-card'));
  const board = stage.querySelector('.dv-board');
  if (board) board.classList.remove('dv-drawing');
  els.forEach(el => el.classList.add('flipped'));
  const isTarot = d.type === 'tarot';
  const dir = isTarot ? 'tarot' : 'lenormand';
  // 翻牌动画开始即挂上牌面图：.dv-back 面被 backface-visibility 挡住，转到 90° 前不可见，
  // 因此既不会提前透出牌面，也不会在背面转正时出现空面或别的牌种牌背
  els.forEach((el, i) => {
    const c = cards[i]; if (!c) return;
    const img = el.querySelector('.dv-card-img');
    if (img) { img.src = `./assets/divine/${dir}/${c.name}.webp`; img.hidden = false; img.classList.toggle('is-rev', isTarot && !c.upright); }
  });
  dvLater(() => {
    els.forEach((el, i) => {
      const c = cards[i]; if (!c) return;
      const img = el.querySelector('.dv-card-img'); if (img) img.alt = c.name;
      const bn = el.querySelector('.dv-back-name'); if (bn) bn.textContent = c.name;
      const lab = stage.querySelector(`.dv-slot-label[data-ci="${i}"]`);
      if (lab) lab.innerHTML = `<span class="dv-slot-name">${escapeHtml(c.name)}</span>` +
        (isTarot ? `<span class="dv-slot-orient ${c.upright ? 'up' : 'rev'}">${c.upright ? '正位' : '逆位'}</span>` : '');
    });
    d.flipDoneAt = performance.now();
    state._dvRevealed = true;
    state.divineStep = 4;
    applyDivineStep();
    pushDivineHistory(result, text).catch(() => {});
    renderDivine();
  }, 540);
}
export async function startDivineDraw() {
  const q = $('divine-question');
  state.divineQuestion = q ? q.value.trim() : '';
  dvClearTimers();
  const type = state.divineType;
  const deck = type === 'tarot' ? TAROT_DECK : LENORMAND_DECK;
  const spread = DIVINE_SPREADS[type][state.divineSpreadIdx[type]];
  const shuffled = shuffleArr(deck);
  // 整副牌全部铺进底部牌扇：塔罗 78 张、雷诺曼 36 张；同副牌不重复
  const poolCount = deck.length;
  state._dvDraw = { type, spread, pool: shuffled.slice(0, poolCount), picked: [], phase: 'shuffle', fanX: null };
  state._dvRevealed = false;
  // 清掉上一局的结果 DOM，避免翻牌前旧牌名残留在隐藏节点里
  const oldResult = $('divine-result'); if (oldResult) oldResult.innerHTML = '';
  const block = $('divine-question-block'); if (block) block.classList.add('hide');
  const back = $('divine-back-3'); if (back) back.classList.add('hide');
  const stage = $('divine-draw-stage');
  if (stage) { stage.classList.remove('hide'); stage.innerHTML = shuffleMarkup(); bindDrawStage(); }
  applyDivineStep();   // 抽牌态：收起底部留白，让牌扇整张牌贴到页面底部
  dvLater(finishDivineShuffle, 1200);
}
// 重新抽牌：清空问题并回到第一步
export function divineRestart() {
  dvClearTimers();
  state._dvDraw = null;
  state._dvRevealed = false;
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
    const out = { pos: spread.positions[i], name: card.name, upright, meaning: type === 'tarot' ? (upright ? card.up : card.rev) : card.meaning };
    // 塔罗：正位/逆位两段释义都留下，供弹窗同时展示
    if (type === 'tarot') { out.up = card.up; out.rev = card.rev; }
    return out;
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
  return `${qLine}${title} · ${r.spread}\n${lines.join('\n')}`;
}

// ---- 结果渲染（牌面卡片 + 翻转牌义） ----
export function renderDivine() {
  const box = $('divine-result'); if (!box) return;
  const cur = state._lastDivine;
  if (!cur || cur.result.dtype !== state.divineType) {
    box.innerHTML = '<div class="insp-empty">静心默念所问之事，然后点击下方按钮抽牌</div>';
    return;
  }
  box.innerHTML = divineResultHtml(cur.result, { revealed: !!state._dvRevealed });
}
export function divineResultHtml(r, opts = {}) {
  const isTarot = r.dtype === 'tarot';
  const dir = isTarot ? 'tarot' : 'lenormand';
  const interactive = opts.interactive !== false;
  const revealed = !!opts.revealed;
  const drawing = !!opts.drawing;
  const backArt = dvBackArt(r.dtype);
  // 单张卡牌（牌背 + 牌面）：牌背按牌种取，翻牌前 DOM 中不出现牌名（文字、alt、src、class、data 一律不带牌名）
  const cardInner = (c, i, badge) => {
    const showName = revealed && c && c.name ? c.name : '';
    const up = isTarot ? !!(c && c.upright) : true;
    const frontInner = backArt + (badge ? `<span class="dv-front-pos">${escapeHtml(badge)}</span>` : '');
    const inner = `<div class="dv-face dv-front">${frontInner}</div>` +
      `<div class="dv-face dv-back"><span class="dv-back-name">${showName ? escapeHtml(showName) : ''}</span>` +
      `<img class="dv-card-img${showName && isTarot && !up ? ' is-rev' : ''}"` +
      (showName
        ? ` src="./assets/divine/${dir}/${showName}.webp" alt="${escapeHtml(showName)}"`
        : ' hidden') +
      ` onerror="dvImgError(this)"></div>`;
    const cls = `dv-card${showName ? ' flipped' : ''}`;
    return interactive
      ? `<button class="${cls}" data-ci="${i}" onclick="flipDivineCard(this)"><div class="dv-card-inner">${inner}</div></button>`
      : `<div class="${cls}" data-ci="${i}"><div class="dv-card-inner">${inner}</div></div>`;
  };
  // 塔罗 / 雷诺曼：共用同一套几何牌阵渲染（不同牌阵位置关系不同）
  const spreads = isTarot ? TAROT_SPREADS : LENORMAND_SPREADS;
  const sp = spreads.find(s => s.name === r.spread) || spreads[0];
  const L = sp.layout;
  const cw = 100 / L.cols;
  const hint = isTarot
    ? `<div class="dv-hint">点击牌面翻转；翻牌后点击下方牌名查看正位 / 逆位释义</div>`
    : `<div class="dv-hint">点击牌面翻转；翻牌后点击下方牌名查看牌义</div>`;
  const actions = `<div class="dv-actions">` +
    `<button class="btn btn-outline" onclick="copyDivineResult()">复制结果</button>` +
    `<button class="btn btn-outline" onclick="sendDivineToChat()">发送到聊天</button>` +
    `<button class="btn" onclick="divineToInspiration()">存入灵感随记</button></div>`;
  // 稀疏 / 密集统一：牌名直接显示在每张牌正下方，牌阵下方不再有清单
  // 密集（7 张及以上）用缩小牌 + 10px 小字（塔罗牌名+正逆位两行）；稀疏地方大，字号 12px、牌不缩小
  const dense = r.cards.length >= 7;
  const CARD_SCALE = dense ? 0.8 : 1;
  const FONT_PX = dense ? 10 : 12;
  const LABEL_PX = dense ? (isTarot ? 27 : 15) : 32;
  const groups = [];
  const gmap = new Map();
  L.slots.forEach((s, i) => {
    const key = `${s[0]}|${s[1]}`;
    if (!gmap.has(key)) { const g = { x: s[0], y: s[1], items: [] }; gmap.set(key, g); groups.push(g); }
    gmap.get(key).items.push({ i, rot: +(s[2] || 0) });
  });
  // 同一行（含相近高度的错位牌）的文字宽度与左偏移：与相邻文字块留空隙、且不越出牌阵左右边界
  // 错位牌（如全能无牌阵中间牌只低 0.3 单位）若只比较同 y 的牌，文字会横向压到相邻牌上
  groups.forEach(g => {
    const center = g.x + 0.5;
    let nearest = Infinity;
    groups.forEach(o => {
      if (o === g || Math.abs(o.y - g.y) > 0.65) return;
      nearest = Math.min(nearest, Math.abs(o.x + 0.5 - center));
    });
    const w = Math.max(0.6, Math.min(1.8, nearest === Infinity ? 1.8 : nearest - 0.1));
    const left = Math.min(Math.max(center - w / 2, 0.05), L.cols - w - 0.05);
    g.label = { w, left };
  });
  // 纵向留白：牌面缩小后，为下方文字撑出空间；同一位置叠两张牌时文字更多
  // 桌面端牌阵高度受 72vh 限制，牌阵越窄文字占比越大，故按实际可用宽度迭代收敛纵向量
  const resEl = document.getElementById('divine-result');
  let availW = Math.min(600, (resEl && resEl.clientWidth) || Math.max(0, window.innerWidth - 32));
  let ky = 1;
  for (let pass = 0; pass < 4; pass++) {
    let boardW = availW;
    if (window.innerWidth >= 900) boardW = Math.min(boardW, 0.72 * window.innerHeight * (L.cols / (L.rows * ky)));
    const unitPx = Math.max(20, boardW / L.cols);
    const labelUnits = Math.max(0.3, LABEL_PX / unitPx);
    let next = 1;
    groups.forEach(a => {
      groups.forEach(b => {
        if (b.y <= a.y) return;
        const lb = a.label.left, rb = a.label.left + a.label.w;
        const cb = b.x + (1 - CARD_SCALE) / 2, ce = cb + CARD_SCALE;
        if (rb <= cb + 0.02 || lb >= ce - 0.02) return;
        const need = 1.6 * CARD_SCALE + labelUnits * a.items.length + 0.04;
        next = Math.max(next, need / (b.y - a.y));
      });
    });
    // 最低一排牌下方的文字也要落在牌阵内，避免压到下方的提示/按钮
    groups.forEach(g => {
      const bottomNeed = g.y + 1.6 * CARD_SCALE + labelUnits * g.items.length + 0.04;
      next = Math.max(next, bottomNeed / L.rows);
    });
    ky = next;
  }
  const slotHtml = groups.map(g => {
    const cards = g.items.map(it =>
      `<div class="dv-card-hold${it.rot ? ' rot' : ''}">${cardInner(r.cards[it.i], it.i, '')}</div>`).join('');
    const labels = g.items.map(it => {
      // 翻牌前为空：牌名与正逆位只在翻牌后写入，避免提前暴露
      const c = r.cards[it.i];
      const inner = (revealed && c && c.name)
        ? `<span class="dv-slot-name">${escapeHtml(c.name)}</span>` +
          (isTarot ? `<span class="dv-slot-orient ${c.upright ? 'up' : 'rev'}">${c.upright ? '正位' : '逆位'}</span>` : '')
        : '';
      const style = `font-size:${FONT_PX}px;width:${(g.label.w * 100).toFixed(2)}%;margin-left:${((g.label.left - g.x) * 100).toFixed(2)}%;`;
      return interactive
        ? `<button class="dv-slot-label" data-ci="${it.i}" style="${style}" onclick="openDivineCardMeaning(${it.i})">${inner}</button>`
        : `<span class="dv-slot-label" data-ci="${it.i}" style="${style}">${inner}</span>`;
    }).join('');
    return `<div class="dv-slot" data-index="${g.items[0].i}"` +
      ` style="left:${(g.x / L.cols * 100).toFixed(3)}%;top:${(g.y / L.rows * 100).toFixed(3)}%;width:${cw.toFixed(3)}%">` +
      `<div class="dv-slot-cards">${cards}</div>${labels}</div>`;
  }).join('');
  const rowsTotal = L.rows * ky;
  const board = `<div class="dv-board${dense ? ' dv-board-dense' : ''}${drawing ? ' dv-drawing' : ''}"` +
    ` style="--dv-scale:${CARD_SCALE};--dv-ratio:${(L.cols / rowsTotal).toFixed(4)};aspect-ratio:${L.cols}/${rowsTotal.toFixed(3)}">` +
    `${slotHtml}</div>`;
  if (opts.bare) return board;
  return board + hint + actions;
}
export function flipDivineCard(el) {
  const flipped = !el.classList.contains('flipped');
  el.classList.toggle('flipped', flipped);
  const result = el.closest('#divine-result');
  const cur = state._lastDivine;
  if (!result || !cur) return;
  const ci = Number(el.dataset.ci);
  const c = cur.result.cards[ci];
  if (!c) return;
  const isTarot = cur.result.dtype === 'tarot';
  const dir = isTarot ? 'tarot' : 'lenormand';
  const img = el.querySelector('.dv-card-img');
  const backName = el.querySelector('.dv-back-name');
  const lab = result.querySelector(`.dv-slot-label[data-ci="${ci}"]`);
  const up = isTarot ? !!c.upright : true;
  if (flipped) {
    // 翻牌后才写入牌面图片与牌名，翻牌前这些信息不在 DOM 中
    img.hidden = false;
    img.src = `./assets/divine/${dir}/${c.name}.webp`;
    img.alt = c.name;
    img.classList.toggle('is-rev', isTarot && !up);
    if (backName) backName.textContent = c.name;
    if (lab) {
      lab.innerHTML = `<span class="dv-slot-name">${escapeHtml(c.name)}</span>` +
        (isTarot ? `<span class="dv-slot-orient ${up ? 'up' : 'rev'}">${up ? '正位' : '逆位'}</span>` : '');
    }
  } else {
    // 盖回牌背：隐藏牌面图，露出本牌种牌背
    img.hidden = true;
    img.removeAttribute('src');
    img.alt = '';
    img.classList.remove('is-rev');
    if (backName) backName.textContent = '';
    if (lab) lab.innerHTML = '';
  }
}
// 点击牌名标题：展开 / 收起详细释义（箭头 ↓↑ 随动；仅雷诺曼使用）
export function toggleDivineMeaning(el) {
  const item = el.closest('.dv-mean-item');
  if (!item) return;
  const box = item.querySelector('.dv-card-mean-box');
  if (!box) return;
  box.classList.toggle('open');
  el.classList.toggle('open', box.classList.contains('open'));
}
// 点击牌名打开弹窗：塔罗给出正位 / 逆位两段释义并标出当前；雷诺曼没有正逆位，只显示一段牌义
export function openDivineCardMeaning(i) {
  const cur = state._lastDivine;
  if (!cur) return;
  const c = cur.result.cards[i];
  if (!c) return;
  const isTarot = cur.result.dtype === 'tarot';
  if (!isTarot) {
    const body = `<div class="dv-mean-modal">` +
      `<div class="dv-mean-base">【${escapeHtml(c.pos)}】${escapeHtml(c.name)}</div>` +
      `<div class="dv-mean-block"><div class="dv-mean-head">牌义</div>` +
      `<div class="dv-mean-body-text">${escapeHtml(c.meaning || c.up || '')}</div></div></div>`;
    showModal(c.name, body, [{ label: '关闭', cls: 'btn-outline', onClick: closeModal }]);
    return;
  }
  const up = c.up || c.meaning || '';
  const rev = c.rev || c.meaning;
  const orient = c.upright ? '正位' : '逆位';
  const section = (label, text, isCurrent) =>
    `<div class="dv-mean-block${isCurrent ? ' is-current' : ''}">` +
    `<div class="dv-mean-head">${label}${isCurrent ? '<span class="dv-mean-now">当前</span>' : ''}</div>` +
    `<div class="dv-mean-body-text">${escapeHtml(text)}</div></div>`;
  const body = `<div class="dv-mean-modal">` +
    `<div class="dv-mean-base">【${escapeHtml(c.pos)}】${escapeHtml(c.name)} · 本次抽到 ` +
    `<span class="dv-orient ${c.upright ? 'up' : 'rev'}">${orient}</span></div>` +
    section('正位释义', up, !!c.upright) +
    section('逆位释义', rev, !c.upright) +
    `</div>`;
  showModal(`${c.name} · ${orient}`, body, [{ label: '关闭', cls: 'btn-outline', onClick: closeModal }]);
}
// 卡牌图片加载容错：.webp 失败 → .jpg → .png → 隐藏（露出文字牌义 / 星光牌背）
export function dvImgError(img) {
  const src = img.currentSrc || img.src;
  if (/\.webp$/i.test(src)) { img.src = src.replace(/\.webp$/i, '.jpg'); return; }
  if (/\.jpe?g$/i.test(src)) { img.src = src.replace(/\.jpe?g$/i, '.png'); return; }
  img.onerror = null;
  img.style.display = 'none';
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
    `<div class="dv-hist-row">` +
    `<div class="insp-item" onclick="viewDivineHistory(${i})">` +
    `<div class="it-text">${h.dtype === 'tarot' ? '塔罗牌' : '雷诺曼'} · ${escapeHtml(h.spread)}</div>` +
    `<div class="it-time">${formatTime(h.ts)}</div></div>` +
    `<button class="dv-hist-del" onclick="deleteDivineHistory(${i})" title="删除这条记录">` +
    `<svg class="i i-sm"><use href="#icon-trash"/></svg></button>` +
    `</div>`
  ).join('');
  showModal('占卜历史', `<div class="dv-hist-list">${body}</div>`, [
    { label: '清除历史', cls: 'btn-danger', onClick: clearDivineHistory },
    { label: '关闭', cls: 'btn-outline', onClick: closeModal }
  ]);
}
// 删除单条占卜历史（沿用统一确认弹窗；只动 divine_history 这一个 meta 键）
export async function deleteDivineHistory(i) {
  const h = (window._divineHist || [])[i]; if (!h) return;
  const ok = await confirmDialog(`确定删除「${h.dtype === 'tarot' ? '塔罗牌' : '雷诺曼'} · ${h.spread}」这条记录？删除后不可恢复。`);
  if (!ok) { openDivineHistory(); return; }
  const r = await dbGet('meta', 'divine_history');
  const list = ((r && r.list) || []).filter(x => x.id !== h.id);
  await dbPut('meta', { k: 'divine_history', list });
  toast('已删除这条占卜记录');
  openDivineHistory();
}
// 清除全部占卜历史（二次确认；只动 divine_history 这一个 meta 键）
export async function clearDivineHistory() {
  if (!await confirmDialog('确定清除全部占卜历史？清除后不可恢复。')) return;
  await dbPut('meta', { k: 'divine_history', list: [] });
  window._divineHist = [];
  toast('占卜历史已清除');
  openDivineHistory();
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
