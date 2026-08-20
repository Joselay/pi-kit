import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Box, Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const PROVIDER = "openai-codex";
const AUTH_PATH = join(getAgentDir(), "auth.json");
const CACHE_ROOT = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const VAULT_PATH = join(CACHE_ROOT, "pi", "codex-accounts.json");
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type Credential = OAuthCredential & { accountId?: string };
type Vault = { activeAccountId: string; accounts: Record<string, Credential> };
type Claims = { accountId?: string; email?: string; plan?: string };
type UsageWindow = { used_percent?: number; limit_window_seconds?: number };
type Usage = {
	email?: string;
	plan_type?: string;
	rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null } | null;
};
type Snapshot = { accountId: string; credential: Credential; usage?: Usage; error?: string };

function isCredential(value: unknown): value is Credential {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return item.type === "oauth" && typeof item.access === "string" && typeof item.refresh === "string" && typeof item.expires === "number";
}

function claims(access: string): Claims {
	try {
		const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
		const profile = payload["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
		const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
		return {
			accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
			email: typeof profile?.email === "string" ? profile.email : undefined,
			plan: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
		};
	} catch {
		return {};
	}
}

function readActiveCredential(): Credential | undefined {
	const credential = readStoredCredential(PROVIDER, AUTH_PATH);
	return isCredential(credential) ? credential : undefined;
}

function readVault(): Vault | undefined {
	try {
		const value = JSON.parse(readFileSync(VAULT_PATH, "utf8")) as Partial<Vault>;
		if (!value.accounts || typeof value.accounts !== "object") return undefined;
		const accounts = Object.fromEntries(Object.entries(value.accounts).filter((entry): entry is [string, Credential] => isCredential(entry[1])));
		const ids = Object.keys(accounts);
		if (ids.length === 0) return undefined;
		const activeAccountId = typeof value.activeAccountId === "string" && accounts[value.activeAccountId] ? value.activeAccountId : ids[0]!;
		return { activeAccountId, accounts };
	} catch {
		return undefined;
	}
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

async function writeActiveCredential(credential: Credential): Promise<void> {
	let auth: Record<string, unknown> = {};
	try {
		const value = JSON.parse(await readFile(AUTH_PATH, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth.json is not an object");
		auth = value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await atomicJsonWrite(AUTH_PATH, { ...auth, [PROVIDER]: credential });
}

async function createVault(): Promise<Vault> {
	const credential = readActiveCredential();
	if (!credential) throw new Error("Log in to OpenAI Codex with /login first");
	const accountId = claims(credential.access).accountId ?? credential.accountId;
	if (!accountId) throw new Error("OpenAI Codex credentials are invalid");
	const created = { activeAccountId: accountId, accounts: { [accountId]: credential } };
	await atomicJsonWrite(VAULT_PATH, created);
	return created;
}

function planLabel(plan: string | undefined): string {
	if (!plan) return "Unknown plan";
	const labels: Record<string, string> = { plus: "Plus", pro: "Pro", prolite: "Pro Lite", free: "Free", business: "Business", team: "Team" };
	return `${labels[plan.toLowerCase()] ?? plan} plan`;
}

function windowLabel(window: UsageWindow | null | undefined): string | undefined {
	if (window?.used_percent === undefined) return undefined;
	const name = (window.limit_window_seconds ?? 0) >= 24 * 60 * 60 ? "weekly" : "session";
	return `${name} ${Math.max(0, Math.floor(100 - window.used_percent))}% left`;
}

function snapshotDescription(snapshot: Snapshot): string {
	const token = claims(snapshot.credential.access);
	return [
		planLabel(snapshot.usage?.plan_type ?? token.plan),
		windowLabel(snapshot.usage?.rate_limit?.primary_window),
		windowLabel(snapshot.usage?.rate_limit?.secondary_window),
		snapshot.error,
	].filter(Boolean).join(" · ");
}

export default function accountExtension(pi: ExtensionAPI): void {
	let vault: Vault | undefined = readVault();
	let builtinOAuth: OAuthAuth | undefined;
	let initialization: Promise<Vault> | undefined;
	let vaultMutation = Promise.resolve();
	const refreshes = new Map<string, Promise<Credential>>();

	async function ensureVault(): Promise<Vault> {
		const stored = readVault();
		if (stored) {
			vault = stored;
			return stored;
		}
		if (vault) return vault;
		initialization ??= createVault();
		try {
			vault = await initialization;
			return vault;
		} catch (error) {
			initialization = undefined;
			throw error;
		}
	}

	async function updateVault(update: (current: Vault) => Vault): Promise<Vault> {
		const operation = vaultMutation.then(async () => {
			const next = update(await ensureVault());
			await atomicJsonWrite(VAULT_PATH, next);
			vault = next;
			return next;
		});
		vaultMutation = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async function syncCurrentLogin(): Promise<Vault> {
		const current = await ensureVault();
		const credential = readActiveCredential();
		if (!credential) return current;
		const accountId = claims(credential.access).accountId ?? credential.accountId;
		if (!accountId) return current;
		const stored = current.accounts[accountId];
		const latest = stored && stored.expires > credential.expires ? stored : credential;
		if (latest !== credential) await writeActiveCredential(latest);
		if (
			current.activeAccountId === accountId
			&& stored
			&& stored.access === latest.access
			&& stored.refresh === latest.refresh
			&& stored.expires === latest.expires
		) return current;
		return updateVault((newest) => {
			const saved = newest.accounts[accountId];
			const selected = saved && saved.expires > latest.expires ? saved : latest;
			return { activeAccountId: accountId, accounts: { ...newest.accounts, [accountId]: selected } };
		});
	}

	async function ensureFresh(accountId: string, credential: Credential, signal?: AbortSignal): Promise<Credential> {
		const current = await ensureVault();
		const latest = current.accounts[accountId] ?? credential;
		if (latest.expires > Date.now() + REFRESH_MARGIN_MS) return latest;
		const pending = refreshes.get(accountId);
		if (pending) return pending;
		const refresh = (async () => {
			const oauth = builtinOAuth;
			if (!oauth) throw new Error("OpenAI Codex OAuth provider unavailable");
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const refreshSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const refreshed = await oauth.refresh(latest, refreshSignal) as Credential;
			const refreshedAccountId = claims(refreshed.access).accountId ?? refreshed.accountId;
			if (refreshedAccountId && refreshedAccountId !== accountId) throw new Error("refreshed token belongs to a different account");
			const newest = await updateVault((currentVault) => {
				const saved = currentVault.accounts[accountId];
				const selected = saved && saved.expires > refreshed.expires ? saved : refreshed;
				return { ...currentVault, accounts: { ...currentVault.accounts, [accountId]: selected } };
			});
			return newest.accounts[accountId]!;
		})();
		refreshes.set(accountId, refresh);
		try {
			return await refresh;
		} finally {
			if (refreshes.get(accountId) === refresh) refreshes.delete(accountId);
		}
	}

	async function fetchUsage(accountId: string, credential: Credential, signal?: AbortSignal): Promise<Snapshot> {
		try {
			const fresh = await ensureFresh(accountId, credential, signal);
			const token = claims(fresh.access);
			if (!token.accountId) throw new Error("invalid account token");
			const base = (process.env.PI_CODEX_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com/backend-api")
				.replace(/\/+$/, "").replace(/\/codex(?:\/responses)?$/, "");
			const prefix = base.includes("/backend-api") ? "/wham" : "/api/codex";
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const response = await fetch(`${base}${prefix}/usage`, {
				headers: { authorization: `Bearer ${fresh.access}`, "chatgpt-account-id": token.accountId, "user-agent": "pi-account/0.2.0" },
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (!response.ok) throw new Error(`usage HTTP ${response.status}`);
			return { accountId, credential: fresh, usage: await response.json() as Usage };
		} catch (error) {
			return { accountId, credential, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function choose(ctx: ExtensionCommandContext, current: Vault): Promise<string | undefined> {
		const entries = Object.entries(current.accounts);
		if (ctx.mode !== "tui") return undefined;
		const snapshots = await ctx.ui.custom<Snapshot[] | null>((tui, theme, _keys, done) => {
			const loader = new BorderedLoader(tui, theme, "Loading Codex accounts...");
			loader.onAbort = () => done(null);
			void Promise.all(entries.map(([id, credential]) => fetchUsage(id, credential, loader.signal))).then(done).catch(() => done(null));
			return loader;
		});
		if (!snapshots) return undefined;
		return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
			const items: SelectItem[] = snapshots.map((snapshot) => {
				const email = snapshot.usage?.email ?? claims(snapshot.credential.access).email ?? snapshot.accountId;
				const label = snapshot.accountId === current.activeAccountId
					? `${email} ${theme.fg("muted", "(active)")}`
					: email;
				return { value: snapshot.accountId, label, description: snapshotDescription(snapshot) };
			});
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			const header = new Text("", 2, 1);
			container.addChild(header);
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
			}, { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 48 });
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			const listBox = new Box(2, 0);
			listBox.addChild(list);
			container.addChild(listBox);
			const help = new Text("", 2, 1);
			container.addChild(help);
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			const updateDisplay = () => {
				const accountLabel = items.length === 1 ? "1 saved account" : `${items.length} saved accounts`;
				header.setText([
					theme.fg("accent", theme.bold("Switch Codex account")),
					theme.fg("muted", `${accountLabel} · current account marked active`),
				].join("\n"));
				const up = keybindings.getKeys("tui.select.up").join("/");
				const down = keybindings.getKeys("tui.select.down").join("/");
				const confirm = keybindings.getKeys("tui.select.confirm").join("/");
				const cancel = keybindings.getKeys("tui.select.cancel").join("/");
				help.setText(theme.fg("dim", `${up}/${down} navigate · ${confirm} select · ${cancel} cancel`));
			};
			updateDisplay();
			return {
				render: (width) => container.render(width),
				invalidate: () => { updateDisplay(); container.invalidate(); },
				handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
			};
		});
	}

	function resolveAccount(query: string, current: Vault): string {
		const normalized = query.toLowerCase();
		const matches = Object.entries(current.accounts).filter(([id, credential]) => {
			const email = claims(credential.access).email?.toLowerCase();
			return id === query || id.startsWith(query) || email === normalized;
		});
		if (matches.length !== 1) throw new Error(matches.length === 0 ? `Unknown account "${query}"` : `Ambiguous account "${query}"`);
		return matches[0]![0];
	}

	async function activate(accountId: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		const current = await ensureVault();
		const credential = current.accounts[accountId];
		if (!credential) throw new Error("Unknown Codex account");
		const fresh = await ensureFresh(accountId, credential);
		await writeActiveCredential(fresh);
		await updateVault((newest) => ({ ...newest, activeAccountId: accountId }));
		const email = claims(fresh.access).email ?? accountId.slice(0, 8);
		pi.events.emit("codex:account-changed", { accountId, email });
		pi.events.emit("codex:usage-changed", undefined);
		ctx.ui.notify(`Codex account: ${email}`, "info");
	}

	pi.registerCommand("account", {
		description: "Switch OpenAI Codex account",
		getArgumentCompletions: (prefix) => {
			const current = vault;
			if (!current) return null;
			const items = Object.entries(current.accounts).map(([id, credential]) => {
				const email = claims(credential.access).email ?? id;
				return { value: email, label: email, description: planLabel(claims(credential.access).plan) };
			});
			return items.filter((item) => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
		},
		handler: async (args, ctx) => {
			try {
				const query = args.trim();
				const current = await syncCurrentLogin();
				const accountId = query ? resolveAccount(query, current) : await choose(ctx, current);
				if (accountId) await activate(accountId, ctx);
				else if (ctx.mode !== "tui") {
					const current = await ensureVault();
					const accounts = Object.entries(current.accounts).map(([id, credential]) => claims(credential.access).email ?? id);
					ctx.ui.notify(`Accounts: ${accounts.join(", ")}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const builtin = ctx.modelRegistry.getProvider(PROVIDER);
		builtinOAuth = builtin?.auth.oauth;
		try {
			await syncCurrentLogin();
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Codex accounts: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});
}
