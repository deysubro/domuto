# Changelog

All notable changes to **Domuto | Visual Browser Automation** will be documented in this file.

## [1.1.0] - 2026-10-30

### Added
- **Live HTML Table & Repeating List Data Source**:
  - One-click detection and selection of live HTML `<table>`, `[role="table"]`, `[role="grid"]`, or repeating `<div>` lists directly on the webpage as data sources.
  - Automatically extracts visible header columns and executes sequences row-by-row without requiring a pre-exported CSV file.
  - Smart nested/expandable details row filtering (`measure-row`, `expanded-row`) and sticky-header pairing for 100% accurate column alignment.
  - Guaranteed unique container selectors with hierarchical ancestor scoping.
- **Chained Multi-Action THEN / ELSE & Nested IFs**:
  - Condition (`type: 'condition'`) steps now support chaining multiple actions within both `THEN` and `ELSE` branches (e.g. click element, type input, select dropdown, extract data).
  - Support for `nested_if` condition actions inside branches.
- **Timed Delay Picker (`⏱️ 3s Delay Pick`)**:
  - 3-second countdown timer before picker activation, giving users time to click and open dynamic popups, modals, or dropdown menus before mapping elements.
- **Math & Date Expression Calculations (`FlowTagCSV.interpolateValue`)**:
  - Full date arithmetic engine preserving input date formats (`MM-DD-YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY`, `DD-MMM-YYYY`).
  - Business day addition and subtraction: `({{PO_Submitted_Date}} + next business day)`, `({{PO_Submitted_Date}} + 3 business days)` (automatically skips Saturday/Sunday).
  - Calendar day calculations: `({{PO_Submitted_Date}} + 1)`, `({{PO_Submitted_Date}} + 2 days)`, `({{PO_Submitted_Date}} - 1 day)`.
  - Numeric arithmetic (`+`, `-`, `*`, `/`) with automatic currency symbol (`$`) and precision preservation.
- **Interactive Formula Autocomplete & Helper Pills**:
  - Typing `(` in any value or condition input triggers a floating autocomplete menu populated with available table/CSV column formulas.
  - Full keyboard navigation (<kbd>↑</kbd>, <kbd>↓</kbd>, <kbd>Enter</kbd>, <kbd>Tab</kbd>, <kbd>Esc</kbd>) and real-time query filtering.
  - One-click formula helper pills below input fields (`📅 ({{Col}} + next biz day)`, `📅 ({{Col}} + 1 day)`, `🧮 ({{Col}} + 1)`).

### Fixed
- **Modal & Popover Selector Scoping**:
  - Fixed an issue where picking an element inside a floating modal/popover (such as `#PurchaseOrderShipDate`) degraded into a generic `input` selector and was incorrectly classified as `📍 Current Row`.
  - Added specific selector identification preserving element IDs, names, classes, and types (`buildElementSpecificSnippet`), and automatic modal ancestor detection.
- **Table Data Source Execution Prompt**:
  - Resolved execution prompt requesting an external CSV file when a live page table was selected as the workflow data source.

## [1.0.0] - 2026-10-28

### Added
- **Interactive On-Page Element Picker & HUD (`content.js`)**: Shadow DOM–isolated visual flow builder with live element highlighting, `+ Manual Step` creation, and automatic `<select>` dropdown `<option>` extraction.
- **Self-Validating Wildcard Selector & Row Anchor Engine**: Automatically strips dynamic numeric IDs into CSS attribute wildcards only when validated against the live DOM, and automatically scopes multi-row table selectors using `rowAnchorText` (`{{CSV_Column}}`).
- **Visual `IF / THEN / ELSE` Conditional Step (`type: 'condition'`)**: Supports evaluating either CSV cells/variables (`csv_or_var`) or live DOM elements (`dom_element`, including `element_exists` / `element_not_exists`) with rich `THEN` and `ELSE` actions (`input`, `click`, `select`, `extract`, `navigate`, `skip_next`, `jump_to_step`, `skip_row`, `stop_workflow`).
- **Per-Step Pause / Resume Toggle**: Pause individual steps (`step.paused`) during testing from either the on-page HUD or the Studio Dashboard.
- **Per-Project AI Export & Import (`.domuto.json`)**: Self-documenting AI export format with embedded `_domuto_ai_guide` schema instructions so ChatGPT, Claude, or Gemini can read, edit, and return workflows.
- **Per-Row Execution Status Reporting**: Added `_Status` (`SUCCESS`, `FAILED`, `SKIPPED`, `STOPPED`) and `_Status_Details` columns to both the Studio results table and exported `.CSV` reports.
