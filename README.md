# pi-diff

A [pi](https://pi.dev) extension that replaces the default `write` and `edit` tool output with **Shiki-powered, syntax-highlighted diffs** — side-by-side split view, unified stacked view, and word-level change emphasis, all rendered directly in your terminal.

> **Status:** Early release.

### Unified view — stacked single-column diff

<img width="700" alt="pi-diff unified view" src="https://github.com/heyhuynhgiabuu/pi-diff/raw/main/media/unified.png" />

### Split view — side-by-side comparison

<img width="700" alt="pi-diff split view" src="https://github.com/heyhuynhgiabuu/pi-diff/raw/main/media/split.png" />

## Features

- **Syntax-highlighted diffs** — full Shiki grammar highlighting (190+ languages) composited with diff background colors
- **Split view** — side-by-side comparison for `edit` tool, auto-falls back to unified on narrow terminals
- **Unified view** — stacked single-column layout for `write` tool overwrites
- **Word-level emphasis** — changed characters get brighter backgrounds so you see exactly what changed
- **New file preview** — syntax-highlighted preview when creating files
- **Adaptive layout** — auto-detects terminal width; wraps intelligently on wide terminals, truncates on narrow ones
- **LRU cache** — singleton Shiki highlighter with 192-entry cache for fast re-renders
- **Large diff fallback** — gracefully degrades (skips highlighting, still shows diff structure) for files > 80k chars
- **Fully customizable** — every color and threshold is overridable via environment variables

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-diff
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## How It Works

pi-diff wraps the built-in `write` and `edit` tools from the pi SDK. When the agent writes or edits a file:

1. **Before the write** — reads the existing file content
2. **Delegates** to the original SDK tool (file is actually written)
3. **After the write** — computes a structured diff between old and new content
4. **Renders** the diff with syntax highlighting and word-level emphasis

The rendering pipeline:

```
Old content ──┐
              ├── diff (structuredPatch) ── parse ── highlight (Shiki → ANSI)
New content ──┘                                          │
                                                         ├── inject diff bg
                                                         ├── inject word-level bg
                                                         └── wrap/fit to terminal
```

### Views

| View | Used by | Description |
|------|---------|-------------|
| **Split** | `edit` tool | Side-by-side with old on left, new on right. Diagonal stripes fill empty slots. Auto-falls back to unified when terminal < 150 cols or > 20% of lines would wrap. |
| **Unified** | `write` tool | Single column with `+`/`-` gutter. Compact, works at any terminal width. |

Both views show:
- Colored border bars (`▌`) for changed lines
- Line numbers in the gutter
- Hunk separators (`··· N unmodified lines ···`)
- Word-level emphasis on paired add/del lines

## Configuration

All settings are controlled via environment variables. Add them to your shell profile or `.envrc`:

### Theme

| Variable | Default | Description |
|----------|---------|-------------|
| `DIFF_THEME` | `github-dark` | Shiki theme name (e.g., `dracula`, `one-dark-pro`, `catppuccin-mocha`) |

### Colors

Override any diff color with hex `#RRGGBB` format:

| Variable | Default | Description |
|----------|---------|-------------|
| `DIFF_BG_ADD` | `#162620` | Background for added lines |
| `DIFF_BG_DEL` | `#2d1919` | Background for removed lines |
| `DIFF_BG_ADD_HL` | `#234b32` | Word-level emphasis on added text |
| `DIFF_BG_DEL_HL` | `#502323` | Word-level emphasis on removed text |
| `DIFF_BG_GUTTER_ADD` | `#12201a` | Gutter background for added lines |
| `DIFF_BG_GUTTER_DEL` | `#261616` | Gutter background for removed lines |
| `DIFF_FG_ADD` | `#64b478` | Foreground for `+` signs and add indicators |
| `DIFF_FG_DEL` | `#c86464` | Foreground for `-` signs and del indicators |

### Layout

| Variable | Default | Description |
|----------|---------|-------------|
| `DIFF_SPLIT_MIN_WIDTH` | `150` | Minimum terminal columns to use split view |
| `DIFF_SPLIT_MIN_CODE_WIDTH` | `60` | Minimum code columns per side in split view |

### Example `.envrc`

```bash
# Use a different Shiki theme
export DIFF_THEME="catppuccin-mocha"

# Brighter add backgrounds
export DIFF_BG_ADD="#1a3a25"
export DIFF_BG_ADD_HL="#2d6040"

# Allow split view on narrower terminals
export DIFF_SPLIT_MIN_WIDTH=120
```

## Architecture

```
src/
└── index.ts    # Extension entry point — wraps write/edit tools with diff rendering
```

### Key internals

| Component | Purpose |
|-----------|---------|
| `parseDiff()` | Converts old/new content to structured `DiffLine[]` using `diff.structuredPatch` |
| `hlBlock()` | Shiki ANSI highlighting with LRU cache (192 entries) |
| `injectBg()` | Composites diff backgrounds into Shiki ANSI output (fg + bg layering) |
| `wordDiffAnalysis()` | Single-pass word diff → similarity score + character ranges |
| `renderSplit()` | Side-by-side renderer with diagonal stripe fillers |
| `renderUnified()` | Stacked single-column renderer |
| `wrapAnsi()` | ANSI-aware line wrapping with state carry-forward |
| `shouldUseSplit()` | Heuristic: split vs unified based on terminal width and wrap ratio |

### Rendering constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_PREVIEW_LINES` | 60 | Max lines in edit preview (split view) |
| `MAX_RENDER_LINES` | 150 | Max lines in write result (unified view) |
| `MAX_HL_CHARS` | 80,000 | Skip syntax highlighting above this |
| `CACHE_LIMIT` | 192 | LRU cache entries for highlighted blocks |
| `WORD_DIFF_MIN_SIM` | 0.15 | Minimum similarity for word-level emphasis |

## Exports

The extension exports a `__testing` object for unit testing:

```typescript
import { __testing } from "@heyhuynhgiabuu/pi-diff";

const { parseDiff, renderSplit, renderUnified, normalizeShikiContrast } = __testing;
```

## Development

```bash
git clone https://github.com/heyhuynhgiabuu/pi-diff.git
cd pi-diff
npm install
npm run typecheck   # TypeScript validation
npm run lint        # Biome linting
npm test            # Run tests
```

### Load in pi for testing

```bash
# From the pi-diff directory
pi -e ./src/index.ts

# Or install globally
pi install .
```

## How pi Extensions Work

pi-diff is a **pi extension** — a TypeScript file that exports a default function receiving the pi API:

```typescript
export default function piDiffExtension(pi: any): void {
  // Get SDK tools
  const origWrite = createWriteTool(cwd);
  const origEdit = createEditTool(cwd);

  // Register enhanced versions
  pi.registerTool({
    ...origWrite,
    name: "write",
    execute: async (...) => { /* wrap + diff */ },
    renderCall: (...) => { /* preview */ },
    renderResult: (...) => { /* render diff */ },
  });
}
```

Extensions can:
- **Register tools** — `pi.registerTool(definition)` 
- **Listen to events** — `pi.on("session_start" | "input" | "before_tool_call" | ...)`
- **Register commands** — `pi.registerCommand("/name", handler)`
- **Register providers** — `pi.registerProvider("name", config)`

See the [pi docs](https://pi.dev) for the full extension API.

## License

MIT — [huynhgiabuu](https://github.com/heyhuynhgiabuu)
