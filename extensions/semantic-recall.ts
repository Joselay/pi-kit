// /recall - semantic search over past pi sessions via text-embedding-3-large.
//
// Embeddings are the one api.openai.com surface the ChatGPT OAuth subscription
// token is scoped for (POST /v1/embeddings returns 200), so this indexes the
// user/assistant messages of every session under ~/.pi/agent/sessions and
// searches them by meaning, not keywords.
//
//   /recall <query>       search past sessions and post the top matches
//   /recall reindex       force a full rebuild of the index
//   /recall large|small   switch embedding tier (persisted; small = mini model)
//
// The index lives at ~/.pi/agent/recall-index.json (vectors stored as base64
// Float32Array at 512 dimensions to keep it small) and refreshes incrementally
// by file mtime on each search. The embedding tier (text-embedding-3-large by
// default, text-embedding-3-small as the mini) is a persisted, in-product
// choice — no env var required. OAuth only — no API-key fallback.

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const EMBEDDINGS_URL =
	process.env.PI_RECALL_ENDPOINT?.trim() || "https://api.openai.com/v1/embeddings";

const CONFIG_PATH = join(getAgentDir(), "recall-config.json");
/**
 * Embedding tier is a first-class, persisted choice (not just an env var) so the
 * mini model is discoverable via `/recall small`:
 *   - large: text-embedding-3-large (best quality; default)
 *   - small: text-embedding-3-small (cheaper/faster indexing)
 * Both support 512-dim shortened vectors. PI_RECALL_MODEL still overrides for
 * power users. Switching tiers changes the stored index.model, so the next
 * search transparently rebuilds the index.
 */
const MODEL_TIERS: Record<string, string> = {
	large: "text-embedding-3-large",
	small: "text-embedding-3-small",
};
const DEFAULT_MODEL = MODEL_TIERS.large!;
/** text-embedding-3 supports shortened vectors; 512 dims keeps the index small. */
const DIMENSIONS = 512;

function readModel(): string {
	const override = process.env.PI_RECALL_MODEL?.trim();
	if (override) return override;
	try {
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { model?: string };
		if (typeof cfg.model === "string" && cfg.model) return cfg.model;
	} catch {}
	return DEFAULT_MODEL;
}

function writeModel(model: string): void {
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify({ model }, null, 2), { mode: 0o600 });
	renameSync(temporaryPath, CONFIG_PATH);
}

let activeModel = readModel();

const SESSIONS_DIR = join(getAgentDir(), "sessions");
const INDEX_PATH = join(getAgentDir(), "recall-index.json");
const INDEX_VERSION = 1;

const MIN_CHUNK_CHARS = 40;
const MAX_CHUNK_CHARS = 2000;
const MAX_CHUNKS_PER_FILE = 300;
const EMBED_BATCH_SIZE = 100;
const TOP_K = 8;

interface Chunk {
	/** message role ("user" | "assistant") */
	r: string;
	/** chunk text (truncated to MAX_CHUNK_CHARS) */
	t: string;
	/** base64-encoded Float32Array embedding */
	v: string;
}

interface FileIndex {
	mtimeMs: number;
	size: number;
	chunks: Chunk[];
}

interface RecallIndex {
	version: number;
	model: string;
	dimensions: number;
	files: Record<string, FileIndex>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

async function resolveOAuth(): Promise<{ token: string; accountId?: string }> {
	const runtime = await ModelRuntime.create();
	const check = await (runtime as any).checkAuth(PROVIDER_ID);
	if (!(runtime as any).isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
		throw new Error("recall needs the openai-codex OAuth subscription; run /login first");
	}
	const token = (await (runtime as any).getAuth(PROVIDER_ID))?.auth?.apiKey;
	if (!token) throw new Error("could not resolve the OAuth token; run /login again");
	let accountId: string | undefined;
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id) accountId = id;
	} catch {}
	return { token, accountId };
}

async function embed(
	auth: { token: string; accountId?: string },
	inputs: string[],
): Promise<Float32Array[]> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.token}`,
		"content-type": "application/json",
		originator: "pi",
	};
	if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
	const response = await fetch(EMBEDDINGS_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: activeModel, input: inputs, dimensions: DIMENSIONS }),
	});
	if (!response.ok) {
		const body = clip(await response.text(), 300);
		throw new Error(`embeddings request failed (${response.status}): ${body}`);
	}
	const data = (await response.json()) as { data: { index: number; embedding: number[] }[] };
	const vectors = new Array<Float32Array>(inputs.length);
	for (const item of data.data) vectors[item.index] = Float32Array.from(item.embedding);
	if (vectors.some((v) => !v)) throw new Error("embeddings response was missing vectors");
	return vectors;
}

function encodeVector(vector: Float32Array): string {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function decodeVector(encoded: string): Float32Array {
	const buf = Buffer.from(encoded, "base64");
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Cosine similarity; embedding-3 vectors are unit-normalized, so dot product. */
function similarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
	return dot;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && typeof part === "object" && (part as any).type === "text"),
		)
		.map((part) => part.text)
		.join("\n");
}

/** Pulls the embeddable user/assistant message chunks out of one session file. */
function sessionChunks(path: string): { r: string; t: string }[] {
	const chunks: { r: string; t: string }[] = [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return chunks;
	}
	for (const line of raw.split("\n")) {
		if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractMessageText(entry.message?.content).trim();
		if (text.length < MIN_CHUNK_CHARS) continue;
		chunks.push({ r: role, t: text.slice(0, MAX_CHUNK_CHARS) });
	}
	return chunks;
}

function listSessionFiles(): string[] {
	if (!existsSync(SESSIONS_DIR)) return [];
	const files: string[] = [];
	for (const dir of readdirSync(SESSIONS_DIR)) {
		const dirPath = join(SESSIONS_DIR, dir);
		let names: string[];
		try {
			if (!statSync(dirPath).isDirectory()) continue;
			names = readdirSync(dirPath);
		} catch {
			continue;
		}
		for (const name of names) {
			if (name.endsWith(".jsonl")) files.push(join(dirPath, name));
		}
	}
	return files;
}

function loadIndex(): RecallIndex {
	try {
		const index = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as RecallIndex;
		if (index.version === INDEX_VERSION && index.model === activeModel && index.dimensions === DIMENSIONS) {
			return index;
		}
	} catch {}
	return { version: INDEX_VERSION, model: activeModel, dimensions: DIMENSIONS, files: {} };
}

function saveIndex(index: RecallIndex): void {
	const temporaryPath = `${INDEX_PATH}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify(index), { mode: 0o600 });
	renameSync(temporaryPath, INDEX_PATH);
}

/** Re-embeds new/changed session files; returns how many files were refreshed. */
async function refreshIndex(
	index: RecallIndex,
	auth: { token: string; accountId?: string },
	onProgress: (done: number, total: number) => void,
	currentSessionFile?: string,
): Promise<number> {
	const files = listSessionFiles();
	const seen = new Set<string>();
	const stale: { path: string; mtimeMs: number; size: number }[] = [];
	for (const path of files) {
		// Skip the live session file: it changes every turn and would force a
		// re-embed on each search.
		if (currentSessionFile && path === currentSessionFile) continue;
		seen.add(path);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		const cached = index.files[path];
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
		stale.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
	}
	for (const path of Object.keys(index.files)) {
		if (!seen.has(path)) delete index.files[path];
	}

	let done = 0;
	for (const file of stale) {
		const chunks = sessionChunks(file.path);
		const indexed: Chunk[] = [];
		for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
			const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
			const vectors = await embed(auth, batch.map((chunk) => chunk.t));
			for (let i = 0; i < batch.length; i++) {
				indexed.push({ r: batch[i]!.r, t: batch[i]!.t, v: encodeVector(vectors[i]!) });
			}
		}
		index.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, chunks: indexed };
		done += 1;
		onProgress(done, stale.length);
		// Persist as we go so an interrupted reindex keeps its progress.
		if (done % 10 === 0) saveIndex(index);
	}
	if (stale.length || seen.size !== Object.keys(index.files).length) saveIndex(index);
	return stale.length;
}

interface Match {
	score: number;
	role: string;
	text: string;
	session: string;
}

function search(index: RecallIndex, queryVector: Float32Array): Match[] {
	const matches: Match[] = [];
	for (const [path, file] of Object.entries(index.files)) {
		for (const chunk of file.chunks) {
			const score = similarity(queryVector, decodeVector(chunk.v));
			matches.push({ score, role: chunk.r, text: chunk.t, session: path });
		}
	}
	matches.sort((a, b) => b.score - a.score);
	// One best chunk per session file so the results span distinct conversations.
	const seen = new Set<string>();
	const top: Match[] = [];
	for (const match of matches) {
		const key = `${match.session}`;
		if (seen.has(key)) continue;
		seen.add(key);
		top.push(match);
		if (top.length >= TOP_K) break;
	}
	return top;
}

function sessionLabel(path: string): string {
	const name = path.split("/").at(-1) ?? path;
	const dir = path.split("/").at(-2) ?? "";
	const when = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
	const cwd = dir.replace(/^--|--$/g, "").replace(/-/g, "/").replace(/^\/?Users\/[^/]+/, "~");
	return when ? `${when[1]} ${when[2]}:${when[3]} · ${cwd}` : `${cwd}/${name}`;
}

export default function semanticRecall(pi: ExtensionAPI) {
	let busy = false;

	pi.registerCommand("recall", {
		description: "Semantic search over past sessions (text-embedding-3-large / -small)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const query = args.trim();
			activeModel = readModel();
			if (!query) {
				ctx.ui.notify(
					`Usage: /recall <query> | /recall reindex | /recall large|small (current: ${activeModel})`,
					"info",
				);
				return;
			}

			// First-class embedding-tier toggle so the mini model is discoverable.
			const lower = query.toLowerCase();
			let tierArg: string | undefined;
			if (lower === "large" || lower === "small") tierArg = lower;
			else if (lower === "model") tierArg = "show";
			else if (lower.startsWith("model ")) tierArg = query.slice(6).trim();
			if (tierArg !== undefined) {
				if (tierArg === "" || tierArg === "show") {
					ctx.ui.notify(
						`Recall embedding model: ${activeModel}. Switch with /recall large or /recall small`,
						"info",
					);
					return;
				}
				const resolved = MODEL_TIERS[tierArg.toLowerCase()] ?? tierArg;
				if (resolved === activeModel) {
					ctx.ui.notify(`Recall already using ${resolved}`, "info");
					return;
				}
				writeModel(resolved);
				activeModel = resolved;
				ctx.ui.notify(
					`Recall embedding model set to ${resolved}; next search rebuilds the index`,
					"info",
				);
				return;
			}

			if (busy) {
				ctx.ui.notify("Recall is already running", "warning");
				return;
			}
			busy = true;
			const status = (text?: string) => {
				if (ctx.hasUI) ctx.ui.setStatus("recall", text);
			};
			try {
				const auth = await resolveOAuth();
				const index = query.toLowerCase() === "reindex"
					? { version: INDEX_VERSION, model: activeModel, dimensions: DIMENSIONS, files: {} }
					: loadIndex();

				status("◉ recall: indexing…");
				const currentSessionFile = (ctx.sessionManager as any).getSessionFile?.() as string | undefined;
				const refreshed = await refreshIndex(
					index,
					auth,
					(done, total) => status(`◉ recall: indexing ${done}/${total}`),
					currentSessionFile,
				);

				if (query.toLowerCase() === "reindex") {
					const total = Object.values(index.files).reduce((sum, file) => sum + file.chunks.length, 0);
					ctx.ui.notify(`Recall reindexed ${refreshed} session files (${total} chunks)`, "info");
					return;
				}

				status("◉ recall: searching…");
				const [queryVector] = await embed(auth, [query]);
				const matches = search(index, queryVector!);
				if (!matches.length) {
					ctx.ui.notify("Recall found no matches (no indexed sessions yet?)", "info");
					return;
				}

				const lines = matches.map((match, i) => {
					const snippet = clip(match.text, 280);
					return `${i + 1}. **${sessionLabel(match.session)}** (${match.role}, ${match.score.toFixed(2)})\n   ${snippet}`;
				});
				pi.sendMessage(
					{
						customType: "recall-results",
						content: `Semantic recall for "${query}" across past pi sessions:\n\n${lines.join("\n\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				ctx.ui.notify(`Recall failed: ${clip(errorText(error), 160)}`, "error");
			} finally {
				busy = false;
				status(undefined);
			}
		},
	});
}
