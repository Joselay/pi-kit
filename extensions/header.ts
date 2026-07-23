import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";

const IMAGES_DIR = new URL("../images/", import.meta.url);

function pickRandomImage() {
	const files = readdirSync(IMAGES_DIR).filter((f) => f.endsWith(".png"));
	const filename = files[Math.floor(Math.random() * files.length)];
	return {
		filename,
		base64: readFileSync(new URL(filename, IMAGES_DIR), "base64"),
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

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
	});
}
