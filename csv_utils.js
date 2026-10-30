/**
 * Domuto | Visual Browser Automation - CSV Parser, Serializer & Variable Interpolation Utilities
 * Authored by Subrata Dey
 */
(function (globalScope) {
  /**
   * Parses raw CSV text into { headers: string[], rows: Record<string, string>[] }
   * Handles quoted fields, embedded commas, and CRLF/LF line breaks.
   */
  function parseCSV(csvText) {
    if (!csvText || typeof csvText !== 'string') {
      return { headers: [], rows: [] };
    }
    // Strip UTF-8 BOM if present
    const cleaned = csvText.replace(/^\uFEFF/, '').trim();
    if (!cleaned) {
      return { headers: [], rows: [] };
    }

    const matrix = [];
    let currentRow = [];
    let currentVal = '';
    let inQuotes = false;

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      const nextChar = cleaned[i + 1];

      if (inQuotes) {
        if (char === '"' && nextChar === '"') {
          currentVal += '"';
          i++; // skip escaped quote
        } else if (char === '"') {
          inQuotes = false;
        } else {
          currentVal += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          currentRow.push(currentVal.trim());
          currentVal = '';
        } else if (char === '\r' && nextChar === '\n') {
          currentRow.push(currentVal.trim());
          matrix.push(currentRow);
          currentRow = [];
          currentVal = '';
          i++; // skip \n
        } else if (char === '\n' || char === '\r') {
          currentRow.push(currentVal.trim());
          matrix.push(currentRow);
          currentRow = [];
          currentVal = '';
        } else {
          currentVal += char;
        }
      }
    }
    // Push last value/row
    if (currentVal.length > 0 || currentRow.length > 0) {
      currentRow.push(currentVal.trim());
      matrix.push(currentRow);
    }

    if (matrix.length === 0) {
      return { headers: [], rows: [] };
    }

    const rawHeaders = matrix[0];
    const headers = rawHeaders.map((h, idx) => h || `Column_${idx + 1}`);
    const rows = [];

    for (let r = 1; r < matrix.length; r++) {
      const rowArr = matrix[r];
      // Skip completely empty trailing rows
      if (rowArr.length === 1 && rowArr[0] === '') continue;
      const rowObj = {};
      headers.forEach((h, cIdx) => {
        rowObj[h] = rowArr[cIdx] !== undefined ? rowArr[cIdx] : '';
      });
      rows.push(rowObj);
    }

    return { headers, rows };
  }

  /**
   * Serializes an array of row objects into a valid RFC-4180 CSV string.
   */
  function objectsToCSV(rows, explicitHeaders) {
    if (!rows || rows.length === 0) {
      if (explicitHeaders && explicitHeaders.length > 0) {
        return explicitHeaders.map(escapeCSVCell).join(',');
      }
      return '';
    }
    const headerSet = new Set(explicitHeaders || []);
    rows.forEach((r) => {
      Object.keys(r || {}).forEach((k) => headerSet.add(k));
    });
    const headers = Array.from(headerSet);

    const lines = [headers.map(escapeCSVCell).join(',')];
    for (const row of rows) {
      const line = headers.map((h) => escapeCSVCell(row[h] !== undefined && row[h] !== null ? String(row[h]) : ''));
      lines.push(line.join(','));
    }
    return lines.join('\r\n');
  }

  function escapeCSVCell(val) {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Helper to parse date strings and preserve their original format.
   * Supports:
   *  - MM-DD-YYYY or M-D-YYYY
   *  - MM/DD/YYYY or M/D/YYYY
   *  - YYYY-MM-DD
   *  - YYYY/MM/DD
   *  - DD-MM-YYYY or DD/MM/YYYY (when day > 12)
   *  - DD-MMM-YYYY or DD MMM YYYY (e.g. 18-Sep-2026)
   */
  function parseDateWithFormat(str) {
    if (!str || typeof str !== 'string') return null;
    const s = str.trim();
    if (!s) return null;

    // 1. MM-DD-YYYY or DD-MM-YYYY (sep: -)
    let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) {
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      let month = p1;
      let day = p2;
      let format = 'MM-DD-YYYY';
      if (p1 > 12 && p2 <= 12) {
        day = p1;
        month = p2;
        format = 'DD-MM-YYYY';
      }
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        return { date, format, padMonth: m[1].length === 2, padDay: m[2].length === 2, sep: '-' };
      }
    }

    // 2. MM/DD/YYYY or DD/MM/YYYY (sep: /)
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      let month = p1;
      let day = p2;
      let format = 'MM/DD/YYYY';
      if (p1 > 12 && p2 <= 12) {
        day = p1;
        month = p2;
        format = 'DD/MM/YYYY';
      }
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        return { date, format, padMonth: m[1].length === 2, padDay: m[2].length === 2, sep: '/' };
      }
    }

    // 3. YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        return { date, format: 'YYYY-MM-DD', padMonth: m[2].length === 2, padDay: m[3].length === 2, sep: '-' };
      }
    }

    // 4. YYYY/MM/DD
    m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      const date = new Date(year, month - 1, day);
      if (!isNaN(date.getTime())) {
        return { date, format: 'YYYY/MM/DD', padMonth: m[2].length === 2, padDay: m[3].length === 2, sep: '/' };
      }
    }

    // 5. DD-MMM-YYYY or DD MMM YYYY (e.g. 18-Sep-2026 or 18 Sep 2026)
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/);
    if (m) {
      const day = parseInt(m[1], 10);
      const monStr = m[2].toLowerCase();
      const monIdx = MONTHS.findIndex((mo) => mo.toLowerCase() === monStr);
      const year = parseInt(m[3], 10);
      if (monIdx >= 0) {
        const date = new Date(year, monIdx, day);
        if (!isNaN(date.getTime())) {
          return { date, format: 'DD-MMM-YYYY', padDay: m[1].length === 2, sep: s.includes('-') ? '-' : ' ' };
        }
      }
    }

    // Fallback if ISO timestamp
    if (s.length >= 10 && (s.includes('-') || s.includes('/'))) {
      const parsed = Date.parse(s);
      if (!isNaN(parsed)) {
        const date = new Date(parsed);
        return { date, format: 'MM-DD-YYYY', padMonth: true, padDay: true, sep: '-' };
      }
    }

    return null;
  }

  function formatDateLike(date, formatInfo) {
    if (!formatInfo) {
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${m}-${d}-${date.getFullYear()}`;
    }
    const y = date.getFullYear();
    const mNum = date.getMonth() + 1;
    const dNum = date.getDate();
    const mStr = formatInfo.padMonth ? String(mNum).padStart(2, '0') : String(mNum);
    const dStr = formatInfo.padDay ? String(dNum).padStart(2, '0') : String(dNum);
    const sep = formatInfo.sep || '-';

    if (formatInfo.format === 'YYYY-MM-DD' || formatInfo.format === 'YYYY/MM/DD') {
      return `${y}${sep}${mStr}${sep}${dStr}`;
    }
    if (formatInfo.format === 'DD-MM-YYYY' || formatInfo.format === 'DD/MM/YYYY') {
      return `${dStr}${sep}${mStr}${sep}${y}`;
    }
    if (formatInfo.format === 'DD-MMM-YYYY') {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${dStr}${sep}${MONTHS[date.getMonth()]}${sep}${y}`;
    }
    return `${mStr}${sep}${dStr}${sep}${y}`;
  }

  function addCalendarDays(startDate, n) {
    const d = new Date(startDate.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  function addBusinessDays(startDate, n) {
    const d = new Date(startDate.getTime());
    if (n === 0) {
      while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() + 1);
      }
      return d;
    }
    const sign = n >= 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
      d.setDate(d.getDate() + sign);
      const day = d.getDay(); // 0 = Sun, 6 = Sat
      if (day !== 0 && day !== 6) {
        remaining--;
      }
    }
    return d;
  }

  function resolveSingleToken(token, context = {}) {
    const key = String(token || '').replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
    const {
      masterRow = {},
      stepRow = {},
      masterRowIndex = 0,
      stepRowIndex = 0,
      extractedVars = {}
    } = context;

    if (key === 'row_index') return String(masterRowIndex + 1);
    if (key === 'step_row_index') return String(stepRowIndex + 1);

    if (key.startsWith('prev.')) {
      const prevKey = key.slice(5);
      if (extractedVars && extractedVars[prevKey] !== undefined) {
        return String(extractedVars[prevKey]);
      }
      return '';
    }
    if (key.startsWith('step.')) {
      const col = key.slice(5);
      if (stepRow && stepRow[col] !== undefined) return String(stepRow[col]);
      if (masterRow && masterRow[col] !== undefined) return String(masterRow[col]);
      return '';
    }
    if (key.startsWith('master.')) {
      const col = key.slice(7);
      if (masterRow && masterRow[col] !== undefined) return String(masterRow[col]);
      if (stepRow && stepRow[col] !== undefined) return String(stepRow[col]);
      return '';
    }
    if (key.startsWith('var.')) {
      const varName = key.slice(4);
      return extractedVars && extractedVars[varName] !== undefined ? String(extractedVars[varName]) : '';
    }

    if (stepRow && stepRow[key] !== undefined) return String(stepRow[key]);
    if (masterRow && masterRow[key] !== undefined) return String(masterRow[key]);
    if (extractedVars && extractedVars[key] !== undefined) return String(extractedVars[key]);

    return token;
  }

  /**
   * Evaluates a math or date calculation expression such as:
   *   "{{PO_Submitted_Date}} + next business day"
   *   "{{PO_Submitted_Date}} + 1"
   *   "{{PO_Submitted_Date}} + 3 business days"
   *   "{{PO_Submitted_Date}} - 1 day"
   *   "{{Price}} * 1.1"
   *   "{{Quantity}} + 5"
   * Returns calculated string, or null if not a calculation.
   */
  function evaluateMathOrDateExpression(rawExpr, context = {}) {
    if (!rawExpr || typeof rawExpr !== 'string') return null;
    const trimmed = rawExpr.trim();

    // Match [left operand] [operator + - * /] [right operand]
    const match = trimmed.match(/^(\{\{[^}]+\}\}|[a-zA-Z0-9_.\$]+)\s*([\+\-\*\/])\s*(.+)$/);
    if (!match) return null;

    let leftRaw = match[1].trim();
    const op = match[2];
    let rightRaw = match[3].trim();

    // Resolve left value if token or column name
    let leftVal = leftRaw.startsWith('{{')
      ? resolveSingleToken(leftRaw, context)
      : resolveSingleToken(`{{${leftRaw}}}`, context);
    if (leftVal === `{{${leftRaw}}}`) {
      leftVal = leftRaw;
    }

    // Resolve right value if it contains a token
    if (rightRaw.startsWith('{{') && rightRaw.endsWith('}}')) {
      rightRaw = resolveSingleToken(rightRaw, context);
    }

    // Check if left operand is a date
    const dateInfo = parseDateWithFormat(leftVal);
    if (dateInfo) {
      const rightLower = rightRaw.toLowerCase().trim();
      const isBiz = /business|workday|biz/.test(rightLower);

      let num = 1;
      if (rightLower.includes('next')) {
        num = 1;
      } else if (rightLower.includes('prev')) {
        num = -1;
      } else {
        const numMatch = rightLower.match(/[-+]?\d+/);
        if (numMatch) {
          num = parseInt(numMatch[0], 10);
        }
      }

      if (op === '-') num = -num;

      const resDate = isBiz
        ? addBusinessDays(dateInfo.date, num)
        : addCalendarDays(dateInfo.date, num);

      return formatDateLike(resDate, dateInfo);
    }

    // Check if numeric calculation
    const leftClean = String(leftVal).replace(/,/g, '').trim();
    const rightClean = String(rightRaw).replace(/,/g, '').trim();
    const hasDollar = leftClean.startsWith('$');
    const numLeft = parseFloat(hasDollar ? leftClean.slice(1) : leftClean);
    const numRight = parseFloat(rightClean.startsWith('$') ? rightClean.slice(1) : rightClean);

    if (!isNaN(numLeft) && !isNaN(numRight)) {
      let res = 0;
      if (op === '+') res = numLeft + numRight;
      else if (op === '-') res = numLeft - numRight;
      else if (op === '*') res = numLeft * numRight;
      else if (op === '/') res = numRight !== 0 ? numLeft / numRight : 0;

      const hasDecimals = leftClean.includes('.') || rightClean.includes('.');
      const formattedNum = hasDecimals
        ? (Math.round(res * 100) / 100).toFixed(2)
        : String(Math.round(res * 10000) / 10000);
      return hasDollar ? `$${formattedNum}` : formattedNum;
    }

    return null;
  }

  /**
   * Resolves template variables and formulas inside a string like:
   *   "https://example.com/search?q={{query}}&page={{step.page}}&ref={{prev.step_2}}"
   *   "({{PO_Submitted_Date}} + next business day)"
   *   "({{PO_Submitted_Date}}+1)"
   *   "Total: ({{Price}} * 1.15)"
   * Supports:
   *   - Parenthesized math & date expressions: ({{Col}} + 1), ({{Col}} + next business day)
   *   - {{columnName}} -> looks up in stepRow first, then masterRow, then extractedVars
   *   - {{master.columnName}} -> looks up in masterRow
   *   - {{step.columnName}} -> looks up in stepRow
   *   - {{prev.step_1}}, {{prev.step_2}} -> value/data produced or used by previous step #1, #2, etc.
   *   - {{var.VariableName}} -> value extracted/saved by a previous step's output column
   *   - {{row_index}} -> 1-based master row index
   *   - {{step_row_index}} -> 1-based step row index
   */
  function interpolateValue(template, context = {}) {
    if (template === undefined || template === null) return '';
    let str = String(template);

    // 1. Evaluate parenthesized math & date formulas: e.g. ({{PO_Submitted_Date}} + next business day) or ({{PO_Submitted_Date}}+1)
    str = str.replace(/\(([^()]+?)\)/g, (fullMatch, inner) => {
      const evalRes = evaluateMathOrDateExpression(inner, context);
      return evalRes !== null ? evalRes : fullMatch;
    });

    // 2. Evaluate expressions or tokens inside {{ ... }}
    str = str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr) => {
      const key = expr.trim();
      if (/[\+\-\*\/]/.test(key) && !key.startsWith('prev.') && !key.startsWith('var.')) {
        const evalRes = evaluateMathOrDateExpression(key, context);
        if (evalRes !== null) return evalRes;
      }
      return resolveSingleToken(key, context);
    });

    return str;
  }

  /**
   * Evaluates a Check / Verify condition against an element's actual content.
   * Returns { passed: boolean, reason: string, actualNormalized: string }
   */
  function evaluateVerification(actualValue, condition = 'contains', expectedValue = '', caseSensitive = false) {
    const actualStr = String(actualValue ?? '').trim();
    const expectedStr = String(expectedValue ?? '').trim();
    const normActual = caseSensitive ? actualStr : actualStr.toLowerCase();
    const normExpected = caseSensitive ? expectedStr : expectedStr.toLowerCase();

    // Helper to parse numeric value from currency/formatted strings like "$1,249.99" or "42 items"
    const extractNum = (s) => {
      const cleaned = s.replace(/,/g, '');
      const match = cleaned.match(/[-+]?\d*\.?\d+/);
      return match ? parseFloat(match[0]) : NaN;
    };

    let passed = false;
    let reason = '';

    switch (condition) {
      case 'contains':
        passed = normActual.includes(normExpected);
        reason = passed
          ? `Contains "${expectedStr}"`
          : `Expected "${actualStr.slice(0, 60)}" to contain "${expectedStr}"`;
        break;

      case 'not_contains':
        passed = !normActual.includes(normExpected);
        reason = passed
          ? `Does not contain "${expectedStr}"`
          : `Expected "${actualStr.slice(0, 60)}" NOT to contain "${expectedStr}"`;
        break;

      case 'equals':
        passed = normActual === normExpected;
        reason = passed
          ? `Equals "${expectedStr}"`
          : `Expected "${actualStr.slice(0, 60)}" to equal "${expectedStr}"`;
        break;

      case 'not_equals':
        passed = normActual !== normExpected;
        reason = passed
          ? `Does not equal "${expectedStr}"`
          : `Expected "${actualStr.slice(0, 60)}" NOT to equal "${expectedStr}"`;
        break;

      case 'starts_with':
        passed = normActual.startsWith(normExpected);
        reason = passed
          ? `Starts with "${expectedStr}"`
          : `Expected "${actualStr.slice(0, 60)}" to start with "${expectedStr}"`;
        break;

      case 'ends_with':
        passed = normActual.endsWith(normExpected);
        reason = passed
          ? `Ends with "${expectedStr}"`
          : `Expected "${actualStr.slice(0, 60)}" to end with "${expectedStr}"`;
        break;

      case 'is_integer': {
        const cleanedInt = actualStr.replace(/,/g, '');
        const isInt = /^[-+]?\d+$/.test(cleanedInt);
        if (expectedStr !== '') {
          passed = isInt && parseInt(cleanedInt, 10) === parseInt(expectedStr.replace(/,/g, ''), 10);
          reason = passed
            ? `Is integer ${expectedStr}`
            : `Expected integer ${expectedStr}, found "${actualStr.slice(0, 60)}"`;
        } else {
          passed = isInt;
          reason = passed
            ? `Is valid integer (${actualStr})`
            : `Expected an integer, found "${actualStr.slice(0, 60)}"`;
        }
        break;
      }

      case 'contains_integer': {
        passed = /\d+/.test(actualStr);
        reason = passed
          ? `Contains integer/digits in "${actualStr.slice(0, 60)}"`
          : `Expected digits/integer inside "${actualStr.slice(0, 60)}"`;
        break;
      }

      case 'is_number': {
        const num = extractNum(actualStr);
        passed = !Number.isNaN(num) && Number.isFinite(num);
        reason = passed
          ? `Contains valid number (${num})`
          : `Expected a number, found "${actualStr.slice(0, 60)}"`;
        break;
      }

      case 'gt': {
        const aNum = extractNum(actualStr);
        const eNum = parseFloat(expectedStr.replace(/,/g, ''));
        passed = !Number.isNaN(aNum) && !Number.isNaN(eNum) && aNum > eNum;
        reason = passed ? `${aNum} > ${eNum}` : `Expected > ${eNum}, found "${actualStr.slice(0, 60)}" (${aNum})`;
        break;
      }

      case 'gte': {
        const aNum = extractNum(actualStr);
        const eNum = parseFloat(expectedStr.replace(/,/g, ''));
        passed = !Number.isNaN(aNum) && !Number.isNaN(eNum) && aNum >= eNum;
        reason = passed ? `${aNum} >= ${eNum}` : `Expected >= ${eNum}, found "${actualStr.slice(0, 60)}" (${aNum})`;
        break;
      }

      case 'lt': {
        const aNum = extractNum(actualStr);
        const eNum = parseFloat(expectedStr.replace(/,/g, ''));
        passed = !Number.isNaN(aNum) && !Number.isNaN(eNum) && aNum < eNum;
        reason = passed ? `${aNum} < ${eNum}` : `Expected < ${eNum}, found "${actualStr.slice(0, 60)}" (${aNum})`;
        break;
      }

      case 'lte': {
        const aNum = extractNum(actualStr);
        const eNum = parseFloat(expectedStr.replace(/,/g, ''));
        passed = !Number.isNaN(aNum) && !Number.isNaN(eNum) && aNum <= eNum;
        reason = passed ? `${aNum} <= ${eNum}` : `Expected <= ${eNum}, found "${actualStr.slice(0, 60)}" (${aNum})`;
        break;
      }

      case 'not_empty':
        passed = actualStr.length > 0;
        reason = passed ? `Has value ("${actualStr.slice(0, 40)}")` : 'Expected non-empty value, but was empty';
        break;

      case 'is_empty':
        passed = actualStr.length === 0;
        reason = passed ? 'Value is empty' : `Expected empty value, found "${actualStr.slice(0, 40)}"`;
        break;

      case 'element_exists':
        passed = actualValue === true || normActual === 'true' || normActual === '1' || normActual === 'exists';
        reason = passed ? 'Element exists on page' : 'Element does NOT exist on page';
        break;

      case 'element_not_exists':
        passed = actualValue === false || normActual === 'false' || normActual === '0' || normActual === '';
        reason = passed ? 'Element does not exist on page' : 'Element exists on page (expected not to exist)';
        break;

      case 'regex': {
        try {
          const rx = new RegExp(expectedStr, caseSensitive ? '' : 'i');
          passed = rx.test(actualStr);
          reason = passed ? `Matches regex /${expectedStr}/` : `Did not match regex /${expectedStr}/`;
        } catch (err) {
          passed = false;
          reason = `Invalid regex "${expectedStr}": ${err.message}`;
        }
        break;
      }

      default:
        passed = normActual.includes(normExpected);
        reason = passed ? 'Condition matched' : 'Condition did not match';
    }

    return { passed, reason, actualValue: actualStr };
  }

  globalScope.FlowTagCSV = {
    parseCSV,
    objectsToCSV,
    escapeCSVCell,
    interpolateValue,
    evaluateVerification,
    evaluateMathOrDateExpression,
    parseDateWithFormat,
    formatDateLike,
    addCalendarDays,
    addBusinessDays
  };
})(typeof self !== 'undefined' ? self : window);
