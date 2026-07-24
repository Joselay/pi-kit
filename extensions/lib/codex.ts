// Shared OpenAI Codex (ChatGPT subscription) auth and backend-API helpers.
//
// Two auth paths exist on purpose:
// - resolveCodexAuth(ctx): pi's model-registry path, used by command extensions
//   (/account, /reset) so expired OAuth credentials refresh through pi itself.
// - resolveRealtimeOAuth(feature): the ModelRuntime path used by the realtime
//   voice extensions (/talk, /say, /translate, /dictate), which run outside a
//   provider request and need the raw bearer for the realtime WebSocket.

import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorText, isRecord } from "./util.ts";

export const PROVIDER_ID = "openai-codex";

// Same backend Codex CLI hits; the /wham prefix is the ChatGPT-auth path style
// (see codex-rs backend-client).
export const CHATGPT_BASE_URL = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 10_000;

/** Emitted after a server-side usage mutation so the footer can refresh. */
export const CODEX_USAGE_CHANGED_EVENT = "codex:usage-changed";

export type CodexAuth = { access: string; accountId: string };
export type OAuthCredentials = { token: string; accountId?: string };

/** The ChatGPT account id embedded in the access token's auth claim. */
export function accountIdFromAccessToken(access: string): string | undefined {
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

/** Codex credentials via pi's provider auth path (refreshes expired OAuth). */
export async function resolveCodexAuth(ctx: ExtensionContext): Promise<CodexAuth> {
	const access = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
	if (!access) {
		const configured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
		throw new Error(
			configured ? "Couldn't refresh OpenAI Codex credentials. Try /login again." : "Log in to OpenAI Codex with /login first.",
		);
	}
	const accountId = accountIdFromAccessToken(access);
	if (!accountId) throw new Error("OpenAI Codex credentials are invalid. Try /login again.");
	return { access, accountId };
}

// ModelRuntime.create() reads pi's own credential store; cache it so repeated
// resolutions do not pay the construction cost. getAuth() refreshes per call.
let runtimePromise: Promise<ModelRuntime> | undefined;

export function modelRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create();
	return runtimePromise;
}

/**
 * Resolves the `openai-codex` OAuth subscription through pi's ModelRuntime, so
 * the token comes from ~/.pi/agent/auth.json and refreshes on our behalf. The
 * ChatGPT access token carries `aud: https://api.openai.com/v1`, so the
 * realtime endpoints accept it. OAuth only — no API-key fallback.
 */
export async function resolveRealtimeOAuth(feature: string): Promise<OAuthCredentials> {
	let runtime: ModelRuntime;
	try {
		runtime = await modelRuntime();
	} catch (error) {
		// A failed create() must not poison every later attempt.
		runtimePromise = undefined;
		throw new Error(`could not load pi's model runtime (${errorText(error)}); run /login`);
	}

	let check;
	let token: string | undefined;
	try {
		check = await runtime.checkAuth(PROVIDER_ID);
		token = (await runtime.getAuth(PROVIDER_ID))?.auth?.apiKey;
	} catch (error) {
		throw new Error(`pi's openai-codex OAuth check failed (${errorText(error)}); run /login`);
	}
	if (!runtime.isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
		throw new Error(`${feature} needs the openai-codex OAuth subscription; run /login first`);
	}
	if (!token) throw new Error("could not resolve the OAuth token; run /login again");
	return { token, accountId: accountIdFromAccessToken(token) };
}

/**
 * Request against the ChatGPT `/wham` backend. GET when `body` is undefined,
 * POST otherwise. Throws on non-2xx with a trimmed detail; `allow404` maps a
 * 404 to undefined (endpoints that don't exist for every plan).
 */
export async function whamRequest(
	auth: CodexAuth,
	path: string,
	options: {
		userAgent: string;
		body?: unknown;
		signal?: AbortSignal;
		allow404?: boolean;
		/** Extra request headers (e.g. the cache-control opt-outs codex sends). */
		headers?: Record<string, string>;
	},
): Promise<unknown> {
	const method = options.body === undefined ? "GET" : "POST";
	const headers: Record<string, string> = {
		authorization: `Bearer ${auth.access}`,
		"chatgpt-account-id": auth.accountId,
		"user-agent": options.userAgent,
		...options.headers,
	};
	if (options.body !== undefined) headers["content-type"] = "application/json";

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(`${CHATGPT_BASE_URL}/wham${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
	});
	const text = await response.text();
	if (response.status === 404 && options.allow404) return undefined;
	if (!response.ok) {
		const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
		throw new Error(`${method} ${path} failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	// A few endpoints legitimately answer with an empty body.
	if (!text.trim()) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${method} ${path} returned invalid JSON`);
	}
}
