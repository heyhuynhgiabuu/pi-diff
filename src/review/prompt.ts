import type { ReviewDiff } from "./git.js";
import { getSubmittableComments, type ReviewDiffSession } from "./session.js";

export function buildReviewDiffPrompt(diff: ReviewDiff, session: ReviewDiffSession): string {
	const comments = getSubmittableComments(session);
	const mode = diff.mode.type === "branch" ? `${diff.mode.base}...HEAD` : "working tree";
	const lines: string[] = [];

	lines.push("Apply the following code review feedback to the current repository changes.");
	lines.push("Treat these comments as explicit requested fixes from the reviewer.");
	lines.push("");
	lines.push(`Review mode: ${mode}`);
	lines.push(`Changed files: ${diff.files.length}`);
	lines.push(`Comments to address: ${comments.length}`);
	lines.push("");
	lines.push("Requirements:");
	lines.push("- Make the smallest changes needed to address each approved comment.");
	lines.push("- Preserve unrelated work already present in the diff.");
	lines.push("- If any comment is invalid or blocked, explain why instead of forcing a change.");
	lines.push("- After editing, summarize which comments were addressed and which were blocked.");
	lines.push("");
	lines.push("Comments:");
	lines.push("");

	for (const [index, comment] of comments.entries()) {
		const exactLine = comment.newNum ?? comment.oldNum ?? comment.line;
		const anchor = comment.previewLineId ? ` [anchor ${comment.previewLineId}]` : "";
		const location = `${comment.file}${exactLine ? `:${exactLine}` : ""}${comment.hunkId ? ` (${comment.hunkId})` : ""}${anchor}`;
		lines.push(`${index + 1}. ${location}`);
		lines.push(`   ${comment.body}`);
		if (comment.status === "edited" && comment.originalBody && comment.originalBody !== comment.body) {
			lines.push(`   Original draft: ${comment.originalBody}`);
		}
		lines.push("");
	}

	if (diff.files.length > 0) {
		lines.push("Current changed files:");
		for (const file of diff.files) {
			lines.push(`- ${file.path} (${file.status}, ${file.hunks.length} hunks)`);
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}
