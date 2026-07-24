// Extension-owned state files live under <agent-dir>/state/ (gitignored as a
// whole) instead of scattered across the agent root. Pi-owned files
// (auth.json, trust.json, models-store.json, sessions/) stay where pi puts them.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Absolute path for an extension state file, creating state/ if needed. */
export function statePath(name: string): string {
	const dir = join(getAgentDir(), "state");
	mkdirSync(dir, { recursive: true });
	return join(dir, name);
}
