import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROVIDER_ID = "openai-codex";
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "pi-usage/0.1.0";

function authFromAccessToken(access: string): { accountId?: string; isFedRamp: boolean } {
	try {
		const encoded = access.split(".")[1];
		if (!encoded) return { isFedRamp: false };
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
		const claim = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
		if (!isRecord(claim)) return { isFedRamp: false };
		const accountId = typeof claim.chatgpt_account_id === "string" ? claim.chatgpt_account_id : undefined;
		return { accountId: accountId || undefined, isFedRamp: claim.chatgpt_account_is_fedramp === true };
	} catch {
		return { isFedRamp: false };
	}
}

function codexApiBaseUrl(raw: string): string {
	let baseUrl = raw.trim().replace(/\/+$/, "");
	if (
		/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(baseUrl) &&
		!baseUrl.includes("/backend-api")
	) {
		baseUrl += "/backend-api";
	}
	return baseUrl;
}

async function requestUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<UsagePayload> {
	const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	const access = resolved?.auth.apiKey;
	if (!access) {
		const configured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
		throw new Error(configured
			? "Couldn't refresh OpenAI Codex credentials. Try /login again."
			: "Log in to OpenAI Codex with /login first.");
	}

	const configuredBase = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim();
	const baseUrl = codexApiBaseUrl(
		configuredBase || resolved.auth.baseUrl || ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl || CHATGPT_BASE_URL,
	);
	const headers = new Headers(
		Object.entries(resolved.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	headers.set("authorization", `Bearer ${access}`);
	const tokenAuth = authFromAccessToken(access);
	if (tokenAuth.accountId && !headers.has("chatgpt-account-id")) {
		headers.set("chatgpt-account-id", tokenAuth.accountId);
	}
	if (tokenAuth.isFedRamp && !headers.has("x-openai-fedramp")) {
		headers.set("x-openai-fedramp", "true");
	}
	headers.set("user-agent", USER_AGENT);

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const prefix = baseUrl.includes("/backend-api") ? "/wham" : "/api/codex";
	const response = await fetch(`${baseUrl}${prefix}/usage`, { headers, signal: requestSignal });
	const text = await response.text();
	if (!response.ok) {
		const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
		throw new Error(`GET /usage failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	if (!text.trim()) throw new Error("GET /usage returned an empty response");
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("GET /usage returned invalid JSON");
	}
	if (!isRecord(payload) || typeof payload.plan_type !== "string") {
		throw new Error("GET /usage returned an invalid payload");
	}
	return payload as UsagePayload;
}

type RateLimitWindow = {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds: number;
	reset_at: number;
};
type RateLimitDetails = {
	allowed: boolean;
	limit_reached: boolean;
	primary_window?: RateLimitWindow | null;
	secondary_window?: RateLimitWindow | null;
};
type AdditionalRateLimit = {
	limit_name: string;
	metered_feature: string;
	rate_limit?: RateLimitDetails | null;
};
type UsagePayload = {
	email?: string;
	plan_type: string;
	rate_limit?: RateLimitDetails | null;
	code_review_rate_limit?: RateLimitDetails | null;
	credits?: {
		has_credits: boolean;
		unlimited: boolean;
		overage_limit_reached?: boolean;
		balance?: string | null;
	} | null;
	spend_control?: {
		reached: boolean;
		individual_limit?: {
			limit: string;
			used: string;
			remaining_percent: number;
			reset_at: number;
		} | null;
	} | null;
	additional_rate_limits?: Array<AdditionalRateLimit> | null;
	rate_limit_reached_type?: { type?: string } | null;
	rate_limit_reset_credits?: { available_count?: number } | null;
};

const BAR_CELLS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

function codexPlanLabel(planType: string): string {
	const labels: Record<string, string> = {
		free: "Free",
		go: "Go",
		plus: "Plus",
		pro: "Pro",
		prolite: "Pro Lite",
		team: "Business",
		business: "Enterprise",
		self_serve_business_prolite: "Business",
		enterprise: "Enterprise",
		ent26: "Enterprise",
		enterprise_cbp_automation: "Enterprise (Automation)",
		edu: "Edu",
		education: "Edu",
		guest: "Guest",
		free_workspace: "Free workspace",
		self_serve_business_usage_based: "Business",
		enterprise_cbp_usage_based: "Enterprise",
		quorum: "Quorum",
		k12: "K-12",
	};
	return labels[planType.toLowerCase()] ?? planType;
}

function bar(ratio: number, width: number, theme: Theme): string {
	const cells = Math.max(1, width);
	const clamped = Math.min(1, Math.max(0, ratio));
	const full = Math.floor(clamped * cells);
	let filled = "█".repeat(full);
	let track = "";
	if (full < cells) {
		const remainder = clamped * cells - full;
		filled += BAR_CELLS[Math.floor(remainder * (BAR_CELLS.length - 1))] ?? " ";
		track = " ".repeat(Math.max(0, cells - full - 1));
	}
	return theme.bg("selectedBg", theme.fg("accent", filled) + track);
}

function lowerMeridiem(text: string): string {
	return text.replace(/ ([AP]M)/i, (_match, meridiem: string) => meridiem.toLowerCase());
}

function formatResetAt(epochSeconds: number, showTime: boolean, alwaysShowDate: boolean, now = Date.now()): string {
	const date = new Date(epochSeconds * 1000);
	const minutes = date.getMinutes();
	const hoursAway = (date.getTime() - now) / 3_600_000;
	const zone = ` (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

	if (alwaysShowDate || hoursAway > 24) {
		const options: Intl.DateTimeFormatOptions = {
			month: "short",
			day: "numeric",
			hour: showTime ? "numeric" : undefined,
			minute: !showTime || minutes === 0 ? undefined : "2-digit",
			hour12: showTime ? true : undefined,
		};
		if (date.getFullYear() !== new Date(now).getFullYear()) options.year = "numeric";
		return lowerMeridiem(date.toLocaleString("en-US", options)) + zone;
	}

	return (
		lowerMeridiem(date.toLocaleTimeString("en-US", { hour: "numeric", minute: minutes === 0 ? undefined : "2-digit", hour12: true })) +
		zone
	);
}

type Gauge = {
	title: string;
	utilization: number;
	resetsAt?: number;
	showTime?: boolean;
	alwaysShowDate?: boolean;
	extraSubtext?: string;
	trailing?: Array<{ text: string; color: "error" | "warning" }>;
};

type Header = {
	title: string;
	subtitle: string;
};
type Section = Header | Gauge;

function isGauge(section: Section): section is Gauge {
	return "utilization" in section;
}

function windowResetAt(window: RateLimitWindow, now = Date.now()): number | undefined {
	if (window.reset_at && window.reset_at > 0) return window.reset_at;
	if (window.reset_after_seconds && window.reset_after_seconds > 0) {
		return Math.floor(now / 1000) + window.reset_after_seconds;
	}
	return undefined;
}

function approximateDuration(seconds: number): string | undefined {
	const durations: Array<[number, string]> = [
		[5 * 60 * 60, "5h"],
		[24 * 60 * 60, "Daily"],
		[7 * 24 * 60 * 60, "Weekly"],
		[30 * 24 * 60 * 60, "Monthly"],
		[365 * 24 * 60 * 60, "Annual"],
	];
	return durations.find(([expected]) => seconds >= expected * 0.95 && seconds <= expected * 1.05)?.[1];
}

function gaugeForWindow(
	window: RateLimitWindow | null | undefined,
	scope: string | undefined,
	fallbackTitle: string,
): Gauge | undefined {
	if (!window) return undefined;
	const duration = approximateDuration(window.limit_window_seconds);
	const title = `${scope ? `${scope} ` : ""}${duration ?? fallbackTitle} limit`;
	return {
		title,
		utilization: window.used_percent,
		resetsAt: windowResetAt(window),
		alwaysShowDate: window.limit_window_seconds >= 24 * 60 * 60,
	};
}

function gaugesForLimit(details: RateLimitDetails | null | undefined, scope: string | undefined): Gauge[] {
	if (!details) return [];
	const gauges = [
		gaugeForWindow(details.primary_window, scope, "Usage"),
		gaugeForWindow(details.secondary_window, scope, "Secondary usage"),
	].filter((gauge): gauge is Gauge => gauge !== undefined);

	const last = gauges.at(-1);
	if (last) {
		if (details.limit_reached) last.trailing = [{ text: "Limit reached", color: "error" }];
		else if (details.allowed === false) last.trailing = [{ text: "Not allowed right now", color: "warning" }];
	}
	return gauges;
}

function limitScope(limit: AdditionalRateLimit): string {
	return limit.limit_name.trim() || limit.metered_feature.trim() || "Additional";
}

function creditAmount(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.round(value).toLocaleString("en-US");
}

function creditsText(credits: UsagePayload["credits"]): string | undefined {
	if (!credits) return undefined;
	if (credits.unlimited) return "Unlimited";
	if (!credits.has_credits) return undefined;
	const balance = creditAmount(credits.balance);
	const text = balance ? `${balance} credits` : "Available";
	return credits.overage_limit_reached ? `${text} · overage limit reached` : text;
}

function accountSectionFor(usage: UsagePayload): Header {
	const who = [usage.email?.trim(), `${codexPlanLabel(usage.plan_type)} plan`].filter(Boolean);
	return { title: "Account", subtitle: who.join(" · ") };
}

function limitSectionsFor(usage: UsagePayload): Section[] {
	const sections: Section[] = [];

	const extra = (usage.additional_rate_limits ?? []).filter((limit) => limit.rate_limit);
	const main = gaugesForLimit(usage.rate_limit, undefined);
	const reached = usage.rate_limit_reached_type?.type?.replace(/_/g, " ").trim();
	const lastMain = main[main.length - 1];
	if (reached && lastMain && !lastMain.trailing) {
		lastMain.trailing = [{ text: reached.charAt(0).toUpperCase() + reached.slice(1), color: "warning" }];
	}
	sections.push(...main);

	for (const limit of extra) sections.push(...gaugesForLimit(limit.rate_limit, limitScope(limit)));
	sections.push(...gaugesForLimit(usage.code_review_rate_limit, "code review"));

	const spend = usage.spend_control?.individual_limit;
	if (spend) {
		const used = creditAmount(spend.used);
		const limit = creditAmount(spend.limit);
		sections.push({
			title: "Monthly credit limit",
			utilization: 100 - spend.remaining_percent,
			resetsAt: spend.reset_at,
			showTime: false,
			alwaysShowDate: true,
			extraSubtext: used && limit ? `${used} of ${limit} credits used` : undefined,
			trailing: usage.spend_control?.reached ? [{ text: "Spend limit reached", color: "error" }] : undefined,
		});
	}

	const credits = creditsText(usage.credits);
	if (credits) sections.push({ title: "Credits", subtitle: credits });

	const resets = usage.rate_limit_reset_credits?.available_count ?? 0;
	if (resets > 0) {
		sections.push({
			title: "Usage limit resets",
			subtitle: `${resets} available · /reset to redeem`,
		});
	}

	return sections;
}

function gaugeSubtext(gauge: Gauge): string | undefined {
	const reset = gauge.resetsAt ? `Resets ${formatResetAt(gauge.resetsAt, gauge.showTime !== false, gauge.alwaysShowDate === true)}` : undefined;
	if (gauge.extraSubtext) return reset ? `${gauge.extraSubtext} · ${reset}` : gauge.extraSubtext;
	return reset;
}

function renderGauge(gauge: Gauge, theme: Theme, maxWidth: number): string[] {
	const remainingPercent = Math.max(0, Math.min(100, 100 - gauge.utilization));
	const remaining = `${Math.floor(remainingPercent)}% left`;
	const subtext = gaugeSubtext(gauge);
	const trailing = (gauge.trailing ?? []).map((line) =>
		theme.fg(line.color, line.text),
	);

	if (maxWidth >= 62) {
		return [
			theme.bold(gauge.title),
			`${bar(remainingPercent / 100, 50, theme)} ${remaining}`,
			...(subtext ? [theme.fg("dim", subtext)] : []),
			...trailing,
		];
	}

	return [
		theme.bold(gauge.title) + (subtext ? ` ${theme.fg("dim", `· ${subtext}`)}` : ""),
		...trailing,
		bar(remainingPercent / 100, maxWidth, theme),
		remaining,
	];
}

function renderSection(section: Section, theme: Theme, maxWidth: number): string[] {
	if (isGauge(section)) return renderGauge(section, theme, maxWidth);
	return [theme.bold(section.title), theme.fg("dim", section.subtitle)];
}

function renderPlainReport(usage: UsagePayload): string {
	const lines: string[] = [];
	for (const section of [accountSectionFor(usage), ...limitSectionsFor(usage)]) {
		if (!isGauge(section)) {
			lines.push(`${section.title}: ${section.subtitle}`);
			continue;
		}
		const subtext = gaugeSubtext(section)?.replace(/^Resets /, "resets ");
		const remaining = Math.max(0, Math.min(100, 100 - section.utilization));
		lines.push(`${section.title}: ${Math.floor(remaining)}% left${subtext ? ` · ${subtext}` : ""}`);
	}
	return lines.join("\n");
}

class UsageComponent implements Component {
	private cache?: { width: number; lines: string[] };

	constructor(
		private readonly usage: UsagePayload,
		private readonly theme: Theme,
		private readonly done: (action: "refresh" | "close") => void,
	) {}

	invalidate(): void {
		this.cache = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done("close");
			return;
		}
		if (data.toLowerCase() === "r") {
			this.done("refresh");
		}
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;

		const maxWidth = Math.max(1, Math.min(width, 80));
		const lines: string[] = [];

		lines.push(...renderSection(accountSectionFor(this.usage), this.theme, maxWidth));
		const sections = limitSectionsFor(this.usage);
		if (sections.length === 0) {
			lines.push("", this.theme.fg("dim", "No limit data available"));
		}
		for (const section of sections) {
			lines.push("");
			lines.push(...renderSection(section, this.theme, maxWidth));
		}
		lines.push("", this.theme.fg("dim", "r refresh · Esc close"));

		const rendered = lines.map((line) => truncateToWidth(line, width));
		this.cache = { width, lines: rendered };
		return rendered;
	}
}

export default function usage(pi: ExtensionAPI) {
	let busy = false;

	pi.registerCommand("usage", {
		description: "Show Codex plan limits and credits",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (busy) {
					if (ctx.hasUI) ctx.ui.notify("Already loading usage", "warning");
					return;
				}
				busy = true;
				try {
					const usage = await requestUsage(ctx);
					const content = renderPlainReport(usage);
					pi.sendMessage({ customType: "usage", content, display: true }, { triggerTurn: false });
				} catch (error) {
					const message = `Couldn't load usage: ${errorText(error)}`;
					if (ctx.hasUI) ctx.ui.notify(message, "error");
					else pi.sendMessage({ customType: "usage", content: message, display: true }, { triggerTurn: false });
				} finally {
					busy = false;
				}
				return;
			}

			while (true) {
				let loadError: string | undefined;
				const usage = await ctx.ui.custom<UsagePayload | null>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Loading usage data...");
					let settled = false;
					const finish = (value: UsagePayload | null) => {
						if (settled) return;
						settled = true;
						done(value);
					};
					loader.onAbort = () => finish(null);
					void requestUsage(ctx, loader.signal)
						.then(finish)
						.catch((error: unknown) => {
							loadError = errorText(error);
							finish(null);
						});
					return loader;
				});

				if (!usage) {
					if (!loadError) return;
					const retry = await ctx.ui.confirm("Couldn't load usage", `${loadError}\n\nRetry?`);
					if (!retry) return;
					continue;
				}

				const action = await ctx.ui.custom<"refresh" | "close">((tui, theme, _keybindings, done) => {
					const usageComponent = new UsageComponent(usage, theme, done);
					const content = new Box(2, 1);
					content.addChild(usageComponent);

					const container = new Container();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(content);
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							usageComponent.handleInput(data);
							tui.requestRender();
						},
					};
				});
				if (action !== "refresh") return;
			}
		},
	});
}
