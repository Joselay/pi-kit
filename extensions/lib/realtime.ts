// Shared OpenAI realtime WebSocket plumbing for the voice extensions.
// Uses Node's global (undici) WebSocket, whose init options accept custom
// headers — no ws dependency needed.

import type { OAuthCredentials } from "./codex.ts";

export const CONNECT_TIMEOUT_MS = 10_000;

/** The bearer + originator headers the GA realtime endpoints expect. */
export function realtimeHeaders(creds: OAuthCredentials, feature: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${creds.token}`,
		originator: "pi",
		"user-agent": `pi-${feature} (${process.platform}; ${process.arch})`,
	};
	if (creds.accountId) headers["chatgpt-account-id"] = creds.accountId;
	return headers;
}

/** Opens a WebSocket and resolves once connected (or rejects on timeout/error). */
export async function openRealtimeSocket(
	url: string,
	headers: Record<string, string>,
	timeoutMessage = "realtime connection timed out",
): Promise<WebSocket> {
	const ws = new WebSocket(url, { headers });
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(timeoutMessage)), CONNECT_TIMEOUT_MS);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.addEventListener("error", (event) => {
			clearTimeout(timer);
			reject(new Error((event as { message?: string }).message ?? "websocket error"));
		});
	});
	return ws;
}

/**
 * JSON payload of a server event, or undefined when unparsable. Returns `any`
 * on purpose: realtime server events are dynamic JSON the callers switch on.
 */
export function parseServerEvent(event: { data?: unknown }): any {
	try {
		return JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
	} catch {
		return undefined;
	}
}

/** Send a JSON payload if the socket is open; swallow late-close races. */
export function sendJson(ws: WebSocket | undefined, payload: unknown): void {
	try {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	} catch {}
}
