import { randomUUID } from "node:crypto";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER_ID = "openai-codex";
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "pi-reset/0.2.0";
const CODEX_USAGE_CHANGED_EVENT = "codex:usage-changed";
const CANCEL_OPTION = "Cancel";
const WARNING_WIDGET = "codex-reset-expiry";
const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;
const WARNING_REFRESH_MS = 15 * 60 * 1000;

type NotifyLevel = "info" | "warning" | "error";

type CodexRequestOptions = {
	userAgent: string;
	body?: unknown;
	signal?: AbortSignal;
};

type CodexAccount = {
	request(path: string, options: CodexRequestOptions): Promise<unknown>;
};

export type ResetCredit = {
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
type LoaderResult<T> =
	| { status: "ok"; value: T }
	| { status: "cancelled" }
	| { status: "failed"; error: unknown; message: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function authClaim(access: string): Record<string, unknown> | undefined {
	try {
		const payloadPart = access.split(".")[1];
		if (!payloadPart) return undefined;
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
		if (!isRecord(payload)) return undefined;
		const claim = payload["https://api.openai.com/auth"];
		return isRecord(claim) ? claim : undefined;
	} catch {
		return undefined;
	}
}

function accountIdFromAccessToken(access: string): string | undefined {
	const value = authClaim(access)?.chatgpt_account_id;
	return typeof value === "string" && value ? value : undefined;
}

function codexAccount(ctx: ExtensionContext): CodexAccount {
	async function resolvedAuth(): Promise<{
		access: string;
		accountId: string;
		baseUrl: string;
		headers: Record<string, string>;
	}> {
		const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
		const access = resolved?.auth.apiKey;
		if (!access) {
			const configured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
			throw new Error(
				configured
					? "Couldn't refresh OpenAI Codex credentials. Try /login again."
					: "Log in to OpenAI Codex with /login first.",
			);
		}

		const accountId = accountIdFromAccessToken(access);
		if (!accountId) throw new Error("OpenAI Codex credentials are invalid. Try /login again.");

		const configuredBase = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim();
		const baseUrl = (
			configuredBase ||
			resolved.auth.baseUrl ||
			ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ||
			CHATGPT_BASE_URL
		)
			.replace(/\/+$/, "")
			.replace(/\/codex(?:\/responses)?$/, "");
		const headers = Object.fromEntries(
			Object.entries(resolved.auth.headers ?? {}).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
		return { access, accountId, baseUrl, headers };
	}

	return {
		async request(path, options): Promise<unknown> {
			const auth = await resolvedAuth();
			const method = options.body === undefined ? "GET" : "POST";
			const headers: Record<string, string> = {
				...auth.headers,
				authorization: `Bearer ${auth.access}`,
				"chatgpt-account-id": auth.accountId,
				"user-agent": options.userAgent,
			};
			if (options.body !== undefined) headers["content-type"] = "application/json";

			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const pathPrefix = auth.baseUrl.includes("/backend-api") ? "/wham" : "/api/codex";
			const response = await fetch(`${auth.baseUrl}${pathPrefix}${path}`, {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
			});
			const text = await response.text();
			if (!response.ok) {
				const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
				throw new Error(`${method} ${path} failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
			}
			if (!text.trim()) return {};
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new Error(`${method} ${path} returned invalid JSON`);
			}
		},
	};
}

function failed(error: unknown): LoaderResult<never> {
	return { status: "failed", error, message: errorText(error) };
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function withLoader<T>(
	ctx: ExtensionContext,
	label: string,
	work: (signal?: AbortSignal) => Promise<T>,
): Promise<LoaderResult<T>> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		try {
			return { status: "ok", value: await work() };
		} catch (error) {
			return failed(error);
		}
	}

	let settled = false;
	return await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, label);
		const settle = (result: LoaderResult<T>): void => {
			if (settled) return;
			settled = true;
			done(result);
		};
		loader.onAbort = () => settle({ status: "cancelled" });
		work(loader.signal)
			.then((value) => settle({ status: "ok", value }))
			.catch((error: unknown) => {
				if (isAbort(error) && loader.signal.aborted) {
					settle({ status: "cancelled" });
					return;
				}
				settle(failed(error));
			});
		return loader;
	});
}

function formatTimeUntil(epochMs: number, now = Date.now()): string {
	const remainingMs = epochMs - now;
	if (remainingMs <= 0) return "expired";
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	if (totalMinutes < 60) return `in ${totalMinutes}m`;
	const totalHours = Math.ceil(totalMinutes / 60);
	if (totalHours < 24) return `in ${totalHours}h`;
	return `in ${Math.ceil(totalHours / 24)}d`;
}

async function fetchResetCredits(
	account: CodexAccount,
	signal?: AbortSignal,
): Promise<{ credits: ResetCredit[]; availableCount: number }> {
	const payload = (await account.request("/rate-limit-reset-credits", {
		userAgent: USER_AGENT,
		signal,
	})) as ResetCreditsPayload;
	const credits = (payload.credits ?? [])
		.filter(
			(credit) =>
				typeof credit.id === "string" && (credit.status === undefined || credit.status === "available"),
		)
		.sort((a, b) => (parseEpoch(a.expires_at) ?? Infinity) - (parseEpoch(b.expires_at) ?? Infinity));
	return { credits, availableCount: payload.available_count ?? credits.length };
}

async function consumeResetCredit(
	account: CodexAccount,
	redeemRequestId: string,
	creditId: string | undefined,
	signal?: AbortSignal,
): Promise<ConsumePayload> {
	const body: Record<string, string> = { redeem_request_id: redeemRequestId };
	if (creditId) body.credit_id = creditId;
	return (await account.request("/rate-limit-reset-credits/consume", {
		userAgent: USER_AGENT,
		body,
		signal,
	})) as ConsumePayload;
}

function parseEpoch(iso: string | null | undefined): number | undefined {
	if (!iso) return undefined;
	const epoch = Date.parse(iso);
	return Number.isNaN(epoch) ? undefined : epoch;
}

export function expiringResetCredits(
	credits: readonly ResetCredit[],
	now = Date.now(),
	warningWindowMs = WARNING_WINDOW_MS,
): ResetCredit[] {
	return credits
		.filter((credit) => {
			const expiry = parseEpoch(credit.expires_at);
			return expiry !== undefined && expiry > now && expiry - now <= warningWindowMs;
		})
		.sort((a, b) => (parseEpoch(a.expires_at) ?? Infinity) - (parseEpoch(b.expires_at) ?? Infinity));
}

export function resetExpiryWarning(credits: readonly ResetCredit[], now = Date.now()): string | undefined {
	const expiring = expiringResetCredits(credits, now);
	const nextExpiry = parseEpoch(expiring[0]?.expires_at);
	if (nextExpiry === undefined) return undefined;
	const until = formatTimeUntil(nextExpiry, now);
	return expiring.length === 1
		? `Codex usage reset expires ${until}`
		: `${expiring.length} Codex usage resets expire soon; next ${until}`;
}

function formatDateTime(epoch: number): string {
	const date = new Date(epoch);
	const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
	const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
	return `${time} on ${day}`;
}

function formatExpiry(expiresAt: string | null | undefined): string {
	const epoch = parseEpoch(expiresAt);
	if (epoch === undefined) return "does not expire";
	if (epoch <= Date.now()) return `expired ${formatDateTime(epoch)}`;
	return `expires ${formatDateTime(epoch)} (${formatTimeUntil(epoch)})`;
}

function creditLabel(credit: ResetCredit, index: number): string {
	const title = credit.title?.trim() || "Usage limit reset";
	return `${index + 1}. ${title} — ${formatExpiry(credit.expires_at)}`;
}

function creditDetail(credit: ResetCredit): string {
	const lines = [
		credit.description?.trim() || "Instantly resets your Codex usage limits. A reset can only be used once.",
	];
	const expiresEpoch = parseEpoch(credit.expires_at);
	lines.push(
		expiresEpoch === undefined
			? "Does not expire."
			: `Expires ${formatDateTime(expiresEpoch)} (${formatTimeUntil(expiresEpoch)}).`,
	);
	const grantedEpoch = parseEpoch(credit.granted_at);
	if (grantedEpoch !== undefined) lines.push(`Granted ${formatDateTime(grantedEpoch)}.`);
	return lines.join("\n");
}

export default function usageReset(pi: ExtensionAPI) {
	let activeContext: ExtensionContext | undefined;
	let warningRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let warningGeneration = 0;

	function clearWarningTimer(): void {
		if (warningRefreshTimer) clearInterval(warningRefreshTimer);
		warningRefreshTimer = undefined;
	}

	function showExpiryWarning(ctx: ExtensionContext, credits: readonly ResetCredit[]): void {
		const now = Date.now();
		const expiring = expiringResetCredits(credits, now);
		const warning = resetExpiryWarning(expiring, now);
		if (!warning) {
			ctx.ui.setWidget(WARNING_WIDGET, undefined);
			return;
		}

		ctx.ui.setWidget(
			WARNING_WIDGET,
			(_tui, theme) => ({
				render(width: number): string[] {
					const nextExpiry = parseEpoch(expiring[0]?.expires_at) ?? Date.now();
					const until = formatTimeUntil(nextExpiry);
					const current = resetExpiryWarning(expiring) ?? "Codex usage reset expired";
					const variants = [`${current} · run /reset`, `Reset ${until} · /reset`, `/reset · reset ${until}`, "/reset"];
					const plain = variants.find((text) => visibleWidth(text) <= width) ?? "/reset";
					const styled = theme.fg("warning", theme.bold(plain));
					const fitted = truncateToWidth(styled, width, "");
					return [`${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`];
				},
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	async function refreshExpiryWarning(ctx: ExtensionContext): Promise<void> {
		const generation = ++warningGeneration;
		try {
			const { credits } = await fetchResetCredits(codexAccount(ctx));
			if (generation === warningGeneration && activeContext === ctx) showExpiryWarning(ctx, credits);
		} catch {
		}
	}

	async function loadResetCredits(
		ctx: ExtensionContext,
	): Promise<{ account: CodexAccount; credits: ResetCredit[]; availableCount: number } | undefined> {
		const outcome = await withLoader(ctx, "Loading Codex usage limit resets...", async (signal) => {
			const account = codexAccount(ctx);
			return { account, ...(await fetchResetCredits(account, signal)) };
		});
		if (outcome.status === "failed") throw outcome.error;
		return outcome.status === "ok" ? outcome.value : undefined;
	}

	function reportOutcome(
		ctx: ExtensionContext,
		result: ConsumePayload,
		creditId: string | undefined,
		remainingCount?: number,
	): void {
		switch (result.code) {
			case "reset":
			case "already_redeemed": {
				const windows = result.windows_reset ?? 0;
				const remainingText =
					remainingCount === undefined ? "" : ` You have ${remainingCount} usage limit reset(s) left.`;
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
					creditId
						? "That reset is no longer available. Run /reset again to refresh."
						: "No usage limit resets are available.",
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
			const { account, credits, availableCount } = loaded;
			if (availableCount <= 0 || credits.length === 0) {
				notify(ctx, "No usage limit resets available.", "info");
				return;
			}

			const options = [...credits.map(creditLabel), CANCEL_OPTION];
			const choice = await ctx.ui.select(`Usage limit resets (${availableCount} available)`, options);
			if (choice === undefined || choice === CANCEL_OPTION) return;
			const credit = credits[options.indexOf(choice)];
			if (!credit?.id) return;
			if (!(await ctx.ui.confirm("Use this reset?", creditDetail(credit)))) return;

			const redeemRequestId = randomUUID();
			for (;;) {
				const outcome = await withLoader(ctx, "Resetting Codex usage limits...", async (signal) => {
					const result = await consumeResetCredit(account, redeemRequestId, credit.id, signal);
					let remainingCount: number | undefined;
					if (result.code === "reset" || result.code === "already_redeemed") {
						try {
							remainingCount = (await fetchResetCredits(account, signal)).availableCount;
						} catch {
						}
					}
					return { result, remainingCount };
				});
				if (outcome.status === "cancelled") return;
				if (outcome.status === "ok") {
					reportOutcome(ctx, outcome.value.result, credit.id, outcome.value.remainingCount);
					return;
				}
				const retry = await ctx.ui.confirm(
					"Couldn't reset usage",
					`${errorText(outcome.error)}\n\nTry again?`,
				);
				if (!retry) return;
			}
		},
	});

	pi.events.on(CODEX_USAGE_CHANGED_EVENT, () => {
		if (activeContext) void refreshExpiryWarning(activeContext);
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		clearWarningTimer();
		if (ctx.mode !== "tui") return;
		void refreshExpiryWarning(ctx);
		warningRefreshTimer = setInterval(() => void refreshExpiryWarning(ctx), WARNING_REFRESH_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		warningGeneration++;
		activeContext = undefined;
		clearWarningTimer();
		if (ctx.mode === "tui") ctx.ui.setWidget(WARNING_WIDGET, undefined);
	});
}
