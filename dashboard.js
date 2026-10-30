/**
 * Domuto | Visual Browser Automation - Full Studio Dashboard Controller
 * Manages Projects, Step Sequencer, Master & Step CSVs, AI Export/Import, and Results Export.
 * Authored by Subrata Dey
 */
document.addEventListener('DOMContentLoaded', () => {
  let projects = [];
  let currentProjectId = null;
  let builderSession = { active: false };
  let runnerState = null;

  // DOM Elements
  const projectListEl = document.getElementById('project-list');
  const projNameInput = document.getElementById('proj-name-input');
  const projDescInput = document.getElementById('proj-desc-input');
  const projDomainInput = document.getElementById('proj-domain-input');
  const btnLaunchTagBuilder = document.getElementById('btn-launch-tag-builder');
  const btnRunWorkflow = document.getElementById('btn-run-workflow');
  const btnDeleteProject = document.getElementById('btn-delete-project');
  const builderIndicator = document.getElementById('builder-connection-indicator');

  const badgeStepCount = document.getElementById('badge-step-count');
  const badgeCsvCount = document.getElementById('badge-csv-count');
  const badgeResultsCount = document.getElementById('badge-results-count');

  const stepsContainer = document.getElementById('steps-container');
  const chkMasterCsvEnabled = document.getElementById('chk-master-csv-enabled');
  const masterCsvFilename = document.getElementById('master-csv-filename');
  const masterCsvTableContainer = document.getElementById('master-csv-table-container');
  const rawMasterCsvTextarea = document.getElementById('raw-master-csv-textarea');

  const liveRunnerBanner = document.getElementById('live-runner-banner');
  const runnerBannerStatus = document.getElementById('runner-banner-status');
  const runnerBannerStep = document.getElementById('runner-banner-step');
  const runnerBannerProgress = document.getElementById('runner-banner-progress');
  const btnBannerPause = document.getElementById('btn-banner-pause');
  const btnBannerStop = document.getElementById('btn-banner-stop');

  const runLogConsole = document.getElementById('run-log-console');
  const resultsTableContainer = document.getElementById('results-table-container');

  // New Project Modal
  const newProjectModal = document.getElementById('new-project-modal');
  const modalProjName = document.getElementById('modal-proj-name');
  const modalProjUrl = document.getElementById('modal-proj-url');

  // Initialize Data
  loadAllData();

  // Listen for live broadcasts from Background or Content HUD
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PROJECTS_UPDATED') {
      projects = message.projects || [];
      if (!getCurrentProject() && projects.length > 0) {
        currentProjectId = projects[0].id;
      }
      renderAll();
    } else if (message.type === 'BUILDER_SESSION_CHANGED') {
      builderSession = message.session || { active: false };
      renderBuilderIndicator();
    } else if (message.type === 'RUNNER_SYNC_STATE') {
      runnerState = message.state || null;
      renderRunnerSection();
    }
  });

  function loadAllData() {
    chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (res) => {
      if (!res || !res.ok) return;
      projects = res.projects || [];
      builderSession = res.builderSession || { active: false };
      runnerState = res.runnerState || null;

      // Check URL hash (#project=...)
      const hash = window.location.hash || '';
      if (hash === '#project=NEW') {
        if (projects.length > 0) currentProjectId = projects[0].id;
        renderAll();
        openNewProjectModal();
        window.location.hash = '';
        return;
      }
      const match = hash.match(/project=([^&]+)/);
      if (match && projects.some((p) => p.id === match[1])) {
        currentProjectId = match[1];
      } else if (projects.length > 0) {
        currentProjectId = projects[0].id;
      }

      renderAll();
    });
  }

  function getCurrentProject() {
    return projects.find((p) => p.id === currentProjectId) || null;
  }

  function saveCurrentProject() {
    const proj = getCurrentProject();
    if (!proj) return;
    chrome.runtime.sendMessage({
      type: 'SAVE_SINGLE_PROJECT',
      project: proj
    });
  }

  // ============================================================================
  // RENDER STUDIO UI
  // ============================================================================

  function getEffectiveRowCount(p) {
    let maxRows = p.masterCsv && p.masterCsv.enabled !== false && Array.isArray(p.masterCsv.rows) ? p.masterCsv.rows.length : 0;
    for (const st of p.steps || []) {
      if (st.stepCsv && st.stepCsv.enabled && st.stepCsv.mode !== 'loop_step' && Array.isArray(st.stepCsv.rows)) {
        if (st.stepCsv.rows.length > maxRows) maxRows = st.stepCsv.rows.length;
      }
    }
    return maxRows;
  }

  function renderAll() {
    renderSidebar();
    renderBuilderIndicator();
    const proj = getCurrentProject();
    if (!proj) return;

    projNameInput.value = proj.name || '';
    projDescInput.value = proj.description || '';
    projDomainInput.value = proj.startUrl || '';

    const stepCount = (proj.steps || []).length;
    const effectiveRows = getEffectiveRowCount(proj);
    const results = proj.lastRunResults || [];

    badgeStepCount.textContent = String(stepCount);
    badgeCsvCount.textContent = `${effectiveRows} row${effectiveRows === 1 ? '' : 's'}`;
    badgeResultsCount.textContent = String(results.length);

    renderStepsSequencer(proj);
    renderMasterCsvEditor(proj);
    renderRunnerSection();
  }

  function renderSidebar() {
    projectListEl.innerHTML = '';
    projects.forEach((p) => {
      const div = document.createElement('div');
      div.className = `project-item ${p.id === currentProjectId ? 'active' : ''}`;
      const stepCount = (p.steps || []).length;
      const rowCount = getEffectiveRowCount(p);
      const isBuilderHere = builderSession.active && builderSession.projectId === p.id;

      div.innerHTML = `
        <div class="project-item-title">
          <span>${escapeHtml(p.name || 'Untitled Project')}</span>
          ${isBuilderHere ? '<span style="color:#34d399;font-size:10px;">● LIVE</span>' : ''}
        </div>
        <div class="project-item-meta">
          <span>${stepCount} step${stepCount === 1 ? '' : 's'}</span>
          <span>•</span>
          <span>${rowCount > 0 ? `${rowCount} CSV rows` : 'Single run'}</span>
        </div>
      `;
      div.addEventListener('click', () => {
        currentProjectId = p.id;
        renderAll();
      });
      projectListEl.appendChild(div);
    });
  }

  function renderBuilderIndicator() {
    if (builderSession && builderSession.active) {
      const proj = projects.find((p) => p.id === builderSession.projectId);
      builderIndicator.innerHTML = `
        <span style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;"></span>
        <span style="color:#6ee7b7;font-weight:600;">Tag Builder Active on Tab (#${builderSession.tabId}) — ${escapeHtml(proj ? proj.name : '')}</span>
        <button class="btn btn-secondary btn-sm" id="btn-disconnect-builder" style="padding:2px 8px;font-size:11px;">Disconnect</button>
      `;
      document.getElementById('btn-disconnect-builder')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLOSE_BUILDER_SESSION' });
      });
    } else {
      builderIndicator.innerHTML = `
        <span style="color:#64748b;">Tag Builder Idle — Click "🎯 Open Domain & Map Elements" to launch</span>
      `;
    }
  }

  // ============================================================================
  // TAB 1: WORKFLOW STEPS SEQUENCER
  // ============================================================================

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

  function setupDashboardFormulaAutocomplete(inputEl, menuEl, getColumnsFn, onSelectFn) {
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
        <div class="dash-autocomplete-header">
          <span>🧮 FORMULA AUTOCOMPLETE</span>
          <span style="font-size:9px;color:#94a3b8;">↑↓ to navigate, Enter to pick</span>
        </div>
        ${currentMatches
          .map(
            (item, idx) => `
          <div class="dash-autocomplete-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}">
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

      menuEl.querySelectorAll('.dash-autocomplete-item').forEach((itemEl) => {
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
      menuEl.querySelectorAll('.dash-autocomplete-item').forEach((el, idx) => {
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

  function renderStepsSequencer(proj) {
    stepsContainer.innerHTML = '';
    const steps = proj.steps || [];
    const headerSet = new Set(proj.masterCsv?.headers || []);
    steps.forEach((st) => {
      if (st.stepCsv && st.stepCsv.enabled && st.stepCsv.mode !== 'loop_step' && Array.isArray(st.stepCsv.headers)) {
        st.stepCsv.headers.forEach((h) => headerSet.add(h));
      }
    });
    const masterHeaders = Array.from(headerSet);

    if (steps.length === 0) {
      stepsContainer.innerHTML = `
        <div class="card-box" style="text-align:center;padding:36px;">
          <h3 style="margin-bottom:8px;">No Steps in This Project Yet</h3>
          <p style="color:#94a3b8;font-size:13px;max-width:520px;margin:0 auto 16px;">
            Enter your target website domain in the top bar and click <b>"🎯 Open Domain & Map Elements"</b> to visually click elements on the site like Google Tag Manager, or add a step manually above!
          </p>
        </div>
      `;
      return;
    }

    steps.forEach((step, idx) => {
      const card = document.createElement('div');
      card.className = 'step-card';
      if (step.paused) {
        card.style.opacity = '0.62';
        card.style.borderStyle = 'dashed';
        card.style.borderColor = '#f59e0b';
      }
      const stepCsv = step.stepCsv || { enabled: false, mode: 'sequence_row', headers: [], rows: [], columnName: '' };
      if (!stepCsv.mode || stepCsv.mode === 'match_row') stepCsv.mode = 'sequence_row';
      const stepHeaders = stepCsv.enabled && Array.isArray(stepCsv.headers) ? stepCsv.headers : [];
      const ifSource = step.options?.ifSource || (step.selector ? 'dom_element' : 'csv_or_var');
      const needsSelector =
        step.type === 'condition'
          ? ifSource === 'dom_element'
          : !['navigate', 'wait'].includes(step.type) || (step.type === 'wait' && step.options?.waitMode === 'element');
      const verifyCond = step.options?.verifyCondition || (step.type === 'condition' ? 'equals' : 'contains');
      const verifyNoValueNeeded = [
        'not_empty',
        'is_empty',
        'contains_integer',
        'is_number',
        'element_exists',
        'element_not_exists'
      ].includes(verifyCond);
      step.options = step.options || {};
      const ensureDashBranchActions = (opts, branchKey) => {
        const arrKey = branchKey === 'else' ? 'elseActions' : 'thenActions';
        const legacyKey = branchKey === 'else' ? 'elseBranch' : 'thenBranch';
        if (!Array.isArray(opts[arrKey]) || opts[arrKey].length === 0) {
          if (opts[legacyKey] && typeof opts[legacyKey] === 'object') {
            opts[arrKey] = [{ ...opts[legacyKey] }];
          } else {
            opts[arrKey] = [
              {
                mode: branchKey === 'else' ? 'continue' : 'click',
                selector: branchKey === 'then' ? step.selector || '' : '',
                value: '',
                targetStepNumber: '',
                pressEnter: false
              }
            ];
          }
        }
        return opts[arrKey];
      };
      const syncDashLegacyBranches = (opts) => {
        if (Array.isArray(opts.thenActions) && opts.thenActions.length > 0) {
          opts.thenBranch = { ...opts.thenActions[0] };
        }
        if (Array.isArray(opts.elseActions) && opts.elseActions.length > 0) {
          opts.elseBranch = { ...opts.elseActions[0] };
        }
      };

      const thenActions = ensureDashBranchActions(step.options, 'then');
      const elseActions = ensureDashBranchActions(step.options, 'else');

      const renderDashBranchCard = (prefix, title, borderCol, actionsList) => {
        return `
          <div style="background:#0f172a;border:1px solid ${borderCol};border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span style="font-weight:700;font-size:12.5px;color:${borderCol};">${title} (${actionsList.length} action${actionsList.length === 1 ? '' : 's'})</span>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn btn-secondary btn-sm" data-dash-chain-add="${prefix}:click" style="border-color:${borderCol};color:${borderCol};">
                  + Add Action
                </button>
                <button type="button" class="btn btn-secondary btn-sm" data-dash-chain-add="${prefix}:nested_if" style="border-color:#ec4899;color:#f9a8d4;">
                  + Nested IF
                </button>
              </div>
            </div>

            ${actionsList
              .map((branchObj, actIdx) => {
                const bMode = branchObj.mode || 'continue';
                const bNeedsSel = ['click', 'input', 'select', 'extract', 'keypress'].includes(bMode);
                const bNeedsVal = ['input', 'select', 'navigate', 'wait', 'keypress'].includes(bMode);
                const bNeedsOutCol = bMode === 'extract';
                const bNeedsJump = bMode === 'jump_to_step';

                return `
                  <div style="background:#1e293b;border:1px solid #334155;border-left:3px solid ${borderCol};border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                      <span style="font-weight:800;font-size:11.5px;color:${borderCol};">#${actIdx + 1}</span>
                      <select class="select" data-dash-chain-mode="${prefix}:${actIdx}" style="flex:1;">
                        <option value="click" ${bMode === 'click' ? 'selected' : ''}>👆 Click Element (Row or Page)</option>
                        <option value="input" ${bMode === 'input' ? 'selected' : ''}>⌨️ Type / Fill Input</option>
                        <option value="select" ${bMode === 'select' ? 'selected' : ''}>▾ Select Dropdown Option</option>
                        <option value="wait" ${bMode === 'wait' ? 'selected' : ''}>⏱ Wait / Delay (Seconds)</option>
                        <option value="keypress" ${bMode === 'keypress' ? 'selected' : ''}>⏎ Press Keyboard Key</option>
                        <option value="extract" ${bMode === 'extract' ? 'selected' : ''}>📋 Extract Data</option>
                        <option value="nested_if" ${bMode === 'nested_if' ? 'selected' : ''}>🔀 Nested IF Condition</option>
                        <option value="continue" ${bMode === 'continue' ? 'selected' : ''}>↪ Continue to Next Step</option>
                        <option value="skip_row" ${bMode === 'skip_row' ? 'selected' : ''}>⏭ Skip Rest of Row</option>
                        <option value="skip_next" ${bMode === 'skip_next' ? 'selected' : ''}>⏭ Skip Next 1 Step</option>
                        <option value="jump_to_step" ${bMode === 'jump_to_step' ? 'selected' : ''}>🔢 Jump to Step #</option>
                        <option value="navigate" ${bMode === 'navigate' ? 'selected' : ''}>🌐 Go to URL</option>
                        <option value="stop_workflow" ${bMode === 'stop_workflow' ? 'selected' : ''}>⏹ Stop Entire Workflow</option>
                      </select>
                      ${
                        actionsList.length > 1
                          ? `<button type="button" class="btn btn-danger btn-sm" data-dash-chain-del="${prefix}:${actIdx}" title="Remove Action">✕</button>`
                          : ''
                      }
                    </div>

                    ${
                      bNeedsSel
                        ? `<div class="field-group">
                            <label class="field-label">Target CSS Selector (e.g. td:nth-of-type(3) a for current row)</label>
                            <input type="text" class="input mono" data-dash-chain-field="${prefix}:${actIdx}:selector" value="${escapeHtml(branchObj.selector || '')}" placeholder="e.g. td:nth-of-type(3) a, or modal input selector" />
                           </div>`
                        : ''
                    }

                    ${
                      bNeedsVal
                        ? `<div class="field-group">
                            <label class="field-label">${
                              bMode === 'navigate'
                                ? 'Target URL'
                                : bMode === 'wait'
                                ? 'Wait Seconds'
                                : bMode === 'keypress'
                                ? 'Key to Press (Enter, Tab, Escape)'
                                : 'Value to Enter / Select (supports {{Column}} or {{prev.step_X}})'
                            }</label>
                            <div style="position:relative;">
                              <input type="text" class="input" data-dash-chain-field="${prefix}:${actIdx}:value" value="${escapeHtml(branchObj.value || '')}" placeholder="Static text, {{Column_Name}}, or ({{Col}} + 1)" autocomplete="off" />
                              <div class="dash-autocomplete-menu"></div>
                            </div>
                            ${
                              masterHeaders.length > 0 && ['input', 'select', 'navigate'].includes(bMode)
                                ? `<div class="token-bar">
                                    ${masterHeaders
                                      .map((h) => `<span class="token-pill" data-dash-chain-insert="${prefix}:${actIdx}:{{${escapeHtml(h)}}}">+ {{${escapeHtml(h)}}}</span>`)
                                      .join('')}
                                    ${masterHeaders
                                      .filter((h) => /date|esd|time|day|ship|submitted|order|due/i.test(h))
                                      .slice(0, 2)
                                      .map((h) => `<span class="token-pill formula-token" data-dash-chain-insert="${prefix}:${actIdx}:({{${escapeHtml(h)}}} + next business day)" title="Formula: Add next business day">📅 ({{${escapeHtml(h)}}} + next biz day)</span>`)
                                      .join('')}
                                   </div>`
                                : ''
                            }
                           </div>`
                        : ''
                    }

                    ${
                      bNeedsOutCol
                        ? `<div class="field-group">
                            <label class="field-label">Output Column</label>
                            <input type="text" class="input mono" data-dash-chain-field="${prefix}:${actIdx}:outputColumn" value="${escapeHtml(branchObj.outputColumn || 'Branch_Extracted')}" />
                           </div>`
                        : ''
                    }

                    ${
                      bNeedsJump
                        ? `<div class="field-group">
                            <label class="field-label">Jump to Step # (1 to ${steps.length})</label>
                            <input type="number" min="1" max="${steps.length}" class="input" data-dash-chain-field="${prefix}:${actIdx}:targetStepNumber" value="${escapeHtml(branchObj.targetStepNumber || '1')}" />
                           </div>`
                        : ''
                    }

                    ${
                      bMode === 'nested_if'
                        ? `<div style="background:#0f172a;border:1px dashed #ec4899;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;">
                            <div style="font-size:11px;font-weight:700;color:#f9a8d4;">🔀 Nested IF Check:</div>
                            <input type="text" class="input mono" data-dash-chain-field="${prefix}:${actIdx}:ifLeftValue" value="${escapeHtml(branchObj.ifLeftValue || '')}" placeholder="Column / Variable to check (e.g. {{PO_Submitted_Date}})" />
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                              <select class="select" data-dash-chain-field="${prefix}:${actIdx}:verifyCondition">
                                <option value="contains" ${(branchObj.verifyCondition || 'contains') === 'contains' ? 'selected' : ''}>Contains</option>
                                <option value="equals" ${branchObj.verifyCondition === 'equals' ? 'selected' : ''}>Equals (==)</option>
                                <option value="not_equals" ${branchObj.verifyCondition === 'not_equals' ? 'selected' : ''}>Not Equals (!=)</option>
                                <option value="not_empty" ${branchObj.verifyCondition === 'not_empty' ? 'selected' : ''}>Not Empty</option>
                                <option value="is_empty" ${branchObj.verifyCondition === 'is_empty' ? 'selected' : ''}>Is Empty</option>
                              </select>
                              <input type="text" class="input" data-dash-chain-field="${prefix}:${actIdx}:value" value="${escapeHtml(branchObj.value || '')}" placeholder="Expected value..." />
                            </div>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                              <input type="text" class="input mono" data-dash-chain-field="${prefix}:${actIdx}:nestedThenSelector" value="${escapeHtml(branchObj.nestedThenSelector || '')}" placeholder="Nested THEN Selector" />
                              <input type="text" class="input" data-dash-chain-field="${prefix}:${actIdx}:nestedThenValue" value="${escapeHtml(branchObj.nestedThenValue || '')}" placeholder="Nested THEN Value" />
                            </div>
                           </div>`
                        : ''
                    }
                  </div>
                `;
              })
              .join('')}
          </div>
        `;
      };

      // Build list of previous steps (Steps 1 .. idx) that this step can reference
      const prevSteps = [];
      for (let pIdx = 0; pIdx < idx; pIdx++) {
        const ps = steps[pIdx];
        const sNum = pIdx + 1;
        const token =
          ps.type === 'extract' && ps.options?.outputColumn
            ? `{{var.${ps.options.outputColumn}}}`
            : `{{prev.step_${sNum}}}`;
        const label = `Step ${sNum}: ${ps.name || ps.type}${
          ps.type === 'extract' && ps.options?.outputColumn ? ` (${ps.options.outputColumn})` : ''
        }`;
        prevSteps.push({ stepNum: sNum, token, label });
      }

      card.innerHTML = `
        <div class="step-card-header">
          <div class="step-card-left">
            <span class="step-index-circle">${idx + 1}</span>
            <span class="step-type-badge badge-${escapeHtml(step.type)}">${escapeHtml(step.type)}</span>
            <input type="text" class="input" data-field="name" value="${escapeHtml(step.name || '')}" placeholder="Step Name" style="max-width:290px;font-weight:600;" />
            ${
              step.paused
                ? `<span class="tab-badge" style="background:rgba(245,158,11,0.2);color:#fde68a;border:1px solid rgba(245,158,11,0.5);font-weight:700;">
                    ⏸ PAUSED (Skipped on Run)
                   </span>`
                : ''
            }
            ${
              stepCsv.enabled
                ? `<span class="tab-badge" style="background:rgba(59,130,246,0.2);color:#93c5fd;border:1px solid rgba(59,130,246,0.4);">
                    CSV Mapped: ${escapeHtml(stepCsv.fileName || 'Attached')} (${stepCsv.rows?.length || 0} rows · ${stepCsv.mode === 'loop_step' ? 'Step Loop' : '1 Row / Full Sequence'})
                   </span>`
                : ''
            }
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-secondary btn-sm" data-act="toggle-pause" title="${step.paused ? 'Resume / Enable Step' : 'Pause Step for Testing (Skip during workflow runs)'}" style="${step.paused ? 'border-color:#f59e0b;color:#fde68a;' : ''}">
              ${step.paused ? '▶ Resume Step' : '⏸ Pause'}
            </button>
            <button class="btn btn-secondary btn-sm" data-act="up" ${idx === 0 ? 'disabled' : ''} title="Move Step Up">↑</button>
            <button class="btn btn-secondary btn-sm" data-act="down" ${idx === steps.length - 1 ? 'disabled' : ''} title="Move Step Down">↓</button>
            <button class="btn btn-secondary btn-sm" data-act="dup" title="Duplicate Step">⧉ Duplicate</button>
            <button class="btn btn-danger btn-sm" data-act="del" title="Delete Step">✕</button>
          </div>
        </div>

        <div class="step-grid">
          <div class="field-group">
            <label class="field-label">Action Type</label>
            <select class="select" data-field="type">
              <option value="navigate" ${step.type === 'navigate' ? 'selected' : ''}>🌐 Go to Domain / URL</option>
              <option value="click" ${step.type === 'click' ? 'selected' : ''}>👆 Click Element</option>
              <option value="input" ${step.type === 'input' ? 'selected' : ''}>⌨️ Type / Fill Input</option>
              <option value="condition" ${step.type === 'condition' ? 'selected' : ''}>🔀 IF / THEN / ELSE Condition</option>
              <option value="verify" ${step.type === 'verify' ? 'selected' : ''}>✓ Check / Verify Content</option>
              <option value="extract" ${step.type === 'extract' ? 'selected' : ''}>📋 Extract / Scrape Data</option>
              <option value="select" ${step.type === 'select' ? 'selected' : ''}>▾ Select Dropdown</option>
              <option value="wait" ${step.type === 'wait' ? 'selected' : ''}>⏱ Wait / Delay</option>
              <option value="scroll" ${step.type === 'scroll' ? 'selected' : ''}>↕ Scroll Page / Element</option>
              <option value="keypress" ${step.type === 'keypress' ? 'selected' : ''}>⏎ Press Keyboard Key</option>
            </select>
          </div>

          ${
            step.type === 'condition'
              ? `
            <div class="field-group">
              <label class="field-label" style="color:#f9a8d4;">🔀 IF — What to Check</label>
              <select class="select" data-opt-rerender="ifSource">
                <option value="csv_or_var" ${ifSource === 'csv_or_var' ? 'selected' : ''}>📄 CSV Cell Value / Previous Step Data (e.g. {{Column}})</option>
                <option value="dom_element" ${ifSource === 'dom_element' ? 'selected' : ''}>🌐 Page HTML Element (Text, Value, HTML, Exists)</option>
              </select>
            </div>
            ${
              ifSource === 'csv_or_var'
                ? `
              <div class="field-group" style="grid-column: span 2;">
                <label class="field-label">CSV Column or Variable to Check (Left-Hand Side of IF)</label>
                <input type="text" class="input mono" data-opt="ifLeftValue" value="${escapeHtml(step.options?.ifLeftValue || '')}" placeholder="e.g. {{Cancel_Reason}} or {{Quantity}} or {{prev.step_1}}" />
                ${
                  masterHeaders.length > 0 || prevSteps.length > 0
                    ? `<div class="token-bar">
                        <span style="font-size:10.5px;color:#94a3b8;align-self:center;">Pick Column / Step to Check:</span>
                        ${masterHeaders
                          .map((h) => `<span class="token-pill" data-ifleft-insert="{{${escapeHtml(h)}}}">+ {{${escapeHtml(h)}}}</span>`)
                          .join('')}
                        ${prevSteps
                          .map((ps) => `<span class="token-pill" style="background:rgba(168,85,247,0.16);color:#d8b4fe;border-color:rgba(168,85,247,0.4);" data-ifleft-insert="${escapeHtml(ps.token)}">🔗 Step ${ps.stepNum} (${escapeHtml(ps.token)})</span>`)
                          .join('')}
                       </div>`
                    : ''
                }
              </div>
            `
                : ''
            }
          `
              : ''
          }

          ${
            needsSelector
              ? `
            <div class="field-group">
              <label class="field-label">
                <span>
                  Target CSS Selector
                  ${
                    step.options?.validationReport
                      ? `<span style="margin-left:6px;font-size:10.5px;color:#34d399;font-weight:600;" title="${escapeHtml(step.options.validationReport.detail || '')}">${escapeHtml(step.options.validationReport.badgeText)}</span>`
                      : ''
                  }
                </span>
                <span style="display:flex;gap:10px;align-items:center;">
                  ${
                    /\d{4,}|\(\d+\)/.test(step.selector || '') && !/\^=|\*=|\$=/.test(step.selector || '')
                      ? `<span style="color:#fbbf24;cursor:pointer;font-weight:700;" data-act="convert-wildcard" title="Strip dynamic order/item IDs and convert to a reusable wildcard selector">✨ Convert to Wildcard</span>`
                      : ''
                  }
                  ${
                    builderSession.active && builderSession.projectId === proj.id
                      ? `<span style="color:#60a5fa;cursor:pointer;" data-act="highlight-tab">Highlight on Tab</span>`
                      : ''
                  }
                </span>
              </label>
              <input type="text" class="input mono" data-field="selector" value="${escapeHtml(step.selector || '')}" placeholder="e.g. input[name^='order('][name$=').cancelled'], #submit-btn" />
            </div>

            <div class="field-group">
              <label class="field-label" title="If an order table has multiple item rows, enter text or a CSV column like {{Partner SKU}} or {{UPC}} to scope this step to the matching table row!">
                <span>🎯 Scope to Table Row Containing Text (Optional, for Multi-Item Tables)</span>
              </label>
              <input type="text" class="input" data-opt="rowAnchorText" value="${escapeHtml(step.options?.rowAnchorText || '')}" placeholder="Leave blank, or e.g. {{Partner SKU}}, {{UPC}}, {{Line Number}}" />
            </div>
          `
              : ''
          }

          ${
            step.type === 'verify' || step.type === 'condition'
              ? `
            ${
              step.type === 'verify' || (step.type === 'condition' && ifSource === 'dom_element')
                ? `<div class="field-group">
                    <label class="field-label">What to Check on Element</label>
                    <select class="select" data-opt="extractTarget">
                      <option value="text" ${step.options?.extractTarget === 'text' ? 'selected' : ''}>Visible Text / Content</option>
                      <option value="value" ${step.options?.extractTarget === 'value' ? 'selected' : ''}>Input Value</option>
                      <option value="href" ${step.options?.extractTarget === 'href' ? 'selected' : ''}>Link URL (href)</option>
                      <option value="html" ${step.options?.extractTarget === 'html' ? 'selected' : ''}>Inner HTML</option>
                    </select>
                  </div>`
                : ''
            }
            <div class="field-group">
              <label class="field-label">${step.type === 'condition' ? 'IF Condition Operator' : 'Check Condition'}</label>
              <select class="select" data-opt-rerender="verifyCondition">
                <option value="equals" ${verifyCond === 'equals' ? 'selected' : ''}>Equals exact match (==)</option>
                <option value="not_equals" ${verifyCond === 'not_equals' ? 'selected' : ''}>Does NOT equal (!=)</option>
                <option value="contains" ${verifyCond === 'contains' ? 'selected' : ''}>Contains word / string</option>
                <option value="not_contains" ${verifyCond === 'not_contains' ? 'selected' : ''}>Does NOT contain word / string</option>
                <option value="starts_with" ${verifyCond === 'starts_with' ? 'selected' : ''}>Starts with</option>
                <option value="ends_with" ${verifyCond === 'ends_with' ? 'selected' : ''}>Ends with</option>
                <option value="is_integer" ${verifyCond === 'is_integer' ? 'selected' : ''}>Is an Integer (Whole Number)</option>
                <option value="contains_integer" ${verifyCond === 'contains_integer' ? 'selected' : ''}>Contains Integer / Digits</option>
                <option value="is_number" ${verifyCond === 'is_number' ? 'selected' : ''}>Is a Number / Price / Decimal</option>
                <option value="gt" ${verifyCond === 'gt' ? 'selected' : ''}>Number Greater Than (&gt;)</option>
                <option value="gte" ${verifyCond === 'gte' ? 'selected' : ''}>Number Greater or Equal (&gt;=)</option>
                <option value="lt" ${verifyCond === 'lt' ? 'selected' : ''}>Number Less Than (&lt;)</option>
                <option value="lte" ${verifyCond === 'lte' ? 'selected' : ''}>Number Less or Equal (&lt;=)</option>
                <option value="not_empty" ${verifyCond === 'not_empty' ? 'selected' : ''}>Has Value / Not Empty</option>
                <option value="is_empty" ${verifyCond === 'is_empty' ? 'selected' : ''}>Is Empty / Blank</option>
                ${
                  step.type === 'condition' && ifSource === 'dom_element'
                    ? `<option value="element_exists" ${verifyCond === 'element_exists' ? 'selected' : ''}>Element Exists on Page</option>
                       <option value="element_not_exists" ${verifyCond === 'element_not_exists' ? 'selected' : ''}>Element Does NOT Exist on Page</option>`
                    : ''
                }
                <option value="regex" ${verifyCond === 'regex' ? 'selected' : ''}>Matches Regular Expression</option>
              </select>
            </div>
            ${
              step.type === 'verify'
                ? `<div class="field-group">
                    <label class="field-label">If Check Fails</label>
                    <select class="select" data-opt="onVerifyFail">
                      <option value="skip_row" ${(step.options?.onVerifyFail || 'skip_row') === 'skip_row' ? 'selected' : ''}>Skip remaining steps for this CSV row</option>
                      <option value="continue" ${step.options?.onVerifyFail === 'continue' ? 'selected' : ''}>Record PASS/FAIL & continue sequence</option>
                      <option value="stop_workflow" ${step.options?.onVerifyFail === 'stop_workflow' ? 'selected' : ''}>Stop entire workflow immediately</option>
                    </select>
                  </div>`
                : ''
            }
          `
              : ''
          }

          ${
            step.type === 'extract'
              ? `
            <div class="field-group">
              <label class="field-label">What to Extract</label>
              <select class="select" data-opt="extractTarget">
                <option value="text" ${step.options?.extractTarget === 'text' ? 'selected' : ''}>Visible Text (innerText)</option>
                <option value="href" ${step.options?.extractTarget === 'href' ? 'selected' : ''}>Link URL (href)</option>
                <option value="src" ${step.options?.extractTarget === 'src' ? 'selected' : ''}>Media URL (src)</option>
                <option value="value" ${step.options?.extractTarget === 'value' ? 'selected' : ''}>Input Value</option>
                <option value="html" ${step.options?.extractTarget === 'html' ? 'selected' : ''}>Inner HTML</option>
                <option value="custom_attr" ${step.options?.extractTarget === 'custom_attr' ? 'selected' : ''}>Custom HTML Attribute</option>
              </select>
            </div>
            <div class="field-group">
              <label class="field-label">Save to Output CSV Column</label>
              <input type="text" class="input mono" data-opt="outputColumn" value="${escapeHtml(step.options?.outputColumn || 'Extracted_Data')}" placeholder="e.g. Product_Title" />
            </div>
          `
              : step.type === 'click' || ((step.type === 'verify' || step.type === 'condition') && verifyNoValueNeeded)
              ? ''
              : `
            <div class="field-group" style="grid-column: span 2;">
              <label class="field-label">
                <span>${
                  step.type === 'navigate'
                    ? 'Target URL (supports {{column}} or {{prev.step_X}})'
                    : step.type === 'verify' || step.type === 'condition'
                    ? 'Expected Word / String / Number to Match (or pick from CSV / Previous Step)'
                    : step.type === 'wait'
                    ? 'Wait Duration (Seconds)'
                    : step.type === 'keypress'
                    ? 'Key Name (Enter, Tab, Escape, ArrowDown)'
                    : 'Input / Action Value (Static text, {{column}}, or Previous Step data)'
                }</span>
              </label>
              <div style="display:flex;gap:8px;">
                <div style="flex:1.4;position:relative;">
                  <input type="text" class="input" data-field="value" value="${escapeHtml(step.value || '')}" placeholder="${
                    step.type === 'navigate'
                      ? 'https://example.com/search?q={{query}}'
                      : step.type === 'verify'
                      ? 'Expected word, string, or number...'
                      : 'Value, {{csv_column}}, or ({{Col}} + 1)'
                  }" style="width:100%;" autocomplete="off" />
                  <div class="dash-autocomplete-menu"></div>
                </div>
                ${
                  prevSteps.length > 0
                    ? `<select class="select" data-prev-step-select style="flex:1;border-color:rgba(168,85,247,0.45);color:#e9d5ff;font-size:12px;">
                        <option value="">🔗 Refer to Previous Step Data...</option>
                        ${prevSteps
                          .map(
                            (ps) =>
                              `<option value="${escapeHtml(ps.token)}">Use ${escapeHtml(ps.label)} → ${escapeHtml(ps.token)}</option>`
                          )
                          .join('')}
                       </select>`
                    : ''
                }
              </div>
              ${
                masterHeaders.length > 0 || stepHeaders.length > 0 || prevSteps.length > 0
                  ? `<div class="token-bar">
                      <span style="font-size:10.5px;color:#94a3b8;align-self:center;">Insert Variable:</span>
                      ${masterHeaders
                        .map((h) => `<span class="token-pill" data-insert-token="{{${escapeHtml(h)}}}">+ {{${escapeHtml(h)}}}</span>`)
                        .join('')}
                      ${stepHeaders
                        .filter((h) => !masterHeaders.includes(h))
                        .map((h) => `<span class="token-pill step-token" data-insert-token="{{step.${escapeHtml(h)}}}">+ {{step.${escapeHtml(h)}}}</span>`)
                        .join('')}
                      ${prevSteps
                        .map(
                          (ps) =>
                            `<span class="token-pill" style="background:rgba(168,85,247,0.16);color:#d8b4fe;border-color:rgba(168,85,247,0.4);" data-insert-token="${escapeHtml(ps.token)}" title="Insert output from ${escapeHtml(ps.label)}">🔗 Step ${ps.stepNum} (${escapeHtml(ps.token)})</span>`
                        )
                        .join('')}
                      ${Array.from(new Set([...masterHeaders, ...stepHeaders]))
                        .filter((h) => /date|esd|time|day|ship|submitted|order|due/i.test(h))
                        .map((h) => `
                          <span class="token-pill formula-token" data-insert-token="({{${escapeHtml(h)}}} + next business day)" title="Formula: Add next business day (skips weekend)">📅 ({{${escapeHtml(h)}}} + next biz day)</span>
                          <span class="token-pill formula-token" data-insert-token="({{${escapeHtml(h)}}} + 1 day)" title="Formula: Add 1 calendar day">📅 ({{${escapeHtml(h)}}} + 1 day)</span>
                        `)
                        .join('')}
                      ${Array.from(new Set([...masterHeaders, ...stepHeaders]))
                        .filter((h) => /qty|quantity|price|amount|total|cost|rate|num|count/i.test(h))
                        .map((h) => `
                          <span class="token-pill formula-token" data-insert-token="({{${escapeHtml(h)}}} + 1)" title="Formula: Add 1">🧮 ({{${escapeHtml(h)}}} + 1)</span>
                        `)
                        .join('')}
                     </div>`
                  : ''
              }
            </div>
          `
          }

          <div class="field-group">
            <label class="field-label">Wait After Step (ms)</label>
            <input type="number" class="input" data-opt="waitAfterMs" value="${step.options?.waitAfterMs ?? 600}" min="0" step="100" />
          </div>

          ${
            step.type === 'condition'
              ? `
            <div style="grid-column: 1 / -1; display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 4px;">
              ${renderDashBranchCard('then', '✅ THEN (When IF is TRUE)', '#10b981', thenActions)}
              ${renderDashBranchCard('else', '❌ ELSE (When IF is FALSE)', '#f59e0b', elseActions)}
            </div>
          `
              : ''
          }
        </div>

        <!-- Step Options & Dedicated Step-Level CSV Mapping -->
        <div class="step-csv-panel">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div style="display:flex;align-items:center;gap:16px;">
              ${
                step.type === 'input'
                  ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer;">
                      <input type="checkbox" data-opt-bool="pressEnter" ${step.options?.pressEnter ? 'checked' : ''} />
                      Press <b>Enter</b> after typing
                     </label>
                     <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer;">
                      <input type="checkbox" data-opt-bool="clearFirst" ${step.options?.clearFirst !== false ? 'checked' : ''} />
                      Clear input field before typing
                     </label>`
                  : ''
              }
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer;">
                <input type="checkbox" data-opt-bool="optional" ${step.options?.optional ? 'checked' : ''} />
                Continue workflow if element not found (Optional Step)
              </label>
            </div>

            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#93c5fd;cursor:pointer;font-weight:600;">
                <input type="checkbox" data-stepcsv-toggle ${stepCsv.enabled && stepCsv.sourceType !== 'page_table' ? 'checked' : ''} />
                📂 Pick Value from CSV File on This Step
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#7dd3fc;cursor:pointer;font-weight:600;">
                <input type="checkbox" data-steptable-toggle ${stepCsv.enabled && stepCsv.sourceType === 'page_table' ? 'checked' : ''} />
                🌐 Pick Value from Page Table / HTML List on This Step
              </label>
            </div>
          </div>

          ${
            stepCsv.enabled && stepCsv.sourceType !== 'page_table'
              ? `
            <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
                  Upload .CSV File
                  <input type="file" accept=".csv,text/csv" data-stepcsv-file style="display:none;" />
                </label>
                <span style="font-size:12px;color:#cbd5e1;">
                  ${
                    stepCsv.fileName
                      ? `<b>${escapeHtml(stepCsv.fileName)}</b> (${stepCsv.rows?.length || 0} rows · Columns: ${(stepCsv.headers || []).join(', ')})`
                      : 'No CSV uploaded on this step yet'
                  }
                </span>
              </div>

              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <select class="select" data-stepcsv-mode style="width:auto;padding:5px 8px;font-size:12px;">
                  <option value="sequence_row" ${stepCsv.mode !== 'loop_step' ? 'selected' : ''}>Pick 1 row per Full Sequence Flow (e.g. 20 rows = run whole sequence 20 times)</option>
                  <option value="loop_step" ${stepCsv.mode === 'loop_step' ? 'selected' : ''}>Repeat only this single step for all rows before next step</option>
                </select>
                <select class="select" data-stepcsv-col style="width:auto;padding:5px 8px;font-size:12px;">
                  <option value="">-- Select Column to Pick --</option>
                  ${(stepCsv.headers || [])
                    .map((h) => `<option value="${escapeHtml(h)}" ${stepCsv.columnName === h ? 'selected' : ''}>Column: ${escapeHtml(h)}</option>`)
                    .join('')}
                </select>
              </div>
            </div>
          `
              : ''
          }

          ${
            stepCsv.enabled && stepCsv.sourceType === 'page_table'
              ? `
            <div style="background:rgba(14,165,233,0.08);border:1px solid rgba(56,189,248,0.35);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <button type="button" class="btn btn-secondary btn-sm" data-steptable-pick style="background:rgba(14,165,233,0.18);border-color:#0284c7;color:#7dd3fc;">
                  🎯 ${stepCsv.containerSelector ? 'Re-Pick Table on Page' : 'Pick Table on Page'}
                </button>
                <span style="font-size:12px;color:#e0f2fe;">
                  ${
                    stepCsv.containerSelector
                      ? `<b>${escapeHtml(stepCsv.fileName || stepCsv.containerSelector)}</b> (${stepCsv.rows?.length || 0} rows · Columns: ${(stepCsv.headers || []).join(', ')})`
                      : 'Click "🎯 Pick Table on Page" or pick any table cell with the element picker'
                  }
                </span>
              </div>

              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <select class="select" data-stepcsv-mode style="width:auto;padding:5px 8px;font-size:12px;">
                  <option value="sequence_row" ${stepCsv.mode !== 'loop_step' ? 'selected' : ''}>Pick 1 row per Full Sequence Flow (e.g. 20 rows = run whole sequence 20 times)</option>
                  <option value="loop_step" ${stepCsv.mode === 'loop_step' ? 'selected' : ''}>Repeat only this single step for all rows before next step</option>
                </select>
                <select class="select" data-stepcsv-col style="width:auto;padding:5px 8px;font-size:12px;">
                  <option value="">-- Select Column from Table --</option>
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
      `;

      // Bind Step Card Events
      card.querySelectorAll('[data-field]').forEach((inputEl) => {
        inputEl.addEventListener('change', (e) => {
          const field = e.target.getAttribute('data-field');
          step[field] = e.target.value;
          saveCurrentProject();
          if (field === 'type') renderAll();
        });
      });

      card.querySelectorAll('[data-opt]').forEach((optEl) => {
        optEl.addEventListener('change', (e) => {
          const optKey = e.target.getAttribute('data-opt');
          step.options = step.options || {};
          step.options[optKey] = optKey === 'waitAfterMs' ? Number(e.target.value) : e.target.value;
          saveCurrentProject();
        });
      });

      card.querySelectorAll('[data-opt-rerender]').forEach((optEl) => {
        optEl.addEventListener('change', (e) => {
          const optKey = e.target.getAttribute('data-opt-rerender');
          step.options = step.options || {};
          step.options[optKey] = e.target.value;
          saveCurrentProject();
          renderStepsSequencer(proj);
        });
      });

      card.querySelector('[data-prev-step-select]')?.addEventListener('change', (e) => {
        const token = e.target.value;
        if (token) {
          step.value = (step.value || '') + token;
          saveCurrentProject();
          renderStepsSequencer(proj);
        }
      });

      card.querySelectorAll('[data-opt-bool]').forEach((chkEl) => {
        chkEl.addEventListener('change', (e) => {
          const optKey = e.target.getAttribute('data-opt-bool');
          step.options = step.options || {};
          step.options[optKey] = e.target.checked;
          saveCurrentProject();
        });
      });

      card.querySelectorAll('[data-insert-token]').forEach((pill) => {
        pill.addEventListener('click', () => {
          const token = pill.getAttribute('data-insert-token');
          const curVal = step.value || '';
          if (!curVal || (token.startsWith('(') && curVal.startsWith('{{') && curVal.endsWith('}}'))) {
            step.value = token;
          } else {
            step.value = curVal + token;
          }
          saveCurrentProject();
          renderStepsSequencer(proj);
        });
      });

      // Autocomplete on step value input
      const valInput = card.querySelector('input[data-field="value"]');
      const valMenu = valInput?.parentElement?.querySelector('.dash-autocomplete-menu');
      if (valInput && valMenu) {
        setupDashboardFormulaAutocomplete(valInput, valMenu, () => Array.from(headerSet), (newVal) => {
          step.value = newVal;
          saveCurrentProject();
        });
      }

      // Autocomplete on chained action value inputs
      card.querySelectorAll('[data-dash-chain-field*=":value"]').forEach((cInp) => {
        const cMenu = cInp.parentElement?.querySelector('.dash-autocomplete-menu');
        if (cMenu) {
          setupDashboardFormulaAutocomplete(cInp, cMenu, () => Array.from(headerSet), (newVal) => {
            const raw = cInp.getAttribute('data-dash-chain-field') || '';
            const [prefix, idxStr] = raw.split(':');
            const actIdx = parseInt(idxStr, 10);
            const arr = ensureDashBranchActions(step.options, prefix);
            if (arr[actIdx]) {
              arr[actIdx].value = newVal;
              syncLegacyBranch(step.options, prefix);
              saveCurrentProject();
            }
          });
        }
      });

      card.querySelectorAll('[data-ifleft-insert]').forEach((pill) => {
        pill.addEventListener('click', () => {
          const token = pill.getAttribute('data-ifleft-insert');
          step.options = step.options || {};
          step.options.ifLeftValue = token;
          saveCurrentProject();
          renderStepsSequencer(proj);
        });
      });

      card.querySelectorAll('[data-dash-chain-add]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const [prefix, defaultMode] = (btn.getAttribute('data-dash-chain-add') || '').split(':');
          step.options = step.options || {};
          const arr = ensureDashBranchActions(step.options, prefix);
          arr.push({
            mode: defaultMode || 'click',
            selector: '',
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
          syncDashLegacyBranches(step.options);
          saveCurrentProject();
          renderStepsSequencer(proj);
        });
      });

      card.querySelectorAll('[data-dash-chain-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const [prefix, idxStr] = (btn.getAttribute('data-dash-chain-del') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          step.options = step.options || {};
          const arr = ensureDashBranchActions(step.options, prefix);
          if (arr.length > 1) {
            arr.splice(actIdx, 1);
            syncDashLegacyBranches(step.options);
            saveCurrentProject();
            renderStepsSequencer(proj);
          }
        });
      });

      card.querySelectorAll('[data-dash-chain-mode]').forEach((selEl) => {
        selEl.addEventListener('change', (e) => {
          const [prefix, idxStr] = (e.target.getAttribute('data-dash-chain-mode') || '').split(':');
          const actIdx = parseInt(idxStr, 10);
          step.options = step.options || {};
          const arr = ensureDashBranchActions(step.options, prefix);
          if (arr[actIdx]) {
            arr[actIdx].mode = e.target.value;
            syncDashLegacyBranches(step.options);
            saveCurrentProject();
            renderStepsSequencer(proj);
          }
        });
      });

      card.querySelectorAll('[data-dash-chain-field]').forEach((inEl) => {
        inEl.addEventListener('change', (e) => {
          const raw = e.target.getAttribute('data-dash-chain-field') || '';
          const [prefix, idxStr, fieldName] = raw.split(':');
          const actIdx = parseInt(idxStr, 10);
          step.options = step.options || {};
          const arr = ensureDashBranchActions(step.options, prefix);
          if (arr[actIdx] && fieldName) {
            arr[actIdx][fieldName] = e.target.value;
            syncDashLegacyBranches(step.options);
            saveCurrentProject();
          }
        });
      });

      card.querySelectorAll('[data-dash-chain-insert]').forEach((pill) => {
        pill.addEventListener('click', () => {
          const raw = pill.getAttribute('data-dash-chain-insert') || '';
          const parts = raw.split(':');
          const prefix = parts[0];
          const actIdx = parseInt(parts[1], 10);
          const token = parts.slice(2).join(':');
          step.options = step.options || {};
          const arr = ensureDashBranchActions(step.options, prefix);
          if (arr[actIdx]) {
            arr[actIdx].value = (arr[actIdx].value || '') + token;
            syncDashLegacyBranches(step.options);
            saveCurrentProject();
            renderStepsSequencer(proj);
          }
        });
      });

      card.querySelector('[data-stepcsv-toggle]')?.addEventListener('change', (e) => {
        step.stepCsv = step.stepCsv || { enabled: false, sourceType: 'csv_file', mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' };
        step.stepCsv.enabled = e.target.checked;
        step.stepCsv.sourceType = 'csv_file';
        if (!step.stepCsv.mode || step.stepCsv.mode === 'match_row' || step.stepCsv.mode === 'loop_step') {
          step.stepCsv.mode = 'sequence_row';
        }
        // Automatically reuse CSV from Master CSV or an earlier step if this step doesn't have one yet
        if (e.target.checked && (!step.stepCsv.rows || step.stepCsv.rows.length === 0)) {
          let existingCsv = null;
          if (proj.masterCsv && Array.isArray(proj.masterCsv.rows) && proj.masterCsv.rows.length > 0 && proj.masterCsv.sourceType !== 'page_table') {
            existingCsv = proj.masterCsv;
          } else {
            for (const st of proj.steps || []) {
              if (st.stepCsv && st.stepCsv.sourceType !== 'page_table' && Array.isArray(st.stepCsv.rows) && st.stepCsv.rows.length > 0) {
                existingCsv = st.stepCsv;
                break;
              }
            }
          }
          if (existingCsv) {
            step.stepCsv.fileName = existingCsv.fileName;
            step.stepCsv.headers = [...existingCsv.headers];
            step.stepCsv.rows = existingCsv.rows;
          }
        }
        saveCurrentProject();
        renderAll();
      });

      card.querySelector('[data-steptable-toggle]')?.addEventListener('change', (e) => {
        step.stepCsv = step.stepCsv || { enabled: false, sourceType: 'page_table', mode: 'sequence_row', fileName: '', containerSelector: '', rowSelector: '', headers: [], rows: [], columnName: '' };
        step.stepCsv.enabled = e.target.checked;
        step.stepCsv.sourceType = 'page_table';
        if (!step.stepCsv.mode || step.stepCsv.mode === 'match_row') {
          step.stepCsv.mode = 'sequence_row';
        }
        if (e.target.checked) {
          let existingTable = null;
          if (proj.pageTableSource && proj.pageTableSource.containerSelector && Array.isArray(proj.pageTableSource.headers)) {
            existingTable = proj.pageTableSource;
          } else {
            for (const st of proj.steps || []) {
              if (st.stepCsv && st.stepCsv.sourceType === 'page_table' && st.stepCsv.containerSelector) {
                existingTable = st.stepCsv;
                break;
              }
            }
          }
          if (existingTable) {
            step.stepCsv.fileName = existingTable.fileName || existingTable.label || existingTable.containerSelector;
            step.stepCsv.containerSelector = existingTable.containerSelector;
            step.stepCsv.rowSelector = existingTable.rowSelector || 'tbody tr, tr';
            step.stepCsv.headers = [...(existingTable.headers || [])];
            step.stepCsv.rows = existingTable.rows || [];
            if (!step.stepCsv.columnName && step.stepCsv.headers[0]) {
              step.stepCsv.columnName = step.stepCsv.headers[0];
              if (step.type === 'condition') {
                step.options = step.options || {};
                step.options.ifSource = 'csv_or_var';
                if (!step.options.ifLeftValue) {
                  step.options.ifLeftValue = `{{${step.stepCsv.headers[0]}}}`;
                }
              } else if (!step.value) {
                step.value = `{{${step.stepCsv.headers[0]}}}`;
              }
            }
          }
        }
        saveCurrentProject();
        renderAll();
      });

      card.querySelector('[data-steptable-pick]')?.addEventListener('click', () => {
        if (builderSession.tabId) {
          chrome.tabs.update(builderSession.tabId, { active: true });
          chrome.tabs.sendMessage(builderSession.tabId, {
            type: 'START_TABLE_SOURCE_PICK',
            projectId: proj.id,
            stepId: step.id
          });
        } else {
          launchVisualBuilder(proj);
        }
      });

      card.querySelector('[data-stepcsv-mode]')?.addEventListener('change', (e) => {
        step.stepCsv.mode = e.target.value;
        saveCurrentProject();
        renderAll();
      });

      card.querySelector('[data-stepcsv-col]')?.addEventListener('change', (e) => {
        step.stepCsv.columnName = e.target.value;
        if (e.target.value) {
          if (step.type === 'condition') {
            step.options = step.options || {};
            step.options.ifSource = 'csv_or_var';
            step.options.ifLeftValue = `{{${e.target.value}}}`;
          } else {
            step.value = `{{${e.target.value}}}`;
          }
        }
        saveCurrentProject();
        renderStepsSequencer(proj);
      });

      card.querySelector('[data-stepcsv-file]')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
          step.stepCsv = {
            enabled: true,
            sourceType: 'csv_file',
            mode: step.stepCsv?.mode === 'loop_single_step' ? 'loop_single_step' : 'sequence_row',
            fileName: file.name,
            headers: parsed.headers,
            rows: parsed.rows,
            columnName: parsed.headers[0] || ''
          };
          if (parsed.headers[0]) {
            if (step.type === 'condition') {
              step.options = step.options || {};
              step.options.ifSource = 'csv_or_var';
              step.options.ifLeftValue = `{{${parsed.headers[0]}}}`;
            } else {
              step.value = `{{${parsed.headers[0]}}}`;
            }
          }
          if (!proj.masterCsv || !proj.masterCsv.rows || proj.masterCsv.rows.length === 0) {
            proj.masterCsv = {
              enabled: true,
              fileName: file.name,
              headers: parsed.headers,
              rows: parsed.rows
            };
          }
          saveCurrentProject();
          renderAll();
        };
        reader.readAsText(file);
      });

      card.querySelector('[data-act="convert-wildcard"]')?.addEventListener('click', () => {
        const converted = convertHardcodedSelectorToWildcard(step.selector || '');
        if (converted && converted !== step.selector) {
          step.options = step.options || {};
          step.options.fallbackSelectors = step.options.fallbackSelectors || [];
          if (!step.options.fallbackSelectors.includes(step.selector)) {
            step.options.fallbackSelectors.push(step.selector);
          }
          step.selector = converted;
          step.options.validationReport = {
            status: 'verified_unique',
            badgeText: '✓ Converted to Wildcard Pattern',
            detail: 'Dynamic IDs stripped so this step works across all orders.'
          };
          saveCurrentProject();
          renderStepsSequencer(proj);
        }
      });

      card.querySelector('[data-act="highlight-tab"]')?.addEventListener('click', () => {
        if (builderSession.tabId) {
          chrome.tabs.sendMessage(builderSession.tabId, {
            type: 'HIGHLIGHT_SELECTOR_PREVIEW',
            selector: step.selector
          });
        }
      });

      card.querySelector('[data-act="toggle-pause"]')?.addEventListener('click', () => {
        step.paused = !step.paused;
        saveCurrentProject();
        renderAll();
      });

      card.querySelector('[data-act="up"]')?.addEventListener('click', () => {
        if (idx > 0) {
          [steps[idx - 1], steps[idx]] = [steps[idx], steps[idx - 1]];
          saveCurrentProject();
          renderAll();
        }
      });

      card.querySelector('[data-act="down"]')?.addEventListener('click', () => {
        if (idx < steps.length - 1) {
          [steps[idx + 1], steps[idx]] = [steps[idx], steps[idx + 1]];
          saveCurrentProject();
          renderAll();
        }
      });

      card.querySelector('[data-act="dup"]')?.addEventListener('click', () => {
        const clone = JSON.parse(JSON.stringify(step));
        clone.id = 'step_' + Date.now();
        clone.name = (clone.name || 'Step') + ' (Copy)';
        steps.splice(idx + 1, 0, clone);
        saveCurrentProject();
        renderAll();
      });

      card.querySelector('[data-act="del"]')?.addEventListener('click', () => {
        steps.splice(idx, 1);
        saveCurrentProject();
        renderAll();
      });

      stepsContainer.appendChild(card);
    });
  }

  // Add step buttons
  document.querySelectorAll('[data-add-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const proj = getCurrentProject();
      if (!proj) return;
      const type = btn.getAttribute('data-add-step');
      const defaults = {
        navigate: { name: 'Go to URL', value: proj.startUrl || 'https://example.com', selector: '' },
        click: { name: 'Click Element', value: '', selector: 'button' },
        input: { name: 'Type into Input', value: '', selector: 'input[type="text"]' },
        condition: { name: 'IF / THEN / ELSE Condition', value: '', selector: '' },
        verify: { name: 'Check Element Content', value: '', selector: 'h1' },
        extract: { name: 'Extract Data', value: '', selector: 'h1' },
        select: { name: 'Select Dropdown', value: '', selector: 'select' },
        wait: { name: 'Wait 2 Seconds', value: '2', selector: '' },
        scroll: { name: 'Scroll Page', value: '500', selector: '' },
        keypress: { name: 'Press Enter Key', value: 'Enter', selector: 'input' }
      }[type] || { name: 'New Step', value: '', selector: '' };

      const firstMasterCol = proj.masterCsv?.headers?.[0] ? `{{${proj.masterCsv.headers[0]}}}` : '';

      proj.steps.push({
        id: 'step_' + Date.now(),
        name: defaults.name,
        type,
        selector: defaults.selector,
        value: defaults.value,
        options: {
          clearFirst: true,
          pressEnter: false,
          waitAfterMs: 800,
          extractTarget: 'text',
          ifSource: 'csv_or_var',
          ifLeftValue: firstMasterCol,
          verifyCondition: type === 'condition' ? 'equals' : 'contains',
          thenBranch: { mode: 'input', selector: '', value: '', targetStepNumber: '' },
          elseBranch: { mode: 'continue', selector: '', value: '', targetStepNumber: '' },
          onVerifyFail: 'skip_row',
          outputColumn: type === 'verify' ? 'Check_' + (proj.steps.length + 1) : 'Extracted_' + (proj.steps.length + 1)
        },
        stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
      });

      saveCurrentProject();
      renderAll();
    });
  });

  // ============================================================================
  // TAB 2: MASTER CSV EDITOR
  // ============================================================================

  function renderMasterCsvEditor(proj) {
    const pts = proj.pageTableSource || {
      enabled: false,
      sourceType: 'table',
      containerSelector: '',
      rowSelector: 'tbody tr',
      liveRefreshOnRun: true
    };
    const chkPageTableEnabled = document.getElementById('chk-page-table-enabled');
    const chkPageTableLiveRefresh = document.getElementById('chk-page-table-live-refresh');
    const inputPageTableContainer = document.getElementById('input-page-table-container');
    const inputPageTableRow = document.getElementById('input-page-table-row');

    if (chkPageTableEnabled) chkPageTableEnabled.checked = Boolean(pts.enabled);
    if (chkPageTableLiveRefresh) chkPageTableLiveRefresh.checked = pts.liveRefreshOnRun !== false;
    if (inputPageTableContainer) inputPageTableContainer.value = pts.containerSelector || '';
    if (inputPageTableRow) inputPageTableRow.value = pts.rowSelector || '';

    const masterCsv = proj.masterCsv || { enabled: true, fileName: '', headers: [], rows: [] };
    chkMasterCsvEnabled.checked = masterCsv.enabled !== false;
    masterCsvFilename.textContent = masterCsv.fileName ? `Source: ${masterCsv.fileName}` : '';

    rawMasterCsvTextarea.value = window.FlowTagCSV.objectsToCSV(masterCsv.rows || [], masterCsv.headers || []);

    if (!masterCsv.headers || masterCsv.headers.length === 0) {
      masterCsvTableContainer.innerHTML = `
        <div style="padding:28px;text-align:center;color:#94a3b8;font-size:13px;">
          No Master CSV columns or rows loaded yet. Upload a <b>.CSV file</b> above, click <b>"+ Add Column"</b>, or paste raw CSV text below.
        </div>
      `;
      return;
    }

    const headers = masterCsv.headers;
    const rows = masterCsv.rows || [];

    let html = `
      <table>
        <thead>
          <tr>
            <th style="width:50px;">#</th>
            ${headers
              .map(
                (h) => `
              <th>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                  <span class="mono">{{${escapeHtml(h)}}}</span>
                </div>
              </th>
            `
              )
              .join('')}
            <th style="width:60px;">Action</th>
          </tr>
        </thead>
        <tbody>
    `;

    rows.forEach((row, rIdx) => {
      html += `
        <tr>
          <td style="color:#64748b;font-weight:700;">${rIdx + 1}</td>
          ${headers
            .map(
              (h) => `
            <td>
              <input type="text" class="input" data-csv-row="${rIdx}" data-csv-col="${escapeHtml(h)}" value="${escapeHtml(row[h] ?? '')}" style="padding:4px 7px;font-size:12px;" />
            </td>
          `
            )
            .join('')}
          <td>
            <button class="btn btn-danger btn-sm" data-del-csv-row="${rIdx}" style="padding:3px 7px;">✕</button>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    masterCsvTableContainer.innerHTML = html;

    masterCsvTableContainer.querySelectorAll('[data-csv-row]').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        const rIdx = Number(e.target.getAttribute('data-csv-row'));
        const col = e.target.getAttribute('data-csv-col');
        if (proj.masterCsv.rows[rIdx]) {
          proj.masterCsv.rows[rIdx][col] = e.target.value;
          saveCurrentProject();
        }
      });
    });

    masterCsvTableContainer.querySelectorAll('[data-del-csv-row]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rIdx = Number(btn.getAttribute('data-del-csv-row'));
        proj.masterCsv.rows.splice(rIdx, 1);
        saveCurrentProject();
        renderAll();
      });
    });
  }

  document.getElementById('input-master-csv-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const proj = getCurrentProject();
    if (!file || !proj) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
      proj.masterCsv = {
        enabled: true,
        fileName: file.name,
        headers: parsed.headers,
        rows: parsed.rows
      };
      saveCurrentProject();
      renderAll();
    };
    reader.readAsText(file);
  });

  chkMasterCsvEnabled.addEventListener('change', (e) => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.masterCsv = proj.masterCsv || { headers: [], rows: [] };
    proj.masterCsv.enabled = e.target.checked;
    saveCurrentProject();
  });

  document.getElementById('btn-add-csv-row')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.masterCsv = proj.masterCsv || { enabled: true, fileName: 'custom.csv', headers: ['query'], rows: [] };
    if (!proj.masterCsv.headers || proj.masterCsv.headers.length === 0) {
      proj.masterCsv.headers = ['query'];
    }
    const emptyRow = {};
    proj.masterCsv.headers.forEach((h) => (emptyRow[h] = ''));
    proj.masterCsv.rows.push(emptyRow);
    saveCurrentProject();
    renderAll();
  });

  document.getElementById('btn-add-csv-col')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const colName = prompt('Enter new CSV column name (e.g. search_term, url, price):');
    if (!colName || !colName.trim()) return;
    const clean = colName.trim().replace(/\s+/g, '_');
    proj.masterCsv = proj.masterCsv || { enabled: true, fileName: 'custom.csv', headers: [], rows: [] };
    if (!proj.masterCsv.headers.includes(clean)) {
      proj.masterCsv.headers.push(clean);
      proj.masterCsv.rows.forEach((r) => (r[clean] = r[clean] || ''));
      saveCurrentProject();
      renderAll();
    }
  });

  document.getElementById('btn-clear-master-csv')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.masterCsv = { enabled: false, fileName: '', headers: [], rows: [] };
    saveCurrentProject();
    renderAll();
  });

  document.getElementById('btn-apply-raw-csv')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const parsed = window.FlowTagCSV.parseCSV(rawMasterCsvTextarea.value);
    proj.masterCsv = {
      enabled: true,
      fileName: proj.masterCsv?.fileName || 'manual_input.csv',
      headers: parsed.headers,
      rows: parsed.rows
    };
    saveCurrentProject();
    renderAll();
  });

  function ensureProjPageTableSource(proj) {
    proj.pageTableSource = proj.pageTableSource || {
      enabled: false,
      sourceType: 'table',
      containerSelector: '',
      rowSelector: 'tbody tr',
      liveRefreshOnRun: true,
      headers: [],
      sampleRowCount: 0
    };
    return proj.pageTableSource;
  }

  document.getElementById('chk-page-table-enabled')?.addEventListener('change', (e) => {
    const proj = getCurrentProject();
    if (!proj) return;
    const pts = ensureProjPageTableSource(proj);
    pts.enabled = e.target.checked;
    saveCurrentProject();
  });

  document.getElementById('chk-page-table-live-refresh')?.addEventListener('change', (e) => {
    const proj = getCurrentProject();
    if (!proj) return;
    const pts = ensureProjPageTableSource(proj);
    pts.liveRefreshOnRun = e.target.checked;
    saveCurrentProject();
  });

  document.getElementById('input-page-table-container')?.addEventListener('change', (e) => {
    const proj = getCurrentProject();
    if (!proj) return;
    const pts = ensureProjPageTableSource(proj);
    pts.containerSelector = e.target.value.trim();
    if (pts.containerSelector) pts.enabled = true;
    saveCurrentProject();
    renderAll();
  });

  document.getElementById('input-page-table-row')?.addEventListener('change', (e) => {
    const proj = getCurrentProject();
    if (!proj) return;
    const pts = ensureProjPageTableSource(proj);
    pts.rowSelector = e.target.value.trim();
    saveCurrentProject();
  });

  document.getElementById('btn-launch-pick-page-table')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const domain = projDomainInput.value.trim() || proj.startUrl || 'https://example.com';
    proj.startUrl = domain;
    chrome.runtime.sendMessage(
      {
        type: 'LAUNCH_TAG_BUILDER',
        projectId: proj.id,
        targetUrl: domain,
        addInitialGotoStep: proj.steps.length === 0,
        startInPickMode: true
      },
      (res) => {
        if (res && res.tabId) {
          setTimeout(() => {
            chrome.tabs.sendMessage(res.tabId, { type: 'START_TABLE_SOURCE_PICK' }, () => {
              void chrome.runtime.lastError;
            });
          }, 900);
        }
      }
    );
  });

  // ============================================================================
  // TAB 3: RUN MONITOR & EXTRACTED RESULTS
  // ============================================================================

  function getNormalizedRunResultsWithHeaders(results) {
    const normalizedResults = (results || []).map((r, idx) => {
      const copy = { ...(r || {}) };
      if (copy._Row === undefined) {
        copy._Row = idx + 1;
      }
      if (!copy._Status) {
        const errKeys = Object.keys(copy).filter((k) => k.startsWith('_Error_Step_') && copy[k]);
        if (errKeys.length > 0) {
          copy._Status = 'FAILED';
          copy._Status_Details = errKeys.map((k) => `${k.replace('_Error_', '')}: ${copy[k]}`).join(' | ');
        } else {
          copy._Status = 'SUCCESS';
          copy._Status_Details = copy._Status_Details || 'Completed';
        }
      } else if (!copy._Status_Details) {
        const errKeys = Object.keys(copy).filter((k) => k.startsWith('_Error_Step_') && copy[k]);
        if (errKeys.length > 0) {
          copy._Status_Details = errKeys.map((k) => `${k.replace('_Error_', '')}: ${copy[k]}`).join(' | ');
        } else {
          copy._Status_Details = String(copy._Status).toUpperCase() === 'SUCCESS' ? 'Completed' : String(copy._Status);
        }
      }
      return copy;
    });

    const priorityCols = ['_Row', '_Status', '_Status_Details'];
    const colSet = new Set(priorityCols);
    normalizedResults.forEach((r) => {
      Object.keys(r || {}).forEach((k) => {
        if (k !== '_Timestamp') colSet.add(k);
      });
    });
    if (normalizedResults.some((r) => r._Timestamp !== undefined)) {
      colSet.add('_Timestamp');
    }
    return {
      normalizedResults,
      cols: Array.from(colSet)
    };
  }

  function renderRunnerSection() {
    const proj = getCurrentProject();
    const isRunningOrPaused = runnerState && ['running', 'paused', 'stopping'].includes(runnerState.status);

    if (isRunningOrPaused) {
      liveRunnerBanner.style.display = 'flex';
      runnerBannerStatus.textContent = `● ${runnerState.status.toUpperCase()} — ${runnerState.projectName || ''}`;
      runnerBannerStep.textContent = runnerState.currentStepName || 'Executing step...';
      runnerBannerProgress.textContent = `Row ${runnerState.currentMasterRow || 1} / ${runnerState.totalMasterRows || 1} · Step ${runnerState.currentStepIndex || 1}/${runnerState.totalSteps || 1}`;
      btnBannerPause.textContent = runnerState.status === 'paused' ? '▶ Resume' : '⏸ Pause';
    } else {
      liveRunnerBanner.style.display = 'none';
    }

    // Logs
    const logs = (runnerState && runnerState.projectId === currentProjectId ? runnerState.logs : proj?.lastRunLogs) || [];
    if (logs.length === 0) {
      runLogConsole.innerHTML = `<div style="color:#64748b;">No execution logs yet. Click "▶ Run Workflow" to start.</div>`;
    } else {
      runLogConsole.innerHTML = logs
        .map(
          (l) => `
          <div class="log-line">
            <span class="log-time">[${escapeHtml(l.time)}]</span>
            <span class="log-${escapeHtml(l.level || 'info')}">${escapeHtml(l.text)}</span>
          </div>
        `
        )
        .join('');
      runLogConsole.scrollTop = runLogConsole.scrollHeight;
    }

    // Results Table
    const results = proj?.lastRunResults || [];
    badgeResultsCount.textContent = String(results.length);

    if (results.length === 0) {
      resultsTableContainer.innerHTML = `
        <div style="padding:28px;text-align:center;color:#94a3b8;font-size:13px;">
          No extracted results yet. Run the workflow to populate extracted data and execution records here.
        </div>
      `;
      return;
    }

    const { normalizedResults, cols } = getNormalizedRunResultsWithHeaders(results);

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    normalizedResults.forEach((r) => {
      const st = String(r._Status || '').toUpperCase();
      if (st === 'FAILED' || st === 'STOPPED') failedCount++;
      else if (st === 'SKIPPED') skippedCount++;
      else successCount++;
    });

    function renderResultCell(row, col) {
      const val = row[col] ?? '';
      if (col === '_Status') {
        const st = String(val).toUpperCase();
        if (st === 'FAILED' || st === 'STOPPED') {
          return `<td><span style="display:inline-flex;align-items:center;gap:4px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.5);color:#fca5a5;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">❌ ${escapeHtml(st)}</span></td>`;
        }
        if (st === 'SKIPPED') {
          return `<td><span style="display:inline-flex;align-items:center;gap:4px;background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.5);color:#fcd34d;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">⏭ SKIPPED</span></td>`;
        }
        return `<td><span style="display:inline-flex;align-items:center;gap:4px;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.5);color:#6ee7b7;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">✅ SUCCESS</span></td>`;
      }
      if (col === '_Status_Details' || col.startsWith('_Error_Step_')) {
        const isErr = String(row._Status || '').toUpperCase() === 'FAILED' || col.startsWith('_Error_Step_');
        return `<td style="${isErr && val ? 'color:#fca5a5;font-weight:600;' : 'color:#94a3b8;'}">${escapeHtml(val)}</td>`;
      }
      return `<td>${escapeHtml(val)}</td>`;
    }

    resultsTableContainer.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#0f172a;border-bottom:1px solid #1e293b;font-size:12px;flex-wrap:wrap;">
        <span style="font-weight:700;color:#cbd5e1;">Row Execution Summary:</span>
        <span style="background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:#6ee7b7;padding:2px 9px;border-radius:6px;font-weight:700;">✅ Passed: ${successCount}</span>
        <span style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#fca5a5;padding:2px 9px;border-radius:6px;font-weight:700;">❌ Failed: ${failedCount}</span>
        <span style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#fcd34d;padding:2px 9px;border-radius:6px;font-weight:700;">⏭ Skipped: ${skippedCount}</span>
      </div>
      <table>
        <thead>
          <tr>
            ${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${normalizedResults
            .map((r) => {
              const st = String(r._Status || '').toUpperCase();
              const rowBg =
                st === 'FAILED' || st === 'STOPPED'
                  ? 'background:rgba(239,68,68,0.07);'
                  : st === 'SKIPPED'
                  ? 'background:rgba(245,158,11,0.05);'
                  : '';
              return `
            <tr style="${rowBg}">
              ${cols.map((c) => renderResultCell(r, c)).join('')}
            </tr>
          `;
            })
            .join('')}
        </tbody>
      </table>
    `;
  }

  // Export Results CSV
  document.getElementById('btn-export-results-csv')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj || !proj.lastRunResults || proj.lastRunResults.length === 0) {
      alert('No extracted results to export yet. Run your workflow first!');
      return;
    }
    const { normalizedResults, cols } = getNormalizedRunResultsWithHeaders(proj.lastRunResults);
    const csvContent = window.FlowTagCSV.objectsToCSV(normalizedResults, cols);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const safeName = (proj.name || 'project').replace(/[^a-z0-9_-]+/gi, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}_results_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btn-clear-results')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.lastRunResults = [];
    proj.lastRunLogs = [];
    saveCurrentProject();
    renderAll();
  });

  // ============================================================================
  // TOPBAR & MODAL ACTIONS
  // ============================================================================

  projNameInput.addEventListener('change', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.name = projNameInput.value.trim() || 'Untitled Project';
    saveCurrentProject();
    renderSidebar();
  });

  projDescInput.addEventListener('change', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.description = projDescInput.value;
    saveCurrentProject();
  });

  projDomainInput.addEventListener('change', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    proj.startUrl = projDomainInput.value.trim();
    saveCurrentProject();
  });

  btnLaunchTagBuilder.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const domain = projDomainInput.value.trim() || proj.startUrl || 'https://example.com';
    proj.startUrl = domain;
    chrome.runtime.sendMessage({
      type: 'LAUNCH_TAG_BUILDER',
      projectId: proj.id,
      targetUrl: domain,
      addInitialGotoStep: proj.steps.length === 0,
      startInPickMode: true
    });
  });

  let modalRuntimeCsv = null;
  let tabRuntimeCsv = null;

  const runWorkflowModal = document.getElementById('run-workflow-modal');
  const runModalExpectedCols = document.getElementById('run-modal-expected-cols');
  const runModalCsvFile = document.getElementById('run-modal-csv-file');
  const runModalCsvStatus = document.getElementById('run-modal-csv-status');
  const runModalSaveDefault = document.getElementById('run-modal-save-default');
  const runModalStartRow = document.getElementById('run-modal-start-row');
  const runModalMaxRows = document.getElementById('run-modal-max-rows');
  const runModalRefSummary = document.getElementById('run-modal-ref-summary');

  function getExpectedProjectCsvHeaders(proj) {
    const colSet = new Set();
    if (proj.masterCsv && Array.isArray(proj.masterCsv.headers)) {
      proj.masterCsv.headers.forEach((h) => colSet.add(h));
    }
    for (const st of proj.steps || []) {
      if (st.stepCsv && Array.isArray(st.stepCsv.headers)) {
        st.stepCsv.headers.forEach((h) => colSet.add(h));
      }
      // Also detect {{token}} references in step value or selector
      const combined = `${st.value || ''} ${st.selector || ''}`;
      const matches = combined.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g);
      for (const m of matches) {
        const key = m[1].trim();
        if (key === 'row_index' || key === 'step_row_index' || key.startsWith('prev.') || key.startsWith('var.')) continue;
        if (key.startsWith('step.')) colSet.add(key.slice(5));
        else if (key.startsWith('master.')) colSet.add(key.slice(7));
        else colSet.add(key);
      }
    }
    return Array.from(colSet);
  }

  function projectUsesPageTableInDash(proj) {
    if (!proj) return false;
    if (proj.pageTableSource && proj.pageTableSource.enabled && proj.pageTableSource.containerSelector) {
      return true;
    }
    if (proj.masterCsv && proj.masterCsv.isPageTableSnapshot) {
      return true;
    }
    for (const st of proj.steps || []) {
      if (st.stepCsv && st.stepCsv.enabled && st.stepCsv.sourceType === 'page_table') {
        return true;
      }
    }
    return false;
  }

  btnRunWorkflow.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;

    // If this project uses a Page Table / HTML List data source on the webpage, do NOT ask for a CSV file—run directly!
    if (projectUsesPageTableInDash(proj)) {
      switchTab('results');
      chrome.runtime.sendMessage({
        type: 'START_WORKFLOW_RUN',
        projectId: proj.id,
        reuseBuilderTab: Boolean(builderSession && builderSession.active && builderSession.projectId === proj.id),
        startRow: 1,
        maxRows: 0,
        runtimeCsv: null
      });
      return;
    }

    modalRuntimeCsv = null;
    if (runModalCsvFile) runModalCsvFile.value = '';
    if (runModalCsvStatus) runModalCsvStatus.textContent = '';
    if (runModalSaveDefault) runModalSaveDefault.checked = false;
    if (runModalStartRow) runModalStartRow.value = '1';
    if (runModalMaxRows) runModalMaxRows.value = '0';

    const expectedCols = getExpectedProjectCsvHeaders(proj);
    if (runModalExpectedCols) {
      if (expectedCols.length === 0) {
        runModalExpectedCols.innerHTML = `<span style="font-size:12px;color:#64748b;">No CSV variables mapped yet (workflow will run once unless you upload a CSV).</span>`;
      } else {
        runModalExpectedCols.innerHTML = expectedCols
          .map((c) => `<span class="token-pill" style="cursor:default;">{{${escapeHtml(c)}}}</span>`)
          .join('');
      }
    }

    const refRows = getEffectiveRowCount(proj);
    if (runModalRefSummary) {
      runModalRefSummary.textContent =
        refRows > 0 ? `Reference CSV has ${refRows} row(s)` : 'No Reference CSV rows saved';
    }

    if (runWorkflowModal) {
      runWorkflowModal.style.display = 'flex';
    }
  });

  document.getElementById('run-modal-btn-cancel')?.addEventListener('click', () => {
    if (runWorkflowModal) runWorkflowModal.style.display = 'none';
  });

  document.getElementById('btn-download-csv-template')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const cols = getExpectedProjectCsvHeaders(proj);
    const csvStr = window.FlowTagCSV.objectsToCSV([], cols.length > 0 ? cols : ['column_1']);
    const blob = new Blob([csvStr + '\r\n'], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(proj.name || 'workflow').replace(/[^a-z0-9_-]+/gi, '_')}_template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  runModalCsvFile?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const proj = getCurrentProject();
    if (!file || !proj) {
      modalRuntimeCsv = null;
      if (runModalCsvStatus) runModalCsvStatus.textContent = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
      modalRuntimeCsv = {
        fileName: file.name,
        headers: parsed.headers,
        rows: parsed.rows,
        saveAsDefault: Boolean(runModalSaveDefault?.checked)
      };

      const expected = getExpectedProjectCsvHeaders(proj);
      const missing = expected.filter((col) => !parsed.headers.includes(col));
      if (runModalCsvStatus) {
        if (missing.length > 0 && expected.length > 0) {
          runModalCsvStatus.style.color = '#fbbf24';
          runModalCsvStatus.textContent = `✓ Loaded "${file.name}" (${parsed.rows.length} rows) — Note: Missing column(s): ${missing.join(', ')}`;
        } else {
          runModalCsvStatus.style.color = '#34d399';
          runModalCsvStatus.textContent = `✓ Loaded "${file.name}" (${parsed.rows.length} rows · All mapped columns matched!)`;
        }
      }
    };
    reader.readAsText(file);
  });

  runModalSaveDefault?.addEventListener('change', (e) => {
    if (modalRuntimeCsv) {
      modalRuntimeCsv.saveAsDefault = e.target.checked;
    }
  });

  document.getElementById('run-modal-btn-use-ref')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const startRow = Number(runModalStartRow?.value) || 1;
    const maxRows = Number(runModalMaxRows?.value) || 0;
    if (runWorkflowModal) runWorkflowModal.style.display = 'none';
    switchTab('results');
    chrome.runtime.sendMessage({
      type: 'START_WORKFLOW_RUN',
      projectId: proj.id,
      startRow,
      maxRows,
      runtimeCsv: null
    });
  });

  document.getElementById('run-modal-btn-start')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const startRow = Number(runModalStartRow?.value) || 1;
    const maxRows = Number(runModalMaxRows?.value) || 0;
    if (runWorkflowModal) runWorkflowModal.style.display = 'none';
    switchTab('results');
    chrome.runtime.sendMessage({
      type: 'START_WORKFLOW_RUN',
      projectId: proj.id,
      startRow,
      maxRows,
      runtimeCsv: modalRuntimeCsv
    });
  });

  document.getElementById('tab-runtime-csv-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const badge = document.getElementById('tab-runtime-csv-badge');
    if (!file) {
      tabRuntimeCsv = null;
      if (badge) badge.textContent = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
      tabRuntimeCsv = {
        fileName: file.name,
        headers: parsed.headers,
        rows: parsed.rows,
        saveAsDefault: false
      };
      if (badge) {
        badge.textContent = `✓ Runtime CSV: ${file.name} (${parsed.rows.length} rows)`;
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-run-custom')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const startRow = Number(document.getElementById('run-start-row')?.value) || 1;
    const maxRows = Number(document.getElementById('run-max-rows')?.value) || 0;
    chrome.runtime.sendMessage({
      type: 'START_WORKFLOW_RUN',
      projectId: proj.id,
      startRow,
      maxRows,
      runtimeCsv: tabRuntimeCsv
    });
  });

  btnBannerPause.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PAUSE_RESUME_RUN' });
  });

  btnBannerStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_WORKFLOW_RUN' });
  });

  btnDeleteProject.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    if (!confirm(`Delete project "${proj.name}"?`)) return;
    projects = projects.filter((p) => p.id !== proj.id);
    currentProjectId = projects[0] ? projects[0].id : null;
    chrome.runtime.sendMessage({ type: 'SAVE_PROJECTS', projects });
    renderAll();
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-pane').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
  }

  // New Project Modal
  document.getElementById('btn-create-project')?.addEventListener('click', openNewProjectModal);

  function openNewProjectModal() {
    modalProjName.value = '';
    modalProjUrl.value = 'https://';
    newProjectModal.style.display = 'flex';
    modalProjName.focus();
  }

  document.getElementById('modal-btn-cancel')?.addEventListener('click', () => {
    newProjectModal.style.display = 'none';
  });

  document.getElementById('modal-btn-create-only')?.addEventListener('click', () => {
    createNewProjectFromModal(false);
  });

  document.getElementById('modal-btn-create-and-launch')?.addEventListener('click', () => {
    createNewProjectFromModal(true);
  });

  function createNewProjectFromModal(launchBuilderImmediately) {
    const name = modalProjName.value.trim() || 'New Automation Project';
    let url = modalProjUrl.value.trim() || 'https://example.com';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    let hostname = 'Domain';
    try {
      hostname = new URL(url).hostname;
    } catch (_) {}

    const newProj = {
      id: 'proj_' + Date.now(),
      name,
      description: '',
      startUrl: url,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      masterCsv: { enabled: false, fileName: '', headers: [], rows: [] },
      steps: [
        {
          id: 'step_' + Date.now(),
          name: `Go to ${hostname}`,
          type: 'navigate',
          selector: '',
          value: url,
          options: { waitAfterMs: 1000 },
          stepCsv: { enabled: false, mode: 'loop_step', fileName: '', headers: [], rows: [], columnName: '' }
        }
      ],
      lastRunResults: [],
      lastRunLogs: []
    };

    projects.unshift(newProj);
    currentProjectId = newProj.id;
    newProjectModal.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'SAVE_PROJECTS', projects }, () => {
      renderAll();
      if (launchBuilderImmediately) {
        chrome.runtime.sendMessage({
          type: 'LAUNCH_TAG_BUILDER',
          projectId: newProj.id,
          targetUrl: url,
          startInPickMode: true
        });
      }
    });
  }

  // Export & Import JSON Backup
  document.getElementById('btn-export-json')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(projects, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `domuto_projects_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('input-import-json')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result || '[]'));
        if (Array.isArray(imported)) {
          projects = imported;
          currentProjectId = projects[0]?.id || null;
        } else if (imported && imported.project && Array.isArray(imported.project.steps)) {
          // Support importing single-project AI JSON file from the sidebar button too!
          const normalized = parseAndNormalizeAiProjectJson(String(reader.result || ''), null);
          normalized.id = 'proj_' + Date.now();
          projects.unshift(normalized);
          currentProjectId = normalized.id;
        } else if (imported && imported.id) {
          projects.unshift(imported);
          currentProjectId = imported.id;
        }
        chrome.runtime.sendMessage({ type: 'SAVE_PROJECTS', projects });
        renderAll();
      } catch (err) {
        alert('Invalid JSON file: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  // ============================================================================
  // PER-PROJECT AI EXPORT & IMPORT MODAL
  // ============================================================================
  const aiProjectModal = document.getElementById('ai-project-modal');
  const chkAiIncludeAllCsv = document.getElementById('chk-ai-include-all-csv');
  const textareaAiProjectJson = document.getElementById('textarea-ai-project-json');
  const aiModalStatus = document.getElementById('ai-modal-status');

  function buildAiExportPayload(proj, includeAllCsvRows = false) {
    const csvRows = proj.masterCsv?.rows || [];
    const shouldTruncateRows = !includeAllCsvRows && csvRows.length > 5;
    return {
      _domuto_ai_guide: {
        purpose:
          'This is a Domuto Visual Browser Automation project file designed to be read, edited, or generated by any AI assistant (ChatGPT, Claude, Gemini) and imported directly back into Domuto.',
        how_to_edit:
          'Modify the "project" object below (especially "project.steps") and return valid JSON. When imported back into Domuto, if "project.masterCsv.rows" is omitted or kept as sample rows, Domuto automatically preserves all existing CSV rows in the project.',
        dynamic_tokens_reference: {
          csv_column: '{{ColumnName}} — injects value from the current CSV row',
          previous_step_output: '{{prev.step_1}} — injects value typed/extracted in Step #1',
          named_variable: '{{var.OutputCol}} — injects value saved by an extract/verify step',
          row_number: '{{row_number}} — 1-based CSV row index'
        },
        step_schema_reference: {
          valid_step_types: [
            'navigate (value = target URL)',
            'input (selector = CSS selector, value = text or {{CSV_Col}}, options.clearFirst = true, options.pressEnter = bool)',
            'click (selector = CSS selector)',
            'select (selector = <select> CSS selector, value = option value or visible text)',
            'extract (selector = CSS selector, options.extractTarget = "text"|"value"|"href"|"html"|"attr", options.outputColumn = column name)',
            'verify (selector = CSS selector, options.verifyCondition = "equals"|"contains"|"not_equals"|"not_contains"|"starts_with"|"greater_than"|"less_than"|"is_empty"|"is_not_empty", value = expected value, options.onVerifyFail = "skip_row"|"continue"|"stop_workflow")',
            'condition (IF/THEN/ELSE step: options.ifSource = "csv_or_var"|"dom_element", options.ifLeftValue = "{{CSV_Col}}", options.verifyCondition = operator, value = expected value, options.thenBranch = { mode, selector, value, targetStepNumber }, options.elseBranch = { mode, selector, value, targetStepNumber })',
            'wait (value = seconds to wait, or options.waitMode = "element" with selector)',
            'keypress (selector = CSS selector, value = key name like "Enter", "Tab", "Escape")',
            'scroll (value = pixels e.g. "500" or "bottom")'
          ],
          condition_branch_modes: [
            'continue (proceed to next step)',
            'input (type "value" into "selector")',
            'click (click "selector")',
            'select (choose dropdown option "value" in "selector")',
            'extract (scrape "selector" into "outputColumn")',
            'navigate (go to URL in "value")',
            'skip_next (skip the immediate next step)',
            'jump_to_step (jump to 1-based step number in "targetStepNumber")',
            'skip_row (finish current CSV row and move to next CSV row)',
            'stop_workflow (halt entire run)'
          ],
          row_scoping_and_wildcards:
            'For multi-row HTML tables where each row has dynamic IDs like input[name="order(12345).box(1)"], use CSS attribute wildcards like input[name^="order("][name$=").box(1)"] and set step.options.rowAnchorText = "{{Order_ID}}" so Domuto scopes the selector to the exact <tr> containing that CSV row value.'
        }
      },
      project: {
        id: proj.id,
        name: proj.name,
        description: proj.description || '',
        startUrl: proj.startUrl || '',
        pausedStepsNote: 'Set step.paused = true on any step to temporarily skip it during test runs.',
        pageTableSource: proj.pageTableSource || {
          enabled: false,
          sourceType: 'table',
          containerSelector: '',
          rowSelector: 'tbody tr',
          liveRefreshOnRun: true
        },
        masterCsv: {
          enabled: Boolean(proj.masterCsv?.enabled),
          fileName: proj.masterCsv?.fileName || '',
          headers: proj.masterCsv?.headers || [],
          totalRowCount: csvRows.length,
          rowsTruncatedForAiContext: shouldTruncateRows,
          rows: shouldTruncateRows ? csvRows.slice(0, 5) : csvRows
        },
        steps: (proj.steps || []).map((s, idx) => ({
          _stepNumber: idx + 1,
          id: s.id || `step_${idx + 1}`,
          name: s.name || `Step ${idx + 1}`,
          type: s.type || 'click',
          paused: Boolean(s.paused),
          selector: s.selector || '',
          value: s.value || '',
          options: s.options || {},
          stepCsv: s.stepCsv?.enabled
            ? s.stepCsv
            : { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
        }))
      }
    };
  }

  function parseAndNormalizeAiProjectJson(rawText, existingProj) {
    if (!rawText || !rawText.trim()) {
      throw new Error('Please paste or upload a JSON project payload first.');
    }
    // Strip markdown ```json ... ``` fences if pasted directly from an AI chat response
    let cleaned = rawText.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
      cleaned = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(cleaned);
    const srcProj = parsed && parsed.project && typeof parsed.project === 'object' ? parsed.project : parsed;

    // Also allow pasting a raw array of steps directly
    const rawSteps = Array.isArray(srcProj) ? srcProj : Array.isArray(srcProj?.steps) ? srcProj.steps : null;
    if (!rawSteps) {
      throw new Error('Could not find a "steps" array in the JSON. Make sure "project.steps" (or top-level "steps") is an array.');
    }

    const normalizedSteps = rawSteps.map((s, idx) => {
      const copy = { ...(s || {}) };
      delete copy._stepNumber;
      return {
        id: copy.id || `step_${Date.now()}_${idx + 1}`,
        name: copy.name || `Step ${idx + 1} (${copy.type || 'click'})`,
        type: copy.type || 'click',
        paused: Boolean(copy.paused),
        selector: copy.selector ?? '',
        value: copy.value ?? '',
        options: { waitAfterMs: 600, ...(copy.options || {}) },
        stepCsv: copy.stepCsv || {
          enabled: false,
          mode: 'sequence_row',
          fileName: '',
          headers: [],
          rows: [],
          columnName: ''
        }
      };
    });

    // Preserve existing CSV rows if the AI export had rowsTruncatedForAiContext: true or omitted rows
    let mergedMasterCsv = existingProj?.masterCsv
      ? JSON.parse(JSON.stringify(existingProj.masterCsv))
      : { enabled: false, fileName: '', headers: [], rows: [] };

    if (srcProj && srcProj.masterCsv && typeof srcProj.masterCsv === 'object') {
      const incomingCsv = srcProj.masterCsv;
      const keepExistingRows =
        incomingCsv.rowsTruncatedForAiContext &&
        existingProj?.masterCsv?.rows &&
        existingProj.masterCsv.rows.length > (incomingCsv.rows?.length || 0);

      mergedMasterCsv = {
        enabled: incomingCsv.enabled !== undefined ? Boolean(incomingCsv.enabled) : mergedMasterCsv.enabled,
        fileName: incomingCsv.fileName ?? mergedMasterCsv.fileName,
        headers: Array.isArray(incomingCsv.headers) ? incomingCsv.headers : mergedMasterCsv.headers,
        rows: keepExistingRows
          ? existingProj.masterCsv.rows
          : Array.isArray(incomingCsv.rows)
          ? incomingCsv.rows
          : mergedMasterCsv.rows
      };
    }

    return {
      id: existingProj?.id || srcProj.id || 'proj_' + Date.now(),
      name: srcProj.name || existingProj?.name || 'AI Imported Project',
      description: srcProj.description ?? existingProj?.description ?? '',
      startUrl: srcProj.startUrl || existingProj?.startUrl || 'https://example.com',
      createdAt: existingProj?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageTableSource: srcProj.pageTableSource || existingProj?.pageTableSource || {
        enabled: false,
        sourceType: 'table',
        containerSelector: '',
        rowSelector: 'tbody tr',
        liveRefreshOnRun: true
      },
      masterCsv: mergedMasterCsv,
      steps: normalizedSteps,
      lastRunResults: existingProj?.lastRunResults || [],
      lastRunLogs: existingProj?.lastRunLogs || []
    };
  }

  function refreshAiModalTextarea() {
    const proj = getCurrentProject();
    if (!proj || !textareaAiProjectJson) return;
    const payload = buildAiExportPayload(proj, Boolean(chkAiIncludeAllCsv?.checked));
    textareaAiProjectJson.value = JSON.stringify(payload, null, 2);
    if (aiModalStatus) {
      aiModalStatus.style.color = '#94a3b8';
      aiModalStatus.textContent = `Ready — ${proj.steps?.length || 0} step(s) & ${proj.masterCsv?.headers?.length || 0} CSV column(s) formatted for AI.`;
    }
  }

  document.getElementById('btn-open-ai-modal')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    refreshAiModalTextarea();
    if (aiProjectModal) aiProjectModal.style.display = 'flex';
  });

  chkAiIncludeAllCsv?.addEventListener('change', refreshAiModalTextarea);

  document.getElementById('ai-modal-btn-close')?.addEventListener('click', () => {
    if (aiProjectModal) aiProjectModal.style.display = 'none';
  });

  document.getElementById('ai-modal-btn-cancel')?.addEventListener('click', () => {
    if (aiProjectModal) aiProjectModal.style.display = 'none';
  });

  document.getElementById('btn-ai-copy-json')?.addEventListener('click', async () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const payload = buildAiExportPayload(proj, Boolean(chkAiIncludeAllCsv?.checked));
    const promptWrapper =
      `Below is my Domuto browser automation project in JSON format (including the _domuto_ai_guide schema reference).\n` +
      `Please help me review or edit the workflow steps and return the updated JSON so I can import it back into Domuto:\n\n` +
      JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(promptWrapper);
      if (aiModalStatus) {
        aiModalStatus.style.color = '#34d399';
        aiModalStatus.textContent = '✓ Copied AI Prompt + Project JSON to clipboard! Paste it into ChatGPT, Claude, or Gemini.';
      }
    } catch (err) {
      textareaAiProjectJson.select();
      document.execCommand('copy');
      if (aiModalStatus) {
        aiModalStatus.style.color = '#34d399';
        aiModalStatus.textContent = '✓ Copied Project JSON to clipboard!';
      }
    }
  });

  document.getElementById('btn-ai-download-json')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    const payload = buildAiExportPayload(proj, Boolean(chkAiIncludeAllCsv?.checked));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeName = (proj.name || 'project').replace(/[^a-z0-9_-]+/gi, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.domuto.json`;
    a.click();
    URL.revokeObjectURL(url);
    if (aiModalStatus) {
      aiModalStatus.style.color = '#34d399';
      aiModalStatus.textContent = `✓ Downloaded "${safeName}.domuto.json" — ready to upload to any AI tool!`;
    }
  });

  document.getElementById('input-ai-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (textareaAiProjectJson) {
        textareaAiProjectJson.value = String(reader.result || '');
      }
      if (aiModalStatus) {
        aiModalStatus.style.color = '#34d399';
        aiModalStatus.textContent = `✓ Loaded "${file.name}" into editor below. Click "✨ Apply Changes to Current Project" to finish importing!`;
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('btn-ai-apply-current')?.addEventListener('click', () => {
    const proj = getCurrentProject();
    if (!proj) return;
    try {
      const updated = parseAndNormalizeAiProjectJson(textareaAiProjectJson?.value || '', proj);
      const idx = projects.findIndex((p) => p.id === proj.id);
      if (idx >= 0) {
        projects[idx] = updated;
      }
      chrome.runtime.sendMessage({ type: 'SAVE_PROJECTS', projects }, () => {
        renderAll();
        if (aiProjectModal) aiProjectModal.style.display = 'none';
      });
    } catch (err) {
      if (aiModalStatus) {
        aiModalStatus.style.color = '#f87171';
        aiModalStatus.textContent = `✗ Import Error: ${err.message}`;
      }
    }
  });

  document.getElementById('btn-ai-import-as-new')?.addEventListener('click', () => {
    try {
      const created = parseAndNormalizeAiProjectJson(textareaAiProjectJson?.value || '', null);
      created.id = 'proj_' + Date.now();
      projects.unshift(created);
      currentProjectId = created.id;
      chrome.runtime.sendMessage({ type: 'SAVE_PROJECTS', projects }, () => {
        renderAll();
        if (aiProjectModal) aiProjectModal.style.display = 'none';
      });
    } catch (err) {
      if (aiModalStatus) {
        aiModalStatus.style.color = '#f87171';
        aiModalStatus.textContent = `✗ Import Error: ${err.message}`;
      }
    }
  });

  function convertHardcodedSelectorToWildcard(selector) {
    if (!selector) return selector;
    // Check if attribute selector like input[name="order(3803967494)..."]
    const attrMatch = selector.match(/^([a-zA-Z0-9_-]*)\[(name|id)=["'](.+)["']\]$/);
    if (attrMatch) {
      const tag = attrMatch[1] || 'input';
      const attrName = attrMatch[2];
      const rawVal = attrMatch[3].replace(/\\([().[\]:])/g, '$1');
      const fineParts = rawVal
        .split(/\d{4,}|(?<=\(|\[)\d+(?=\)|\])|[0-9a-f]{8,}/i)
        .filter((s) => s.length > 0);
      if (fineParts.length >= 2) {
        const prefix = fineParts[0];
        const suffix = fineParts[fineParts.length - 1];
        const middles = fineParts.slice(1, -1).filter((m) => m.length >= 2);
        let wildcardSel = `${tag}[${attrName}^="${prefix}"]`;
        for (const mid of middles.slice(0, 2)) {
          wildcardSel += `[${attrName}*="${mid}"]`;
        }
        if (suffix && suffix !== prefix) {
          wildcardSel += `[${attrName}$="${suffix}"]`;
        }
        return wildcardSel;
      }
    }
    // Check if #id selector with escaped parens and long numbers
    if (selector.startsWith('#') && /\d{4,}/.test(selector)) {
      const rawId = selector.slice(1).replace(/\\(.)/g, '$1');
      const fineParts = rawId
        .split(/\d{4,}|(?<=\(|\[)\d+(?=\)|\])|[0-9a-f]{8,}/i)
        .filter((s) => s.length > 0);
      if (fineParts.length >= 2) {
        const prefix = fineParts[0];
        const suffix = fineParts[fineParts.length - 1];
        const middles = fineParts.slice(1, -1).filter((m) => m.length >= 2);
        let wildcardSel = `[id^="${prefix}"]`;
        for (const mid of middles.slice(0, 2)) {
          wildcardSel += `[id*="${mid}"]`;
        }
        if (suffix && suffix !== prefix) {
          wildcardSel += `[id$="${suffix}"]`;
        }
        return wildcardSel;
      }
    }
    return selector;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
