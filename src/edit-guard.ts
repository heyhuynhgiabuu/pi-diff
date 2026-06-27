// SPDX-License-Identifier: MIT
// Block edit tool calls when oldText is not present in the target file.
// Forces the model to re-read the file before editing instead of guessing stale
// oldText and getting caught in repeated retry loops.

import { readFileSync } from "node:fs";
import type { EditToolCallEvent, ExtensionHandler, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const guardEditToolCall: ExtensionHandler<EditToolCallEvent, ToolCallEventResult> = async (event, _ctx) => {
	const { path, edits } = event.input;
	if (!edits || !Array.isArray(edits)) return;
	let fileContent: string;
	try {
		fileContent = readFileSync(path, "utf8");
	} catch {
		return;
	}
	for (const edit of edits) {
		if (!fileContent.includes(edit.oldText)) {
			return {
				block: true,
				reason: `oldText not found in ${path}. Re-read the file and copy the exact text (edit protocol: VERIFY before EDIT).`,
			};
		}
	}
};

export function registerEditGuard(pi: unknown): void {
	if (pi == null) return;
	const on = (pi as { on?: unknown }).on;
	if (typeof on !== "function") return;
	(pi as { on: (event: string, handler: typeof guardEditToolCall) => void }).on("tool_call", guardEditToolCall);
}
