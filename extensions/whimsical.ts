import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RGB = readonly [number, number, number];

const LABELS = [
	"Accomplishing…",
	"Actioning…",
	"Actualizing…",
	"Architecting…",
	"Baking…",
	"Beaming…",
	"Beboppin'…",
	"Befuddling…",
	"Billowing…",
	"Blanching…",
	"Bloviating…",
	"Boogieing…",
	"Boondoggling…",
	"Booping…",
	"Bootstrapping…",
	"Brewing…",
	"Bunning…",
	"Burrowing…",
	"Calculating…",
	"Canoodling…",
	"Caramelizing…",
	"Cascading…",
	"Catapulting…",
	"Cerebrating…",
	"Channeling…",
	"Channelling…",
	"Choreographing…",
	"Churning…",
	"Clauding…",
	"Coalescing…",
	"Cogitating…",
	"Combobulating…",
	"Composing…",
	"Computing…",
	"Concocting…",
	"Considering…",
	"Contemplating…",
	"Cooking…",
	"Crafting…",
	"Creating…",
	"Crunching…",
	"Crystallizing…",
	"Cultivating…",
	"Deciphering…",
	"Deliberating…",
	"Determining…",
	"Dilly-dallying…",
	"Discombobulating…",
	"Doing…",
	"Doodling…",
	"Drizzling…",
	"Ebbing…",
	"Effecting…",
	"Elucidating…",
	"Embellishing…",
	"Enchanting…",
	"Envisioning…",
	"Fermenting…",
	"Fiddle-faddling…",
	"Finagling…",
	"Flambéing…",
	"Flibbertigibbeting…",
	"Flowing…",
	"Flummoxing…",
	"Fluttering…",
	"Forging…",
	"Forming…",
	"Frolicking…",
	"Frosting…",
	"Gallivanting…",
	"Galloping…",
	"Garnishing…",
	"Generating…",
	"Gesticulating…",
	"Germinating…",
	"Gitifying…",
	"Grooving…",
	"Gusting…",
	"Harmonizing…",
	"Hashing…",
	"Hatching…",
	"Herding…",
	"Honking…",
	"Hullaballooing…",
	"Hyperspacing…",
	"Ideating…",
	"Imagining…",
	"Improvising…",
	"Incubating…",
	"Inferring…",
	"Infusing…",
	"Ionizing…",
	"Jitterbugging…",
	"Julienning…",
	"Kneading…",
	"Leavening…",
	"Levitating…",
	"Lollygagging…",
	"Manifesting…",
	"Marinating…",
	"Meandering…",
	"Metamorphosing…",
	"Misting…",
	"Moonwalking…",
	"Moseying…",
	"Mulling…",
	"Mustering…",
	"Musing…",
	"Nebulizing…",
	"Nesting…",
	"Newspapering…",
	"Noodling…",
	"Nucleating…",
	"Orbiting…",
	"Orchestrating…",
	"Osmosing…",
	"Perambulating…",
	"Percolating…",
	"Perusing…",
	"Philosophising…",
	"Photosynthesizing…",
	"Pollinating…",
	"Pondering…",
	"Pontificating…",
	"Pouncing…",
	"Precipitating…",
	"Prestidigitating…",
	"Processing…",
	"Proofing…",
	"Propagating…",
	"Puttering…",
	"Puzzling…",
	"Quantumizing…",
	"Razzle-dazzling…",
	"Razzmatazzing…",
	"Recombobulating…",
	"Reticulating…",
	"Roosting…",
	"Ruminating…",
	"Sautéing…",
	"Scampering…",
	"Schlepping…",
	"Scurrying…",
	"Seasoning…",
	"Shenaniganing…",
	"Shimmying…",
	"Simmering…",
	"Skedaddling…",
	"Sketching…",
	"Slithering…",
	"Smooshing…",
	"Sock-hopping…",
	"Spelunking…",
	"Spinning…",
	"Sprouting…",
	"Stewing…",
	"Sublimating…",
	"Swirling…",
	"Swooping…",
	"Symbioting…",
	"Synthesizing…",
	"Tempering…",
	"Thinking…",
	"Thundering…",
	"Tinkering…",
	"Tomfoolering…",
	"Topsy-turvying…",
	"Transfiguring…",
	"Transmuting…",
	"Twisting…",
	"Undulating…",
	"Unfurling…",
	"Unravelling…",
	"Vibing…",
	"Waddling…",
	"Wandering…",
	"Warping…",
	"Whatchamacalliting…",
	"Whirlpooling…",
	"Whirring…",
	"Whisking…",
	"Wibbling…",
	"Working…",
	"Wrangling…",
	"Zesting…",
	"Zigzagging…",
] as const;

const SPINNER_GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...SPINNER_GLYPHS, ...SPINNER_GLYPHS.slice(1, -1).reverse()];
const BASE: RGB = [0xff, 0x86, 0x9a];
const CREST: RGB = [0xff, 0xaa, 0xb8];
const RESET_FG = "\x1b[39m";
const BAND = 4;
const FRAME_MS = 200;

function ansi([r, g, b]: RGB): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function paint(color: RGB, text: string): string {
	return `${ansi(color)}${text}${RESET_FG}`;
}

function blend(a: RGB, b: RGB, amount: number): RGB {
	return [
		Math.round(a[0] + (b[0] - a[0]) * amount),
		Math.round(a[1] + (b[1] - a[1]) * amount),
		Math.round(a[2] + (b[2] - a[2]) * amount),
	];
}

function buildShimmerFrames(text: string): string[] {
	const characters = [...text];
	const span = characters.length + BAND * 2;
	return Array.from({ length: span }, (_, index) => {
		const head = index - BAND;
		const line = characters
			.map((character, column) => {
				const strength = Math.max(0, 1 - Math.abs(column - head) / BAND);
				return `${ansi(blend(BASE, CREST, strength))}${character}`;
			})
			.join("");
		return `${line}${RESET_FG}`;
	});
}

export default function whimsical(pi: ExtensionAPI): void {
	let ui: ExtensionContext["ui"] | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frame = 0;
	let label = "Working…";
	let shimmerFrames = buildShimmerFrames(label);

	function applyIndicator(): void {
		const currentUi = ui;
		if (!currentUi) return;
		const truecolor = currentUi.theme.getColorMode() === "truecolor";
		const frames = SPINNER_FRAMES.map((glyph) =>
			truecolor ? paint(BASE, glyph) : currentUi.theme.fg("accent", glyph),
		);
		currentUi.setWorkingIndicator({ frames, intervalMs: 120 });
	}

	function render(): void {
		if (!ui) return;
		const truecolor = ui.theme.getColorMode() === "truecolor";
		const title = truecolor
			? shimmerFrames[frame % shimmerFrames.length]!
			: ui.theme.fg("accent", label);
		ui.setWorkingMessage(title);
	}

	function start(context: ExtensionContext): void {
		if (context.mode !== "tui") return;
		ui = context.ui;
		if (timer) return;
		applyIndicator();
		render();
		timer = setInterval(() => {
			frame = (frame + 1) % shimmerFrames.length;
			render();
		}, FRAME_MS);
	}

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
		ui?.setWorkingMessage();
	}

	pi.on("session_start", (_event, context) => {
		if (context.mode !== "tui") return;
		ui = context.ui;
		applyIndicator();
	});

	pi.on("before_agent_start", (_event, context) => {
		stop();
		ui = context.mode === "tui" ? context.ui : undefined;
		label = LABELS[Math.floor(Math.random() * LABELS.length)]!;
		shimmerFrames = buildShimmerFrames(label);
		frame = 0;
	});

	pi.on("agent_start", (_event, context) => start(context));

	pi.on("turn_start", (_event, context) => start(context));

	pi.on("agent_settled", () => {
		stop();
	});

	pi.on("session_shutdown", () => {
		stop();
		ui = undefined;
	});
}
