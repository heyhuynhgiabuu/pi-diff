import { extname } from "node:path";

import { codeToANSI } from "@shikijs/cli";
import type { BundledLanguage, BundledTheme } from "shiki";

import type { ReviewViewportLine } from "./model.js";

export interface ReviewFilePreviewInput {
	filePath: string;
	lines: ReviewViewportLine[];
	theme?: any;
	width: number;
}

const THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";
const MAX_HL_CHARS = 80_000;
const CACHE_LIMIT = 192;
const BG_ADD = "\x1b[48;2;22;38;32m";
const BG_DEL = "\x1b[48;2;45;25;25m";
const BG_CTX = "\x1b[49m";
const RST = "\x1b[0m";

// Binary file extensions — never try to Shiki-render these as code.
const BINARY_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"ico",
	"bmp",
	"tiff",
	"tif",
	"pdf",
	"zip",
	"tar",
	"gz",
	"bz2",
	"xz",
	"7z",
	"rar",
	"bin",
	"exe",
	"dll",
	"so",
	"dylib",
	"o",
	"a",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"mp3",
	"mp4",
	"avi",
	"mov",
	"mkv",
	"flac",
	"wav",
	"ogg",
	"aac",
	"db",
	"sqlite",
	"sqlite3",
]);

function isBinaryPath(filePath: string): boolean {
	const ext = extname(filePath).slice(1).toLowerCase();
	return BINARY_EXTS.has(ext);
}

// Return a raw background ANSI escape. Pi theme.bg(token, text) wraps text and is
// not a raw escape provider; calling it as bg(token) can throw and blank the
// preview. Use getBgAnsi() when available, otherwise fall back to a stable RGB.
function bgAnsi(theme: any, token: string, fallback: string): string {
	if (typeof theme?.getBgAnsi !== "function") return fallback;
	try {
		const bg = (theme.getBgAnsi as (t: string) => string | undefined)(token);
		return bg || fallback;
	} catch {
		return fallback;
	}
}
const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
};

const cache = new Map<string, string[]>();
codeToANSI("", "typescript", THEME).catch(() => {});

export async function renderReviewFilePreview(input: ReviewFilePreviewInput): Promise<string[]> {
	// Binary files must not be Shiki-rendered: their bytes, when decoded as UTF-8, can
	// produce wide Unicode characters whose display width exceeds our column budget and
	// crashes Pi TUI's renderer.
	if (isBinaryPath(input.filePath)) {
		return input.lines.map((line) => {
			if (line.kind === "hunk-header") {
				return styleLine(input.theme?.fg?.("muted", line.content) ?? line.content, input.width);
			}
			const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
			const signColor =
				line.kind === "add" ? "toolDiffAdded" : line.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
			const number = line.kind === "del" ? line.oldNum : line.newNum;
			const bodyBg =
				line.kind === "add"
					? bgAnsi(input.theme, "toolDiffAdded", BG_ADD)
					: line.kind === "del"
						? bgAnsi(input.theme, "toolDiffRemoved", BG_DEL)
						: BG_CTX;
			const gutter = `  ${fg(input.theme, signColor, String(number ?? "").padStart(4, " "))} ${fg(input.theme, signColor, sign)} `;
			return styleLine(`${gutter}${bodyBg}${fg(input.theme, signColor, "(binary)")}${RST}`, input.width);
		});
	}

	const language = lang(input.filePath);
	const diffLines = input.lines.filter((line) => line.kind !== "hunk-header");
	const highlights = await hlBlock(diffLines.map((line) => line.content).join("\n"), language);
	let highlightIndex = 0;
	return input.lines.map((line) => {
		if (line.kind === "hunk-header") {
			return styleLine(input.theme?.fg?.("muted", line.content) ?? line.content, input.width);
		}
		const highlighted = highlights[highlightIndex++] ?? line.content;
		const marker = " ";
		const commentMarker =
			line.commentCount > 0
				? fg(input.theme, "warning", `●${line.commentCount > 1 ? Math.min(line.commentCount, 9) : ""}`)
				: " ";
		const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
		const signColor =
			line.kind === "add" ? "toolDiffAdded" : line.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
		const number = line.kind === "del" ? line.oldNum : line.newNum;
		// Use the theme's background color for add/del lines so the background adapts to
		// the active Pi theme instead of using hard-coded RGB that can clash with syntax
		// highlighting token colors. Falls back to a dark RGB constant when the theme
		// does not expose a bg() / getBgAnsi() method.
		const bodyBg =
			line.kind === "add"
				? bgAnsi(input.theme, "toolDiffAdded", BG_ADD)
				: line.kind === "del"
					? bgAnsi(input.theme, "toolDiffRemoved", BG_DEL)
					: BG_CTX;
		const gutter = `${marker}${commentMarker} ${fg(input.theme, signColor, String(number ?? "").padStart(4, " "))} ${fg(input.theme, signColor, sign)} `;
		return styleLine(`${gutter}${bodyBg}${highlighted}${RST}`, input.width);
	});
}

function fg(theme: any, token: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(token, text) : text;
}

function styleLine(text: string, width: number): string {
	const stripped = stripAnsi(text);
	if (stripped.length <= width) return text;
	return truncateAnsi(text, width);
}

// biome-ignore lint/complexity/useRegexLiterals: constructor form avoids the control-character lint on ESC.
const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function truncateAnsi(text: string, width: number): string {
	let visible = 0;
	let index = 0;
	while (index < text.length && visible < width) {
		if (text[index] === "\u001b") {
			const end = text.indexOf("m", index);
			if (end !== -1) {
				index = end + 1;
				continue;
			}
		}
		visible += 1;
		index += 1;
	}
	return `${text.slice(0, index)}${RST}`;
}

function lang(filePath: string): BundledLanguage | undefined {
	return EXT_LANG[extname(filePath).slice(1).toLowerCase()];
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
	const key = `${THEME}\0${language}\0${code}`;
	const hit = cache.get(key);
	if (hit) return touch(key, hit);
	try {
		const ansi = await codeToANSI(code, language, THEME);
		const output = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return touch(key, output);
	} catch {
		return code.split("\n");
	}
}

function touch(key: string, value: string[]): string[] {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > CACHE_LIMIT) {
		const first = cache.keys().next().value;
		if (first === undefined) break;
		cache.delete(first);
	}
	return value;
}
