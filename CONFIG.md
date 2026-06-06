# pi-diff Configuration Guide

pi-diff is configured through a `pi-diff.json` file placed in your project root or at `~/.pi/agent/pi-diff.json`.

> **Priority:** Environment variable > project `pi-diff.json` > `~/.pi/agent/pi-diff.json` > defaults

---

## Quick Start

Place a `pi-diff.json` in your project root with only the settings you want to change:

```json
{
	"indicatorStyle": "classic",
	"lineNumbers": false
}
```

All other settings use defaults. See the full reference below.

---

## All Options

### Display

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sepStyle` | `"auto"` `"simple"` `"gap"` `"context"` `"metadata"` | `"auto"` | How collapsed hunk context is shown |
| `lineNumbers` | `boolean` | `true` | Show line numbers in gutter |
| `indicatorStyle` | `"bar"` `"classic"` `"none"` | `"bar"` | Left-edge change marker |
| `longLines` | `"wrap"` `"scroll"` | `"wrap"` | How lines wider than terminal are handled |
| `fileHeader` | `boolean` | `true` | Show filename + stats header |

### Color

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `theme` | `string` | `"default"` | Named preset: `default`, `midnight`, `subtle`, `neon`, `pierre`, `pierre-light` |
| `shikiTheme` | `string` | `"github-dark"` | Shiki syntax theme. Use `"github-light"` with `theme: "pierre-light"` |
| `colors` | `object` | — | Per-color hex overrides (`#RRGGBB`) |

### Layout (advanced)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `splitMinWidth` | `integer` | `150` | Min terminal cols for split view |
| `splitMinCodeWidth` | `integer` | `60` | Min code cols per side in split |
| `maxPreviewLines` | `integer` | `60` | Max lines in edit preview |
| `maxRenderLines` | `integer` | `150` | Max lines in write output |
| `wordDiffMinSimilarity` | `number` | `0.15` | Similarity threshold for word-diff (0–1) |

---

## Best Practice Scenarios

### 1. Minimal (defaults are good)

```json
{
	"$schema": "./pi-diff.schema.json"
}
```

Just ship it. The defaults are tuned for dark terminal backgrounds.

### 2. Clean & minimal UI

```json
{
	"indicatorStyle": "none",
	"lineNumbers": false,
	"fileHeader": false,
	"theme": "subtle"
}
```

Hides everything except the diff content. Great for focus-mode or when you're already seeing the file path from the tool header.

### 3. Classic +/- diff style

```json
{
	"indicatorStyle": "classic",
	"sepStyle": "simple"
}
```

Uses `+`/`-` in the gutter without the `▌` bar. Simple and familiar.

### 4. Maximum information density

```json
{
	"sepStyle": "metadata",
	"indicatorStyle": "bar",
	"lineNumbers": true,
	"fileHeader": true
}
```

Shows full hunk headers (`@@ -1,5 +2,6 @@ funcName`), file headers, and line numbers. Good for code review sessions.

### 5. Light terminal background

```json
{
	"theme": "default",
	"shikiTheme": "github-light",
	"colors": {
		"bgAdd": "#e6ffec",
		"bgDel": "#ffebe9",
		"bgAddHighlight": "#abf2bc",
		"bgDelHighlight": "#ffb7b0",
		"bgGutterAdd": "#e6ffec",
		"bgGutterDel": "#ffebe9",
		"bgEmpty": "#f6f8fa",
		"fgDim": "#6e7681",
		"fgLnum": "#8b949e",
		"fgRule": "#d0d7de",
		"fgStripe": "#d0d7de",
		"fgSafeMuted": "#656d76"
	}
}
```

A light-theme color palette that matches GitHub's light diff style.

### 6. Midnight (pure black terminal)

```json
{
	"theme": "midnight"
}
```

Very subtle backgrounds that look natural on pure black (`#000`) terminals.

### 7. High contrast

```json
{
	"theme": "neon",
	"sepStyle": "metadata"
}
```

More visible diff backgrounds with full hunk metadata.

### 8. Development/Debug mode (scroll, no wrapping)

```json
{
	"longLines": "scroll",
	"lineNumbers": true,
	"indicatorStyle": "bar"
}
```

Lines wider than the terminal are shown as-is (no wrapping). Use your terminal's horizontal scroll. Good for debugging long JSON, log lines, or generated code.

---

## Global Config

Set system-wide defaults for all your projects:

```bash
mkdir -p ~/.pi
cat > ~/.pi/agent/pi-diff.json << 'EOF'
{
	"indicatorStyle": "classic",
	"theme": "midnight"
}
EOF
```

Project-level files in individual repos override the global settings.

---

## Env Var Overrides

Any option can be overridden at runtime with environment variables.
This is useful for one-off sessions or automation:

```bash
# Disable line numbers for a single diff review
PI_DIFF_LINE_NUMBERS=hide pi

# Use scroll mode for a specific session
PI_DIFF_LONG_LINES=scroll pi

# Bright diff backgrounds for demo/presentation
DIFF_BG_ADD="#1a5020" DIFF_BG_DEL="#501a1a" pi
```

> **Convention:** Display options use `PI_DIFF_*` prefix. Color options use `DIFF_*` prefix (legacy).

---

## Full Example

The file `pi-diff.example.json` contains all options with their defaults:

```json
{
	"$schema": "./pi-diff.schema.json",
	"sepStyle": "auto",
	"lineNumbers": true,
	"indicatorStyle": "bar",
	"longLines": "wrap",
	"fileHeader": true,
	"theme": "default",
	"shikiTheme": "github-dark",
	"colors": {
		"bgAdd": "#162620",
		"bgDel": "#2d1919",
		"bgAddHighlight": "#234b32",
		"bgDelHighlight": "#502323",
		"bgGutterAdd": "#12201a",
		"bgGutterDel": "#261616",
		"bgEmpty": "#121212",
		"fgDim": "#505050",
		"fgLnum": "#646464",
		"fgRule": "#323232",
		"fgStripe": "#282828",
		"fgSafeMuted": "#8b949e"
	},
	"splitMinWidth": 150,
	"splitMinCodeWidth": 60,
	"maxPreviewLines": 60,
	"maxRenderLines": 150,
	"wordDiffMinSimilarity": 0.15
}
```

---

## IDE Autocompletion

The `$schema` field in `pi-diff.json` connects to `pi-diff.schema.json` for
autocompletion and validation. Most editors (VS Code, JetBrains, Neovim
with `jsonls`) will suggest valid values as you type.

## Reference

- **Schema:** `pi-diff.schema.json`
- **Example:** `pi-diff.example.json`
- **Source:** `src/core/config.ts`
