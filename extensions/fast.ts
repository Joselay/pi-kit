import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorText, isRecord } from "./lib/util.ts";

const FAST_REQUEST_SERVICE_TIER = "priority";
const FAST_STATE_PATH = join(getAgentDir(), "fast.json");
export const CODEX_FAST_STATUS_KEY = "codex-fast";

type Model = ExtensionContext["model"];

type NotificationLevel = "info" | "warning" | "error";

// Fast-capable model slugs from the bundled Codex catalog (models.json); GPT-5.6
// only ships as the sol/terra/luna variants. Runtime catalog tier metadata takes
// precedence when Pi exposes it.
const CODEX_FAST_MODE_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;
const CODEX_FAST_MODE_MODELS = new Set<string>(CODEX_FAST_MODE_MODEL_IDS);

function isEnabledByEnv(): boolean {
	const value = process.env.PI_CODEX_FAST_MODE?.trim().toLowerCase();
	if (!value) return false;
	return value === "1" || value === "true" || value === "on" || value === "yes";
}

function readPersistedEnabled(): boolean | undefined {
	if (!existsSync(FAST_STATE_PATH)) return undefined;

	try {
		const parsed = JSON.parse(readFileSync(FAST_STATE_PATH, "utf8")) as unknown;
		if (isRecord(parsed) && typeof parsed.enabled === "boolean") return parsed.enabled;
	} catch {
		return undefined;
	}

	return undefined;
}

function initialEnabled(): boolean {
	return readPersistedEnabled() ?? isEnabledByEnv();
}

function writePersistedEnabled(enabled: boolean): void {
	writeFileSync(FAST_STATE_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

export function modelSupportsCodexFastMode(model: Model | undefined): boolean {
	if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;

	const catalogModel = model as unknown as Record<string, unknown>;
	const tiers = catalogModel.service_tiers ?? catalogModel.serviceTiers;
	if (Array.isArray(tiers)) {
		const hasPriorityTier = tiers.some((tier) =>
			typeof tier === "string" ? tier === FAST_REQUEST_SERVICE_TIER : isRecord(tier) && tier.id === FAST_REQUEST_SERVICE_TIER,
		);
		if (hasPriorityTier) return true;
	}

	// Deprecated catalog field that predates service_tiers; Codex still honors it.
	const legacyTiers = catalogModel.additional_speed_tiers ?? catalogModel.additionalSpeedTiers;
	if (Array.isArray(legacyTiers)) return legacyTiers.includes("fast");
	if (Array.isArray(tiers)) return false;

	return CODEX_FAST_MODE_MODELS.has(model.id);
}

function unsupportedModelMessage(model: Model | undefined): string {
	const modelName = model?.id ?? "current model";
	return `${modelName} does not support fast mode. Switch to a fast-capable enabled model to use /fast.`;
}

export default function fastMode(pi: ExtensionAPI) {
	let enabled = initialEnabled();

	function statusText(): string {
		return enabled ? "fast:on" : "fast:off";
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, statusText());
	}

	function notify(ctx: ExtensionContext, message: string, level: NotificationLevel): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = initialEnabled();
		// Materialize the initial (possibly env-derived) state once; afterwards the
		// file is the source of truth and only /fast toggles rewrite it.
		if (!existsSync(FAST_STATE_PATH)) {
			try {
				writePersistedEnabled(enabled);
			} catch (error) {
				notify(ctx, `Failed to save fast mode state: ${errorText(error)}`, "warning");
			}
		}
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") return;
		if (ctx.model.api !== "openai-codex-responses") return;
		if (!isRecord(event.payload)) return;

		return {
			...event.payload,
			// Codex uses "default" only as a config/UI sentinel; provider requests omit the field.
			service_tier: enabled && modelSupportsCodexFastMode(ctx.model) ? FAST_REQUEST_SERVICE_TIER : undefined,
		};
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode, or use on/off/status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && action !== "on" && action !== "off" && action !== "status") {
				notify(ctx, "Use /fast, /fast on, /fast off, or /fast status", "warning");
				return;
			}
			if (!modelSupportsCodexFastMode(ctx.model)) {
				notify(ctx, unsupportedModelMessage(ctx.model), "warning");
				return;
			}
			if (action === "status") {
				notify(ctx, enabled ? "Fast mode on" : "Fast mode off", "info");
				return;
			}

			const nextEnabled = action === "on" ? true : action === "off" ? false : !enabled;
			if (nextEnabled === enabled) {
				notify(ctx, enabled ? "Fast mode already on" : "Fast mode already off", "info");
				return;
			}
			enabled = nextEnabled;
			try {
				writePersistedEnabled(enabled);
			} catch (error) {
				notify(ctx, `Fast mode changed but failed to save state: ${errorText(error)}`, "warning");
			}
			updateStatus(ctx);
			notify(ctx, enabled ? "Fast mode on (1.5x speed, consumes usage limits ~2-2.5x faster)" : "Fast mode off", "info");
		},
	});
}
