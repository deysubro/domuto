# Changelog

All notable changes to **Domuto | Visual Browser Automation** will be documented in this file.

## [1.0.0] - 2026-10-28

### Added
- **Interactive On-Page Element Picker & HUD (`content.js`)**: Shadow DOM–isolated visual flow builder with live element highlighting, `+ Manual Step` creation, and automatic `<select>` dropdown `<option>` extraction.
- **Self-Validating Wildcard Selector & Row Anchor Engine**: Automatically strips dynamic numeric IDs into CSS attribute wildcards only when validated against the live DOM, and automatically scopes multi-row table selectors using `rowAnchorText` (`{{CSV_Column}}`).
- **Visual `IF / THEN / ELSE` Conditional Step (`type: 'condition'`)**: Supports evaluating either CSV cells/variables (`csv_or_var`) or live DOM elements (`dom_element`, including `element_exists` / `element_not_exists`) with rich `THEN` and `ELSE` actions (`input`, `click`, `select`, `extract`, `navigate`, `skip_next`, `jump_to_step`, `skip_row`, `stop_workflow`).
- **Per-Step Pause / Resume Toggle**: Pause individual steps (`step.paused`) during testing from either the on-page HUD or the Studio Dashboard.
- **Per-Project AI Export & Import (`.domuto.json`)**: Self-documenting AI export format with embedded `_domuto_ai_guide` schema instructions so ChatGPT, Claude, or Gemini can read, edit, and return workflows.
- **Per-Row Execution Status Reporting**: Added `_Status` (`SUCCESS`, `FAILED`, `SKIPPED`, `STOPPED`) and `_Status_Details` columns to both the Studio results table and exported `.CSV` reports.
