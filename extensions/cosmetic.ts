/**
 * Cosmetic chrome, none of which changes what the agent does: the random image
 * header, the custom footer (project, model, context, Codex usage), whimsical
 * working messages, and the completion chime.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Image, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_FAST_STATUS_KEY, modelSupportsCodexFastMode } from "./fast";

const IMAGES_DIR = new URL("../images/", import.meta.url);
const WORKING_MESSAGES_PATH = new URL("../cosmetic/working-messages.json", import.meta.url);
const SOUND_PATH = join(getAgentDir(), "sounds", "notification.mp3");
const AUDIO_PLAYER = "/usr/bin/afplay";

function pickRandom<T>(items: readonly T[]): T {
	return items[Math.floor(Math.random() * items.length)]!;
}

function pickRandomImage() {
	const filename = pickRandom(readdirSync(IMAGES_DIR).filter((f) => f.endsWith(".png")));
	return {
		filename,
		base64: readFileSync(new URL(filename, IMAGES_DIR), "base64"),
	};
}

function installHeader(ctx: ExtensionContext) {
	const image = pickRandomImage();
	ctx.ui.setHeader((tui, theme) => {
		const component = new Image(
			image.base64,
			"image/png",
			{ fallbackColor: (text) => theme.fg("muted", text) },
			{
				filename: image.filename,
				maxWidthCells: 34,
				maxHeightCells: 18,
			},
		);
		return {
			render(width: number): string[] {
				const lines = component.render(width);
				// Terminal graphics always draw over text, so overlays (e.g. /btw)
				// can't cover the image. Blank it out while an overlay is open,
				// keeping the same height so the layout doesn't jump.
				if (tui.hasOverlay()) {
					return lines.map(() => "");
				}
				return lines;
			},
			invalidate: () => component.invalidate(),
		};
	});
}

function loadWorkingMessages(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(WORKING_MESSAGES_PATH, "utf8")) as unknown;
		if (Array.isArray(parsed)) return parsed.filter((message): message is string => typeof message === "string");
	} catch {
		// Fall through: a missing or corrupt asset just means Pi's default message.
	}
	return [];
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function lastPathSegment(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function fg(hex: string, text: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

const footerColors = {
	project: "#89B4FA", // Catppuccin blue
	branch: "#F9E2AF", // Catppuccin yellow
	sessionName: "#F5C2E7", // Catppuccin pink
	provider: "#BAC2DE", // Catppuccin subtext1
	model: "#FAB387", // Catppuccin peach
	fast: "#74C7EC", // Catppuccin sapphire
	thinking: "#CBA6F7", // Catppuccin mauve
	context: "#94E2D5", // Catppuccin teal
	codexSession: "#A6E3A1", // Catppuccin green
	codexWeekly: "#F38BA8", // Catppuccin red
	codexSpark: "#A6E3A1", // Catppuccin green (same as normal Codex usage)
	codexSparkWeekly: "#EBA0AC", // Catppuccin maroon
} as const;

const CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const CODEX_USAGE_CHANGED_EVENT = "codex:usage-changed";

type Model = ExtensionContext["model"];
type CodexBucket = { usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null };
type CodexLimit = {
	limitId?: string | null;
	limitName?: string | null;
	primary?: CodexBucket | null;
	secondary?: CodexBucket | null;
};
type CodexRateLimitsPayload = {
	rateLimits?: CodexLimit | null;
	rateLimitsByLimitId?: Record<string, CodexLimit | null> | null;
};
type CodexUsagePart = { label: string; remaining: number; resetEpoch?: number; color: string };
type CodexUsageKind = "codex" | "spark" | "other";
type CodexUsageGroup = { kind: CodexUsageKind; parts: CodexUsagePart[] };
type CodexUsage = { groups: CodexUsageGroup[] };
type AppServerMessage = { id?: number; method: string; params?: unknown };

function remainingPercent(used: number): number {
	return Math.max(0, Math.min(100, 100 - used));
}

function formatResetCountdown(epoch: number | undefined, now = Date.now()): string | undefined {
	if (!epoch || epoch <= 0) return undefined;

	const remainingMs = epoch * 1000 - now;
	if (remainingMs <= 0) return "now";

	const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function formatWindowLabel(durationMins: number | null | undefined, fallback: string): string {
	if (!durationMins || durationMins <= 0) return fallback;
	if (durationMins === 300) return "session";
	if (durationMins === 10080) return "weekly";
	if (durationMins % 10080 === 0) return `${durationMins / 10080}w`;
	if (durationMins % 1440 === 0) return `${durationMins / 1440}d`;
	if (durationMins % 60 === 0) return `${durationMins / 60}h`;
	return `${durationMins}m`;
}

function formatCodexUsagePart(part: CodexUsagePart, now = Date.now()): string {
	const resetCountdown = formatResetCountdown(part.resetEpoch, now);
	const resetText = resetCountdown ? ` ${resetCountdown}` : "";

	return `${part.label} ${part.remaining}%${resetText}`;
}

function codexLimitKind(limit: CodexLimit, fallbackId: string): CodexUsageKind {
	const label = limit.limitName?.trim().toLowerCase();
	const limitId = (limit.limitId ?? fallbackId).toLowerCase();
	// Spark's bucket is limit_id "codex_bengalfox" / limit_name "GPT-5.3-Codex-Spark";
	// limitName can be absent in sparse payloads, so match the id too.
	if (label?.includes("spark") || limitId.includes("bengalfox")) return "spark";
	if (limitId === "codex") return "codex";
	return "other";
}

function parseCodexLimit(limit: CodexLimit, fallbackId: string): CodexUsageGroup | undefined {
	const parts: CodexUsagePart[] = [];
	const kind = codexLimitKind(limit, fallbackId);
	const sessionColor = kind === "spark" ? footerColors.codexSpark : footerColors.codexSession;
	if (limit?.primary?.usedPercent !== undefined) {
		parts.push({
			label: formatWindowLabel(limit.primary.windowDurationMins, "session"),
			remaining: remainingPercent(limit.primary.usedPercent),
			resetEpoch: limit.primary.resetsAt ?? undefined,
			color: sessionColor,
		});
	}

	if (limit?.secondary?.usedPercent !== undefined) {
		parts.push({
			label: formatWindowLabel(limit.secondary.windowDurationMins, "weekly"),
			remaining: remainingPercent(limit.secondary.usedPercent),
			resetEpoch: limit.secondary.resetsAt ?? undefined,
			color: kind === "spark" ? footerColors.codexSparkWeekly : footerColors.codexWeekly,
		});
	}

	return parts.length > 0 ? { kind, parts } : undefined;
}

function parseCodexUsage(payload: any): CodexUsage | undefined {
	const data = payload as CodexRateLimitsPayload | undefined;
	const byLimitId = data?.rateLimitsByLimitId;
	const limits = new Map<string, CodexLimit>();

	if (data?.rateLimits) {
		limits.set(data.rateLimits.limitId ?? "codex", data.rateLimits);
	}
	if (byLimitId) {
		for (const [limitId, limit] of Object.entries(byLimitId)) {
			if (limit) limits.set(limitId, limit);
		}
	}

	const groups = Array.from(limits.entries())
		.sort(([a], [b]) => {
			if (a === "codex") return -1;
			if (b === "codex") return 1;
			return a.localeCompare(b);
		})
		.map(([limitId, limit]) => parseCodexLimit(limit, limitId))
		.filter((group): group is CodexUsageGroup => Boolean(group));

	return groups.length > 0 ? { groups } : undefined;
}

function modelUsesSparkLimit(model: Model | undefined): boolean {
	return model?.provider === "openai-codex" && model.id.toLowerCase() === CODEX_SPARK_MODEL_ID;
}

function isCodexModel(model: Model | undefined): boolean {
	return model?.provider === "openai-codex";
}

function visibleCodexUsageGroups(usage: CodexUsage | undefined, model: Model | undefined): CodexUsageGroup[] {
	if (!usage || model?.provider !== "openai-codex") return [];
	const targetKind: CodexUsageKind = modelUsesSparkLimit(model) ? "spark" : "codex";
	return usage.groups.filter((group) => group.kind === targetKind);
}

class CodexUsageClient {
	private child: ChildProcess | undefined;
	private buffer = "";
	private nextId = 1;
	private initializeId: number | undefined;
	private initialized = false;
	private rateLimitsRequestId: number | undefined;
	private rateLimitsRefreshPending = false;
	private rateLimitsRetryTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly onUsage: (usage: CodexUsage) => void,
		private readonly onStop: (client: CodexUsageClient) => void,
	) {}

	start(): void {
		if (this.child) return;

		const codexBinary = process.env.PEEK_CODEX_BIN?.trim() || "codex";
		const child: ChildProcess = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.child = child;

		const childEvents = child as ChildProcess & EventEmitter;
		childEvents.on("error", () => this.stop());
		childEvents.on("close", () => this.stop());
		child.stdout?.on("data", (chunk) => this.handleData(chunk.toString("utf8")));

		this.initializeId = this.nextId++;
		this.send({
			id: this.initializeId,
			method: "initialize",
			params: {
				clientInfo: { name: "pi-footer", title: "Pi Footer", version: "0.1.0" },
				capabilities: {},
			},
		});
	}

	refresh(): void {
		if (!this.initialized || this.rateLimitsRequestId !== undefined) {
			this.rateLimitsRefreshPending = true;
			return;
		}
		this.requestRateLimits();
	}

	stop(): void {
		if (this.rateLimitsRetryTimer) clearTimeout(this.rateLimitsRetryTimer);
		this.rateLimitsRetryTimer = undefined;
		if (!this.child) return;

		const child = this.child;
		this.child = undefined;
		this.initializeId = undefined;
		this.initialized = false;
		this.rateLimitsRequestId = undefined;
		this.rateLimitsRefreshPending = false;
		this.buffer = "";
		if (!child.killed) child.kill();
		this.onStop(this);
	}

	private handleData(data: string): void {
		this.buffer += data;
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line) continue;
			this.handleEnvelope(line);
		}
	}

	private handleEnvelope(line: string): void {
		let envelope: any;
		try {
			envelope = JSON.parse(line);
		} catch {
			return;
		}

		if (envelope.id === this.initializeId) {
			if (envelope.error) {
				// Restart with backoff via onStop instead of idling with a live child.
				this.stop();
				return;
			}
			this.initialized = true;
			this.send({ method: "initialized", params: {} });
			this.requestRateLimits();
			return;
		}

		if (envelope.id === this.rateLimitsRequestId) {
			this.rateLimitsRequestId = undefined;
			const usage = envelope.result ? parseCodexUsage(envelope.result) : undefined;
			if (usage) this.onUsage(usage);
			if (this.rateLimitsRefreshPending) {
				this.rateLimitsRefreshPending = false;
				this.requestRateLimits();
			} else if (envelope.error) {
				// Covers -32001 "Server overloaded; retry later" and transient failures.
				this.scheduleRateLimitsRetry();
			}
			return;
		}

		if (envelope.method === "account/rateLimits/updated") {
			// Updates are sparse. Refetch so absent secondary windows and other
			// limit buckets are not incorrectly treated as deleted.
			if (this.rateLimitsRequestId === undefined) this.requestRateLimits();
			else this.rateLimitsRefreshPending = true;
		}
	}

	private requestRateLimits(): void {
		if (!this.initialized || this.rateLimitsRequestId !== undefined) return;
		if (this.rateLimitsRetryTimer) clearTimeout(this.rateLimitsRetryTimer);
		this.rateLimitsRetryTimer = undefined;
		this.rateLimitsRequestId = this.nextId++;
		this.send({ id: this.rateLimitsRequestId, method: "account/rateLimits/read" });
	}

	private scheduleRateLimitsRetry(): void {
		if (this.rateLimitsRetryTimer || !this.child) return;
		this.rateLimitsRetryTimer = setTimeout(() => {
			this.rateLimitsRetryTimer = undefined;
			this.requestRateLimits();
		}, 10_000);
	}

	private send(message: AppServerMessage): void {
		this.child?.stdin?.write(JSON.stringify(message) + "\n");
	}
}

export default function (pi: ExtensionAPI) {
	const workingMessages = loadWorkingMessages();
	let soundWarned = false;
	let activeModel: Model;
	// Doubles as the footer-active flag: set while the footer is installed.
	let requestFooterRender: (() => void) | undefined;
	let codexUsage: CodexUsage | undefined;
	let codexClient: CodexUsageClient | undefined;
	let codexCountdownTimer: NodeJS.Timeout | undefined;
	let codexRestartTimer: NodeJS.Timeout | undefined;
	let codexRestartDelayMs = 1_000;

	function updateCodexCountdownTimer() {
		// Tick once a minute only while a reset countdown is on screen.
		const needsTicking =
			requestFooterRender !== undefined &&
			visibleCodexUsageGroups(codexUsage, activeModel).some((group) => group.parts.some((part) => part.resetEpoch));
		if (needsTicking && !codexCountdownTimer) {
			codexCountdownTimer = setInterval(() => requestFooterRender?.(), 60 * 1000);
		} else if (!needsTicking && codexCountdownTimer) {
			clearInterval(codexCountdownTimer);
			codexCountdownTimer = undefined;
		}
	}

	function clearCodexUsage() {
		codexUsage = undefined;
		updateCodexCountdownTimer();
		requestFooterRender?.();
	}

	function stopCodexUsageClient() {
		const client = codexClient;
		codexClient = undefined;
		client?.stop();
		if (codexRestartTimer) clearTimeout(codexRestartTimer);
		codexRestartTimer = undefined;
		codexRestartDelayMs = 1_000;
		clearCodexUsage();
	}

	function scheduleCodexUsageRestart() {
		if (codexRestartTimer || !requestFooterRender || !isCodexModel(activeModel)) return;
		const delay = codexRestartDelayMs;
		codexRestartDelayMs = Math.min(codexRestartDelayMs * 2, 30_000);
		codexRestartTimer = setTimeout(() => {
			codexRestartTimer = undefined;
			refreshCodexUsageClient();
		}, delay);
	}

	function refreshCodexUsageClient() {
		if (!requestFooterRender || !isCodexModel(activeModel)) {
			stopCodexUsageClient();
			return;
		}

		if (codexClient || codexRestartTimer) return;
		codexClient = new CodexUsageClient(
			(usage) => {
				codexRestartDelayMs = 1_000;
				codexUsage = usage;
				updateCodexCountdownTimer();
				requestFooterRender?.();
			},
			(client) => {
				if (codexClient !== client) return;
				codexClient = undefined;
				clearCodexUsage();
				scheduleCodexUsageRestart();
			},
		);
		codexClient.start();
	}

	function installFooter(ctx: ExtensionContext) {
		activeModel = ctx.model;

		// Component factories are TUI-only; ctx.hasUI is also true in RPC mode.
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			refreshCodexUsageClient();
			const unsubscribeBranch = footerData.onBranchChange(requestFooterRender);

			const dim = (text: string) => theme.fg("dim", text);
			const separator = () => dim(" • ");

			function projectSegment(): { plain: string; styled: string } {
				const projectName = lastPathSegment(ctx.cwd);
				let plain = projectName;
				let styled = fg(footerColors.project, projectName);
				const branch = footerData.getGitBranch();
				if (branch) {
					plain += ` • ${branch}`;
					styled += separator() + fg(footerColors.branch, branch);
				}
				const sessionName = pi.getSessionName();
				if (sessionName) {
					plain += ` • ${sessionName}`;
					styled += separator() + fg(footerColors.sessionName, sessionName);
				}
				return { plain, styled };
			}

			function modelSegment(model: Model | undefined, fastText: string | undefined, projectPlain: string, width: number): string {
				const segments: { text: string; color: string }[] = [{ text: model?.id || "no-model", color: footerColors.model }];
				if (fastText) segments.push({ text: fastText, color: footerColors.fast });
				if (model?.reasoning) {
					const thinkingLevel = pi.getThinkingLevel();
					segments.push({
						text: thinkingLevel === "off" ? "thinking off" : thinkingLevel,
						color: footerColors.thinking,
					});
				}

				const plain = segments.map((segment) => segment.text).join(" • ");
				const styled = segments.map((segment) => fg(segment.color, segment.text)).join(separator());

				if (footerData.getAvailableProviderCount() > 1 && model) {
					const providerPrefix = `(${model.provider}) `;
					if (visibleWidth(projectPlain) + 3 + visibleWidth(providerPrefix + plain) <= width) {
						return fg(footerColors.provider, providerPrefix) + styled;
					}
				}
				return styled;
			}

			function contextSegment(model: Model | undefined): string {
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const percentValue = contextUsage?.percent ?? 0;
				const tokens = contextUsage?.tokens;
				const used = tokens === null || tokens === undefined ? undefined : tokens;
				const left = used === undefined ? undefined : Math.max(0, contextWindow - used);
				const leftText = left === undefined ? "?" : formatTokens(left);
				const percentText =
					contextUsage?.percent === null || contextUsage?.percent === undefined ? "?" : `${contextUsage.percent.toFixed(1)}%`;
				const color = percentValue > 90 ? "#cc6666" : percentValue > 70 ? "#ffff00" : footerColors.context;
				return fg(color, `${percentText} (${leftText} left)`);
			}

			function codexSegment(model: Model | undefined): string {
				const groups = visibleCodexUsageGroups(codexUsage, model);
				if (groups.length === 0) return "";
				return (
					separator() +
					groups
						.map((group) => group.parts.map((part) => fg(part.color, formatCodexUsagePart(part))).join(separator()))
						.join(separator())
				);
			}

			function statusLine(extensionStatuses: ReadonlyMap<string, string>, width: number): string | undefined {
				const visibleStatuses = Array.from(extensionStatuses.entries()).filter(([key]) => key !== CODEX_FAST_STATUS_KEY);
				if (visibleStatuses.length === 0) return undefined;
				const statusColors: ThemeColor[] = ["success", "warning", "accent", "mdCode", "syntaxNumber", "syntaxString"];
				const line = visibleStatuses
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text], index) => theme.fg(statusColors[index % statusColors.length]!, sanitizeStatusText(text)))
					.join(dim(" "));
				return truncateToWidth(line, width, dim("..."));
			}

			return {
				dispose() {
					unsubscribeBranch();
					requestFooterRender = undefined;
					stopCodexUsageClient();
				},
				invalidate() {},
				render(width: number): string[] {
					const model = activeModel ?? ctx.model;
					const project = projectSegment();
					const extensionStatuses = footerData.getExtensionStatuses();
					const fastStatus = sanitizeStatusText(extensionStatuses.get(CODEX_FAST_STATUS_KEY) ?? "");
					const fastText = fastStatus === "fast:on" && modelSupportsCodexFastMode(model) ? "fast" : undefined;

					const headerLine = truncateToWidth(
						project.styled +
							separator() +
							modelSegment(model, fastText, project.plain, width) +
							separator() +
							contextSegment(model) +
							codexSegment(model),
						width,
						dim("..."),
					);

					const lines = [headerLine];
					const statuses = statusLine(extensionStatuses, width);
					if (statuses) lines.push(statuses);
					return lines;
				},
			};
		});
	}

	pi.events.on(CODEX_USAGE_CHANGED_EVENT, () => {
		codexClient?.refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		if (ctx.mode === "tui") installHeader(ctx);
	});

	pi.on("session_shutdown", async () => {
		requestFooterRender = undefined;
		stopCodexUsageClient();
	});

	pi.on("model_select", async (event) => {
		activeModel = event.model;
		refreshCodexUsageClient();
		updateCodexCountdownTimer();
		requestFooterRender?.();
	});

	pi.on("session_info_changed", async () => {
		requestFooterRender?.();
	});

	pi.on("thinking_level_select", async () => {
		requestFooterRender?.();
	});

	pi.on("message_end", async () => {
		requestFooterRender?.();
	});

	pi.on("session_compact", async () => {
		requestFooterRender?.();
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (workingMessages.length > 0) ctx.ui.setWorkingMessage(pickRandom(workingMessages));
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(); // Reset for next time
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const warn = (message: string) => {
			if (soundWarned) return;
			ctx.ui.notify(message, "warning");
			soundWarned = true;
		};

		if (!existsSync(SOUND_PATH)) {
			warn(`Notification sound missing: ${SOUND_PATH}`);
			return;
		}

		try {
			const result = await pi.exec(AUDIO_PLAYER, [SOUND_PATH], { timeout: 5_000 });
			if (result.code !== 0) warn("Failed to play notification sound");
		} catch {
			warn("Failed to play notification sound");
		}
	});
}
