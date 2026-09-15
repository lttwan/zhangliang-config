/**
 * Bluecoins 导入适配器
 *
 * 导出格式（TSV，制表符分隔，14 列）：
 *   类型  日期  设置时间  名称  金额  货币  汇率  类别组  类别  账户  备注  分组  标签  状态
 *
 * 样例：
 *   转账\t2026/9/15 17:10\t17:10\t转账测试\t-25\tCNY\t1\t(转账)\t(转账)\t钱包\t转账测试备注\t\t个人 假期\t无
 *   转账\t2026/9/15 17:10\t17:10\t转账测试\t25\tCNY\t1\t(转账)\t(转账)\t微信\t转账测试备注\t\t个人 假期\t无
 *   收入\t2026/9/15 17:10\t17:10\t收入测试\t12\tCNY\t1\t其它\t其它\t微信\t收入备注测试\t\t\t无
 *   支出\t2026/9/15 17:02\t17:02\t晚餐\t-36\tCNY\t1\t娱乐\t购物\t钱包\t\t\t个人 假期 商业\t无
 *
 * 与钱迹的主要语义差异（这正是需要独立适配器的原因）：
 * 1. **转账占两行**：同一笔转账拆成「转出账户 -金额」与「转入账户 +金额」两行，
 *    时间、名称、备注相同，需按此特征配对合并成一条本应用的转账记录
 * 2. 分隔符是制表符而非逗号
 * 3. 类型为中文枚举：转账 / 收入 / 支出
 * 4. 日期列已包含时间，格式 YYYY/M/D H:mm（月日不补零）
 * 5. 分类为「类别组 + 类别」两列
 * 6. 标签以空格分隔，如「个人 假期 商业」
 * 7. 转账行的类别组/类别为占位值 (转账)
 *
 * 输出：{ rows: string[][] } —— 本应用 14 列格式
 * 本应用列(14): ID,账单时间,账本,类型,一级分类,二级分类,金额,账户1,账户2,
 *               备注,标签,账单标记,已对账,关联账单ID
 */

var OUR_HEADER = [
  'ID', '账单时间', '账本', '类型', '一级分类', '二级分类', '金额', '账户1',
  '账户2', '备注', '标签', '账单标记', '已对账', '关联账单ID'
];

/** Bluecoins 类型 → 本应用类型 */
function mapType(raw) {
  var t = (raw || '').trim();
  switch (t) {
    case '支出':
      return '支出';
    case '收入':
      return '收入';
    case '转账':
      return '转账';
    default:
      return t;
  }
}

/**
 * 解析金额：支持千分位、货币符号、正负号。
 * 返回 { value: 绝对值, positive: 是否为正 }
 */
function parseAmount(raw) {
  if (!raw) {
    return { value: NaN, positive: true };
  }
  var s = String(raw).trim().replace(/,/g, '');
  var positive = s.indexOf('-') < 0;
  s = s.replace(/[^\d.]/g, '');
  var v = parseFloat(s);
  return { value: v, positive: positive };
}

/** 是否为形如 2026/9/15 或 2026-09-15 的日期 */
function isDateLike(raw) {
  var s = (raw || '').trim();
  if (s === '') {
    return false;
  }
  return /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(s);
}

/** 按分隔符解析表格文本（自动识别制表符/逗号），支持双引号包裹与转义 */
function parseTable(text, delimiter) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.substring(1);
  }
  while (i < text.length) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 自动识别分隔符：按首行的制表符与逗号出现次数取多者。
 * Bluecoins 导出为 TSV，但用户另存为 CSV 的情况也一并兼容。
 */
function detectDelimiter(text) {
  var firstLine = text;
  var nl = text.indexOf('\n');
  if (nl >= 0) {
    firstLine = text.substring(0, nl);
  }
  var tabs = firstLine.split('\t').length - 1;
  var commas = firstLine.split(',').length - 1;
  return tabs >= commas ? '\t' : ',';
}

/**
 * 列名别名表：不同版本/语言设置导出的表头名不同，统一归一到语义字段。
 *
 * 已观察到的差异（同一软件不同版本）：
 *   名称   / 标题        → title
 *   类别组 / 类别分组名称 → categoryGroup
 *   分组                  → 部分版本存在，语义接近标签分组，目前不单独使用
 */
var COLUMN_ALIASES = {
  '类型': 'type',
  '日期': 'date',
  '设置时间': 'setTime',
  '标题': 'title',
  '名称': 'title',
  '金额': 'amount',
  '货币': 'currency',
  '汇率': 'rate',
  '类别组': 'categoryGroup',
  '类别分组名称': 'categoryGroup',
  '类别': 'category',
  '账户': 'account',
  '备注': 'note',
  '分组': 'group',
  '标签': 'tags',
  '状态': 'status'
};

/** 无表头时的固定列序兜底（按各版本共有的前若干列） */
var FALLBACK_ORDER = ['type', 'date', 'setTime', 'title', 'amount', 'currency',
  'rate', 'categoryGroup', 'category', 'account', 'note', 'tags', 'status'];

/**
 * 由表头解析出「语义字段 → 列下标」映射。
 *
 * 无法识别任何关键列（type/date/amount）时返回 null，由调用方决定兜底策略。
 */
function resolveColumns(header) {
  var col = {};
  var recognized = 0;
  for (var i = 0; i < header.length; i++) {
    var raw = String(header[i] || '').trim();
    var key = COLUMN_ALIASES[raw];
    if (key === undefined) {
      continue;
    }
    // 同名语义列只取首次出现，避免覆盖
    if (col[key] === undefined) {
      col[key] = i;
      recognized++;
    }
  }
  if (col['type'] === undefined && col['date'] === undefined && col['amount'] === undefined) {
    return null;
  }
  return { col: col, recognized: recognized };
}

/** 无表头时按固定列序构造映射 */
function fallbackColumns() {
  var col = {};
  for (var i = 0; i < FALLBACK_ORDER.length; i++) {
    col[FALLBACK_ORDER[i]] = i;
  }
  return col;
}

function cell(row, index) {
  if (index === undefined || index < 0 || index >= row.length) {
    return '';
  }
  var v = row[index];
  return v === undefined || v === null ? '' : String(v).trim();
}

/**
 * 日期规范化：Bluecoins 的 "2026/9/15 17:10" → 本应用 "2026-09-15 17:10:00"。
 * 月/日/时/分 均补零；秒缺失时补 ":00"。
 */
function normalizeDateTime(raw) {
  var s = (raw || '').trim();
  if (s === '') {
    return '';
  }
  var parts = s.split(' ');
  var datePart = parts[0] || '';
  var timePart = parts.length > 1 ? parts[1] : '';

  var d = datePart.replace(/-/g, '/').split('/');
  if (d.length !== 3) {
    return s;
  }
  var y = d[0];
  var mo = pad2(d[1]);
  var day = pad2(d[2]);

  if (timePart === '') {
    return y + '-' + mo + '-' + day;
  }
  var t = timePart.split(':');
  var hh = pad2(t[0]);
  var mm = pad2(t.length > 1 ? t[1] : '0');
  var ss = t.length > 2 ? pad2(t[2]) : '00';
  return y + '-' + mo + '-' + day + ' ' + hh + ':' + mm + ':' + ss;
}

function pad2(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (s === '') {
    return '00';
  }
  return s.length === 1 ? '0' + s : s;
}

/** 标签：空格分隔 → 本应用 "未分组#a#b" */
function convertTags(raw) {
  var s = (raw || '').trim();
  if (s === '') {
    return '';
  }
  var tokens = s.split(/\s+/);
  var tags = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].trim();
    if (t !== '') {
      tags.push(t);
    }
  }
  if (tags.length === 0) {
    return '';
  }
  return '未分组#' + tags.join('#');
}

/** 备注：名称与备注都有值时合并，避免丢信息 */
function buildNote(name, note) {
  var n = (name || '').trim();
  var m = (note || '').trim();
  if (n !== '' && m !== '') {
    return n + ' (' + m + ')';
  }
  return n !== '' ? n : m;
}

/**
 * 转账配对键：时间 + 名称 + 备注。
 * Bluecoins 把一笔转账拆成两行，这三项在两行中相同。
 */
function transferKey(row, col) {
  return cell(row, col['date']) + '\u0001'
    + cell(row, col['title']) + '\u0001'
    + cell(row, col['note']);
}

/**
 * 转账配对：Bluecoins 把一笔转账拆成两行（转出 -金额 / 转入 +金额），
 * 两行的时间、名称、备注相同，金额符号相反。
 *
 * 算法：先扫描出全部转账行并按配对键分组，同组内再按符号配成 (转出, 转入)。
 * 用 used 集合保证每行只被消费一次；找不到配对的单边行单独成条，不丢数据。
 *
 * @returns 按原始行序排列的分组列表，每组为 [转出行, 转入行] 或 [单边行]
 */
function groupTransferRows(rows, startRow, col) {
  var transferIndexes = [];
  for (var i = startRow; i < rows.length; i++) {
    if (mapType(cell(rows[i], col['type'])) === '转账') {
      transferIndexes.push(i);
    }
  }

  // 按配对键分组
  var buckets = {};
  var order = [];
  for (var k = 0; k < transferIndexes.length; k++) {
    var idx = transferIndexes[k];
    var key = transferKey(rows[idx], col);
    if (buckets[key] === undefined) {
      buckets[key] = [];
      order.push(key);
    }
    buckets[key].push(idx);
  }

  var used = {};
  var groups = [];
  for (var o = 0; o < order.length; o++) {
    var bucket = buckets[order[o]];
    var negatives = [];
    var positives = [];
    for (var b = 0; b < bucket.length; b++) {
      if (used[bucket[b]]) {
        continue;
      }
      var amount = parseAmount(cell(rows[bucket[b]], col['amount']));
      if (amount.positive) {
        positives.push(bucket[b]);
      } else {
        negatives.push(bucket[b]);
      }
    }
    var pairs = Math.min(negatives.length, positives.length);
    for (var n = 0; n < pairs; n++) {
      used[negatives[n]] = true;
      used[positives[n]] = true;
      groups.push([negatives[n], positives[n]]);
    }
    // 落单的行单独成条
    for (var x = pairs; x < negatives.length; x++) {
      used[negatives[x]] = true;
      groups.push([negatives[x]]);
    }
    for (var y = pairs; y < positives.length; y++) {
      used[positives[y]] = true;
      groups.push([positives[y]]);
    }
  }

  // 按各组首行的原始位置排序，保持导出顺序
  groups.sort(function (a, b) { return a[0] - b[0]; });
  return { groups: groups, used: used };
}

function parse(input) {
  var result = [OUR_HEADER];
  var text = input.text || '';
  var delimiter = detectDelimiter(text);
  var rows = parseTable(text, delimiter);
  // 至少需要一行；有表头时实际的判定在下方（需要表头 + 至少一条数据）
  if (rows.length === 0) {
    return { rows: result };
  }

  var resolved = resolveColumns(rows[0]);
  var col;
  var startRow;
  if (resolved !== null) {
    col = resolved.col;
    startRow = 1;
    // key 列必须齐全，缺失会导致大量字段静默为空
    if (col['type'] === undefined || col['date'] === undefined
      || col['amount'] === undefined) {
      return {
        rows: result,
        error: '表头缺少关键列（类型/日期/金额），请确认是 Bluecoins 导出文件'
      };
    }
  } else {
    // 认不出任何关键列：需区分「有表头但格式不符」与「本就没有表头」
    var firstRow = rows[0];
    var looksLikeData = false;
    // 数据行的首列应是类型枚举或日期；表头行则不是
    var firstCell = cell(firstRow, 0);
    if (mapType(firstCell) === '支出' || mapType(firstCell) === '收入'
      || mapType(firstCell) === '转账') {
      looksLikeData = true;
    }
    if (isDateLike(cell(firstRow, 1))) {
      looksLikeData = true;
    }
    if (!looksLikeData) {
      // 表头存在但无法识别——直接报错，避免静默产出错乱数据
      return {
        rows: result,
        error: '无法识别的表头：' + firstRow.slice(0, 4).join(' / ')
          + '。请确认是 Bluecoins 导出文件，或反馈该表头以便适配'
      };
    }
    // 确实没有表头：按固定列序兜底
    col = fallbackColumns();
    startRow = 0;
  }

  var transfer = groupTransferRows(rows, startRow, col);
  var used = transfer.used;
  var groups = [];
  var t = 0;
  for (var i = startRow; i < rows.length; i++) {
    if (used[i]) {
      // 由转账分组统一输出，位置取该组首行
      continue;
    }
    groups.push([i]);
  }
  // 合并两类分组并保持原始顺序
  for (var g = 0; g < transfer.groups.length; g++) {
    groups.push(transfer.groups[g]);
  }
  groups.sort(function (a, b) { return a[0] - b[0]; });

  var seq = 0;
  for (var m = 0; m < groups.length; m++) {
    var idxList = groups[m];
    var rowList = [];
    for (var q = 0; q < idxList.length; q++) {
      rowList.push(rows[idxList[q]]);
    }
    var type = mapType(cell(rowList[0], col['type']));
    var built = buildRecord(type, rowList, col, seq + 1);
    if (built !== null) {
      seq++;
      result.push(built);
    }
  }
  return { rows: result };
}

/**
 * 由一行或两行（转账）构造本应用记录。
 *
 * @param type 已判定的本应用类型
 * @param rowList 单行 [row]；转账为 [转出行, 转入行]
 */
function buildRecord(type, rowList, col, seq) {
  var first = rowList[0];
  var second = rowList.length > 1 ? rowList[1] : null;

  var dateRaw = cell(first, col['date']);
  if (dateRaw === '') {
    return null;
  }
  var amountInfo = parseAmount(cell(first, col['amount']));
  if (isNaN(amountInfo.value)) {
    return null;
  }

  var out = new Array(14).fill('');
  out[0] = 'bluecoins-' + seq;
  out[1] = normalizeDateTime(dateRaw);
  out[2] = '';
  out[3] = type;
  out[9] = buildNote(cell(first, col['title']), cell(first, col['note']));
  out[10] = convertTags(cell(first, col['tags']));
  // 非人民币账单：本应用目前仅支持人民币。
  // 在「账单标记」列写入 外币:<币种>，由导入层识别为问题账单并跳过，
  // 提示用户暂不支持该币种。
  var currency = cell(first, col['currency']).toUpperCase();
  if (currency !== '' && currency !== 'CNY') {
    out[11] = '外币:' + currency;
  }
  out[12] = '';
  out[13] = '';

  if (type === '转账') {
    // 账户1 = 转出（金额为负的那行的账户），账户2 = 转入
    if (second !== null) {
      out[6] = amountInfo.value.toString();
      out[7] = cell(first, col['account']);
      out[8] = cell(second, col['account']);
    } else {
      // 单边转账：只保留已知账户，不臆造另一侧
      out[6] = amountInfo.value.toString();
      out[7] = amountInfo.positive ? '' : cell(first, col['account']);
      out[8] = amountInfo.positive ? cell(first, col['account']) : '';
    }
    // 转账在蓝色币中标为 (转账) 占位，清空以免生成无意义分类
    out[4] = '';
    out[5] = '';
    return out;
  }

  var catGroup = cell(first, col['categoryGroup']);
  var catSub = cell(first, col['category']);
  // 部分记录会用括号包裹占位值，如 "(其它)"
  if (catGroup.indexOf('(') === 0) {
    catGroup = '';
  }
  if (catSub.indexOf('(') === 0) {
    catSub = '';
  }
  out[4] = catGroup;
  out[5] = catSub;
  out[6] = amountInfo.value.toString();
  out[7] = cell(first, col['account']);
  out[8] = '';
  return out;
}
