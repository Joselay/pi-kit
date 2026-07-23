import { randomUUID } from "node:crypto";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Same backend Codex CLI hits for /usage -> "Redeem usage limit reset"; the
// /wham prefix is the ChatGPT-auth path style (see codex-rs backend-client).
const CHATGPT_BASE_URL = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "pi-reset/0.1.0";
const CANCEL_OPTION = "Cancel";
const CODEX_USAGE_CHANGED_EVENT = "codex:usage-changed";

type CodexAuth = { access: string; accountId: string };

type ResetCredit = {
	id?: string;
	reset_type?: string;
	status?: string;
	granted_at?: string;
	expires_at?: string | null;
	title?: string | null;
	description?: string | null;
};

type ResetCreditsPayload = { credits?: ResetCredit[] | null; available_count?: number };

type ConsumeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";
type ConsumePayload = { code?: ConsumeCode; windows_reset?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountIdFromAccessToken(access: string): string | undefined {
	try {
		const payloadPart = access.split(".")[1];
		if (!payloadPart) return undefined;
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
		if (!isRecord(payload)) return undefined;
		const authClaim = payload["https://api.openai.com/auth"];
		if (!isRecord(authClaim)) return undefined;
		return typeof authClaim.chatgpt_account_id === "string" ? authClaim.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

async function resolveCodexAuth(ctx: ExtensionContext): Promise<CodexAuth> {
	// Use Pi's provider auth path so expired OAuth credentials are refreshed and
	// auth.json remains an implementation detail.
	const access = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!access) {
		const configured = ctx.modelRegistry.getProviderAuthStatus("openai-codex").configured;
		throw new Error(configured ? "Couldn't refresh OpenAI Codex credentials. Try /login again." : "Log in to OpenAI Codex with /login first.");
	}

	const accountId = accountIdFromAccessToken(access);
	if (!accountId) throw new Error("OpenAI Codex credentials are invalid. Try /login again.");
	return { access, accountId };
}

async function apiRequest(auth: CodexAuth, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
	const method = body === undefined ? "GET" : "POST";
	const url = `${CHATGPT_BASE_URL}/wham${path}`;
	const headers: Record<string, string> = {
		authorization: `Bearer ${auth.access}`,
		"chatgpt-account-id": auth.accountId,
		"user-agent": USER_AGENT,
	};
	if (body !== undefined) headers["content-type"] = "application/json";

	const response = await fetch(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
		throw new Error(`${method} ${path} failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${method} ${path} returned invalid JSON`);
	}
}

async function fetchResetCredits(auth: CodexAuth, signal?: AbortSignal): Promise<{ credits: ResetCredit[]; availableCount: number }> {
	const payload = (await apiRequest(auth, "/rate-limit-reset-credits", undefined, signal)) as ResetCreditsPayload;
	const credits = (payload.credits ?? [])
		.filter((credit) => typeof credit.id === "string" && (credit.status === undefined || credit.status === "available"))
		.sort((a, b) => (parseEpoch(a.expires_at) ?? Infinity) - (parseEpoch(b.expires_at) ?? Infinity));
	return { credits, availableCount: payload.available_count ?? credits.length };
}

async function consumeResetCredit(auth: CodexAuth, redeemRequestId: string, creditId: string | undefined): Promise<ConsumePayload> {
	// redeem_request_id is an idempotency key; retries must reuse the same value.
	const body: Record<string, string> = { redeem_request_id: redeemRequestId };
	if (creditId) body.credit_id = creditId;
	return (await apiRequest(auth, "/rate-limit-reset-credits/consume", body)) as ConsumePayload;
}

function parseEpoch(iso: string | null | undefined): number | undefined {
	if (!iso) return undefined;
	const epoch = Date.parse(iso);
	return Number.isNaN(epoch) ? undefined : epoch;
}

// Matches Codex TUI's "Expires %H:%M on %-d %b %Y" rendering, in local time.
function formatDateTime(epoch: number): string {
	const date = new Date(epoch);
	const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
	const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
	return `${time} on ${day}`;
}

function formatRemaining(epoch: number, now = Date.now()): string {
	const remainingMs = epoch - now;
	if (remainingMs <= 0) return "expired";
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	if (totalMinutes < 60) return `in ${totalMinutes}m`;
	const totalHours = Math.ceil(totalMinutes / 60);
	if (totalHours < 24) return `in ${totalHours}h`;
	return `in ${Math.ceil(totalHours / 24)}d`;
}

function formatExpiry(expiresAt: string | null | undefined): string {
	const epoch = parseEpoch(expiresAt);
	if (epoch === undefined) return "does not expire";
	if (epoch <= Date.now()) return `expired ${formatDateTime(epoch)}`;
	return `expires ${formatDateTime(epoch)} (${formatRemaining(epoch)})`;
}

function creditLabel(credit: ResetCredit, index: number): string {
	const title = credit.title?.trim() || "Usage limit reset";
	return `${index + 1}. ${title} — ${formatExpiry(credit.expires_at)}`;
}

function creditDetail(credit: ResetCredit): string {
	const lines = [credit.description?.trim() || "Instantly resets your Codex usage limits. A reset can only be used once."];
	const expiresEpoch = parseEpoch(credit.expires_at);
	lines.push(expiresEpoch === undefined ? "Does not expire." : `Expires ${formatDateTime(expiresEpoch)} (${formatRemaining(expiresEpoch)}).`);
	const grantedEpoch = parseEpoch(credit.granted_at);
	if (grantedEpoch !== undefined) lines.push(`Granted ${formatDateTime(grantedEpoch)}.`);
	return lines.join("\n");
}

export default function usageReset(pi: ExtensionAPI) {
	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	async function loadResetCredits(ctx: ExtensionContext): Promise<{ auth: CodexAuth; credits: ResetCredit[]; availableCount: number } | undefined> {
		const load = async (signal?: AbortSignal) => {
			const auth = await resolveCodexAuth(ctx);
			return { auth, ...(await fetchResetCredits(auth, signal)) };
		};
		if (ctx.mode !== "tui") return load();

		let loadError: unknown;
		const result = await ctx.ui.custom<Awaited<ReturnType<typeof load>> | undefined>((tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, "Loading Codex usage limit resets...");
			loader.onAbort = () => done(undefined);
			load(loader.signal)
				.then(done)
				.catch((error) => {
					loadError = error;
					done(undefined);
				});
			return loader;
		});
		if (loadError) throw loadError;
		return result;
	}

	async function reportOutcome(ctx: ExtensionContext, auth: CodexAuth, result: ConsumePayload, creditId: string | undefined): Promise<void> {
		switch (result.code) {
			case "reset":
			case "already_redeemed": {
				const windows = result.windows_reset ?? 0;
				let remainingText = "";
				try {
					const { availableCount } = await fetchResetCredits(auth);
					remainingText = ` You have ${availableCount} usage limit reset(s) left.`;
				} catch {
					// Refresh is best-effort; the reset itself already succeeded.
				}
				// The statusline's app-server process does not always receive an
				// account/rateLimits/updated notification after this HTTP mutation.
				pi.events.emit(CODEX_USAGE_CHANGED_EVENT, undefined);
				notify(ctx, `Usage reset${windows > 0 ? ` (${windows} window(s))` : ""}.${remainingText}`, "info");
				return;
			}
			case "nothing_to_reset":
				notify(ctx, "Your usage does not need a reset right now.", "info");
				return;
			case "no_credit":
				notify(
					ctx,
					creditId ? "That reset is no longer available. Run /reset again to refresh." : "No usage limit resets are available.",
					"warning",
				);
				return;
			default:
				notify(ctx, `Unexpected reset response code: ${String(result.code)}`, "warning");
		}
	}

	pi.registerCommand("reset", {
		description: "Redeem an OpenAI Codex usage limit reset",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim()) {
				notify(ctx, "Use /reset with no arguments", "warning");
				return;
			}

			let loaded: Awaited<ReturnType<typeof loadResetCredits>>;
			try {
				loaded = await loadResetCredits(ctx);
			} catch (error) {
				notify(ctx, `Couldn't load usage limit resets: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (!loaded) return;
			const { auth, credits, availableCount } = loaded;
			if (availableCount <= 0 || credits.length === 0) {
				notify(ctx, "No usage limit resets available.", "info");
				return;
			}

			const options = [...credits.map(creditLabel), CANCEL_OPTION];
			const choice = await ctx.ui.select(`Usage limit resets (${availableCount} available)`, options);
			if (choice === undefined || choice === CANCEL_OPTION) return;
			const credit = credits[options.indexOf(choice)];
			if (!credit?.id) return;

			const confirmed = await ctx.ui.confirm("Use this reset?", creditDetail(credit));
			if (!confirmed) return;

			const redeemRequestId = randomUUID();
			for (;;) {
				try {
					const result = await consumeResetCredit(auth, redeemRequestId, credit.id);
					await reportOutcome(ctx, auth, result, credit.id);
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const retry = await ctx.ui.confirm("Couldn't reset usage", `${message}\n\nTry again?`);
					if (!retry) return;
				}
			}
		},
	});
}
