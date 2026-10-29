# Contributing to Domuto

Thank you for your interest in contributing to **Domuto | Visual Browser Automation**!

## 🛠️ Local Development Setup

Domuto intentionally uses **vanilla JavaScript (ES2022), HTML5, and CSS3** with zero bundler or transpiler dependencies. Every file in the repository runs directly in Chrome (Manifest V3).

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/deysubro/domuto.git
   cd domuto
   ```
2. Open `chrome://extensions` in Chrome, enable **Developer mode**, and click **Load unpacked** pointing to the repository root.
3. After editing any file:
   - Validate JavaScript syntax before testing:
     ```bash
     node --check background.js
     node --check content.js
     node --check dashboard.js
     node --check popup.js
     node --check csv_utils.js
     ```
   - Click the **Reload (`↻`)** button on the Domuto card in `chrome://extensions`.

## 📐 Architectural Guidelines

- **Shadow DOM Isolation (`content.js`)**: Any UI injected onto a host webpage must remain inside `shadowRoot` (`#flowtag-shadow-host`) so page CSS never leaks into the HUD and HUD styles never affect the host page.
- **Storage Compatibility (`background.js`)**: Do not rename the existing `STORAGE_KEYS` (`flowtag_projects`, `flowtag_builder_session`, `flowtag_runner_state`) so existing users never lose their saved workflows on upgrade.
- **Selector Resilience (`content.js`)**: Whenever generating wildcard selectors for dynamic attributes, validate the candidate wildcard against `document.querySelectorAll()` before preferring it over an exact selector.
