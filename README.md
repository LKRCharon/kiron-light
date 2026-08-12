# Kiron Light

A calm, Apple-inspired light theme for VS Code. Bright without being harsh, blue without being loud.

Kiron Light pairs a system-blue interaction layer with a restrained, proven syntax palette. The UI feels like a native macOS app; the code feels like a well-tuned editor. The two layers are designed independently and deliberately kept apart.

[Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=KairongLi.kiron-light) · [Repository](https://github.com/LKRCharon/kiron-light) · [Changelog](CHANGELOG.md)

## Design

### The UI layer speaks Apple blue

Every interactive surface follows one rule: blue means "you can act here". The blue itself comes in two tiers, mirroring how Apple uses it in practice:

| Tier | Color | Where |
| --- | --- | --- |
| Solid fills | `#0071E3` (hover `#0077ED`) | Buttons, badges, progress bars, remote status |
| Thin accents | `#0A84FF` | Focus rings, active borders, tab underline |
| Link text | `#0066D6` | Links, breadcrumb focus, modified-file markers |

Semantic states stay out of blue's way: errors `#D70015`, warnings `#BF8803`, success and additions `#1F9D3A`. Surfaces layer from `#f8f8f8` (editor) through `#ebedef` (sidebar) to `#a4a9b2` (status bar) — gentle gray steps instead of hard borders.

### The syntax layer stays independent

Code highlighting is not forced into the Apple-blue system. It builds on the palette of [Brackets Light Pro](https://github.com/EryouHao/brackets-light-pro), a light-theme classic whose color roles have survived a decade of daily use:

| Role | Color |
| --- | --- |
| Keywords | `#4469BD` |
| Types, classes | `#213EDB` |
| Functions | `#8431c5` |
| Strings | `#e88501` |
| Comments | `#10a567` |
| Numbers | `#6d8600` |
| Parameters | `#e06c75` |
| Tags, selectors | `#386ac3` |

Semantic highlighting is enabled (48 semantic token rules), with TextMate rules kept as fallback for grammar-only languages.

## Modern VS Code, fully covered

Kiron Light is written against the current theme spec — 700+ workbench color keys, organized in commented sections:

- Inline edit (next-edit suggestions), chat and agent sessions
- Multi-diff editor, SCM graph, sticky scroll (editor and sidebar)
- Bracket pair colorization, inlay hints, ghost text
- Testing, debugging, notebooks, settings editor, welcome page
- Full Apple-hued ANSI terminal palette with command decorations
- Markdown alerts, symbol icons, activity warning/error badges

## Install

Search for **Kiron Light** in the Extensions view, or:

```
code --install-extension KairongLi.kiron-light
```

Then select it via `Preferences: Color Theme` → **Kiron Light**.

## Development

```bash
npm install
npm run install:vscode   # package and install into local VS Code
```

The `playground/` folder contains sample files in several languages for eyeballing syntax colors while iterating. It is excluded from the packaged VSIX.

## Credits

The syntax palette is inspired by [Brackets Light Pro](https://github.com/EryouHao/brackets-light-pro) by EryouHao. Kiron Light started as an attempt to bring that palette's calm clarity to modern VS Code — semantic tokens, current workbench surfaces, and all.

## License

[MIT](LICENSE)
