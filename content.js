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
  let pickingTableSourceMode = false; // true when picking an HTML <table> or repeating <div> list as the project's data source
  let showHudRunLauncher = false;
  let hudRuntimeCsv = null;
  let pickDelayTimer = null;
  let pickDelayRemaining = 0;

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

      case 'EXTRACT_PAGE_TABLE_ROWS': {
        const cfg = message.pageTableSource || activeProject?.pageTableSource || {};
        const extracted = extractPageTableOrListData(null, cfg.containerSelector || '', cfg.rowSelector || '');
        sendResponse(extracted);
        return false;
      }

      case 'START_TABLE_SOURCE_PICK': {
        ensureShadowHud();
        if (message.stepId && activeProject && Array.isArray(activeProject.steps)) {
          const matchedStep = activeProject.steps.find((s) => s.id === message.stepId);
          if (matchedStep && (!editingStepDraft || editingStepDraft.id !== matchedStep.id)) {
            editingStepDraft = JSON.parse(JSON.stringify(matchedStep));
            editingStepDraft.isNew = false;
          }
        }
        pickingTableSourceMode = true;
        setPickMode(true);
        renderHud();
        sendResponse({ ok: true });
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

  function startDelayedPick(targetBranchKey, delaySeconds = 3) {
    if (pickDelayTimer) {
      clearInterval(pickDelayTimer);
      pickDelayTimer = null;
    }
    pickingBranchTarget = targetBranchKey;
    pickDelayRemaining = delaySeconds;
    // Keep pickMode false while countdown is running so the user can freely click and open their modal!
    setPickMode(false);
    renderHud();

    pickDelayTimer = setInterval(() => {
      pickDelayRemaining--;
      if (pickDelayRemaining <= 0) {
        clearInterval(pickDelayTimer);
        pickDelayTimer = null;
        setPickMode(true);
        chrome.runtime.sendMessage({
          type: 'UPDATE_BUILDER_SESSION',
          updates: { pickMode: true }
        });
      }
      renderHud();
    }, 1000);
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
    if (e.key === 'Escape') {
      if (pickDelayTimer) {
        clearInterval(pickDelayTimer);
        pickDelayTimer = null;
        pickDelayRemaining = 0;
      }
      if (builderSession.pickMode) {
        e.preventDefault();
        e.stopPropagation();
        pickingBranchTarget = null;
        pickingTableSourceMode = false;
        setPickMode(false);
        chrome.runtime.sendMessage({
          type: 'UPDATE_BUILDER_SESSION',
          updates: { pickMode: false }
        });
        renderHud();
      }
    }
  }

  /**
   * Extracts structured rows and columns from an HTML <table>, [role="table"], [role="grid"],
   * or a repeating <div> / <ul> / <ol> list container on the live webpage.
   */
  function extractPageTableOrListData(rawEl, explicitContainerSelector = '', explicitRowSelector = '') {
    let containerEl = null;
    if (explicitContainerSelector) {
      try {
        containerEl = document.querySelector(explicitContainerSelector);
      } catch (_) {}
    }

    if (!containerEl && rawEl && rawEl.nodeType === 1) {
      // 1. Prefer enclosing HTML <table>
      const tableEl = rawEl.tagName === 'TABLE' ? rawEl : rawEl.closest('table');
      if (tableEl) {
        containerEl = tableEl;
      } else {
        // 2. Check ARIA table / grid
        const ariaTable = rawEl.closest('[role="table"], [role="grid"]');
        if (ariaTable) {
          containerEl = ariaTable;
        } else {
          // 3. Walk up from rawEl to find a container with >= 2 repeating visible child elements
          let cur = rawEl;
          while (cur && cur !== document.body && cur !== document.documentElement) {
            const children = Array.from(cur.children || []).filter((ch) => {
              const tag = ch.tagName.toLowerCase();
              if (['script', 'style', 'template', 'svg', 'hr', 'br'].includes(tag)) return false;
              const r = ch.getBoundingClientRect();
              return r.width > 10 && r.height > 10;
            });
            if (children.length >= 2) {
              const tagCounts = {};
              children.forEach((ch) => {
                const t = ch.tagName.toLowerCase();
                tagCounts[t] = (tagCounts[t] || 0) + 1;
              });
              const hasRepeatingTag = Object.values(tagCounts).some((cnt) => cnt >= 2);
              if (hasRepeatingTag) {
                containerEl = cur;
                break;
              }
            }
            cur = cur.parentElement;
          }
        }
      }
    }

    if (!containerEl) {
      return {
        ok: false,
        error: 'Could not find an HTML <table> or repeating list container at that element.'
      };
    }

    const containerSelector = explicitContainerSelector || buildUniqueContainerSelector(containerEl);
    const isHtmlTable = containerEl.tagName === 'TABLE' || Boolean(containerEl.querySelector(':scope > tbody, :scope > tr, :scope > thead'));

    if (isHtmlTable) {
      const tableEl = containerEl.tagName === 'TABLE' ? containerEl : containerEl.closest('table') || containerEl;
      const rowSelector = explicitRowSelector || 'tbody tr';

      // Only rows that belong to THIS table (ignore nested tables inside expandable rows)
      const ownedRows = Array.from(tableEl.querySelectorAll('tr')).filter((tr) => tr.closest('table') === tableEl);
      const isRowVisible = (tr) => {
        if (tr.getAttribute('aria-hidden') === 'true') return false;
        if (/measure-row|expanded-row|placeholder/i.test(tr.className || '')) return false;
        const cs = window.getComputedStyle(tr);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        return true;
      };
      const ownCells = (tr) => Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      const expandColspan = (cells) => {
        const out = [];
        cells.forEach((c) => {
          const span = Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1);
          out.push(c);
          for (let i = 1; i < span; i++) out.push(null);
        });
        return out;
      };

      // 1. Header row: last visible <thead> row of this table that contains <th> cells
      let headerRow = null;
      const theadRows = ownedRows.filter((tr) => tr.parentElement && tr.parentElement.tagName === 'THEAD' && isRowVisible(tr));
      if (theadRows.length > 0) {
        headerRow = theadRows[theadRows.length - 1];
      } else {
        // 1b. Sticky / fixed-header grids (e.g. Ant Design) render the header in a SEPARATE sibling <table>
        //     (resolved after data rows are known so we can match the column count)
        // 1c. First row made of <th> only
        const firstThRow = ownedRows.find((tr) => {
          const cells = ownCells(tr);
          return cells.length > 0 && cells.every((c) => c.tagName === 'TH');
        });
        if (firstThRow) headerRow = firstThRow;
      }

      // 2. Data rows: owned, visible, non-header rows with <td> cells and the dominant cell count
      let dataTrs = ownedRows.filter(
        (tr) => tr !== headerRow && !(tr.parentElement && tr.parentElement.tagName === 'THEAD') && isRowVisible(tr) && tr.querySelector(':scope > td')
      );
      const countFreq = {};
      dataTrs.forEach((tr) => {
        const n = expandColspan(ownCells(tr)).length;
        countFreq[n] = (countFreq[n] || 0) + 1;
      });
      const dominantCount = Number(Object.entries(countFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
      dataTrs = dataTrs.filter((tr) => {
        if (expandColspan(ownCells(tr)).length !== dominantCount) return false;
        const text = (tr.innerText || tr.textContent || '').trim();
        return text.length > 0 || Boolean(tr.querySelector('input, select, textarea, button'));
      });

      if (!headerRow) {
        // Look for a separate header <table> near this one whose column count matches the data rows
        let anc = tableEl.parentElement;
        for (let depth = 0; anc && depth < 5 && !headerRow; depth++, anc = anc.parentElement) {
          const candidates = Array.from(anc.querySelectorAll('table thead tr')).filter((tr) => {
            const ownerTable = tr.closest('table');
            return (
              !tableEl.contains(tr) &&
              !(ownerTable.parentElement && ownerTable.parentElement.closest('table')) &&
              isRowVisible(tr)
            );
          });
          const matching = candidates.filter((tr) => expandColspan(ownCells(tr)).length === dominantCount);
          if (matching.length > 0) headerRow = matching[matching.length - 1];
        }
      }

      // 3. Headers aligned 1:1 with data cells (blank header cells become Col_N, never "Extracted_Data")
      const headerCellsExpanded = headerRow ? expandColspan(ownCells(headerRow)) : [];
      const maxCols = Math.max(dominantCount, 0);
      const headers = [];
      const usedHeaders = new Set();
      for (let c = 0; c < maxCols; c++) {
        const hCell = headerCellsExpanded[c];
        const rawHeader = hCell ? (hCell.innerText || hCell.textContent || '').trim().replace(/\s+/g, ' ') : '';
        let cleanHeader = rawHeader
          .replace(/["'<>]/g, '')
          .replace(/[^a-zA-Z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (!cleanHeader || /^\d+$/.test(cleanHeader)) {
          cleanHeader = `Col_${c + 1}`;
        }
        let uniqueHeader = cleanHeader;
        let dupN = 2;
        while (usedHeaders.has(uniqueHeader)) {
          uniqueHeader = `${cleanHeader}_${dupN++}`;
        }
        usedHeaders.add(uniqueHeader);
        headers.push(uniqueHeader);
      }

      const rows = dataTrs.map((tr) => {
        const cells = expandColspan(ownCells(tr));
        const rowObj = {};
        headers.forEach((colName, cIdx) => {
          const cell = cells[cIdx];
          if (!cell) {
            rowObj[colName] = '';
            return;
          }
          const inputEl = cell.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
          let cellText = (cell.innerText || cell.textContent || '').trim().replace(/\s+/g, ' ');
          if (inputEl) {
            if (inputEl.tagName === 'SELECT') {
              const selOpt = inputEl.options?.[inputEl.selectedIndex];
              cellText = (selOpt ? selOpt.text : inputEl.value || '').trim();
            } else if (!cellText && inputEl.value) {
              cellText = String(inputEl.value).trim();
            }
          }
          rowObj[colName] = cellText;
        });
        return rowObj;
      });

      return {
        ok: true,
        sourceType: 'table',
        containerEl: tableEl,
        containerSelector,
        rowSelector,
        headers,
        rows,
        rowElements: dataTrs
      };
    }

    // Repeating <div> / <ul> / [role="table"] list container
    let rowElements = [];
    let rowSelector = explicitRowSelector || '';
    if (rowSelector) {
      try {
        rowElements = Array.from(containerEl.querySelectorAll(rowSelector));
      } catch (_) {}
    }

    if (rowElements.length === 0) {
      const roleRows = Array.from(containerEl.querySelectorAll('[role="row"], [role="listitem"]'));
      if (roleRows.length >= 2) {
        rowElements = roleRows;
        rowSelector = '[role="row"], [role="listitem"]';
      } else {
        const children = Array.from(containerEl.children || []).filter((ch) => {
          const tag = ch.tagName.toLowerCase();
          return !['script', 'style', 'template', 'svg', 'hr', 'br'].includes(tag);
        });
        const tagCounts = {};
        children.forEach((ch) => {
          const t = ch.tagName.toLowerCase();
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
        let dominantTag = 'div';
        let maxCnt = 0;
        Object.entries(tagCounts).forEach(([t, cnt]) => {
          if (cnt > maxCnt) {
            maxCnt = cnt;
            dominantTag = t;
          }
        });
        rowElements = children.filter((ch) => ch.tagName.toLowerCase() === dominantTag);
        rowSelector = `:scope > ${dominantTag}`;
      }
    }

    let maxSegments = 1;
    const rawRowSegments = rowElements.map((rowEl) => {
      const directKids = Array.from(rowEl.children || []);
      let parts = [];
      if (directKids.length >= 2) {
        parts = directKids
          .map((kid) => {
            const inp = kid.querySelector('input:not([type="hidden"]), select, textarea');
            const txt = (kid.innerText || kid.textContent || '').trim().replace(/\s+/g, ' ');
            return txt || (inp && inp.value ? String(inp.value).trim() : '');
          })
          .filter((val) => val.length > 0);
      }
      if (parts.length === 0) {
        const fullTxt = (rowEl.innerText || rowEl.textContent || '').trim().replace(/\s+/g, ' ');
        parts = fullTxt ? [fullTxt] : [''];
      }
      if (parts.length > maxSegments) maxSegments = Math.min(parts.length, 10);
      return parts;
    });

    const headers = [];
    for (let i = 0; i < maxSegments; i++) {
      headers.push(`Col_${i + 1}`);
    }

    const rows = rawRowSegments.map((parts) => {
      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = parts[idx] ?? '';
      });
      return rowObj;
    });

    return {
      ok: true,
      sourceType: 'list',
      containerEl,
      containerSelector,
      rowSelector,
      headers,
      rows,
      rowElements
    };
  }

  /**
   * Builds a selector that matches ONLY this table/list container on the page, so the runner never
   * accidentally reads a different table (e.g. a generic `div > div > div > table` that matches the first table).
   */
  function buildUniqueContainerSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const isUnique = (sel) => {
      try {
        const m = document.querySelectorAll(sel);
        return m.length === 1 && m[0] === el;
      } catch (_) {
        return false;
      }
    };
    const std = generateStandardSelector(el, true);
    if (std && isUnique(std)) return std;

    // Try "<stable ancestor> <tag>" combos (ancestor with clean id or meaningful class)
    const tag = el.tagName.toLowerCase();
    let anc = el.parentElement;
    for (let depth = 0; anc && anc !== document.body && depth < 12; depth++, anc = anc.parentElement) {
      if (anc.id && !/\d{4,}/.test(anc.id)) {
        const sel = `#${CSS.escape(anc.id)} ${tag}`;
        if (isUnique(sel)) return sel;
      }
      const cls = Array.from(anc.classList || []).filter(
        (c) => c.length > 2 && !/^(active|hover|focus|selected|open|ng-|css-|sc-|tw-|\d)/.test(c) && !/\d{3,}/.test(c)
      );
      for (const c of cls.slice(0, 3)) {
        const sel = `.${CSS.escape(c)} ${tag}`;
        if (isUnique(sel)) return sel;
      }
    }

    // Final fallback: full structural path from <body> (unique by construction)
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((ch) => ch.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return `body > ${parts.join(' > ')}`;
  }

  function findNthPageTableRowElement(pageTableConfig) {
    if (!pageTableConfig || !pageTableConfig.containerSelector) return null;
    const extracted = extractPageTableOrListData(
      null,
      pageTableConfig.containerSelector,
      pageTableConfig.rowSelector || ''
    );
    if (!extracted.ok || !Array.isArray(extracted.rowElements)) return null;
    const idx = Number(pageTableConfig.rowIndex || 0);
    return extracted.rowElements[idx] || null;
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

  function ensureBranchActionsArray(options, branchKey) {
    if (!options) return [];
    const arrKey = branchKey === 'else' ? 'elseActions' : 'thenActions';
    const legacyKey = branchKey === 'else' ? 'elseBranch' : 'thenBranch';
    if (!Array.isArray(options[arrKey]) || options[arrKey].length === 0) {
      if (options[legacyKey] && typeof options[legacyKey] === 'object') {
        options[arrKey] = [{ ...options[legacyKey] }];
      } else {
        options[arrKey] = [
          {
            mode: branchKey === 'else' ? 'continue' : 'click',
            selector: '',
            rowRelativeSelector: '',
            isRowRelative: false,
            value: '',
            targetStepNumber: '',
            pressEnter: false
          }
        ];
      }
    }
    return options[arrKey];
  }

  function syncLegacyBranchesFromActions(options) {
    if (!options) return;
    if (Array.isArray(options.thenActions) && options.thenActions.length > 0) {
      options.thenBranch = { ...options.thenActions[0] };
    }
    if (Array.isArray(options.elseActions) && options.elseActions.length > 0) {
      options.elseBranch = { ...options.elseActions[0] };
    }
  }

  function projectUsesPageTable(proj, draft = null) {
    if (!proj) return false;
    if (proj.pageTableSource && proj.pageTableSource.enabled && proj.pageTableSource.containerSelector) {
      return true;
    }
    if (proj.masterCsv && proj.masterCsv.isPageTableSnapshot) {
      return true;
    }
    if (draft && draft.stepCsv && draft.stepCsv.enabled && draft.stepCsv.sourceType === 'page_table') {
      return true;
    }
    for (const st of proj.steps || []) {
      if (st.stepCsv && st.stepCsv.enabled && st.stepCsv.sourceType === 'page_table') {
        return true;
      }
    }
    return false;
  }

  function onPickerClick(e) {
    if (!builderSession.pickMode || isEventInsideHud(e)) return;

    const rawEl = e.target;
    if (!rawEl) return;

    // Handle picking an HTML <table> or repeating <div> list for the step's "Pick value from Page Table" box!
    if (pickingTableSourceMode) {
      e.preventDefault();
      e.stopPropagation();
      const extracted = extractPageTableOrListData(rawEl);
      pickingTableSourceMode = false;
      setPickMode(false);
      chrome.runtime.sendMessage({
        type: 'UPDATE_BUILDER_SESSION',
        updates: { pickMode: false }
      });

      if (extracted && extracted.ok && activeProject) {
        const tableLabel = `Table: ${extracted.containerSelector}`;
        activeProject.pageTableSource = {
          enabled: true,
          sourceType: extracted.sourceType,
          containerSelector: extracted.containerSelector,
          rowSelector: extracted.rowSelector,
          liveRefreshOnRun: true,
          headers: extracted.headers,
          sampleRowCount: extracted.rows.length
        };
        activeProject.masterCsv = {
          enabled: true,
          isPageTableSnapshot: true,
          fileName: tableLabel,
          headers: extracted.headers,
          rows: extracted.rows
        };
        if (editingStepDraft) {
          editingStepDraft.stepCsv = {
            enabled: true,
            sourceType: 'page_table',
            containerSelector: extracted.containerSelector,
            rowSelector: extracted.rowSelector,
            mode: editingStepDraft.stepCsv?.mode === 'loop_step' ? 'loop_step' : 'sequence_row',
            fileName: tableLabel,
            headers: extracted.headers,
            rows: extracted.rows,
            columnName: extracted.headers[0] || ''
          };
          if (extracted.headers[0]) {
            if (editingStepDraft.type === 'condition') {
              editingStepDraft.options = editingStepDraft.options || {};
              editingStepDraft.options.ifSource = 'csv_or_var';
              const curLeft = editingStepDraft.options.ifLeftValue || '';
              const curKey = (curLeft.match(/^\{\{\s*(?:step\.|master\.)?([^}]+?)\s*\}\}$/) || [])[1];
              if (!curLeft || (curKey && !extracted.headers.includes(curKey))) {
                editingStepDraft.options.ifLeftValue = `{{${extracted.headers[0]}}}`;
              }
            } else if (!editingStepDraft.value) {
              editingStepDraft.value = `{{${extracted.headers[0]}}}`;
            }
          }
          if (!editingStepDraft.isNew && Array.isArray(activeProject.steps)) {
            const existingIdx = activeProject.steps.findIndex((s) => s.id === editingStepDraft.id);
            if (existingIdx >= 0) {
              activeProject.steps[existingIdx].stepCsv = JSON.parse(JSON.stringify(editingStepDraft.stepCsv));
              if (!activeProject.steps[existingIdx].value && editingStepDraft.value) {
                activeProject.steps[existingIdx].value = editingStepDraft.value;
              }
            }
          }
        }
        flashElement(extracted.containerEl, '#06b6d4');
        persistActiveProject().then(() => renderHud());
      } else {
        renderHud();
      }
      return;
    }

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

    // Check if the picked element is an HTML <table> or inside an HTML <table> / repeating list
    const tableCheck = extractPageTableOrListData(el);
    const detectedTable =
      tableCheck && tableCheck.ok && tableCheck.rows.length > 0
        ? {
            sourceType: tableCheck.sourceType,
            containerSelector: tableCheck.containerSelector,
            rowSelector: tableCheck.rowSelector,
            headers: tableCheck.headers,
            rows: tableCheck.rows
          }
        : null;

    // Get current dropdown value if it's a <select> or <option>
    let pickedDropdownVal = '';
    if (rawEl.tagName === 'OPTION') {
      pickedDropdownVal = rawEl.value || (rawEl.text || '').trim();
    } else if (selectEl) {
      const selOpt = selectEl.options?.[selectEl.selectedIndex];
      pickedDropdownVal = selectEl.value || (selOpt ? (selOpt.text || '').trim() : '');
    }

    // If the user clicked "🎯 Pick" for a specific branch or chained action (IF / THEN / ELSE) inside an open draft,
    // populate that branch action's selector (and dropdown value if it's a <select>) instead of replacing the entire draft!
    if (editingStepDraft && pickingBranchTarget) {
      const targetStr = String(pickingBranchTarget);
      editingStepDraft.options = editingStepDraft.options || {};
      if (detectedTable && !editingStepDraft.detectedTable) {
        editingStepDraft.detectedTable = detectedTable;
      }

      const isUniqueGlobal = Boolean(
        selector &&
        (selector.startsWith('#') || selector.includes('[id=')) &&
        validateSelectorClaim(selector, el).isUnique
      );
      const modalAncestor = el.closest(
        '.modal, .dialog, [role="dialog"], .popover, .popup, .dropdown-menu, .ui-dialog, [aria-modal="true"], .ant-modal, .ant-popover, .el-dialog, .MuiDialog-root, .MuiPopover-root, [class*="modal"], [class*="popover"], [class*="dialog"], [class*="popup"]'
      );
      const useRowRel = Boolean(
        !isUniqueGlobal &&
        !modalAncestor &&
        analysis.isRowRelative &&
        analysis.rowRelativeSelector &&
        (editingStepDraft.stepCsv?.sourceType === 'page_table' ||
          activeProject?.pageTableSource?.enabled ||
          detectedTable)
      );
      const effectivePickedSelector = useRowRel ? analysis.rowRelativeSelector : selector;

      if (targetStr === 'if') {
        editingStepDraft.selector = effectivePickedSelector;
        editingStepDraft.options.rowRelativeSelector = useRowRel ? (analysis.rowRelativeSelector || '') : '';
        editingStepDraft.options.isRowRelative = useRowRel;
        editingStepDraft.options.validationReport = analysis.validationReport;
        editingStepDraft.options.selectorStrategies = analysis.strategies;
        editingStepDraft.options.fallbackSelectors = analysis.fallbackSelectors;
      } else {
        // Format: "then:0:main", "then:0:nested_if", "then:0:nested_then", "then:0:nested_else", or legacy "then"/"else"
        const parts = targetStr.split(':');
        const branchKey = parts[0] === 'else' ? 'else' : 'then';
        const actIdx = parts.length > 1 ? Math.max(0, parseInt(parts[1], 10) || 0) : 0;
        const subRole = parts[2] || 'main';
        const actionsArr = ensureBranchActionsArray(editingStepDraft.options, branchKey);
        const actObj = actionsArr[actIdx] || { mode: 'click', selector: '', value: '' };
        actionsArr[actIdx] = actObj;

        if (subRole === 'nested_if') {
          actObj.selector = effectivePickedSelector;
          actObj.rowRelativeSelector = useRowRel ? (analysis.rowRelativeSelector || '') : '';
          actObj.isRowRelative = useRowRel;
        } else if (subRole === 'nested_then') {
          actObj.nestedThenSelector = effectivePickedSelector;
          actObj.nestedThenIsRowRelative = useRowRel;
          if (selectEl) {
            actObj.nestedThenMode = 'select';
            if (pickedDropdownVal) actObj.nestedThenValue = pickedDropdownVal;
          }
        } else if (subRole === 'nested_else') {
          actObj.nestedElseSelector = effectivePickedSelector;
          actObj.nestedElseIsRowRelative = useRowRel;
          if (selectEl) {
            actObj.nestedElseMode = 'select';
            if (pickedDropdownVal) actObj.nestedElseValue = pickedDropdownVal;
          }
        } else {
          actObj.selector = effectivePickedSelector;
          actObj.rowRelativeSelector = useRowRel ? (analysis.rowRelativeSelector || '') : '';
          actObj.isRowRelative = useRowRel;
          if (suggestedType === 'input' && actObj.mode !== 'input') {
            actObj.mode = 'input';
          }
          if (selectEl) {
            actObj.mode = 'select';
            if (pickedDropdownVal) {
              actObj.value = pickedDropdownVal;
            }
            const onLiveSelectChange = () => {
              if (editingStepDraft) {
                const chosenOpt = selectEl.options?.[selectEl.selectedIndex];
                actObj.value =
                  selectEl.value !== '' ? selectEl.value : (chosenOpt ? (chosenOpt.text || '').trim() : '');
                syncLegacyBranchesFromActions(editingStepDraft.options);
                renderHud();
              }
            };
            selectEl.addEventListener('change', onLiveSelectChange, { once: true });
          }
        }
        syncLegacyBranchesFromActions(editingStepDraft.options);
      }
      pickingBranchTarget = null;
      flashElement(el, '#10b981');
      renderHud();
      return;
    }

    const isUniqueGlobalMain = Boolean(
      selector &&
      (selector.startsWith('#') || selector.includes('[id=')) &&
      validateSelectorClaim(selector, el).isUnique
    );
    const modalAncestorMain = el.closest(
      '.modal, .dialog, [role="dialog"], .popover, .popup, .dropdown-menu, .ui-dialog, [aria-modal="true"], .ant-modal, .ant-popover, .el-dialog, .MuiDialog-root, .MuiPopover-root, [class*="modal"], [class*="popover"], [class*="dialog"], [class*="popup"]'
    );
    const useRowRelForMain = Boolean(
      !isUniqueGlobalMain &&
      !modalAncestorMain &&
      analysis.isRowRelative &&
      analysis.rowRelativeSelector &&
      activeProject?.pageTableSource?.enabled
    );
    const initialMainSelector = useRowRelForMain ? analysis.rowRelativeSelector : selector;

    editingStepDraft = {
      isNew: true,
      id: 'step_' + Date.now(),
      name: `${formatActionVerb(suggestedType)} ${labelSnippet}`.trim(),
      type: suggestedType,
      selector: initialMainSelector,
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
        rowRelativeSelector: useRowRelForMain ? (analysis.rowRelativeSelector || '') : '',
        isRowRelative: useRowRelForMain,
        thenBranch: {
          mode: 'click',
          selector: initialMainSelector,
          rowRelativeSelector: useRowRelForMain ? (analysis.rowRelativeSelector || '') : '',
          isRowRelative: useRowRelForMain,
          value: '',
          targetStepNumber: '',
          pressEnter: false
        },
        elseBranch: { mode: 'continue', selector: '', value: '', targetStepNumber: '', pressEnter: false },
        thenActions: [
          {
            mode: 'click',
            selector: initialMainSelector,
            rowRelativeSelector: useRowRelForMain ? (analysis.rowRelativeSelector || '') : '',
            isRowRelative: useRowRelForMain,
            value: '',
            targetStepNumber: '',
            pressEnter: false
          }
        ],
        elseActions: [
          { mode: 'continue', selector: '', value: '', targetStepNumber: '', pressEnter: false }
        ],
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
        sourceType: 'csv_file',
        mode: 'sequence_row',
        fileName: '',
        headers: [],
        rows: [],
        columnName: ''
      },
      detectedTable
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
   * Builds a concise, specific selector snippet for an element using its ID, name, class, or attributes.
   * Prevents degrading into a generic tag like "input".
   */
  function buildElementSpecificSnippet(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();

    // 1. Clean unique or non-numeric ID
    if (el.id && !/^\d+$/.test(el.id) && !/\d{4,}/.test(el.id) && !/\(\d+\)/.test(el.id)) {
      return `#${CSS.escape(el.id)}`;
    }

    // 2. High-priority unique attributes: data-testid, data-test, data-qa, data-cy, name
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name']) {
      const val = el.getAttribute(attr);
      if (val && !/\d{4,}/.test(val) && !/\(\d+\)/.test(val)) {
        return `${tag}[${attr}="${escapeAttrVal(val)}"]`;
      }
    }

    // 3. Meaningful classes
    const validClasses = Array.from(el.classList || []).filter(
      (c) => c.length > 1 && !/^(active|hover|focus|selected|open|disabled|ng-|css-|sc-|tw-|\d)/.test(c)
    );
    if (validClasses.length > 0) {
      return `${tag}.${validClasses.slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
    }

    // 4. Type or placeholder for inputs
    if (tag === 'input' || tag === 'textarea') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.length < 50) {
        return `${tag}[placeholder="${escapeAttrVal(placeholder)}"]`;
      }
      const type = el.getAttribute('type');
      if (type && type !== 'text') {
        return `${tag}[type="${escapeAttrVal(type)}"]`;
      }
    }

    // 5. Aria-label or title
    const aria = el.getAttribute('aria-label') || el.getAttribute('title');
    if (aria && aria.length < 60) {
      return `${tag}[aria-label="${escapeAttrVal(aria)}"]`;
    }

    return tag;
  }

  /**
   * Builds a CSS selector relative to the enclosing table/list row (`<tr>`, `[role="row"]`, `<li>`, or repeating row div)
   * so that an element picked on Row #8 (e.g. `td:nth-of-type(3) a`) automatically resolves on Row #1, #2, ..., #N.
   */
  function buildRowRelativeSelector(el, detectedDynamicAttr = null) {
    if (!el || el.nodeType !== 1) return { isRowRelative: false, rowRelativeSelector: '' };

    // 0. Check if element is inside a popup / modal / dialog
    const modalAncestor = el.closest(
      '.modal, .dialog, [role="dialog"], .popover, .popup, .dropdown-menu, .ui-dialog, [aria-modal="true"], .ant-modal, .ant-popover, .el-dialog, .MuiDialog-root, .MuiPopover-root, [class*="modal"], [class*="popover"], [class*="dialog"], [class*="popup"]'
    );
    if (modalAncestor) {
      // Element is inside a popup/modal dialog: NOT a table-row-relative element!
      const specificSel = buildElementSpecificSnippet(el);
      return { isRowRelative: false, rowRelativeSelector: specificSel };
    }

    // If element has a clean, globally unique ID on the page, prefer global ID over row-relative
    if (el.id && !/^\d+$/.test(el.id) && !/\d{4,}/.test(el.id) && !/\(\d+\)/.test(el.id)) {
      const idSel = `#${CSS.escape(el.id)}`;
      try {
        if (document.querySelectorAll(idSel).length === 1) {
          return { isRowRelative: false, rowRelativeSelector: idSel };
        }
      } catch (_) {}
    }

    let rowEl = el.closest('tr, [role="row"], li');
    if (!rowEl) {
      // Check if project has a pageTableSource or if el is inside a repeating list row
      const tbl = extractPageTableOrListData(el);
      if (tbl && tbl.ok && tbl.containerEl) {
        try {
          const rows = Array.from(tbl.containerEl.querySelectorAll(tbl.rowSelector || 'tbody tr, tr'));
          rowEl = rows.find((r) => r === el || r.contains(el)) || null;
        } catch (_) {}
      }
    }
    if (!rowEl) return { isRowRelative: false, rowRelativeSelector: '' };
    if (el === rowEl) return { isRowRelative: true, rowRelativeSelector: ':scope' };

    const tag = el.tagName.toLowerCase();
    const specificTag = buildElementSpecificSnippet(el);
    const suffixPart =
      detectedDynamicAttr && detectedDynamicAttr.suffixToken
        ? `[${detectedDynamicAttr.attrName}$="${escapeAttrVal(detectedDynamicAttr.suffixToken)}"]`
        : '';

    const cellEl = el.closest('td, th, [role="cell"], [role="gridcell"]');
    if (cellEl && rowEl.contains(cellEl)) {
      const cellTag = cellEl.tagName.toLowerCase();
      const sameTagCells = Array.from(rowEl.children).filter((c) => c.tagName.toLowerCase() === cellTag);
      const colIdx = sameTagCells.indexOf(cellEl) + 1;
      const cellSel = colIdx > 0 ? `${cellTag}:nth-of-type(${colIdx})` : cellTag;
      if (el === cellEl) {
        return { isRowRelative: true, rowRelativeSelector: cellSel };
      }

      // Try specific selector candidates inside the cell before falling back to bare tag
      const candidates = [
        specificTag.startsWith('#') ? specificTag : `${cellSel} ${specificTag}${suffixPart}`,
        `${cellSel} ${tag}${suffixPart}`,
        specificTag,
        `${cellSel} ${tag}`
      ];

      for (const cand of candidates) {
        try {
          const matches = Array.from(rowEl.querySelectorAll(cand));
          if (matches.length === 1 && matches[0] === el) {
            return { isRowRelative: true, rowRelativeSelector: cand };
          }
        } catch (_) {}
      }
      return { isRowRelative: true, rowRelativeSelector: candidates[0] };
    }

    // Repeating div/li row without <td>: build path relative to rowEl
    const relParts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== rowEl && depth < 5) {
      let part = cur === el ? buildElementSpecificSnippet(cur) : cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent && cur !== el && !part.startsWith('#')) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) {
          part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        }
      }
      relParts.unshift(part);
      const relCand = relParts.join(' > ');
      try {
        const m = Array.from(rowEl.querySelectorAll(relCand));
        if (m.length === 1 && m[0] === el) {
          return { isRowRelative: true, rowRelativeSelector: relCand };
        }
      } catch (_) {}
      cur = parent;
      depth++;
    }
    return {
      isRowRelative: relParts.length > 0,
      rowRelativeSelector: relParts.join(' > ')
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
        rowRelativeSelector: '',
        isRowRelative: false,
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

    const rowRelInfo = buildRowRelativeSelector(el, detectedDynamicAttr);

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
        const tableColSel =
          el === parentTd
            ? `tr ${parentTd.tagName.toLowerCase()}:nth-of-type(${colIdx})`
            : `tr td:nth-of-type(${colIdx}) ${tag}${suffixPart}`;
        rawCandidates.push({
          strategy: 'table_col',
          label: `Table Col #${colIdx} (Row-Relative)`,
          selector: rowRelInfo.rowRelativeSelector || tableColSel,
          reason: `Table column ${colIdx} inside current row`
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

    // 1. Prefer unique ID selector (#PurchaseOrderShipDate) above all
    const uniqueId = validatedStrategies.find(
      (s) => s.strategy === 'standard' && s.selector.startsWith('#') && s.isUnique
    );
    // 2. If a wildcard or suffix strategy uniquely matches (1 match on page)
    const uniqueWildcard = validatedStrategies.find(
      (s) => (s.strategy === 'wildcard' || s.strategy === 'suffix') && s.isUnique
    );
    const anyWildcard = validatedStrategies.find(
      (s) => s.strategy === 'wildcard' || s.strategy === 'suffix'
    );

    if (uniqueId) {
      chosen = uniqueId;
    } else if (uniqueWildcard) {
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

    const fallbackSelectors = Array.from(
      new Set(
        [
          rowRelInfo.rowRelativeSelector,
          ...validatedStrategies.map((s) => s.selector)
        ].filter((sel) => sel && sel !== chosen.selector)
      )
    );

    return {
      primarySelector: chosen.selector,
      rowRelativeSelector: rowRelInfo.rowRelativeSelector || '',
      isRowRelative: Boolean(rowRelInfo.isRowRelative),
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
          checkTimeout,
          step.pageTableConfig || null
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
      const branchActions = ensureBranchActionsArray(options, evalRes.passed ? 'then' : 'else');
      let lastRes = {
        ok: true,
        verifyPassed: evalRes.passed,
        verifyReason: evalRes.reason,
        actualValue: evalRes.actualValue,
        stepOutput: evalRes.actualValue
      };

      const runSingleBranchAction = async (act, idxSuffix) => {
        const bMode = act.mode || 'continue';
        if (bMode === 'wait') {
          const sec = parseFloat(act.resolvedValue ?? act.value) || 1;
          await new Promise((r) => setTimeout(r, Math.min(sec * 1000, 30000)));
          return { ok: true };
        }
        if (['click', 'input', 'select', 'extract', 'keypress'].includes(bMode)) {
          const bSel = act.resolvedSelector || act.selector || selector;
          const bVal = act.resolvedValue !== undefined ? act.resolvedValue : (act.value || '');
          const res = await executeDomStep({
            id: `${step.id}_branch_${idxSuffix}`,
            type: bMode,
            selector: bSel,
            resolvedSelector: bSel,
            value: bVal,
            resolvedValue: bVal,
            resolvedRowAnchor: rowAnchor,
            pageTableConfig: step.pageTableConfig || null,
            options: {
              clearFirst: true,
              pressEnter: Boolean(act.pressEnter),
              extractTarget: act.extractTarget || 'text',
              outputColumn: act.outputColumn || 'Branch_Output'
            }
          });
          await new Promise((r) => setTimeout(r, 350));
          return res;
        }
        if (bMode === 'nested_if') {
          const nSource = act.ifSource || 'csv_or_var';
          const nCondOp = act.verifyCondition || 'contains';
          const nExpected = act.resolvedValue !== undefined ? act.resolvedValue : (act.value || '');
          let nEval = { passed: false };
          if (nSource === 'csv_or_var') {
            const nLeft = act.resolvedLeftValue !== undefined ? act.resolvedLeftValue : (act.ifLeftValue || '');
            nEval = window.FlowTagCSV.evaluateVerification(nLeft, nCondOp, nExpected, false);
          } else {
            const nSel = act.resolvedSelector || act.selector || selector;
            const nLookup = await waitForElementSmart(nSel, [], rowAnchor, 2000, step.pageTableConfig || null);
            const nText = nLookup.element ? readElementContentByTarget(nLookup.element, 'text', '') : '';
            nEval = window.FlowTagCSV.evaluateVerification(nText, nCondOp, nExpected, false);
          }
          const subMode = nEval.passed ? (act.nestedThenMode || 'click') : (act.nestedElseMode || 'continue');
          const subSel = nEval.passed
            ? (act.resolvedNestedThenSelector || act.nestedThenSelector || selector)
            : (act.resolvedNestedElseSelector || act.nestedElseSelector || selector);
          const subVal = nEval.passed
            ? (act.resolvedNestedThenValue !== undefined ? act.resolvedNestedThenValue : (act.nestedThenValue || ''))
            : (act.resolvedNestedElseValue !== undefined ? act.resolvedNestedElseValue : (act.nestedElseValue || ''));
          const subEnter = nEval.passed ? Boolean(act.nestedThenPressEnter) : Boolean(act.nestedElsePressEnter);
          if (['click', 'input', 'select', 'keypress'].includes(subMode)) {
            return runSingleBranchAction(
              {
                mode: subMode,
                selector: subSel,
                resolvedSelector: subSel,
                value: subVal,
                resolvedValue: subVal,
                pressEnter: subEnter
              },
              `${idxSuffix}_nested`
            );
          }
          return { ok: true };
        }
        if (bMode === 'navigate' && act.value) {
          const bUrl = act.resolvedValue || act.value;
          window.location.href = /^https?:\/\//i.test(bUrl) ? bUrl : 'https://' + bUrl;
        }
        return { ok: true };
      };

      for (let aIdx = 0; aIdx < branchActions.length; aIdx++) {
        const act = branchActions[aIdx];
        if (!act || ['continue', 'none', 'skip_row', 'skip_next', 'jump_to_step', 'stop_workflow'].includes(act.mode)) {
          break;
        }
        lastRes = await runSingleBranchAction(act, aIdx);
      }
      return lastRes;
    }

    // Locate target element using Multi-Strategy Self-Healing Selector + optional Row Anchor / Page Table Row
    const lookup = await waitForElementSmart(
      selector,
      options.fallbackSelectors || [],
      rowAnchor,
      timeoutMs,
      step.pageTableConfig || null
    );
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
   * Resolves a selector inside a specific row element (`<tr>`, `[role="row"]`, `<li>`, or repeating row div),
   * automatically stripping any leading table/row path (like `tbody > tr:nth-of-type(8) > td:nth-of-type(3) > a`
   * or `tr td:nth-of-type(3) a`) so that selectors picked on one row work on every row!
   */
  function queryWithinRowSmart(rowEl, rawSel) {
    if (!rowEl || !rawSel) return null;
    const trimmed = String(rawSel).trim();
    if (!trimmed) return null;
    if (trimmed === ':scope') return rowEl;

    const candidates = [];
    // 1. Strip anything up to and including `tr(...) >` or `tr ` or `[role="row"](...) >`
    const strippedTrArrow = trimmed.replace(/^.*?\btr(?::nth-[a-z-]+\(\d+\)|\.[a-zA-Z0-9_-]+)*\s*>\s*/i, '');
    if (strippedTrArrow && strippedTrArrow !== trimmed) {
      candidates.push(strippedTrArrow);
    }
    const strippedTrSpace = trimmed.replace(/^.*?\btr(?::nth-[a-z-]+\(\d+\)|\.[a-zA-Z0-9_-]+)*\s+/i, '');
    if (strippedTrSpace && strippedTrSpace !== trimmed && !candidates.includes(strippedTrSpace)) {
      candidates.push(strippedTrSpace);
    }
    // 2. Also strip up to `td:nth-of-type(...)` if present deeper in a path
    const tdMatch = trimmed.match(/((?:td|th)(?::nth-[a-z-]+\(\d+\))?.*)$/i);
    if (tdMatch && tdMatch[1] && !candidates.includes(tdMatch[1])) {
      candidates.push(tdMatch[1]);
    }
    candidates.push(trimmed);

    for (const c of candidates) {
      try {
        const found = rowEl.querySelector(c);
        if (found) return found;
      } catch (_) {}
    }
    try {
      if (rowEl.matches(trimmed)) return rowEl;
    } catch (_) {}
    return null;
  }

  /**
   * Smart element resolver with:
   * - Optional Row Anchor Scoping (`rowAnchorText` finds the `<tr>` / row container containing that text)
   * - Primary selector lookup
   * - Saved fallback selectors lookup
   * - Runtime auto-derived wildcard fallbacks (so even legacy steps with hardcoded IDs self-heal!)
   */
  async function waitForElementSmart(
    primarySelector,
    savedFallbacks = [],
    rowAnchorText = '',
    timeoutMs = 8000,
    pageTableConfig = null
  ) {
    if (!primarySelector) return { element: null, matchedSelector: '' };

    const derivedFallbacks = deriveRuntimeWildcardFallbacks(primarySelector);
    const candidateSelectors = Array.from(
      new Set([primarySelector, ...(savedFallbacks || []), ...derivedFallbacks].filter(Boolean))
    );

    const cleanAnchor =
      rowAnchorText && !String(rowAnchorText).includes('{{') ? String(rowAnchorText).trim() : '';

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let tableContainerEl = null;
      let nthRowEl = null;

      // 1. If a Page Table / HTML List Data Source is active for this row, try scoping to the Nth HTML row first!
      if (pageTableConfig && pageTableConfig.containerSelector) {
        try {
          tableContainerEl = document.querySelector(pageTableConfig.containerSelector);
        } catch (_) {}
        nthRowEl = findNthPageTableRowElement(pageTableConfig);
        if (nthRowEl) {
          for (const sel of candidateSelectors) {
            const scopedEl = queryWithinRowSmart(nthRowEl, sel);
            if (scopedEl) {
              return { element: scopedEl, matchedSelector: sel };
            }
          }
        }
      }

      // 2. Standard Row Anchor Text scoping (or full document lookup)
      let queryRoot = document;
      if (cleanAnchor) {
        const rowContainer = findRowContainerByAnchorText(cleanAnchor);
        if (rowContainer) {
          queryRoot = rowContainer;
          for (const sel of candidateSelectors) {
            const scopedEl = queryWithinRowSmart(rowContainer, sel);
            if (scopedEl) {
              return { element: scopedEl, matchedSelector: sel };
            }
          }
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
            // If we are scoped to nthRowEl of a Page Table, do NOT accidentally return an element from a DIFFERENT row of the same table!
            // (Elements outside the table—such as a modal dialog or page button—are allowed.)
            if (tableContainerEl && nthRowEl && tableContainerEl.contains(el) && !nthRowEl.contains(el)) {
              continue;
            }
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

    if (pickingTableSourceMode) {
      const extracted = extractPageTableOrListData(el);
      const targetContainer = (extracted && extracted.ok && extracted.containerEl) ? extracted.containerEl : el;
      const rect = targetContainer.getBoundingClientRect();
      const rowCnt = extracted && extracted.ok ? extracted.rows.length : 0;
      const colCnt = extracted && extracted.ok ? extracted.headers.length : 0;
      const selPreview = extracted && extracted.ok ? extracted.containerSelector : generateSmartSelector(targetContainer);

      box.style.cssText = `
        position: fixed;
        top: ${Math.max(0, rect.top - 3)}px;
        left: ${Math.max(0, rect.left - 3)}px;
        width: ${rect.width + 6}px;
        height: ${rect.height + 6}px;
        border: 2.5px dashed #06b6d4;
        background: rgba(6, 182, 212, 0.14);
        border-radius: 6px;
        pointer-events: none;
        z-index: 2147483646;
        box-sizing: border-box;
        transition: all 0.05s ease-out;
      `;
      box.innerHTML = `
        <div style="
          position: absolute;
          top: ${rect.top < 32 ? rect.height + 6 : -28}px;
          left: 0;
          background: #083344;
          color: #ecfeff;
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 11px;
          padding: 4px 9px;
          border-radius: 5px;
          white-space: nowrap;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          border: 1px solid #06b6d4;
        ">
          <span style="color:#22d3ee;font-weight:700;">🌐 HTML ${extracted?.sourceType === 'list' ? 'Repeating List' : 'Table'}:</span>
          <span style="color:#cffafe;margin-left:4px;">${escapeHtml(String(selPreview).slice(0, 38))}</span>
          <span style="color:#34d399;margin-left:6px;font-weight:700;">(${rowCnt} rows × ${colCnt} cols — Click to Use!)</span>
        </div>
      `;
      return;
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

  function getAvailableColumnsForDraft() {
    const colSet = new Set();
    if (activeProject?.masterCsv?.headers) {
      activeProject.masterCsv.headers.forEach((h) => colSet.add(h));
    }
    if (activeProject?.steps) {
      activeProject.steps.forEach((st) => {
        if (st.stepCsv?.headers) {
          st.stepCsv.headers.forEach((h) => colSet.add(h));
        }
      });
    }
    if (editingStepDraft?.stepCsv?.headers) {
      editingStepDraft.stepCsv.headers.forEach((h) => colSet.add(h));
    }
    if (editingStepDraft?.detectedTable?.headers) {
      editingStepDraft.detectedTable.headers.forEach((h) => colSet.add(h));
    }
    return Array.from(colSet);
  }

  function generateFormulaSuggestions(columns = [], query = '') {
    const list = [];
    const qLower = query.toLowerCase().trim();

    for (const col of columns) {
      if (!col) continue;
      const isDate = /date|esd|time|day|ship|submitted|order|due/i.test(col);
      const isNum = /qty|quantity|price|amount|total|cost|rate|num|count/i.test(col);

      const formulas = [
        {
          formula: `({{${col}}} + next business day)`,
          label: 'Next Business Day',
          tag: '📅 Date',
          priority: isDate ? 10 : 3
        },
        {
          formula: `({{${col}}} + 1 day)`,
          label: '+1 Calendar Day',
          tag: '📅 Date',
          priority: isDate ? 9 : 2
        },
        {
          formula: `({{${col}}} + 2 days)`,
          label: '+2 Calendar Days',
          tag: '📅 Date',
          priority: isDate ? 8 : 1
        },
        {
          formula: `({{${col}}} + 3 business days)`,
          label: '+3 Business Days',
          tag: '📅 Date',
          priority: isDate ? 7 : 1
        },
        {
          formula: `({{${col}}} - 1 day)`,
          label: '-1 Calendar Day',
          tag: '📅 Date',
          priority: isDate ? 6 : 1
        },
        {
          formula: `({{${col}}} + 1)`,
          label: '+1 (Day or Math)',
          tag: isDate ? '📅 Date' : '🧮 Math',
          priority: isDate || isNum ? 8 : 2
        },
        {
          formula: `({{${col}}} - 1)`,
          label: '-1 (Day or Math)',
          tag: isDate ? '📅 Date' : '🧮 Math',
          priority: isDate || isNum ? 7 : 2
        }
      ];

      if (isNum) {
        formulas.push(
          {
            formula: `({{${col}}} * 1.1)`,
            label: 'Multiply * 1.1 (+10%)',
            tag: '🧮 Math',
            priority: 6
          },
          {
            formula: `({{${col}}} / 2)`,
            label: 'Divide / 2',
            tag: '🧮 Math',
            priority: 5
          }
        );
      }

      list.push(...formulas);
    }

    list.sort((a, b) => b.priority - a.priority);

    if (qLower) {
      return list.filter(
        (item) =>
          item.formula.toLowerCase().includes(qLower) ||
          item.label.toLowerCase().includes(qLower)
      );
    }
    return list;
  }

  function setupFormulaAutocomplete(inputEl, menuEl, getColumnsFn, onSelectFn) {
    if (!inputEl || !menuEl) return;
    let activeIdx = -1;
    let currentMatches = [];

    const hideMenu = () => {
      menuEl.style.display = 'none';
      menuEl.innerHTML = '';
      activeIdx = -1;
      currentMatches = [];
    };

    const updateMenu = () => {
      const val = inputEl.value || '';
      const cursor = inputEl.selectionStart ?? val.length;
      const textBefore = val.slice(0, cursor);
      const openIdx = textBefore.lastIndexOf('(');

      if (openIdx === -1) {
        hideMenu();
        return;
      }

      const textBetween = textBefore.slice(openIdx + 1);
      if (textBetween.includes(')')) {
        hideMenu();
        return;
      }

      const rawQuery = textBetween
        .replace(/^\{\{\s*|\s*\}\}$/g, '')
        .replace(/^[+*\-\/]\s*/, '')
        .trim();
      const cols = getColumnsFn();
      const suggestions = generateFormulaSuggestions(cols, rawQuery);

      if (!suggestions || suggestions.length === 0) {
        hideMenu();
        return;
      }

      currentMatches = suggestions.slice(0, 8);
      activeIdx = 0;

      menuEl.innerHTML = `
        <div class="ft-autocomplete-header">
          <span>🧮 FORMULA AUTOCOMPLETE</span>
          <span style="font-size:9px;color:#94a3b8;">↑↓ to navigate, Enter to pick</span>
        </div>
        ${currentMatches
          .map(
            (item, idx) => `
          <div class="ft-autocomplete-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}">
            <div style="display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              <span style="color:#67e8f9;font-weight:600;">${escapeHtml(item.formula)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
              <span class="desc">${escapeHtml(item.label)}</span>
              <span style="font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.08);color:#cbd5e1;">${escapeHtml(item.tag)}</span>
            </div>
          </div>
        `
          )
          .join('')}
      `;
      menuEl.style.display = 'block';

      menuEl.querySelectorAll('.ft-autocomplete-item').forEach((itemEl) => {
        itemEl.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const idx = parseInt(itemEl.getAttribute('data-idx'), 10);
          selectItem(idx);
        });
      });
    };

    const selectItem = (idx) => {
      const chosen = currentMatches[idx];
      if (!chosen) return;
      const val = inputEl.value || '';
      const cursor = inputEl.selectionStart ?? val.length;
      const textBefore = val.slice(0, cursor);
      const textAfter = val.slice(cursor);
      const openIdx = textBefore.lastIndexOf('(');

      const closeIdx = textAfter.indexOf(')');
      const remainderAfter = closeIdx !== -1 ? textAfter.slice(closeIdx + 1) : textAfter;
      const remainderBefore = openIdx !== -1 ? textBefore.slice(0, openIdx) : textBefore;

      const newVal = remainderBefore + chosen.formula + remainderAfter;
      inputEl.value = newVal;
      const newCursor = remainderBefore.length + chosen.formula.length;
      inputEl.setSelectionRange(newCursor, newCursor);
      hideMenu();

      if (onSelectFn) {
        onSelectFn(newVal);
      } else {
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };

    inputEl.addEventListener('input', updateMenu);
    inputEl.addEventListener('focus', updateMenu);

    inputEl.addEventListener('keydown', (e) => {
      if (menuEl.style.display !== 'block') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % currentMatches.length;
        renderActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = (activeIdx - 1 + currentMatches.length) % currentMatches.length;
        renderActive();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (activeIdx >= 0 && activeIdx < currentMatches.length) {
          e.preventDefault();
          selectItem(activeIdx);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideMenu();
      }
    });

    const renderActive = () => {
      menuEl.querySelectorAll('.ft-autocomplete-item').forEach((el, idx) => {
        if (idx === activeIdx) {
          el.classList.add('active');
          el.scrollIntoView({ block: 'nearest' });
        } else {
          el.classList.remove('active');
        }
      });
    };

    inputEl.addEventListener('blur', () => {
      setTimeout(hideMenu, 220);
    });
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
        .ft-formula-pill {
          background: rgba(56, 189, 248, 0.14) !important;
          color: #7dd3fc !important;
          border-color: rgba(56, 189, 248, 0.38) !important;
        }
        .ft-formula-pill:hover {
          background: rgba(56, 189, 248, 0.28) !important;
          border-color: #38bdf8 !important;
        }
        .ft-autocomplete-menu {
          position: absolute;
          top: calc(100% + 3px);
          left: 0;
          right: 0;
          z-index: 9999999;
          background: #090d16;
          border: 1px solid #38bdf8;
          border-radius: 6px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.7);
          max-height: 210px;
          overflow-y: auto;
          display: none;
        }
        .ft-autocomplete-header {
          padding: 4px 8px;
          font-size: 9.5px;
          font-weight: 700;
          color: #38bdf8;
          border-bottom: 1px solid #1e293b;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #111827;
        }
        .ft-autocomplete-item {
          padding: 5px 8px;
          cursor: pointer;
          font-size: 11px;
          font-family: monospace;
          color: #f1f5f9;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .ft-autocomplete-item:hover, .ft-autocomplete-item.active {
          background: rgba(56, 189, 248, 0.22);
          color: #38bdf8;
        }
        .ft-autocomplete-item .desc {
          font-size: 9.5px;
          font-family: sans-serif;
          color: #94a3b8;
          margin-left: 6px;
        }
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
    const pts = activeProject?.pageTableSource;
    const hasPageTable = Boolean(pts && pts.enabled && pts.containerSelector);

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
              ? pickingTableSourceMode
                ? '🌐 Click Any Table / List on Page... (ESC to cancel)'
                : '🎯 Click Any Element on Page... (ESC to cancel)'
              : pickDelayRemaining > 0
              ? `⏳ Picker starting in ${pickDelayRemaining}s... Open your modal now!`
              : '🎯 Pick Element on Page to Map Step'
          }
        </button>
        <button class="ft-btn ft-btn-secondary" id="ft-btn-pick-delay-toggle" title="Starts a 3-second countdown before activating picker so you can open any popup, dropdown, or modal first!">
          ⏱️ 3s Delay Pick
        </button>
        <button class="ft-btn ft-btn-secondary" id="ft-btn-add-url-step">
          + Go to Current URL
        </button>
        <button class="ft-btn ft-btn-secondary" id="ft-btn-add-manual-step">
          + Manual Step
        </button>
      </div>

      ${
        hasPageTable
          ? `
        <div style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.45);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:5px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <span style="font-size:10.5px;font-weight:800;color:#22d3ee;text-transform:uppercase;">
              🌐 Page ${pts.sourceType === 'list' ? 'List' : 'Table'} Data Source Active (${pts.sampleRowCount ?? (activeProject.masterCsv?.rows?.length || 0)} rows)
            </span>
            <div style="display:flex;gap:4px;">
              <button class="ft-mini-btn" id="ft-btn-rescan-table-source" style="color:#67e8f9;border-color:#06b6d4;" title="Re-read live rows from this table on the page">🔄 Re-Scan</button>
              <button class="ft-mini-btn" id="ft-btn-clear-table-source" style="color:#fca5a5;" title="Remove Page Table Data Source">✕</button>
            </div>
          </div>
          <div style="font-size:10.5px;color:#cbd5e1;font-family:monospace;">
            Container: <b>${escapeHtml(pts.containerSelector)}</b> · Rows: <b>${escapeHtml(pts.rowSelector || 'tr')}</b>
          </div>
          <div style="font-size:10px;color:#94a3b8;">
            Columns mapped: ${(pts.headers || []).map((h) => `<code style="color:#67e8f9;">{{${escapeHtml(h)}}}</code>`).join(', ')}
          </div>
        </div>
      `
          : ''
      }

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
    const usesTable = projectUsesPageTable(activeProject, editingStepDraft);
    const refCsv = findExistingProjectCsv();
    const refDesc = refCsv
      ? `${refCsv.fileName || 'Reference CSV'} (${refCsv.rows?.length || 0} rows)`
      : 'None (Single run)';

    if (usesTable) {
      const tableSel =
        activeProject?.pageTableSource?.containerSelector ||
        editingStepDraft?.stepCsv?.containerSelector ||
        'table';
      const rowCnt =
        activeProject?.pageTableSource?.sampleRowCount ||
        activeProject?.masterCsv?.rows?.length ||
        editingStepDraft?.stepCsv?.rows?.length ||
        0;
      return `
        <div class="ft-card" style="border-color:#06b6d4;background:#0f172a;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11.5px;font-weight:700;color:#22d3ee;">
              ▶ Run Workflow — 🌐 Live Page Table Source
            </span>
            <button class="ft-mini-btn" id="ft-run-launch-cancel">Cancel</button>
          </div>

          <div style="font-size:11px;color:#cbd5e1;line-height:1.45;">
            This workflow uses the <b>HTML Table / List on the webpage</b> (<code style="color:#67e8f9;">${escapeHtml(tableSel)}</code> · <b>${rowCnt} rows</b>). No CSV file upload is needed—Domuto will read the rows directly from this page!
          </div>

          <button class="ft-btn ft-btn-success" id="ft-btn-confirm-start-run" style="width:100%;padding:9px;background:#0891b2;">
            🚀 Start Run on Live Page Table (${rowCnt || 'All'} rows)
          </button>
        </div>
      `;
    }

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
    draft.options = draft.options || {};
    const ifSource = draft.options?.ifSource || (draft.selector ? 'dom_element' : 'csv_or_var');
    const needsSelector =
      draft.type === 'condition'
        ? ifSource === 'dom_element'
        : !['navigate', 'wait'].includes(draft.type) || (draft.type === 'wait' && draft.options?.waitMode === 'element');
    const stepCsv = draft.stepCsv || { enabled: false, mode: 'sequence_row', headers: [], rows: [] };
    if (!stepCsv.mode || stepCsv.mode === 'match_row') stepCsv.mode = 'sequence_row';
    const allStepCols = stepCsv.enabled && Array.isArray(stepCsv.headers) ? stepCsv.headers : [];
    const combinedCols = Array.from(new Set([...masterColumns, ...allStepCols]));
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

    const thenActions = ensureBranchActionsArray(draft.options, 'then');
    const elseActions = ensureBranchActionsArray(draft.options, 'else');

    const renderSingleChainedActionHtml = (prefix, actObj, actIdx, totalCount, colorHex) => {
      const bMode = actObj.mode || (prefix === 'then' ? 'click' : 'continue');
      const bNeedsSel = ['click', 'input', 'select', 'extract', 'keypress'].includes(bMode);
      const bNeedsVal = ['input', 'select', 'navigate', 'wait', 'keypress'].includes(bMode);
      const bNeedsOutCol = bMode === 'extract';
      const bNeedsJump = bMode === 'jump_to_step';
      const pickKeyMain = `${prefix}:${actIdx}:main`;
      const isRowRel = Boolean(
        (actObj.isRowRelative ||
          (actObj.selector && /^(?:td|th)(?::nth-[a-z-]+\(\d+\))?/i.test(actObj.selector.trim()))) &&
        !(actObj.selector && (actObj.selector.startsWith('#') || actObj.selector.includes('[id=')))
      );

      return `
        <div style="background:#1e293b;border:1px solid #334155;border-left:3px solid ${colorHex};border-radius:6px;padding:6px 7px;display:flex;flex-direction:column;gap:5px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:5px;">
            <span style="font-size:10px;font-weight:800;color:${colorHex};white-space:nowrap;">
              #${actIdx + 1}
            </span>
            <select class="ft-select" data-chain-mode="${prefix}:${actIdx}" style="width:auto;flex:1;font-size:10.5px;padding:3px 5px;">
              <option value="click" ${bMode === 'click' ? 'selected' : ''}>👆 Click Element (on Row / Page)</option>
              <option value="input" ${bMode === 'input' ? 'selected' : ''}>⌨️ Type / Fill Input</option>
              <option value="select" ${bMode === 'select' ? 'selected' : ''}>▾ Select Dropdown Option</option>
              <option value="wait" ${bMode === 'wait' ? 'selected' : ''}>⏱ Wait / Delay (Seconds)</option>
              <option value="keypress" ${bMode === 'keypress' ? 'selected' : ''}>⏎ Press Keyboard Key</option>
              <option value="extract" ${bMode === 'extract' ? 'selected' : ''}>📋 Extract Data to Column</option>
              <option value="nested_if" ${bMode === 'nested_if' ? 'selected' : ''}>🔀 Nested IF / THEN Condition</option>
              <option value="continue" ${bMode === 'continue' ? 'selected' : ''}>↪ Continue to Next Step</option>
              <option value="skip_row" ${bMode === 'skip_row' ? 'selected' : ''}>⏭ Skip Rest of Row</option>
              <option value="skip_next" ${bMode === 'skip_next' ? 'selected' : ''}>⏭ Skip Next 1 Step</option>
              <option value="jump_to_step" ${bMode === 'jump_to_step' ? 'selected' : ''}>🔢 Jump to Step #</option>
              <option value="navigate" ${bMode === 'navigate' ? 'selected' : ''}>🌐 Go to URL</option>
              <option value="stop_workflow" ${bMode === 'stop_workflow' ? 'selected' : ''}>⏹ Stop Entire Workflow</option>
            </select>
            ${
              totalCount > 1
                ? `<div style="display:flex;gap:2px;">
                    <button class="ft-mini-btn" data-chain-move="${prefix}:${actIdx}:-1" ${actIdx === 0 ? 'disabled' : ''} title="Move Action Up">↑</button>
                    <button class="ft-mini-btn" data-chain-move="${prefix}:${actIdx}:1" ${actIdx === totalCount - 1 ? 'disabled' : ''} title="Move Action Down">↓</button>
                    <button class="ft-mini-btn" data-chain-del="${prefix}:${actIdx}" style="color:#f87171;" title="Remove Action">✕</button>
                   </div>`
                : ''
            }
          </div>

          ${
            bNeedsSel
              ? `<div>
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;gap:4px;">
                    <span style="font-size:9.5px;color:#94a3b8;display:flex;align-items:center;gap:4px;">
                      Target Selector:
                      ${
                        actObj.selector
                          ? `<span style="padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:${
                              isRowRel ? 'rgba(6,182,212,0.2)' : 'rgba(99,102,241,0.2)'
                            };color:${isRowRel ? '#67e8f9' : '#a5b4fc'};" title="${
                              isRowRel
                                ? 'Relative to the current table row (runs on whichever row matched)'
                                : 'Targets element across the page or popup modal'
                            }">${isRowRel ? '📍 Current Row' : '🌐 Page / Modal'}</span>`
                          : ''
                      }
                    </span>
                    <div style="display:flex;gap:3px;align-items:center;">
                      <button class="ft-mini-btn" data-pick-branch="${pickKeyMain}" style="color:#a5b4fc;border-color:#6366f1;">
                        ${pickingBranchTarget === pickKeyMain ? (pickDelayRemaining > 0 ? `⏳ ${pickDelayRemaining}s (Open modal now!)` : '🎯 Click element on page...') : '🎯 Pick'}
                      </button>
                      <button class="ft-mini-btn" data-pick-delay="${pickKeyMain}" style="color:#fcd34d;border-color:#f59e0b;" title="3-second countdown before picker activates so you can click to open a popup/modal first">
                        ⏱️ 3s Delay
                      </button>
                    </div>
                  </div>
                  <input class="ft-input" data-chain-field="${prefix}:${actIdx}:selector" value="${escapeHtml(actObj.selector || '')}" placeholder="e.g. td:nth-of-type(3) a, or modal input selector" style="font-family:monospace;font-size:10.5px;" />
                </div>`
              : ''
          }

          ${
            bNeedsVal
              ? (() => {
                  const targetSelForOpts = actObj.selector || draft.selector || '';
                  const pageDropdownOpts = bMode === 'select' ? getSelectOptionsFromSelector(targetSelForOpts) : [];
                  return `<div>
                  ${
                    pageDropdownOpts.length > 0
                      ? `<div style="margin-bottom:4px;">
                          <span style="font-size:10px;color:#34d399;font-weight:600;">▾ Pick Option from Page Dropdown (${pageDropdownOpts.length} found):</span>
                          <select class="ft-select" data-chain-opt-picker="${prefix}:${actIdx}" style="font-size:11px;margin-top:2px;border-color:#10b981;color:#d1fae5;">
                            <option value="">-- Choose Dropdown Option from Page --</option>
                            ${pageDropdownOpts
                              .map(
                                (o) =>
                                  `<option value="${escapeHtml(o.value !== '' ? o.value : o.text)}" ${
                                    actObj.value === (o.value !== '' ? o.value : o.text) || actObj.value === o.text
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
                  <span style="font-size:9.5px;color:#94a3b8;">${
                    bMode === 'navigate'
                      ? 'Target URL:'
                      : bMode === 'wait'
                      ? 'Wait Seconds (e.g. 0.5 or 2):'
                      : bMode === 'keypress'
                      ? 'Key to Press (Enter, Tab, Escape):'
                      : 'Value to Type / Select (supports {{Column}}):'
                  }</span>
                  <div style="position:relative;">
                    <input class="ft-input" data-chain-field="${prefix}:${actIdx}:value" value="${escapeHtml(actObj.value ?? (bMode === 'wait' ? '1' : bMode === 'keypress' ? 'Enter' : ''))}" placeholder="${
                      bMode === 'wait' ? '1' : bMode === 'keypress' ? 'Enter' : 'Static text, {{Col}}, or ({{Col}} + 1)'
                    }" style="font-size:11px;margin-top:2px;" autocomplete="off" />
                    <div class="ft-autocomplete-menu"></div>
                  </div>
                  ${
                    bMode === 'input'
                      ? `<label style="display:flex;align-items:center;gap:5px;font-size:10px;color:#cbd5e1;margin-top:3px;cursor:pointer;">
                          <input type="checkbox" data-chain-bool="${prefix}:${actIdx}:pressEnter" ${actObj.pressEnter ? 'checked' : ''} />
                          Press <b>Enter</b> after typing
                         </label>`
                      : ''
                  }
                  ${
                    combinedCols.length > 0 && ['input', 'select', 'navigate'].includes(bMode)
                      ? `<div class="ft-pills" style="margin-top:3px;">
                          ${combinedCols
                            .slice(0, 6)
                            .map((c) => `<span class="ft-pill" data-chain-token="${prefix}:${actIdx}:value:{{${escapeHtml(c)}}}" style="font-size:9.5px;">+ {{${escapeHtml(c)}}}</span>`)
                            .join('')}
                          ${combinedCols
                            .filter((c) => /date|esd|time|day|ship|submitted|order|due/i.test(c))
                            .slice(0, 2)
                            .map((c) => `<span class="ft-pill ft-formula-pill" data-chain-token="${prefix}:${actIdx}:value:({{${escapeHtml(c)}}} + next business day)" style="font-size:9.5px;" title="Formula: Add next business day">📅 ({{${escapeHtml(c)}}} + next biz day)</span>`)
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
                  <span style="font-size:9.5px;color:#94a3b8;">Save to Output Column:</span>
                  <input class="ft-input" data-chain-field="${prefix}:${actIdx}:outputColumn" value="${escapeHtml(actObj.outputColumn || 'Branch_Extracted')}" style="font-size:11px;margin-top:2px;" />
                </div>`
              : ''
          }

          ${
            bNeedsJump
              ? `<div>
                  <span style="font-size:9.5px;color:#94a3b8;">Jump to Step Number (1, 2, 3...):</span>
                  <input type="number" min="1" class="ft-input" data-chain-field="${prefix}:${actIdx}:targetStepNumber" value="${escapeHtml(actObj.targetStepNumber || '1')}" style="font-size:11px;margin-top:2px;" />
                </div>`
              : ''
          }

          ${
            bMode === 'nested_if'
              ? (() => {
                  const nSource = actObj.ifSource || 'csv_or_var';
                  const nCond = actObj.verifyCondition || 'contains';
                  const nThenMode = actObj.nestedThenMode || 'click';
                  const nElseMode = actObj.nestedElseMode || 'continue';
                  const pickNestedIf = `${prefix}:${actIdx}:nested_if`;
                  const pickNestedThen = `${prefix}:${actIdx}:nested_then`;
                  const pickNestedElse = `${prefix}:${actIdx}:nested_else`;
                  return `
                  <div style="background:#0f172a;border:1px dashed #ec4899;border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:5px;">
                    <div style="font-size:10px;font-weight:700;color:#f9a8d4;">🔀 Nested IF Check:</div>
                    <select class="ft-select" data-chain-rerender="${prefix}:${actIdx}:ifSource" style="font-size:10.5px;padding:3px 5px;">
                      <option value="csv_or_var" ${nSource === 'csv_or_var' ? 'selected' : ''}>Check Table / CSV Column ({{Column}})</option>
                      <option value="dom_element" ${nSource === 'dom_element' ? 'selected' : ''}>Check Element on Row / Page</option>
                    </select>
                    ${
                      nSource === 'csv_or_var'
                        ? `<div>
                            <input class="ft-input" data-chain-field="${prefix}:${actIdx}:ifLeftValue" value="${escapeHtml(actObj.ifLeftValue || '')}" placeholder="e.g. {{PO_Submitted_Date}}" style="font-family:monospace;font-size:10.5px;" />
                            ${
                              combinedCols.length > 0
                                ? `<div class="ft-pills" style="margin-top:3px;">
                                    ${combinedCols
                                      .slice(0, 6)
                                      .map((c) => `<span class="ft-pill" data-chain-set="${prefix}:${actIdx}:ifLeftValue:{{${escapeHtml(c)}}}" style="font-size:9px;">{{${escapeHtml(c)}}}</span>`)
                                      .join('')}
                                   </div>`
                                : ''
                            }
                           </div>`
                        : `<div>
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
                              <span style="font-size:9.5px;color:#94a3b8;">Element Selector:</span>
                              <button class="ft-mini-btn" data-pick-branch="${pickNestedIf}" style="color:#a5b4fc;border-color:#6366f1;">
                                ${pickingBranchTarget === pickNestedIf ? '🎯 Click on page...' : '🎯 Pick'}
                              </button>
                            </div>
                            <input class="ft-input" data-chain-field="${prefix}:${actIdx}:selector" value="${escapeHtml(actObj.selector || '')}" placeholder="CSS selector" style="font-family:monospace;font-size:10.5px;" />
                           </div>`
                    }
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
                      <select class="ft-select" data-chain-field="${prefix}:${actIdx}:verifyCondition" style="font-size:10px;padding:3px 5px;">
                        <option value="contains" ${nCond === 'contains' ? 'selected' : ''}>Contains</option>
                        <option value="equals" ${nCond === 'equals' ? 'selected' : ''}>Equals (==)</option>
                        <option value="not_equals" ${nCond === 'not_equals' ? 'selected' : ''}>Not Equals (!=)</option>
                        <option value="not_empty" ${nCond === 'not_empty' ? 'selected' : ''}>Not Empty</option>
                        <option value="is_empty" ${nCond === 'is_empty' ? 'selected' : ''}>Is Empty</option>
                        <option value="gt" ${nCond === 'gt' ? 'selected' : ''}>Greater (&gt;)</option>
                        <option value="lt" ${nCond === 'lt' ? 'selected' : ''}>Less (&lt;)</option>
                      </select>
                      <input class="ft-input" data-chain-field="${prefix}:${actIdx}:value" value="${escapeHtml(actObj.value || '')}" placeholder="Expected value..." style="font-size:10.5px;" />
                    </div>

                    <div style="border-top:1px solid #334155;padding-top:4px;">
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
                        <span style="font-size:9.5px;font-weight:700;color:#34d399;">↳ Nested THEN:</span>
                        <select class="ft-select" data-chain-rerender="${prefix}:${actIdx}:nestedThenMode" style="width:auto;flex:1;font-size:10px;padding:2px 4px;">
                          <option value="click" ${nThenMode === 'click' ? 'selected' : ''}>👆 Click Element</option>
                          <option value="input" ${nThenMode === 'input' ? 'selected' : ''}>⌨️ Type / Fill Input</option>
                          <option value="select" ${nThenMode === 'select' ? 'selected' : ''}>▾ Select Dropdown</option>
                          <option value="keypress" ${nThenMode === 'keypress' ? 'selected' : ''}>⏎ Press Key</option>
                          <option value="skip_row" ${nThenMode === 'skip_row' ? 'selected' : ''}>⏭ Skip Row</option>
                          <option value="continue" ${nThenMode === 'continue' ? 'selected' : ''}>↪ Continue</option>
                        </select>
                        ${
                          ['click', 'input', 'select', 'keypress'].includes(nThenMode)
                            ? `<button class="ft-mini-btn" data-pick-branch="${pickNestedThen}" style="color:#a5b4fc;border-color:#6366f1;">
                                ${pickingBranchTarget === pickNestedThen ? '🎯 Click...' : '🎯 Pick'}
                               </button>`
                            : ''
                        }
                      </div>
                      ${
                        ['click', 'input', 'select', 'keypress'].includes(nThenMode)
                          ? `<input class="ft-input" data-chain-field="${prefix}:${actIdx}:nestedThenSelector" value="${escapeHtml(actObj.nestedThenSelector || '')}" placeholder="Nested THEN selector" style="font-family:monospace;font-size:10px;margin-top:3px;" />`
                          : ''
                      }
                      ${
                        ['input', 'select', 'keypress'].includes(nThenMode)
                          ? `<input class="ft-input" data-chain-field="${prefix}:${actIdx}:nestedThenValue" value="${escapeHtml(actObj.nestedThenValue || '')}" placeholder="Value to type / select (or {{Column}})" style="font-size:10px;margin-top:3px;" />`
                          : ''
                      }
                    </div>

                    <div style="border-top:1px solid #334155;padding-top:4px;">
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
                        <span style="font-size:9.5px;font-weight:700;color:#fbbf24;">↳ Nested ELSE:</span>
                        <select class="ft-select" data-chain-rerender="${prefix}:${actIdx}:nestedElseMode" style="width:auto;flex:1;font-size:10px;padding:2px 4px;">
                          <option value="continue" ${nElseMode === 'continue' ? 'selected' : ''}>↪ Continue / Do Nothing</option>
                          <option value="click" ${nElseMode === 'click' ? 'selected' : ''}>👆 Click Element</option>
                          <option value="input" ${nElseMode === 'input' ? 'selected' : ''}>⌨️ Type / Fill Input</option>
                          <option value="select" ${nElseMode === 'select' ? 'selected' : ''}>▾ Select Dropdown</option>
                          <option value="skip_row" ${nElseMode === 'skip_row' ? 'selected' : ''}>⏭ Skip Row</option>
                        </select>
                        ${
                          ['click', 'input', 'select'].includes(nElseMode)
                            ? `<button class="ft-mini-btn" data-pick-branch="${pickNestedElse}" style="color:#a5b4fc;border-color:#6366f1;">
                                ${pickingBranchTarget === pickNestedElse ? '🎯 Click...' : '🎯 Pick'}
                               </button>`
                            : ''
                        }
                      </div>
                      ${
                        ['click', 'input', 'select'].includes(nElseMode)
                          ? `<input class="ft-input" data-chain-field="${prefix}:${actIdx}:nestedElseSelector" value="${escapeHtml(actObj.nestedElseSelector || '')}" placeholder="Nested ELSE selector" style="font-family:monospace;font-size:10px;margin-top:3px;" />`
                          : ''
                      }
                      ${
                        ['input', 'select'].includes(nElseMode)
                          ? `<input class="ft-input" data-chain-field="${prefix}:${actIdx}:nestedElseValue" value="${escapeHtml(actObj.nestedElseValue || '')}" placeholder="Value to type / select" style="font-size:10px;margin-top:3px;" />`
                          : ''
                      }
                    </div>
                  </div>`;
                })()
              : ''
          }
        </div>
      `;
    };

    const renderBranchBoxHtml = (prefix, title, colorHex, actionsList) => {
      return `
        <div style="background:#0f172a;border:1px solid ${colorHex};border-radius:7px;padding:7px 8px;display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <span style="font-size:10.5px;font-weight:700;color:${colorHex};">${title} (${actionsList.length} action${actionsList.length === 1 ? '' : 's'})</span>
            <div style="display:flex;gap:4px;">
              <button class="ft-mini-btn" data-chain-add="${prefix}:click" style="color:${colorHex};border-color:${colorHex};font-weight:700;">
                + Add Action
              </button>
              <button class="ft-mini-btn" data-chain-add="${prefix}:nested_if" style="color:#f9a8d4;border-color:#ec4899;">
                + Nested IF
              </button>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:5px;">
            ${actionsList
              .map((actObj, actIdx) => renderSingleChainedActionHtml(prefix, actObj, actIdx, actionsList.length, colorHex))
              .join('')}
          </div>
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

        ${
          draft.detectedTable && !(stepCsv.enabled && stepCsv.sourceType === 'page_table')
            ? `
          <div style="background:rgba(6,182,212,0.14);border:1px solid rgba(6,182,212,0.5);border-radius:7px;padding:7px 9px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div>
              <div style="font-size:11px;font-weight:700;color:#67e8f9;">
                🌐 HTML Table Detected (${draft.detectedTable.rows.length} rows × ${draft.detectedTable.headers.length} cols)
              </div>
              <div style="font-size:10px;color:#cbd5e1;font-family:monospace;">
                ${escapeHtml(draft.detectedTable.containerSelector)}
              </div>
            </div>
            <button class="ft-btn ft-btn-primary" id="ft-draft-use-detected-table" style="padding:5px 9px;font-size:10.5px;background:#0891b2;white-space:nowrap;">
              🌐 Use as Data Source
            </button>
          </div>
        `
            : ''
        }

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
            <input class="ft-input" id="ft-draft-name" value="${escapeHtml(draft.name || '')}" placeholder="e.g. IF ESD is Enter PO ESD..." />
          </div>
        </div>

        ${
          draft.type === 'condition'
            ? `
          <div style="background:#0f172a;padding:7px 8px;border-radius:7px;border:1px solid #ec4899;display:flex;flex-direction:column;gap:6px;">
            <label class="ft-label" style="color:#f9a8d4;margin:0;">🔀 IF — What do you want to check?</label>

            <!-- Quick checkboxes right inside IF to refer to Page Table or CSV -->
            <div style="display:flex;flex-direction:column;gap:4px;background:#1e293b;padding:6px 7px;border-radius:6px;border:1px solid #334155;">
              <label style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:#7dd3fc;cursor:pointer;font-weight:600;">
                <input type="checkbox" id="ft-draft-if-use-table" ${stepCsv.enabled && stepCsv.sourceType === 'page_table' ? 'checked' : ''} />
                🌐 Refer to Page Table / HTML List on this IF check
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:#93c5fd;cursor:pointer;font-weight:600;">
                <input type="checkbox" id="ft-draft-if-use-csv" ${stepCsv.enabled && stepCsv.sourceType !== 'page_table' ? 'checked' : ''} />
                📂 Refer to CSV File on this IF check
              </label>

              ${
                stepCsv.enabled && stepCsv.sourceType === 'page_table'
                  ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:3px;padding-top:4px;border-top:1px dashed rgba(56,189,248,0.35);">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                        <button class="ft-btn ft-btn-secondary" id="ft-draft-if-pick-table" style="padding:3px 7px;font-size:10px;border-color:#0284c7;color:#7dd3fc;">
                          ${pickingTableSourceMode ? '🌐 Click Table on Page...' : stepCsv.containerSelector ? '🎯 Re-Pick Table' : '🎯 Pick Table on Page'}
                        </button>
                        <span style="font-size:10px;color:#e0f2fe;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                          ${stepCsv.containerSelector ? `${escapeHtml(stepCsv.containerSelector)} (${stepCsv.rows?.length || 0} rows)` : 'Pick a table'}
                        </span>
                      </div>
                      <select class="ft-select" id="ft-draft-if-col-select" style="font-size:11px;border-color:#0284c7;color:#e0f2fe;">
                        <option value="">-- Select Table Column to Check in IF --</option>
                        ${allStepCols
                          .map((c) => `<option value="${escapeHtml(c)}" ${draft.options?.ifLeftValue === `{{${c}}}` || stepCsv.columnName === c ? 'selected' : ''}>Check Column: ${escapeHtml(c)} ({{${escapeHtml(c)}}})</option>`)
                          .join('')}
                      </select>
                    </div>`
                  : ''
              }

              ${
                stepCsv.enabled && stepCsv.sourceType !== 'page_table'
                  ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:3px;padding-top:4px;border-top:1px dashed #475569;">
                      <select class="ft-select" id="ft-draft-if-col-select" style="font-size:11px;">
                        <option value="">-- Select CSV Column to Check in IF --</option>
                        ${combinedCols
                          .map((c) => `<option value="${escapeHtml(c)}" ${draft.options?.ifLeftValue === `{{${c}}}` || stepCsv.columnName === c ? 'selected' : ''}>Check Column: ${escapeHtml(c)} ({{${escapeHtml(c)}}})</option>`)
                          .join('')}
                      </select>
                    </div>`
                  : ''
              }
            </div>

            <select class="ft-select" id="ft-draft-if-source">
              <option value="csv_or_var" ${ifSource === 'csv_or_var' ? 'selected' : ''}>📄 Check Table / CSV Column or Variable (e.g. {{ESD}})</option>
              <option value="dom_element" ${ifSource === 'dom_element' ? 'selected' : ''}>🌐 Check HTML Element on Current Row / Page (Text, Value, Exists)</option>
            </select>

            ${
              ifSource === 'csv_or_var'
                ? `
              <div>
                <label class="ft-label">Column or Variable to Check (Left-Hand Side of IF):</label>
                <div style="position:relative;">
                  <input class="ft-input" id="ft-draft-if-left" value="${escapeHtml(draft.options?.ifLeftValue || '')}" placeholder="e.g. {{ESD}} or {{Cancel_Reason}} or ({{PO_Date}} + 1)" style="font-family:monospace;font-size:11px;" autocomplete="off" />
                  <div class="ft-autocomplete-menu" id="ft-autocomplete-if-left"></div>
                </div>
                ${
                  combinedCols.length > 0 || prevSteps.length > 0
                    ? `<div class="ft-pills" style="margin-top:4px;">
                        ${combinedCols
                          .map((c) => `<span class="ft-pill" data-ifleft-token="{{${escapeHtml(c)}}}">+ {{${escapeHtml(c)}}}</span>`)
                          .join('')}
                        ${combinedCols
                          .filter((c) => /date|esd|time|day|ship|submitted|order|due/i.test(c))
                          .slice(0, 2)
                          .map((c) => `<span class="ft-pill ft-formula-pill" data-ifleft-token="({{${escapeHtml(c)}}} + next business day)" title="Formula: Add next business day">📅 ({{${escapeHtml(c)}}} + next biz day)</span>`)
                          .join('')}
                        ${prevSteps
                          .map((ps) => `<span class="ft-pill" style="background:rgba(168,85,247,0.16);color:#d8b4fe;border-color:rgba(168,85,247,0.4);" data-ifleft-token="${escapeHtml(ps.token)}">🔗 Step ${ps.stepNum}</span>`)
                          .join('')}
                      </div>`
                    : ''
                }
              </div>
            `
                : `
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:10px;color:#f9a8d4;">Pick the element on the row/page to check:</span>
                <button class="ft-mini-btn" data-pick-branch="if" style="color:#f9a8d4;border-color:#ec4899;">
                  ${pickingBranchTarget === 'if' ? '🎯 Click element on page...' : '🎯 Pick IF Element'}
                </button>
              </div>
            `
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
            <div style="position:relative;">
              <input class="ft-input" id="ft-draft-value" value="${escapeHtml(draft.value || '')}" placeholder="${
                  draft.type === 'navigate'
                    ? 'https://example.com'
                    : draft.type === 'verify' || draft.type === 'condition'
                    ? 'Word, string, number, or {{CSV_Column}}...'
                    : 'Static text, {{column_name}}, or ({{Col}} + 1)'
                }" autocomplete="off" />
              <div class="ft-autocomplete-menu" id="ft-autocomplete-draft-value"></div>
            </div>

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
              combinedCols.length > 0 || prevSteps.length > 0
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
                    ${combinedCols
                      .filter((c) => /date|esd|time|day|ship|submitted|order|due/i.test(c))
                      .map((c) => `
                        <span class="ft-pill ft-formula-pill" data-token="({{${escapeHtml(c)}}} + next business day)" title="Formula: Add next business day (skips weekend)">📅 ({{${escapeHtml(c)}}} + next biz day)</span>
                        <span class="ft-pill ft-formula-pill" data-token="({{${escapeHtml(c)}}} + 1 day)" title="Formula: Add 1 calendar day">📅 ({{${escapeHtml(c)}}} + 1 day)</span>
                      `)
                      .join('')}
                    ${combinedCols
                      .filter((c) => /qty|quantity|price|amount|total|cost|rate|num|count/i.test(c))
                      .map((c) => `
                        <span class="ft-pill ft-formula-pill" data-token="({{${escapeHtml(c)}}} + 1)" title="Formula: Add 1">🧮 ({{${escapeHtml(c)}}} + 1)</span>
                      `)
                      .join('')}
                    ${!combinedCols.some((c) => /date|esd|time|day|ship|submitted|order|due/i.test(c)) && combinedCols.length > 0
                      ? combinedCols.slice(0, 2).map((c) => `
                        <span class="ft-pill ft-formula-pill" data-token="({{${escapeHtml(c)}}} + next business day)" title="Formula: Add next business day (skips weekend)">📅 ({{${escapeHtml(c)}}} + next biz day)</span>
                        <span class="ft-pill ft-formula-pill" data-token="({{${escapeHtml(c)}}} + 1 day)" title="Formula: Add 1 calendar day">📅 ({{${escapeHtml(c)}}} + 1 day)</span>
                      `).join('')
                      : ''}
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
            ${renderBranchBoxHtml('then', '✅ THEN (If TRUE):', '#10b981', thenActions)}
            ${renderBranchBoxHtml('else', '❌ ELSE (If FALSE):', '#f59e0b', elseActions)}
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

        <!-- Step-level CSV or Page Table mapping inside HUD -->
        <div style="border-top:1px solid #334155;padding-top:6px;display:flex;flex-direction:column;gap:6px;">
          <!-- Option 1: Pick value from CSV File on this step -->
          <div>
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#cbd5e1;cursor:pointer;">
              <span>
                <input type="checkbox" id="ft-draft-stepcsv-toggle" ${stepCsv.enabled && stepCsv.sourceType !== 'page_table' ? 'checked' : ''} />
                Pick value from <b>CSV File</b> on this step
              </span>
              ${
                stepCsv.fileName && stepCsv.sourceType !== 'page_table'
                  ? `<span style="color:#34d399;font-size:10px;">${escapeHtml(stepCsv.fileName)} (${stepCsv.rows?.length || 0} rows)</span>`
                  : ''
              }
            </label>
            ${
              stepCsv.enabled && stepCsv.sourceType !== 'page_table'
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

          <!-- Option 2: Pick value from Page Table on this step -->
          <div>
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#cbd5e1;cursor:pointer;">
              <span>
                <input type="checkbox" id="ft-draft-steptable-toggle" ${stepCsv.enabled && stepCsv.sourceType === 'page_table' ? 'checked' : ''} />
                Pick value from <b>Page Table / HTML List</b> on this step
              </span>
              ${
                stepCsv.fileName && stepCsv.sourceType === 'page_table'
                  ? `<span style="color:#22d3ee;font-size:10px;">${escapeHtml(stepCsv.fileName)} (${stepCsv.rows?.length || 0} rows)</span>`
                  : ''
              }
            </label>
            ${
              stepCsv.enabled && stepCsv.sourceType === 'page_table'
                ? `
              <div style="margin-top:6px;display:flex;flex-direction:column;gap:5px;background:#0f172a;padding:7px;border-radius:6px;border:1px solid rgba(6,182,212,0.4);">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                  <button
                    type="button"
                    class="ft-btn ft-btn-secondary"
                    id="ft-draft-pick-table-btn"
                    style="padding:4px 9px;font-size:10.5px;border-color:#06b6d4;color:#67e8f9;background:rgba(6,182,212,0.15);"
                  >
                    ${pickingTableSourceMode ? '🌐 Click Any Table on Page...' : '🎯 Pick Table on Page'}
                  </button>
                  <span style="font-size:10px;color:#94a3b8;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${
                      stepCsv.containerSelector
                        ? `${escapeHtml(stepCsv.containerSelector)} (${stepCsv.rows?.length || 0} rows)`
                        : 'No table picked yet'
                    }
                  </span>
                </div>
                <div style="display:grid;grid-template-columns:1fr;gap:5px;">
                  <select class="ft-select" id="ft-draft-stepcsv-mode" style="font-size:11px;">
                    <option value="sequence_row" ${stepCsv.mode !== 'loop_step' ? 'selected' : ''}>Pick 1 row per Full Sequence Flow (e.g. 20 rows = run whole sequence 20x)</option>
                    <option value="loop_step" ${stepCsv.mode === 'loop_step' ? 'selected' : ''}>Repeat only this single step for all rows before next step</option>
                  </select>
                  <select class="ft-select" id="ft-draft-stepcsv-col" style="font-size:11px;">
                    <option value="">-- Select Table Column to Pick --</option>
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
      if (pickDelayTimer) {
        clearInterval(pickDelayTimer);
        pickDelayTimer = null;
        pickDelayRemaining = 0;
      }
      pickingBranchTarget = null;
      pickingTableSourceMode = false;
      const next = !builderSession.pickMode;
      setPickMode(next);
      chrome.runtime.sendMessage({
        type: 'UPDATE_BUILDER_SESSION',
        updates: { pickMode: next }
      });
      renderHud();
    });

    q('#ft-btn-pick-delay-toggle')?.addEventListener('click', () => {
      startDelayedPick(null, 3);
    });

    q('#ft-btn-pick-table-source')?.addEventListener('click', () => {
      pickingBranchTarget = null;
      if (pickingTableSourceMode && builderSession.pickMode) {
        pickingTableSourceMode = false;
        setPickMode(false);
        chrome.runtime.sendMessage({
          type: 'UPDATE_BUILDER_SESSION',
          updates: { pickMode: false }
        });
      } else {
        pickingTableSourceMode = true;
        setPickMode(true);
        chrome.runtime.sendMessage({
          type: 'UPDATE_BUILDER_SESSION',
          updates: { pickMode: true }
        });
      }
      renderHud();
    });

    q('#ft-btn-rescan-table-source')?.addEventListener('click', async () => {
      if (!activeProject || !activeProject.pageTableSource) return;
      const pts = activeProject.pageTableSource;
      const extracted = extractPageTableOrListData(null, pts.containerSelector, pts.rowSelector);
      if (extracted && extracted.ok) {
        activeProject.pageTableSource.headers = extracted.headers;
        activeProject.pageTableSource.sampleRowCount = extracted.rows.length;
        activeProject.masterCsv = {
          enabled: true,
          isPageTableSnapshot: true,
          fileName: `Page ${extracted.sourceType === 'table' ? 'Table' : 'List'} (${extracted.containerSelector})`,
          headers: extracted.headers,
          rows: extracted.rows
        };
        flashElement(extracted.containerEl, '#06b6d4');
        await persistActiveProject();
        renderHud();
      }
    });

    q('#ft-btn-clear-table-source')?.addEventListener('click', async () => {
      if (!activeProject) return;
      activeProject.pageTableSource = { enabled: false, containerSelector: '', rowSelector: '' };
      if (activeProject.masterCsv && activeProject.masterCsv.isPageTableSnapshot) {
        activeProject.masterCsv = { enabled: false, fileName: '', headers: [], rows: [] };
      }
      await persistActiveProject();
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

    q('#ft-btn-run-now')?.addEventListener('click', async () => {
      if (!activeProject) return;
      if (editingStepDraft) {
        const nameEl = q('#ft-draft-name');
        const selEl = q('#ft-draft-selector');
        const valEl = q('#ft-draft-value');
        if (nameEl) editingStepDraft.name = nameEl.value;
        if (selEl) editingStepDraft.selector = selEl.value;
        if (valEl) editingStepDraft.value = valEl.value;
        await saveDraftToProject(false);
      }
      // If project uses a Page Table / HTML List data source, do NOT prompt for a CSV file—run directly on the page!
      if (projectUsesPageTable(activeProject, editingStepDraft)) {
        showHudRunLauncher = false;
        hudRuntimeCsv = null;
        renderHud();
        chrome.runtime.sendMessage({
          type: 'START_WORKFLOW_RUN',
          projectId: activeProject.id,
          reuseBuilderTab: true,
          runtimeCsv: null
        });
        return;
      }
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

        // Sync Chained THEN and ELSE actions
        shadowRoot.querySelectorAll('[data-chain-field]').forEach((inp) => {
          const raw = inp.getAttribute('data-chain-field') || '';
          const [prefix, idxStr, fieldName] = raw.split(':');
          const actIdx = parseInt(idxStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx] && fieldName) {
            arr[actIdx][fieldName] = inp.value;
          }
        });

        shadowRoot.querySelectorAll('[data-chain-bool]').forEach((chk) => {
          const raw = chk.getAttribute('data-chain-bool') || '';
          const [prefix, idxStr, fieldName] = raw.split(':');
          const actIdx = parseInt(idxStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx] && fieldName) {
            arr[actIdx][fieldName] = chk.checked;
          }
        });

        syncLegacyBranchesFromActions(editingStepDraft.options);

        if (csvModeEl) editingStepDraft.stepCsv.mode = csvModeEl.value;
        if (csvColEl) {
          editingStepDraft.stepCsv.columnName = csvColEl.value;
          if (csvColEl.value) {
            if (editingStepDraft.type === 'condition') {
              editingStepDraft.options.ifSource = 'csv_or_var';
              editingStepDraft.options.ifLeftValue = `{{${csvColEl.value}}}`;
            } else if (!editingStepDraft.value) {
              editingStepDraft.value = `{{${csvColEl.value}}}`;
            }
          }
        }
      };

      const applyTableSourceToDraftAndProject = (tbl) => {
        if (!tbl || !editingStepDraft) return;
        const tableLabel = `Table: ${tbl.containerSelector}`;
        const firstCol = tbl.headers?.[0] || '';
        editingStepDraft.stepCsv = {
          enabled: true,
          sourceType: 'page_table',
          containerSelector: tbl.containerSelector,
          rowSelector: tbl.rowSelector || 'tbody tr',
          mode: editingStepDraft.stepCsv?.mode === 'loop_step' ? 'loop_step' : 'sequence_row',
          fileName: tableLabel,
          headers: [...(tbl.headers || [])],
          rows: tbl.rows || [],
          columnName: firstCol
        };
        if (firstCol) {
          if (editingStepDraft.type === 'condition') {
            editingStepDraft.options = editingStepDraft.options || {};
            editingStepDraft.options.ifSource = 'csv_or_var';
            const curLeft = editingStepDraft.options.ifLeftValue || '';
            const curKey = (curLeft.match(/^\{\{\s*(?:step\.|master\.)?([^}]+?)\s*\}\}$/) || [])[1];
            if (!curLeft || (curKey && !(tbl.headers || []).includes(curKey))) {
              editingStepDraft.options.ifLeftValue = `{{${firstCol}}}`;
            }
          } else if (!editingStepDraft.value) {
            editingStepDraft.value = `{{${firstCol}}}`;
          }
        }
        if (activeProject) {
          activeProject.pageTableSource = {
            enabled: true,
            sourceType: tbl.sourceType || 'table',
            containerSelector: tbl.containerSelector,
            rowSelector: tbl.rowSelector || 'tbody tr',
            liveRefreshOnRun: true,
            headers: [...(tbl.headers || [])],
            sampleRowCount: tbl.rows?.length || 0
          };
          activeProject.masterCsv = {
            enabled: true,
            isPageTableSnapshot: true,
            fileName: tableLabel,
            headers: [...(tbl.headers || [])],
            rows: tbl.rows || []
          };
          persistActiveProject();
        }
      };

      const enablePageTableOnDraft = () => {
        editingStepDraft.stepCsv.enabled = true;
        editingStepDraft.stepCsv.sourceType = 'page_table';
        if (!editingStepDraft.stepCsv.mode) {
          editingStepDraft.stepCsv.mode = 'sequence_row';
        }
        if (editingStepDraft.detectedTable) {
          applyTableSourceToDraftAndProject(editingStepDraft.detectedTable);
        } else if (activeProject?.pageTableSource?.enabled && activeProject.pageTableSource.containerSelector) {
          const pts = activeProject.pageTableSource;
          const liveScan = extractPageTableOrListData(null, pts.containerSelector, pts.rowSelector);
          if (liveScan && liveScan.ok) {
            applyTableSourceToDraftAndProject(liveScan);
          } else {
            editingStepDraft.stepCsv.containerSelector = pts.containerSelector;
            editingStepDraft.stepCsv.rowSelector = pts.rowSelector;
            editingStepDraft.stepCsv.fileName = `Table: ${pts.containerSelector}`;
            editingStepDraft.stepCsv.headers = [...(pts.headers || activeProject.masterCsv?.headers || [])];
            editingStepDraft.stepCsv.rows = activeProject.masterCsv?.rows || [];
          }
        }
      };

      q('#ft-draft-type')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.type = e.target.value;
        if (editingStepDraft.type === 'condition') {
          const hasTableOrCsv = Boolean(editingStepDraft.stepCsv?.enabled);
          editingStepDraft.options.ifSource =
            hasTableOrCsv || !editingStepDraft.selector ? 'csv_or_var' : 'dom_element';
          if (hasTableOrCsv && editingStepDraft.stepCsv?.columnName && !editingStepDraft.options.ifLeftValue) {
            editingStepDraft.options.ifLeftValue = `{{${editingStepDraft.stepCsv.columnName}}}`;
          }
          ensureBranchActionsArray(editingStepDraft.options, 'then');
          ensureBranchActionsArray(editingStepDraft.options, 'else');
          syncLegacyBranchesFromActions(editingStepDraft.options);
        }
        renderHud();
      });

      q('#ft-draft-if-source')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.options.ifSource = e.target.value;
        renderHud();
      });

      q('#ft-draft-if-use-table')?.addEventListener('change', (e) => {
        syncDraftInputs();
        if (e.target.checked) {
          editingStepDraft.options.ifSource = 'csv_or_var';
          enablePageTableOnDraft();
        } else {
          editingStepDraft.stepCsv.enabled = false;
        }
        renderHud();
      });

      q('#ft-draft-if-use-csv')?.addEventListener('change', (e) => {
        syncDraftInputs();
        if (e.target.checked) {
          editingStepDraft.options.ifSource = 'csv_or_var';
          editingStepDraft.stepCsv.enabled = true;
          editingStepDraft.stepCsv.sourceType = 'csv_file';
          const existingCsv = findExistingProjectCsv();
          if (existingCsv && !existingCsv.isPageTableSnapshot) {
            editingStepDraft.stepCsv.fileName = existingCsv.fileName;
            editingStepDraft.stepCsv.headers = [...(existingCsv.headers || [])];
            editingStepDraft.stepCsv.rows = existingCsv.rows || [];
          }
        } else {
          editingStepDraft.stepCsv.enabled = false;
        }
        renderHud();
      });

      q('#ft-draft-if-pick-table')?.addEventListener('click', () => {
        syncDraftInputs();
        pickingBranchTarget = null;
        pickingTableSourceMode = true;
        setPickMode(true);
        chrome.runtime.sendMessage({
          type: 'UPDATE_BUILDER_SESSION',
          updates: { pickMode: true }
        });
        renderHud();
      });

      q('#ft-draft-if-col-select')?.addEventListener('change', (e) => {
        syncDraftInputs();
        const chosenCol = e.target.value;
        editingStepDraft.stepCsv.columnName = chosenCol;
        if (chosenCol) {
          editingStepDraft.options.ifSource = 'csv_or_var';
          editingStepDraft.options.ifLeftValue = `{{${chosenCol}}}`;
        }
        renderHud();
      });

      q('#ft-draft-main-opt-picker')?.addEventListener('change', (e) => {
        syncDraftInputs();
        if (e.target.value !== '') {
          editingStepDraft.value = e.target.value;
          renderHud();
        }
      });

      // Chained Action Event Listeners inside THEN and ELSE
      shadowRoot.querySelectorAll('[data-chain-mode]').forEach((selEl) => {
        selEl.addEventListener('change', (e) => {
          syncDraftInputs();
          const [prefix, idxStr] = (selEl.getAttribute('data-chain-mode') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx]) {
            arr[actIdx].mode = e.target.value;
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('[data-chain-rerender]').forEach((selEl) => {
        selEl.addEventListener('change', (e) => {
          syncDraftInputs();
          const [prefix, idxStr, fieldName] = (selEl.getAttribute('data-chain-rerender') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx] && fieldName) {
            arr[actIdx][fieldName] = e.target.value;
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('[data-chain-add]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDraftInputs();
          const [prefix, defaultMode] = (btn.getAttribute('data-chain-add') || '').split(':');
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          arr.push({
            mode: defaultMode || 'click',
            selector: '',
            rowRelativeSelector: '',
            isRowRelative: false,
            value: '',
            pressEnter: false,
            ifSource: 'csv_or_var',
            ifLeftValue: '',
            verifyCondition: 'contains',
            nestedThenMode: 'click',
            nestedThenSelector: '',
            nestedThenValue: '',
            nestedElseMode: 'continue',
            nestedElseSelector: '',
            nestedElseValue: ''
          });
          syncLegacyBranchesFromActions(editingStepDraft.options);
          renderHud();
        });
      });

      shadowRoot.querySelectorAll('[data-chain-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDraftInputs();
          const [prefix, idxStr] = (btn.getAttribute('data-chain-del') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr.length > 1) {
            arr.splice(actIdx, 1);
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('[data-chain-move]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDraftInputs();
          const [prefix, idxStr, dirStr] = (btn.getAttribute('data-chain-move') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          const dir = parseInt(dirStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          const targetIdx = actIdx + dir;
          if (targetIdx >= 0 && targetIdx < arr.length) {
            [arr[actIdx], arr[targetIdx]] = [arr[targetIdx], arr[actIdx]];
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('[data-chain-opt-picker]').forEach((selEl) => {
        selEl.addEventListener('change', (e) => {
          syncDraftInputs();
          const [prefix, idxStr] = (selEl.getAttribute('data-chain-opt-picker') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx]) {
            arr[actIdx].value = e.target.value;
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('.ft-pill[data-chain-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const raw = pill.getAttribute('data-chain-token') || '';
          const parts = raw.split(':');
          const prefix = parts[0];
          const actIdx = parseInt(parts[1], 10);
          const fieldName = parts[2] || 'value';
          const token = parts.slice(3).join(':');
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx]) {
            arr[actIdx][fieldName] = (arr[actIdx][fieldName] || '') + token;
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('.ft-pill[data-chain-set]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const raw = pill.getAttribute('data-chain-set') || '';
          const parts = raw.split(':');
          const prefix = parts[0];
          const actIdx = parseInt(parts[1], 10);
          const fieldName = parts[2] || 'ifLeftValue';
          const token = parts.slice(3).join(':');
          const arr = ensureBranchActionsArray(editingStepDraft.options, prefix);
          if (arr[actIdx]) {
            arr[actIdx][fieldName] = token;
            syncLegacyBranchesFromActions(editingStepDraft.options);
            renderHud();
          }
        });
      });

      shadowRoot.querySelectorAll('.ft-pill[data-ifleft-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          syncDraftInputs();
          const token = pill.getAttribute('data-ifleft-token') || '';
          editingStepDraft.options.ifLeftValue = token;
          renderHud();
        });
      });

      shadowRoot.querySelectorAll('[data-pick-branch]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDraftInputs();
          const prefix = btn.getAttribute('data-pick-branch');
          if (pickDelayTimer) {
            clearInterval(pickDelayTimer);
            pickDelayTimer = null;
          }
          pickingBranchTarget = prefix;
          setPickMode(true);
          chrome.runtime.sendMessage({
            type: 'UPDATE_BUILDER_SESSION',
            updates: { pickMode: true }
          });
          renderHud();
        });
      });

      shadowRoot.querySelectorAll('[data-pick-delay]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDraftInputs();
          const prefix = btn.getAttribute('data-pick-delay');
          startDelayedPick(prefix, 3);
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
          if (editingStepDraft.type === 'condition') {
            editingStepDraft.options.ifSource = 'csv_or_var';
            editingStepDraft.options.ifLeftValue = `{{${chosenCol}}}`;
          } else {
            editingStepDraft.value = `{{${chosenCol}}}`;
          }
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
          const curVal = editingStepDraft.value || '';
          if (!curVal || (token.startsWith('(') && curVal.startsWith('{{') && curVal.endsWith('}}'))) {
            editingStepDraft.value = token;
          } else {
            editingStepDraft.value = curVal + token;
          }
          renderHud();
        });
      });

      // Autocomplete setup for main draft value input
      const draftValInp = q('#ft-draft-value');
      const draftValMenu = q('#ft-autocomplete-draft-value');
      if (draftValInp && draftValMenu) {
        setupFormulaAutocomplete(draftValInp, draftValMenu, getAvailableColumnsForDraft, (newVal) => {
          editingStepDraft.value = newVal;
          syncDraftInputs();
        });
      }

      // Autocomplete setup for condition if-left input
      const ifLeftInp = q('#ft-draft-if-left');
      const ifLeftMenu = q('#ft-autocomplete-if-left');
      if (ifLeftInp && ifLeftMenu) {
        setupFormulaAutocomplete(ifLeftInp, ifLeftMenu, getAvailableColumnsForDraft, (newVal) => {
          if (!editingStepDraft.options) editingStepDraft.options = {};
          editingStepDraft.options.ifLeftValue = newVal;
          syncDraftInputs();
        });
      }

      // Autocomplete setup for chained action inputs
      shadowRoot.querySelectorAll('[data-chain-field*=":value"]').forEach((cInp) => {
        const cMenu = cInp.parentElement?.querySelector('.ft-autocomplete-menu');
        if (cMenu) {
          setupFormulaAutocomplete(cInp, cMenu, getAvailableColumnsForDraft, () => {
            syncDraftInputs();
          });
        }
      });

      q('#ft-draft-use-detected-table')?.addEventListener('click', () => {
        syncDraftInputs();
        if (editingStepDraft.detectedTable) {
          applyTableSourceToDraftAndProject(editingStepDraft.detectedTable);
          renderHud();
        }
      });

      q('#ft-draft-stepcsv-toggle')?.addEventListener('change', (e) => {
        syncDraftInputs();
        editingStepDraft.stepCsv.enabled = e.target.checked;
        editingStepDraft.stepCsv.sourceType = 'csv_file';
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

      q('#ft-draft-steptable-toggle')?.addEventListener('change', (e) => {
        syncDraftInputs();
        if (e.target.checked) {
          enablePageTableOnDraft();
        } else {
          editingStepDraft.stepCsv.enabled = false;
        }
        renderHud();
      });

      q('#ft-draft-pick-table-btn')?.addEventListener('click', () => {
        syncDraftInputs();
        pickingBranchTarget = null;
        pickingTableSourceMode = true;
        setPickMode(true);
        chrome.runtime.sendMessage({
          type: 'UPDATE_BUILDER_SESSION',
          updates: { pickMode: true }
        });
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
            sourceType: 'csv_file',
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
    delete stepToSave.detectedTable;

    if (stepToSave.stepCsv?.enabled && stepToSave.stepCsv?.sourceType === 'page_table' && stepToSave.stepCsv?.containerSelector) {
      activeProject.pageTableSource = {
        enabled: true,
        sourceType: 'table',
        containerSelector: stepToSave.stepCsv.containerSelector,
        rowSelector: stepToSave.stepCsv.rowSelector || 'tbody tr',
        liveRefreshOnRun: true,
        headers: [...(stepToSave.stepCsv.headers || [])],
        sampleRowCount: stepToSave.stepCsv.rows?.length || 0
      };
      if (!activeProject.masterCsv || !activeProject.masterCsv.rows || activeProject.masterCsv.rows.length === 0) {
        activeProject.masterCsv = {
          enabled: true,
          isPageTableSnapshot: true,
          fileName: stepToSave.stepCsv.fileName || `Table: ${stepToSave.stepCsv.containerSelector}`,
          headers: [...(stepToSave.stepCsv.headers || [])],
          rows: stepToSave.stepCsv.rows || []
        };
      }
    }

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
      if (stepToSave.type !== 'condition' && stepToSave.stepCsv?.enabled && stepToSave.stepCsv?.columnName && !rawVal.includes('{{')) {
        rawVal = sampleStepRow[stepToSave.stepCsv.columnName] ?? rawVal;
      }

      const interpCtx = {
        masterRow: sampleMasterRow,
        stepRow: sampleStepRow,
        extractedVars: previewVars
      };

      const resolvedValue = window.FlowTagCSV.interpolateValue(rawVal, interpCtx);
      const resolvedSelector = window.FlowTagCSV.interpolateValue(stepToSave.selector || '', interpCtx);
      const resolvedRowAnchor = window.FlowTagCSV.interpolateValue(
        stepToSave.options?.rowAnchorText || '',
        interpCtx
      );
      const resolvedLeftValue = window.FlowTagCSV.interpolateValue(
        stepToSave.options?.ifLeftValue || '',
        interpCtx
      );

      ['then', 'else'].forEach((bKey) => {
        const arr = ensureBranchActionsArray(stepToSave.options || {}, bKey);
        arr.forEach((act) => {
          act.resolvedSelector = window.FlowTagCSV.interpolateValue(act.selector || '', interpCtx);
          act.resolvedValue = window.FlowTagCSV.interpolateValue(act.value || '', interpCtx);
          act.resolvedLeftValue = window.FlowTagCSV.interpolateValue(act.ifLeftValue || '', interpCtx);
          act.resolvedNestedThenSelector = window.FlowTagCSV.interpolateValue(act.nestedThenSelector || '', interpCtx);
          act.resolvedNestedThenValue = window.FlowTagCSV.interpolateValue(act.nestedThenValue || '', interpCtx);
          act.resolvedNestedElseSelector = window.FlowTagCSV.interpolateValue(act.nestedElseSelector || '', interpCtx);
          act.resolvedNestedElseValue = window.FlowTagCSV.interpolateValue(act.nestedElseValue || '', interpCtx);
        });
        syncLegacyBranchesFromActions(stepToSave.options);
      });

      const pageTableConfig =
        activeProject.pageTableSource && activeProject.pageTableSource.enabled && activeProject.pageTableSource.containerSelector
          ? {
              containerSelector: activeProject.pageTableSource.containerSelector,
              rowSelector: activeProject.pageTableSource.rowSelector || 'tbody tr',
              rowIndex: 0
            }
          : null;

      if (stepToSave.type === 'navigate' && resolvedValue) {
        window.location.href = /^https?:\/\//i.test(resolvedValue) ? resolvedValue : 'https://' + resolvedValue;
      } else {
        await executeDomStep({
          ...stepToSave,
          resolvedSelector,
          resolvedValue,
          resolvedRowAnchor,
          resolvedLeftValue,
          pageTableConfig
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
