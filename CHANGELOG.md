# Changelog

All notable changes to the Kiron Light theme are documented here.

## 0.3.0 — 2026-08-12

- Python: color untyped member calls such as `stream.readline().split()` consistently with functions and methods
- Git: deepen added and untracked resource labels for clearer contrast in Explorer and Source Control
- Lists: remove the distracting focus outline from selected rows while retaining the selection background
- Development: replace the minimal playground with 1,000+ line, production-shaped fixtures for every included language

## 0.2.2 — 2026-08-12

- Fix: remove a duplicate `agentStatusIndicator.background` entry that overrode the intended quiet `#F5F5F7` value
- Packaging: align the manifest publisher with the existing Marketplace publisher ID `KairongLi`
- Packaging: synchronize the lockfile version with the extension manifest

## 0.2.1 — 2026-07-21

- Fix: title bar agent status pill (search / chat capsule) showed a muddy blue tint — the new `agentStatusIndicator.background` key was undefined and fell back to a focusBorder-derived color; now a quiet `#F5F5F7` matching the command center
- Add: `inputOption.*` keys for find-widget toggles (match case / regex), active state uses a soft blue chip `#D6E9FB`
- Packaging: exclude `.qoder/` and `work/` from the VSIX

## 0.2.0 — 2026-07-21

First public release.

- Single focused theme: **Kiron Light** (Apple-blue UI accent, one variant only)
- Complete workbench rewrite with 700+ color keys, organized in commented sections
- Two-tier action blue: `#0071E3` for solid fills (buttons, badges, progress), `#0A84FF` for thin accents (focus rings, active borders, tab underline)
- Semantic highlighting enabled with 48 semantic token rules, TextMate fallback kept for grammar-only languages
- Syntax palette rooted in Brackets Light Pro, refined for modern VS Code
- Modern surfaces themed: inline edit (next-edit suggestions), chat / agent sessions, multi-diff editor, SCM graph, sticky scroll, Markdown alerts, symbol icons
- Apple-hued ANSI terminal palette with command decorations
- Softened current-line highlight (no border box) and tuned minimap opacity

## 0.1.x

Internal iterations: initial palette drafts, variant experiments (default / Apple / Bold), packaging setup. Superseded by the single-theme strategy in 0.2.0.
