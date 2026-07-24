// The talk visualizer: a true-color 3D globe with a ring in its own equatorial
// plane, drawn in quadrant-block "pixels". It knows nothing about the realtime
// session beyond the state and the 0..1 level it is handed each frame.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type TalkVisualState = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "working";

type Rgb = readonly [number, number, number];
// Two-tone gradient per state for the true-color globe. With no caption under
// the globe, hue is the only thing naming the state, so the six sit in distinct
// families: slate, cyan, green, magenta, indigo, amber. The dark tone shades the
// shadowed half of each surface band, the bright tone the lit half, and the
// bright tone alone tints the ring, the storms and the inner glow.
const STATE_COLORS: Record<TalkVisualState, readonly [Rgb, Rgb]> = {
	connecting: [
		[40, 48, 70],
		[120, 140, 175],
	],
	listening: [
		[14, 46, 130],
		[80, 200, 255],
	],
	hearing: [
		[8, 100, 74],
		[110, 250, 170],
	],
	thinking: [
		[96, 24, 132],
		[255, 110, 215],
	],
	speaking: [
		[40, 52, 190],
		[130, 120, 255],
	],
	working: [
		[168, 92, 22],
		[255, 195, 90],
	],
};
const RIM_TINT: Rgb = [90, 128, 217]; // cool edge light, 0..255
const SPARK_COLOR: Rgb = [255, 226, 130];
const POLE_TINT: Rgb = [200, 236, 255]; // polar aurora
// Quadrant glyph indexed by pixel mask: UL=1, UR=2, LL=4, LR=8.
const QUAD = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"] as const;
// Spin axis tipped toward the viewer, so one pole stays visible, the bands
// curve, and the ring opens into an ellipse instead of collapsing to a line.
const TILT = 0.45;
const SIN_TILT = Math.sin(TILT);
const COS_TILT = Math.cos(TILT);
const HALO = 0.26; // atmosphere thickness outside the limb, in globe radii
const FRAME_MS = 33;
const CHAR_ROWS = 8;
// A quadrant "pixel" is half a cell wide and half a cell tall, and cells are
// about twice as tall as they are wide — so a pixel is twice as tall as it is
// wide. Every length below is in vertical pixels and scales by this
// horizontally, which is what makes the disc an actual circle.
const PIXEL_ASPECT = 2;
const GLOBE_R = 5.2; // globe radius, in vertical pixels of the 16-pixel canvas
const RING_R = 1.5; // outermost ring radius, in globe radii
// Widest the globe ever draws: its ring's full diameter, plus a column of slack
// so the halo is not clipped by whatever it is drawn into.
export const ORB_COLS = Math.ceil(GLOBE_R * RING_R * 2) + 1;

/**
 * Concentric strands of the ring, with a gap between the inner pair and the
 * outer one. Each carries its own count of travelling bright arcs (`k`) at its
 * own rate (`sp`), so the ring shows its rotation instead of sitting there as a
 * painted-on ellipse.
 */
const STRANDS = [
	{ r: 1.22, w: 0.5, k: 3, sp: 1.0 },
	{ r: 1.32, w: 0.95, k: 2, sp: 1.35 },
	{ r: 1.46, w: 0.4, k: 4, sp: 0.75 },
];

/**
 * Storm spots fixed to the surface. At a dozen pixels across a meridian
 * graticule is either invisible or aliased into moire, but a handful of
 * landmarks appearing at one limb and crossing to the other make the rotation
 * unmistakable. Latitudes are spaced by the golden ratio and longitudes by the
 * golden angle so the six never line up, and each drifts at its own rate so the
 * face never repeats exactly.
 */
const SPOTS = Array.from({ length: 6 }, (_, i) => {
	const lat = (((i * 0.618) % 1) - 0.5) * 1.5;
	return {
		lon: i * 2.39996, // golden angle, in radians
		drift: 0.05 + ((i * 0.37) % 1) * 0.12,
		size: 0.34 + ((i * 0.29) % 1) * 0.3,
		cosLat: Math.cos(lat),
		sinLat: Math.sin(lat),
	};
});

/** Frame-rate independent smoothing factor for an exponential approach. */
function ease(rate: number, dt: number): number {
	return 1 - Math.exp(-rate * dt);
}

/**
 * The talk visualizer widget: a true-color 3D globe with a ring in its own
 * equatorial plane, and nothing else — no caption, no strip. Two channels carry
 * the whole session: the hue says which state it is in, and the ring meters
 * energy — loudness while audio flows, the agent's own machinery when there is
 * nothing to hear. Live audio also spins the globe faster, swells it and lights
 * it from within; matter spirals in and flattens into the ring while
 * connecting, the surface churns while thinking, and the ring burns amber while
 * the agent works.
 */
export class TalkVisual {
	private clock = 0; // seconds since mount; drives every time-based motion
	private last = Date.now();
	private level = 0; // smoothed 0..1 loudness driving the animation
	private spin = 0; // accumulated globe rotation; audio accelerates it smoothly
	// Per-state drivers, smoothed so a state change crossfades instead of popping.
	private readonly colA: [number, number, number];
	private readonly colB: [number, number, number];
	private churn = 1;
	private sparkAmt = 0;
	private condense = 1;
	private busy = 0; // machinery running with no audio to measure
	private energy = 0; // what the ring meters: loudness, or busyness when silent
	private orbit = 0; // accumulated ring rotation; energy accelerates it
	private pixels?: Float32Array; // reused across frames
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly getState: () => TalkVisualState,
		private readonly getLevel: () => number,
	) {
		const [a, b] = STATE_COLORS.connecting;
		this.colA = [a[0], a[1], a[2]];
		this.colB = [b[0], b[1], b[2]];
		this.timer = setInterval(() => this.tick(), FRAME_MS);
		this.timer.unref?.();
	}

	// Everything animated is integrated against wall-clock dt rather than frame
	// count, so the motion is identical whether or not frames arrive on time.
	private tick(): void {
		const now = Date.now();
		const dt = Math.min(0.25, Math.max(0.001, (now - this.last) / 1000));
		this.last = now;
		this.clock += dt;

		// Fast attack, slow release: snap to speech onsets, ease out after.
		const target = this.getLevel();
		this.level += (target - this.level) * ease(target > this.level ? 10 : 2.5, dt);
		this.spin += (0.42 + this.level * 1.1) * dt;

		const state = this.getState();
		const [ta, tb] = STATE_COLORS[state];
		const cf = ease(5, dt);
		for (let i = 0; i < 3; i++) {
			this.colA[i]! += (ta[i]! - this.colA[i]!) * cf;
			this.colB[i]! += (tb[i]! - this.colB[i]!) * cf;
		}
		const audio = state === "speaking" || state === "hearing";
		const churn = state === "thinking" ? 2.2 : 0.9 + (audio ? this.level * 0.9 : 0);
		this.churn += (churn - this.churn) * ease(4, dt);
		this.sparkAmt += ((state === "working" ? 1 : 0) - this.sparkAmt) * ease(3.5, dt);
		this.condense += ((state === "connecting" ? 1 : 0) - this.condense) * ease(2.5, dt);
		// The ring meters energy. While audio is flowing that is live loudness;
		// while the agent is thinking or working there is nothing to hear, so it
		// meters the machinery instead and the ring keeps turning on its own.
		this.busy += ((state === "working" ? 0.85 : state === "thinking" ? 0.45 : 0) - this.busy) * ease(3, dt);
		this.energy = Math.max(audio ? this.level : 0, this.busy);
		this.orbit += (0.6 + this.energy * 2.4) * dt;
		this.tui.requestRender();
	}

	private centered(line: string, width: number): string {
		const fitted = truncateToWidth(line, Math.max(0, width), "");
		return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2)))}${fitted}`;
	}

	render(width: number): string[] {
		// Too narrow to shade a sphere; fall back to a themed marker.
		if (width < 12) return [this.centered(this.theme.fg("accent", "◉ TALK"), width)];
		return this.renderOrb(width, this.getState());
	}

	// A true-color 3D globe rendered in quadrant-block "pixels" (2x2 per
	// character cell) with 2x2 supersampling per pixel. Each sample is projected
	// onto a tilted sphere and shaded with wrapped Lambert diffuse from a
	// drifting key light, a dim opposite fill, a tight specular hot spot, a cool
	// fresnel rim, a polar aurora and a scattering atmosphere just outside the
	// limb, over warped latitude bands crossed by storm spots that ride the
	// rotation. A three-strand ring in the globe's own equatorial plane passes
	// behind the far limb and across the lit face. Interior cells split their
	// four pixels into bright/dark groups (fg/bg) when there is contrast to keep,
	// so real detail survives the two-colors-per-cell limit without quantizing
	// smooth gradients into speckle; edge cells keep a transparent background.
	private renderOrb(width: number, state: TalkVisualState): string[] {
		const audio = state === "speaking" || state === "hearing";
		const t = this.clock;
		const level = this.level;
		const H = CHAR_ROWS * 2;
		// Wide enough for the globe and its ring, never wider than the box it is
		// drawn into; the radius then shrinks to whatever actually fits.
		const cols = Math.max(9, Math.min(ORB_COLS, width - 2));
		const W = cols * 2;
		const rows: string[] = [];

		// Live audio swells the globe, gently — the ring is the loudness tell, and
		// the body only needs to agree with it. Idle states breathe instead. While
		// matter is still condensing the globe sits small and translucent, then
		// inflates and solidifies as `condense` decays, so connecting flows into
		// listening without a cut.
		const swell = audio ? level * 0.08 : 0.025 * Math.sin(t * 0.7);
		const grow = 0.72 + 0.28 * (1 - this.condense);
		const form = 0.5 + 0.5 * (1 - this.condense);
		const R = Math.min(GLOBE_R, cols / 2 / RING_R) * (1 + swell) * grow;

		const cosSpin = Math.cos(this.spin);
		const sinSpin = Math.sin(this.spin);
		const churn = this.churn;
		const ca = this.colA;
		const cb = this.colB;
		const glowAmt = audio ? level : 0;

		// Key light drifting slowly around the upper left; half vector for specular.
		const la = 0.5 + 0.35 * Math.sin(t * 0.25);
		const ln = Math.hypot(-la, -0.6, 0.62);
		const lx = -la / ln;
		const ly = -0.6 / ln;
		const lz = 0.62 / ln;
		// Dim fill from the opposite side. Without it the unlit limb falls all the
		// way to background black and the silhouette stops reading as a circle.
		const fn = Math.hypot(la, 0.5, 0.5);
		const fx = la / fn;
		const fy = 0.5 / fn;
		const fz = 0.5 / fn;
		const hn = Math.hypot(lx, ly, lz + 1);
		const hx = lx / hn;
		const hy = ly / hn;
		const hz = (lz + 1) / hn;

		// Storm centres as unit vectors in the globe's own frame, so comparing them
		// against a sample is one dot product and no trigonometry per pixel.
		const spots = SPOTS.map((s) => {
			const lon = s.lon + s.drift * t;
			return {
				x: s.cosLat * Math.sin(lon),
				y: s.sinLat,
				z: s.cosLat * Math.cos(lon),
				inner: 1 - s.size,
				inv: 1 / s.size,
			};
		});

		// Shade one sample point into `smp` as pre-gamma rgb (0..1) premultiplied
		// by coverage, plus that coverage; false when the sample misses both the
		// globe and its atmosphere. A shared scratch buffer keeps this allocation
		// free — it runs a few thousand times per frame.
		const OUT = (1 + HALO) * (1 + HALO);
		const smp = new Float32Array(4);
		const shade = (nx: number, ny: number): boolean => {
			const d2 = nx * nx + ny * ny;
			if (d2 > OUT) return false;
			const r = Math.sqrt(d2);
			smp[0] = 0;
			smp[1] = 0;
			smp[2] = 0;
			let alpha = 0;

			// Analytic limb coverage — one pixel of feather right at the edge — so
			// the silhouette is a clean anti-aliased circle at any radius, without
			// the supersampler having to resolve it.
			const cov = Math.min(1, (1 - r) * R + 0.5);
			if (cov > 0) {
				const sz = Math.sqrt(Math.max(0, 1 - d2));
				const ndl = nx * lx + ny * ly + sz * lz;
				// Wrapped diffuse: softens the terminator so the shadowed side still
				// carries some shape instead of going flat black.
				const diffuse = Math.max(0, (ndl + 0.22) / 1.22);
				const fill = Math.max(0, nx * fx + ny * fy + sz * fz) * 0.2;
				let s = nx * hx + ny * hy + sz * hz;
				s = s > 0 ? s : 0;
				// ^32 by repeated squaring rather than Math.pow, which is several
				// times the cost of the whole rest of this function per sample.
				const s2 = s * s;
				const s4 = s2 * s2;
				const s8 = s4 * s4;
				const s16 = s8 * s8;
				const spec = s16 * s16; // a tight highlight rather than a wash
				const fres = 1 - sz;
				const rim = fres * fres * fres * 0.55;

				// Globe frame: untilt onto the spin axis, then unspin, so everything
				// below is fixed to the surface and rides the rotation.
				const ty = ny * COS_TILT - sz * SIN_TILT;
				const tz = ny * SIN_TILT + sz * COS_TILT;
				const gx = nx * cosSpin + tz * sinSpin;
				const gz = -nx * sinSpin + tz * cosSpin;

				// Latitude bands warped by a slow swirl, the way a gas giant reads.
				// Being latitude-aligned they never alias into moire the way
				// meridians do at this resolution. Compressed rather than full
				// swing: at full contrast the dark half of a band reads as a dent in
				// the sphere rather than as a marking on it.
				const raw = 0.5 + 0.5 * Math.sin(ty * 7.2 + 0.5 * churn * Math.sin(gx * 2.4 + gz * 1.3 + t * 0.8));
				const band = 0.24 + 0.62 * raw * raw * (3 - 2 * raw);

				let spot = 0;
				for (const p of spots) {
					const dot = gx * p.x + ty * p.y + gz * p.z;
					if (dot <= p.inner) continue;
					const m = Math.min(1, (dot - p.inner) * p.inv);
					spot += m * m * (3 - 2 * m);
				}
				if (spot > 1) spot = 1;

				// Polar aurora: cold light capping the axis, brightest where the
				// surface turns away from the light, so the night side is not dead.
				const polar = Math.max(0, Math.abs(ty) - 0.7) / 0.3;
				const cap = polar * polar * (0.2 + 0.5 * (1 - diffuse));
				// Live audio lights the globe from within.
				const emis = glowAmt * 0.22 * (1 - d2);
				const light = 0.07 + 0.93 * diffuse + fill;
				const a = cov * form;
				for (let i = 0; i < 3; i++) {
					const base = (ca[i]! + (cb[i]! - ca[i]!) * band) / 255;
					const hot = cb[i]! / 255;
					const v =
						base * light +
						spot * 0.55 * hot * (0.3 + 0.7 * diffuse) +
						spot * spot * 0.16 +
						emis * hot +
						spec * 0.26 +
						(rim * RIM_TINT[i]! + cap * POLE_TINT[i]!) / 255;
					smp[i] = (v > 1 ? 1 : v) * a;
				}
				alpha = a;
			}

			// Atmosphere: scattered light hugging the limb, strongest on the lit
			// side and fading outward, which gives the globe depth against the
			// background instead of a hard cutout edge.
			const fall = 1 - Math.max(0, r - 0.94) / HALO;
			if (fall > 0 && r > 0.6) {
				const facing = 0.45 + 0.55 * Math.max(0, (nx * lx + ny * ly) / (r || 1));
				const a = fall * fall * facing * (0.5 + 0.5 * glowAmt) * 0.85 * form * (1 - cov * 0.55);
				if (a > 0) {
					for (let i = 0; i < 3; i++) smp[i]! += ((RIM_TINT[i]! * 0.5 + cb[i]! * 0.5) / 255) * a;
					alpha += a;
				}
			}
			if (alpha <= 0) return false;
			smp[3] = alpha > 1 ? 1 : alpha;
			return true;
		};

		// Supersampled pixel grid: rgb + coverage per pixel, in a buffer reused
		// across frames.
		const size = W * H * 4;
		if (!this.pixels || this.pixels.length !== size) this.pixels = new Float32Array(size);
		const px = this.pixels;
		px.fill(0);
		const midX = (W - 1) / 2;
		const midY = (H - 1) / 2;
		const scaleX = 1 / (R * PIXEL_ASPECT);
		const scaleY = 1 / R;
		for (let py = 0; py < H; py++) {
			for (let x = 0; x < W; x++) {
				let r = 0;
				let g = 0;
				let b = 0;
				let cov = 0;
				for (let s = 0; s < 4; s++) {
					const dx = s & 1 ? 0.25 : -0.25;
					const dy = s & 2 ? 0.25 : -0.25;
					if (!shade((x + dx - midX) * scaleX, (py + dy - midY) * scaleY)) continue;
					r += smp[0]!;
					g += smp[1]!;
					b += smp[2]!;
					cov += smp[3]!;
				}
				if (!cov) continue;
				const o = (py * W + x) * 4;
				px[o] = r / 4;
				px[o + 1] = g / 4;
				px[o + 2] = b / 4;
				px[o + 3] = cov / 4;
			}
		}

		// Plot one point at a globe-space position (in radii). The same axial tilt
		// as the surface takes it to view space, anything on the far side is
		// occluded by the globe rather than drawn over it, and the blend is
		// additive so a point crossing the lit face reads as a highlight instead
		// of a hole punched in the surface.
		const plot = (gx: number, gy: number, gz: number, tint: Rgb, weight: number, rad: number): void => {
			const vy = gy * COS_TILT + gz * SIN_TILT;
			const vz = -gy * SIN_TILT + gz * COS_TILT;
			let w = weight;
			if (vz < 0) {
				// Going behind: fade across the limb instead of clipping, so a point
				// sinks under the globe and comes back out rather than blinking.
				const occ = (Math.hypot(gx, vy) - 1) / 0.14;
				if (occ <= 0) return;
				if (occ < 1) w *= occ;
			}
			w *= 0.45 + 0.55 * ((vz / (Math.hypot(gx, gy, gz) || 1) + 1) / 2);
			if (w <= 0.015) return;
			// Sub-pixel splat: a round, anti-aliased falloff, stretched
			// horizontally because pixels are half as wide as they are tall, so it
			// stays circular on screen and glides between pixels instead of
			// snapping from one to the next.
			const cx = midX + gx * R * PIXEL_ASPECT;
			const cy = midY + vy * R;
			const radX = rad * PIXEL_ASPECT;
			const y1 = Math.floor(cy + rad);
			const x1 = Math.floor(cx + radX);
			for (let yy = Math.ceil(cy - rad); yy <= y1; yy++) {
				if (yy < 0 || yy >= H) continue;
				const dy = (yy - cy) / rad;
				const dy2 = dy * dy;
				for (let xx = Math.ceil(cx - radX); xx <= x1; xx++) {
					if (xx < 0 || xx >= W) continue;
					const dx = (xx - cx) / radX;
					const d2 = dx * dx + dy2;
					if (d2 >= 1) continue;
					const f = 1 - d2;
					const ww = w * f * f;
					const o = (yy * W + xx) * 4;
					for (let i = 0; i < 3; i++) px[o + i] = Math.min(1, px[o + i]! + (tint[i]! / 255) * ww);
					px[o + 3] = Math.min(1, px[o + 3]! + ww);
				}
			}
		};

		// The ring is the meter the level strip used to be, and it lies in the
		// globe's own equatorial plane so the two read as one object: the far half
		// slips behind the limb, the near half crosses the lit face. Loose motes
		// never resolve at this size — a continuous curve does, and it brightens,
		// gains beads and runs faster as energy rises. The tint tracks the live
		// palette, warming to amber sparks while the agent works.
		const energy = this.energy;
		const ringTint: [number, number, number] = [0, 0, 0];
		for (let i = 0; i < 3; i++) {
			const idle = POLE_TINT[i]! * 0.4 + cb[i]! * 0.6;
			ringTint[i] = idle + (SPARK_COLOR[i]! - idle) * this.sparkAmt;
		}
		const ringAmt = (0.55 + 0.45 * energy) * form;
		for (const st of STRANDS) {
			// One sample per ~0.75px of arc, so a strand is a continuous line
			// rather than a dotted one, whatever radius it ended up drawn at.
			const circ = Math.PI * st.r * R * (PIXEL_ASPECT + SIN_TILT);
			const segs = Math.max(24, Math.ceil(circ / 0.75));
			for (let i = 0; i < segs; i++) {
				const a = (i / segs) * Math.PI * 2;
				// Brightness travelling around the strand: a uniform ring would
				// hide its own rotation, arcs sweeping along it do not.
				const dens = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(a * st.k - this.orbit * st.sp * 2));
				plot(Math.cos(a) * st.r, 0, Math.sin(a) * st.r, ringTint, st.w * dens * ringAmt * 0.6, 0.8);
			}
		}
		// Beads riding the ring: the fast, legible end of the meter, drawn
		// tail-first so each bright head wins the pixels it shares with its trail.
		const beads = 2 + Math.round(energy * 3);
		for (let b = 0; b < beads; b++) {
			const head = this.orbit * (1.1 + b * 0.13) + b * 2.4;
			for (let tr = 5; tr >= 0; tr--) {
				const a = head - tr * 0.09;
				plot(Math.cos(a) * 1.33, 0, Math.sin(a) * 1.33, ringTint, (1 - tr / 6) ** 1.5 * ringAmt * 1.5, 0.95);
			}
		}

		// Connecting: matter spirals inward and flattens into the ring plane as it
		// arrives, so the session assembles itself out of the geometry it is about
		// to settle into rather than out of unrelated confetti.
		if (this.condense > 0.02) {
			for (let k = 0; k < 7; k++) {
				const elev0 = (((k * 0.618) % 1) - 0.5) * 1.5;
				const phase = (this.clock * 0.6 + k * 0.143) % 1;
				for (let tr = 5; tr >= 0; tr--) {
					const p = phase - tr * 0.045;
					if (p <= 0) continue;
					// Stays within the frame: 1.75 radii is just inside the canvas.
					const rr = 1.75 - 0.42 * p;
					const elev = elev0 * (1 - p) * (1 - p);
					const a = k * 2.39996 + this.orbit * 0.9 + p * 3.4;
					const ce = Math.cos(elev);
					const weight = this.condense * Math.sin(p * Math.PI) * (1 - tr / 6) * 1.1;
					plot(Math.cos(a) * ce * rr, Math.sin(elev) * rr, Math.sin(a) * ce * rr, POLE_TINT, weight, 0.9);
				}
			}
		}

		const GAMMA = 0.85;
		const offs = new Int32Array(4);
		const lums = new Float64Array(4);
		const q = (v: number) => Math.round(255 * (v > 1 ? 1 : v) ** GAMMA);
		const seq = (sel: number, bg: boolean): string => {
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let i = 0; i < 4; i++) {
				if (!(sel & (1 << i))) continue;
				const o = offs[i]!;
				r += px[o]!;
				g += px[o + 1]!;
				b += px[o + 2]!;
				n += 1;
			}
			return `\x1b[${bg ? 48 : 38};2;${q(r / n)};${q(g / n)};${q(b / n)}m`;
		};
		let curFg = "";
		let curBg = "";
		// Emit an SGR change only where a cell actually needs one: a run of empty
		// background costs one reset instead of one escape pair per cell, which
		// roughly halves the bytes pushed to the terminal each frame.
		const style = (fg: string, bg: string): string => {
			let out = "";
			if (curBg && bg !== curBg) {
				out += "\x1b[0m";
				curFg = "";
				curBg = "";
			}
			if (bg && bg !== curBg) {
				out += bg;
				curBg = bg;
			}
			if (fg && fg !== curFg) {
				out += fg;
				curFg = fg;
			}
			return out;
		};
		// A pixel counts as drawn when it is bright enough to beat the terminal
		// background, not merely when something touched it. Keying off coverage
		// instead emits near-black cells for the faintest atmosphere and ring
		// samples, which on any non-black background punch dark specks out of the
		// limb and leave the halo looking chewed.
		const lit = (o: number) => px[o]! + px[o + 1]! + px[o + 2]! > 0.15;
		for (let cy = 0; cy < CHAR_ROWS; cy++) {
			let line = "";
			curFg = "";
			curBg = "";
			for (let cx = 0; cx < cols; cx++) {
				// Cell pixel offsets in mask order UL, UR, LL, LR.
				offs[0] = (cy * 2 * W + cx * 2) * 4;
				offs[1] = offs[0]! + 4;
				offs[2] = ((cy * 2 + 1) * W + cx * 2) * 4;
				offs[3] = offs[2]! + 4;
				let mask = 0;
				for (let i = 0; i < 4; i++) if (lit(offs[i]!)) mask |= 1 << i;
				if (!mask) {
					line += `${style("", "")} `;
					continue;
				}
				if (mask !== 15) {
					// Limb: draw only covered quadrants, background stays transparent.
					line += `${style(seq(mask, false), "")}${QUAD[mask]}`;
					continue;
				}
				// Interior: splitting the cell into bright and dark halves buys
				// detail only where there is detail to keep. On smooth shading it
				// just quantizes a gradient into speckle, so a flat cell takes one
				// averaged color instead.
				for (let i = 0; i < 4; i++) lums[i] = px[offs[i]!]! + px[offs[i]! + 1]! + px[offs[i]! + 2]!;
				let lo = lums[0]!;
				let hi = lums[0]!;
				for (let i = 1; i < 4; i++) {
					if (lums[i]! < lo) lo = lums[i]!;
					if (lums[i]! > hi) hi = lums[i]!;
				}
				if (hi - lo < 0.12) {
					line += `${style(seq(15, false), "")}█`;
					continue;
				}
				const mean = (lums[0]! + lums[1]! + lums[2]! + lums[3]!) / 4;
				let brightMask = 0;
				for (let i = 0; i < 4; i++) if (lums[i]! >= mean) brightMask |= 1 << i;
				line +=
					brightMask === 15
						? `${style(seq(15, false), "")}█`
						: `${style(seq(brightMask, false), seq(15 & ~brightMask, true))}${QUAD[brightMask]}`;
			}
			if (curFg || curBg) line += "\x1b[0m";
			rows.push(this.centered(line, width));
		}

		return rows;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}
