// The talk panel: the globe plus the running conversation, as one fixed block
// above the editor.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ORB_COLS, TalkVisual, type TalkVisualState } from "./globe.ts";

export type TranscriptWho = "you" | "asst" | "sys";
export type TranscriptEntry = { who: TranscriptWho; text: string };
/** What the panel draws: settled entries, plus the one still being spoken. */
export type TranscriptView = { entries: readonly TranscriptEntry[]; open?: TranscriptEntry };

const PANEL_ROWS = 8; // the globe's own height, so the panel is a fixed block
const LABEL_W = 4; // "you" / "talk" / "·", right-aligned in this column
const ORB_GUTTER = 2;
const MIN_TEXT_W = 26; // narrower than this and the words are not worth wrapping
const MAX_TEXT_W = 84; // a comfortable measure; wider rows read worse, not better
// Notes carry their own leading arrow, so they take no speaker label and their
// text lines up with everyone else's.
const LABELS: Record<TranscriptWho, string> = { you: "you", asst: "talk", sys: "" };

/** Greedy word wrap to `width` columns; a word longer than the line is split. */
function wrapText(text: string, width: number): string[] {
	if (width < 2) return [];
	const lines: string[] = [];
	let line = "";
	const flush = () => {
		while (visibleWidth(line) > width) {
			const head = truncateToWidth(line, width, "");
			lines.push(head);
			line = line.slice(head.length);
		}
	};
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		if (!line) line = word;
		else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) line += ` ${word}`;
		else {
			flush();
			if (line) lines.push(line);
			line = word;
		}
		flush();
	}
	if (line) lines.push(line);
	return lines;
}

/**
 * The whole talk surface as one fixed block above the editor: the globe on the
 * left, the conversation in the width the globe was wasting on its right.
 *
 * The two used to sit on opposite sides of the editor, which put the input box
 * in the middle of a single conversation, and the transcript grew and shrank
 * with what had been said, so every utterance shoved the editor and the whole
 * scrollback up or down the screen. This is always exactly `PANEL_ROWS` tall —
 * fewer rows than the two widgets used to take between them — and the text is
 * bottom-aligned, so the newest line is always in the same place and the older
 * ones recede up and out.
 */
export class TalkPanel {
	private readonly orb: TalkVisual;

	constructor(
		tui: TUI,
		private readonly theme: Theme,
		getState: () => TalkVisualState,
		getLevel: () => number,
		private readonly getView: () => TranscriptView,
	) {
		this.orb = new TalkVisual(tui, theme, getState, getLevel);
	}

	render(width: number): string[] {
		const orbBox = Math.min(ORB_COLS + 2, width);
		// Capped, not greedy: on a wide terminal a full-width row of speech runs
		// well past a comfortable measure and is harder to follow, not easier.
		const textWidth = Math.min(MAX_TEXT_W, width - orbBox - ORB_GUTTER);
		// Too narrow to sit side by side: the globe carries the state on its own,
		// and the words — which are spoken aloud anyway — give up the room.
		if (textWidth < MIN_TEXT_W) return this.orb.render(width);
		const orbLines = this.orb.render(orbBox);
		const textLines = this.transcript(textWidth);
		const gutter = " ".repeat(ORB_GUTTER);
		return orbLines.map((orb, i) => {
			const text = textLines[i];
			if (!text) return orb;
			const pad = " ".repeat(Math.max(0, orbBox - visibleWidth(orb)));
			return `${orb}${pad}${gutter}${text}`;
		});
	}

	/** Exactly PANEL_ROWS rendered rows, bottom-aligned. */
	private transcript(width: number): string[] {
		const { entries, open } = this.getView();
		const all = open ? [...entries, open] : entries;
		// Label, its trailing space, and a reserved column for the cursor block the
		// open line ends with — without that column the line still being spoken
		// renders one wider than the panel it was measured for.
		const bodyWidth = Math.max(4, width - LABEL_W - 2);
		const rows: string[] = [];
		for (const [index, entry] of all.entries()) {
			const wrapped = wrapText(entry.text, bodyWidth);
			// The label sits on the first line of an utterance only; continuations
			// hang under it, which reads far better than a speaker tag per row.
			const latest = index === all.length - 1;
			for (const [line, text] of wrapped.entries()) {
				const cursor = latest && open !== undefined && line === wrapped.length - 1;
				rows.push(this.row(line === 0 ? LABELS[entry.who] : "", text, entry.who, latest, cursor));
			}
		}
		const tail = rows.slice(-PANEL_ROWS);
		return Array(PANEL_ROWS - tail.length)
			.fill("")
			.concat(tail);
	}

	private row(label: string, text: string, who: TranscriptWho, latest: boolean, cursor: boolean): string {
		const labelColor = who === "you" ? "muted" : who === "asst" ? "accent" : "dim";
		// Only the newest utterance is at full strength; everything behind it
		// recedes, so the eye lands on what is being said right now.
		const textColor = who === "sys" ? "dim" : latest ? (who === "you" ? "userMessageText" : "text") : "muted";
		const head = this.theme.fg(labelColor, label.padStart(LABEL_W));
		const body = this.theme.fg(textColor, text);
		return `${head} ${body}${cursor ? this.theme.fg("accent", "▌") : ""}`;
	}

	invalidate(): void {
		this.orb.invalidate();
	}

	dispose(): void {
		this.orb.dispose();
	}
}
