// Startup context and the token budgeting around it, ported from Codex
// core/src/realtime_context.rs. Pi's on-disk session store stands in for
// codex's thread-store metadata.

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { messageText } from "../lib/util.ts";

const APPROX_BYTES_PER_TOKEN = 4;

function approxTokenCount(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN);
}

// Middle-out truncation ported from codex-rs utils/string/src/truncate.rs:
// keep the head and tail, replace the middle with an approximate-token marker.
function truncateMiddleToTokens(text: string, maxTokens: number): string {
	if (!text) return "";
	const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (maxTokens > 0 && totalBytes <= maxBytes) return text;
	const marker = (removedBytes: number) =>
		`…${Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN)} tokens truncated…`;
	if (maxBytes === 0) return marker(totalBytes);
	const chars = Array.from(text);
	const sizes = chars.map((ch) => Buffer.byteLength(ch, "utf8"));
	const leftBudget = Math.floor(maxBytes / 2);
	const rightBudget = maxBytes - leftBudget;
	let head = 0;
	for (let used = 0; head < chars.length && used + sizes[head]! <= leftBudget; head++) used += sizes[head]!;
	let tail = chars.length;
	for (let used = 0; tail > head && used + sizes[tail - 1]! <= rightBudget; tail--) used += sizes[tail - 1]!;
	return chars.slice(0, head).join("") + marker(totalBytes - maxBytes) + chars.slice(tail).join("");
}

// Port of core/src/realtime_context.rs truncate_realtime_text_to_token_budget:
// the marker is added after choosing preserved content, so tighten the content
// budget until the rendered text itself fits the cap.
export function truncateToTokens(text: string, budgetTokens: number): string {
	let truncationBudget = budgetTokens;
	for (;;) {
		const candidate = truncateMiddleToTokens(text, truncationBudget);
		const candidateTokens = approxTokenCount(candidate);
		if (candidateTokens <= budgetTokens) return candidate;
		const next = truncationBudget - Math.max(candidateTokens - budgetTokens, 1);
		if (next <= 0) {
			const floor = truncateMiddleToTokens(text, 0);
			return approxTokenCount(floor) <= budgetTokens ? floor : "";
		}
		truncationBudget = next;
	}
}

export function userFirstName(): string {
	try {
		const full = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 1000 }).trim();
		if (full) return full.split(/\s+/)[0]!;
	} catch {}
	return userInfo().username || "there";
}

const STARTUP_CONTEXT_HEADER =
	"Startup context from Pi.\nThis is background context about recent work and machine/workspace layout. It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.";
const CURRENT_THREAD_SECTION_TOKEN_BUDGET = 1200;
const RECENT_WORK_SECTION_TOKEN_BUDGET = 2200;
const WORKSPACE_SECTION_TOKEN_BUDGET = 1600;
const NOTES_SECTION_TOKEN_BUDGET = 300;
const REALTIME_TURN_TOKEN_BUDGET = 300;
const MAX_RECENT_THREADS = 40;
const MAX_RECENT_WORK_GROUPS = 8;
const MAX_CURRENT_CWD_ASKS = 8;
const MAX_OTHER_CWD_ASKS = 5;
const MAX_ASK_CHARS = 240;
// The session header and first user ask sit at the top of a session file.
const SESSION_HEAD_BYTES = 64 * 1024;
const TREE_MAX_DEPTH = 2;
const DIR_ENTRY_LIMIT = 20;
const NOISY_DIR_NAMES = new Set([
	".git", ".next", ".pytest_cache", ".ruff_cache", "__pycache__",
	"build", "dist", "node_modules", "out", "target",
]);

function collectTreeLines(dir: string, depth: number, lines: string[]): void {
	if (depth >= TREE_MAX_DEPTH) return;
	let entries: { name: string; isDir: boolean }[];
	try {
		entries = readdirSync(dir)
			.filter((name) => !name.startsWith(".") && !NOISY_DIR_NAMES.has(name))
			.map((name) => {
				let isDir = false;
				try {
					isDir = statSync(join(dir, name)).isDirectory();
				} catch {}
				return { name, isDir };
			});
	} catch {
		return;
	}
	// Directories first, then lexicographic, as upstream read_sorted_entries does.
	entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const indent = "  ".repeat(depth);
	for (const entry of entries.slice(0, DIR_ENTRY_LIMIT)) {
		lines.push(`${indent}- ${entry.name}${entry.isDir ? "/" : ""}`);
		if (entry.isDir) collectTreeLines(join(dir, entry.name), depth + 1, lines);
	}
	if (entries.length > DIR_ENTRY_LIMIT) {
		lines.push(`${indent}- ... ${entries.length - DIR_ENTRY_LIMIT} more entries`);
	}
}

function renderTree(root: string): string[] | undefined {
	try {
		if (!statSync(root).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const lines: string[] = [];
	collectTreeLines(root, 0, lines);
	return lines.length ? lines : undefined;
}

function gitRoot(cwd: string): string | undefined {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

function baseName(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function buildWorkspaceSection(cwd: string): string | undefined {
	const root = gitRoot(cwd);
	const userRoot = homedir();
	const cwdTree = renderTree(cwd);
	const gitRootTree = root && root !== cwd ? renderTree(root) : undefined;
	const userRootTree = userRoot !== cwd && userRoot !== root ? renderTree(userRoot) : undefined;
	if (!cwdTree && !root && !userRootTree) return undefined;

	const lines = [`Current working directory: ${cwd}`, `Working directory name: ${baseName(cwd)}`];
	if (root) {
		lines.push(`Git root: ${root}`);
		lines.push(`Git project: ${baseName(root)}`);
	}
	lines.push(`User root: ${userRoot}`);
	if (cwdTree) lines.push("", "Working directory tree:", ...cwdTree);
	if (gitRootTree) lines.push("", "Git root tree:", ...gitRootTree);
	if (userRootTree) lines.push("", "User root tree:", ...userRootTree);
	return lines.join("\n");
}

// --- Recent Work (upstream build_recent_work_section) ---

type SessionSummary = { cwd: string; mtimeMs: number; ask?: string };

/** Session cwd and first user ask, read from the head of a session jsonl. */
function readSessionSummary(path: string, mtimeMs: number): SessionSummary | undefined {
	let head = "";
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
			head = buffer.toString("utf8", 0, readSync(fd, buffer, 0, SESSION_HEAD_BYTES, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
	let cwd: string | undefined;
	let ask: string | undefined;
	for (const line of head.split("\n")) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // the final line is usually cut mid-record by the head read
		}
		if (!cwd && entry?.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
		if (entry?.type === "message" && entry.message?.role === "user") {
			// Upstream collapses the first user message to single-spaced words.
			ask = messageText(entry.message).split(/\s+/).filter(Boolean).join(" ");
			break;
		}
	}
	if (!cwd) return undefined;
	return { cwd, mtimeMs, ask: ask || undefined };
}

/** Every session jsonl under the agent's sessions dir, newest first. */
function listSessionFiles(): { path: string; mtimeMs: number }[] | undefined {
	let sessionsDir: string;
	let dirs: string[];
	try {
		sessionsDir = join(getAgentDir(), "sessions");
		dirs = readdirSync(sessionsDir);
	} catch {
		return undefined;
	}
	const files: { path: string; mtimeMs: number }[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(join(sessionsDir, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(sessionsDir, dir, name);
			try {
				files.push({ path, mtimeMs: statSync(path).mtimeMs });
			} catch {}
		}
	}
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function clipAsk(ask: string): string {
	const chars = Array.from(ask);
	return chars.length > MAX_ASK_CHARS ? `${chars.slice(0, MAX_ASK_CHARS - 3).join("")}...` : ask;
}

function buildRecentWorkSection(cwd: string): string | undefined {
	const files = listSessionFiles();
	if (!files) return undefined;

	// Group by git project root, falling back to the session cwd (upstream's
	// resolve_root_git_project_for_trust grouping).
	type Group = { root: string; isGit: boolean; entries: SessionSummary[] };
	const groups = new Map<string, Group>();
	const rootCache = new Map<string, { root: string; isGit: boolean }>();
	for (const file of files.slice(0, MAX_RECENT_THREADS)) {
		const summary = readSessionSummary(file.path, file.mtimeMs);
		if (!summary) continue;
		let resolved = rootCache.get(summary.cwd);
		if (!resolved) {
			const root = gitRoot(summary.cwd);
			resolved = root ? { root, isGit: true } : { root: summary.cwd, isGit: false };
			rootCache.set(summary.cwd, resolved);
		}
		let group = groups.get(resolved.root);
		if (!group) {
			group = { root: resolved.root, isGit: resolved.isGit, entries: [] };
			groups.set(resolved.root, group);
		}
		// Files arrive mtime-descending, so entries[0] stays the latest.
		group.entries.push(summary);
	}
	if (!groups.size) return undefined;

	const currentRoot = gitRoot(cwd) ?? cwd;
	// Current project first, then latest activity, then path (upstream order).
	const ordered = [...groups.values()].sort(
		(a, b) =>
			Number(b.root === currentRoot) - Number(a.root === currentRoot) ||
			b.entries[0]!.mtimeMs - a.entries[0]!.mtimeMs ||
			(a.root < b.root ? -1 : a.root > b.root ? 1 : 0),
	);

	const sections: string[] = [];
	for (const group of ordered.slice(0, MAX_RECENT_WORK_GROUPS)) {
		const latest = group.entries[0]!;
		const lines = [
			`### ${group.isGit ? "Git repo" : "Directory"}: ${group.root}`,
			`Recent sessions: ${group.entries.length}`,
			`Latest activity: ${new Date(latest.mtimeMs).toISOString()}`,
			"",
			"User asks:",
		];
		const seen = new Set<string>();
		const maxAsks = group.root === currentRoot ? MAX_CURRENT_CWD_ASKS : MAX_OTHER_CWD_ASKS;
		for (const entry of group.entries) {
			if (!entry.ask) continue;
			const key = `${entry.cwd}:${entry.ask}`;
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(`- ${entry.cwd}: ${clipAsk(entry.ask)}`);
			if (seen.size === maxAsks) break;
		}
		// Upstream keeps a group only when it contributed at least one ask.
		if (seen.size) sections.push(lines.join("\n"));
	}
	return sections.length ? sections.join("\n\n") : undefined;
}

function buildCurrentThreadSection(ctx: ExtensionContext): string | undefined {
	type Turn = { user: string[]; assistant: string[] };
	const turns: Turn[] = [];
	let current: Turn = { user: [], assistant: [] };
	try {
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry?.type !== "message") continue;
			const role = entry.message?.role;
			const text = messageText(entry.message).trim();
			if (!text) continue;
			if (role === "user") {
				if (current.user.length || current.assistant.length) {
					turns.push(current);
					current = { user: [], assistant: [] };
				}
				current.user.push(text);
			} else if (role === "assistant") {
				// Upstream drops assistant text that precedes any user message.
				if (!current.user.length && !current.assistant.length) continue;
				current.assistant.push(text);
			}
		}
	} catch {
		return undefined;
	}
	if (current.user.length || current.assistant.length) turns.push(current);
	if (!turns.length) return undefined;

	const lines = [
		"Most recent user/assistant turns from this exact thread. Use them for continuity when responding.",
	];
	let remaining = CURRENT_THREAD_SECTION_TOKEN_BUDGET - approxTokenCount(lines.join("\n"));
	let retained = 0;
	turns.reverse();
	for (const [index, turn] of turns.entries()) {
		if (remaining <= 0) break;
		const turnLines = [index === 0 ? "### Latest turn" : `### Previous turn ${index}`];
		if (turn.user.length) turnLines.push("User:", turn.user.join("\n\n"));
		if (turn.assistant.length) turnLines.push("", "Assistant:", turn.assistant.join("\n\n"));
		const text = truncateToTokens(turnLines.join("\n"), Math.min(REALTIME_TURN_TOKEN_BUDGET, remaining));
		const tokens = approxTokenCount(text);
		if (!tokens) continue;
		lines.push("", text);
		remaining -= tokens;
		retained += 1;
	}
	return retained ? lines.join("\n") : undefined;
}

function formatSection(title: string, body: string | undefined, budgetTokens: number): string | undefined {
	const trimmed = body?.trim();
	if (!trimmed) return undefined;
	const heading = `## ${title}\n`;
	const bodyBudget = budgetTokens - approxTokenCount(heading);
	if (bodyBudget <= 0) return undefined;
	const rendered = truncateToTokens(trimmed, bodyBudget);
	return rendered ? `${heading}${rendered}` : undefined;
}

export function buildStartupContext(ctx: ExtensionContext): string {
	const thread = formatSection("Current Thread", buildCurrentThreadSection(ctx), CURRENT_THREAD_SECTION_TOKEN_BUDGET);
	const recentWork = formatSection("Recent Work", buildRecentWorkSection(ctx.cwd), RECENT_WORK_SECTION_TOKEN_BUDGET);
	const workspace = formatSection(
		"Machine / Workspace Map",
		buildWorkspaceSection(ctx.cwd),
		WORKSPACE_SECTION_TOKEN_BUDGET,
	);
	if (!thread && !recentWork && !workspace) return "";
	const notes = formatSection(
		"Notes",
		"Built at realtime startup from the current thread history, local thread metadata, and a bounded local workspace scan. This excludes repo memory instructions, AGENTS files, project-doc prompt blends, and memory summaries.",
		NOTES_SECTION_TOKEN_BUDGET,
	);
	const parts = [STARTUP_CONTEXT_HEADER, thread, recentWork, workspace, notes].filter(
		(part): part is string => part !== undefined,
	);
	return `<startup_context>\n${parts.join("\n\n")}\n</startup_context>`;
}
