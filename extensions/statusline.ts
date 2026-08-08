import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type Model = ExtensionContext["model"];
type Paint = (text: string) => string;
type WindowKind = "session" | "weekly";
type UsageKind = "codex" | "spark" | "other";
type UsagePart = { label: string; used: number; window: WindowKind };
type UsageGroup = { id: string; kind: UsageKind; parts: UsagePart[] };
type Usage = { groups: UsageGroup[] };
type Bucket = { usedPercent?: number; windowDurationMins?: number | null };
type Limit = {
	limitId?: string | null;
	limitName?: string | null;
	primary?: Bucket | null;
	secondary?: Bucket | null;
};

const BAR_WIDTH = 10;
const WEEK_MINUTES = 10_080;
const CODEX_PROVIDER = "openai-codex";
const SPARK_MODEL = "gpt-5.3-codex-spark";
const FAST_EVENT = "codex:fast-changed";
const USAGE_EVENT = "codex:usage-changed";

function cleanStatus(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function shortenPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function contextLeft(usage: ContextUsage | undefined, modelWindow = 0): string {
	const window = usage?.contextWindow ?? modelWindow;
	return usage?.tokens == null || window <= 0
		? "Context ? left"
		: `Context ${formatTokens(Math.max(0, window - usage.tokens))} left`;
}

function renderBar(percent: number): string {
	const filled = Math.min(BAR_WIDTH, Math.max(0, Math.floor((percent * BAR_WIDTH) / 100)));
	return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function normalizeId(id: string): string {
	return id.trim().toLowerCase().replace(/-/g, "_");
}

function windowLabel(minutes: number | null | undefined, fallback: WindowKind): string {
	if (!minutes || minutes <= 0) return fallback === "weekly" ? "Weekly" : "Session";
	if (minutes === 300) return "Session";
	if (minutes === WEEK_MINUTES) return "Weekly";
	if (minutes % WEEK_MINUTES === 0) return `${minutes / WEEK_MINUTES}w`;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function usagePart(bucket: Bucket | null | undefined, fallback: WindowKind): UsagePart | undefined {
	if (bucket?.usedPercent === undefined || !Number.isFinite(bucket.usedPercent)) return undefined;
	const weekly = bucket.windowDurationMins != null && bucket.windowDurationMins >= WEEK_MINUTES;
	return {
		label: windowLabel(bucket.windowDurationMins, fallback),
		used: Math.max(0, Math.min(100, Math.round(bucket.usedPercent))),
		window: weekly ? "weekly" : fallback,
	};
}

function limitKind(limit: Limit, fallbackId: string): UsageKind {
	const id = normalizeId(limit.limitId ?? fallbackId);
	const name = limit.limitName?.toLowerCase() ?? "";
	if (name.includes("spark") || id.includes("bengalfox") || id.includes("spark")) return "spark";
	return id === "codex" ? "codex" : "other";
}

function usageFromLimits(limits: Limit[]): Usage | undefined {
	const groups = limits.flatMap((limit): UsageGroup[] => {
		const id = normalizeId(limit.limitId ?? "codex");
		const parts = [usagePart(limit.primary, "session"), usagePart(limit.secondary, "weekly")].filter(
			(part): part is UsagePart => part !== undefined,
		);
		return parts.length ? [{ id, kind: limitKind(limit, id), parts }] : [];
	});
	groups.sort((a, b) => (a.id === "codex" ? -1 : b.id === "codex" ? 1 : a.id.localeCompare(b.id)));
	return groups.length ? { groups } : undefined;
}

function usageFromBackend(payload: unknown): Usage | undefined {
	type Window = { used_percent?: number; limit_window_seconds?: number };
	type BackendLimit = { primary_window?: Window | null; secondary_window?: Window | null };
	type Backend = {
		rate_limit?: BackendLimit | null;
		additional_rate_limits?: Array<{
			limit_id?: string;
			limit_name?: string;
			metered_feature?: string;
			rate_limit?: BackendLimit | null;
		}> | null;
	};
	const data = payload as Backend | undefined;
	const convert = (id: string, name: string | undefined, limit: BackendLimit | null | undefined): Limit => ({
		limitId: id,
		limitName: name,
		primary: limit?.primary_window
			? { usedPercent: limit.primary_window.used_percent, windowDurationMins: (limit.primary_window.limit_window_seconds ?? 0) / 60 }
			: undefined,
		secondary: limit?.secondary_window
			? { usedPercent: limit.secondary_window.used_percent, windowDurationMins: (limit.secondary_window.limit_window_seconds ?? 0) / 60 }
			: undefined,
	});
	const limits = [convert("codex", undefined, data?.rate_limit)];
	for (const extra of data?.additional_rate_limits ?? []) {
		limits.push(convert(extra.limit_id ?? extra.metered_feature ?? "other", extra.limit_name, extra.rate_limit));
	}
	return usageFromLimits(limits);
}

function usageFromHeaders(headers: Record<string, string | undefined>): Usage | undefined {
	const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const ids = new Set<string>();
	for (const key of normalized.keys()) {
		const match = /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(key);
		if (match?.[1]) ids.add(normalizeId(match[1]));
	}
	const number = (key: string): number | undefined => {
		const value = Number(normalized.get(key));
		return Number.isFinite(value) ? value : undefined;
	};
	const bucket = (prefix: string, window: "primary" | "secondary"): Bucket | undefined => {
		const usedPercent = number(`${prefix}-${window}-used-percent`);
		if (usedPercent === undefined) return undefined;
		return { usedPercent, windowDurationMins: number(`${prefix}-${window}-window-minutes`) };
	};
	return usageFromLimits([...ids].map((id) => {
		const prefix = `x-${id.replace(/_/g, "-")}`;
		return {
			limitId: id,
			limitName: normalized.get(`${prefix}-limit-name`),
			primary: bucket(prefix, "primary"),
			secondary: bucket(prefix, "secondary"),
		};
	}));
}

function mergeUsage(current: Usage | undefined, update: Usage): Usage {
	const groups = new Map((current?.groups ?? []).map((group) => [group.id, group]));
	for (const group of update.groups) groups.set(group.id, group);
	return { groups: [...groups.values()] };
}

function visibleGroups(usage: Usage | undefined, model: Model | undefined): UsageGroup[] {
	if (!usage || model?.provider !== CODEX_PROVIDER) return [];
	const activeKind: UsageKind = model.id.toLowerCase() === SPARK_MODEL ? "spark" : "codex";
	return usage.groups.filter((group) => group.kind === activeKind);
}

async function fetchUsage(ctx: ExtensionContext): Promise<Usage | undefined> {
	const resolved = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER);
	const access = resolved?.auth.apiKey;
	if (!access) return undefined;
	let accountId: string | undefined;
	try {
		const jwt = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = jwt["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
		accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
	if (!accountId) return undefined;
	const configured = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim();
	const base = (configured || resolved.auth.baseUrl || ctx.modelRegistry.getProvider(CODEX_PROVIDER)?.baseUrl || "https://chatgpt.com/backend-api")
		.replace(/\/+$/, "").replace(/\/codex(?:\/responses)?$/, "");
	const prefix = base.includes("/backend-api") ? "/wham" : "/api/codex";
	const inherited = Object.fromEntries(Object.entries(resolved.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	const response = await fetch(`${base}${prefix}/usage`, {
		headers: { ...inherited, authorization: `Bearer ${access}`, "chatgpt-account-id": accountId, "user-agent": "pi-statusline/0.2.0" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return undefined;
	return usageFromBackend(await response.json());
}

export default function statusline(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let usage: Usage | undefined;
	let fastActive = false;
	let generation = 0;

	async function refreshUsage(ctx: ExtensionContext): Promise<void> {
		const current = ++generation;
		if (ctx.model?.provider !== CODEX_PROVIDER) return;
		try {
			const next = await fetchUsage(ctx);
			if (current === generation && next) {
				usage = next;
				requestRender?.();
			}
		} catch {
		}
	}

	function install(ctx: ExtensionContext): void {
		activeContext = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const color = {
				project: (text: string) => theme.fg("syntaxFunction", text),
				branch: (text: string) => theme.fg("syntaxNumber", text),
				model: (text: string) => theme.fg("syntaxKeyword", text),
				context: (text: string) => theme.fg("syntaxVariable", text),
				session: (text: string) => theme.fg("success", text),
				weekly: (text: string) => theme.fg("thinkingMax", text),
			};
			const statusColors: Paint[] = [
				color.session,
				color.branch,
				color.model,
				color.context,
				color.project,
				color.weekly,
			];
			const dim = (text: string) => theme.fg("dim", text);
			const separator = () => dim(" • ");
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);
			return {
				dispose() { unsubscribe(); requestRender = undefined; },
				invalidate() {},
				render(width: number): string[] {
					const model = activeContext?.model;
					const contextUsage = activeContext?.getContextUsage();
					const thinkingLevel = activeContext?.thinkingLevel ?? "off";
					const project = [color.project(shortenPath(activeContext?.cwd ?? ""))];
					const branch = footerData.getGitBranch();
					if (branch) project.push(color.branch(branch));
					let modelText = color.model(model?.id || "no-model");
					if (model?.reasoning) modelText += color.model(` (${thinkingLevel})`);
					if (fastActive) modelText += separator() + color.session("fast");
					const limits = visibleGroups(usage, model).flatMap((group) => group.parts.map((part) => {
						const remaining = Math.max(0, 100 - part.used);
						return (part.window === "weekly" ? color.weekly : color.session)(
							`${part.label} [${renderBar(remaining)}] ${remaining}% left`,
						);
					}));
					const line = [project.join(separator()), modelText, color.context(contextLeft(contextUsage, model?.contextWindow ?? 0)), ...limits].join(separator());
					const lines = [truncateToWidth(line, width, dim("..."))];
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text], index) => statusColors[index % statusColors.length]!(cleanStatus(text)))
						.join(dim(" "));
					if (statuses) lines.push(truncateToWidth(statuses, width, dim("...")));
					return lines;
				},
			};
		});
		if (ctx.model?.provider === CODEX_PROVIDER) void refreshUsage(ctx);
	}

	pi.events.on(USAGE_EVENT, (data: unknown) => {
		const update = data as Usage | undefined;
		if (update?.groups) { generation++; usage = update; requestRender?.(); }
		else if (activeContext) void refreshUsage(activeContext);
	});
	pi.events.on(FAST_EVENT, (data: unknown) => {
		fastActive = (data as { active?: boolean } | undefined)?.active === true;
		requestRender?.();
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== CODEX_PROVIDER) return;
		const update = usageFromHeaders(event.headers);
		if (update) { generation++; usage = mergeUsage(usage, update); requestRender?.(); }
	});
	pi.on("turn_end", (_event, ctx) => {
		if (ctx.model?.provider === CODEX_PROVIDER) void refreshUsage(ctx);
		requestRender?.();
	});
	pi.on("agent_settled", () => requestRender?.());
	pi.on("session_start", (_event, ctx) => install(ctx));
	pi.on("session_shutdown", () => {
		generation++;
		activeContext = undefined;
		requestRender = undefined;
		usage = undefined;
	});
	pi.on("model_select", (event, ctx) => {
		if (event.model.provider === CODEX_PROVIDER) void refreshUsage(ctx);
		else generation++;
		requestRender?.();
	});
	pi.on("thinking_level_select", () => requestRender?.());
	pi.on("message_end", () => requestRender?.());
	pi.on("session_compact", () => requestRender?.());
}
