# Playground

This folder is a local, production-shaped theme fixture for Kiron Light. The
files model the same fictional **Kiron Fleet Control Plane**: a multi-tenant
progressive-delivery system with feature flags, audit events, SLOs, incident
response, regional failover, and rollback workflows.

Each `demo.*` file contains at least 1,100 physical lines. The scale is
intentional: it exercises semantic highlighting, TextMate fallbacks, minimap
markers, Git decorations, bracket pairs, diagnostics, search, breadcrumbs, and
long-file navigation under conditions closer to a real engineering repository.

The fixtures are original and contain no production secrets. Open them in VS
Code with `Kiron Light` active, then compare typed and untyped symbols, nested
calls, declarations, state machines, structured data, logs, tables, and diff
states.

Run `node ./playground/generate-ui-fixtures.mjs` to regenerate the HTML, CSS,
and Markdown fixtures deterministically. The Python, JavaScript, TypeScript,
Rust, Shell, and JSON fixtures are maintained alongside their language-specific
validation commands.

The entire `playground/**` tree is excluded from VSIX packaging.
