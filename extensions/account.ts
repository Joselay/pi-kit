/**
 * /account - OpenAI Codex subscription introspection.
 *
 * Reports what the ChatGPT backend actually knows about the logged-in account:
 * plan tier, real rate-limit windows (not just the footer's percentages),
 * credit balance, spend controls, usage-reset credits, lifetime token stats,
 * workspace membership, and any enterprise-managed config pushed to this client.
 *
 * These are the `/wham/*` endpoints Codex CLI itself calls (see codex-rs
 * backend-client); the `/wham` prefix is the ChatGPT-auth path style. Auth is
 * the pi `openai-codex` OAuth subscription resolved through the model registry,
 * so credentials refresh normally and auth.json stays an implementation detail.
 * OAuth only - no API-key fallback.
 *
 *   /account          plan, limits, credits, and profile summary
 *   /account raw      the same data as raw JSON (for debugging)
 */

import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CHATGPT_BASE_URL = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "pi-account/0.1.0";

type CodexAuth = { access: string; accountId: string };

/** GET /wham/usage - rate_limit_status_payload.rs, flattened with reset credits. */
type RateLimitWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
};
type RateLimitDetails = {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: RateLimitWindow | null;
	secondary_window?: RateLimitWindow | null;
};
type UsagePayload = {
	plan_type?: string;
	rate_limit?: RateLimitDetails | null;
	/** Separate bucket for cloud code review; same shape, often null. */
	code_review_rate_limit?: RateLimitDetails | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		overage_limit_reached?: boolean;
		/** String on some accounts, a structured amount on others. */
		balance?: string | Record<string, unknown> | null;
	} | null;
	promo?: unknown;
	spend_control?: {
		reached?: boolean;
		individual_limit?: {
			source?: string | null;
			limit?: string;
			used?: string;
			remaining?: string;
			used_percent?: number;
			remaining_percent?: number;
			reset_at?: number;
		} | null;
	} | null;
	additional_rate_limits?: Array<{
		limit_name?: string;
		metered_feature?: string;
		rate_limit?: RateLimitDetails | null;
	}> | null;
	rate_limit_reached_type?: { type?: string } | null;
	rate_limit_reset_credits?: { available_count?: number; applicable_available_count?: number } | null;
};

type AccountsCheckPayload = {
	accounts?: Record<string, { account?: AccountRecord | null }> | AccountRecord[] | null;
	account_ordering?: string[] | null;
	default_account_id?: string | null;
};
type AccountRecord = {
	account_id?: string | null;
	id?: string | null;
	name?: string | null;
	structure?: string | null;
};

type ProfilePayload = {
	profile?: { username?: string | null; display_name?: string | null } | null;
	stats?: {
		lifetime_tokens?: number | null;
		peak_daily_tokens?: number | null;
		longest_running_turn_sec?: number | null;
		current_streak_days?: number | null;
		longest_streak_days?: number | null;
		total_threads?: number | null;
		fast_mode_usage_percentage?: number | null;
		total_skills_used?: number | null;
		unique_skills_used?: number | null;
		most_used_reasoning_effort?: string | null;
		most_used_reasoning_effort_percentage?: number | null;
		top_invocations?: Array<{
			type?: string;
			skill_name?: string | null;
			plugin_name?: string | null;
			usage_count?: number;
		}> | null;
		workspace_rank?: number | null;
		workspace_total_user_count?: number | null;
	} | null;
	metadata?: { stats_as_of?: string | null } | null;
};

/** Server-side Codex preferences; richer than the published struct. */
type SettingsPayload = {
	git_diff_mode?: string | null;
	branch_format?: string | null;
	code_review_preference?: string | null;
	code_review_trigger_policy?: string | null;
	exhaustive_code_review?: boolean | null;
	security_review?: boolean | null;
	alpha_opt_in?: boolean | null;
	allow_credits_for_code_reviews?: boolean | null;
	commit_attribution_enabled?: boolean | null;
};

type WorkspaceMessagesPayload = {
	messages?: Array<{
		message_id?: string;
		message_type?: string;
		message_body?: string;
		archived_at?: string | null;
	}> | null;
};

type TomlFragment = { id?: string; name?: string; contents?: string };
type DeliveredToml = {
	enterprise_managed?: TomlFragment[] | null;
	managed_layers?: { baseline?: TomlFragment[]; system_overlay?: TomlFragment[] } | null;
} | null;
type ConfigBundlePayload = { config_toml?: DeliveredToml; requirements_toml?: DeliveredToml };

type AccountSnapshot = {
	usage?: UsagePayload;
	accounts?: AccountsCheckPayload;
	profile?: ProfilePayload;
	settings?: SettingsPayload;
	workspaceMessages?: WorkspaceMessagesPayload;
	configBundle?: ConfigBundlePayload;
	errors: Record<string, string>;
};

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

async function resolveCodexAuth(ctx: ExtensionCommandContext): Promise<CodexAuth> {
	const access = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!access) {
		const configured = ctx.modelRegistry.getProviderAuthStatus("openai-codex").configured;
		throw new Error(
			configured ? "Couldn't refresh OpenAI Codex credentials. Try /login again." : "Log in to OpenAI Codex with /login first.",
		);
	}
	const accountId = accountIdFromAccessToken(access);
	if (!accountId) throw new Error("OpenAI Codex credentials are invalid. Try /login again.");
	return { access, accountId };
}

async function apiGet(auth: CodexAuth, path: string): Promise<unknown | undefined> {
	const response = await fetch(`${CHATGPT_BASE_URL}/wham${path}`, {
		method: "GET",
		headers: {
			authorization: `Bearer ${auth.access}`,
			"chatgpt-account-id": auth.accountId,
			"user-agent": USER_AGENT,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	// Not every endpoint exists for every plan; treat that as "no data", not failure.
	if (response.status === 404) return undefined;
	if (!response.ok) {
		const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
		throw new Error(`status ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	// A few of these endpoints legitimately answer with an empty body.
	if (!text.trim()) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("invalid JSON");
	}
}

/** Every endpoint is best-effort: one 404 shouldn't blank the whole report. */
async function loadSnapshot(auth: CodexAuth): Promise<AccountSnapshot> {
	const snapshot: AccountSnapshot = { errors: {} };
	const requests: Array<[keyof AccountSnapshot, string]> = [
		["usage", "/usage"],
		["accounts", "/accounts/check"],
		["profile", "/profiles/me"],
		["settings", "/settings/user"],
		["workspaceMessages", "/workspace-messages"],
		["configBundle", "/config/bundle"],
	];

	await Promise.all(
		requests.map(async ([key, path]) => {
			try {
				const payload = await apiGet(auth, path);
				if (payload !== undefined) (snapshot as Record<string, unknown>)[key] = payload;
			} catch (error) {
				snapshot.errors[path] = error instanceof Error ? error.message : String(error);
			}
		}),
	);
	return snapshot;
}

const PLAN_LABELS: Record<string, string> = {
	free: "Free",
	go: "Go",
	plus: "Plus",
	pro: "Pro",
	prolite: "Pro Lite",
	team: "Team",
	business: "Business",
	enterprise: "Enterprise",
	edu: "Edu",
	education: "Edu",
	guest: "Guest",
	free_workspace: "Free workspace",
	self_serve_business_usage_based: "Business (usage-based)",
	enterprise_cbp_usage_based: "Enterprise (usage-based)",
	quorum: "Quorum",
	k12: "K-12",
	hc: "Enterprise",
};

export function planLabel(planType: string | undefined): string {
	if (!planType) return "unknown";
	return PLAN_LABELS[planType.toLowerCase()] ?? planType;
}

/** Mirrors the footer's window naming: 300min -> session, 10080min -> weekly. */
export function formatWindow(seconds: number | undefined): string {
	if (!seconds || seconds <= 0) return "window";
	const minutes = Math.ceil(seconds / 60);
	if (minutes === 300) return "5h";
	if (minutes === 10080) return "weekly";
	if (minutes % 10080 === 0) return `${minutes / 10080}w`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

export function formatCountdown(resetAt: number | undefined, now = Date.now()): string | undefined {
	if (!resetAt || resetAt <= 0) return undefined;
	const remainingMs = resetAt * 1000 - now;
	if (remainingMs <= 0) return "now";
	const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function formatWindowLine(label: string, window: RateLimitWindow | null | undefined): string | undefined {
	if (!window || window.used_percent === undefined) return undefined;
	const used = window.used_percent;
	const remaining = Math.max(0, Math.min(100, 100 - used));
	const scope = formatWindow(window.limit_window_seconds);
	const countdown = formatCountdown(window.reset_at);
	const resetText = countdown ? `, resets in ${countdown}` : "";
	return `- ${label} (${scope}): ${remaining}% left — ${used}% used${resetText}`;
}

function formatLimitBlock(details: RateLimitDetails | null | undefined): string[] {
	if (!details) return [];
	const lines: string[] = [];
	const primary = formatWindowLine("primary", details.primary_window);
	const secondary = formatWindowLine("secondary", details.secondary_window);
	if (primary) lines.push(primary);
	if (secondary) lines.push(secondary);
	if (details.limit_reached) lines.push("- **limit reached**");
	else if (details.allowed === false) lines.push("- **not allowed right now**");
	return lines;
}

function formatNumber(value: number | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	return value.toLocaleString("en-US");
}

function renderReport(snapshot: AccountSnapshot): string {
	const lines: string[] = [];
	const usage = snapshot.usage;

	lines.push("## OpenAI Codex account");
	lines.push("");

	const who = snapshot.profile?.profile;
	const whoText = who?.display_name?.trim() || who?.username?.trim();
	if (whoText) lines.push(`**User:** ${whoText}`);
	lines.push(`**Plan:** ${planLabel(usage?.plan_type)}`);

	// Which workspace this token is scoped to, and whether it's personal.
	const accounts = snapshot.accounts;
	if (accounts) {
		const records: AccountRecord[] = Array.isArray(accounts.accounts)
			? accounts.accounts
			: Object.values(accounts.accounts ?? {})
					.map((entry) => entry?.account)
					.filter((record): record is AccountRecord => Boolean(record));
		const defaultId = accounts.default_account_id ?? undefined;
		const active = records.find((record) => (record.account_id ?? record.id) === defaultId) ?? records[0];
		if (active) {
			const name = active.name?.trim();
			const structure = active.structure?.trim();
			const descriptor = [name || active.account_id || active.id, structure ? `(${structure})` : undefined]
				.filter(Boolean)
				.join(" ");
			if (descriptor) lines.push(`**Account:** ${descriptor}`);
		}
		if (records.length > 1) lines.push(`**Workspaces available:** ${records.length}`);
	}

	const credits = usage?.credits;
	if (credits) {
		const balance = typeof credits.balance === "string" ? credits.balance : undefined;
		const creditText = credits.unlimited ? "unlimited" : balance ? balance : credits.has_credits ? "available" : "none";
		const overage = credits.overage_limit_reached ? " — **overage limit reached**" : "";
		lines.push(`**Credits:** ${creditText}${overage}`);
	}

	const resets = usage?.rate_limit_reset_credits;
	if (resets?.available_count !== undefined) {
		const applicable =
			resets.applicable_available_count !== undefined && resets.applicable_available_count !== resets.available_count
				? ` (${resets.applicable_available_count} applicable now)`
				: "";
		const hint = resets.available_count > 0 ? " — redeem with `/reset`" : "";
		lines.push(`**Usage-limit resets:** ${resets.available_count} available${applicable}${hint}`);
	}

	const reached = usage?.rate_limit_reached_type?.type;
	if (reached) lines.push(`**Rate limit state:** ${reached.replace(/_/g, " ")}`);

	// Rate limits: the real windows behind the footer percentages.
	const limitLines = formatLimitBlock(usage?.rate_limit);
	if (limitLines.length > 0) {
		lines.push("", "### Rate limits", ...limitLines);
	}

	const codeReviewLines = formatLimitBlock(usage?.code_review_rate_limit);
	if (codeReviewLines.length > 0) {
		lines.push("", "### Code review limits", ...codeReviewLines);
	}

	for (const extra of usage?.additional_rate_limits ?? []) {
		const extraLines = formatLimitBlock(extra.rate_limit);
		if (extraLines.length === 0) continue;
		const title = extra.limit_name || extra.metered_feature || "additional limit";
		lines.push("", `### ${title}`, ...extraLines);
	}

	const spend = usage?.spend_control?.individual_limit;
	if (spend) {
		const parts = [`${spend.used ?? "?"} / ${spend.limit ?? "?"} used`];
		if (spend.remaining) parts.push(`${spend.remaining} remaining`);
		const countdown = formatCountdown(spend.reset_at);
		if (countdown) parts.push(`resets in ${countdown}`);
		lines.push("", "### Spend control", `- ${parts.join(", ")}`);
		if (usage?.spend_control?.reached) lines.push("- **spend limit reached**");
	}

	const stats = snapshot.profile?.stats;
	if (stats) {
		const percent = (value: number | null | undefined) =>
			value === null || value === undefined ? undefined : `${value.toFixed(1)}%`;
		const statLines = [
			["Lifetime tokens", formatNumber(stats.lifetime_tokens)],
			["Peak daily tokens", formatNumber(stats.peak_daily_tokens)],
			["Threads", formatNumber(stats.total_threads)],
			["Longest turn", stats.longest_running_turn_sec ? `${stats.longest_running_turn_sec}s` : undefined],
			["Current streak", stats.current_streak_days ? `${stats.current_streak_days}d` : undefined],
			["Longest streak", stats.longest_streak_days ? `${stats.longest_streak_days}d` : undefined],
			["Fast mode", percent(stats.fast_mode_usage_percentage)],
			[
				"Usual reasoning",
				stats.most_used_reasoning_effort
					? `${stats.most_used_reasoning_effort}${
							stats.most_used_reasoning_effort_percentage ? ` (${percent(stats.most_used_reasoning_effort_percentage)})` : ""
						}`
					: undefined,
			],
			[
				"Skills used",
				stats.total_skills_used
					? `${stats.total_skills_used}${stats.unique_skills_used ? ` (${stats.unique_skills_used} unique)` : ""}`
					: undefined,
			],
			[
				"Workspace rank",
				stats.workspace_rank
					? `#${stats.workspace_rank}${stats.workspace_total_user_count ? ` of ${stats.workspace_total_user_count}` : ""}`
					: undefined,
			],
		]
			.filter((entry): entry is [string, string] => Boolean(entry[1]))
			.map(([label, value]) => `- ${label}: ${value}`);

		if (statLines.length > 0) {
			const asOf = snapshot.profile?.metadata?.stats_as_of;
			lines.push("", `### Profile${asOf ? ` (as of ${asOf})` : ""}`, ...statLines);
		}

		const top = (stats.top_invocations ?? [])
			.map((entry) => {
				const name = entry.skill_name || entry.plugin_name;
				return name ? `${name}${entry.usage_count ? ` ×${entry.usage_count}` : ""}` : undefined;
			})
			.filter((entry): entry is string => Boolean(entry))
			.slice(0, 8);
		if (top.length > 0) lines.push(`- Most used: ${top.join(", ")}`);
	}

	const messages = (snapshot.workspaceMessages?.messages ?? []).filter((message) => !message.archived_at);
	if (messages.length > 0) {
		lines.push("", "### Workspace messages");
		for (const message of messages) {
			const body = (message.message_body ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
			if (body) lines.push(`- ${body}`);
		}
	}

	// Enterprise-managed config, when the workspace pushes one. Personal plans
	// get an empty bundle here, so only render it when fragments exist.
	const fragments = [
		...(snapshot.configBundle?.config_toml?.enterprise_managed ?? []),
		...(snapshot.configBundle?.requirements_toml?.enterprise_managed ?? []),
	];
	if (fragments.length > 0) {
		lines.push("", "### Managed config");
		for (const fragment of fragments) lines.push(`- ${fragment.name || fragment.id || "fragment"}`);
	}

	// Server-side Codex preferences; `alpha_opt_in` is the one that gates early features.
	const settings = snapshot.settings;
	if (settings) {
		const flag = (value: boolean | null | undefined) => (value === null || value === undefined ? undefined : value ? "on" : "off");
		const settingLines = [
			["Alpha opt-in", flag(settings.alpha_opt_in)],
			["Code review", settings.code_review_preference ?? undefined],
			["Review trigger", settings.code_review_trigger_policy ?? undefined],
			["Exhaustive review", flag(settings.exhaustive_code_review)],
			["Security review", flag(settings.security_review)],
			["Credits for reviews", flag(settings.allow_credits_for_code_reviews)],
			["Commit attribution", flag(settings.commit_attribution_enabled)],
			["Diff mode", settings.git_diff_mode ?? undefined],
			["Branch format", settings.branch_format ?? undefined],
		]
			.filter((entry): entry is [string, string] => Boolean(entry[1]))
			.map(([label, value]) => `- ${label}: ${value}`);
		if (settingLines.length > 0) lines.push("", "### Codex settings", ...settingLines);
	}

	const errorEntries = Object.entries(snapshot.errors);
	if (errorEntries.length > 0) {
		lines.push("", "### Unavailable");
		for (const [path, message] of errorEntries) lines.push(`- \`${path}\`: ${message}`);
	}

	return lines.join("\n");
}

export default function account(pi: ExtensionAPI) {
	let busy = false;

	pi.registerCommand("account", {
		description: "Show OpenAI Codex plan, rate limits, credits, and profile",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (busy) {
				ctx.ui.notify("Already loading account info", "warning");
				return;
			}
			const mode = args.trim().toLowerCase();
			if (mode && mode !== "raw") {
				ctx.ui.notify("Usage: /account [raw]", "warning");
				return;
			}

			busy = true;
			const status = (text?: string) => {
				if (ctx.hasUI) ctx.ui.setStatus("account", text);
			};
			try {
				status("◉ account: loading…");
				const auth = await resolveCodexAuth(ctx);
				const snapshot = await loadSnapshot(auth);

				const content =
					mode === "raw"
						? `\`\`\`json\n${JSON.stringify({ ...snapshot, errors: undefined }, null, 2)}\n\`\`\``
						: renderReport(snapshot);

				pi.sendMessage({ customType: "account-info", content, display: true }, { triggerTurn: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Couldn't load account info: ${message}`, "error");
			} finally {
				busy = false;
				status(undefined);
			}
		},
	});
}
