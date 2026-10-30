/**
 * Domuto | Visual Browser Automation - Background Service Worker (Manifest V3)
 * Orchestrates interactive Tag-Assistant Builder sessions, multi-page Workflow Execution,
 * Master & Step CSV looping, IF/THEN/ELSE branching, and state synchronization.
 * Authored by Subrata Dey
 */
importScripts('csv_utils.js');

const STORAGE_KEYS = {
  PROJECTS: 'flowtag_projects',
  BUILDER_SESSION: 'flowtag_builder_session',
  RUNNER_STATE: 'flowtag_runner_state'
};

let runnerControl = {
  isRunning: false,
  isPaused: false,
  shouldStop: false,
  activeTabId: null,
  pageLoadResolvers: new Map() // tabId -> resolve fn
};

// Seed a sample project on first install so the user can explore or create their own immediately
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get([STORAGE_KEYS.PROJECTS]);
  if (!data[STORAGE_KEYS.PROJECTS] || data[STORAGE_KEYS.PROJECTS].length === 0) {
    const sampleProject = createDefaultDemoProject();
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROJECTS]: [sampleProject],
      [STORAGE_KEYS.BUILDER_SESSION]: { active: false, projectId: null, tabId: null, pickMode: false }
    });
  }
});

function createDefaultDemoProject() {
  const now = new Date().toISOString();
  return {
    id: 'proj_demo_' + Date.now(),
    name: 'Demo: Search & Scrape Wikipedia',
    description: 'Example workflow showing Master CSV search queries, clicking search, and extracting article headings.',
    startUrl: 'https://en.wikipedia.org',
    createdAt: now,
    updatedAt: now,
    masterCsv: {
      enabled: true,
      fileName: 'search_topics.csv',
      headers: ['topic', 'notes'],
      rows: [
        { topic: 'Browser extension', notes: 'Tech category' },
        { topic: 'Web scraping', notes: 'Automation category' }
      ]
    },
    steps: [
      {
        id: 'step_1',
        name: 'Open Wikipedia Home',
        type: 'navigate',
        selector: '',
        value: 'https://en.wikipedia.org',
        options: { waitAfterMs: 800 },
        stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
      },
      {
        id: 'step_2',
        name: 'Type Search Topic from Master CSV',
        type: 'input',
        selector: 'input[name="search"]',
        value: '{{topic}}',
        options: { clearFirst: true, pressEnter: true, waitAfterMs: 1500 },
        stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
      },
      {
        id: 'step_3',
        name: 'Extract Article Title',
        type: 'extract',
        selector: '#firstHeading, h1',
        value: '',
        options: { extractTarget: 'text', customAttr: '', outputColumn: 'Article_Title', waitAfterMs: 500 },
        stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
      }
    ],
    lastRunResults: [],
    lastRunLogs: []
  };
}

// Listen for tab navigation completions to support:
// 1. Re-attaching Tag Builder HUD across page loads
// 2. Resolving page navigation promises during workflow execution
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    // Resolve any pending navigation wait in runner
    if (runnerControl.pageLoadResolvers.has(tabId)) {
      const resolve = runnerControl.pageLoadResolvers.get(tabId);
      runnerControl.pageLoadResolvers.delete(tabId);
      resolve(tab);
    }

    // Check if this tab has an active Builder Session
    const sessionData = await chrome.storage.local.get([STORAGE_KEYS.BUILDER_SESSION, STORAGE_KEYS.PROJECTS]);
    const session = sessionData[STORAGE_KEYS.BUILDER_SESSION];
    if (session && session.active && session.tabId === tabId) {
      const projects = sessionData[STORAGE_KEYS.PROJECTS] || [];
      const project = projects.find((p) => p.id === session.projectId);
      if (project) {
        setTimeout(() => {
          sendMessageToTabSafe(tabId, {
            type: 'BUILDER_SYNC_STATE',
            session,
            project
          });
        }, 300);
      }
    }

    // Check if this tab is running an automation workflow
    if (runnerControl.isRunning && runnerControl.activeTabId === tabId) {
      const runData = await chrome.storage.local.get([STORAGE_KEYS.RUNNER_STATE]);
      if (runData[STORAGE_KEYS.RUNNER_STATE]) {
        setTimeout(() => {
          sendMessageToTabSafe(tabId, {
            type: 'RUNNER_SYNC_STATE',
            state: runData[STORAGE_KEYS.RUNNER_STATE]
          });
        }, 250);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessionData = await chrome.storage.local.get([STORAGE_KEYS.BUILDER_SESSION]);
  const session = sessionData[STORAGE_KEYS.BUILDER_SESSION];
  if (session && session.active && session.tabId === tabId) {
    session.active = false;
    session.tabId = null;
    session.pickMode = false;
    await chrome.storage.local.set({ [STORAGE_KEYS.BUILDER_SESSION]: session });
    broadcastToExtension({ type: 'BUILDER_SESSION_CHANGED', session });
  }

  if (runnerControl.isRunning && runnerControl.activeTabId === tabId) {
    runnerControl.shouldStop = true;
  }
});

// Central Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((res) => sendResponse(res))
    .catch((err) => {
      console.error('[FlowTag Background Error]', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'GET_ALL_DATA': {
      const data = await chrome.storage.local.get([
        STORAGE_KEYS.PROJECTS,
        STORAGE_KEYS.BUILDER_SESSION,
        STORAGE_KEYS.RUNNER_STATE
      ]);
      return {
        ok: true,
        projects: data[STORAGE_KEYS.PROJECTS] || [],
        builderSession: data[STORAGE_KEYS.BUILDER_SESSION] || { active: false },
        runnerState: data[STORAGE_KEYS.RUNNER_STATE] || null,
        senderTabId: sender.tab ? sender.tab.id : null
      };
    }

    case 'SAVE_PROJECTS': {
      const projects = message.projects || [];
      await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
      await syncActiveBuilderTab(projects);
      broadcastToExtension({ type: 'PROJECTS_UPDATED', projects });
      return { ok: true };
    }

    case 'SAVE_SINGLE_PROJECT': {
      const updatedProject = message.project;
      const data = await chrome.storage.local.get([STORAGE_KEYS.PROJECTS]);
      const projects = data[STORAGE_KEYS.PROJECTS] || [];
      const idx = projects.findIndex((p) => p.id === updatedProject.id);
      updatedProject.updatedAt = new Date().toISOString();
      if (idx >= 0) {
        projects[idx] = updatedProject;
      } else {
        projects.push(updatedProject);
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
      await syncActiveBuilderTab(projects);
      broadcastToExtension({ type: 'PROJECTS_UPDATED', projects, updatedProject });
      return { ok: true, project: updatedProject };
    }

    case 'LAUNCH_TAG_BUILDER': {
      // Opens or attaches to target URL and activates the Tag-Assistant floating HUD
      const { projectId, targetUrl, addInitialGotoStep } = message;
      const data = await chrome.storage.local.get([STORAGE_KEYS.PROJECTS]);
      const projects = data[STORAGE_KEYS.PROJECTS] || [];
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error('Project not found');

      let urlToOpen = (targetUrl || project.startUrl || '').trim();
      if (!urlToOpen) {
        throw new Error('Please provide a valid target website URL (e.g., https://example.com)');
      }
      if (!/^https?:\/\//i.test(urlToOpen)) {
        urlToOpen = 'https://' + urlToOpen;
      }

      project.startUrl = urlToOpen;

      // Optionally add initial "Go to Domain" step if project has no steps yet or requested
      if (addInitialGotoStep || project.steps.length === 0) {
        const hasGoto = project.steps.some((s) => s.type === 'navigate');
        if (!hasGoto) {
          project.steps.unshift({
            id: 'step_' + Date.now(),
            name: 'Go to ' + new URL(urlToOpen).hostname,
            type: 'navigate',
            selector: '',
            value: urlToOpen,
            options: { waitAfterMs: 1000 },
            stepCsv: { enabled: false, mode: 'sequence_row', fileName: '', headers: [], rows: [], columnName: '' }
          });
        }
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });

      // Create or focus tab
      let tab;
      if (message.useCurrentTab && message.tabId) {
        tab = await chrome.tabs.get(message.tabId);
      } else {
        tab = await chrome.tabs.create({ url: urlToOpen, active: true });
      }

      const session = {
        active: true,
        projectId: project.id,
        tabId: tab.id,
        pickMode: Boolean(message.startInPickMode)
      };

      await chrome.storage.local.set({ [STORAGE_KEYS.BUILDER_SESSION]: session });
      broadcastToExtension({ type: 'PROJECTS_UPDATED', projects, updatedProject: project });
      broadcastToExtension({ type: 'BUILDER_SESSION_CHANGED', session });

      // Ensure content script is injected and initialized even if tab was already open
      setTimeout(async () => {
        await ensureContentScriptInjected(tab.id);
        sendMessageToTabSafe(tab.id, {
          type: 'BUILDER_SYNC_STATE',
          session,
          project
        });
      }, 500);

      return { ok: true, session, project };
    }

    case 'UPDATE_BUILDER_SESSION': {
      const data = await chrome.storage.local.get([STORAGE_KEYS.BUILDER_SESSION, STORAGE_KEYS.PROJECTS]);
      const current = data[STORAGE_KEYS.BUILDER_SESSION] || {};
      const updated = { ...current, ...message.updates };
      await chrome.storage.local.set({ [STORAGE_KEYS.BUILDER_SESSION]: updated });

      if (updated.tabId) {
        const projects = data[STORAGE_KEYS.PROJECTS] || [];
        const project = projects.find((p) => p.id === updated.projectId);
        sendMessageToTabSafe(updated.tabId, {
          type: 'BUILDER_SYNC_STATE',
          session: updated,
          project
        });
      }
      broadcastToExtension({ type: 'BUILDER_SESSION_CHANGED', session: updated });
      return { ok: true, session: updated };
    }

    case 'CLOSE_BUILDER_SESSION': {
      const data = await chrome.storage.local.get([STORAGE_KEYS.BUILDER_SESSION]);
      const current = data[STORAGE_KEYS.BUILDER_SESSION] || {};
      const oldTabId = current.tabId;
      const closedSession = { active: false, projectId: null, tabId: null, pickMode: false };
      await chrome.storage.local.set({ [STORAGE_KEYS.BUILDER_SESSION]: closedSession });
      if (oldTabId) {
        sendMessageToTabSafe(oldTabId, { type: 'BUILDER_CLOSE_HUD' });
      }
      broadcastToExtension({ type: 'BUILDER_SESSION_CHANGED', session: closedSession });
      return { ok: true };
    }

    case 'OPEN_DASHBOARD': {
      const dashUrl = chrome.runtime.getURL('dashboard.html') + (message.projectId ? `#project=${message.projectId}` : '');
      const existingTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('dashboard.html') + '*' });
      if (existingTabs.length > 0) {
        await chrome.tabs.update(existingTabs[0].id, { active: true, url: dashUrl });
        await chrome.windows.update(existingTabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: dashUrl, active: true });
      }
      return { ok: true };
    }

    case 'START_WORKFLOW_RUN': {
      if (runnerControl.isRunning) {
        throw new Error('A workflow is already running. Stop it before starting a new one.');
      }
      const { projectId, maxRows, startRow, reuseBuilderTab, runtimeCsv } = message;
      // Launch workflow asynchronously so message returns immediately
      executeProjectWorkflow({ projectId, maxRows, startRow, reuseBuilderTab, runtimeCsv }).catch((err) => {
        console.error('[Workflow Execution Fatal]', err);
      });
      return { ok: true };
    }

    case 'PAUSE_RESUME_RUN': {
      if (!runnerControl.isRunning) return { ok: false, error: 'Not running' };
      runnerControl.isPaused = !runnerControl.isPaused;
      await updateRunnerState({ status: runnerControl.isPaused ? 'paused' : 'running' });
      return { ok: true, isPaused: runnerControl.isPaused };
    }

    case 'STOP_WORKFLOW_RUN': {
      if (!runnerControl.isRunning) return { ok: true };
      runnerControl.shouldStop = true;
      runnerControl.isPaused = false;
      await updateRunnerState({ status: 'stopping' });
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

async function syncActiveBuilderTab(projects) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.BUILDER_SESSION]);
  const session = data[STORAGE_KEYS.BUILDER_SESSION];
  if (session && session.active && session.tabId) {
    const project = projects.find((p) => p.id === session.projectId);
    if (project) {
      sendMessageToTabSafe(session.tabId, {
        type: 'BUILDER_SYNC_STATE',
        session,
        project
      });
    }
  }
}

async function ensureContentScriptInjected(tabId) {
  try {
    const res = await sendMessageToTabSafe(tabId, { type: 'PING_CONTENT' });
    if (res && res.ok) return true;
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['csv_utils.js', 'content.js']
    });
    return true;
  } catch (err) {
    console.warn('Could not inject content script into tab:', err.message);
    return false;
  }
}

function sendMessageToTabSafe(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

function broadcastToExtension(payload) {
  chrome.runtime.sendMessage(payload, () => {
    // Ignore error if no extension pages (dashboard/popup) are open
    void chrome.runtime.lastError;
  });
}

// ============================================================================
// WORKFLOW EXECUTION ENGINE (Supports Master CSV + Step CSV + Multi-Page Nav)
// ============================================================================

async function updateRunnerState(patch) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.RUNNER_STATE]);
  const current = data[STORAGE_KEYS.RUNNER_STATE] || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE_KEYS.RUNNER_STATE]: next });

  broadcastToExtension({ type: 'RUNNER_SYNC_STATE', state: next });
  if (runnerControl.activeTabId) {
    sendMessageToTabSafe(runnerControl.activeTabId, { type: 'RUNNER_SYNC_STATE', state: next });
  }
  return next;
}

async function appendRunLog(level, text) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.RUNNER_STATE]);
  const current = data[STORAGE_KEYS.RUNNER_STATE] || {};
  const logs = current.logs || [];
  logs.push({
    time: new Date().toLocaleTimeString(),
    level,
    text
  });
  // Keep last 300 logs
  if (logs.length > 300) logs.shift();
  return updateRunnerState({ logs });
}

async function waitWhilePausedOrStopped() {
  while (runnerControl.isPaused && !runnerControl.shouldStop) {
    await sleep(250);
  }
  if (runnerControl.shouldStop) {
    throw new Error('WORKFLOW_STOPPED_BY_USER');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        runnerControl.pageLoadResolvers.delete(tabId);
        resolve({ timedOut: true });
      }
    }, timeoutMs);

    runnerControl.pageLoadResolvers.set(tabId, (tab) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(tab);
      }
    });
  });
}

async function executeProjectWorkflow({ projectId, maxRows = 0, startRow = 1, reuseBuilderTab = false, runtimeCsv = null }) {
  const storageData = await chrome.storage.local.get([
    STORAGE_KEYS.PROJECTS,
    STORAGE_KEYS.BUILDER_SESSION
  ]);
  const projects = storageData[STORAGE_KEYS.PROJECTS] || [];
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Project not found');
  if (!project.steps || project.steps.length === 0) {
    throw new Error('Project has no steps to run.');
  }

  // Check if user supplied a Runtime CSV for this execution
  const hasRuntimeCsv =
    runtimeCsv &&
    Array.isArray(runtimeCsv.rows) &&
    runtimeCsv.rows.length > 0;

  if (hasRuntimeCsv && runtimeCsv.saveAsDefault) {
    project.masterCsv = {
      enabled: true,
      fileName: runtimeCsv.fileName || 'runtime_uploaded.csv',
      headers: runtimeCsv.headers || [],
      rows: runtimeCsv.rows
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
    broadcastToExtension({ type: 'PROJECTS_UPDATED', projects, updatedProject: project });
  }

  // Determine how many times the ENTIRE sequence flow should run.
  // If a Runtime CSV was provided at execution time, its row count drives the sequence!
  const hasMasterCsv =
    project.masterCsv &&
    project.masterCsv.enabled !== false &&
    Array.isArray(project.masterCsv.rows) &&
    project.masterCsv.rows.length > 0;

  let masterCsvRows = hasRuntimeCsv
    ? runtimeCsv.rows
    : hasMasterCsv
    ? project.masterCsv.rows
    : [];

  const startIdx = Math.max(0, (parseInt(startRow, 10) || 1) - 1);

  function computeSequenceIndices() {
    let maxSequenceRows = masterCsvRows.length;
    if (!hasRuntimeCsv) {
      for (const st of project.steps) {
        if (
          st.stepCsv &&
          Array.isArray(st.stepCsv.rows) &&
          st.stepCsv.rows.length > 0 &&
          st.stepCsv.mode !== 'loop_single_step'
        ) {
          if (st.stepCsv.rows.length > maxSequenceRows) {
            maxSequenceRows = st.stepCsv.rows.length;
          }
        }
      }
    }
    const totalAvailableRows = Math.max(maxSequenceRows, 1);
    let indices = [];
    for (let i = 0; i < totalAvailableRows; i++) {
      indices.push(i);
    }
    indices = indices.slice(startIdx);
    if (maxRows && maxRows > 0) {
      indices = indices.slice(0, maxRows);
    }
    return indices;
  }

  let sequenceIndices = computeSequenceIndices();

  // Helper to build the merged row data for sequence iteration `rowIndex`
  function getMergedSequenceRow(rowIndex) {
    const merged = {};
    // Merge all Step CSV rows for this rowIndex first so ANY follow-up step can pick from the same CSV!
    for (const st of project.steps) {
      if (
        st.stepCsv &&
        Array.isArray(st.stepCsv.rows) &&
        st.stepCsv.rows.length > 0
      ) {
        const r = st.stepCsv.rows[rowIndex] || st.stepCsv.rows[rowIndex % st.stepCsv.rows.length] || {};
        Object.assign(merged, r);
      }
    }
    // Merge Master CSV / Runtime CSV row on top (so Runtime CSV overrides the example/reference CSV!)
    if (masterCsvRows.length > 0) {
      const mRow = masterCsvRows[rowIndex] || masterCsvRows[rowIndex % masterCsvRows.length] || {};
      Object.assign(merged, mRow);
    }
    return merged;
  }

  // Determine initial URL
  let initialUrl = project.startUrl || 'https://example.com';
  const firstStep = project.steps[0];
  if (firstStep && firstStep.type === 'navigate' && firstStep.value) {
    initialUrl = FlowTagCSV.interpolateValue(firstStep.value, {
      masterRow: getMergedSequenceRow(sequenceIndices[0] || 0),
      masterRowIndex: sequenceIndices[0] || 0
    });
  }
  if (!/^https?:\/\//i.test(initialUrl)) {
    initialUrl = 'https://' + initialUrl;
  }

  // Open or reuse tab
  let targetTab = null;
  const builderSession = storageData[STORAGE_KEYS.BUILDER_SESSION];
  if (reuseBuilderTab && builderSession && builderSession.active && builderSession.tabId) {
    try {
      targetTab = await chrome.tabs.get(builderSession.tabId);
      await chrome.tabs.update(targetTab.id, { active: true });
    } catch (_) {
      targetTab = null;
    }
  }

  if (!targetTab) {
    const loadWait = waitForTabComplete(-1, 100); // dummy init
    void loadWait;
    targetTab = await chrome.tabs.create({ url: initialUrl, active: true });
    await waitForTabComplete(targetTab.id, 18000);
    await sleep(600);
  }

  runnerControl.isRunning = true;
  runnerControl.isPaused = false;
  runnerControl.shouldStop = false;
  runnerControl.activeTabId = targetTab.id;

  const extractedResults = [];

  await updateRunnerState({
    projectId: project.id,
    projectName: project.name,
    status: 'running',
    tabId: targetTab.id,
    totalMasterRows: sequenceIndices.length,
    currentMasterRow: 1,
    totalSteps: project.steps.length,
    currentStepIndex: 0,
    currentStepName: 'Initializing...',
    results: [],
    logs: [
      {
        time: new Date().toLocaleTimeString(),
        level: 'info',
        text: `Started workflow "${project.name}" (${sequenceIndices.length} full sequence run${sequenceIndices.length === 1 ? '' : 's'}).`
      }
    ]
  });

  await ensureContentScriptInjected(targetTab.id);

  const stepTableSourceStep = (project.steps || []).find(
    (st) => st.stepCsv && st.stepCsv.enabled && st.stepCsv.sourceType === 'page_table' && st.stepCsv.containerSelector
  );
  const effectivePageTableSource =
    project.pageTableSource && project.pageTableSource.enabled && project.pageTableSource.containerSelector
      ? project.pageTableSource
      : stepTableSourceStep
      ? {
          enabled: true,
          sourceType: 'table',
          containerSelector: stepTableSourceStep.stepCsv.containerSelector,
          rowSelector: stepTableSourceStep.stepCsv.rowSelector || 'tbody tr',
          liveRefreshOnRun: true
        }
      : null;

  const hasPageTableSource = Boolean(effectivePageTableSource && !hasRuntimeCsv);

  async function refreshLivePageTableRowsIfNeeded() {
    if (!hasPageTableSource || effectivePageTableSource.liveRefreshOnRun === false) return false;
    try {
      await ensureContentScriptInjected(targetTab.id);
      const liveRes = await sendMessageToTabSafe(targetTab.id, {
        type: 'EXTRACT_PAGE_TABLE_ROWS',
        pageTableSource: effectivePageTableSource
      });
      if (liveRes && liveRes.ok && Array.isArray(liveRes.rows) && liveRes.rows.length > 0) {
        masterCsvRows = liveRes.rows;
        for (const st of project.steps || []) {
          if (st.stepCsv && st.stepCsv.sourceType === 'page_table') {
            st.stepCsv.rows = liveRes.rows;
            if (Array.isArray(liveRes.headers) && liveRes.headers.length > 0) {
              st.stepCsv.headers = liveRes.headers;
            }
          }
        }
        sequenceIndices = computeSequenceIndices();
        await updateRunnerState({ totalMasterRows: sequenceIndices.length });
        await appendRunLog(
          'info',
          `🌐 Live Page Table/List (${effectivePageTableSource.containerSelector}): Detected ${liveRes.rows.length} row(s) on page.`
        );
        return true;
      }
    } catch (_) {}
    return false;
  }

  await refreshLivePageTableRowsIfNeeded();

  try {
    for (let mIdx = 0; mIdx < sequenceIndices.length; mIdx++) {
      await waitWhilePausedOrStopped();
      const rowIndex = sequenceIndices[mIdx];
      const actualRowNumber = rowIndex + 1;
      let masterRow = getMergedSequenceRow(rowIndex);
      const activePageTableConfig = effectivePageTableSource
        ? {
            containerSelector: effectivePageTableSource.containerSelector,
            rowSelector: effectivePageTableSource.rowSelector || '',
            rowIndex
          }
        : null;

      // Build result record seeded with current row columns
      const rowResult = {
        _Row: actualRowNumber,
        _Status: 'SUCCESS',
        _Status_Details: '',
        ...masterRow
      };
      const extractedVars = {};
      const rowErrors = [];
      let rowSkippedReason = '';
      let executedStepsCount = 0;

      await updateRunnerState({
        currentMasterRow: mIdx + 1,
        currentStepIndex: 0,
        currentStepName: `Starting Sequence Run #${actualRowNumber} (Row ${mIdx + 1} of ${sequenceIndices.length})`
      });
      await appendRunLog('info', `--- Running Full Sequence for Row #${actualRowNumber} (${mIdx + 1}/${sequenceIndices.length}) ---`);

      let skipRemainingStepsForRow = false;

      for (let sIdx = 0; sIdx < project.steps.length; sIdx++) {
        if (skipRemainingStepsForRow) break;
        await waitWhilePausedOrStopped();
        const step = project.steps[sIdx];
        const stepKey = `step_${sIdx + 1}`;

        if (step.paused) {
          await appendRunLog(
            'info',
            `⏸ [Row ${actualRowNumber} · Step ${sIdx + 1}] Skipping paused step: "${step.name || step.type}"`
          );
          continue;
        }
        executedStepsCount++;

        // Check if this step has its own Step-level CSV
        const hasStepCsv =
          step.stepCsv &&
          step.stepCsv.enabled &&
          Array.isArray(step.stepCsv.rows) &&
          step.stepCsv.rows.length > 0;

        let stepIterations = [{ stepRow: masterRow, stepRowIndex: rowIndex }];
        if (hasStepCsv) {
          if (step.stepCsv.mode === 'loop_single_step') {
            // Only if user explicitly chose to loop this single step in-place over all rows
            const rowsToLoop = hasRuntimeCsv ? runtimeCsv.rows : step.stepCsv.rows;
            stepIterations = rowsToLoop.map((r, idx) => ({
              stepRow: r,
              stepRowIndex: idx
            }));
          } else {
            // DEFAULT ('sequence_row' / 'match_row' / 'loop_step'):
            // Pick 1 row for this entire sequence flow (Row #1 on Flow #1, Row #2 on Flow #2, etc.)
            const refRow =
              step.stepCsv.rows[rowIndex] !== undefined
                ? step.stepCsv.rows[rowIndex]
                : step.stepCsv.rows[rowIndex % step.stepCsv.rows.length] || {};
            const pickedRow = hasRuntimeCsv ? { ...refRow, ...masterRow } : { ...masterRow, ...refRow };
            stepIterations = [{ stepRow: pickedRow, stepRowIndex: rowIndex }];
          }
        }

        for (let subIdx = 0; subIdx < stepIterations.length; subIdx++) {
          if (skipRemainingStepsForRow) break;
          await waitWhilePausedOrStopped();
          const { stepRow, stepRowIndex } = stepIterations[subIdx];

          const stepLabel =
            stepIterations.length > 1
              ? `${step.name || step.type} (Step CSV ${subIdx + 1}/${stepIterations.length})`
              : step.name || `Step ${sIdx + 1} (${step.type})`;

          await updateRunnerState({
            currentStepIndex: sIdx + 1,
            currentStepName: stepLabel
          });

          // Resolve dynamic value ({{col}}, {{prev.step_1}}, {{var.Name}}, or explicit Step CSV column)
          // Note: For 'condition' and 'verify' steps, `step.value` is the expected comparison string (e.g. "Enter PO ESD"),
          // NOT an input value to be replaced by `stepRow[columnName]`!
          let rawVal = step.value || '';
          if (
            step.type !== 'condition' &&
            step.type !== 'verify' &&
            hasStepCsv &&
            step.stepCsv.columnName &&
            !rawVal.includes('{{')
          ) {
            rawVal = stepRow[step.stepCsv.columnName] ?? rawVal;
          }

          const interpCtx = {
            masterRow,
            stepRow,
            masterRowIndex: actualRowNumber - 1,
            stepRowIndex,
            extractedVars
          };

          const resolvedValue = FlowTagCSV.interpolateValue(rawVal, interpCtx);
          const resolvedSelector = FlowTagCSV.interpolateValue(step.selector || '', interpCtx);
          const resolvedRowAnchor = FlowTagCSV.interpolateValue(step.options?.rowAnchorText || '', interpCtx);

          await appendRunLog(
            'step',
            `[Row ${actualRowNumber} · Step ${sIdx + 1}] ${stepLabel} ${resolvedValue ? `→ "${resolvedValue}"` : ''}${resolvedRowAnchor ? ` [Row Scope: "${resolvedRowAnchor}"]` : ''}`
          );

          // Store default step output so subsequent steps can reference {{prev.step_X}}
          extractedVars[stepKey] = resolvedValue;

          // Execute step by type
          if (step.type === 'navigate') {
            // When looping an embedded HTML table on the same page, skip redundant static page reloads on Row #2+
            if (
              mIdx > 0 &&
              sIdx === 0 &&
              hasPageTableSource &&
              !String(step.value || '').includes('{{')
            ) {
              await appendRunLog(
                'info',
                `🌐 [Row ${actualRowNumber}] Staying on current page to process HTML Table Row #${actualRowNumber}.`
              );
              continue;
            }
            let navUrl = resolvedValue || project.startUrl;
            if (!/^https?:\/\//i.test(navUrl)) {
              navUrl = 'https://' + navUrl;
            }
            extractedVars[stepKey] = navUrl;
            const waitNav = waitForTabComplete(targetTab.id, 20000);
            await chrome.tabs.update(targetTab.id, { url: navUrl });
            await waitNav;
            await sleep(500);
            await ensureContentScriptInjected(targetTab.id);
            if (mIdx === 0 && sIdx === 0 && hasPageTableSource) {
              const refreshed = await refreshLivePageTableRowsIfNeeded();
              if (refreshed) {
                masterRow = getMergedSequenceRow(rowIndex);
                Object.assign(rowResult, masterRow);
              }
            }
          } else if (step.type === 'wait' && (!step.options || step.options.waitMode !== 'element')) {
            const waitSec = parseFloat(resolvedValue) || 2;
            await sleep(Math.min(waitSec * 1000, 60000));
          } else if (step.type === 'condition') {
            const opts = step.options || {};
            const ifSource = opts.ifSource || (step.selector && !opts.ifLeftValue && !step.stepCsv?.columnName ? 'dom_element' : 'csv_or_var');
            const conditionOp = opts.verifyCondition || 'equals';
            let condPassed = false;
            let condReason = '';
            let condActual = '';

            if (ifSource === 'csv_or_var') {
              const rawLeft =
                opts.ifLeftValue ||
                (step.stepCsv?.columnName ? `{{${step.stepCsv.columnName}}}` : '');
              const resolvedLeft = FlowTagCSV.interpolateValue(rawLeft, interpCtx);
              const evalRes = FlowTagCSV.evaluateVerification(
                resolvedLeft,
                conditionOp,
                resolvedValue,
                Boolean(opts.caseSensitive)
              );
              condPassed = evalRes.passed;
              condReason = `Column/Var "${rawLeft}" = "${resolvedLeft}" → ${evalRes.reason}`;
              condActual = evalRes.actualValue;
            } else {
              await ensureContentScriptInjected(targetTab.id);
              const checkRes = await sendMessageToTabSafe(targetTab.id, {
                type: 'EXECUTE_DOM_STEP',
                step: {
                  ...step,
                  type: 'condition_check',
                  resolvedSelector,
                  resolvedValue,
                  resolvedRowAnchor,
                  pageTableConfig: activePageTableConfig
                }
              });
              if (checkRes && checkRes.ok) {
                condPassed = Boolean(checkRes.verifyPassed);
                condReason = `Page Element (${resolvedSelector}) → ${checkRes.verifyReason || ''}`;
                condActual = checkRes.actualValue ?? '';
              } else {
                condPassed = false;
                condReason = `Page Element (${resolvedSelector}) not found`;
                condActual = '';
              }
            }

            const defaultThen = { mode: 'continue', selector: '', value: '', targetStepNumber: '' };
            const defaultElse = { mode: 'continue', selector: '', value: '', targetStepNumber: '' };
            const actionsList = condPassed
              ? Array.isArray(opts.thenActions) && opts.thenActions.length > 0
                ? opts.thenActions
                : [opts.thenBranch || defaultThen]
              : Array.isArray(opts.elseActions) && opts.elseActions.length > 0
              ? opts.elseActions
              : [opts.elseBranch || defaultElse];

            const branchLabel = condPassed ? 'THEN (True)' : 'ELSE (False)';
            const modesSummary = actionsList.map((a) => a.mode || 'continue').join(' → ');

            extractedVars[stepKey] = condActual;
            extractedVars[`${stepKey}.passed`] = condPassed ? 'TRUE' : 'FALSE';
            rowResult[`_Condition_Step_${sIdx + 1}`] = `${condPassed ? 'TRUE → THEN' : 'FALSE → ELSE'} (${modesSummary})`;

            await appendRunLog(
              condPassed ? 'success' : 'info',
              `🔀 IF Condition ${condPassed ? 'TRUE' : 'FALSE'} [${condReason}] → Running ${branchLabel}: ${modesSummary.toUpperCase()}`
            );

            let jumpedStep = false;

            const executeSingleChainedAction = async (branch, actionLabel) => {
              const branchMode = branch.mode || 'continue';
              if (branchMode === 'continue' || branchMode === 'none') {
                return 'continue';
              }
              if (branchMode === 'wait') {
                const wVal = FlowTagCSV.interpolateValue(branch.value || '1', interpCtx);
                const wSec = parseFloat(wVal) || 1;
                await appendRunLog('info', `⏱ ${actionLabel}: Waiting ${wSec}s...`);
                await sleep(Math.min(wSec * 1000, 60000));
                return 'ok';
              }
              if (branchMode === 'skip_next') {
                await appendRunLog('info', `↪ ${actionLabel}: Skipping next step (Step ${sIdx + 2}).`);
                sIdx += 1;
                return 'break';
              }
              if (branchMode === 'jump_to_step') {
                const targetStepNum = parseInt(branch.targetStepNumber, 10);
                if (!Number.isNaN(targetStepNum) && targetStepNum >= 1 && targetStepNum <= project.steps.length) {
                  await appendRunLog('info', `↪ ${actionLabel}: Jumping to Step #${targetStepNum}.`);
                  sIdx = targetStepNum - 2;
                  jumpedStep = true;
                  return 'break';
                }
                return 'ok';
              }
              if (branchMode === 'skip_row') {
                await appendRunLog('warn', `↪ ${actionLabel}: Skipping remaining steps for Row #${actualRowNumber}.`);
                rowSkippedReason = `Skipped at Step ${sIdx + 1} (${actionLabel})`;
                skipRemainingStepsForRow = true;
                return 'break';
              }
              if (branchMode === 'stop_workflow') {
                const stopMsg = `Stopped workflow by ${actionLabel} at Step ${sIdx + 1} (${stepLabel}).`;
                rowResult._Status = 'STOPPED';
                rowResult._Status_Details = stopMsg;
                rowResult._Timestamp = new Date().toISOString();
                extractedResults.push(rowResult);
                await updateRunnerState({ results: extractedResults });
                await saveRunResultsToProject(project.id, extractedResults);
                throw new Error(stopMsg);
              }
              if (branchMode === 'navigate') {
                let branchUrl = FlowTagCSV.interpolateValue(branch.value || '', interpCtx);
                if (branchUrl) {
                  if (!/^https?:\/\//i.test(branchUrl)) branchUrl = 'https://' + branchUrl;
                  const waitNav = waitForTabComplete(targetTab.id, 20000);
                  await chrome.tabs.update(targetTab.id, { url: branchUrl });
                  await waitNav;
                  await sleep(500);
                  await ensureContentScriptInjected(targetTab.id);
                }
                return 'ok';
              }
              if (branchMode === 'nested_if') {
                const nSource = branch.ifSource || 'csv_or_var';
                const nCondOp = branch.verifyCondition || 'contains';
                const nExpected = FlowTagCSV.interpolateValue(branch.value || '', interpCtx);
                let nPassed = false;
                let nReason = '';
                if (nSource === 'csv_or_var') {
                  const nLeft = FlowTagCSV.interpolateValue(branch.ifLeftValue || '', interpCtx);
                  const nEval = FlowTagCSV.evaluateVerification(nLeft, nCondOp, nExpected, false);
                  nPassed = nEval.passed;
                  nReason = `${branch.ifLeftValue || ''} = "${nLeft}" → ${nEval.reason}`;
                } else {
                  const nSel = FlowTagCSV.interpolateValue(branch.selector || step.selector || '', interpCtx);
                  await ensureContentScriptInjected(targetTab.id);
                  const nCheck = await sendMessageToTabSafe(targetTab.id, {
                    type: 'EXECUTE_DOM_STEP',
                    step: {
                      id: `${step.id}_nested_check`,
                      type: 'condition_check',
                      selector: nSel,
                      resolvedSelector: nSel,
                      value: nExpected,
                      resolvedValue: nExpected,
                      resolvedRowAnchor,
                      pageTableConfig: activePageTableConfig,
                      options: {
                        ifSource: 'dom_element',
                        verifyCondition: nCondOp,
                        extractTarget: 'text'
                      }
                    }
                  });
                  nPassed = Boolean(nCheck && nCheck.ok && nCheck.verifyPassed);
                  nReason = `Element (${nSel}) → ${nCheck?.verifyReason || 'checked'}`;
                }
                const subMode = nPassed ? (branch.nestedThenMode || 'click') : (branch.nestedElseMode || 'continue');
                const subSel = nPassed ? (branch.nestedThenSelector || '') : (branch.nestedElseSelector || '');
                const subVal = nPassed ? (branch.nestedThenValue || '') : (branch.nestedElseValue || '');
                const subEnter = nPassed ? Boolean(branch.nestedThenPressEnter) : Boolean(branch.nestedElsePressEnter);
                await appendRunLog(
                  nPassed ? 'success' : 'info',
                  `↳ Nested IF ${nPassed ? 'TRUE' : 'FALSE'} [${nReason}] → ${subMode.toUpperCase()}`
                );
                return executeSingleChainedAction(
                  {
                    mode: subMode,
                    selector: subSel,
                    value: subVal,
                    pressEnter: subEnter
                  },
                  `${actionLabel} ↳ Nested ${nPassed ? 'THEN' : 'ELSE'}`
                );
              }
              if (['click', 'input', 'select', 'extract', 'keypress'].includes(branchMode)) {
                const branchRawSel = branch.selector || step.selector || '';
                const branchSelector = FlowTagCSV.interpolateValue(branchRawSel, interpCtx);
                const branchValue = FlowTagCSV.interpolateValue(branch.value || '', interpCtx);
                await ensureContentScriptInjected(targetTab.id);
                const branchExec = await sendMessageToTabSafe(targetTab.id, {
                  type: 'EXECUTE_DOM_STEP',
                  step: {
                    id: `${step.id}_${condPassed ? 'then' : 'else'}`,
                    name: `${stepLabel} (${actionLabel})`,
                    type: branchMode,
                    selector: branchSelector,
                    resolvedSelector: branchSelector,
                    value: branchValue,
                    resolvedValue: branchValue,
                    resolvedRowAnchor,
                    pageTableConfig: activePageTableConfig,
                    options: {
                      clearFirst: true,
                      pressEnter: Boolean(branch.pressEnter),
                      extractTarget: branch.extractTarget || 'text',
                      outputColumn: branch.outputColumn || `Branch_Step_${sIdx + 1}`
                    }
                  }
                });

                if (branchExec && branchExec.ok) {
                  if (branchExec.stepOutput !== undefined) {
                    extractedVars[stepKey] = branchExec.stepOutput;
                  }
                  if (branchMode === 'extract') {
                    const outCol = branch.outputColumn || `Branch_Extracted_${sIdx + 1}`;
                    rowResult[outCol] = branchExec.extractedValue ?? '';
                    extractedVars[outCol] = branchExec.extractedValue ?? '';
                  }
                  await appendRunLog('success', `✓ ${actionLabel} (${branchMode}) completed.`);
                  await sleep(350);
                } else if (branchExec && !branchExec.ok) {
                  await appendRunLog('error', `✗ ${actionLabel} (${branchMode}) error: ${branchExec.error}`);
                  rowErrors.push(`Step ${sIdx + 1} ${actionLabel} (${branchMode}): ${branchExec.error}`);
                  rowResult[`_Error_Step_${sIdx + 1}`] = branchExec.error;
                }
                return 'ok';
              }
              return 'ok';
            };

            for (let aIdx = 0; aIdx < actionsList.length; aIdx++) {
              await waitWhilePausedOrStopped();
              const actObj = actionsList[aIdx];
              const actLabel =
                actionsList.length > 1 ? `${branchLabel} #${aIdx + 1}` : branchLabel;
              const status = await executeSingleChainedAction(actObj, actLabel);
              if (status === 'break') break;
            }
            if (jumpedStep) break;
          } else {
            // Execute DOM step inside Content Script
            await ensureContentScriptInjected(targetTab.id);
            const execRes = await sendMessageToTabSafe(targetTab.id, {
              type: 'EXECUTE_DOM_STEP',
              step: {
                ...step,
                resolvedSelector,
                resolvedValue,
                resolvedRowAnchor,
                pageTableConfig: activePageTableConfig
              }
            });

            if (!execRes) {
              // The click or Enter key might have triggered an immediate full-page load!
              await appendRunLog('info', `Page navigation detected during step "${stepLabel}", waiting for page ready...`);
              await sleep(1500);
              await ensureContentScriptInjected(targetTab.id);
            } else if (!execRes.ok) {
              if (step.options && step.options.optional) {
                await appendRunLog('warn', `Optional step skipped: ${execRes.error}`);
              } else {
                await appendRunLog('error', `Step error: ${execRes.error}`);
                rowErrors.push(`Step ${sIdx + 1} (${stepLabel}): ${execRes.error}`);
                rowResult[`_Error_Step_${sIdx + 1}`] = execRes.error;
              }
            } else {
              // Save step output for {{prev.step_X}} references
              if (execRes.stepOutput !== undefined && execRes.stepOutput !== '') {
                extractedVars[stepKey] = execRes.stepOutput;
              }

              if (step.type === 'extract') {
                const outCol = (step.options && step.options.outputColumn) || step.name || `Extracted_${sIdx + 1}`;
                const extractedVal = execRes.extractedValue !== undefined ? execRes.extractedValue : '';
                if (stepIterations.length > 1) {
                  rowResult[`${outCol}_${subIdx + 1}`] = extractedVal;
                } else {
                  rowResult[outCol] = extractedVal;
                }
                extractedVars[outCol] = extractedVal;
                extractedVars[stepKey] = extractedVal;
                await appendRunLog('success', `Extracted [${outCol}]: "${String(extractedVal).slice(0, 80)}"`);
              } else if (step.type === 'verify') {
                const outCol = (step.options && step.options.outputColumn) || `Check_Step_${sIdx + 1}`;
                const passed = Boolean(execRes.verifyPassed);
                const actualVal = execRes.actualValue !== undefined ? execRes.actualValue : '';
                const reason = execRes.verifyReason || '';

                extractedVars[stepKey] = actualVal;
                extractedVars[`${stepKey}.passed`] = passed ? 'PASS' : 'FAIL';
                extractedVars[outCol] = actualVal;
                rowResult[outCol] = `${passed ? 'PASS' : 'FAIL'} (${actualVal})`;

                if (passed) {
                  await appendRunLog('success', `✓ Check Passed [${stepLabel}]: ${reason}`);
                } else {
                  const onFail = (step.options && step.options.onVerifyFail) || 'skip_row';
                  await appendRunLog('warn', `✗ Check Failed [${stepLabel}]: ${reason}`);
                  rowErrors.push(`Step ${sIdx + 1} Verify Failed: ${reason}`);
                  if (onFail === 'stop_workflow') {
                    const failMsg = `Verification failed at Step ${sIdx + 1} (${stepLabel}): ${reason}`;
                    rowResult._Status = 'FAILED';
                    rowResult._Status_Details = failMsg;
                    rowResult._Timestamp = new Date().toISOString();
                    extractedResults.push(rowResult);
                    await updateRunnerState({ results: extractedResults });
                    await saveRunResultsToProject(project.id, extractedResults);
                    throw new Error(failMsg);
                  } else if (onFail === 'skip_row') {
                    await appendRunLog('warn', `Skipping remaining steps for Row #${actualRowNumber} due to failed check.`);
                    rowSkippedReason = `Verify failed at Step ${sIdx + 1}: ${reason}`;
                    skipRemainingStepsForRow = true;
                  }
                }
              }
            }
          }

          // Post-step wait delay
          const waitAfterMs = step.options && step.options.waitAfterMs !== undefined ? Number(step.options.waitAfterMs) : 600;
          if (waitAfterMs > 0) {
            await sleep(waitAfterMs);
          }
        }
      }

      if (rowErrors.length > 0) {
        rowResult._Status = 'FAILED';
        rowResult._Status_Details = rowErrors.join(' | ');
      } else if (rowSkippedReason) {
        rowResult._Status = 'SKIPPED';
        rowResult._Status_Details = rowSkippedReason;
      } else {
        rowResult._Status = 'SUCCESS';
        rowResult._Status_Details = `Completed (${executedStepsCount} step${executedStepsCount === 1 ? '' : 's'})`;
      }
      rowResult._Timestamp = new Date().toISOString();
      extractedResults.push(rowResult);

      // Save incremental results to project and runner state
      await updateRunnerState({ results: extractedResults });
      await saveRunResultsToProject(project.id, extractedResults);
    }

    await appendRunLog('success', `Workflow completed! Processed ${extractedResults.length} row(s).`);
    await updateRunnerState({
      status: 'completed',
      currentStepName: 'Completed All Rows!'
    });
  } catch (err) {
    if (err.message === 'WORKFLOW_STOPPED_BY_USER') {
      await appendRunLog('warn', 'Workflow stopped by user.');
      await updateRunnerState({ status: 'stopped', currentStepName: 'Stopped by user' });
    } else {
      await appendRunLog('error', `Execution failed: ${err.message}`);
      await updateRunnerState({ status: 'error', currentStepName: `Error: ${err.message}` });
    }
  } finally {
    runnerControl.isRunning = false;
    runnerControl.isPaused = false;
    runnerControl.shouldStop = false;
  }
}

async function saveRunResultsToProject(projectId, results) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.PROJECTS, STORAGE_KEYS.RUNNER_STATE]);
  const projects = data[STORAGE_KEYS.PROJECTS] || [];
  const runnerState = data[STORAGE_KEYS.RUNNER_STATE] || {};
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx >= 0) {
    projects[idx].lastRunResults = results;
    projects[idx].lastRunLogs = runnerState.logs || [];
    projects[idx].updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
    broadcastToExtension({ type: 'PROJECTS_UPDATED', projects, updatedProject: projects[idx] });
  }
}
