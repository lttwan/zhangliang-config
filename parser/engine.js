/**
 * 账单识别规则
 * ============================================================
 * 由本地识别服务通过 QuickJS 执行，把 OCR 结果转成账单结构化数据。
 *
 * 输入 input = { text, lines, imageWidth, imageHeight }
 *   text        : OCR 文本（每行一条，已按阅读顺序排序）
 *   lines       : 带坐标的文本行，字段 t/l/tp/r/b（坐标已归一化到 0~1）
 *                 t=文本 l=左 tp=上 r=右 b=下
 *   imageWidth  : 原图宽（px，仅调试用）
 *   imageHeight : 原图高（px，仅调试用）
 *
 * 输出 { type, amount, dateStr, accountName, categoryName, merchant, note }
 *   type         : 0=支出 1=收入
 *   amount       : 金额字符串，如 "15.76"
 *   dateStr      : 交易时间，如 "2026-09-16 12:29:39"
 *   accountName  : 支付方式，如 "分付"
 *   categoryName : 分类名，如 "打车"（由调用方在用户分类库中对齐）
 *   merchant     : 商户名
 *   note         : 备注（取商品，无商品时取商户名）
 *
 * 坐标规律来自实测的微信支付账单详情页（青岛工学院 / 美团 / 高德打车）：
 *   表格左列（标签）  l ≈ 0.04~0.08
 *   表格右列（值）    l ≈ 0.26~0.31
 *   金额行            居中（l ≈ 0.34~0.36）+ 带符号 + 大字号（行高 > 0.03）
 *   商户名            紧邻金额行的上/下一行，居中
 *   底部无关区        tp 之后是商户小程序、账单服务、菜单等
 */

// ============================================================
// 可调参数（改这里即可适配新版式，无需改动逻辑）
// ============================================================

/** 金额行的左边界范围（居中显示） */
var AMOUNT_LEFT_MIN = 0.15;
var AMOUNT_LEFT_MAX = 0.60;

/** 金额行的最小行高：金额字号明显大于正文，实测约 0.037~0.039 */
var AMOUNT_MIN_HEIGHT = 0.030;

/** 「值」列的左边界下限：表格右侧的值都从这里开始 */
var VALUE_COLUMN_LEFT_MIN = 0.22;

/** 同一行的判定容差（按行高的比例） */
var SAME_ROW_TOLERANCE_RATIO = 0.6;

/** 表格各行之间的最大纵向间距（用于判断「紧邻下一行」） */
var ROW_GAP_MAX = 0.05;

/** 商户名最大长度 */
var MERCHANT_MAX_LEN = 24;

// ============================================================
// 词表
// ============================================================

/**
 * 版式规则注册表。
 * ============================================================
 * 由各平台规则文件（platforms/*.js）在加载时注册，引擎本身不内置任何版式。
 *
 * 每个规则需包含：
 *   id            —— 版式标识
 *   name          —— 展示名
 *   identify      —— 特征词，命中 2 个即认定该版式
 *   labels        —— 各字段的标签文本，引擎取该标签同一行右侧的值
 *   uiNoise       —— 该版式的界面固定文案
 *   cutoffMarkers —— 表格下方无关区域的特征，命中后截断
 */
var PLATFORM_RULES = [];

/**
 * 注册版式规则。
 *
 * 各平台规则文件在末尾调用本函数；重复注册同一 id 时以后者为准，
 * 便于远端规则覆盖内置版本。
 */
function registerPlatform(rule) {
  for (var i = 0; i < PLATFORM_RULES.length; i++) {
    if (PLATFORM_RULES[i].id === rule.id) {
      PLATFORM_RULES[i] = rule;
      return;
    }
  }
  PLATFORM_RULES.push(rule);
}

/**
 * 组装备注。
 *
 * 版式声明 autoNote:false 时返回空串，由用户自行填写。
 *
 * @param goods 商品名
 * @param merchant 商户名
 */
function noteOf(goods, merchant) {
  if (activeRule !== null && activeRule.autoNote === false) {
    return '';
  }
  return goods.length > 0 ? goods : merchant;
}

/** 表格标签的通用集合：两列版式中左列是标签，其右侧为值 */
var TABLE_LABEL_TEXT = ['当前状态', '支付状态', '支付时间', '商品', '商户全称',
  '商户名称', '收单机构', '支付方式', '付款方式', '交易单号', '商户单号', '订单编号'];

/**
 * 「标签:值」内联版式中使用的分隔符。
 *
 * 中英文冒号都要支持——OCR 对手写体与印刷体的识别结果不稳定，
 * 同一页面可能出现「支付方式:微信支付」与「支付方式：微信支付」两种。
 */
var INLINE_SEPARATORS = [':', '：'];

/**
 * 从一行文本中按内联标签取值。
 *
 * 适用于「支付方式:微信支付」「下单时间:2026-09-10 14:53:07」这类版式：
 * 标签与值在同一行内，靠分隔符区分，而非左右两列。
 *
 * @param text 行文本
 * @param label 标签名
 * @returns 标签后的值；该行不含此标签时返回空串
 */
function inlineValueOf(text, label) {
  if (label.length === 0) {
    return '';
  }
  // 标签须在行首：避免「商品快照:发生交易争议」里的「商品」被误当标签
  if (text.indexOf(label) !== 0) {
    return '';
  }
  var rest = text.substring(label.length);
  for (var i = 0; i < INLINE_SEPARATORS.length; i++) {
    if (rest.indexOf(INLINE_SEPARATORS[i]) === 0) {
      return rest.substring(INLINE_SEPARATORS[i].length).trim();
    }
  }
  return '';
}

/**
 * 在全部行中查找内联标签并取值。
 *
 * @returns 首个命中行的值；无则返回空串
 */
function findInlineValue(lines, label) {
  if (label.length === 0) {
    return '';
  }
  for (var i = 0; i < lines.length; i++) {
    var v = inlineValueOf(lines[i].t, label);
    if (v.length > 0) {
      return v;
    }
  }
  return '';
}

/** 取当前版式下某字段的内联标签名 */
function inlineLabelOf(field, fallbacks) {
  if (activeRule !== null && activeRule.inlineLabels !== undefined) {
    var name = activeRule.inlineLabels[field];
    if (name !== undefined && name.length > 0) {
      return name;
    }
  }
  return fallbacks.length > 0 ? fallbacks[0] : '';
}

/** 命中版式后置为对应规则，供各提取函数读取标签名 */
var activeRule = null;

/** 支付方式关键词：命中后取该名称作为账户 */
/**
 * 支付方式关键词。
 *
 * 顺序即优先级：「微信支付」须排在「微信」之前，否则会被更短的词截断；
 * 同理「支付宝」排在「余额宝」之前。匹配时取首个命中项。
 */
var PAY_METHODS = ['微信支付', '零钱', '分付', '支付宝', '余额宝', '花呗', '借呗',
  '银行卡', '信用卡', '云闪付', '现金'];

/**
 * 分类关键词表（对应应用内置分类）。
 *
 * 键为应用中的二级分类名，值为该分类的特征词。匹配时按关键词长度降序，
 * 长者优先——「共享单车」应胜过「单车」，「打车」应胜过「车」。
 *
 * 脚本在沙箱内拿不到用户的分类库，故这里只负责得出「分类名」，
 * 由调用方在分类库中对齐；库中没有同名分类时该项留空。
 */
var CATEGORY_KEYWORDS = [
  // 餐饮
  { name: '早餐', words: ['早餐', '早点', '包子', '油条', '豆浆', '煎饼'] },
  { name: '午餐', words: ['午餐', '午饭', '中饭'] },
  { name: '晚餐', words: ['晚餐', '晚饭'] },
  { name: '外卖', words: ['外卖', '美团外卖', '饿了么', '美团', '送餐'] },
  { name: '奶茶', words: ['奶茶', '喜茶', '奈雪', '蜜雪', '茶百道', '古茗'] },
  { name: '咖啡', words: ['咖啡', '星巴克', '瑞幸', '库迪', 'manner'] },
  { name: '零食', words: ['零食', '小吃', '烧烤', '火锅', '串串', '蛋糕', '面包', '甜品'] },
  { name: '餐饮', words: ['餐饮', '饭店', '餐厅', '饭馆', '食堂', '快餐', '汉堡', '肯德基', '麦当劳', '餐饮消费'] },
  // 交通
  { name: '打车', words: ['打车', '滴滴', '出租车', '网约车', '高德打车', '曹操出行', 'T3出行'] },
  { name: '地铁', words: ['地铁', '轨道交通'] },
  { name: '公交', words: ['公交', '公共汽车'] },
  { name: '加油', words: ['加油', '中石化', '中石油', '壳牌'] },
  { name: '高铁', words: ['高铁', '火车', '动车', '12306'] },
  { name: '机票', words: ['机票', '航班', '航空'] },
  { name: '共享单车', words: ['共享单车', '哈啰', '青桔', '美团单车', '摩拜'] },
  // 购物
  { name: '数码', words: ['数码', '手机', '电脑', '耳机', '京东', '小米', '苹果'] },
  { name: '衣服', words: ['衣服', '服饰', '服装', '优衣库', '淘宝', '天猫'] },
  { name: '鞋子', words: ['鞋子', '运动鞋', '球鞋'] },
  { name: '护肤', words: ['护肤', '化妆品', '面膜', '口红'] },
  { name: '日用', words: ['日用', '日用品', '超市', '沃尔玛', '永辉', '拼多多'] },
  { name: '水果', words: ['水果', '果园', '生鲜'] },
  { name: '购物', words: ['购物', '商城', '商场', '网购'] },
  // 娱乐
  { name: '电影', words: ['电影', '影院', '万达影城', 'CGV'] },
  { name: '游戏', words: ['游戏', 'Steam', '腾讯游戏', '网易游戏'] },
  { name: '旅行', words: ['旅行', '旅游', '酒店', '民宿', '携程', '去哪儿'] },
  { name: 'KTV', words: ['KTV', 'ktv', '唱歌'] },
  { name: '健身', words: ['健身', '健身房', '游泳'] },
  { name: '娱乐', words: ['娱乐', '演出', '门票', '剧院'] },
  // 居住
  { name: '房租', words: ['房租', '租金', '租房'] },
  { name: '水电', words: ['水费', '电费', '水电', '燃气费'] },
  { name: '物业', words: ['物业', '物业管理'] },
  { name: '房贷', words: ['房贷'] },
  { name: '维修', words: ['维修', '修理'] },
  { name: '居住', words: ['居住', '住房'] },
  // 生活
  { name: '话费', words: ['话费', '话费充值', '中国移动', '中国联通', '中国电信'] },
  { name: '宽带', words: ['宽带', '光纤'] },
  { name: '理发', words: ['理发', '美发', '剪发'] },
  { name: '医药', words: ['医药', '药店', '医院', '诊所', '药房'] },
  { name: '书籍', words: ['书籍', '书店', '当当', '图书'] },
  { name: '生活', words: ['生活服务', '快递', '美团优选'] },
  // 收入类
  { name: '工资', words: ['工资', '月薪', '薪资', '发工资'] },
  { name: '奖金', words: ['奖金', '年终奖', '绩效', '提成'] },
  { name: '报销', words: ['报销', '报销入账'] },
  { name: '退款', words: ['退款', '退货'] },
  { name: '红包', words: ['红包', '微信红包'] },
  { name: '转账', words: ['转账', '收款'] },
  { name: '理财', words: ['利息', '收益', '基金', '分红', '余额宝收益'] }
];

/**
 * 日期正则。
 * 支持「2026年9月16日18:16:58」「2026-09-16 18:16:58」「2026/09/16 18:16」等，
 * 秒可省略。
 */
var DATE_PATTERNS = [
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/
];

// ============================================================
// 工具
// ============================================================

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 行高（归一化） */
function lineHeight(line) {
  return line.b - line.tp;
}

/** 垂直中心 */
function centerY(line) {
  return (line.tp + line.b) / 2;
}

/** 两行是否属于同一视觉行 */
function isSameRow(a, b) {
  var tol = Math.max(lineHeight(a), lineHeight(b)) * SAME_ROW_TOLERANCE_RATIO;
  return Math.abs(centerY(a) - centerY(b)) <= tol;
}

/** 文本是否命中任一关键词 */
function containsAny(text, words) {
  for (var i = 0; i < words.length; i++) {
    if (text.indexOf(words[i]) >= 0) {
      return true;
    }
  }
  return false;
}

/** 该行是否为界面固定文案（不含交易信息） */
/**
 * 该文本是否为本版式的界面固定文案。
 *
 * 未识别出具体版式时按「所有版式的噪声词并集」判断更安全——
 * 宁可误排一个商户候选，也不要把「账单服务」当成店名。
 */
function isUiNoise(text) {
  if (activeRule !== null && activeRule.uiNoise !== undefined) {
    for (var i = 0; i < activeRule.uiNoise.length; i++) {
      if (text === activeRule.uiNoise[i]) {
        return true;
      }
    }
    return false;
  }
  for (var r = 0; r < PLATFORM_RULES.length; r++) {
    var words = PLATFORM_RULES[r].uiNoise;
    if (words === undefined) {
      continue;
    }
    for (var j = 0; j < words.length; j++) {
      if (text === words[j]) {
        return true;
      }
    }
  }
  return false;
}

/** 该文本是否为表格标签 */
function isTableLabel(text) {
  for (var i = 0; i < TABLE_LABEL_TEXT.length; i++) {
    if (text === TABLE_LABEL_TEXT[i]) {
      return true;
    }
  }
  return false;
}

/**
 * 取当前版式下某字段的标签文本。
 *
 * 优先用命中版式声明的名称；未识别出版式时返回首个备选名，
 * 由调用方的 findLine 在文本中实际查找，找不到自然退到下一策略。
 *
 * @param field 字段名，如 'time' / 'goods' / 'merchant' / 'payMethod'
 * @param fallbacks 该字段的备选标签（不同平台叫法不同）
 */
function labelOf(field, fallbacks) {
  if (activeRule !== null && activeRule.labels !== undefined) {
    var name = activeRule.labels[field];
    if (name !== undefined && name.length > 0) {
      return name;
    }
  }
  return fallbacks.length > 0 ? fallbacks[0] : '';
}

/** 查找包含指定片段的第一行 */
function findLine(lines, fragment) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].t.indexOf(fragment) >= 0) {
      return lines[i];
    }
  }
  return null;
}

// ============================================================
// 各字段提取
// ============================================================

/**
 * 提取金额。
 *
 * 判据（三条同时满足，缺一不可）：
 *  1) 文本以 +/- 开头（微信账单的金额恒带符号）
 *  2) 左边界居中（0.15~0.60），排除表格右侧的长数字
 *  3) 行高明显大于正文（金额字号更大）
 *
 * 仅靠正则会让「-15.76」在交易单号、商户单号等长数字中被误取，
 * 坐标能有效排除它们。
 */
function extractAmount(lines) {
  // ① 内联锚点：如拼多多的「实付:26.8(免运费)」。
  // 这类页面金额不带符号，且与标签同处一行，靠锚点词定位。
  var anchorHit = extractInlineAmount(lines);
  if (anchorHit.value.length > 0) {
    return anchorHit;
  }

  // ② 带符号且居中、字号较大的独立金额行（微信支付详情页属此类）
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!/^[+-]\s*\d+(\.\d{1,2})?$/.test(line.t)) {
      continue;
    }
    if (line.l < AMOUNT_LEFT_MIN || line.l > AMOUNT_LEFT_MAX) {
      continue;
    }
    if (lineHeight(line) < AMOUNT_MIN_HEIGHT) {
      continue;
    }
    // 取行高最大的（金额通常为页面最大字号）
    if (best === null || lineHeight(line) > lineHeight(best)) {
      best = line;
    }
  }
  if (best === null) {
    return { value: '', negative: false, line: null };
  }
  return {
    value: best.t.replace(/^[+-]\s*/, ''),
    negative: best.t.charAt(0) === '-',
    line: best
  };
}

/**
 * 按「实付 / 实付款 / 应付 / 合计」等内联锚点取金额。
 *
 * 拼多多等订单页的版式是「实付:26.8(免运费)」——金额与锚点同行、
 * 不带符号、后面还可能跟括号说明。取锚点后的第一个金额数字即可，
 * 括号内的说明（如「(免运费)」）不含金额，不会干扰。
 *
 * 「已优惠 / 共优惠 / 店铺优惠」这类是减免项，不是实付金额，需排除。
 *
 * @returns { value, negative, line }；未命中时 value 为空串
 */
function extractInlineAmount(lines) {
  var none = { value: '', negative: false, line: null };
  var anchors = ['实付款', '实付', '应付金额', '应付', '支付金额', '订单金额', '合计'];
  var excludes = ['优惠', '已减', '共减', '立减', '折扣', '抵扣'];

  for (var a = 0; a < anchors.length; a++) {
    for (var i = 0; i < lines.length; i++) {
      var text = lines[i].t;
      if (text.indexOf(anchors[a]) !== 0) {
        continue;
      }
      // 排除减免项：「秒杀后共优惠¥10」不该被当成实付
      var excluded = false;
      for (var e = 0; e < excludes.length; e++) {
        if (text.indexOf(excludes[e]) >= 0) {
          excluded = true;
          break;
        }
      }
      if (excluded) {
        continue;
      }
      var m = text.match(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
      if (m === null || m[1].length === 0) {
        continue;
      }
      // 带负号（如「-¥10」）是减免，不是实付
      var signIdx = text.indexOf('-');
      var isNegative = signIdx >= 0 && signIdx < m.index;
      return { value: m[1], negative: isNegative, line: lines[i] };
    }
  }
  return none;
}

/**
 * 提取商品。
 *
 * 取「商品」行同一行右侧的值。该值在不同商户下有不同形态，需清洗：
 *  - 微信自有分类前缀：「408_餐饮消费」→「餐饮消费」
 *  - 渠道后缀：「二两包子铺(南湖店)-美团App-」→「二两包子铺(南湖店)」
 *  - 尾部残留的连接符与空白
 */
function extractGoods(lines) {
  // ① 两列版式：取「商品」标签行右侧的值
  var label = findLine(lines, labelOf('goods', ['商品', '交易内容']));
  if (label !== null) {
    var value = findValueOfRow(lines, label);
    if (value !== null) {
      var cleaned = cleanGoods(value.t);
      if (cleaned.length > 0) {
        return cleaned;
      }
    }
  }
  // ② 无标签版式（拼多多等）：店铺行下方的商品名
  return extractGoodsNearShop(lines);
}

/**
 * 从「店铺行下方的第一行」取商品名。
 *
 * 拼多多订单页无「商品」标签，商品名紧跟在店铺名下方：
 *   沃之沃厨房用品旗舰店 旗舰店     ← 店铺行（含旗舰店等后缀）
 *   沃之沃粘毛器滚筒斜撕式衣服床单   ← 商品名
 *   卷纸滚刷头发神器黏毛清理多功能
 *
 * 商品名常跨多行，取第一行即可（第二行起是规格、赠品等细节）。
 */
function extractGoodsNearShop(lines) {
  var markers = [];
  if (activeRule !== null && activeRule.goodsMarkers !== undefined) {
    markers = activeRule.goodsMarkers;
  }
  if (markers.length === 0) {
    return '';
  }
  for (var i = 0; i < lines.length; i++) {
    var text = lines[i].t;
    var isShop = false;
    for (var m = 0; m < markers.length; m++) {
      if (text.indexOf(markers[m]) >= 0) {
        isShop = true;
        break;
      }
    }
    if (!isShop) {
      continue;
    }
    // 取该行下方首个可用作商品名的行
    for (var k = i + 1; k < lines.length && k <= i + 2; k++) {
      var cand = lines[k].t;
      if (cand.length < 4 || isUiNoise(cand)) {
        continue;
      }
      // 价格行、规格行、退换货说明不是商品名
      if (/^[¥￥]/.test(cand) || /^x\d+$/i.test(cand)) {
        continue;
      }
      if (cand.indexOf('退货') >= 0 || cand.indexOf('包运费') >= 0) {
        continue;
      }
      return cand.substring(0, 30);
    }
    break;
  }
  return '';
}

/** 清洗商品名 */
function cleanGoods(raw) {
  var t = raw;

  // 去掉微信自有分类的数字前缀：「408_餐饮消费」→「餐饮消费」
  t = t.replace(/^\d{1,4}[_\-]\s*/, '');

  // 去掉订单编号一类信息：「京东-订单编号3619281016946184」→「京东」
  // 这类值不是商品，而是账单单号；连接符前若是商户名则保留，否则整段丢弃
  var orderMarks = ['订单编号', '订单号', '交易单号', '商户单号', '流水号'];
  for (var k = 0; k < orderMarks.length; k++) {
    var markIdx = t.indexOf(orderMarks[k]);
    if (markIdx < 0) {
      continue;
    }
    var head = t.substring(0, markIdx);
    // 去掉连接符后若还有内容，视为商户名保留；否则整段丢弃
    head = head.replace(/[\s\-_]+$/, '');
    t = /^[\s\-_]*$/.test(head) ? '' : head;
    break;
  }

  // 去掉渠道后缀：「-美团App-」「-微信支付」「-App」等
  // 仅当连接符后才出现渠道名时截断，避免误伤正常店名中的短横线
  var channelSuffix = ['-美团App-', '-美团App', '-美团外卖', '-微信支付',
    '-支付宝', '-App-', '-App', '-小程序'];
  for (var i = 0; i < channelSuffix.length; i++) {
    var idx = t.indexOf(channelSuffix[i]);
    if (idx > 0) {
      t = t.substring(0, idx);
    }
  }

  // 去掉首尾空白与残留连接符
  t = t.replace(/^[\s\-_]+/, '').replace(/[\s\-_]+$/, '');

  // 纯数字或纯单号特征的内容不是商品
  if (/^\d+$/.test(t) || /\d{10,}/.test(t)) {
    return '';
  }
  return t;
}

/**
 * 提取商户名。
 *
 * 商户名在版式中紧邻金额行（美团、高德打车、青岛工学院三例均如此），
 * 且居中显示。优先取金额行上方，其次下方——金额上方通常是店名，
 * 下方通常是品牌名。
 */
function extractMerchant(lines, amountLine) {
  // ① 店铺行优先：含「旗舰店 / 专营店」等后缀的行是最可靠的商户标识。
  // 拼多多等订单页的金额行上方是收货信息，靠「金额行紧邻行」取不到店铺。
  var shop = extractShopLine(lines);
  if (shop.length > 0) {
    return shop;
  }
  if (amountLine === null) {
    return extractMerchantByFallback(lines);
  }
  // 按**坐标**取上下相邻行，而非数组下标。
  // lines 按阅读顺序排列，同一视觉行的左右两块会占两个下标：
  //   共优惠¥1        (l=0.021, tp=0.408)   ← 与下一项同一行，但在左侧
  //   实付:¥29.57     (l=0.604, tp=0.406)   ← 金额行
  // 若按下标取「上一行」会拿到同一行的左侧块，把优惠文案当成商户名。
  var candidates = [];
  var above = nearestAbove(lines, amountLine);
  if (above !== null) {
    candidates.push(above);
  }
  var below = nearestBelow(lines, amountLine);
  if (below !== null) {
    candidates.push(below);
  }
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    if (isUsableMerchant(cand)) {
      return cand.t;
    }
  }
  return '';
}

/**
 * 取含店铺后缀的行作为商户名。
 *
 * 「沃之沃厨房用品旗舰店 旗舰店」这类行是订单页中最明确的商户标识，
 * 比「金额行紧邻行」可靠——后者在订单页会取到收件人或地址。
 *
 * 同一行可能重复出现后缀（如「XX旗舰店 旗舰店」），需截断到首个完整店名。
 */
function extractShopLine(lines) {
  var suffixes = ['旗舰店', '专营店', '专卖店', '官方店', '自营店', '官方旗舰店'];
  for (var i = 0; i < lines.length; i++) {
    var text = lines[i].t;
    if (text.length < 3 || text.length > 40) {
      continue;
    }
    for (var j = 0; j < suffixes.length; j++) {
      var idx = text.indexOf(suffixes[j]);
      if (idx <= 0) {
        continue;
      }
      // 截到后缀结束处，丢掉其后重复的后缀
      var name = text.substring(0, idx + suffixes[j].length);
      if (name.length >= 3) {
        return name;
      }
    }
  }
  return '';
}

/**
 * 取参照行**正上方**的最近一行（跳过同一视觉行的其他块）。
 *
 * 判定依据是纵向位置而非数组下标：只有当候选行的下边界在参照行
 * 上边界之上（留出少量容差）时，才算「上一行」。
 */
function nearestAbove(lines, ref) {
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === ref) {
      continue;
    }
    // 候选行必须在参照行上方
    if (line.b > ref.tp + 0.002) {
      continue;
    }
    if (best === null || line.tp > best.tp) {
      best = line;
    }
  }
  return best;
}

/** 取参照行正下方的最近一行（跳过同一视觉行的其他块） */
function nearestBelow(lines, ref) {
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === ref) {
      continue;
    }
    // 候选行必须在参照行下方
    if (line.tp < ref.b - 0.002) {
      continue;
    }
    if (best === null || line.tp < best.tp) {
      best = line;
    }
  }
  return best;
}

/** 兜底：取首个居中、非界面文案、长度合适的行 */
function extractMerchantByFallback(lines) {
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // 居中：左右留白接近
    var leftGap = line.l;
    var rightGap = 1 - line.r;
    if (Math.abs(leftGap - rightGap) > 0.15) {
      continue;
    }
    if (isUsableMerchant(line)) {
      return line.t;
    }
  }
  return '';
}

/** 是否可作为商户名 */
function isUsableMerchant(line) {
  var t = line.t;
  if (t.length < 2 || t.length > MERCHANT_MAX_LEN) {
    return false;
  }
  if (isUiNoise(t) || isTableLabel(t)) {
    return false;
  }
  // 含单号特征（长数字串）的不是商户名
  if (/\d{10,}/.test(t)) {
    return false;
  }
  // 优惠/减免类文案不是商户名：各平台的措辞不一（「共优惠」「秒杀后共优惠」
  // 「店铺优惠」「已减」…），逐条罗列容易漏，按语义统一排除
  var promoWords = ['优惠', '已减', '共减', '立减', '抵扣', '折扣', '省'];
  for (var p = 0; p < promoWords.length; p++) {
    if (t.indexOf(promoWords[p]) >= 0) {
      return false;
    }
  }
  // 表格标签固定在最左列，排除
  if (line.l < VALUE_COLUMN_LEFT_MIN && t.length <= 4) {
    return false;
  }
  return true;
}

/**
 * 提取交易时间。
 *
 * 优先取「支付时间」行右侧的值；取不到时全文搜索日期。
 * 坐标用于精确定位「同一行的右侧」，避免误取到其他行的日期。
 */
function extractDate(lines, text) {
  // ① 内联版式：如「下单时间:2026-09-10 14:53:07」
  var inlineLabel = inlineLabelOf('time', ['下单时间', '支付时间', '交易时间', '付款时间']);
  var inline = findInlineValue(lines, inlineLabel);
  if (inline.length > 0) {
    var di = normalizeDate(inline);
    if (di.length > 0) {
      return di;
    }
  }
  // ② 两列版式：标签行右侧的值
  var label = findLine(lines, labelOf('time', ['支付时间', '交易时间', '付款时间', '创建时间']));
  if (label !== null) {
    var value = findValueOfRow(lines, label);
    if (value !== null) {
      var d = normalizeDate(value.t);
      if (d.length > 0) {
        return d;
      }
    }
  }
  // ③ 兜底：全文匹配
  return normalizeDate(text);
}

/**
 * 取某标签行同一行右侧的「值」。
 *
 * 表格是「标签 | 值」两列布局：值在标签右侧、垂直方向几乎对齐。
 */
function findValueOfRow(lines, labelLine) {
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === labelLine) {
      continue;
    }
    if (line.l < VALUE_COLUMN_LEFT_MIN) {
      continue;
    }
    if (!isSameRow(line, labelLine)) {
      continue;
    }
    if (best === null || line.l < best.l) {
      best = line;
    }
  }
  return best;
}

/** 从文本中解析出 "YYYY-MM-DD HH:mm:ss" */
function normalizeDate(text) {
  for (var i = 0; i < DATE_PATTERNS.length; i++) {
    var m = text.match(DATE_PATTERNS[i]);
    if (m === null) {
      continue;
    }
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var day = parseInt(m[3], 10);
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      continue;
    }
    if (m.length < 5 || m[4] === undefined) {
      // 只有日期没有时刻
      return year + '-' + pad2(month) + '-' + pad2(day) + ' 00:00:00';
    }
    var hour = parseInt(m[4], 10);
    var minute = parseInt(m[5], 10);
    var second = (m.length > 6 && m[6] !== undefined) ? parseInt(m[6], 10) : 0;
    if (hour > 23 || minute > 59 || second > 59) {
      continue;
    }
    return year + '-' + pad2(month) + '-' + pad2(day) + ' ' +
      pad2(hour) + ':' + pad2(minute) + ':' + pad2(second);
  }
  return '';
}

/**
 * 提取支付方式。
 *
 * 优先取「支付方式」行右侧的值；该值可能带「查看详情」等后缀，
 * 按关键词截取。取不到时全文搜索支付方式关键词。
 */
function extractPayMethod(lines, text) {
  // ① 内联版式：如「支付方式:微信支付」
  var inlineLabel = inlineLabelOf('payMethod', ['支付方式', '付款方式']);
  var inline = findInlineValue(lines, inlineLabel);
  if (inline.length > 0) {
    var m = matchPayMethod(inline);
    if (m.length > 0) {
      return m;
    }
  }
  // ② 两列版式
  var label = findLine(lines, labelOf('payMethod', ['支付方式', '付款方式']));
  if (label !== null) {
    var value = findValueOfRow(lines, label);
    if (value !== null) {
      var method = matchPayMethod(value.t);
      if (method.length > 0) {
        return method;
      }
    }
  }
  // ③ 兜底：全文匹配
  return matchPayMethod(text);
}

/** 从文本中匹配支付方式关键词 */
function matchPayMethod(text) {
  for (var i = 0; i < PAY_METHODS.length; i++) {
    if (text.indexOf(PAY_METHODS[i]) >= 0) {
      return PAY_METHODS[i];
    }
  }
  return '';
}

// ============================================================
// 分类匹配
// ============================================================

/**
 * 提取分类。
 *
 * 匹配范围有优先级，因为不同来源的信息可靠性不同：
 *  1) 商户名 —— 最能说明消费性质（「高德打车」→交通、「美团」→外卖）
 *  2) 商品 —— 常含具体类目（「408_餐饮消费」→餐饮）
 *  3) 全文 —— 兜底
 *
 * 匹配时按关键词长度降序：长者更具体，「共享单车」应胜过「单车」。
 * 商户名与商品都取不到时才用全文，避免底部的推广文案（如「特价外卖团购」）
 * 把一笔打车账单误判成外卖。
 *
 * 注意：本函数只得出分类名，用户分类库中是否存在同名分类由调用方判断。
 */
function extractCategory(lines, merchant, goods, text) {
  // 版式可限定匹配范围：电商标题（商品名）噪声大，误判率高，
  // 此时只依据店铺名判断，避免「粘毛器…衣服床单」被判成衣服分类。
  var scopeMode = activeRule !== null && activeRule.categoryScope !== undefined
    ? activeRule.categoryScope : 'all';

  if (scopeMode === 'merchant') {
    if (merchant.length > 0) {
      var mHit = matchCategory(merchant);
      if (mHit.length > 0) {
        return mHit;
      }
    }
    // 店铺名未命中关键词时不再退到商品名——那正是需要规避的噪声来源
    return '';
  }

  var scope = '';
  if (merchant.length > 0) {
    scope = merchant;
  } else if (goods.length > 0) {
    scope = goods;
  }
  var hit = matchCategory(scope);
  if (hit.length > 0) {
    return hit;
  }
  // 商户与商品都没命中时，退到「商品 + 商户」组合，再退到全文
  if (goods.length > 0 && merchant.length > 0) {
    hit = matchCategory(goods + ' ' + merchant);
    if (hit.length > 0) {
      return hit;
    }
  }
  return matchCategory(text);
}

/**
 * 在文本中匹配分类关键词。
 *
 * 同一分类内取最长命中的关键词；跨分类比较时也取更长者，
 * 使具体分类优先级高于宽泛分类。
 */
function matchCategory(scope) {
  if (scope.length === 0) {
    return '';
  }
  var bestName = '';
  var bestLen = 0;
  for (var i = 0; i < CATEGORY_KEYWORDS.length; i++) {
    var group = CATEGORY_KEYWORDS[i];
    for (var j = 0; j < group.words.length; j++) {
      var word = group.words[j];
      if (scope.indexOf(word) >= 0 && word.length > bestLen) {
        bestName = group.name;
        bestLen = word.length;
      }
    }
  }
  return bestName;
}

// ============================================================
// 版式识别
// ============================================================

/**
 * 识别当前页面属于哪套版式。
 *
 * 按特征词命中数判断，命中 2 个以上即认定——单个词可能恰好出现在
 * 其他页面，取 2 个可抗 OCR 误差。
 *
 * 未能识别时 activeRule 保持 null，各提取函数退回通用策略
 * （用备选标签名查找、用全部版式的噪声词判断），尽量仍能工作。
 */
function identifyPlatform(text) {
  for (var i = 0; i < PLATFORM_RULES.length; i++) {
    var rule = PLATFORM_RULES[i];
    var hits = 0;
    for (var j = 0; j < rule.identify.length; j++) {
      if (text.indexOf(rule.identify[j]) >= 0) {
        hits++;
        if (hits >= 2) {
          return rule;
        }
      }
    }
  }
  return null;
}

/**
 * 按版式截断底部无关区域。
 *
 * 表格之下通常是账单服务、客服入口、推广位，与交易无关且可能干扰
 * 分类匹配（如推广文案里的「外卖」「团购」）。
 *
 * @returns 截断后的行；未识别版式或特征缺失时原样返回
 */
function cutoffTail(lines) {
  if (activeRule === null || activeRule.cutoffMarkers === undefined
    || activeRule.cutoffMarkers.length === 0) {
    return lines;
  }
  var cutIndex = -1;
  for (var i = 0; i < lines.length; i++) {
    for (var j = 0; j < activeRule.cutoffMarkers.length; j++) {
      if (lines[i].t.indexOf(activeRule.cutoffMarkers[j]) >= 0) {
        if (cutIndex < 0 || i < cutIndex) {
          cutIndex = i;
        }
      }
    }
  }
  if (cutIndex <= 0) {
    return lines;
  }
  // 保留截断点之前的内容；该点本身是界面入口，一并去掉
  return lines.slice(0, cutIndex);
}

// ============================================================
// 入口
// ============================================================

/**
 * 入参为单个对象 { text, lines, imageWidth, imageHeight }：
 * native 桥接把本脚本包装为
 *   (function(){ var __input = JSON.parse(__inputRaw);
 *                <本脚本>
 *                return JSON.stringify(parse(__input)); })()
 */
function parse(input) {
  try {
    var src = input === undefined || input === null ? {} : input;
    var text = String(src.text === undefined || src.text === null ? '' : src.text);
    var lines = src.lines === undefined || src.lines === null ? [] : src.lines;

    // 先认出页面版式，后续提取即可按该版式的标签名取值
    activeRule = identifyPlatform(text);
    lines = cutoffTail(lines);

    var amountInfo = extractAmount(lines);
    var merchant = extractMerchant(lines, amountInfo.line);
    var dateStr = extractDate(lines, text);
    var payMethod = extractPayMethod(lines, text);
    var goods = extractGoods(lines);
    var category = extractCategory(lines, merchant, goods, text);

    return {
      // 负号即支出；无带符号金额时按支出兜底
      type: amountInfo.negative ? 0 : 0,
      amount: amountInfo.value,
      dateStr: dateStr,
      accountName: payMethod,
      categoryName: category,
      merchant: merchant,
      // 备注取商品（比商户名更能说明这笔钱花在哪）；无商品时退回商户名。
      // 版式可声明 autoNote:false 关闭自动填充——电商标题冗长且含规格噪声，
      // 强行填入反而干扰用户，交由记账时手填更合适。
      note: noteOf(goods, merchant)
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}
