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
   * Resolves template variables inside a string like:
   *   "https://example.com/search?q={{query}}&page={{step.page}}&ref={{prev.step_2}}"
   * Supports:
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
    const str = String(template);
    const {
      masterRow = {},
      stepRow = {},
      masterRowIndex = 0,
      stepRowIndex = 0,
      extractedVars = {}
    } = context;

    return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr) => {
      const key = expr.trim();
      if (key === 'row_index') return String(masterRowIndex + 1);
      if (key === 'step_row_index') return String(stepRowIndex + 1);

      if (key.startsWith('prev.')) {
        const prevKey = key.slice(5); // e.g. 'step_1' or 'step_2'
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

      // Check stepRow first if present, then masterRow, then extractedVars
      if (stepRow && stepRow[key] !== undefined) {
        return String(stepRow[key]);
      }
      if (masterRow && masterRow[key] !== undefined) {
        return String(masterRow[key]);
      }
      if (extractedVars && extractedVars[key] !== undefined) {
        return String(extractedVars[key]);
      }
      return match; // leave unchanged if not found
    });
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
    evaluateVerification
  };
})(typeof self !== 'undefined' ? self : window);
