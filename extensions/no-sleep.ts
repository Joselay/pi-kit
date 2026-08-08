import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";

let caffeinate: ChildProcess | undefined;

function start(ctx: ExtensionContext): void {
	if (process.platform !== "darwin" || caffeinate) return;

	const child = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], {
		stdio: "ignore",
	});
	child.unref();
	caffeinate = child;

	child.once("error", (error) => {
		if (caffeinate !== child) return;
		caffeinate = undefined;
		if (ctx.hasUI) ctx.ui.notify(`No Sleep failed: ${error.message}`, "error");
	});
	child.once("exit", () => {
		if (caffeinate === child) caffeinate = undefined;
	});
}

function stop(): void {
	caffeinate?.kill();
	caffeinate = undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => stop());
}
