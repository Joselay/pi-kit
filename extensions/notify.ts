import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOUND_PATH = join(getAgentDir(), "sounds", "notification.mp3");
const AUDIO_PLAYER = "/usr/bin/afplay";

export default function notifyWhenDone(pi: ExtensionAPI) {
	let warned = false;

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		if (!existsSync(SOUND_PATH)) {
			if (!warned) {
				ctx.ui.notify(`Notification sound missing: ${SOUND_PATH}`, "warning");
				warned = true;
			}
			return;
		}

		try {
			const result = await pi.exec(AUDIO_PLAYER, [SOUND_PATH], { timeout: 5_000 });
			if (result.code !== 0 && !warned) {
				ctx.ui.notify("Failed to play notification sound", "warning");
				warned = true;
			}
		} catch {
			if (!warned) {
				ctx.ui.notify("Failed to play notification sound", "warning");
				warned = true;
			}
		}
	});
}
