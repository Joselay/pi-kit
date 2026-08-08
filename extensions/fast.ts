import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const FAST_REQUEST_SERVICE_TIER = "priority";
const FAST_STATE_FILE = "fast.json";
const CODEX_FAST_CHANGED_EVENT = "codex:fast-changed";

type CodexFastChanged = { active: boolean };
type Model = ExtensionContext["model"];
type NotifyLevel = "info" | "warning" | "error";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function statePath(): string {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const directory = join(cacheRoot, "pi", "fast");
	mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
	return join(directory, FAST_STATE_FILE);
}

function readState<T>(parse: (value: unknown) => T | undefined): T | undefined {
	let raw: string;
	try {
		raw = readFileSync(statePath(), "utf8");
	} catch {
		return undefined;
	}

	try {
		return parse(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function writeState(value: unknown): void {
	const target = statePath();
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
		renameSync(temporary, target);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

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
	return readState((value) =>
		isRecord(value) && typeof value.enabled === "boolean" ? value.enabled : undefined,
	);
}

function writePersistedEnabled(enabled: boolean): void {
	writeState({ enabled });
}

function modelSupportsCodexFastMode(model: Model | undefined): boolean {
	if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;

	const catalogModel = model as unknown as Record<string, unknown>;
	const tiers = catalogModel.service_tiers ?? catalogModel.serviceTiers;
	if (Array.isArray(tiers)) {
		const hasPriorityTier = tiers.some((tier) =>
			typeof tier === "string" ? tier === FAST_REQUEST_SERVICE_TIER : isRecord(tier) && tier.id === FAST_REQUEST_SERVICE_TIER,
		);
		if (hasPriorityTier) return true;
	}

	if (Array.isArray(tiers)) return false;

	return CODEX_FAST_MODE_MODELS.has(model.id);
}

function unsupportedModelMessage(model: Model | undefined): string {
	const modelName = model?.id ?? "current model";
	return `${modelName} does not support fast mode. Switch to a fast-capable enabled model to use /fast.`;
}

export default function fastMode(pi: ExtensionAPI) {
	let enabled = readPersistedEnabled() ?? isEnabledByEnv();

	function publishActiveState(ctx: ExtensionContext, model: Model | undefined = ctx.model): void {
		pi.events.emit(CODEX_FAST_CHANGED_EVENT, {
			active: enabled && modelSupportsCodexFastMode(model),
		} satisfies CodexFastChanged);
	}

	pi.on("session_start", (_event, ctx) => {
		const persisted = readPersistedEnabled();
		enabled = persisted ?? isEnabledByEnv();
		if (persisted === undefined) {
			try {
				writePersistedEnabled(enabled);
			} catch (error) {
				notify(ctx, `Failed to save fast mode state: ${errorText(error)}`, "warning");
			}
		}
		publishActiveState(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		publishActiveState(ctx, event.model);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") return;
		if (ctx.model.api !== "openai-codex-responses") return;
		if (!isRecord(event.payload)) return;

		return {
			...event.payload,
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
			publishActiveState(ctx);
			notify(ctx, enabled ? "Fast mode on (1.5x speed, consumes usage limits ~2-2.5x faster)" : "Fast mode off", "info");
		},
	});
}
