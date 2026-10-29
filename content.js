/**
 * Domuto | Visual Browser Automation - Content Script (Visual Builder HUD + DOM Execution Engine)
 * Uses Shadow DOM isolation so styles never collide with the host webpage.
 * Authored by Subrata Dey
 */
(function () {
  if (window.__FLOWTAG_CONTENT_LOADED__) return;
  window.__FLOWTAG_CONTENT_LOADED__ = true;

  let builderSession = { active: false, projectId: null, tabId: null, pickMode: false };
  let activeProject = null;
  let runnerState = null;

  // UI state inside Shadow DOM
  let shadowRoot = null;
  let hostEl = null;
  let hudMinimized = false;
  let hoveredElement = null;
  let editingStepDraft = null; // non-null when adding/editing a step in HUD
  let pickingBranchTarget = null; // null | 'if' | 'then' | 'else' when picking an element for a branch inside editingStepDraft
  let showHudRunLauncher = false;
  let hudRuntimeCsv = null;

  // Dragging state for HUD
  let hudPos = { right: 20, bottom: 20, top: null, left: null };

  // Listen to messages from background / popup / dashboard
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'PING_CONTENT':
        sendResponse({ ok: true });
        return false;

      case 'BUILDER_SYNC_STATE':
        builderSession = message.session || { active: false };
        activeProject = message.project || null;
        if (builderSession.active && activeProject) {
          ensureShadowHud();
          setPickMode(Boolean(builderSession.pickMode));
          renderHud();
        } else {
          setPickMode(false);
          renderHud();
        }
        sendResponse({ ok: true });
        return false;

      case 'BUILDER_CLOSE_HUD':
        builderSession = { active: false, projectId: null, tabId: null, pickMode: false };
        editingStepDraft = null;
        setPickMode(false);
        renderHud();
        sendResponse({ ok: true });
        return false;

      case 'RUNNER_SYNC_STATE':
        runnerState = message.state || null;
        ensureShadowHud();
        renderHud();
        sendResponse({ ok: true });
        return false;

      case 'HIGHLIGHT_SELECTOR_PREVIEW': {
        const count = highlightSelectorOnPage(message.selector);
        sendResponse({ ok: true, count });
        return false;
      }

      case 'EXECUTE_DOM_STEP': {
        executeDomStep(message.step)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
        return true; // async
      }

      default:
        return false;
    }
  });

  // Check on initial page load if this tab is already an active Builder or Runner tab
  chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    const myTabId = res.senderTabId;
    if (res.builderSession && res.builderSession.active && res.builderSession.tabId === myTabId) {
      builderSession = res.builderSession;
      activeProject = (res.projects || []).find((p) => p.id === builderSession.projectId) || null;
      if (activeProject) {
        ensureShadowHud();
        setPickMode(Boolean(builderSession.pickMode));
        renderHud();
      }
    }
    if (res.runnerState && res.runnerState.tabId === myTabId && ['running', 'paused'].includes(res.runnerState.status)) {
      runnerState = res.runnerState;
      ensureShadowHud();
      renderHud();
    }
  });

  // ============================================================================
  // SMART CSS SELECTOR GENERATOR & ELEMENT PICKER
  // ============================================================================

  function setPickMode(enabled) {
    builderSession.pickMode = enabled;
    if (enabled) {
      document.addEventListener('mousemove', onPickerMouseMove, true);
      document.addEventListener('click', onPickerClick, true);
      document.addEventListener('mousedown', onPickerBlockEvent, true);
      document.addEventListener('mouseup', onPickerBlockEvent, true);
      document.addEventListener('keydown', onPickerKeyDown, true);
    } else {
      document.removeEventListener('mousemove', onPickerMouseMove, true);
      document.removeEventListener('click', onPickerClick, true);
      document.removeEventListener('mousedown', onPickerBlockEvent, true);
      document.removeEventListener('mouseup', onPickerBlockEvent, true);
      document.removeEventListener('keydown', onPickerKeyDown, true);
      hoveredElement = null;
      hideHoverBox();
    }
  }

  function isEventInsideHud(e) {
    if (!hostEl) return false;
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(hostEl);
  }

  function onPickerMouseMove(e) {
    if (!builderSession.pickMode) return;
    if (isEventInsideHud(e)) {
      hideHoverBox();
      return;
    }
    const el = e.target;
    if (!el || el === document.documentElement || el === document.body) {
      hideHoverBox();
      return;
    }
    hoveredElement = el;
    drawHoverBox(el);
  }

  function onPickerBlockEvent(e) {
    if (!builderSession.pickMode || isEventInsideHud(e)) return;
    e.stopPropagation();
  }

  function onPickerKeyDown(e) {
    if (e.key === 'Escape' && builderSession.pickMode) {
      e.preventDefault();
      e.stopPropagation();
      setPickMode(false);
      chrome.runtime.sendMessage({
        type: 'UPDATE_BUILDER_SESSION',
        updates: { pickMode: false }
      });
      renderHud();
    }
  }

  function getSelectOptionsFromSelector(selector) {
    if (!selector) return [];
    try {
      const el = document.querySelector(selector);
      if (!el || el.tagName !== 'SELECT') return [];
      return Array.from(el.options || []).map((opt) => ({
        value: opt.value ?? '',
        text: (opt.text || opt.label || opt.value || '').trim()
      }));
    } catch (_) {
      return [];
    }
  }

  function onPickerClick(e) {
    if (!builderSession.pickMode || isEventInsideHud(e)) return;

    const rawEl = e.target;
    if (!rawEl) return;

    const selectEl = rawEl.tagName === 'SELECT' ? rawEl : rawEl.closest('select');
    const el = selectEl || rawEl;

    // If the user clicked a <select> dropdown, do NOT preventDefault so the native dropdown can still open,
    // and attach a listener so if they change the dropdown option on the page, it updates the HUD value live!
    if (!selectEl) {
      e.preventDefault();
    }
    e.stopPropagation();

    // Turn off pick mode once element is chosen
    setPickMode(false);
    chrome.runtime.sendMessage({
      type: 'UPDATE_BUILDER_SESSION',
      updates: { pickMode: false }
    });

    const analysis = analyzeAndGenerateSelectors(el);
    const selector = analysis.primarySelector;
    const suggestedType = suggestStepTypeForElement(el);
    const labelSnippet = getElementReadableLabel(el);

    // Get current dropdown value if it's a <select> or <option>
    let pickedDropdownVal = '';
    if (rawEl.tagName === 'OPTION') {
      pickedDropdownVal = rawEl.value || (rawEl.text || '').trim();
    } else if (selectEl) {
      const selOpt = selectEl.options?.[selectEl.selectedIndex];
      pickedDropdownVal = selectEl.value || (selOpt ? (selOpt.text || '').trim() : '');
    }

    // If the user clicked "🎯 Pick" for a specific branch (IF / THEN / ELSE) inside an open draft,
    // populate that branch's selector (and dropdown value if it's a <select>) instead of replacing the entire draft!
    if (editingStepDraft && pickingBranchTarget) {
      const targetBranch = pickingBranchTarget;
      editingStepDraft.options = editingStepDraft.options || {};
      if (targetBranch === 'if') {
        editingStepDraft.selector = selector;
        editingStepDraft.options.validationReport = analysis.validationReport;
        editingStepDraft.options.selectorStrategies = analysis.strategies;
        editingStepDraft.options.fallbackSelectors = analysis.fallbackSelectors;
      } else if (targetBranch === 'then' || targetBranch === 'else') {
        const prop = targetBranch === 'then' ? 'thenBranch' : 'elseBranch';
        editingStepDraft.options[prop] = editingStepDraft.options[prop] || { mode: 'click', selector: '', value: '' };
        editingStepDraft.options[prop].selector = selector;
        if (selectEl) {
          editingStepDraft.options[prop].mode = 'select';
          if (pickedDropdownVal) {
            editingStepDraft.options[prop].value = pickedDropdownVal;
          }
          // Also listen for the user picking an option on the page's <select> right after clicking it!
          const onLiveSelectChange = () => {
            if (editingStepDraft && editingStepDraft.options && editingStepDraft.options[prop]) {
              const chosenOpt = selectEl.options?.[selectEl.selectedIndex];
              editingStepDraft.options[prop].value =
                selectEl.value !== '' ? selectEl.value : (chosenOpt ? (chosenOpt.text || '').trim() : '');
              renderHud();
            }
          };
          selectEl.addEventListener('change', onLiveSelectChange, { once: true });
        }
      }
      pickingBranchTarget = null;
      flashElement(el, '#10b981');
      renderHud();
      return;
    }

    editingStepDraft = {
      isNew: true,
      id: 'step_' + Date.now(),
      name: `${formatActionVerb(suggestedType)} ${labelSnippet}`.trim(),
      type: suggestedType,
      selector: selector,
      value: suggestedType === 'extract' ? '' : (pickedDropdownVal || getDefaultValueForElement(el, suggestedType)),
      options: {
        clearFirst: true,
        pressEnter: false,
        waitAfterMs: 800,
        extractTarget: el.tagName === 'A' ? 'href' : 'text',
        customAttr: '',
        outputColumn: sanitizeColumnName(labelSnippet || 'Extracted_Value'),
        verifyCondition: 'contains',
        onVerifyFail: 'skip_row',
        caseSensitive: false,
        ifSource: 'dom_element',
        ifLeftValue: '',
        thenBranch: { mode: 'input', selector: selector, value: '', targetStepNumber: '', pressEnter: false },
        elseBranch: { mode: 'continue', selector: '', value: '', targetStepNumber: '', pressEnter: false },
        waitMode: 'time',
        scrollMode: 'element',
        pixels: 500,
        rowAnchorText: analysis.suggestedRowAnchor || '',
        selectorStrategy: analysis.primaryStrategy,
        selectorStrategies: analysis.strategies,
        fallbackSelectors: analysis.fallbackSelectors,
        validationReport: analysis.validationReport
      },
      stepCsv: {
        enabled: false,
        mode: 'sequence_row',
        fileName: '',
        headers: [],
        rows: [],
        columnName: ''
      }
    };

    if (selectEl) {
      const onMainSelectChange = () => {
        if (editingStepDraft && editingStepDraft.selector === selector) {
          const chosenOpt = selectEl.options?.[selectEl.selectedIndex];
          editingStepDraft.value =
            selectEl.value !== '' ? selectEl.value : (chosenOpt ? (chosenOpt.text || '').trim() : '');
          renderHud();
        }
      };
      selectEl.addEventListener('change', onMainSelectChange, { once: true });
    }

    flashElement(el, '#10b981');
    renderHud();
  }

  function suggestStepTypeForElement(el) {
    const tag = (el.tagName || '').toUpperCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'input';
    if (tag === 'INPUT') {
      if (['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type)) return 'click';
      return 'input';
    }
    if (tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button' || el.onclick) {
      return 'click';
    }
    // Check if parent is a button or anchor
    if (el.closest('button, a, [role="button"]')) {
      return 'click';
    }
    return 'extract';
  }

  function formatActionVerb(type) {
    const map = {
      click: 'Click',
      input: 'Type into',
      extract: 'Extract',
      verify: 'Check',
      condition: 'IF / ELSE on',
      select: 'Select',
      wait: 'Wait for',
      scroll: 'Scroll to',
      keypress: 'Press Key on',
      navigate: 'Go to'
    };
    return map[type] || 'Interact with';
  }

  function getElementReadableLabel(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title');
    if (aria) return `"${aria.trim().slice(0, 28)}"`;
    const text = (el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g, ' ');
    if (text) return `"${text.slice(0, 28)}"`;
    return `<${el.tagName.toLowerCase()}>`;
  }

  function sanitizeColumnName(str) {
    const cleaned = str.replace(/["'<>]/g, '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'Extracted_Data';
  }

  function getDefaultValueForElement(el, type) {
    if (type === 'select' && el.options && el.options.length > 0) {
      return el.value || el.options[0].value || '';
    }
    return '';
  }

  function escapeAttrVal(val) {
    return String(val ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Tests a CSS selector against the live DOM (and optional row container) to validate
   * how many elements it matches and whether `targetEl` (if provided) is matched.
   */
  function validateSelectorClaim(selector, targetEl = null, rowAnchorText = '') {
    if (!selector) {
      return { validSyntax: false, matchCount: 0, matchesTarget: false, isUnique: false };
    }
    try {
      let root = document;
      if (rowAnchorText && String(rowAnchorText).trim() && !String(rowAnchorText).includes('{{')) {
        const scopedRow = findRowContainerByAnchorText(String(rowAnchorText).trim());
        if (scopedRow) root = scopedRow;
      }
      const nodeList = root.querySelectorAll(selector);
      const matches = Array.from(nodeList);
      const matchCount = matches.length;
      const matchesTarget = targetEl ? matches.includes(targetEl) : matchCount > 0;
      const isUnique = targetEl ? matchCount === 1 && matches[0] === targetEl : matchCount === 1;
      return {
        validSyntax: true,
        matchCount,
        matchesTarget,
        isUnique
      };
    } catch (_) {
      return { validSyntax: false, matchCount: 0, matchesTarget: false, isUnique: false };
    }
  }

  /**
   * Detects whether an attribute value (like `order(3803967494).box(1).item(3905178636).cancelled`)
   * contains dynamic/ephemeral IDs (long digit sequences, parameterized IDs, URL-embedded numbers,
   * or sibling-divergent numbers) and builds wildcard + suffix CSS selectors.
   */
  function buildWildcardCandidatesForAttribute(tag, attrName, attrVal) {
    if (!attrVal || typeof attrVal !== 'string') return null;

    // 1. Check for parameterized or long numeric / hex segments:
    //    e.g. order(3803967494).box(1).item(3905178636).cancelled
    //    or items[3905178636].qty or field_3803967494_cancelled
    const hasLongNumber = /\d{4,}/.test(attrVal);
    const hasParameterizedIndex = /\(\d+\)|\[\d+\]/.test(attrVal);
    const hasHexToken = /[0-9a-f]{8,}/i.test(attrVal);

    // Also check if any 3+ digit number in attrVal appears in the current page URL
    const urlNumbers = (window.location.href.match(/\d{3,}/g) || []);
    const hasUrlMatchingNumber = urlNumbers.some((num) => attrVal.includes(num));

    // Also check if sibling/peer elements on the page share a prefix/suffix with different numbers
    const normalizedPattern = attrVal.replace(/\d+/g, '#');
    let peerDivergentCount = 0;
    if (/\d/.test(attrVal)) {
      try {
        const sameTagEls = document.querySelectorAll(tag);
        for (const peer of sameTagEls) {
          if (peer === document) continue;
          const peerVal = peer.getAttribute(attrName);
          if (peerVal && peerVal !== attrVal && peerVal.replace(/\d+/g, '#') === normalizedPattern) {
            peerDivergentCount++;
          }
        }
      } catch (_) {}
    }

    const isDynamic =
      hasLongNumber ||
      hasParameterizedIndex ||
      hasHexToken ||
      hasUrlMatchingNumber ||
      peerDivergentCount > 0;

    if (!isDynamic) return null;

    // Split attribute by dynamic numeric/hex tokens while keeping static structural tokens
    // For example: "order(3803967494).box(1).item(3905178636).cancelled"
    // Dynamic tokens: 3803967494, 1 (inside parens if peer varies, or keep/strip), 3905178636
    // Static tokens when splitting on \d{3,}|(?<=\(|\[)\d+(?=\)|\])|[0-9a-f]{8,}:
    const staticParts = attrVal
      .split(/\d{3,}|\(\d+\)|\[\d+\]|[0-9a-f]{8,}/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Also build a finer split that preserves `(` and `)` around dynamic numbers:
    // e.g. "order(3803967494).box(1).item(3905178636).cancelled"
    // -> ["order(", ").box(", ").item(", ").cancelled"]
    const fineParts = attrVal
      .split(/\d{4,}|(?<=\(|\[)\d+(?=\)|\])|[0-9a-f]{8,}/i)
      .filter((s) => s.length > 0);

    const candidates = [];

    // Strategy A: Full structural wildcard chain using ^= (starts with), *= (contains), $= (ends with)
    if (fineParts.length >= 2) {
      const prefix = fineParts[0];
      const suffix = fineParts[fineParts.length - 1];
      const middles = fineParts.slice(1, -1).filter((m) => m.length >= 2);

      let wildcardSel = `${tag}[${attrName}^="${escapeAttrVal(prefix)}"]`;
      for (const mid of middles.slice(0, 2)) {
        wildcardSel += `[${attrName}*="${escapeAttrVal(mid)}"]`;
      }
      if (suffix && suffix !== prefix) {
        wildcardSel += `[${attrName}$="${escapeAttrVal(suffix)}"]`;
      }
      candidates.push({
        strategy: 'wildcard',
        label: 'Wildcard Pattern',
        selector: wildcardSel,
        reason: `Dynamic IDs stripped (${attrName} pattern)`
      });
    }

    // Strategy B: Clean Suffix Match (e.g., input[name$=".cancelled"] or input[name$=").cancelled"])
    const dotSuffixMatch = attrVal.match(/(\.[a-zA-Z_][a-zA-Z0-9_-]*)$/);
    const parenDotSuffixMatch = attrVal.match(/([)\]]\.[a-zA-Z_][a-zA-Z0-9_-]*)$/);
    const suffixToken = parenDotSuffixMatch
      ? parenDotSuffixMatch[1]
      : dotSuffixMatch
      ? dotSuffixMatch[1]
      : staticParts.length > 0
      ? staticParts[staticParts.length - 1]
      : '';

    if (suffixToken && suffixToken.length >= 2 && suffixToken !== attrVal) {
      candidates.push({
        strategy: 'suffix',
        label: `Ends With "${suffixToken}"`,
        selector: `${tag}[${attrName}$="${escapeAttrVal(suffixToken)}"]`,
        reason: `Matches field ending in "${suffixToken}"`
      });
    }

    return {
      isDynamic: true,
      attrName,
      attrVal,
      suffixToken,
      candidates
    };
  }

  /**
   * Self-Validating Selector Engine:
   * 1. Inspects `el` for dynamic attributes (`name`, `id`, `onkeyup`, `onchange`) vs static attributes.
   * 2. Generates ranked candidate selectors (Wildcard, Suffix, Table Column + Suffix, Standard, Exact).
   * 3. Validates every candidate against the live DOM (`document.querySelectorAll`) to prove its claim.
   * 4. Detects if a wildcard matches multiple rows (`matchCount > 1`) and checks if a CSV column from the
   *    project appears in the clicked `<tr>` row so it can suggest automatic Row Anchor Scoping.
   */
  function analyzeAndGenerateSelectors(el) {
    if (!el || el.nodeType !== 1) {
      return {
        primarySelector: '',
        primaryStrategy: 'standard',
        strategies: [],
        fallbackSelectors: [],
        suggestedRowAnchor: '',
        validationReport: null
      };
    }

    const interactiveAncestor = el.closest('button, a, input, select, textarea, [role="button"]');
    if (
      interactiveAncestor &&
      ['SVG', 'PATH', 'I', 'SPAN'].includes(el.tagName.toUpperCase()) &&
      interactiveAncestor.contains(el)
    ) {
      el = interactiveAncestor;
    }

    const tag = el.tagName.toLowerCase();
    const rawCandidates = [];
    let detectedDynamicAttr = null;

    // 1. Check `name` and `id` for embedded dynamic Order/Box/Item IDs
    for (const attrName of ['name', 'id']) {
      const val = el.getAttribute(attrName);
      if (!val) continue;
      const dynInfo = buildWildcardCandidatesForAttribute(tag, attrName, val);
      if (dynInfo && dynInfo.isDynamic) {
        if (!detectedDynamicAttr) detectedDynamicAttr = dynInfo;
        for (const c of dynInfo.candidates) {
          rawCandidates.push(c);
        }
      }
    }

    // 2. If inside a table cell (`<td>`), also generate a Table Column + Suffix/Tag strategy
    const parentTd = el.closest('td, th');
    const parentTr = el.closest('tr, [role="row"]');
    if (parentTd && parentTr) {
      const cells = Array.from(parentTr.children).filter((c) => c.tagName === parentTd.tagName);
      const colIdx = cells.indexOf(parentTd) + 1;
      if (colIdx > 0) {
        const suffixPart =
          detectedDynamicAttr && detectedDynamicAttr.suffixToken
            ? `[${detectedDynamicAttr.attrName}$="${escapeAttrVal(detectedDynamicAttr.suffixToken)}"]`
            : '';
        const tableColSel = `tr td:nth-of-type(${colIdx}) ${tag}${suffixPart}`;
        rawCandidates.push({
          strategy: 'table_col',
          label: `Table Col #${colIdx}`,
          selector: tableColSel,
          reason: `Table column ${colIdx} ${suffixPart || tag}`
        });
      }
    }

    // 3. Standard semantic selector (ignoring dynamic numeric IDs/names)
    const standardSel = generateStandardSelector(el, Boolean(detectedDynamicAttr));
    if (standardSel) {
      rawCandidates.push({
        strategy: 'standard',
        label: 'Standard CSS',
        selector: standardSel,
        reason: 'Standard structural/attribute selector'
      });
    }

    // 4. Exact attribute selector (for reference / fallback if same order page is revisited)
    const exactName = el.getAttribute('name');
    const exactId = el.getAttribute('id');
    if (exactName) {
      rawCandidates.push({
        strategy: 'exact',
        label: 'Exact Name (Hardcoded ID)',
        selector: `${tag}[name="${escapeAttrVal(exactName)}"]`,
        reason: 'Contains page-specific ID numbers'
      });
    } else if (exactId) {
      rawCandidates.push({
        strategy: 'exact',
        label: 'Exact ID (Hardcoded ID)',
        selector: `[id="${escapeAttrVal(exactId)}"]`,
        reason: 'Contains page-specific ID numbers'
      });
    }

    // Deduplicate and self-validate every candidate against the live DOM!
    const seenSelectors = new Set();
    const validatedStrategies = [];

    for (const cand of rawCandidates) {
      if (!cand.selector || seenSelectors.has(cand.selector)) continue;
      seenSelectors.add(cand.selector);
      const check = validateSelectorClaim(cand.selector, el);
      if (check.validSyntax && check.matchesTarget) {
        validatedStrategies.push({
          strategy: cand.strategy,
          label: cand.label,
          selector: cand.selector,
          reason: cand.reason,
          matchCount: check.matchCount,
          isUnique: check.isUnique
        });
      }
    }

    // Determine primary selector & build self-validation report
    let chosen = validatedStrategies[0] || {
      strategy: 'standard',
      label: 'Standard CSS',
      selector: standardSel || tag,
      matchCount: 1,
      isUnique: true
    };

    // If a wildcard or suffix strategy uniquely matches (1 match on page), always prefer it!
    const uniqueWildcard = validatedStrategies.find(
      (s) => (s.strategy === 'wildcard' || s.strategy === 'suffix') && s.isUnique
    );
    const anyWildcard = validatedStrategies.find(
      (s) => s.strategy === 'wildcard' || s.strategy === 'suffix'
    );

    if (uniqueWildcard) {
      chosen = uniqueWildcard;
    } else if (anyWildcard && detectedDynamicAttr) {
      // Even if there are multiple items/rows on the page (e.g. 3 items in an order table),
      // the wildcard selector is still much safer than a hardcoded order(3803967494) ID!
      chosen = anyWildcard;
    } else {
      const firstUnique = validatedStrategies.find((s) => s.isUnique && s.strategy !== 'exact');
      if (firstUnique) chosen = firstUnique;
    }

    // Check if the element is inside a table row and if any CSV column from the project matches text in this row
    let suggestedRowAnchor = '';
    if (parentTr && chosen.matchCount > 1) {
      const rowText = (parentTr.innerText || parentTr.textContent || '').trim();
      const existingCsv = findExistingProjectCsv();
      if (existingCsv && Array.isArray(existingCsv.rows) && existingCsv.rows.length > 0) {
        const firstRow = existingCsv.rows[0] || {};
        for (const [colName, colVal] of Object.entries(firstRow)) {
          const cleanVal = String(colVal || '').trim();
          if (cleanVal.length >= 2 && rowText.includes(cleanVal)) {
            suggestedRowAnchor = `{{${colName}}}`;
            break;
          }
        }
      }
    }

    let validationReport = null;
    if (detectedDynamicAttr) {
      if (chosen.isUnique) {
        validationReport = {
          status: 'verified_unique',
          badgeText: `✓ Wildcard Self-Validated (1 exact match)`,
          detail: `Detected dynamic IDs in ${detectedDynamicAttr.attrName}="${detectedDynamicAttr.attrVal.slice(0, 42)}${detectedDynamicAttr.attrVal.length > 42 ? '...' : ''}". Stripped dynamic numbers and verified selector uniquely finds this element on the page.`
        };
      } else {
        validationReport = {
          status: 'verified_multirow',
          badgeText: `⚠ Wildcard Validated (${chosen.matchCount} rows match on page)`,
          detail: `Dynamic IDs stripped so this works on every order. Because this page has ${chosen.matchCount} matching row items, you can optionally scope to a row containing a CSV value (like {{SKU}} or {{Line Number}}) below.`
        };
      }
    } else if (chosen.isUnique) {
      validationReport = {
        status: 'verified_static',
        badgeText: `✓ Selector Validated (1 exact match)`,
        detail: `Verified unique match on the live DOM.`
      };
    } else {
      validationReport = {
        status: 'multi_static',
        badgeText: `ℹ Matches ${chosen.matchCount} elements on page`,
        detail: `Will target the first matching element (or scope to a row container below).`
      };
    }

    const fallbackSelectors = validatedStrategies
      .map((s) => s.selector)
      .filter((sel) => sel !== chosen.selector);

    return {
      primarySelector: chosen.selector,
      primaryStrategy: chosen.strategy,
      strategies: validatedStrategies,
      fallbackSelectors,
      suggestedRowAnchor,
      validationReport
    };
  }

  /**
   * Generates a concise CSS selector for static elements, or structural fallback when `skipDynamicAttrs` is true.
   */
  function generateSmartSelector(el) {
    return analyzeAndGenerateSelectors(el).primarySelector;
  }

  function generateStandardSelector(el, skipDynamicAttrs = false) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();

    // 1. Check unique ID (skip dynamic numeric IDs or parameterized IDs)
    if (
      el.id &&
      !/^\d+$/.test(el.id) &&
      !/\d{4,}/.test(el.id) &&
      !/\(\d+\)/.test(el.id) &&
      !/[0-9a-f]{8,}/i.test(el.id)
    ) {
      const idSel = `#${CSS.escape(el.id)}`;
      if (isUniqueSelector(idSel, el)) return idSel;
    }

    // 2. Check high-stability attributes
    const priorityAttrs = [
      'data-testid',
      'data-test',
      'data-qa',
      'data-cy',
      'name',
      'aria-label',
      'placeholder',
      'title',
      'alt'
    ];

    for (const attr of priorityAttrs) {
      const val = el.getAttribute(attr);
      if (!val || !val.trim() || val.length >= 90) continue;
      if (skipDynamicAttrs && (/\d{4,}/.test(val) || /\(\d+\)/.test(val))) continue;
      const attrSel = `${tag}[${attr}="${escapeAttrVal(val)}"]`;
      if (isUniqueSelector(attrSel, el)) return attrSel;
    }

    // 3. For links, check href if relatively clean
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && href.length > 1 && href.length < 100 && !href.startsWith('javascript:') && !/\d{5,}/.test(href)) {
        const hrefSel = `a[href="${escapeAttrVal(href)}"]`;
        if (isUniqueSelector(hrefSel, el)) return hrefSel;
      }
    }

    // 4. Meaningful classes on the element itself
    const validClasses = Array.from(el.classList || []).filter(
      (c) => c.length > 1 && !/^(active|hover|focus|selected|open|disabled|ng-|css-|sc-|tw-|\d)/.test(c)
    );
    if (validClasses.length > 0) {
      const classCombo = `${tag}.${validClasses.slice(0, 3).map((c) => CSS.escape(c)).join('.')}`;
      if (isUniqueSelector(classCombo, el)) return classCombo;
    }

    // 5. Build short hierarchical path up to 4 levels or until a clean #id ancestor is reached
    const pathParts = [];
    let current = el;
    let depth = 0;

    while (current && current.nodeType === 1 && current !== document.body && depth < 5) {
      let part = current.tagName.toLowerCase();

      if (current.id && !/^\d+$/.test(current.id) && !/\d{4,}/.test(current.id) && !/\(\d+\)/.test(current.id)) {
        part = `#${CSS.escape(current.id)}`;
        pathParts.unshift(part);
        break;
      }

      const nameAttr = current.getAttribute('name');
      if (nameAttr && !/\d{4,}/.test(nameAttr) && !/\(\d+\)/.test(nameAttr)) {
        part += `[name="${escapeAttrVal(nameAttr)}"]`;
      } else {
        const parent = current.parentElement;
        if (parent) {
          const siblingsSameTag = Array.from(parent.children).filter(
            (child) => child.tagName === current.tagName
          );
          if (siblingsSameTag.length > 1) {
            const idx = siblingsSameTag.indexOf(current) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
      }

      pathParts.unshift(part);
      const candidate = pathParts.join(' > ');
      if (isUniqueSelector(candidate, el)) {
        return candidate;
      }

      current = current.parentElement;
      depth++;
    }

    return pathParts.join(' > ');
  }

  /**
   * Given any selector (including a previously saved exact selector like
   * `input[name="order(3803967494).box(1).item(3905178636).cancelled"]` or `#order\(3803967494\)...`),
   * automatically derives wildcard & suffix fallback selectors at runtime!
   */
  function deriveRuntimeWildcardFallbacks(selector) {
    if (!selector || typeof selector !== 'string') return [];
    const fallbacks = [];

    // 1. Check if selector is an attribute selector like tag[attr="..."] or [attr="..."]
    const attrMatch = selector.match(/^([a-zA-Z0-9_-]*)\[(name|id)=["'](.+)["']\]$/);
    if (attrMatch) {
      const tag = attrMatch[1] || '*';
      const attrName = attrMatch[2];
      // Unescape CSS.escape backslashes (e.g. \( -> (, \. -> .)
      const rawVal = attrMatch[3].replace(/\\([().[\]:])/g, '$1');
      const dyn = buildWildcardCandidatesForAttribute(tag === '*' ? 'input' : tag, attrName, rawVal);
      if (dyn && dyn.candidates) {
        dyn.candidates.forEach((c) => fallbacks.push(c.selector));
      }
    }

    // 2. Check if selector is an #id selector with escaped parens/dots and long numbers
    if (selector.startsWith('#') && /\d{4,}/.test(selector)) {
      const rawId = selector.slice(1).replace(/\\(.)/g, '$1');
      const dynId = buildWildcardCandidatesForAttribute('*', 'id', rawId);
      if (dynId && dynId.candidates) {
        dynId.candidates.forEach((c) => fallbacks.push(c.selector.replace(/^\*/, '')));
      }
      const dynName = buildWildcardCandidatesForAttribute('*', 'name', rawId);
      if (dynName && dynName.candidates) {
        dynName.candidates.forEach((c) => fallbacks.push(c.selector.replace(/^\*/, '')));
      }
    }

    return fallbacks;
  }

  function findRowContainerByAnchorText(anchorText) {
    if (!anchorText) return null;
    const needle = String(anchorText).trim().toLowerCase();
    if (!needle) return null;

    // Search table rows first (`tr`), then ARIA rows / list items / cards
    const rowContainers = document.querySelectorAll('tr, [role="row"], li, .row, .item-row');
    let bestMatch = null;
    let smallestLength = Infinity;

    for (const row of rowContainers) {
      const text = (row.innerText || row.textContent || '').trim().toLowerCase();
      if (text.includes(needle) && text.length < smallestLength) {
        bestMatch = row;
        smallestLength = text.length;
      }
    }
    return bestMatch;
  }

  function isUniqueSelector(selector, targetEl) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === targetEl;
    } catch (_) {
      return false;
    }
  }

  function highlightSelectorOnPage(selector, rowAnchorText = '') {
    if (!selector) return 0;
    try {
      let root = document;
      if (rowAnchorText && String(rowAnchorText).trim() && !String(rowAnchorText).includes('{{')) {
        const row = findRowContainerByAnchorText(String(rowAnchorText).trim());
        if (row) {
          root = row;
          flashElement(row, '#f59e0b');
        }
      }
      const els = root.querySelectorAll(selector);
      els.forEach((el, idx) => {
        if (idx === 0) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        flashElement(el, '#3b82f6');
      });
      return els.length;
    } catch (_) {
      return 0;
    }
  }

  function flashElement(el, color = '#10b981') {
    if (!el || !el.getBoundingClientRect) return;
    const prevTransition = el.style.transition;
    const prevOutline = el.style.outline;
    const prevOutlineOffset = el.style.outlineOffset;

    el.style.transition = 'outline 0.15s ease';
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';

    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOutlineOffset;
      el.style.transition = prevTransition;
    }, 1400);
  }

  // ============================================================================
  // DOM STEP EXECUTION ENGINE (Runs individual steps on the live DOM)
  // ============================================================================

  async function executeDomStep(step) {
    const type = step.type;
    const selector = step.resolvedSelector !== undefined ? step.resolvedSelector : step.selector;
    const value = step.resolvedValue !== undefined ? step.resolvedValue : step.value;
    const options = step.options || {};
    const rowAnchor =
      step.resolvedRowAnchor !== undefined ? step.resolvedRowAnchor : options.rowAnchorText || '';
    const timeoutMs = Number(options.timeoutMs) || 8000;

    if (type === 'scroll' && options.scrollMode !== 'element') {
      if (options.scrollMode === 'bottom') {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      } else {
        const px = Number(value || options.pixels) || 500;
        window.scrollBy({ top: px, behavior: 'smooth' });
      }
      return { ok: true };
    }

    if (type === 'wait' && options.waitMode !== 'element') {
      const sec = parseFloat(value) || 2;
      await new Promise((r) => setTimeout(r, sec * 1000));
      return { ok: true };
    }

    if (type === 'condition_check' || type === 'condition') {
      const ifSource = options.ifSource || (selector ? 'dom_element' : 'csv_or_var');
      const conditionOp = options.verifyCondition || 'equals';
      let evalRes;

      if (ifSource === 'csv_or_var') {
        const leftVal = step.resolvedLeftValue !== undefined ? step.resolvedLeftValue : (options.ifLeftValue || '');
        evalRes = window.FlowTagCSV.evaluateVerification(
          leftVal,
          conditionOp,
          value,
          Boolean(options.caseSensitive)
        );
      } else {
        const checkTimeout = ['element_exists', 'element_not_exists'].includes(conditionOp) ? 1500 : 2500;
        const lookupCond = await waitForElementSmart(
          selector,
          options.fallbackSelectors || [],
          rowAnchor,
          checkTimeout
        );
        const condEl = lookupCond.element;
        if (['element_exists', 'element_not_exists'].includes(conditionOp)) {
          evalRes = window.FlowTagCSV.evaluateVerification(
            Boolean(condEl),
            conditionOp,
            value,
            Boolean(options.caseSensitive)
          );
        } else if (!condEl) {
          evalRes = window.FlowTagCSV.evaluateVerification(
            '',
            conditionOp,
            value,
            Boolean(options.caseSensitive)
          );
        } else {
          const target = options.extractTarget || 'text';
          const actualContent = readElementContentByTarget(condEl, target, options.customAttr);
          evalRes = window.FlowTagCSV.evaluateVerification(
            actualContent,
            conditionOp,
            value,
            Boolean(options.caseSensitive)
          );
          flashElement(condEl, evalRes.passed ? '#10b981' : '#f59e0b');
        }
      }

      if (type === 'condition_check') {
        return {
          ok: true,
          verifyPassed: evalRes.passed,
          verifyReason: evalRes.reason,
          actualValue: evalRes.actualValue,
          stepOutput: evalRes.actualValue
        };
      }

      // If type === 'condition' (e.g. executed immediately via "⚡ Save & Execute Now" in HUD)
      const branch = evalRes.passed
        ? options.thenBranch || { mode: 'continue' }
        : options.elseBranch || { mode: 'continue' };
      const bMode = branch.mode || 'continue';
      if (['click', 'input', 'select', 'extract'].includes(bMode)) {
        const bSel = branch.resolvedSelector || branch.selector || selector;
        const bVal = branch.resolvedValue !== undefined ? branch.resolvedValue : (branch.value || '');
        return executeDomStep({
          id: `${step.id}_branch`,
          type: bMode,
          selector: bSel,
          resolvedSelector: bSel,
          value: bVal,
          resolvedValue: bVal,
          resolvedRowAnchor: rowAnchor,
          options: {
            clearFirst: true,
            pressEnter: Boolean(branch.pressEnter),
            extractTarget: branch.extractTarget || 'text',
            outputColumn: branch.outputColumn || 'Branch_Output'
          }
        });
      } else if (bMode === 'navigate' && branch.value) {
        const bUrl = branch.resolvedValue || branch.value;
        window.location.href = /^https?:\/\//i.test(bUrl) ? bUrl : 'https://' + bUrl;
      }
      return {
        ok: true,
        verifyPassed: evalRes.passed,
        verifyReason: evalRes.reason,
        actualValue: evalRes.actualValue,
        stepOutput: evalRes.actualValue
      };
    }

    // Locate target element using Multi-Strategy Self-Healing Selector + optional Row Anchor
    const lookup = await waitForElementSmart(selector, options.fallbackSelectors || [], rowAnchor, timeoutMs);
    const el = lookup.element;
    if (!el) {
      const anchorNote = rowAnchor ? ` (within row containing "${rowAnchor}")` : '';
      return { ok: false, error: `Element not found for selector: ${selector}${anchorNote}` };
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashElement(el, '#10b981');
    await new Promise((r) => setTimeout(r, 180));

    switch (type) {
      case 'wait':
        // waitMode === 'element' succeeded
        return { ok: true };

      case 'scroll':
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { ok: true };

      case 'click': {
        const clickedLabel = (el.innerText || el.textContent || el.value || '').trim().slice(0, 120);
        simulateRealisticClick(el);
        return { ok: true, stepOutput: clickedLabel, matchedSelector: lookup.matchedSelector };
      }

      case 'input': {
        simulateRealisticInput(el, value, Boolean(options.clearFirst !== false));
        if (options.pressEnter) {
          await new Promise((r) => setTimeout(r, 150));
          simulateKeyPress(el, 'Enter');
          const parentForm = el.closest('form');
          if (parentForm) {
            // Dispatch submit event; if not prevented by SPA, submit buttons or form.submit
            const submitBtn = parentForm.querySelector('button[type="submit"], input[type="submit"]');
            if (submitBtn) {
              submitBtn.click();
            } else {
              parentForm.requestSubmit ? parentForm.requestSubmit() : parentForm.submit();
            }
          }
        }
        return { ok: true, stepOutput: value, matchedSelector: lookup.matchedSelector };
      }

      case 'select': {
        const matchedOpt = Array.from(el.options || []).find(
          (opt) => opt.value === value || opt.text.trim().toLowerCase() === String(value).trim().toLowerCase()
        );
        if (matchedOpt) {
          el.value = matchedOpt.value;
        } else {
          el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, stepOutput: el.value || value, matchedSelector: lookup.matchedSelector };
      }

      case 'keypress': {
        const keyName = value || 'Enter';
        simulateKeyPress(el, keyName);
        return { ok: true, stepOutput: keyName, matchedSelector: lookup.matchedSelector };
      }

      case 'extract': {
        const target = options.extractTarget || 'text';
        const extractedValue = readElementContentByTarget(el, target, options.customAttr);
        return { ok: true, extractedValue, stepOutput: extractedValue, matchedSelector: lookup.matchedSelector };
      }

      case 'verify': {
        const target = options.extractTarget || 'text';
        const actualContent = readElementContentByTarget(el, target, options.customAttr);
        const condition = options.verifyCondition || 'contains';
        const evalRes = window.FlowTagCSV.evaluateVerification(
          actualContent,
          condition,
          value,
          Boolean(options.caseSensitive)
        );
        flashElement(el, evalRes.passed ? '#10b981' : '#ef4444');
        return {
          ok: true,
          verifyPassed: evalRes.passed,
          verifyReason: evalRes.reason,
          actualValue: evalRes.actualValue,
          stepOutput: evalRes.actualValue,
          matchedSelector: lookup.matchedSelector
        };
      }

      default:
        return { ok: false, error: `Unsupported DOM step type: ${type}` };
    }
  }

  function readElementContentByTarget(el, target, customAttr) {
    if (target === 'text') {
      return (el.innerText || el.textContent || el.value || '').trim();
    } else if (target === 'html') {
      return el.innerHTML.trim();
    } else if (target === 'value') {
      return el.value !== undefined ? String(el.value) : '';
    } else if (target === 'href') {
      return el.href || el.getAttribute('href') || '';
    } else if (target === 'src') {
      return el.src || el.getAttribute('src') || '';
    } else if (target === 'custom_attr' && customAttr) {
      return el.getAttribute(customAttr) || '';
    }
    return (el.innerText || el.textContent || el.value || '').trim();
  }

  /**
   * Smart element resolver with:
   * - Optional Row Anchor Scoping (`rowAnchorText` finds the `<tr>` / row container containing that text)
   * - Primary selector lookup
   * - Saved fallback selectors lookup
   * - Runtime auto-derived wildcard fallbacks (so even legacy steps with hardcoded IDs self-heal!)
   */
  async function waitForElementSmart(primarySelector, savedFallbacks = [], rowAnchorText = '', timeoutMs = 8000) {
    if (!primarySelector) return { element: null, matchedSelector: '' };

    const derivedFallbacks = deriveRuntimeWildcardFallbacks(primarySelector);
    const candidateSelectors = Array.from(
      new Set([primarySelector, ...(savedFallbacks || []), ...derivedFallbacks].filter(Boolean))
    );

    const cleanAnchor =
      rowAnchorText && !String(rowAnchorText).includes('{{') ? String(rowAnchorText).trim() : '';

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let queryRoot = document;
      if (cleanAnchor) {
        const rowContainer = findRowContainerByAnchorText(cleanAnchor);
        if (rowContainer) {
          queryRoot = rowContainer;
        } else {
          // Wait for row container to render if not yet in DOM
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
      }

      for (const sel of candidateSelectors) {
        try {
          const el = queryRoot.querySelector(sel);
          if (el) {
            return { element: el, matchedSelector: sel };
          }
        } catch (_) {
          // Ignore invalid selector candidate
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    return { element: null, matchedSelector: '' };
  }

  function simulateRealisticClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (el.focus) el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  /**
   * Fires the complete browser event lifecycle (`focus`, `keydown`, `keypress`, `input`, `keyup`, `change`, `blur`)
   * so both modern SPA frameworks (React/Vue/Angular) AND legacy inline attributes like
   * `onkeyup="javascript:updateDependentField(this, 'order(...).cancelreason')"` and `onchange="..."`
   * execute reliably!
   */
  function simulateRealisticInput(el, text, clearFirst = true) {
    if (el.focus) el.focus();
    const finalVal = clearFirst ? String(text ?? '') : String(el.value || '') + String(text ?? '');

    const lastChar = finalVal.slice(-1) || '0';
    const charCode = lastChar.charCodeAt(0) || 48;
    const keyInit = {
      key: lastChar,
      code: `Key${lastChar.toUpperCase()}`,
      keyCode: charCode,
      which: charCode,
      bubbles: true,
      cancelable: true
    };

    el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
    el.dispatchEvent(new KeyboardEvent('keypress', keyInit));

    // React / Vue / Angular compatible native value setter
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(el, finalVal);
    } else {
      el.value = finalVal;
    }

    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    // Critical for inline onkeyup="javascript:updateDependentField(...)" handlers:
    el.dispatchEvent(new KeyboardEvent('keyup', keyInit));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function simulateKeyPress(el, key) {
    if (el.focus) el.focus();
    const keyCodeMap = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
    const keyCode = keyCodeMap[key] || 0;
    const eventInit = {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true
    };
    el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  }

  // ============================================================================
  // SHADOW DOM FLOATING TAG-ASSISTANT BUILDER & RUNNER HUD
  // ============================================================================

  function ensureShadowHud() {
    if (hostEl && shadowRoot && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement('div');
    hostEl.id = 'flowtag-automator-shadow-host';
    hostEl.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; pointer-events: none; inset: 0;';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(hostEl);
  }

  function drawHoverBox(el) {
    ensureShadowHud();
    let box = shadowRoot.getElementById('ft-hover-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ft-hover-box';
      shadowRoot.appendChild(box);
    }
    const rect = el.getBoundingClientRect();
    const selectorPreview = generateSmartSelector(el);
    const tag = el.tagName.toLowerCase();

    box.style.cssText = `
      position: fixed;
      top: ${Math.max(0, rect.top - 2)}px;
      left: ${Math.max(0, rect.left - 2)}px;
      width: ${rect.width + 4}px;
      height: ${rect.height + 4}px;
      border: 2px solid #6366f1;
      background: rgba(99, 102, 241, 0.14);
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483646;
      box-sizing: border-box;
      transition: all 0.05s ease-out;
    `;
    box.innerHTML = `
      <div style="
        position: absolute;
        top: ${rect.top < 30 ? rect.height + 6 : -26}px;
        left: 0;
        background: #0f172a;
        color: #f8fafc;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 4px;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        border: 1px solid #6366f1;
      ">
        <span style="color:#818cf8;font-weight:700;">&lt;${escapeHtml(tag)}&gt;</span>
        <span style="color:#cbd5e1;margin-left:4px;">${escapeHtml(selectorPreview.slice(0, 48))}</span>
        <span style="color:#34d399;margin-left:6px;font-weight:600;">[Click to Map]</span>
      </div>
    `;
  }

  function hideHoverBox() {
    if (!shadowRoot) return;
    const box = shadowRoot.getElementById('ft-hover-box');
    if (box) box.remove();
  }

  function renderHud() {
    if (!shadowRoot) return;

    const showBuilder = builderSession && builderSession.active && activeProject;
    const showRunner =
      runnerState &&
      ['running', 'paused', 'stopping'].includes(runnerState.status);

    if (!showBuilder && !showRunner) {
      shadowRoot.innerHTML = '';
      return;
    }

    const masterColSet = new Set(
      activeProject &&
      activeProject.masterCsv &&
      Array.isArray(activeProject.masterCsv.headers)
        ? activeProject.masterCsv.headers
        : []
    );
    if (activeProject && Array.isArray(activeProject.steps)) {
      activeProject.steps.forEach((st) => {
        if (st.stepCsv && Array.isArray(st.stepCsv.headers)) {
          st.stepCsv.headers.forEach((h) => masterColSet.add(h));
        }
      });
    }
    const masterColumns = Array.from(masterColSet);

    const posStyle =
      hudPos.top !== null
        ? `top: ${hudPos.top}px; left: ${hudPos.left}px;`
        : `bottom: ${hudPos.bottom}px; right: ${hudPos.right}px;`;

    shadowRoot.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .ft-hud {
          position: fixed;
          ${posStyle}
          width: ${hudMinimized ? '290px' : '395px'};
          max-height: 86vh;
          background: #0f172a;
          color: #f1f5f9;
          border-radius: 14px;
          border: 1px solid #334155;
          box-shadow: 0 20px 45px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(99, 102, 241, 0.25);
          display: flex;
          flex-direction: column;
          pointer-events: auto;
          overflow: hidden;
          z-index: 2147483647;
        }
        .ft-header {
          background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
          padding: 11px 14px;
          border-bottom: 1px solid #1e293b;
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: grab;
          user-select: none;
        }
        .ft-header:active { cursor: grabbing; }
        .ft-brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
          font-size: 13px;
          color: #fff;
        }
        .ft-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 8px #10b981;
        }
        .ft-header-actions {
          display: flex;
          gap: 6px;
        }
        .ft-icon-btn {
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.12);
          color: #cbd5e1;
          border-radius: 6px;
          padding: 3px 7px;
          font-size: 11px;
          cursor: pointer;
        }
        .ft-icon-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }
        .ft-body {
          padding: 12px 14px;
          overflow-y: auto;
          max-height: calc(86vh - 50px);
          display: flex;
          flex-direction: column;
          gap: 11px;
        }
        .ft-proj-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #1e293b;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #334155;
        }
        .ft-proj-title {
          font-size: 12px;
          font-weight: 600;
          color: #e2e8f0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 220px;
        }
        .ft-badge {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 99px;
          font-weight: 600;
          background: rgba(99, 102, 241, 0.2);
          color: #a5b4fc;
          border: 1px solid rgba(99, 102, 241, 0.4);
        }
        .ft-toolbar {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .ft-btn {
          border: none;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s ease;
        }
        .ft-btn-pick {
          background: ${builderSession.pickMode ? '#ef4444' : '#6366f1'};
          color: #fff;
          grid-column: span 2;
          padding: 10px;
          font-size: 13px;
          box-shadow: 0 4px 12px ${builderSession.pickMode ? 'rgba(239,68,68,0.35)' : 'rgba(99,102,241,0.35)'};
        }
        .ft-btn-pick:hover { filter: brightness(1.08); }
        .ft-btn-secondary {
          background: #1e293b;
          color: #e2e8f0;
          border: 1px solid #334155;
        }
        .ft-btn-secondary:hover { background: #334155; }
        .ft-btn-success {
          background: #10b981;
          color: #052e16;
        }
        .ft-btn-success:hover { filter: brightness(1.08); }
        .ft-card {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 10px;
          padding: 11px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .ft-label {
          font-size: 11px;
          color: #94a3b8;
          font-weight: 600;
          margin-bottom: 2px;
          display: block;
        }
        .ft-input, .ft-select {
          width: 100%;
          background: #0f172a;
          border: 1px solid #334155;
          color: #f8fafc;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
        }
        .ft-input:focus, .ft-select:focus {
          outline: none;
          border-color: #6366f1;
        }
        .ft-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 3px;
        }
        .ft-pill {
          background: rgba(16, 185, 129, 0.15);
          color: #6ee7b7;
          border: 1px solid rgba(16, 185, 129, 0.35);
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 10px;
          font-family: monospace;
          cursor: pointer;
        }
        .ft-pill:hover { background: rgba(16, 185, 129, 0.28); }
        .ft-step-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 220px;
          overflow-y: auto;
        }
        .ft-step-item {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 7px 9px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          font-size: 12px;
        }
        .ft-step-left {
          display: flex;
          align-items: center;
          gap: 7px;
          overflow: hidden;
        }
        .ft-step-num {
          background: #0f172a;
          color: #94a3b8;
          font-size: 10px;
          font-weight: 700;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .ft-step-type {
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          padding: 2px 5px;
          border-radius: 4px;
          background: #312e81;
          color: #c7d2fe;
          flex-shrink: 0;
        }
        .ft-step-name {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: #e2e8f0;
          font-size: 11.5px;
        }
        .ft-step-actions {
          display: flex;
          gap: 3px;
          flex-shrink: 0;
        }
        .ft-mini-btn {
          background: #0f172a;
          border: 1px solid #334155;
          color: #94a3b8;
          border-radius: 4px;
          padding: 2px 5px;
          font-size: 10px;
          cursor: pointer;
        }
        .ft-mini-btn:hover { color: #fff; border-color: #64748b; }
        .ft-runner-box {
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.4);
          border-radius: 10px;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
      </style>

      <div class="ft-hud" id="ft-hud-container">
        <div class="ft-header" id="ft-drag-handle">
          <div class="ft-brand">
            <img src="${chrome.runtime.getURL('ico.png')}" alt="Domuto" style="width:20px;height:20px;border-radius:5px;object-fit:cover;display:block;" />
            <span>Domuto</span>
          </div>
          <div class="ft-header-actions">
            <button class="ft-icon-btn" id="ft-btn-open-dash" title="Open Full Dashboard">Dashboard ↗</button>
            <button class="ft-icon-btn" id="ft-btn-min" title="Minimize / Expand">${hudMinimized ? '▲' : '▼'}</button>
            <button class="ft-icon-btn" id="ft-btn-close" title="Close HUD">✕</button>
          </div>
        </div>

        ${
          hudMinimized
            ? ''
            : `
          <div class="ft-body">
            ${renderRunnerBannerHtml(showRunner)}
            ${showBuilder ? renderBuilderBodyHtml(masterColumns) : ''}
          </div>
        `
        }
      </div>
    `;

    attachHudEvents();
  }

  function renderRunnerBannerHtml(showRunner) {
    if (!showRunner || !runnerState) return '';
    return `
      <div class="ft-runner-box">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11px;font-weight:700;color:#34d399;text-transform:uppercase;">
            ● ${escapeHtml(runnerState.status)} — Row ${runnerState.currentMasterRow || 1} / ${runnerState.totalMasterRows || 1}
          </span>
          <span style="font-size:11px;color:#94a3b8;">
            Step ${runnerState.currentStepIndex || 1}/${runnerState.totalSteps || 1}
          </span>
        </div>
        <div style="font-size:12px;color:#f8fafc;font-weight:600;">
          ${escapeHtml(runnerState.currentStepName || 'Running...')}
        </div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button class="ft-btn ft-btn-secondary" id="ft-run-pause" style="flex:1;padding:5px;">
            ${runnerState.status === 'paused' ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button class="ft-btn ft-btn-secondary" id="ft-run-stop" style="flex:1;padding:5px;border-color:#ef4444;color:#fca5a5;">
            ⏹ Stop
          </button>
        </div>
      </div>
    `;
  }

  function renderBuilderBodyHtml(masterColumns) {
    const steps = (activeProject && activeProject.steps) || [];
    return `
      <div class="ft-proj-bar">
        <div>
          <div style="font-size:10px;color:#94a3b8;">ACTIVE PROJECT</div>
          <div class="ft-proj-title">${escapeHtml(activeProject.name)}</div>
        </div>
        <span class="ft-badge">${steps.length} Step${steps.length === 1 ? '' : 's'}</span>
      </div>

      <div class="ft-toolbar">
        <button class="ft-btn ft-btn-pick" id="ft-btn-toggle-pick">
          ${
            builderSession.pickMode
              ? '🎯 Click Any Element on Page... (ESC to cancel)'
              : '🎯 Pick Element on Page to Map Step'
          }
        </button>
        <button class="ft-btn ft-btn-secondary" id="ft-btn-add-url-step">
          + Go to Current URL
        </button>
        <button class="ft-btn ft-btn-secondary" id="ft-btn-add-manual-step">
          + Manual Step
        </button>
      </div>

      ${editingStepDraft ? renderStepEditorHtml(editingStepDraft, masterColumns) : ''}
      ${showHudRunLauncher ? renderHudRunLauncherHtml(masterColumns) : ''}

      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="ft-label" style="margin:0;">WORKFLOW SEQUENCE (${steps.length})</span>
          <button class="ft-btn ft-btn-success" id="ft-btn-run-now" style="padding:4px 9px;font-size:11px;">
            ▶ Run Workflow
          </button>
        </div>
        ${
          steps.length === 0
            ? `<div style="text-align:center;padding:14px;color:#64748b;font-size:11.5px;background:#1e293b;border-radius:8px;">
                No steps yet. Click <b>"Pick Element on Page"</b> above and click any input, button, or text on this website!
               </div>`
            : `<div class="ft-step-list">
                ${steps
                  .map(
                    (s, i) => `
                  <div class="ft-step-item" style="${s.paused ? 'opacity:0.55;border-style:dashed;border-color:#f59e0b;' : ''}">
                    <div class="ft-step-left">
                      <span class="ft-step-num">${i + 1}</span>
                      <span class="ft-step-type">${escapeHtml(s.type)}</span>
                      <span class="ft-step-name" style="${s.paused ? 'text-decoration:line-through;color:#94a3b8;' : ''}" title="${escapeHtml(s.name || s.selector)}">
                        ${escapeHtml(s.name || s.value || s.selector)}
                        ${s.paused ? '<span style="color:#fbbf24;font-size:10px;font-weight:700;text-decoration:none;display:inline-block;margin-left:3px;">[PAUSED]</span>' : ''}
                        ${s.stepCsv && s.stepCsv.enabled ? '<span style="color:#34d399;font-size:10px;">[CSV]</span>' : ''}
                      </span>
                    </div>
                    <div class="ft-step-actions">
                      <button class="ft-mini-btn" data-act="toggle-pause" data-idx="${i}" title="${s.paused ? 'Resume / Enable Step' : 'Pause Step (Skip during test runs)'}" style="${s.paused ? 'color:#fbbf24;border-color:#f59e0b;font-weight:700;' : ''}">${s.paused ? '▶' : '⏸'}</button>
                      <button class="ft-mini-btn" data-act="up" data-idx="${i}" title="Move Up">↑</button>
                      <button class="ft-mini-btn" data-act="down" data-idx="${i}" title="Move Down">↓</button>
                      <button class="ft-mini-btn" data-act="edit" data-idx="${i}" title="Edit Step">✎</button>
                      <button class="ft-mini-btn" data-act="del" data-idx="${i}" title="Delete" style="color:#f87171;">✕</button>
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>`
        }
      </div>
    `;
  }

  function renderHudRunLauncherHtml(masterColumns) {
    const refCsv = findExistingProjectCsv();
    const refDesc = refCsv
      ? `${refCsv.fileName || 'Reference CSV'} (${refCsv.rows?.length || 0} rows)`
      : 'None (Single run)';

    return `
      <div class="ft-card" style="border-color:#10b981;background:#0f172a;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11.5px;font-weight:700;color:#34d399;">
            ▶ Run Workflow — Execution CSV Input
          </span>
          <button class="ft-mini-btn" id="ft-run-launch-cancel">Cancel</button>
        </div>

        <div style="font-size:11px;color:#cbd5e1;line-height:1.4;">
          Upload a <b>Runtime .CSV file</b> to run this sequence with your own data, or leave blank to use the mapped reference CSV (<b>${escapeHtml(refDesc)}</b>).
        </div>

        ${
          masterColumns.length > 0
            ? `<div style="font-size:10px;color:#94a3b8;">
                Mapped Columns: <span style="color:#6ee7b7;font-family:monospace;">${escapeHtml(masterColumns.slice(0, 8).join(', '))}${masterColumns.length > 8 ? '...' : ''}</span>
               </div>`
            : ''
        }

        <div style="background:#1e293b;padding:7px;border-radius:6px;border:1px dashed #334155;">
          <label class="ft-label" style="color:#93c5fd;">📂 Select CSV File for This Execution:</label>
          <input type="file" accept=".csv,text/csv" id="ft-runtime-csv-file" style="font-size:11px;color:#e2e8f0;width:100%;" />
          ${
            hudRuntimeCsv
              ? `<div style="color:#34d399;font-size:10.5px;margin-top:4px;font-weight:600;">
                  ✓ Loaded: ${escapeHtml(hudRuntimeCsv.fileName)} (${hudRuntimeCsv.rows.length} rows)
                 </div>`
              : ''
          }
        </div>

        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#cbd5e1;cursor:pointer;">
          <input type="checkbox" id="ft-runtime-save-default" ${hudRuntimeCsv?.saveAsDefault ? 'checked' : ''} />
          Also save this CSV as default for future runs
        </label>

        <button class="ft-btn ft-btn-success" id="ft-btn-confirm-start-run" style="width:100%;padding:9px;">
          🚀 ${
            hudRuntimeCsv
              ? `Start Run with "${escapeHtml(hudRuntimeCsv.fileName)}" (${hudRuntimeCsv.rows.length} rows)`
              : `Start Run with Reference CSV`
          }
        </button>
      </div>
    `;
  }

  function getPreviousStepsForDraft(draft) {
    if (!activeProject || !Array.isArray(activeProject.steps)) return [];
    const existingIdx = activeProject.steps.findIndex((s) => s.id === draft.id);
    const limit = existingIdx >= 0 ? existingIdx : activeProject.steps.length;
    const prevList = [];
    for (let i = 0; i < limit; i++) {
      const s = activeProject.steps[i];
      const stepNum = i + 1;
      const token =
        s.type === 'extract' && s.options?.outputColumn
          ? `{{var.${s.options.outputColumn}}}`
          : `{{prev.step_${stepNum}}}`;
      const label = `Step ${stepNum}: ${s.name || s.type}${
        s.type === 'extract' && s.options?.outputColumn ? ` (${s.options.outputColumn})` : ''
      }`;
      prevList.push({ stepNum, token, label, step: s });
    }
    return prevList;
  }

  function renderStepEditorHtml(draft, masterColumns) {
    const ifSource = draft.options?.ifSource || (draft.selector ? 'dom_element' : 'csv_or_var');
    const needsSelector =
      draft.type === 'condition'
        ? ifSource === 'dom_element'
        : !['navigate', 'wait'].includes(draft.type) || (draft.type === 'wait' && draft.options?.waitMode === 'element');
    const stepCsv = draft.stepCsv || { enabled: false, mode: 'sequence_row', headers: [], rows: [] };
    if (!stepCsv.mode || stepCsv.mode === 'match_row') stepCsv.mode = 'sequence_row';
    const allStepCols = stepCsv.enabled && Array.isArray(stepCsv.headers) ? stepCsv.headers : [];
    const prevSteps = getPreviousStepsForDraft(draft);
    const verifyCond = draft.options?.verifyCondition || 'contains';
    const verifyNoValueNeeded = [
      'not_empty',
      'is_empty',
      'contains_integer',
      'is_number',
      'element_exists',
      'element_not_exists'
    ].includes(verifyCond);

    const thenBranch = draft.options?.thenBranch || {
      mode: draft.type === 'condition' ? 'input' : 'continue',
      selector: draft.selector || '',
      value: '',
      targetStepNumber: '',
      pressEnter: false
    };
    const elseBranch = draft.options?.elseBranch || {
      mode: 'continue',
      selector: '',
      value: '',
      targetStepNumber: '',
      pressEnter: false
    };

    const renderBranchBoxHtml = (prefix, title, colorHex, branchObj) => {
      const bMode = branchObj.mode || 'continue';
      const bNeedsSel = ['click', 'input', 'select', 'extract'].includes(bMode);
      const bNeedsVal = ['input', 'select', 'navigate'].includes(bMode);
      const bNeedsOutCol = bMode === 'extract';
      const bNeedsJump = bMode === 'jump_to_step';

      return `
        <div style="background:#0f172a;border:1px solid ${colorHex};border-radius:7px;padding:7px 8px;display:flex;flex-direction:column;gap:5px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <span style="font-size:10.5px;font-weight:700;color:${colorHex};">${title}</span>
            <select class="ft-select" id="ft-draft-${prefix}-mode" style="width:auto;flex:1;font-size:11px;padding:4px 6px;">
              <option value="continue" ${bMode === 'continue' ? 'selected' : ''}>↪ Continue to Next Step</option>
              <option value="input" ${bMode === 'input' ? 'selected' : ''}>⌨️ Type / Fill Input</option>
              <option value="click" ${bMode === 'click' ? 'selected' : ''}>👆 Click Element</option>
              <option value="select" ${bMode === 'select' ? 'selected' : ''}>▾ Select Dropdown Option</option>
              <option value="extract" ${bMode === 'extract' ? 'selected' : ''}>📋 Extract Data</option>
              <option value="navigate" ${bMode === 'navigate' ? 'selected' : ''}>🌐 Go to URL</option>
              <option value="skip_next" ${bMode === 'skip_next' ? 'selected' : ''}>⏭ Skip Next 1 Step</option>
              <option value="jump_to_step" ${bMode === 'jump_to_step' ? 'selected' : ''}>🔢 Jump to Step #</option>
              <option value="skip_row" ${bMode === 'skip_row' ? 'selected' : ''}>⏭ Skip Rest of CSV Row</option>
              <option value="stop_workflow" ${bMode === 'stop_workflow' ? 'selected' : ''}>⏹ Stop Entire Workflow</option>
            </select>
          </div>

          ${
            bNeedsSel
              ? `<div>
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
                    <span style="font-size:10px;color:#94a3b8;">Target Element Selector:</span>
                    <button class="ft-mini-btn" data-pick-branch="${prefix}" style="color:#a5b4fc;border-color:#6366f1;">
                      ${pickingBranchTarget === prefix ? '🎯 Click element on page...' : '🎯 Pick on Page'}
                    </button>
                  </div>
                  <input class="ft-input" id="ft-draft-${prefix}-selector" value="${escapeHtml(branchObj.selector || '')}" placeholder="CSS selector (or leave blank to use IF selector)" style="font-family:monospace;font-size:10.5px;" />
                </div>`
              : ''
          }

          ${
            bNeedsVal
              ? (() => {
                  const targetSelForOpts = branchObj.selector || draft.selector || '';
                  const pageDropdownOpts = bMode === 'select' ? getSelectOptionsFromSelector(targetSelForOpts) : [];
                  return `<div>
                  ${
                    pageDropdownOpts.length > 0
                      ? `<div style="margin-bottom:4px;">
                          <span style="font-size:10px;color:#34d399;font-weight:600;">▾ Pick Option from Page Dropdown (${pageDropdownOpts.length} found):</span>
                          <select class="ft-select" data-branch-opt-picker="${prefix}" style="font-size:11px;margin-top:2px;border-color:#10b981;color:#d1fae5;">
                            <option value="">-- Choose Dropdown Option from Page --</option>
                            ${pageDropdownOpts
                              .map(
                                (o) =>
                                  `<option value="${escapeHtml(o.value !== '' ? o.value : o.text)}" ${
                                    branchObj.value === (o.value !== '' ? o.value : o.text) || branchObj.value === o.text
                                      ? 'selected'
                                      : ''
                                  }>${escapeHtml(o.text || '(empty)')}${
                                    o.value && o.value !== o.text ? ` [value: ${escapeHtml(o.value)}]` : ''
                                  }</option>`
                              )
                              .join('')}
                          </select>
                        </div>`
                      : ''
                  }
                  <span style="font-size:10px;color:#94a3b8;">${bMode === 'navigate' ? 'Target URL:' : 'Value to Enter / Select (supports {{CSV_Col}}):'}</span>
                  <input class="ft-input" id="ft-draft-${prefix}-value" value="${escapeHtml(branchObj.value || '')}" placeholder="Static text or {{Column_Name}}" style="font-size:11px;margin-top:2px;" />
                  ${
                    masterColumns.length > 0
                      ? `<div class="ft-pills" style="margin-top:3px;">
                          ${masterColumns
                            .slice(0, 6)
                            .map((c) => `<span class="ft-pill" data-branch-token="${prefix}:{{${escapeHtml(c)}}}" style="font-size:9.5px;">+ {{${escapeHtml(c)}}}</span>`)
                            .join('')}
                        </div>`
                      : ''
                  }
                </div>`;
                })()
              : ''
          }

          ${
            bNeedsOutCol
              ? `<div>
                  <span style="font-size:10px;color:#94a3b8;">Save to Output CSV Column:</span>
                  <input class="ft-input" id="ft-draft-${prefix}-outcol" value="${escapeHtml(branchObj.outputColumn || 'Branch_Extracted')}" style="font-size:11px;margin-top:2px;" />
                </div>`
              : ''
          }

          ${
            bNeedsJump
              ? `<div>
                  <span style="font-size:10px;color:#94a3b8;">Jump to Step Number (1, 2, 3...):</span>
                  <input type="number" min="1" class="ft-input" id="ft-draft-${prefix}-jump" value="${escapeHtml(branchObj.targetStepNumber || '1')}" style="font-size:11px;margin-top:2px;" />
                </div>`
              : ''
          }
        </div>
      `;
    };

    return `
      <div class="ft-card" style="border-color:#6366f1;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11.5px;font-weight:700;color:#a5b4fc;">
            ${draft.isNew ? '✨ Map New Step' : '✎ Edit Step'}
          </span>
          <button class="ft-mini-btn" id="ft-draft-cancel">Cancel</button>
        </div>

        <div style="display:grid;grid-template-columns: 1fr 1fr;gap:6px;">
          <div>
            <label class="ft-label">Action Type</label>
            <select class="ft-select" id="ft-draft-type">
              <option value="click" ${draft.type === 'click' ? 'selected' : ''}>Click Element</option>
              <option value="input" ${draft.type === 'input' ? 'selected' : ''}>Type / Fill Input</option>
              <option value="condition" ${draft.type === 'condition' ? 'selected' : ''}>🔀 IF / THEN / ELSE Condition</option>
              <option value="verify" ${draft.type === 'verify' ? 'selected' : ''}>✓ Check / Verify Content</option>
              <option value="extract" ${draft.type === 'extract' ? 'selected' : ''}>Extract / Scrape Data</option>
              <option value="select" ${draft.type === 'select' ? 'selected' : ''}>Select Dropdown</option>
              <option value="navigate" ${draft.type === 'navigate' ? 'selected' : ''}>Go to URL / Domain</option>
              <option value="wait" ${draft.type === 'wait' ? 'selected' : ''}>Wait / Delay</option>
              <option value="scroll" ${draft.type === 'scroll' ? 'selected' : ''}>Scroll Page / Element</option>
              <option value="keypress" ${draft.type === 'keypress' ? 'selected' : ''}>Press Keyboard Key</option>
            </select>
          </div>
          <div>
            <label class="ft-label">Step Name</label>
            <input class="ft-input" id="ft-draft-name" value="${escapeHtml(draft.name || '')}" placeholder="e.g. IF Cancel Reason..." />
          </div>
        </div>

        ${
          draft.type === 'condition'
            ? `
          <div style="background:#0f172a;padding:7px 8px;border-radius:7px;border:1px solid #ec4899;">
            <label class="ft-label" style="color:#f9a8d4;">🔀 IF — What do you want to check?</label>
            <select class="ft-select" id="ft-draft-if-source" style="margin-bottom:6px;">
              <option value="csv_or_var" ${ifSource === 'csv_or_var' ? 'selected' : ''}>📄 Check CSV Cell Value / Previous Step Data (e.g. {{Column}})</option>
              <option value="dom_element" ${ifSource === 'dom_element' ? 'selected' : ''}>🌐 Check HTML Element on Page (Text, Value, HTML, Exists)</option>
            </select>

            ${
              ifSource === 'csv_or_var'
                ? `
              <div>
                <label class="ft-label">CSV Cell / Variable to Check:</label>
                <input class="ft-input" id="ft-draft-if-left" value="${escapeHtml(draft.options?.ifLeftValue || '')}" placeholder="e.g. {{Cancel_Reason}} or {{Quantity}} or {{prev.step_1}}" style="font-family:monospace;font-size:11px;" />
                ${
                  masterColumns.length > 0 || prevSteps.length > 0
                    ? `<div class="ft-pills" style="margin-top:4px;">
                        ${masterColumns
                          .map((c) => `<span class="ft-pill" data-ifleft-token="{{${escapeHtml(c)}}}">+ {{${escapeHtml(c)}}}</span>`)
                          .join('')}
                        ${prevSteps
                          .map((ps) => `<span class="ft-pill" style="background:rgba(168,85,247,0.16);color:#d8b4fe;border-color:rgba(168,85,247,0.4);" data-ifleft-token="${escapeHtml(ps.token)}">🔗 Step ${ps.stepNum}</span>`)
                          .join('')}
                      </div>`
                    : ''
                }
              </div>
            `
                : ''
            }
          </div>
        `
            : ''
        }

        ${
          needsSelector
            ? `
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <label class="ft-label">CSS Selector</label>
              <button class="ft-mini-btn" id="ft-draft-test-sel" title="Validate & highlight matching element(s) on page">✓ Validate & Highlight</button>
            </div>
            <input class="ft-input" id="ft-draft-selector" value="${escapeHtml(draft.selector || '')}" placeholder="#id, .class, input[name$='.cancelled']" style="font-family:monospace;font-size:11px;" />

            ${
              draft.options?.validationReport
                ? `<div style="margin-top:5px;padding:5px 7px;border-radius:6px;font-size:10.5px;line-height:1.35;background:${
                    draft.options.validationReport.status === 'verified_multirow'
                      ? 'rgba(245,158,11,0.14)'
                      : 'rgba(16,185,129,0.14)'
                  };border:1px solid ${
                    draft.options.validationReport.status === 'verified_multirow'
                      ? 'rgba(245,158,11,0.4)'
                      : 'rgba(16,185,129,0.4)'
                  };color:${
                    draft.options.validationReport.status === 'verified_multirow' ? '#fde68a' : '#6ee7b7'
                  };" title="${escapeHtml(draft.options.validationReport.detail || '')}">
                    <div style="font-weight:700;">${escapeHtml(draft.options.validationReport.badgeText)}</div>
                    <div style="color:#cbd5e1;font-size:10px;margin-top:2px;">${escapeHtml(draft.options.validationReport.detail || '')}</div>
                  </div>`
                : ''
            }

            ${
              Array.isArray(draft.options?.selectorStrategies) && draft.options.selectorStrategies.length > 1
                ? `<div style="margin-top:5px;">
                    <span style="font-size:10px;color:#94a3b8;">Validated Selector Strategies (click to switch):</span>
                    <div class="ft-pills" style="margin-top:3px;">
                      ${draft.options.selectorStrategies
                        .map(
                          (st) => `<span class="ft-pill" data-switch-sel="${escapeHtml(st.selector)}" style="${
                            draft.selector === st.selector
                              ? 'background:rgba(99,102,241,0.3);color:#fff;border-color:#6366f1;font-weight:700;'
                              : 'background:rgba(30,41,59,0.9);color:#cbd5e1;border-color:#475569;'
                          }" title="${escapeHtml(st.selector)} (${st.reason || ''})">${escapeHtml(st.label)} (${st.matchCount})</span>`
                        )
                        .join('')}
                    </div>
                  </div>`
                : ''
            }

            <div style="margin-top:6px;background:#0f172a;padding:6px 8px;border-radius:6px;border:1px solid #334155;">
              <label class="ft-label" style="color:#93c5fd;margin-bottom:3px;" title="If a table has multiple items/rows, enter text or a CSV column like {{Partner SKU}} or {{UPC}} to find the exact row first!">
                🎯 Scope to Table Row Containing Text (Optional, for multi-item orders):
              </label>
              <input class="ft-input" id="ft-draft-row-anchor" value="${escapeHtml(draft.options?.rowAnchorText || '')}" placeholder="Leave blank, or e.g. {{Partner SKU}}, {{UPC}}, {{Line Number}}" style="font-size:11px;" />
              ${
                masterColumns.length > 0
                  ? `<div class="ft-pills" style="margin-top:4px;">
                      <span style="font-size:9.5px;color:#64748b;align-self:center;">Row Match CSV Col:</span>
                      ${masterColumns
                        .slice(0, 6)
                        .map(
                          (c) =>
                            `<span class="ft-pill" data-row-token="{{${escapeHtml(c)}}}" style="background:rgba(59,130,246,0.15);color:#93c5fd;border-color:rgba(59,130,246,0.35);" title="Find table row containing {{${escapeHtml(c)}}}">+ {{${escapeHtml(c)}}}</span>`
                        )
                        .join('')}
                    </div>`
                  : ''
              }
            </div>
          </div>
        `
            : ''
        }

        ${
          draft.type === 'verify' || draft.type === 'condition'
            ? `
          <div style="display:grid;grid-template-columns:${draft.type === 'condition' && ifSource === 'csv_or_var' ? '1fr' : '1fr 1fr'};gap:6px;">
            ${
              draft.type === 'verify' || (draft.type === 'condition' && ifSource === 'dom_element')
                ? `<div>
                    <label class="ft-label">What to Check on Element</label>
                    <select class="ft-select" id="ft-draft-extract-target">
                      <option value="text" ${draft.options?.extractTarget === 'text' ? 'selected' : ''}>Visible Text / Content</option>
                      <option value="value" ${draft.options?.extractTarget === 'value' ? 'selected' : ''}>Input Value</option>
                      <option value="href" ${draft.options?.extractTarget === 'href' ? 'selected' : ''}>Link URL (href)</option>
                      <option value="html" ${draft.options?.extractTarget === 'html' ? 'selected' : ''}>Inner HTML</option>
                    </select>
                  </div>`
                : ''
            }
            <div>
              <label class="ft-label">${draft.type === 'condition' ? 'IF Condition Operator' : 'Check Condition'}</label>
              <select class="ft-select" id="ft-draft-verify-cond">
                <option value="equals" ${verifyCond === 'equals' ? 'selected' : ''}>Equals exact match (==)</option>
                <option value="not_equals" ${verifyCond === 'not_equals' ? 'selected' : ''}>Does NOT equal (!=)</option>
                <option value="contains" ${verifyCond === 'contains' ? 'selected' : ''}>Contains word / string</option>
                <option value="not_contains" ${verifyCond === 'not_contains' ? 'selected' : ''}>Does NOT contain</option>
                <option value="starts_with" ${verifyCond === 'starts_with' ? 'selected' : ''}>Starts with</option>
                <option value="ends_with" ${verifyCond === 'ends_with' ? 'selected' : ''}>Ends with</option>
                <option value="is_integer" ${verifyCond === 'is_integer' ? 'selected' : ''}>Is an Integer (Whole #)</option>
                <option value="contains_integer" ${verifyCond === 'contains_integer' ? 'selected' : ''}>Contains Integer / Digits</option>
                <option value="is_number" ${verifyCond === 'is_number' ? 'selected' : ''}>Is a Number / Price</option>
                <option value="gt" ${verifyCond === 'gt' ? 'selected' : ''}>Number Greater Than (&gt;)</option>
                <option value="gte" ${verifyCond === 'gte' ? 'selected' : ''}>Number Greater or Equal (&gt;=)</option>
                <option value="lt" ${verifyCond === 'lt' ? 'selected' : ''}>Number Less Than (&lt;)</option>
                <option value="lte" ${verifyCond === 'lte' ? 'selected' : ''}>Number Less or Equal (&lt;=)</option>
                <option value="not_empty" ${verifyCond === 'not_empty' ? 'selected' : ''}>Has Value / Not Empty</option>
                <option value="is_empty" ${verifyCond === 'is_empty' ? 'selected' : ''}>Is Empty / Blank</option>
                ${
                  draft.type === 'condition' && ifSource === 'dom_element'
                    ? `<option value="element_exists" ${verifyCond === 'element_exists' ? 'selected' : ''}>Element Exists on Page</option>
                       <option value="element_not_exists" ${verifyCond === 'element_not_exists' ? 'selected' : ''}>Element Does NOT Exist on Page</option>`
                    : ''
                }
                <option value="regex" ${verifyCond === 'regex' ? 'selected' : ''}>Matches Regex</option>
              </select>
            </div>
          </div>
          ${
            draft.type === 'verify'
              ? `<div>
                  <label class="ft-label">If Check Fails:</label>
                  <select class="ft-select" id="ft-draft-verify-fail">
                    <option value="skip_row" ${(draft.options?.onVerifyFail || 'skip_row') === 'skip_row' ? 'selected' : ''}>Skip rest of sequence for this row & move to next row</option>
                    <option value="continue" ${draft.options?.onVerifyFail === 'continue' ? 'selected' : ''}>Record PASS/FAIL in results & continue to next step</option>
                    <option value="stop_workflow" ${draft.options?.onVerifyFail === 'stop_workflow' ? 'selected' : ''}>Stop entire workflow immediately</option>
                  </select>
                </div>`
              : ''
          }
        `
            : ''
        }

        ${
          draft.type === 'extract'
            ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label class="ft-label">What to Extract</label>
              <select class="ft-select" id="ft-draft-extract-target">
                <option value="text" ${draft.options?.extractTarget === 'text' ? 'selected' : ''}>Visible Text</option>
                <option value="href" ${draft.options?.extractTarget === 'href' ? 'selected' : ''}>Link URL (href)</option>
                <option value="src" ${draft.options?.extractTarget === 'src' ? 'selected' : ''}>Image/Media (src)</option>
                <option value="value" ${draft.options?.extractTarget === 'value' ? 'selected' : ''}>Input Value</option>
                <option value="html" ${draft.options?.extractTarget === 'html' ? 'selected' : ''}>Inner HTML</option>
              </select>
            </div>
            <div>
              <label class="ft-label">Output CSV Column</label>
              <input class="ft-input" id="ft-draft-output-col" value="${escapeHtml(draft.options?.outputColumn || 'Extracted_Data')}" />
            </div>
          </div>
        `
            : draft.type === 'click' || ((draft.type === 'verify' || draft.type === 'condition') && verifyNoValueNeeded)
            ? ''
            : `
          <div>
            <label class="ft-label">
              ${
                draft.type === 'navigate'
                  ? 'Target URL (supports {{csv_col}} or previous step data)'
                  : draft.type === 'verify' || draft.type === 'condition'
                  ? 'Expected Value to Match (word, string, number, or {{CSV_Column}})'
                  : draft.type === 'wait'
                  ? 'Wait Seconds (e.g. 2)'
                  : draft.type === 'keypress'
                  ? 'Key Name (Enter, Escape, Tab, ArrowDown)'
                  : 'Value / Text (Static, CSV column, or Previous Step data)'
              }
            </label>
            ${
              draft.type === 'select'
                ? (() => {
                    const mainDropdownOpts = getSelectOptionsFromSelector(draft.selector || '');
                    return mainDropdownOpts.length > 0
                      ? `<div style="margin-bottom:5px;">
                          <span style="font-size:10px;color:#34d399;font-weight:600;">▾ Pick Option from Page Dropdown (${mainDropdownOpts.length} found):</span>
                          <select class="ft-select" id="ft-draft-main-opt-picker" style="font-size:11px;margin-top:2px;border-color:#10b981;color:#d1fae5;">
                            <option value="">-- Choose Dropdown Option from Page --</option>
                            ${mainDropdownOpts
                              .map(
                                (o) =>
                                  `<option value="${escapeHtml(o.value !== '' ? o.value : o.text)}" ${
                                    draft.value === (o.value !== '' ? o.value : o.text) || draft.value === o.text
                                      ? 'selected'
                                      : ''
                                  }>${escapeHtml(o.text || '(empty)')}${
                                    o.value && o.value !== o.text ? ` [value: ${escapeHtml(o.value)}]` : ''
                                  }</option>`
                              )
                              .join('')}
                          </select>
                        </div>`
                      : '';
                  })()
                : ''
            }
            <input class="ft-input" id="ft-draft-value" value="${escapeHtml(draft.value || '')}" placeholder="${
                draft.type === 'navigate'
                  ? 'https://example.com'
                  : draft.type === 'verify' || draft.type === 'condition'
                  ? 'Word, string, number, or {{CSV_Column}}...'
                  : 'Static text, {{column_name}}, or {{prev.step_1}}'
              }" />

            ${
              prevSteps.length > 0
                ? `<div style="margin-top:5px;">
                    <select class="ft-select" id="ft-draft-prev-step-select" style="font-size:11px;border-color:#a855f7;color:#e9d5ff;">
                      <option value="">🔗 Refer to Data from a Previous Step...</option>
                      ${prevSteps
                        .map(
                          (ps) =>
                            `<option value="${escapeHtml(ps.token)}">Use ${escapeHtml(ps.label)} → ${escapeHtml(ps.token)}</option>`
                        )
                        .join('')}
                    </select>
                   </div>`
                : ''
            }

            ${
              masterColumns.length > 0 || allStepCols.length > 0 || prevSteps.length > 0
                ? `<div class="ft-pills">
                    ${masterColumns
                      .map((c) => `<span class="ft-pill" data-token="{{${escapeHtml(c)}}}" title="Insert CSV column">+ {{${escapeHtml(c)}}}</span>`)
                      .join('')}
                    ${allStepCols
                      .filter((c) => !masterColumns.includes(c))
                      .map((c) => `<span class="ft-pill" style="color:#93c5fd;border-color:#3b82f6;" data-token="{{step.${escapeHtml(c)}}}" title="Insert Step CSV column">+ {{step.${escapeHtml(c)}}}</span>`)
                      .join('')}
                    ${prevSteps
                      .map((ps) => `<span class="ft-pill" style="background:rgba(168,85,247,0.16);color:#d8b4fe;border-color:rgba(168,85,247,0.4);" data-token="${escapeHtml(ps.token)}" title="Insert output from ${escapeHtml(ps.label)}">🔗 Step ${ps.stepNum}</span>`)
                      .join('')}
                   </div>`
                : ''
            }
          </div>
        `
        }

        ${
          draft.type === 'condition'
            ? `
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:2px;">
            ${renderBranchBoxHtml('then', '✅ THEN (If TRUE):', '#10b981', thenBranch)}
            ${renderBranchBoxHtml('else', '❌ ELSE (If FALSE):', '#f59e0b', elseBranch)}
          </div>
        `
            : ''
        }

        ${
          draft.type === 'input'
            ? `
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#cbd5e1;cursor:pointer;">
            <input type="checkbox" id="ft-draft-enter" ${draft.options?.pressEnter ? 'checked' : ''} />
            Press <b>Enter</b> key automatically after typing
          </label>
        `
            : ''
        }

        <!-- Step-level CSV mapping inside HUD -->
        <div style="border-top:1px solid #334155;padding-top:6px;">
          <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#cbd5e1;cursor:pointer;">
            <span>
              <input type="checkbox" id="ft-draft-stepcsv-toggle" ${stepCsv.enabled ? 'checked' : ''} />
              Pick value from <b>CSV File</b> on this step
            </span>
            ${stepCsv.fileName ? `<span style="color:#34d399;font-size:10px;">${escapeHtml(stepCsv.fileName)} (${stepCsv.rows?.length || 0} rows)</span>` : ''}
          </label>
          ${
            stepCsv.enabled
              ? `
            <div style="margin-top:6px;display:flex;flex-direction:column;gap:5px;background:#0f172a;padding:7px;border-radius:6px;">
              <input type="file" accept=".csv,text/csv" id="ft-draft-stepcsv-file" style="font-size:10.5px;color:#94a3b8;" />
              <div style="display:grid;grid-template-columns:1fr;gap:5px;">
                <select class="ft-select" id="ft-draft-stepcsv-mode" style="font-size:11px;">
                  <option value="sequence_row" ${stepCsv.mode !== 'loop_step' ? 'selected' : ''}>Pick 1 row per Full Sequence Flow (e.g. 20 rows = run whole sequence 20x)</option>
                  <option value="loop_step" ${stepCsv.mode === 'loop_step' ? 'selected' : ''}>Repeat only this single step for all rows before next step</option>
                </select>
                <select class="ft-select" id="ft-draft-stepcsv-col" style="font-size:11px;">
                  <option value="">-- Select CSV Column to Pick --</option>
                  ${(stepCsv.headers || [])
                    .map((h) => `<option value="${escapeHtml(h)}" ${stepCsv.columnName === h ? 'selected' : ''}>Column: ${escapeHtml(h)}</option>`)
                    .join('')}
                </select>
              </div>
            </div>
          `
              : ''
          }
        </div>

        <div style="display:flex;gap:6px;margin-top:4px;">
          <button class="ft-btn ft-btn-secondary" id="ft-draft-save" style="flex:1;">
            Save Step
          </button>
          <button class="ft-btn ft-btn-success" id="ft-draft-save-exec" style="flex:1.2;" title="Saves step and immediately performs it on the page so you can continue building!">
            ⚡ Save & Execute Now
          </button>
        </div>
      </div>
    `;
  }

  function attachHudEvents() {
    const q = (sel) => shadowRoot.querySelector(sel);

    // Dragging HUD header
    const dragHandle = q('#ft-drag-handle');
    if (dragHandle) {
      dragHandle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const hudEl = q('#ft-hud-container');
        if (!hudEl) return;
        const rect = hudEl.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;

        const onMove = (moveEvt) => {
          hudPos.left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, moveEvt.clientX - offsetX));
          hudPos.top = Math.max(8, Math.min(window.innerHeight - 60, moveEvt.clientY - offsetY));
          hudPos.right = null;
          hudPos.bottom = null;
          hudEl.style.left = hudPos.left + 'px';
          hudEl.style.top = hudPos.top + 'px';
          hudEl.style.right = 'auto';
          hudEl.style.bottom = 'auto';
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });
    }

    q('#ft-btn-min')?.addEventListener('click', () => {
      hudMinimized = !hudMinimized;
      renderHud();
    });

    q('#ft-btn-close')?.addEventListener('click', () => {
      setPickMode(false);
      chrome.runtime.sendMessage({ type: 'CLOSE_BUILDER_SESSION' });
    });

    q('#ft-btn-open-dash')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'OPEN_DASHBOARD',
        projectId: activeProject ? activeProject.id : null
      });
    });

    // Runner controls
    q('#ft-run-pause')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'PAUSE_RESUME_RUN' });
    });
    q('#ft-run-stop')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_WORKFLOW_RUN' });
    });

    // Builder controls
    q('#ft-btn-toggle-pick')?.addEventListener('click', () => {
      const next = !builderSession.pickMode;
      setPickMode(next);
      chrome.runtime.sendMessage({
        type: 'UPDATE_BUILDER_SESSION',
        updates: { pickMode: next }
      });
      renderHud();
    });

    q('#ft-btn-add-url-step')?.addEventListener('click', async () => {
      if (!activeProject) return;
      activeProject.steps.push({
        id: 'step_' + Date.now(),
        name: 'Go to ' + window.location.hostname,
        type: 'navigate',
        selector: '',
        value: window.location.href,
        options: { waitAfterMs: 1000 },
        stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
      });
      await persistActiveProject();
      renderHud();
    });

    q('#ft-btn-add-manual-step')?.addEventListener('click', () => {
      const refCsv = findExistingProjectCsv();
      const firstCol = refCsv?.headers?.[0] ? `{{${refCsv.headers[0]}}}` : '';
      editingStepDraft = {
        isNew: true,
        id: 'step_' + Date.now(),
        name: 'Manual Step',
        type: 'wait',
        selector: '',
        value: '2',
        options: {
          waitMode: 'time',
          waitAfterMs: 500,
          outputColumn: 'Extracted_Data',
          extractTarget: 'text',
          ifSource: 'csv_or_var',
          ifLeftValue: firstCol,
          verifyCondition: 'equals',
          thenBranch: { mode: 'input', selector: '', value: '', targetStepNumber: '', pressEnter: false },
          elseBranch: { mode: 'continue', selector: '', value: '', targetStepNumber: '', pressEnter: false }
        },
        stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
      };
      renderHud();
    });

    q('#ft-btn-run-now')?.addEventListener('click', () => {
      if (!activeProject) return;
      showHudRunLauncher = !showHudRunLauncher;
      renderHud();
    });

    q('#ft-run-launch-cancel')?.addEventListener('click', () => {
      showHudRunLauncher = false;
      hudRuntimeCsv = null;
      renderHud();
    });

    q('#ft-runtime-csv-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
        const saveChk = q('#ft-runtime-save-default');
        hudRuntimeCsv = {
          fileName: file.name,
          headers: parsed.headers,
          rows: parsed.rows,
          saveAsDefault: saveChk ? saveChk.checked : false
        };
        renderHud();
      };
      reader.readAsText(file);
    });

    q('#ft-runtime-save-default')?.addEventListener('change', (e) => {
      if (hudRuntimeCsv) {
        hudRuntimeCsv.saveAsDefault = e.target.checked;
      }
    });

    q('#ft-btn-confirm-start-run')?.addEventListener('click', () => {
      if (!activeProject) return;
      const runtimeToUse = hudRuntimeCsv;
      showHudRunLauncher = false;
      hudRuntimeCsv = null;
      renderHud();
      chrome.runtime.sendMessage({
        type: 'START_WORKFLOW_RUN',
        projectId: activeProject.id,
        reuseBuilderTab: true,
        runtimeCsv: runtimeToUse
      });
    });

    // Draft form bindings
    if (editingStepDraft) {
      const syncDraftInputs = () => {
        const nameEl = q('#ft-draft-name');
        const selEl = q('#ft-draft-selector');
        const valEl = q('#ft-draft-value');
        const enterEl = q('#ft-draft-enter');
        const extTargetEl = q('#ft-draft-extract-target');
        const outColEl = q('#ft-draft-output-col');
        const verifyCondEl = q('#ft-draft-verify-cond');
        const verifyFailEl = q('#ft-draft-verify-fail');
        const rowAnchorEl = q('#ft-draft-row-anchor');
        const ifSourceEl = q('#ft-draft-if-source');
        const ifLeftEl = q('#ft-draft-if-left');
        const csvModeEl = q('#ft-draft-stepcsv-mode');
        const csvColEl = q('#ft-draft-stepcsv-col');

        editingStepDraft.options = editingStepDraft.options || {};
        if (nameEl) editingStepDraft.name = nameEl.value;
        if (selEl) editingStepDraft.selector = selEl.value;
        if (valEl) editingStepDraft.value = valEl.value;
        if (enterEl) editingStepDraft.options.pressEnter = enterEl.checked;
        if (extTargetEl) editingStepDraft.options.extractTarget = extTargetEl.value;
        if (outColEl) editingStepDraft.options.outputColumn = outColEl.value;
        if (verifyCondEl) editingStepDraft.options.verifyCondition = verifyCondEl.value;
        if (verifyFailEl) editingStepDraft.options.onVerifyFail = verifyFailEl.value;
        if (rowAnchorEl) editingStepDraft.options.rowAnchorText = rowAnchorEl.value;
        if (ifSourceEl) editingStepDraft.options.ifSource = ifSourceEl.value;
        if (ifLeftEl) editingStepDraft.options.ifLeftValue = ifLeftEl.value;

        // Sync THEN and ELSE branches
        ['then', 'else'].forEach((prefix) => {
          const prop = prefix === 'then' ? 'thenBranch' : 'elseBranch';
          const bObj = editingStepDraft.options[prop] || { mode: 'continue', selector: '', value: '' };
          const bModeEl = q(`#ft-draft-${prefix}-mode`);
          const bSelEl = q(`#ft-draft-${prefix}-selector`);
          const bValEl = q(`#ft-draft-${prefix}-value`);
          const bOutEl = q(`#ft-draft-${prefix}-outcol`);
          const bJumpEl = q(`#ft-draft-${prefix}-jump`);
          if (bModeEl) bObj.mode = bModeEl.value;
          if (bSelEl) bObj.selector = bSelEl.value;
          if (bValEl) bObj.value = bValEl.value;
          if (bOutEl) bObj.outputColumn = bOutEl.value;
          if (bJumpEl) bObj.targetStepNumber = bJumpEl.value;
          editingStepDraft.options[prop] = bObj;
        });

        if (csvModeEl) editingStepDraft.stepCsv.mode = csvModeEl.value;
        if (csvColEl) {
          editingStepDraft.stepCsv.columnName = csvColEl.value;
          if (csvColEl.value && !editingStepDraft.value) {
            editingStepDraft.value = `{{step.${csvColEl.value}}}`;
          }
        }
      };

      q('#ft-draft-type')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.type = e.target.value;
        if (editingStepDraft.type === 'condition') {
          editingStepDraft.options.ifSource = editingStepDraft.selector ? 'dom_element' : 'csv_or_var';
          editingStepDraft.options.thenBranch = editingStepDraft.options.thenBranch || {
            mode: 'input',
            selector: editingStepDraft.selector || '',
            value: ''
          };
          editingStepDraft.options.elseBranch = editingStepDraft.options.elseBranch || {
            mode: 'continue',
            selector: '',
            value: ''
          };
        }
        renderHud();
      });

      q('#ft-draft-if-source')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.options.ifSource = e.target.value;
        renderHud();
      });

      q('#ft-draft-main-opt-picker')?.addEventListener('change', (e) => {
        syncDraftInputs();
        if (e.target.value !== '') {
          editingStepDraft.value = e.target.value;
          renderHud();
        }
      });

      shadowRoot.querySelectorAll('[data-branch-opt-picker]').forEach((selEl) => {
        selEl.addEventListener('change', (e) => {
          syncDraftInputs();
          const prefix = selEl.getAttribute('data-branch-opt-picker');
          const prop = prefix === 'then' ? 'thenBranch' : 'elseBranch';
          editingStepDraft.options[prop] = editingStepDraft.options[prop] || { mode: 'select', selector: '', value: '' };
          editingStepDraft.options[prop].value = e.target.value;
          renderHud();
        });
      });

      q('#ft-draft-then-selector')?.addEventListener('change', () => {
        syncDraftInputs();
        renderHud();
      });

      q('#ft-draft-else-selector')?.addEventListener('change', () => {
        syncDraftInputs();
        renderHud();
      });

      q('#ft-draft-then-mode')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.options.thenBranch.mode = e.target.value;
        renderHud();
      });

      q('#ft-draft-else-mode')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.options.elseBranch.mode = e.target.value;
        renderHud();
      });

      shadowRoot.querySelectorAll('.ft-pill[data-ifleft-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const token = pill.getAttribute('data-ifleft-token') || '';
          editingStepDraft.options.ifLeftValue = token;
          renderHud();
        });
      });

      shadowRoot.querySelectorAll('.ft-pill[data-branch-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const raw = pill.getAttribute('data-branch-token') || '';
          const [prefix, token] = raw.split(':');
          const prop = prefix === 'then' ? 'thenBranch' : 'elseBranch';
          editingStepDraft.options[prop] = editingStepDraft.options[prop] || { mode: 'input', selector: '', value: '' };
          editingStepDraft.options[prop].value = (editingStepDraft.options[prop].value || '') + (token || '');
          renderHud();
        });
      });

      shadowRoot.querySelectorAll('[data-pick-branch]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDraftInputs();
          const prefix = btn.getAttribute('data-pick-branch');
          pickingBranchTarget = prefix;
          setPickMode(true);
          chrome.runtime.sendMessage({
            type: 'UPDATE_BUILDER_SESSION',
            updates: { pickMode: true }
          });
          renderHud();
        });
      });

      q('#ft-draft-verify-cond')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.options.verifyCondition = e.target.value;
        renderHud();
      });

      q('#ft-draft-prev-step-select')?.addEventListener('change', (e) => {
        syncDraftInputs();
        const token = e.target.value;
        if (token) {
          editingStepDraft.value = (editingStepDraft.value || '') + token;
          renderHud();
        }
      });

      q('#ft-draft-stepcsv-col')?.addEventListener('change', (e) => {
        syncDraftInputs();
        const chosenCol = e.target.value;
        editingStepDraft.stepCsv.columnName = chosenCol;
        if (chosenCol) {
          editingStepDraft.value = `{{step.${chosenCol}}}`;
        }
        renderHud();
      });

      q('#ft-draft-test-sel')?.addEventListener('click', () => {
        syncDraftInputs();
        // Resolve rowAnchorText against Row 1 if it contains {{...}}
        let previewAnchor = editingStepDraft.options?.rowAnchorText || '';
        if (previewAnchor.includes('{{')) {
          const refCsv = findExistingProjectCsv();
          const row0 = refCsv?.rows?.[0] || {};
          previewAnchor = window.FlowTagCSV.interpolateValue(previewAnchor, { masterRow: row0, stepRow: row0 });
        }
        const count = highlightSelectorOnPage(editingStepDraft.selector, previewAnchor);
        const btn = q('#ft-draft-test-sel');
        if (btn) btn.textContent = `✓ ${count} match${count === 1 ? '' : 'es'}`;
      });

      shadowRoot.querySelectorAll('.ft-pill[data-switch-sel]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const nextSel = pill.getAttribute('data-switch-sel') || '';
          if (nextSel) {
            editingStepDraft.selector = nextSel;
            highlightSelectorOnPage(nextSel, editingStepDraft.options?.rowAnchorText || '');
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('.ft-pill[data-row-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const rowToken = pill.getAttribute('data-row-token') || '';
          editingStepDraft.options = editingStepDraft.options || {};
          editingStepDraft.options.rowAnchorText = rowToken;
          renderHud();
        });
      });

      shadowRoot.querySelectorAll('.ft-pill[data-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const token = pill.getAttribute('data-token') || '';
          editingStepDraft.value = (editingStepDraft.value || '') + token;
          renderHud();
        });
      });

      q('#ft-draft-stepcsv-toggle')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.stepCsv.enabled = e.target.checked;
        if (!editingStepDraft.stepCsv.mode || editingStepDraft.stepCsv.mode === 'match_row' || editingStepDraft.stepCsv.mode === 'loop_step') {
          editingStepDraft.stepCsv.mode = 'sequence_row';
        }
        // If enabling on a follow-up step and this step doesn't have a CSV yet, reuse the CSV from an earlier step or Master CSV!
        if (e.target.checked && (!editingStepDraft.stepCsv.rows || editingStepDraft.stepCsv.rows.length === 0)) {
          const existingCsv = findExistingProjectCsv();
          if (existingCsv) {
            editingStepDraft.stepCsv.fileName = existingCsv.fileName;
            editingStepDraft.stepCsv.headers = [...existingCsv.headers];
            editingStepDraft.stepCsv.rows = existingCsv.rows;
          }
        }
        renderHud();
      });

      q('#ft-draft-stepcsv-file')?.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          syncDraftInputs();
          const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
          editingStepDraft.stepCsv = {
            ...editingStepDraft.stepCsv,
            enabled: true,
            mode: editingStepDraft.stepCsv?.mode === 'loop_single_step' ? 'loop_single_step' : 'sequence_row',
            fileName: file.name,
            headers: parsed.headers,
            rows: parsed.rows,
            columnName: parsed.headers[0] || ''
          };
          if (parsed.headers[0] && !editingStepDraft.value) {
            editingStepDraft.value = `{{${parsed.headers[0]}}}`;
          }
          // Also populate Project Master CSV if it was empty so all follow-up steps share it automatically
          if (activeProject && (!activeProject.masterCsv || !activeProject.masterCsv.rows || activeProject.masterCsv.rows.length === 0)) {
            activeProject.masterCsv = {
              enabled: true,
              fileName: file.name,
              headers: parsed.headers,
              rows: parsed.rows
            };
          }
          renderHud();
        };
        reader.readAsText(file);
      });

      q('#ft-draft-cancel')?.addEventListener('click', () => {
        editingStepDraft = null;
        renderHud();
      });

      q('#ft-draft-save')?.addEventListener('click', async () => {
        syncDraftInputs();
        await saveDraftToProject(false);
      });

      q('#ft-draft-save-exec')?.addEventListener('click', async () => {
        syncDraftInputs();
        await saveDraftToProject(true);
      });
    }

    // Step sequence item actions (up, down, edit, delete)
    shadowRoot.querySelectorAll('.ft-mini-btn[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!activeProject) return;
        const act = btn.getAttribute('data-act');
        const idx = Number(btn.getAttribute('data-idx'));
        const steps = activeProject.steps;

        if (act === 'toggle-pause' && steps[idx]) {
          steps[idx].paused = !steps[idx].paused;
          await persistActiveProject();
          renderHud();
        } else if (act === 'up' && idx > 0) {
          [steps[idx - 1], steps[idx]] = [steps[idx], steps[idx - 1]];
          await persistActiveProject();
          renderHud();
        } else if (act === 'down' && idx < steps.length - 1) {
          [steps[idx + 1], steps[idx]] = [steps[idx], steps[idx + 1]];
          await persistActiveProject();
          renderHud();
        } else if (act === 'del') {
          steps.splice(idx, 1);
          await persistActiveProject();
          renderHud();
        } else if (act === 'edit') {
          editingStepDraft = JSON.parse(JSON.stringify(steps[idx]));
          editingStepDraft.isNew = false;
          renderHud();
        }
      });
    });
  }

  function findExistingProjectCsv() {
    if (!activeProject) return null;
    if (activeProject.masterCsv && Array.isArray(activeProject.masterCsv.rows) && activeProject.masterCsv.rows.length > 0) {
      return activeProject.masterCsv;
    }
    for (const st of activeProject.steps || []) {
      if (st.stepCsv && Array.isArray(st.stepCsv.rows) && st.stepCsv.rows.length > 0) {
        return st.stepCsv;
      }
    }
    return null;
  }

  async function saveDraftToProject(executeImmediately) {
    if (!activeProject || !editingStepDraft) return;
    const stepToSave = JSON.parse(JSON.stringify(editingStepDraft));
    delete stepToSave.isNew;

    const existingIdx = activeProject.steps.findIndex((s) => s.id === stepToSave.id);
    if (existingIdx >= 0) {
      activeProject.steps[existingIdx] = stepToSave;
    } else {
      activeProject.steps.push(stepToSave);
    }

    editingStepDraft = null;
    await persistActiveProject();
    renderHud();

    if (executeImmediately) {
      // Build merged Row #1 from Master CSV AND any earlier step's Step CSV so {{Quantity}} resolves even on follow-up steps!
      const sampleMasterRow = {};
      for (const st of activeProject.steps || []) {
        if (st.stepCsv && Array.isArray(st.stepCsv.rows) && st.stepCsv.rows.length > 0) {
          Object.assign(sampleMasterRow, st.stepCsv.rows[0] || {});
        }
      }
      if (activeProject.masterCsv && Array.isArray(activeProject.masterCsv.rows) && activeProject.masterCsv.rows.length > 0) {
        Object.assign(sampleMasterRow, activeProject.masterCsv.rows[0] || {});
      }

      const sampleStepRow = stepToSave.stepCsv?.rows?.[0] || sampleMasterRow;

      // Also build preview values for {{prev.step_X}} references
      const previewVars = {};
      (activeProject.steps || []).forEach((st, idx) => {
        const val = window.FlowTagCSV.interpolateValue(st.value || '', {
          masterRow: sampleMasterRow,
          stepRow: st.stepCsv?.rows?.[0] || sampleMasterRow,
          extractedVars: previewVars
        });
        previewVars[`step_${idx + 1}`] = val;
        if (st.options?.outputColumn) {
          previewVars[st.options.outputColumn] = val;
        }
      });

      let rawVal = stepToSave.value || '';
      if (stepToSave.stepCsv?.enabled && stepToSave.stepCsv?.columnName && !rawVal.includes('{{')) {
        rawVal = sampleStepRow[stepToSave.stepCsv.columnName] ?? rawVal;
      }

      const resolvedValue = window.FlowTagCSV.interpolateValue(rawVal, {
        masterRow: sampleMasterRow,
        stepRow: sampleStepRow,
        extractedVars: previewVars
      });
      const resolvedSelector = window.FlowTagCSV.interpolateValue(stepToSave.selector || '', {
        masterRow: sampleMasterRow,
        stepRow: sampleStepRow,
        extractedVars: previewVars
      });
      const resolvedRowAnchor = window.FlowTagCSV.interpolateValue(
        stepToSave.options?.rowAnchorText || '',
        {
          masterRow: sampleMasterRow,
          stepRow: sampleStepRow,
          extractedVars: previewVars
        }
      );
      const resolvedLeftValue = window.FlowTagCSV.interpolateValue(
        stepToSave.options?.ifLeftValue || '',
        {
          masterRow: sampleMasterRow,
          stepRow: sampleStepRow,
          extractedVars: previewVars
        }
      );
      if (stepToSave.options?.thenBranch) {
        stepToSave.options.thenBranch.resolvedSelector = window.FlowTagCSV.interpolateValue(
          stepToSave.options.thenBranch.selector || '',
          { masterRow: sampleMasterRow, stepRow: sampleStepRow, extractedVars: previewVars }
        );
        stepToSave.options.thenBranch.resolvedValue = window.FlowTagCSV.interpolateValue(
          stepToSave.options.thenBranch.value || '',
          { masterRow: sampleMasterRow, stepRow: sampleStepRow, extractedVars: previewVars }
        );
      }
      if (stepToSave.options?.elseBranch) {
        stepToSave.options.elseBranch.resolvedSelector = window.FlowTagCSV.interpolateValue(
          stepToSave.options.elseBranch.selector || '',
          { masterRow: sampleMasterRow, stepRow: sampleStepRow, extractedVars: previewVars }
        );
        stepToSave.options.elseBranch.resolvedValue = window.FlowTagCSV.interpolateValue(
          stepToSave.options.elseBranch.value || '',
          { masterRow: sampleMasterRow, stepRow: sampleStepRow, extractedVars: previewVars }
        );
      }

      if (stepToSave.type === 'navigate' && resolvedValue) {
        window.location.href = /^https?:\/\//i.test(resolvedValue) ? resolvedValue : 'https://' + resolvedValue;
      } else {
        await executeDomStep({
          ...stepToSave,
          resolvedSelector,
          resolvedValue,
          resolvedRowAnchor,
          resolvedLeftValue
        });
      }
    }
  }

  function persistActiveProject() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'SAVE_SINGLE_PROJECT',
          project: activeProject
        },
        (res) => resolve(res)
      );
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
