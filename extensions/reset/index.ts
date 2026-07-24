import { randomUUID } from "node:crypto";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_USAGE_CHANGED_EVENT, resolveCodexAuth, whamRequest, type CodexAuth } from "../lib/codex.ts";
import { errorText } from "../lib/util.ts";

const USER_AGENT = "pi-reset/0.1.0";
const CANCEL_OPTION = "Cancel";

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

async function fetchResetCredits(auth: CodexAuth, signal?: AbortSignal): Promise<{ credits: ResetCredit[]; availableCount: number }> {
	const payload = (await whamRequest(auth, "/rate-limit-reset-credits", { userAgent: USER_AGENT, signal })) as ResetCreditsPayload;
	const credits = (payload.credits ?? [])
		.filter((credit) => typeof credit.id === "string" && (credit.status === undefined || credit.status === "available"))
		.sort((a, b) => (parseEpoch(a.expires_at) ?? Infinity) - (parseEpoch(b.expires_at) ?? Infinity));
	return { credits, availableCount: payload.available_count ?? credits.length };
}

async function consumeResetCredit(auth: CodexAuth, redeemRequestId: string, creditId: string | undefined): Promise<ConsumePayload> {
	// redeem_request_id is an idempotency key; retries must reuse the same value.
	const body: Record<string, string> = { redeem_request_id: redeemRequestId };
	if (creditId) body.credit_id = creditId;
	return (await whamRequest(auth, "/rate-limit-reset-credits/consume", { userAgent: USER_AGENT, body })) as ConsumePayload;
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
				notify(ctx, `Couldn't load usage limit resets: ${errorText(error)}`, "error");
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
					const message = errorText(error);
					const retry = await ctx.ui.confirm("Couldn't reset usage", `${message}\n\nTry again?`);
					if (!retry) return;
				}
			}
		},
	});
}
