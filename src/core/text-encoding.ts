/**
 * BOM and line-ending preservation helpers for text-file mutations.
 */

export type LineEnding = "\r\n" | "\n" | "\r";

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export function detectLineEnding(content: string): LineEnding {
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return content.includes("\r") ? "\r" : "\n";
	return content[lfIdx - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Normalize line separators without rewriting lone CR characters in text. */
export function normalizeForLineEnding(text: string, ending: LineEnding): string {
	return ending === "\r" ? text.replace(/\r/g, "\n") : text.replace(/\r\n/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
	if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
	if (ending === "\r") return text.replace(/\n/g, "\r");
	return text;
}

/** Strip BOM and normalize newlines for hashline matching; keep metadata for write-back. */
export function prepareTextForHashlineEdit(rawUtf8: string): {
	bom: string;
	ending: LineEnding;
	normalized: string;
} {
	const { bom, text } = stripBom(rawUtf8);
	const ending = detectLineEnding(text);
	const normalized = normalizeToLF(text);
	return { bom, ending, normalized };
}

export function finalizeHashlineWriteContent(bom: string, ending: LineEnding, lfContent: string): string {
	return bom + restoreLineEndings(lfContent, ending);
}
