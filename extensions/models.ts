/**
 * /models - live OpenAI Codex model catalog.
 *
 * pi ships a static `models-store.json`, so newly released Codex models stay
 * invisible until that snapshot is refreshed. This asks the ChatGPT backend for
 * the catalog it would actually serve this account right now
 * (`GET /backend-api/codex/models?client_version=...`, the same endpoint Codex
 * CLI's models-manager polls) and reports the per-model capability flags that
 * decide what the skills can rely on: hosted web search, apply_patch, shell
 * type, image input, reasoning levels, and context window.
 *
 * Auth is the pi `openai-codex` OAuth subscription resolved through the model
 * registry. OAuth only - no API-key fallback.
 *
 *   /models            live catalog, plus a diff against pi's models-store.json
 *   /models <slug>     every capability flag for one model
 *   /models raw        the raw /models payload
 */

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHATGPT_BASE_URL = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com/backend-api";
/**
 * The backend gates entries on `minimal_client_version`, so a stale value hides
 * new models. Bump (or set PI_CODEX_CLIENT_VERSION) when Codex CLI moves on.
 */
const CLIENT_VERSION = process.env.PI_CODEX_CLIENT_VERSION?.trim() || "0.144.0";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "pi-models/0.1.0";
const PROVIDER_ID = "openai-codex";

/** codex_protocol::openai_models::ModelInfo - serde names are the Rust names. */
type ModelInfo = {
	slug: string;
	display_name?: string;
	description?: string | null;
	visibility?: string;
	supported_in_api?: boolean;
	priority?: number;
	context_window?: number;
	max_context_window?: number;
	auto_compact_token_limit?: number | null;
	supports_search_tool?: boolean;
	web_search_tool_type?: string;
	apply_patch_tool_type?: string | null;
	shell_type?: string;
	input_modalities?: string[];
	support_verbosity?: boolean;
	default_verbosity?: string | null;
	supports_parallel_tool_calls?: boolean;
	use_responses_lite?: boolean;
	tool_mode?: string | null;
	multi_agent_version?: string | null;
	experimental_supported_tools?: string[];
	default_reasoning_level?: string | null;
	supported_reasoning_levels?: Array<{ effort?: string; description?: string }>;
	service_tiers?: Array<{ id?: string; name?: string }>;
	// Sent by the backend but absent from the Rust struct; useful here.
	available_in_plans?: string[];
	minimal_client_version?: string | number[];
	supports_reasoning_summaries?: boolean;
};

type ModelsResponse = { models?: ModelInfo[] };

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

async function fetchLiveModels(ctx: ExtensionCommandContext): Promise<ModelInfo[]> {
	const access = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	if (!access) {
		const configured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
		throw new Error(
			configured ? "Couldn't refresh OpenAI Codex credentials. Try /login again." : "Log in to OpenAI Codex with /login first.",
		);
	}
	const accountId = accountIdFromAccessToken(access);
	if (!accountId) throw new Error("OpenAI Codex credentials are invalid. Try /login again.");

	const headers: Record<string, string> = {
		authorization: `Bearer ${access}`,
		"chatgpt-account-id": accountId,
		originator: "pi",
		version: CLIENT_VERSION,
		"user-agent": USER_AGENT,
	};

	const base = CHATGPT_BASE_URL.replace(/\/+$/, "");
	const codexBase = base.endsWith("/codex") ? base : `${base}/codex`;
	const url = `${codexBase}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;

	const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	const text = await response.text();
	if (!response.ok) {
		const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
		throw new Error(`models request failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}
	let payload: ModelsResponse;
	try {
		payload = JSON.parse(text) as ModelsResponse;
	} catch {
		throw new Error("the models endpoint returned invalid JSON");
	}
	const models = payload.models ?? [];
	if (models.length === 0) throw new Error("the models endpoint returned no models");
	return models;
}

/** Model ids pi already knows about, so the diff can show what's new. */
function localModelIds(): { ids: Set<string>; available: boolean } {
	try {
		const raw = readFileSync(join(getAgentDir(), "models-store.json"), "utf8");
		const store = JSON.parse(raw) as Record<string, { models?: Array<{ id?: string }> }>;
		const ids = (store[PROVIDER_ID]?.models ?? [])
			.map((model) => model.id)
			.filter((id): id is string => typeof id === "string");
		return { ids: new Set(ids), available: true };
	} catch {
		return { ids: new Set(), available: false };
	}
}

function formatTokens(value: number | undefined): string | undefined {
	if (!value || value <= 0) return undefined;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(value);
}

/** The flags that actually change how a skill should call the model. */
function capabilityTags(model: ModelInfo): string[] {
	const tags: string[] = [];
	if (model.supports_search_tool) tags.push("search-tool");
	if (model.web_search_tool_type === "text_and_image") tags.push("web-search:text+image");
	else if (model.web_search_tool_type) tags.push(`web-search:${model.web_search_tool_type}`);
	if (model.apply_patch_tool_type) tags.push(`apply-patch:${model.apply_patch_tool_type}`);
	if (model.shell_type && model.shell_type !== "default") tags.push(`shell:${model.shell_type}`);
	if ((model.input_modalities ?? []).includes("image")) tags.push("image-input");
	if (model.support_verbosity) tags.push("verbosity");
	if (model.use_responses_lite) tags.push("responses-lite");
	if (model.tool_mode) tags.push(`tool-mode:${model.tool_mode}`);
	if (model.multi_agent_version) tags.push(`multi-agent:${model.multi_agent_version}`);
	for (const tool of model.experimental_supported_tools ?? []) tags.push(`experimental:${tool}`);
	return tags;
}

function renderCatalog(models: ModelInfo[]): string {
	const local = localModelIds();
	const liveIds = new Set(models.map((model) => model.slug));

	const lines: string[] = ["## Live Codex model catalog", ""];
	lines.push(`Backend served ${models.length} model(s) for client_version ${CLIENT_VERSION}.`);
	lines.push("");

	// Pickable models first, then by the backend's own ranking (priority 1 = flagship).
	const rank = (model: ModelInfo) => (model.visibility === "list" ? 0 : 1);
	const sorted = [...models].sort(
		(a, b) => rank(a) - rank(b) || (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || a.slug.localeCompare(b.slug),
	);
	for (const model of sorted) {
		const context = formatTokens(model.context_window ?? model.max_context_window);
		const header = [
			`**${model.slug}**`,
			model.display_name && model.display_name !== model.slug ? `(${model.display_name})` : undefined,
			local.available ? (local.ids.has(model.slug) ? undefined : "— **NEW**") : undefined,
		]
			.filter(Boolean)
			.join(" ");
		lines.push(`### ${header}`);

		const facts = [
			context ? `context ${context}` : undefined,
			model.visibility && model.visibility !== "list" ? `visibility ${model.visibility}` : undefined,
			model.default_reasoning_level ? `reasoning ${model.default_reasoning_level}` : undefined,
		].filter(Boolean);
		if (facts.length > 0) lines.push(facts.join(" • "));

		const efforts = (model.supported_reasoning_levels ?? [])
			.map((level) => level.effort)
			.filter((effort): effort is string => Boolean(effort));
		if (efforts.length > 0) lines.push(`Reasoning levels: ${efforts.join(", ")}`);

		const tags = capabilityTags(model);
		if (tags.length > 0) lines.push(`Capabilities: ${tags.join(", ")}`);

		if (model.available_in_plans?.length) lines.push(`Plans: ${model.available_in_plans.join(", ")}`);
		lines.push("");
	}

	if (local.available) {
		const added = [...liveIds].filter((slug) => !local.ids.has(slug));
		const removed = [...local.ids].filter((slug) => !liveIds.has(slug));
		lines.push("### Compared to models-store.json");
		if (added.length === 0 && removed.length === 0) {
			lines.push("- in sync");
		} else {
			for (const slug of added) lines.push(`- **${slug}** is live but missing from pi's store`);
			for (const slug of removed) lines.push(`- \`${slug}\` is in pi's store but no longer served`);
		}
	} else {
		lines.push("_models-store.json unreadable; skipped the diff._");
	}

	return lines.join("\n").trim();
}

function renderDetail(model: ModelInfo): string {
	const lines = [`## ${model.slug}`, ""];
	if (model.display_name) lines.push(`**${model.display_name}**`);
	if (model.description) lines.push("", model.description);
	lines.push("");

	const rows: Array<[string, string | undefined]> = [
		["Context window", formatTokens(model.context_window)],
		["Max context window", formatTokens(model.max_context_window)],
		["Auto-compact limit", formatTokens(model.auto_compact_token_limit ?? undefined)],
		["Visibility", model.visibility],
		["Priority", model.priority === undefined ? undefined : String(model.priority)],
		["Supported in API", model.supported_in_api === undefined ? undefined : String(model.supported_in_api)],
		["Shell type", model.shell_type],
		["Apply patch", model.apply_patch_tool_type ?? undefined],
		["Web search", model.web_search_tool_type],
		["Search tool", model.supports_search_tool === undefined ? undefined : String(model.supports_search_tool)],
		["Input modalities", model.input_modalities?.join(", ")],
		["Verbosity", model.support_verbosity ? (model.default_verbosity ?? "supported") : undefined],
		["Parallel tool calls", model.supports_parallel_tool_calls === undefined ? undefined : String(model.supports_parallel_tool_calls)],
		["Responses lite", model.use_responses_lite ? "true" : undefined],
		["Tool mode", model.tool_mode ?? undefined],
		["Multi-agent", model.multi_agent_version ?? undefined],
		["Default reasoning", model.default_reasoning_level ?? undefined],
		["Reasoning levels", (model.supported_reasoning_levels ?? []).map((level) => level.effort).filter(Boolean).join(", ")],
		["Service tiers", (model.service_tiers ?? []).map((tier) => tier.id ?? tier.name).filter(Boolean).join(", ")],
		["Experimental tools", model.experimental_supported_tools?.join(", ")],
		["Plans", model.available_in_plans?.join(", ")],
		[
			"Minimal client",
			Array.isArray(model.minimal_client_version) ? model.minimal_client_version.join(".") : model.minimal_client_version,
		],
	];

	for (const [label, value] of rows) {
		if (value) lines.push(`- **${label}:** ${value}`);
	}
	return lines.join("\n");
}

export default function models(pi: ExtensionAPI) {
	let busy = false;

	pi.registerCommand("models", {
		description: "Show the live OpenAI Codex model catalog and its capability flags",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (busy) {
				ctx.ui.notify("Already loading the model catalog", "warning");
				return;
			}
			busy = true;
			const status = (text?: string) => {
				if (ctx.hasUI) ctx.ui.setStatus("models", text);
			};
			try {
				status("◉ models: loading…");
				const live = await fetchLiveModels(ctx);
				const arg = args.trim();

				let content: string;
				if (arg.toLowerCase() === "raw") {
					content = `\`\`\`json\n${JSON.stringify({ models: live }, null, 2)}\n\`\`\``;
				} else if (arg) {
					const match =
						live.find((model) => model.slug.toLowerCase() === arg.toLowerCase()) ??
						live.find((model) => model.slug.toLowerCase().includes(arg.toLowerCase()));
					if (!match) {
						ctx.ui.notify(`No live model matches "${arg}"`, "warning");
						return;
					}
					content = renderDetail(match);
				} else {
					content = renderCatalog(live);
				}

				pi.sendMessage({ customType: "models-catalog", content, display: true }, { triggerTurn: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Couldn't load the model catalog: ${message}`, "error");
			} finally {
				busy = false;
				status(undefined);
			}
		},
	});
}
