/**
 * 钱迹导入适配器
 *
 * 输入:  { text: <CSV文本>, fileName: <原始文件名> }
 * 输出:  { rows: string[][] }  —— 本应用 14 列格式
 *
 * 钱迹列(19): ID,时间,账本,分类,二级分类,类型,金额,币种,账户1,账户2,备注,
 *             已报销,手续费,优惠券,记账者,账单标记,标签,账单图片,关联账单
 * 本应用列(14): ID,账单时间,账本,类型,一级分类,二级分类,金额,账户1,账户2,
 *              备注,标签,账单标记,已对账,关联账单ID
 */

var OUR_HEADER = [
  'ID', '账单时间', '账本', '类型', '一级分类', '二级分类', '金额', '账户1',
  '账户2', '备注', '标签', '账单标记', '已对账', '关联账单ID'
];

/** 解析 CSV 文本为二维数组，支持双引号包裹与转义 */
function parseCsv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  // 去掉 BOM
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

/** 安全取列 */
function cell(row, idx) {
  if (idx < row.length && row[idx] !== undefined && row[idx] !== null) {
    return String(row[idx]);
  }
  return '';
}

/** 钱迹类型 → 本应用类型 */
function mapType(type) {
  switch (type) {
    case '支出':
    case '收入':
      return type;
    case '转账':
      return '转账';
    case '债务-借入':
      return '周转-借入';
    case '债务-借出':
      return '周转-借出';
    case '债务-还款':
      return '周转-还款';
    case '债务-收款':
      return '周转-收款';
    case '报销':
      return '支出';
    case '报销记录':
      return '报销入账';
    default:
      return type;
  }
}

/** 钱迹标签 → 本应用标签（# 分隔，统一归入"未分组"） */
function convertTags(tagStr) {
  if (!tagStr) {
    return '';
  }
  var tokens = tagStr.split('#');
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

/** 钱迹账单标记 + 已报销 → 本应用账单标记 */
function mapMark(mark, reimbursed) {
  var parts = [];
  if (mark && mark.length > 0) {
    if (mark === '不计收支&预算') {
      parts.push('不计收支');
      parts.push('不计预算');
    } else {
      parts.push(mark);
    }
  }
  if (reimbursed === '是') {
    parts.push('已报销');
  }
  return parts.join('|');
}

function parse(input) {
  var rows = parseCsv(input.text || '');
  var result = [OUR_HEADER];
  if (rows.length < 2) {
    return { rows: result };
  }

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (r.length < 7) {
      continue;
    }
    var origId = cell(r, 0);
    var qType = cell(r, 5);
    var qAcc1 = cell(r, 8);
    var qAcc2 = cell(r, 9);

    var out = new Array(14).fill('');
    out[0] = origId;
    out[1] = cell(r, 1);
    out[2] = cell(r, 2);
    out[3] = mapType(qType);
    out[4] = cell(r, 3);
    out[5] = cell(r, 4);
    out[6] = cell(r, 6);

    // 债务类且无转入账户时，账户落在「账户2」列
    if ((qType === '债务-还款' || qType === '债务-借出') && qAcc2 === '' && qAcc1 !== '') {
      out[7] = '';
      out[8] = qAcc1;
    } else {
      out[7] = qAcc1;
      out[8] = qAcc2;
    }

    out[9] = cell(r, 10);
    out[10] = convertTags(cell(r, 16));
    out[11] = mapMark(cell(r, 15), cell(r, 11));
    out[12] = '';
    out[13] = cell(r, 18);
    result.push(out);

    // 手续费 > 0 时拆出一条独立账单
    var feeStr = cell(r, 12);
    if (feeStr.length > 0) {
      var feeAmt = parseFloat(feeStr);
      if (!isNaN(feeAmt) && feeAmt !== 0) {
        var feeRow = new Array(14).fill('');
        feeRow[1] = cell(r, 1);
        feeRow[2] = cell(r, 2);
        feeRow[3] = '手续费';
        feeRow[6] = feeStr;
        feeRow[7] = cell(r, 8);
        feeRow[13] = origId;
        result.push(feeRow);
      }
    }
  }
  return { rows: result };
}
