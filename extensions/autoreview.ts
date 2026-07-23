// /autoreview - one-shot code review by the dedicated `codex-auto-review` model.
//
// The ChatGPT backend's /codex/models catalog exposes codex-auto-review to
// OAuth subscription accounts alongside the chat models. Unlike /review (which
// steers the interactive agent through a rubric), this sends the diff straight
// to the purpose-trained review model over the codex responses endpoint and
// posts its findings — no agent turn, no tool use, faster and cheaper.
//
//   /autoreview                    review uncommitted changes (falls back to
//                                  the branch diff vs main when the tree is clean)
//   /autoreview branch <name>      review the diff against a base branch
//   /autoreview commit <sha>       review a single commit
//
// Auth is the pi `openai-codex` OAuth subscription resolved through
// ModelRuntime (~/.pi/agent/auth.json). OAuth only — no API-key fallback.

import { randomUUID } from "node:crypto";
import {
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const MODEL = process.env.PI_AUTOREVIEW_MODEL?.trim() || "codex-auto-review";
/** Middle-out cap so huge diffs still fit the model context. */
const MAX_DIFF_CHARS = 180_000;

const INSTRUCTIONS =
	"You are an automated code reviewer. Review the code changes in the diff " +
	"below and report prioritized, actionable findings. Tag each finding " +
	"[P0] (blocking), [P1] (urgent), [P2] (normal), or [P3] (nice to have), " +
	"with the file location and a one-paragraph explanation. Only flag issues " +
	"introduced by the diff, not pre-existing problems. End with an overall " +
	'verdict: "correct" or "needs attention". If the change looks good, say so.';

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 60) / 2);
	const omitted = text.length - half * 2;
	return `${text.slice(0, half)}\n\n…[${omitted} characters of diff truncated]…\n\n${text.slice(-half)}`;
}

async function resolveOAuth(): Promise<{ token: string; accountId?: string; baseUrl: string }> {
	const runtime = await ModelRuntime.create();
	const check = await (runtime as any).checkAuth(PROVIDER_ID);
	if (!(runtime as any).isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
		throw new Error("autoreview needs the openai-codex OAuth subscription; run /login first");
	}
	const result = await (runtime as any).getAuth(PROVIDER_ID);
	const token = result?.auth?.apiKey;
	if (!token) throw new Error("could not resolve the OAuth token; run /login again");
	const baseUrl: string =
		result?.auth?.baseUrl ?? (runtime as any).getProvider?.(PROVIDER_ID)?.baseUrl ?? DEFAULT_BASE_URL;
	let accountId: string | undefined;
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id) accountId = id;
	} catch {}
	return { token, accountId, baseUrl };
}

function responsesEndpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	const codexBase = normalized.endsWith("/codex") ? normalized : `${normalized}/codex`;
	return `${codexBase}/responses`;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of body as any) {
		buffered += decoder.decode(chunk, { stream: true });
		let boundary: number;
		while ((boundary = buffered.indexOf("\n\n")) !== -1) {
			const rawEvent = buffered.slice(0, boundary);
			buffered = buffered.slice(boundary + 2);
			const data = rawEvent
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("");
			if (!data || data === "[DONE]") continue;
			try {
				yield JSON.parse(data);
			} catch {}
		}
	}
}

async function runReview(diff: string, label: string): Promise<string> {
	const { token, accountId, baseUrl } = await resolveOAuth();
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		originator: "pi",
		"session-id": randomUUID(),
		accept: "text/event-stream",
		"content-type": "application/json",
		"user-agent": `pi-autoreview (${process.platform}; ${process.arch})`,
	};
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const response = await fetch(responsesEndpoint(baseUrl), {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: MODEL,
			instructions: INSTRUCTIONS,
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: `Review these code changes (${label}):\n\n\`\`\`diff\n${truncateMiddle(diff, MAX_DIFF_CHARS)}\n\`\`\``,
						},
					],
				},
			],
			store: false,
			stream: true,
			include: [],
		}),
	});
	if (!response.ok) {
		const body = clip(await response.text(), 300);
		throw new Error(`review request failed (${response.status}): ${body}`);
	}
	if (!response.body) throw new Error("review request returned no stream");

	let review = "";
	for await (const event of sseEvents(response.body)) {
		switch (event.type) {
			case "response.output_item.done": {
				const item = event.item;
				if (item?.type === "message" && item.role === "assistant") {
					for (const part of item.content ?? []) {
						if (part.type === "output_text") review += part.text ?? "";
					}
				}
				break;
			}
			case "response.failed":
				throw new Error(event.response?.error?.message ?? "the review request failed");
			case "error":
				throw new Error(event.message ?? "the review stream reported an error");
			default:
				break;
		}
	}
	if (!review.trim()) throw new Error("the review model returned no findings text");
	return review.trim();
}

export default function autoreview(pi: ExtensionAPI) {
	let busy = false;

	async function collectDiff(args: string): Promise<{ diff: string; label: string }> {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const mode = parts[0]?.toLowerCase();

		if (mode === "commit") {
			const sha = parts[1];
			if (!sha) throw new Error("Usage: /autoreview commit <sha>");
			const { stdout, code } = await pi.exec("git", ["show", "--patch", sha]);
			if (code !== 0 || !stdout.trim()) throw new Error(`could not read commit ${sha}`);
			return { diff: stdout, label: `commit ${sha.slice(0, 10)}` };
		}

		if (mode === "branch") {
			const branch = parts[1];
			if (!branch) throw new Error("Usage: /autoreview branch <name>");
			const { stdout: base, code: baseCode } = await pi.exec("git", ["merge-base", "HEAD", branch]);
			if (baseCode !== 0 || !base.trim()) throw new Error(`could not find merge base with ${branch}`);
			const { stdout, code } = await pi.exec("git", ["diff", base.trim()]);
			if (code !== 0) throw new Error(`git diff against ${branch} failed`);
			if (!stdout.trim()) throw new Error(`no changes against ${branch}`);
			return { diff: stdout, label: `diff vs ${branch}` };
		}

		if (mode && mode !== "uncommitted") {
			throw new Error(`Unknown /autoreview mode "${mode}". Use uncommitted, branch <name>, or commit <sha>.`);
		}

		const { stdout: uncommitted } = await pi.exec("git", ["diff", "HEAD"]);
		if (uncommitted.trim()) return { diff: uncommitted, label: "uncommitted changes" };
		if (mode === "uncommitted") throw new Error("no uncommitted changes to review");

		// Clean tree with no explicit mode: review the branch against the default branch.
		const { stdout: head } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
		const fallback = head.trim().replace("origin/", "") || "main";
		const { stdout: base, code: baseCode } = await pi.exec("git", ["merge-base", "HEAD", fallback]);
		if (baseCode !== 0 || !base.trim()) throw new Error("no uncommitted changes and no base branch to diff against");
		const { stdout: branchDiff } = await pi.exec("git", ["diff", base.trim()]);
		if (!branchDiff.trim()) {
			// Nothing on the branch either: review the latest commit.
			const { stdout: show, code } = await pi.exec("git", ["show", "--patch", "HEAD"]);
			if (code !== 0 || !show.trim()) throw new Error("nothing to review");
			return { diff: show, label: "latest commit (HEAD)" };
		}
		return { diff: branchDiff, label: `diff vs ${fallback}` };
	}

	pi.registerCommand("autoreview", {
		description: "One-shot code review by the codex-auto-review model (no agent turn)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (busy) {
				ctx.ui.notify("Autoreview is already running", "warning");
				return;
			}
			busy = true;
			const status = (text?: string) => {
				if (ctx.hasUI) ctx.ui.setStatus("autoreview", text);
			};
			try {
				const { diff, label } = await collectDiff(args);
				status(`◉ autoreview: ${label} — ${MODEL}`);
				ctx.ui.notify(`Reviewing ${label} with ${MODEL}…`, "info");
				const review = await runReview(diff, label);
				pi.sendMessage(
					{
						customType: "autoreview-results",
						content: `Automated review of ${label} by ${MODEL}:\n\n${review}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				ctx.ui.notify(`Autoreview failed: ${clip(errorText(error), 160)}`, "error");
			} finally {
				busy = false;
				status(undefined);
			}
		},
	});
}
