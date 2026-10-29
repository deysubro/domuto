/**
 * Domuto | Visual Browser Automation - Extension Popup Controller
 * Authored by Subrata Dey
 */
document.addEventListener('DOMContentLoaded', () => {
  const projectSelect = document.getElementById('project-select');
  const projectMeta = document.getElementById('project-meta');
  const btnOpenDashboard = document.getElementById('btn-open-dashboard');
  const btnLaunchDomain = document.getElementById('btn-launch-domain');
  const btnRunProject = document.getElementById('btn-run-project');
  const btnAttachCurrentTab = document.getElementById('btn-attach-current-tab');
  const btnNewProject = document.getElementById('btn-new-project');

  let projects = [];

  chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }, (res) => {
    if (!res || !res.ok) return;
    projects = res.projects || [];
    renderProjects();
  });

  function renderProjects() {
    projectSelect.innerHTML = '';
    if (projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No projects yet';
      projectSelect.appendChild(opt);
      projectMeta.textContent = '';
      return;
    }

    projects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      projectSelect.appendChild(opt);
    });

    updateMeta();
  }

  function getSelectedProject() {
    const id = projectSelect.value;
    return projects.find((p) => p.id === id) || projects[0] || null;
  }

  function updateMeta() {
    const p = getSelectedProject();
    if (!p) {
      projectMeta.textContent = '';
      return;
    }
    const stepCount = (p.steps || []).length;
    let csvCount = p.masterCsv && p.masterCsv.enabled !== false && p.masterCsv.rows ? p.masterCsv.rows.length : 0;
    for (const st of p.steps || []) {
      if (st.stepCsv && st.stepCsv.enabled && st.stepCsv.mode !== 'loop_step' && Array.isArray(st.stepCsv.rows)) {
        if (st.stepCsv.rows.length > csvCount) csvCount = st.stepCsv.rows.length;
      }
    }
    projectMeta.innerHTML = `
      <span>${stepCount} step${stepCount === 1 ? '' : 's'}</span>
      <span>${csvCount > 0 ? `CSV Flow: ${csvCount} rows` : 'Single run (No CSV)'}</span>
    `;
  }

  projectSelect.addEventListener('change', updateMeta);

  btnOpenDashboard.addEventListener('click', () => {
    const p = getSelectedProject();
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', projectId: p ? p.id : null });
    window.close();
  });

  btnNewProject.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', projectId: 'NEW' });
    window.close();
  });

  btnLaunchDomain.addEventListener('click', () => {
    const p = getSelectedProject();
    if (!p) return;
    chrome.runtime.sendMessage(
      {
        type: 'LAUNCH_TAG_BUILDER',
        projectId: p.id,
        targetUrl: p.startUrl || 'https://example.com',
        startInPickMode: true
      },
      () => window.close()
    );
  });

  btnAttachCurrentTab.addEventListener('click', async () => {
    const p = getSelectedProject();
    if (!p) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      alert('Please switch to a normal website tab (http:// or https://) first, or click "Open Domain & Map".');
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'LAUNCH_TAG_BUILDER',
        projectId: p.id,
        targetUrl: tab.url,
        useCurrentTab: true,
        tabId: tab.id,
        startInPickMode: true
      },
      () => window.close()
    );
  });

  let parsedRuntimeCsv = null;
  const runtimeCsvInput = document.getElementById('popup-runtime-csv');
  const runtimeCsvInfo = document.getElementById('popup-runtime-csv-info');

  runtimeCsvInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      parsedRuntimeCsv = null;
      if (runtimeCsvInfo) runtimeCsvInfo.textContent = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = window.FlowTagCSV.parseCSV(String(reader.result || ''));
      parsedRuntimeCsv = {
        fileName: file.name,
        headers: parsed.headers,
        rows: parsed.rows
      };
      if (runtimeCsvInfo) {
        runtimeCsvInfo.textContent = `✓ Ready: ${file.name} (${parsed.rows.length} rows)`;
      }
    };
    reader.readAsText(file);
  });

  btnRunProject.addEventListener('click', () => {
    const p = getSelectedProject();
    if (!p) return;
    chrome.runtime.sendMessage(
      {
        type: 'START_WORKFLOW_RUN',
        projectId: p.id,
        runtimeCsv: parsedRuntimeCsv
      },
      () => window.close()
    );
  });
});
