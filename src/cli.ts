#!/usr/bin/env node

import { formatReviewMarkdown } from "./review/export.js";
import { type ReviewDiffMode, readGitDiff } from "./review/git.js";

interface CliOptions {
	mode: ReviewDiffMode;
	includeRawDiff: boolean;
	maxLinesPerHunk?: number;
}

function main(argv: string[]): void {
	const options = parseArgs(argv);
	const diff = readGitDiff(process.cwd(), options.mode);
	process.stdout.write(
		formatReviewMarkdown(diff, {
			includeRawDiff: options.includeRawDiff,
			maxLinesPerHunk: options.maxLinesPerHunk,
		}),
	);
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { mode: { type: "working-tree" }, includeRawDiff: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--base") {
			const base = argv[++index];
			if (!base) throw new Error("--base requires a branch name");
			options.mode = { type: "branch", base };
			continue;
		}
		if (arg === "--raw") {
			options.includeRawDiff = true;
			continue;
		}
		if (arg === "--max-lines-per-hunk") {
			const value = Number(argv[++index]);
			if (!Number.isInteger(value) || value <= 0) throw new Error("--max-lines-per-hunk requires a positive integer");
			options.maxLinesPerHunk = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function printHelp(): void {
	process.stdout.write(
		`pi-diff-review\n\nExport current Git changes as agent-ready code review context.\n\nUsage:\n  pi-diff-review [--base <branch>] [--raw] [--max-lines-per-hunk <n>]\n\nOptions:\n  --base <branch>          Compare <branch>...HEAD instead of working tree changes.\n  --raw                    Include the raw git diff at the end.\n  --max-lines-per-hunk <n> Limit emitted lines per hunk (default: 80).\n`,
	);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`pi-diff-review: ${message}\n`);
	process.exitCode = 1;
}
