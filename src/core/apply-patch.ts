/**
 * apply_patch — Multi-file patch engine.
 *
 * One call can add, update, delete, or move multiple files.
 * Updates use a conservative matcher and are committed only after every
 * change has been prepared successfully.
 */

import { isUtf8 } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatch } from "diff";
import { countPatchOccurrences, findPatchReplacement } from "./replace.js";
import { detectLineEnding, normalizeForLineEnding, restoreLineEndings, stripBom } from "./text-encoding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyPatchEdit {
	oldText: string;
	newText: string;
}

export interface ApplyPatchChange {
	/** Path to the file, relative to the patch workspace or absolute within it. */
	path: string;
	action: "add" | "update" | "delete" | "move";
	/** Content for new files (action=add). */
	content?: string;
	/** Text to find for updates (action=update). */
	oldText?: string;
	/** Replacement text for updates (action=update). */
	newText?: string;
	/** Multiple disjoint replacements for one update target. */
	edits?: ApplyPatchEdit[];
	/** Destination path for moves (action=move). */
	movePath?: string;
}

export interface ApplyPatchOptions {
	/** Base directory for relative paths. Defaults to the process cwd. */
	cwd?: string;
	/** Workspace boundary. Defaults to cwd. */
	root?: string;
}

export interface ApplyPatchResult {
	ok: boolean;
	applied: AppliedChange[];
	errors: ApplyPatchError[];
}

export interface AppliedChange {
	path: string;
	action: ApplyPatchChange["action"];
	bytes?: number;
	diff?: string;
	movePath?: string;
	oldContent?: string;
	newContent?: string;
}

export interface ApplyPatchError {
	path: string;
	action: string;
	error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, context: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${context}.${field} must be a non-empty string`);
	return value;
}

function requiredText(value: unknown, field: string, context: string): string {
	if (typeof value !== "string") throw new Error(`${context}.${field} must be a string`);
	return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) throw new Error(`${context}.${key} is not supported`);
	}
}

function parseUpdateEdits(value: unknown, context: string): ApplyPatchEdit[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`${context}.edits must contain at least one replacement`);
	return value.map((entry, index) => {
		const editContext = `${context}.edits[${index}]`;
		if (!isRecord(entry)) throw new Error(`${editContext} must be an object`);
		rejectUnknownKeys(entry, ["oldText", "newText"], editContext);
		return {
			oldText: requiredString(entry.oldText, "oldText", editContext),
			newText: requiredText(entry.newText, "newText", editContext),
		};
	});
}

function tryParseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (trimmed === "") return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/** Tolerate common model serialization shapes before strict validation. */
function normalizeApplyPatchInput(input: unknown): unknown {
	const parsed = tryParseJson(input);
	if (!isRecord(parsed)) return parsed;

	const record: Record<string, unknown> =
		!("changes" in parsed) && typeof parsed.path === "string" && typeof parsed.action === "string"
			? { changes: [parsed] }
			: parsed;

	const changes = tryParseJson(record.changes);
	if (!Array.isArray(changes)) return record;

	return {
		...record,
		changes: changes.map((entry) => {
			if (!isRecord(entry)) return entry;
			const edits = tryParseJson(entry.edits);
			if (Array.isArray(edits)) return { ...entry, edits };
			if (isRecord(edits) && typeof edits.oldText === "string") return { ...entry, edits: [edits] };
			return entry;
		}),
	};
}

/** Decode the model-facing tool payload before it reaches the mutation core. */
export function parseApplyPatchInput(rawInput: unknown): ApplyPatchChange[] {
	const input = normalizeApplyPatchInput(rawInput);
	if (!isRecord(input)) throw new Error("apply_patch input must be an object");
	rejectUnknownKeys(input, ["changes"], "apply_patch");
	if (!Array.isArray(input.changes) || input.changes.length === 0) {
		throw new Error("apply_patch.changes must contain at least one change");
	}

	return input.changes.map((entry, index) => {
		const context = `apply_patch.changes[${index}]`;
		if (!isRecord(entry)) throw new Error(`${context} must be an object`);
		const pathValue = requiredString(entry.path, "path", context);
		const action = requiredString(entry.action, "action", context);
		switch (action) {
			case "add":
				rejectUnknownKeys(entry, ["path", "action", "content"], context);
				return { path: pathValue, action, content: requiredText(entry.content, "content", context) };
			case "update": {
				rejectUnknownKeys(entry, ["path", "action", "oldText", "newText", "edits"], context);
				if (entry.edits !== undefined) {
					if (entry.oldText !== undefined || entry.newText !== undefined) {
						throw new Error(`${context} cannot combine edits with oldText/newText`);
					}
					return { path: pathValue, action, edits: parseUpdateEdits(entry.edits, context) };
				}
				return {
					path: pathValue,
					action,
					oldText: requiredString(entry.oldText, "oldText", context),
					newText: entry.newText === undefined ? undefined : requiredText(entry.newText, "newText", context),
				};
			}
			case "delete":
				rejectUnknownKeys(entry, ["path", "action"], context);
				return { path: pathValue, action };
			case "move":
				rejectUnknownKeys(entry, ["path", "action", "movePath"], context);
				return { path: pathValue, action, movePath: requiredString(entry.movePath, "movePath", context) };
			default:
				throw new Error(`${context}.action must be add, update, delete, or move`);
		}
	});
}

interface FileSnapshot {
	bytes: Buffer;
	rawContent: string;
	mode: number;
	dev: number;
	ino: number;
	mtimeMs: number;
	size: number;
}

interface ResolvedChange {
	change: ApplyPatchChange;
	path: string;
	movePath?: string;
}

interface PreparedChange {
	change: ApplyPatchChange;
	applied: AppliedChange;
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

interface PathPolicy {
	resolve(filePath: unknown, label: string): Promise<string>;
}

interface PathLock {
	key: string;
	previous: Promise<void>;
	queued: Promise<void>;
	release: () => void;
}

const pathLocks = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Path and filesystem safety
// ---------------------------------------------------------------------------

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function formatFilesystemError(error: unknown): string {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
		return `${code}${error.message}`;
	}
	return String(error);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertSafeAncestors(filePath: string, root: string, label: string): Promise<void> {
	const relative = path.relative(root, filePath);
	if (!isWithin(root, filePath)) throw new Error(`${label} must stay within workspace root: ${filePath}`);
	if (relative === "") return;

	let current = root;
	const segments = relative.split(path.sep).filter(Boolean);
	for (let index = 0; index < segments.length; index++) {
		current = path.join(current, segments[index]);
		let stats: fs.Stats;
		try {
			stats = await fs.promises.lstat(current);
		} catch (error) {
			if (isMissingPathError(error)) return;
			throw new Error(`${label} could not be inspected: ${formatFilesystemError(error)}`);
		}
		if (stats.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link: ${filePath}`);
		if (index < segments.length - 1 && !stats.isDirectory()) {
			throw new Error(`${label} parent must be a directory: ${filePath}`);
		}
	}
}

async function createPathPolicy(options: ApplyPatchOptions): Promise<PathPolicy> {
	const root = path.resolve(options.root ?? options.cwd ?? process.cwd());
	const cwd = path.resolve(options.cwd ?? root);
	try {
		const rootStats = await fs.promises.stat(root);
		const cwdStats = await fs.promises.stat(cwd);
		if (!rootStats.isDirectory()) throw new Error(`${root} is not a directory`);
		if (!cwdStats.isDirectory()) throw new Error(`${cwd} is not a directory`);
	} catch (error) {
		throw new Error(`workspace could not be resolved: ${formatFilesystemError(error)}`);
	}
	if (!isWithin(root, cwd)) throw new Error(`cwd must stay within workspace root: ${cwd}`);

	return {
		async resolve(filePath: unknown, label: string): Promise<string> {
			if (typeof filePath !== "string" || filePath.length === 0) throw new Error(`${label} path is required`);
			const resolved = path.resolve(cwd, filePath);
			if (!isWithin(root, resolved)) throw new Error(`${label} must stay within workspace root: ${filePath}`);
			await assertSafeAncestors(resolved, root, label);
			return resolved;
		},
	};
}

async function lstatIfExists(filePath: string): Promise<fs.Stats | undefined> {
	try {
		return await fs.promises.lstat(filePath);
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

async function readRegularFile(filePath: string, label: string): Promise<FileSnapshot> {
	const initialStats = await lstatIfExists(filePath);
	if (!initialStats) throw new Error(`${label} not found: ${filePath}`);
	if (initialStats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filePath}`);
	if (!initialStats.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);

	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
		const bytes = await handle.readFile();
		if (!isUtf8(bytes)) throw new Error(`${label} must contain valid UTF-8 text: ${filePath}`);
		const rawContent = bytes.toString("utf8");
		return {
			bytes,
			rawContent,
			mode: stats.mode & 0o7777,
			dev: stats.dev,
			ino: stats.ino,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
		};
	} catch (error) {
		if (error instanceof Error && error.message.includes("valid UTF-8")) throw error;
		throw new Error(`${label} could not be read: ${formatFilesystemError(error)}`);
	} finally {
		await handle?.close();
	}
}

async function assertUnchanged(filePath: string, original: FileSnapshot, label: string): Promise<void> {
	const current = await readRegularFile(filePath, label);
	if (
		current.dev !== original.dev ||
		current.ino !== original.ino ||
		current.size !== original.size ||
		current.mtimeMs !== original.mtimeMs ||
		!current.bytes.equals(original.bytes)
	) {
		throw new Error(`${label} changed while patch was being prepared: ${filePath}`);
	}
}

async function createParentDirectories(directory: string): Promise<string[]> {
	const missing: string[] = [];
	let current = directory;
	while (true) {
		const stats = await lstatIfExists(current);
		if (stats) {
			if (!stats.isDirectory()) throw new Error(`parent path is not a directory: ${current}`);
			break;
		}
		missing.push(current);
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`could not find a directory for: ${directory}`);
		current = parent;
	}
	try {
		await fs.promises.mkdir(directory, { recursive: true });
	} catch (error) {
		await removeCreatedDirectories(missing).catch(() => undefined);
		throw error;
	}
	return missing;
}

async function removeCreatedDirectories(directories: string[]): Promise<void> {
	for (const directory of directories) {
		try {
			await fs.promises.rmdir(directory);
		} catch (error) {
			if (
				isMissingPathError(error) ||
				(typeof error === "object" && error !== null && "code" in error && error.code === "ENOTEMPTY")
			) {
				continue;
			}
			throw error;
		}
	}
}

async function atomicWriteFile(
	filePath: string,
	content: string | Uint8Array,
	mode?: number,
	replace = true,
): Promise<void> {
	const directory = path.dirname(filePath);
	const temporaryDirectory = await fs.promises.mkdtemp(path.join(directory, `.pi-apply-patch-${process.pid}-`));
	const temporaryPath = path.join(temporaryDirectory, "content");
	const desiredMode = mode ?? 0o666 & ~process.umask();
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(content);
		await handle.chmod(desiredMode);
		await handle.sync();
		await handle.close();
		handle = undefined;

		if (replace) {
			await fs.promises.rename(temporaryPath, filePath);
		} else {
			await fs.promises.link(temporaryPath, filePath);
			await fs.promises.unlink(temporaryPath);
		}
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function withPathLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
	const locks: PathLock[] = [];
	for (const key of [...new Set(keys)].sort()) {
		const previous = pathLocks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => gate);
		pathLocks.set(key, queued);
		locks.push({ key, previous, queued, release });
	}

	await Promise.all(locks.map((lock) => lock.previous));
	try {
		return await operation();
	} finally {
		for (const lock of locks) lock.release();
		for (const lock of locks) {
			if (pathLocks.get(lock.key) === lock.queued) pathLocks.delete(lock.key);
		}
	}
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

async function prepareAdd(resolved: ResolvedChange): Promise<PreparedChange> {
	const { change, path: targetPath } = resolved;
	if (await lstatIfExists(targetPath)) throw new Error(`add target already exists: ${change.path}`);
	const content = change.content ?? "";
	const final = content.endsWith("\n") ? content : `${content}\n`;
	let createdDirectories: string[] = [];

	return {
		change,
		applied: { path: change.path, action: "add", bytes: Buffer.byteLength(final, "utf8"), newContent: final },
		async commit() {
			createdDirectories = await createParentDirectories(path.dirname(targetPath));
			try {
				if (await lstatIfExists(targetPath)) throw new Error(`add target appeared during patch: ${change.path}`);
				await atomicWriteFile(targetPath, final, undefined, false);
			} catch (error) {
				await removeCreatedDirectories(createdDirectories).catch(() => undefined);
				throw error;
			}
		},
		async rollback() {
			await fs.promises.unlink(targetPath);
			await removeCreatedDirectories(createdDirectories);
		},
	};
}

function getUpdateEdits(change: ApplyPatchChange): ApplyPatchEdit[] {
	if (change.edits !== undefined) {
		if (change.oldText !== undefined || change.newText !== undefined) {
			throw new Error("update cannot combine edits with oldText/newText");
		}
		if (!Array.isArray(change.edits) || change.edits.length === 0) throw new Error("update requires edits");
		return change.edits;
	}
	if (typeof change.oldText !== "string" || change.oldText.length === 0) throw new Error("update requires oldText");
	return [{ oldText: change.oldText, newText: change.newText ?? "" }];
}

/** Explain a failed match so the model can self-correct. */
function patchFailureMessage(content: string, oldText: string, filePath: string): string {
	const occurrences = countPatchOccurrences(content, oldText);
	if (occurrences > 1) {
		return `oldText matches ${occurrences} times in ${filePath}; add surrounding context to make it unique`;
	}
	return `oldText not found in ${filePath}`;
}

function applyUpdateEdits(content: string, edits: ApplyPatchEdit[], filePath: string): string {
	const replacements = edits.map((edit, index) => {
		if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			throw new Error(`edit ${index + 1} in ${filePath} is invalid`);
		}
		if (edit.oldText.length === 0) throw new Error(`edit ${index + 1} in ${filePath} requires oldText`);
		if (edit.oldText === edit.newText) throw new Error("oldText and newText are identical — no change");
		const match = findPatchReplacement(content, edit.oldText, edit.newText);
		if (!match) throw new Error(patchFailureMessage(content, edit.oldText, filePath));
		return match;
	});

	const ordered = [...replacements].sort((a, b) => a.start - b.start);
	for (let index = 1; index < ordered.length; index++) {
		if (ordered[index - 1].end > ordered[index].start) throw new Error(`update edits overlap in ${filePath}`);
	}

	let result = content;
	for (const replacement of [...ordered].reverse()) {
		result = result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end);
	}
	return result;
}

async function prepareUpdate(resolved: ResolvedChange): Promise<PreparedChange> {
	const { change, path: targetPath } = resolved;
	const original = await readRegularFile(targetPath, "update target");
	const { bom, text } = stripBom(original.rawContent);
	const ending = detectLineEnding(text);
	const normalizedContent = normalizeForLineEnding(text, ending);
	const normalizedEdits = getUpdateEdits(change).map((edit) => ({
		oldText: normalizeForLineEnding(edit.oldText, ending),
		newText: normalizeForLineEnding(edit.newText, ending),
	}));
	const normalizedNewContent = applyUpdateEdits(normalizedContent, normalizedEdits, change.path);
	const newContent = bom + restoreLineEndings(normalizedNewContent, ending);

	return {
		change,
		applied: {
			path: change.path,
			action: "update",
			diff: generateDiff(change.path, original.rawContent, newContent),
			bytes: Buffer.byteLength(newContent, "utf8"),
			oldContent: original.rawContent,
			newContent,
		},
		async commit() {
			await assertUnchanged(targetPath, original, "update target");
			await atomicWriteFile(targetPath, Buffer.from(newContent, "utf8"), original.mode);
		},
		async rollback() {
			await atomicWriteFile(targetPath, original.bytes, original.mode);
		},
	};
}

async function prepareDelete(resolved: ResolvedChange): Promise<PreparedChange> {
	const { change, path: targetPath } = resolved;
	const original = await readRegularFile(targetPath, "delete target");
	return {
		change,
		applied: { path: change.path, action: "delete", oldContent: original.rawContent },
		async commit() {
			await assertUnchanged(targetPath, original, "delete target");
			await fs.promises.unlink(targetPath);
		},
		async rollback() {
			await atomicWriteFile(targetPath, original.bytes, original.mode, false);
		},
	};
}

async function prepareMove(resolved: ResolvedChange): Promise<PreparedChange> {
	const { change, path: sourcePath, movePath: destinationPath } = resolved;
	if (!destinationPath) throw new Error("move requires movePath");
	const original = await readRegularFile(sourcePath, "move source");
	if (await lstatIfExists(destinationPath)) throw new Error(`move destination already exists: ${change.movePath}`);
	let createdDirectories: string[] = [];

	return {
		change,
		applied: { path: change.path, action: "move", movePath: change.movePath },
		async commit() {
			await assertUnchanged(sourcePath, original, "move source");
			if (await lstatIfExists(destinationPath))
				throw new Error(`move destination appeared during patch: ${change.movePath}`);
			createdDirectories = await createParentDirectories(path.dirname(destinationPath));
			try {
				await fs.promises.rename(sourcePath, destinationPath);
			} catch (error) {
				await removeCreatedDirectories(createdDirectories).catch(() => undefined);
				throw error;
			}
		},
		async rollback() {
			await fs.promises.rename(destinationPath, sourcePath);
			await removeCreatedDirectories(createdDirectories);
		},
	};
}

async function prepareChange(resolved: ResolvedChange): Promise<PreparedChange> {
	switch (resolved.change.action) {
		case "add":
			return prepareAdd(resolved);
		case "update":
			return prepareUpdate(resolved);
		case "delete":
			return prepareDelete(resolved);
		case "move":
			return prepareMove(resolved);
		default:
			throw new Error(`unknown action: ${(resolved.change as { action: string }).action}`);
	}
}

// ---------------------------------------------------------------------------
// Diff generation (for result/UI feedback)
// ---------------------------------------------------------------------------

function generateDiff(filePath: string, oldContent: string, newContent: string): string | undefined {
	if (oldContent === newContent) return undefined;
	const patch = structuredPatch(filePath, filePath, oldContent, newContent, "", "", { context: 3 });
	const lines: string[] = [];
	for (const hunk of patch.hunks) {
		const oldRange = `${hunk.oldStart},${hunk.oldLines}`;
		const newRange = `${hunk.newStart},${hunk.newLines}`;
		lines.push(`@@ -${oldRange} +${newRange} @@`);
		lines.push(...hunk.lines);
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : undefined;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function executeApplyPatch(
	changes: ApplyPatchChange[],
	options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
	if (!Array.isArray(changes) || changes.length === 0) {
		return {
			ok: false,
			applied: [],
			errors: [{ path: "", action: "patch", error: "patch must contain at least one change" }],
		};
	}

	let policy: PathPolicy;
	try {
		policy = await createPathPolicy(options);
	} catch (error) {
		return {
			ok: false,
			applied: [],
			errors: [{ path: "", action: "patch", error: formatFilesystemError(error) }],
		};
	}

	const resolved: ResolvedChange[] = [];
	const errors: ApplyPatchError[] = [];
	const claimedPaths = new Set<string>();

	for (const change of changes) {
		let sourcePath: string;
		let destinationPath: string | undefined;
		try {
			sourcePath = await policy.resolve(change?.path, `${change?.action ?? "change"} target`);
			if (change?.action === "move") {
				destinationPath = await policy.resolve(change.movePath, "move destination");
			}
		} catch (error) {
			errors.push({
				path: typeof change?.path === "string" ? change.path : "",
				action: typeof change?.action === "string" ? change.action : "change",
				error: formatFilesystemError(error),
			});
			continue;
		}

		const paths = [sourcePath, ...(destinationPath ? [destinationPath] : [])];
		if (paths.some((filePath) => claimedPaths.has(filePath))) {
			errors.push({
				path: change.path,
				action: change.action,
				error: "each source and destination path may appear only once per patch",
			});
			continue;
		}
		for (const filePath of paths) claimedPaths.add(filePath);
		resolved.push({ change, path: sourcePath, movePath: destinationPath });
	}

	if (errors.length > 0) return { ok: false, applied: [], errors };

	const lockPaths = resolved.flatMap(({ path: sourcePath, movePath: destinationPath }) => {
		const paths = [sourcePath, ...(destinationPath ? [destinationPath] : [])];
		return [...paths, ...paths.map((filePath) => path.dirname(filePath))];
	});

	return withPathLocks(lockPaths, async () => {
		const prepared: PreparedChange[] = [];
		for (const change of resolved) {
			try {
				prepared.push(await prepareChange(change));
			} catch (error) {
				errors.push({
					path: change.change.path,
					action: change.change.action,
					error: formatFilesystemError(error),
				});
			}
		}

		if (errors.length > 0) return { ok: false, applied: [], errors };

		const committed: PreparedChange[] = [];
		try {
			for (const change of prepared) {
				await change.commit();
				committed.push(change);
			}
		} catch (error) {
			for (const change of committed.reverse()) {
				try {
					await change.rollback();
				} catch (rollbackError) {
					errors.push({
						path: change.change.path,
						action: change.change.action,
						error: `rollback failed: ${formatFilesystemError(rollbackError)}`,
					});
				}
			}
			errors.unshift({
				path: prepared[committed.length]?.change.path ?? "",
				action: prepared[committed.length]?.change.action ?? "commit",
				error: formatFilesystemError(error),
			});
			return { ok: false, applied: [], errors };
		}

		return { ok: true, applied: prepared.map((change) => change.applied), errors: [] };
	});
}

// ---------------------------------------------------------------------------
// Format result for tool output
// ---------------------------------------------------------------------------

export function formatApplyPatchResult(result: ApplyPatchResult): string {
	const lines: string[] = [];

	if (result.applied.length > 0) {
		lines.push(`Applied ${result.applied.length} change(s):`);
		for (const change of result.applied) {
			const rel = change.path;
			switch (change.action) {
				case "add":
					lines.push(`  A ${rel}`);
					break;
				case "update":
					lines.push(`  M ${rel}`);
					break;
				case "delete":
					lines.push(`  D ${rel}`);
					break;
				case "move":
					lines.push(`  M ${rel} -> ${change.movePath}`);
					break;
			}
		}
	}

	if (result.errors.length > 0) {
		lines.push(`\nFailed ${result.errors.length} change(s):`);
		for (const err of result.errors) {
			lines.push(`  [${err.action}] ${err.path}: ${err.error}`);
		}
	}

	return lines.join("\n");
}
