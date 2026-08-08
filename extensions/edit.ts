import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	generateDiffString,
	generateUnifiedPatch,
	renderDiff,
	withFileMutationQueue,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, hyperlink, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}


export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

export interface UpdateFileChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

export type Hunk =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };

export function hunkPath(hunk: Hunk): string {
	return hunk.kind === "update" && hunk.movePath !== undefined ? hunk.movePath : hunk.path;
}

export class PatchParseError extends Error {
	constructor(
		readonly kind: "patch" | "hunk",
		message: string,
		readonly lineNumber?: number,
	) {
		super(message);
		this.name = "PatchParseError";
	}
}

function invalidPatch(message: string): PatchParseError {
	return new PatchParseError("patch", message);
}

function invalidHunk(message: string, lineNumber: number): PatchParseError {
	return new PatchParseError("hunk", message, lineNumber);
}

export function formatParseError(error: PatchParseError): string {
	if (error.kind === "patch") return `Invalid patch: ${error.message}`;
	return `Invalid patch hunk on line ${error.lineNumber}: ${error.message}`;
}

function notAValidHunkHeader(trimmed: string, lineNumber: number): PatchParseError {
	return invalidHunk(
		`'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		lineNumber,
	);
}

function unexpectedLineInUpdateHunk(line: string, lineNumber: number): PatchParseError {
	return invalidHunk(
		`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
		lineNumber,
	);
}

function expectedContextMarker(line: string, lineNumber: number): PatchParseError {
	return invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNumber);
}

const RUST_WHITESPACE = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const TRIM_START = new RegExp(`^[${RUST_WHITESPACE}]+`);
const TRIM_END = new RegExp(`[${RUST_WHITESPACE}]+$`);

export function rustTrim(text: string): string {
	return text.replace(TRIM_START, "").replace(TRIM_END, "");
}

export function rustTrimEnd(text: string): string {
	return text.replace(TRIM_END, "");
}

export function rustLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	const endedWithNewline = lines[lines.length - 1] === "";
	if (endedWithNewline) lines.pop();
	return lines.map((line, index) => {
		const splitOnNewline = endedWithNewline || index < lines.length - 1;
		return splitOnNewline && line.endsWith("\r") ? line.slice(0, -1) : line;
	});
}

type ParserMode =
	| { kind: "notStarted" }
	| { kind: "startedPatch" }
	| { kind: "addFile" }
	| { kind: "deleteFile" }
	| { kind: "updateFile"; hunkLineNumber: number }
	| { kind: "endedPatch" };

export class StreamingPatchParser {
	private lineBuffer = "";
	private mode: ParserMode = { kind: "notStarted" };
	private lineNumber = 0;
	private readonly hunks: Hunk[] = [];
	environmentId: string | undefined;

	snapshot(): Hunk[] {
		return this.hunks.map((hunk) =>
			hunk.kind === "update"
				? {
						...hunk,
						chunks: hunk.chunks.map((chunk) => ({
							...chunk,
							oldLines: [...chunk.oldLines],
							newLines: [...chunk.newLines],
						})),
					}
				: { ...hunk },
		);
	}

	pushDelta(delta: string): Hunk[] {
		for (const ch of delta) {
			if (ch === "\n") {
				let line = this.lineBuffer;
				this.lineBuffer = "";
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.lineNumber++;
				this.processLine(line);
			} else {
				this.lineBuffer += ch;
			}
		}
		return this.snapshot();
	}

	finish(): Hunk[] {
		if (this.lineBuffer !== "") {
			const line = this.lineBuffer;
			this.lineBuffer = "";
			this.lineNumber++;
			if (rustTrim(line) === END_PATCH_MARKER) {
				this.ensureUpdateHunkIsNotEmpty(rustTrim(line));
				this.mode = { kind: "endedPatch" };
			} else {
				this.processLine(line);
			}
		}

		if (this.mode.kind !== "endedPatch") {
			throw invalidPatch("The last line of the patch must be '*** End Patch'");
		}
		return this.snapshot();
	}

	private lastHunk(): Hunk | undefined {
		return this.hunks[this.hunks.length - 1];
	}

	private ensureUpdateHunkIsNotEmpty(line: string): void {
		const last = this.lastHunk();
		if (last?.kind !== "update") return;

		if (last.chunks.length === 0 && this.mode.kind === "updateFile") {
			throw invalidHunk(`Update file hunk for path '${last.path}' is empty`, this.mode.hunkLineNumber);
		}

		const lastChunk = last.chunks[last.chunks.length - 1];
		if (lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
			if (line === END_PATCH_MARKER) {
				throw invalidHunk("Update hunk does not contain any lines", this.lineNumber);
			}
			throw unexpectedLineInUpdateHunk(line, this.lineNumber);
		}
	}

	private handleHunkHeadersAndEndPatch(trimmed: string): boolean {
		if (this.mode.kind === "startedPatch" && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
			if (this.environmentId !== undefined) {
				throw invalidPatch("apply_patch environment_id cannot be specified more than once");
			}
			const environmentId = rustTrim(trimmed.slice(ENVIRONMENT_ID_MARKER.length));
			if (environmentId === "") throw invalidPatch("apply_patch environment_id cannot be empty");
			this.environmentId = environmentId;
			return true;
		}

		if (trimmed === END_PATCH_MARKER) {
			this.ensureUpdateHunkIsNotEmpty(trimmed);
			this.mode = { kind: "endedPatch" };
			return true;
		}

		if (trimmed.startsWith(ADD_FILE_MARKER)) {
			this.ensureUpdateHunkIsNotEmpty(trimmed);
			this.hunks.push({ kind: "add", path: trimmed.slice(ADD_FILE_MARKER.length), contents: "" });
			this.mode = { kind: "addFile" };
			return true;
		}

		if (trimmed.startsWith(DELETE_FILE_MARKER)) {
			this.ensureUpdateHunkIsNotEmpty(trimmed);
			this.hunks.push({ kind: "delete", path: trimmed.slice(DELETE_FILE_MARKER.length) });
			this.mode = { kind: "deleteFile" };
			return true;
		}

		if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
			this.ensureUpdateHunkIsNotEmpty(trimmed);
			this.hunks.push({ kind: "update", path: trimmed.slice(UPDATE_FILE_MARKER.length), chunks: [] });
			this.mode = { kind: "updateFile", hunkLineNumber: this.lineNumber };
			return true;
		}

		return false;
	}

	private processLine(line: string): void {
		const trimmed = rustTrim(line);
		switch (this.mode.kind) {
			case "notStarted":
				if (trimmed === BEGIN_PATCH_MARKER) {
					this.mode = { kind: "startedPatch" };
					return;
				}
				throw invalidPatch("The first line of the patch must be '*** Begin Patch'");

			case "startedPatch":
				if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
				throw notAValidHunkHeader(trimmed, this.lineNumber);

			case "addFile": {
				if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
				const last = this.lastHunk();
				if (line.startsWith("+") && last?.kind === "add") {
					last.contents += `${line.slice(1)}\n`;
					return;
				}
				throw notAValidHunkHeader(trimmed, this.lineNumber);
			}

			case "deleteFile":
				if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
				throw notAValidHunkHeader(trimmed, this.lineNumber);

			case "updateFile":
				this.processUpdateFileLine(line);
				return;

			case "endedPatch":
				if (trimmed === "") return;
				throw invalidPatch("The last line of the patch must be '*** End Patch'");
		}
	}

	private processUpdateFileLine(line: string): void {
		const updateLine = rustTrimEnd(line);
		if (this.handleHunkHeadersAndEndPatch(updateLine)) return;

		const last = this.lastHunk();
		if (last?.kind !== "update") throw unexpectedLineInUpdateHunk(line, this.lineNumber);

		const lastChunk = (): UpdateFileChunk | undefined => last.chunks[last.chunks.length - 1];
		const isContextMarker = updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER);
		const lastChunkIsEmpty = (): boolean => {
			const chunk = lastChunk();
			return chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;
		};
		const pushEmptyChunk = (changeContext?: string): UpdateFileChunk => {
			const chunk: UpdateFileChunk = { changeContext, oldLines: [], newLines: [], isEndOfFile: false };
			last.chunks.push(chunk);
			return chunk;
		};
		const chunkForContent = (): UpdateFileChunk => lastChunk() ?? pushEmptyChunk();

		if (lastChunk()?.isEndOfFile) {
			if (updateLine === "") return;
			if (!isContextMarker) throw expectedContextMarker(line, this.lineNumber);
		}

		if (last.chunks.length === 0 && last.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
			last.movePath = updateLine.slice(MOVE_TO_MARKER.length);
			return;
		}

		if (isContextMarker && lastChunkIsEmpty()) throw unexpectedLineInUpdateHunk(line, this.lineNumber);

		if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
			pushEmptyChunk();
			return;
		}

		if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
			pushEmptyChunk(updateLine.slice(CHANGE_CONTEXT_MARKER.length));
			return;
		}

		if (updateLine === EOF_MARKER) {
			if (lastChunkIsEmpty()) throw invalidHunk("Update hunk does not contain any lines", this.lineNumber);
			const chunk = lastChunk();
			if (chunk) chunk.isEndOfFile = true;
			return;
		}

		if (line === "") {
			const chunk = chunkForContent();
			chunk.oldLines.push("");
			chunk.newLines.push("");
			return;
		}

		if (line.startsWith(" ")) {
			const chunk = chunkForContent();
			chunk.oldLines.push(line.slice(1));
			chunk.newLines.push(line.slice(1));
			return;
		}

		if (line.startsWith("+")) {
			chunkForContent().newLines.push(line.slice(1));
			return;
		}

		if (line.startsWith("-")) {
			chunkForContent().oldLines.push(line.slice(1));
			return;
		}

		const chunk = lastChunk();
		if (chunk && (chunk.oldLines.length > 0 || chunk.newLines.length > 0)) {
			throw expectedContextMarker(line, this.lineNumber);
		}
		throw unexpectedLineInUpdateHunk(line, this.lineNumber);
	}
}

function checkPatchBoundariesStrict(lines: string[]): string[] {
	const first = lines.length === 0 ? undefined : rustTrim(lines[0]);
	const last = lines.length === 0 ? undefined : rustTrim(lines[lines.length - 1]);

	if (first !== undefined && last !== undefined && first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) {
		return lines;
	}
	if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
		throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
	}
	throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

const HEREDOC_OPENERS = ["<<EOF", "<<'EOF'", '<<"EOF"'];

function checkPatchBoundariesLenient(lines: string[]): string[] {
	try {
		return checkPatchBoundariesStrict(lines);
	} catch (originalError) {
		if (lines.length >= 2) {
			const first = lines[0];
			const last = lines[lines.length - 1];
			if (HEREDOC_OPENERS.includes(first) && last.endsWith("EOF") && lines.length >= 4) {
				return checkPatchBoundariesStrict(lines.slice(1, -1));
			}
		}
		throw originalError;
	}
}

export interface ParsedPatch {
	hunks: Hunk[];
	patch: string;
	environmentId?: string;
}

export function parsePatch(patch: string): ParsedPatch {
	const lines = rustLines(rustTrim(patch));
	const patchLines = checkPatchBoundariesLenient(lines);
	const joined = patchLines.join("\n");

	const parser = new StreamingPatchParser();
	parser.pushDelta(joined);
	const hunks = parser.finish();
	return { hunks, patch: joined, environmentId: parser.environmentId };
}

export function parsePartialPatch(patch: string): Hunk[] {
	const parser = new StreamingPatchParser();
	try {
		parser.pushDelta(patch);
	} catch {
	}
	return parser.snapshot();
}

const UNICODE_NORMALISATIONS: Array<[RegExp, string]> = [
	[/[‐‑‒–—―−]/g, "-"],
	[/[‘’‚‛]/g, "'"],
	[/[“”„‟]/g, '"'],
	[/[            　]/g, " "],
];

function normalise(text: string): string {
	let result = rustTrim(text);
	for (const [pattern, replacement] of UNICODE_NORMALISATIONS) result = result.replace(pattern, replacement);
	return result;
}

export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;

	const searchStart = eof ? lines.length - pattern.length : start;
	const searchEnd = lines.length - pattern.length;
	const passes: Array<(a: string, b: string) => boolean> = [
		(a, b) => a === b,
		(a, b) => rustTrimEnd(a) === rustTrimEnd(b),
		(a, b) => rustTrim(a) === rustTrim(b),
		(a, b) => normalise(a) === normalise(b),
	];

	for (const equal of passes) {
		for (let i = searchStart; i <= searchEnd; i++) {
			let ok = true;
			for (let j = 0; j < pattern.length; j++) {
				if (!equal(lines[i + j], pattern[j])) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
	}
	return undefined;
}

export class ComputeReplacementsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComputeReplacementsError";
	}
}

type Replacement = { startIndex: number; oldLength: number; newLines: string[] };

export function splitFileLines(contents: string): string[] {
	const lines = contents.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function computeReplacements(originalLines: string[], path: string, chunks: UpdateFileChunk[]): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const index = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (index === undefined) {
				throw new ComputeReplacementsError(`Failed to find context '${chunk.changeContext}' in ${path}`);
			}
			lineIndex = index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push({ startIndex: insertionIndex, oldLength: 0, newLines: [...chunk.newLines] });
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === undefined) {
			throw new ComputeReplacementsError(
				`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
			);
		}

		replacements.push({ startIndex: found, oldLength: pattern.length, newLines: [...newSlice] });
		lineIndex = found + pattern.length;
	}

	return replacements
		.map((replacement, order) => ({ replacement, order }))
		.sort((a, b) => a.replacement.startIndex - b.replacement.startIndex || a.order - b.order)
		.map(({ replacement }) => replacement);
}

export function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
	let result = lines;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { startIndex, oldLength, newLines } = replacements[i];
		const removed = Math.min(oldLength, Math.max(0, result.length - startIndex));
		result = result.slice(0, startIndex).concat(newLines, result.slice(startIndex + removed));
	}
	return result === lines ? [...lines] : result;
}

export function deriveNewContents(path: string, originalContents: string, chunks: UpdateFileChunk[]): string {
	const originalLines = splitFileLines(originalContents);
	const newLines = applyReplacements(originalLines, computeReplacements(originalLines, path, chunks));
	if (newLines[newLines.length - 1] !== "") newLines.push("");
	return newLines.join("\n");
}

export interface AffectedPaths {
	added: string[];
	modified: string[];
	deleted: string[];
}

export function printSummary(affected: AffectedPaths): string {
	const lines = ["Success. Updated the following files:"];
	for (const path of affected.added) lines.push(`A ${path}`);
	for (const path of affected.modified) lines.push(`M ${path}`);
	for (const path of affected.deleted) lines.push(`D ${path}`);
	return lines.map((line) => `${line}\n`).join("");
}


export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const TOOL_DESCRIPTION = `The \`apply_patch\` tool can be used to edit files. Pass the whole patch envelope as the \`input\` string.

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
 name = "world"
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

- Paths are relative, never absolute.
- Every added line is prefixed with \`+\`, including under \`*** Add File:\`.
- Give an update hunk 3 lines of unchanged context above and below each change, without repeating context shared with an adjacent change. Where 3 lines do not locate the snippet uniquely, head the hunk with \`@@ <enclosing class or function>\`, repeating \`@@\` lines to nest.`;

export const TOOL_PROMPT_SNIPPET = "Edit files with an apply_patch envelope (*** Begin Patch ... *** End Patch).";

export const TOOL_PROMPT_GUIDELINES = [
	"Use edit for local file edits. Do not create or edit files with `cat`, `sed`, or other shell write tricks.",
	"Do not use edit for changes that are auto-generated (running a formatter, regenerating a lockfile) or when scripting is more efficient, such as search-and-replacing a string across a codebase.",
	"Do not re-read a file after edit to check the result; the tool call fails if the patch did not apply.",
];

export const EDIT_SCHEMA = Type.Object(
	{
		input: Type.String({ description: "The apply_patch envelope, from '*** Begin Patch' to '*** End Patch'." }),
	},
	{ additionalProperties: false },
);

export type EditParams = Static<typeof EDIT_SCHEMA>;

export function prepareEditArguments(args: unknown): EditParams {
	if (typeof args === "string") return { input: args };
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		const input = (args as Record<string, unknown>).input;
		if (typeof input === "string") return { input };
	}
	return args as EditParams;
}

interface EditDetailsLike {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

export interface EditDetails extends EditDetailsLike {
	summary: string;
	files: Array<{
		path: string;
		kind: PlannedFileChange["kind"];
		details: EditDetailsLike;
	}>;
}

export type PlannedFileChange = {
	kind: "add" | "update" | "delete";
	path: string;
	absolutePath: string;
	movePath?: string;
	oldText: string;
	newText: string;
};

export type ParsedPlan = { changes: PlannedFileChange[] };

export type Preview = { diff: string; files: string[]; firstChangedLine?: number } | { error: string };

export function resolveToCwd(cwd: string, path: string): string {
	return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

export function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths));
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function readFileText(absolutePath: string): Promise<string> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(absolutePath);
	} catch (err) {
		throw new Error(formatIoError(err));
	}
	if (!stats.isFile()) throw new Error(`path \`${absolutePath}\` is not a file`);

	const buffer = await readFile(absolutePath);
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	} catch {
		throw new Error(utf8ErrorMessage(buffer) ?? "invalid utf-8");
	}
}

function utf8ErrorMessage(bytes: Uint8Array): string | undefined {
	const invalid = (index: number, length: number) => `invalid utf-8 sequence of ${length} bytes from index ${index}`;
	const incomplete = (index: number) => `incomplete utf-8 byte sequence from index ${index}`;

	let i = 0;
	while (i < bytes.length) {
		const first = bytes[i];
		if (first < 0x80) {
			i++;
			continue;
		}

		const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
		if (width === 0) return invalid(i, 1);

		const lower = first === 0xe0 ? 0xa0 : first === 0xf0 ? 0x90 : 0x80;
		const upper = first === 0xed ? 0x9f : first === 0xf4 ? 0x8f : 0xbf;

		if (i + 1 >= bytes.length) return incomplete(i);
		if (bytes[i + 1] < lower || bytes[i + 1] > upper) return invalid(i, 1);

		for (let offset = 2; offset < width; offset++) {
			if (i + offset >= bytes.length) return incomplete(i);
			if (bytes[i + offset] < 0x80 || bytes[i + offset] > 0xbf) return invalid(i, offset);
		}
		i += width;
	}
	return undefined;
}

async function writeFileWithMissingParentRetry(absolutePath: string, contents: string): Promise<void> {
	try {
		await writeFile(absolutePath, contents, "utf-8");
		return;
	} catch (err) {
		if (errorCode(err) !== "ENOENT") throw new Error(`Failed to write file ${absolutePath}`);
	}
	try {
		await mkdir(dirname(absolutePath), { recursive: true });
	} catch {
		throw new Error(`Failed to create parent directories for ${absolutePath}`);
	}
	try {
		await writeFile(absolutePath, contents, "utf-8");
	} catch {
		throw new Error(`Failed to write file ${absolutePath}`);
	}
}

async function ensureNotDirectory(absolutePath: string, context: string): Promise<void> {
	let isDirectory: boolean;
	try {
		isDirectory = (await stat(absolutePath)).isDirectory();
	} catch {
		throw new Error(context);
	}
	if (isDirectory) throw new Error(context);
}

function detailsForChange(path: string, oldText: string, newText: string): EditDetailsLike {
	const { diff, firstChangedLine } = generateDiffString(oldText, newText);
	return { diff, patch: generateUnifiedPatch(path, oldText, newText), firstChangedLine };
}

async function verifyHunks(hunks: Hunk[], cwd: string): Promise<ParsedPlan> {
	const changes = new Map<string, PlannedFileChange>();

	for (const hunk of hunks) {
		const absolutePath = resolveToCwd(cwd, hunk.path);
		if (hunk.kind === "add") {
			changes.set(absolutePath, { kind: "add", path: hunk.path, absolutePath, oldText: "", newText: hunk.contents });
			continue;
		}
		if (hunk.kind === "delete") {
			let contents: string;
			try {
				contents = await readFileText(absolutePath);
			} catch (err) {
				throw new Error(`Failed to read ${absolutePath}: ${formatIoError(err)}`);
			}
			changes.set(absolutePath, { kind: "delete", path: hunk.path, absolutePath, oldText: contents, newText: "" });
			continue;
		}

		const original = await readFileToUpdate(absolutePath);
		changes.set(absolutePath, {
			kind: "update",
			path: hunk.path,
			absolutePath,
			movePath: hunk.movePath,
			oldText: original,
			newText: deriveNewContents(absolutePath, original, hunk.chunks),
		});
	}

	return { changes: Array.from(changes.values()) };
}

const OS_ERROR_DESCRIPTIONS: Record<string, string> = {
	EACCES: "Permission denied",
	EEXIST: "File exists",
	EISDIR: "Is a directory",
	ELOOP: "Too many levels of symbolic links",
	EMFILE: "Too many open files",
	ENAMETOOLONG: "File name too long",
	ENOENT: "No such file or directory",
	ENOSPC: "No space left on device",
	ENOTDIR: "Not a directory",
	EPERM: "Operation not permitted",
	EROFS: "Read-only file system",
};

function formatIoError(err: unknown): string {
	const code = errorCode(err);
	const errno = (err as NodeJS.ErrnoException | undefined)?.errno;
	const description = code ? OS_ERROR_DESCRIPTIONS[code] : undefined;
	if (description !== undefined && typeof errno === "number") {
		return `${description} (os error ${Math.abs(errno)})`;
	}
	return errorText(err);
}

async function readFileToUpdate(absolutePath: string): Promise<string> {
	try {
		return await readFileText(absolutePath);
	} catch (err) {
		throw new Error(`Failed to read file to update ${absolutePath}: ${formatIoError(err)}`);
	}
}

export async function buildPreviewPlan(text: string, cwd: string, argsComplete: boolean): Promise<ParsedPlan> {
	const hunks = argsComplete ? parsePatchOrThrow(text) : parsePartialPatch(text);
	return verifyHunks(hunks, cwd);
}

function parsePatchOrThrow(text: string): Hunk[] {
	try {
		return parsePatch(text).hunks;
	} catch (err) {
		if (err instanceof PatchParseError) throw new Error(formatParseError(err));
		throw err;
	}
}

export function previewForPlan(plan: ParsedPlan): Preview {
	const details = combineDetails(
		plan.changes.map((change) => ({
			path: displayPath(change),
			kind: change.kind,
			details: detailsForChange(displayPath(change), change.oldText, change.newText),
		})),
	);
	return {
		diff: details.diff,
		files: uniquePaths(plan.changes.map((change) => displayPath(change))),
		firstChangedLine: details.firstChangedLine,
	};
}

function displayPath(change: PlannedFileChange): string {
	return change.movePath ?? change.path;
}

export async function applyPatchText(text: string, cwd: string, signal?: AbortSignal): Promise<EditDetails> {
	const hunks = parsePatchOrThrow(text);
	if (hunks.length === 0) throw new Error("No files were modified.");

	const affected: AffectedPaths = { added: [], modified: [], deleted: [] };
	const files: EditDetails["files"] = [];

	for (const hunk of hunks) {
		throwIfAborted(signal);
		const affectedPath = hunkPath(hunk);
		const absolutePath = resolveToCwd(cwd, hunk.path);

		if (hunk.kind === "add") {
			await withFileMutationQueue(absolutePath, () => writeFileWithMissingParentRetry(absolutePath, hunk.contents));
			files.push({ path: affectedPath, kind: "add", details: detailsForChange(affectedPath, "", hunk.contents) });
			affected.added.push(affectedPath);
			continue;
		}

		if (hunk.kind === "delete") {
			const oldText = await withFileMutationQueue(absolutePath, async () => {
				const contents = await readFileText(absolutePath).catch(() => "");
				await ensureNotDirectory(absolutePath, `Failed to delete file ${absolutePath}`);
				try {
					await unlink(absolutePath);
				} catch {
					throw new Error(`Failed to delete file ${absolutePath}`);
				}
				return contents;
			});
			files.push({ path: affectedPath, kind: "delete", details: detailsForChange(affectedPath, oldText, "") });
			affected.deleted.push(affectedPath);
			continue;
		}

		const details = await applyUpdateHunk(hunk, absolutePath, cwd, signal);
		files.push({ path: affectedPath, kind: "update", details });
		affected.modified.push(affectedPath);
	}

	return { ...combineDetails(files), summary: printSummary(affected) };
}

async function applyUpdateHunk(
	hunk: Extract<Hunk, { kind: "update" }>,
	absolutePath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<EditDetailsLike> {
	return withFileMutationQueue(absolutePath, async () => {
		const original = await readFileToUpdate(absolutePath);
		throwIfAborted(signal);
		const newContents = deriveNewContents(absolutePath, original, hunk.chunks);

		if (hunk.movePath === undefined) {
			try {
				await writeFile(absolutePath, newContents, "utf-8");
			} catch {
				throw new Error(`Failed to write file ${absolutePath}`);
			}
			return detailsForChange(hunk.path, original, newContents);
		}

		const destination = resolveToCwd(cwd, hunk.movePath);
		await writeFileWithMissingParentRetry(destination, newContents);
		await ensureNotDirectory(absolutePath, `Failed to remove original ${absolutePath}`);
		try {
			await unlink(absolutePath);
		} catch {
			throw new Error(`Failed to remove original ${absolutePath}`);
		}
		return detailsForChange(hunk.movePath, original, newContents);
	});
}

function combineDetails(files: EditDetails["files"]): Omit<EditDetails, "summary"> {
	const diff =
		files.length === 1
			? files[0].details.diff
			: files.map((file) => `File: ${file.path}\n${file.details.diff}`).join("\n\n");
	const patch = files.map((file) => file.details.patch).join("\n");
	const firstChangedLine = files.find((file) => file.details.firstChangedLine !== undefined)?.details.firstChangedLine;
	return { diff, patch, firstChangedLine, files };
}

export function formatSummary(details: EditDetails): string {
	return details.summary;
}

const HEADER_PREFIXES = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "];

export function renderablePathsIn(text: string | undefined): string[] | undefined {
	if (!text) return undefined;

	const paths: string[] = [];
	try {
		for (const hunk of parsePartialPatch(text)) paths.push(hunkPath(hunk));
	} catch {
	}
	if (paths.length === 0) {
		for (const raw of text.split("\n")) {
			const line = raw.trimEnd();
			for (const prefix of HEADER_PREFIXES) {
				if (line.startsWith(prefix)) paths.push(line.slice(prefix.length));
			}
		}
	}

	const unique = uniquePaths(paths.filter((path) => path !== ""));
	return unique.length > 0 ? unique : undefined;
}

type EditCallComponent = Box & {
	preview?: Preview;
	previewArgsKey?: string;
	previewBuiltKey?: string;
	previewBuiltFromCompleteArgs?: boolean;
	previewPending?: boolean;
	previewPendingArgsKey?: string;
	previewSuppressedArgsKey?: string;
	settledError?: boolean;
};

type EditRenderState = {
	planKey?: string;
	preview?: Preview;
	pending?: boolean;
	callComponent?: EditCallComponent;
};

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	return hyperlink(styledText, pathToFileURL(resolveToCwd(cwd, rawPath)).href);
}

function renderToolPath(rawPath: string | null, theme: Theme, cwd: string, options?: { emptyFallback?: string }): string {
	if (rawPath === null) return theme.fg("error", "[invalid arg]");
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

function uniquePathsForCwd(paths: string[], cwd: string): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		let key = path;
		try {
			key = resolveToCwd(cwd, path);
		} catch {
		}
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(path);
	}
	return unique;
}

function renderPathLabel(paths: string[] | undefined, theme: Theme, cwd: string): string {
	const unique = paths ? uniquePathsForCwd(paths, cwd) : undefined;
	if (!unique || unique.length === 0) return renderToolPath("", theme, cwd);
	if (unique.length === 1) return renderToolPath(str(unique[0]), theme, cwd);
	return theme.fg("accent", `${unique.length} files`);
}

function formatEditCall(text: string | undefined, preview: Preview | undefined, theme: Theme, cwd: string): string {
	const title = theme.fg("toolTitle", theme.bold("edit"));
	const paths = preview && !("error" in preview) ? preview.files : renderablePathsIn(text);
	return `${title} ${renderPathLabel(paths, theme, cwd)}`;
}

function createEditCallComponent(): EditCallComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as Preview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewBuiltKey: undefined as string | undefined,
		previewBuiltFromCompleteArgs: false,
		previewPending: false,
		previewPendingArgsKey: undefined as string | undefined,
		previewSuppressedArgsKey: undefined as string | undefined,
		settledError: false,
	});
}

function getEditCallComponent(
	state: EditRenderState,
	lastComponent: unknown,
): EditCallComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) return state.callComponent;
	const component = createEditCallComponent();
	state.callComponent = component;
	return component;
}

function getHeaderBg(
	preview: Preview | undefined,
	previewIsStale: boolean,
	settledError: boolean | undefined,
	argsComplete: boolean,
	theme: Theme,
): (text: string) => string {
	if (argsComplete && preview && !previewIsStale) {
		if ("error" in preview) return (text: string) => theme.bg("toolErrorBg", text);
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolPendingBg", text);
}

function setPreview(
	component: EditCallComponent,
	preview: Preview,
	argsKey: string | undefined,
	argsComplete = true,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff ||
				current.firstChangedLine !== preview.firstChangedLine ||
				current.files.join("\0") !== preview.files.join("\0")));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewBuiltKey = argsKey;
	component.previewBuiltFromCompleteArgs = argsComplete;
	component.previewPending = false;
	component.previewPendingArgsKey = undefined;
	component.previewSuppressedArgsKey = undefined;
	return changed;
}

function requestPreview(
	component: EditCallComponent,
	text: string | undefined,
	argsKey: string | undefined,
	cwd: string,
	argsComplete: boolean,
	invalidate: () => void,
): void {
	const previewIsCurrent = component.preview !== undefined && component.previewBuiltKey === argsKey;
	const hasUsablePreview = previewIsCurrent && (!argsComplete || component.previewBuiltFromCompleteArgs);
	if (!text || !argsKey || hasUsablePreview || component.previewPendingArgsKey === argsKey) return;
	if (!argsComplete && component.previewSuppressedArgsKey === argsKey) return;

	component.previewPending = true;
	component.previewPendingArgsKey = argsKey;
	const requestKey = argsKey;
	void buildPreviewPlan(text, cwd, argsComplete)
		.then((plan): Preview => previewForPlan(plan))
		.catch((err): Preview | undefined => {
			if (!argsComplete) return undefined;
			return { error: errorText(err) };
		})
		.then((preview) => {
			if (component.previewArgsKey !== requestKey) return;
			component.previewPending = false;
			component.previewPendingArgsKey = undefined;
			if (preview) {
				setPreview(component, preview, requestKey, argsComplete);
			} else {
				component.previewSuppressedArgsKey = requestKey;
			}
			invalidate();
		});
}

const STREAMING_PREVIEW_MAX_DIFF_LINES = 20;

function renderPreviewDiff(diff: string, argsComplete: boolean, theme: Theme): string {
	if (argsComplete) return renderDiff(diff);
	const lines = diff.split("\n");
	if (lines.length <= STREAMING_PREVIEW_MAX_DIFF_LINES + 4) return renderDiff(diff);
	const rendered = renderDiff(lines.slice(0, STREAMING_PREVIEW_MAX_DIFF_LINES).join("\n"));
	const hidden = lines.length - STREAMING_PREVIEW_MAX_DIFF_LINES;
	return `${rendered}\n${theme.fg("toolOutput", `… +${hidden} more diff lines`)}`;
}

function buildEditCallComponent(
	component: EditCallComponent,
	text: string | undefined,
	theme: Theme,
	cwd: string,
	argsComplete = true,
): EditCallComponent {
	const previewIsStale = component.preview !== undefined && component.previewBuiltKey !== component.previewArgsKey;
	component.setBgFn(getHeaderBg(component.preview, previewIsStale, component.settledError, argsComplete, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(text, component.preview, theme, cwd), 0, 0));

	if (!component.preview) return component;
	if ("error" in component.preview) {
		if (previewIsStale) return component;
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("error", component.preview.error), 0, 0));
		return component;
	}

	component.addChild(new Spacer(1));
	component.addChild(new Text(renderPreviewDiff(component.preview.diff, argsComplete, theme), 0, 0));
	return component;
}

function formatEditResult(
	preview: Preview | undefined,
	result: AgentToolResult<EditDetails>,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		if (!errorText || errorText === previewError) return undefined;
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) return renderDiff(resultDiff);
	return undefined;
}

export default function editExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof EDIT_SCHEMA, EditDetails, EditRenderState>({
		name: "edit",
		label: "edit",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: TOOL_PROMPT_GUIDELINES,
		parameters: EDIT_SCHEMA,
		constrainedSampling: { type: "grammar", variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR } },
		renderShell: "self",
		prepareArguments: prepareEditArguments,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await applyPatchText(params.input, ctx.cwd, signal);
			return { content: [{ type: "text" as const, text: formatSummary(details) }], details };
		},

		renderCall(args, theme, context) {
			const component = getEditCallComponent(context.state, context.lastComponent);
			const prepared = prepareEditArguments(args);
			const text = prepared && typeof prepared.input === "string" ? prepared.input : undefined;
			const key = text === undefined ? undefined : `${context.cwd}\0${text}`;
			if (component.previewArgsKey !== key) {
				component.previewArgsKey = key;
				component.previewPending = false;
				component.previewPendingArgsKey = undefined;
				component.previewSuppressedArgsKey = undefined;
				component.settledError = false;
			}

			requestPreview(component, text, key, context.cwd, context.argsComplete, () => context.invalidate());

			return buildEditCallComponent(component, text, theme, context.cwd, context.argsComplete);
		},

		renderResult(result, _options, theme, context) {
			const component = context.state.callComponent;
			const prepared = prepareEditArguments(context.args);
			const text = prepared && typeof prepared.input === "string" ? prepared.input : undefined;
			const key = text === undefined ? undefined : `${context.cwd}\0${text}`;
			let changed = false;

			if (component) {
				if (!context.isError && result.details?.diff) {
					changed =
						setPreview(
							component,
							{
								diff: result.details.diff,
								files: uniquePaths(result.details.files.map((file) => file.path)),
								firstChangedLine: result.details.firstChangedLine,
							},
							key,
						) || changed;
				}
				if (component.settledError !== context.isError) {
					component.settledError = context.isError;
					changed = true;
				}
				if (changed) buildEditCallComponent(component, text, theme, context.cwd);
			}

			const output = formatEditResult(component?.preview, result, theme, context.isError);
			const resultComponent = (context.lastComponent as Container | undefined) ?? new Container();
			resultComponent.clear();
			if (!output) return resultComponent;
			resultComponent.addChild(new Spacer(1));
			resultComponent.addChild(new Text(output, 1, 0));
			return resultComponent;
		},
	});
}
