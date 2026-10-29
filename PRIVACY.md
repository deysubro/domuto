# Privacy Policy — Domuto | Visual Browser Automation

**Last Updated:** October 2026

**Domuto** is designed from the ground up with a strict **local-first, zero-telemetry architecture**.

## 1. Data Storage
- All automation projects, workflow steps, CSS selectors, uploaded CSV files, execution logs, and scraped/extracted results are stored **100% locally** on your device using Chrome's `chrome.storage.local` API.
- No data is ever transmitted to any external server, cloud database, or third-party service.

## 2. Permissions Explained
- **`storage` & `unlimitedStorage`**: Used exclusively to save your workflows, CSV rows, and run results locally inside your browser profile without hitting the standard 5MB `localStorage` limit.
- **`tabs` & `activeTab`**: Used to open your target workflow URL and coordinate step execution across page navigations when you explicitly start a workflow or attach the visual element picker.
- **`scripting` & `<all_urls>`**: Required so the interactive **Domuto Element Picker HUD** and DOM step executor (`content.js`) can run on the specific websites you choose to automate.
- **`downloads`**: Used when you click export buttons to save your results CSV or project JSON backup files to your computer.

## 3. Third-Party Sharing & Analytics
- Domuto includes **zero** analytics SDKs, **zero** telemetry beacons, and **zero** remote scripts.
