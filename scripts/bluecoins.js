/**
 * Bluecoins 导入适配器
 *
 * Bluecoins（Android 记账应用）CSV 导出格式：
 *   Date,Time,Amount,Type,Category,Account,Notes,Labels
 *   - Date:     YYYY-MM-DD
 *   - Time:     HH:mm:ss
 *   - Amount:   带符号，负=支出，正=收入
 *   - Type:     Expense / Income / Transfer
 *   - Category: "一级:二级"（冒号分隔），转账时固定为 Transfer:Transfer
 *   - Account:  普通账单为单个账户；转账为 "转出>转入"
 *   - Labels:   多个标签以逗号分隔（CSV 中会被引号包裹）
 *
 * 与钱迹的主要语义差异（这正是需要独立适配器的原因）：
 * 1. 类型是英文枚举，需映射为中文类型
 * 2. 日期与时间分列，需拼接
 * 3. 金额带符号，需按符号推断收支方向
 * 4. 转账只有一个 Account 列，用 ">" 表示双方账户
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
function mapType(raw, amount) {
  var t = (raw || '').trim().toLowerCase();
  if (t === 'expense') {
    return '支出';
  }
  if (t === 'income') {
    return '收入';
  }
  if (t === 'transfer') {
    return '转账';
  }
  // 未知类型时按金额符号兜底：正为收入，负为支出
  return amount >= 0 ? '收入' : '支出';
}

/** 去除金额字符串中的千分位与货币符号，保留符号与小数点 */
function parseAmount(raw) {
  if (!raw) {
    return NaN;
  }
  var s = String(raw).trim().replace(/,/g, '');
  s = s.replace(/[^\d.\-+]/g, '');
  return parseFloat(s);
}

/** 解析 CSV 文本为二维数组，支持双引号包裹与转义 */
function parseCsv(text) {
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
    if (ch === ',') {
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

/** 按表头名定位列下标；找不到时返回 -1 */
function buildColumnIndex(header) {
  var idx = {};
  for (var i = 0; i < header.length; i++) {
    var name = String(header[i] || '').trim().toLowerCase();
    idx[name] = i;
  }
  return idx;
}

function cell(row, index) {
  if (index === undefined || index < 0 || index >= row.length) {
    return '';
  }
  var v = row[index];
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 分类 "一级:二级" → [一级, 二级] */
function splitCategory(raw) {
  if (!raw) {
    return ['', ''];
  }
  var pos = raw.indexOf(':');
  if (pos < 0) {
    return [raw.trim(), ''];
  }
  return [raw.substring(0, pos).trim(), raw.substring(pos + 1).trim()];
}

/** 账户 "转出>转入" → [转出, 转入] */
function splitTransferAccount(raw) {
  if (!raw) {
    return ['', ''];
  }
  // 支持全角与半角分隔符
  var normalized = raw.replace(/＞/g, '>').replace(/→/g, '>');
  var pos = normalized.indexOf('>');
  if (pos < 0) {
    return [normalized.trim(), ''];
  }
  return [normalized.substring(0, pos).trim(), normalized.substring(pos + 1).trim()];
}

/** 标签：逗号分隔 → 本应用 "未分组#a#b" */
function convertLabels(raw) {
  if (!raw) {
    return '';
  }
  var tokens = String(raw).split(',');
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

/** 日期 + 时间 拼接为 "YYYY-MM-DD HH:mm:ss" */
function joinDateTime(date, time) {
  var d = (date || '').trim();
  var t = (time || '').trim();
  if (d === '') {
    return '';
  }
  if (t === '') {
    return d;
  }
  // 只取时分秒，去掉可能存在的毫秒/时区
  var m = t.match(/^(\d{1,2}:\d{2}(?::\d{2})?)/);
  return m ? d + ' ' + m[1] : d + ' ' + t;
}

function parse(input) {
  var rows = parseCsv(input.text || '');
  var result = [OUR_HEADER];
  if (rows.length < 2) {
    return { rows: result };
  }

  var col = buildColumnIndex(rows[0]);
  // 表头识别失败（例如无表头的裸数据）时回退到固定列序
  var hasHeader = col['date'] !== undefined || col['amount'] !== undefined;
  var iDate = hasHeader ? col['date'] : 0;
  var iTime = hasHeader ? col['time'] : 1;
  var iAmount = hasHeader ? col['amount'] : 2;
  var iType = hasHeader ? col['type'] : 3;
  var iCategory = hasHeader ? col['category'] : 4;
  var iAccount = hasHeader ? col['account'] : 5;
  var iNotes = hasHeader ? col['notes'] : 6;
  var iLabels = hasHeader ? col['labels'] : 7;

  var startRow = hasHeader ? 1 : 0;
  var seq = 0;

  for (var r = startRow; r < rows.length; r++) {
    var row = rows[r];
    var dateRaw = cell(row, iDate);
    var amountRaw = cell(row, iAmount);
    if (dateRaw === '' || amountRaw === '') {
      continue;
    }
    var amount = parseAmount(amountRaw);
    if (isNaN(amount)) {
      continue;
    }

    var typeRaw = cell(row, iType);
    var type = mapType(typeRaw, amount);
    var accountRaw = cell(row, iAccount);
    var accFrom = '';
    var accTo = '';
    if (type === '转账') {
      var pair = splitTransferAccount(accountRaw);
      accFrom = pair[0];
      accTo = pair[1];
    } else {
      accFrom = accountRaw;
    }

    var cat = splitCategory(cell(row, iCategory));

    var out = new Array(14).fill('');
    // Bluecoins 无导出 ID，用序号占位，保证预览去重逻辑正常工作
    seq++;
    out[0] = 'bluecoins-' + seq;
    out[1] = joinDateTime(dateRaw, cell(row, iTime));
    out[2] = '';
    out[3] = type;
    out[4] = type === '转账' ? '' : cat[0];
    out[5] = type === '转账' ? '' : cat[1];
    // 本应用金额为正数，方向由类型表达
    out[6] = Math.abs(amount).toString();
    out[7] = accFrom;
    out[8] = accTo;
    out[9] = cell(row, iNotes);
    out[10] = convertLabels(cell(row, iLabels));
    out[11] = '';
    out[12] = '';
    out[13] = '';
    result.push(out);
  }

  return { rows: result };
}
