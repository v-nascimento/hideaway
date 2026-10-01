// Quake mode geometry and animation (PLAN §5). Pure placement maths plus the
// slide, which is clipped to its monitor so it never shows on a neighbour.

import type { Edge } from "./data";
import { intersect, NativeWindow, Rect } from "./electron";

/** A window's share of an edge it shares with others: `index` of `count`. */
export interface Slot {
	index: number;
	count: number;
}

/** Edges whose span runs horizontally. */
const horizontal = (edge: Edge) => edge === "N" || edge === "S";

/**
 * Where a Quake window sits on a monitor's usable area: `depthPct` in from the
 * edge, sharing a `spanPct` stretch centred on the edge equally with the other
 * windows on it (PLAN: sharing an edge).
 */
export function quakeRect(area: Rect, edge: Edge, depthPct: number, spanPct: number, slot: Slot): Rect {
	const edgeLength = horizontal(edge) ? area.width : area.height;
	const crossLength = horizontal(edge) ? area.height : area.width;
	const span = Math.round((edgeLength * spanPct) / 100);
	const depth = Math.round((crossLength * depthPct) / 100);
	const share = Math.floor(span / slot.count);
	const start = Math.round((edgeLength - span) / 2) + share * slot.index;
	// The last slot takes the rounding remainder, so the shares fill the span exactly.
	const length = slot.index === slot.count - 1 ? span - share * (slot.count - 1) : share;
	if (horizontal(edge)) {
		const y = edge === "N" ? area.y : area.y + area.height - depth;
		return { x: area.x + start, y, width: length, height: depth };
	}
	const x = edge === "W" ? area.x : area.x + area.width - depth;
	return { x, y: area.y + start, width: depth, height: length };
}

/** The current depth of a Quake window, in % of the monitor (after the user drags its inner edge). */
export function depthPct(rect: Rect, area: Rect, edge: Edge): number {
	const pct = horizontal(edge) ? rect.height / area.height : rect.width / area.width;
	return Math.min(100, Math.max(10, Math.round(pct * 100)));
}

/** The same rect, moved just past the edge. */
function beyondEdge(r: Rect, edge: Edge): Rect {
	switch (edge) {
		case "N": return { ...r, y: r.y - r.height };
		case "S": return { ...r, y: r.y + r.height };
		case "W": return { ...r, x: r.x - r.width };
		case "E": return { ...r, x: r.x + r.width };
	}
}

/** Moves a rect `px` back towards the monitor from past the edge. */
function nudgeIn(r: Rect, edge: Edge, px: number): Rect {
	switch (edge) {
		case "N": return { ...r, y: r.y + px };
		case "S": return { ...r, y: r.y - px };
		case "W": return { ...r, x: r.x + px };
		case "E": return { ...r, x: r.x - px };
	}
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function lerp(a: Rect, b: Rect, t: number): Rect {
	return {
		x: Math.round(a.x + (b.x - a.x) * t),
		y: Math.round(a.y + (b.y - a.y) * t),
		width: Math.round(a.width + (b.width - a.width) * t),
		height: Math.round(a.height + (b.height - a.height) * t),
	};
}

/**
 * Runs `frame(progress)` once per frame of `clock` for `durationMs`, with an
 * ease-out curve. `frame` returns false to stop early. A hidden window's frame
 * clock stops, so a safety timer jumps to the end instead of hanging.
 */
function animate(clock: Window, durationMs: number, frame: (progress: number) => boolean): Promise<void> {
	return new Promise((resolve) => {
		if (durationMs <= 0) {
			frame(1);
			resolve();
			return;
		}
		const t0 = performance.now();
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			window.clearTimeout(safety);
			resolve();
		};
		const safety = window.setTimeout(() => {
			if (done) return;
			frame(1);
			finish();
		}, durationMs + 500);
		const step = () => {
			if (done) return;
			const t = Math.min(1, (performance.now() - t0) / durationMs);
			const more = frame(easeOut(t));
			if (!more || t >= 1) finish();
			else clock.requestAnimationFrame(step);
		};
		clock.requestAnimationFrame(step);
	});
}

export interface SlideOptions {
	win: NativeWindow;
	/** The pop-out's own window: its frame clock drives the animation (the main window may be hidden by Tray). */
	clock: Window;
	/** The monitor's usable area; the window is clipped to it while it moves. */
	area: Rect;
	edge: Edge;
	durationMs: number;
	/** Sliding in: called once the window first becomes visible. */
	onShown?: () => void;
	/** Sliding out: called once the window is fully off the monitor; must hide it. */
	onGone?: () => void;
}

/**
 * Slides a Quake window in to `rect`, or out from `rect` past its edge. It starts
 * 1 px inside the monitor, so the window is visible (and its frame clock running)
 * from the first frame.
 */
export async function slide(dir: "in" | "out", rect: Rect, o: SlideOptions): Promise<void> {
	const outside = beyondEdge(rect, o.edge);
	const from = dir === "in" ? nudgeIn(outside, o.edge, 1) : rect;
	const to = dir === "in" ? rect : outside;
	let visible = dir === "out";

	const place = (r: Rect): boolean => {
		const clip = intersect(r, o.area);
		if (!clip) {
			if (visible) {
				o.onGone?.();
				visible = false;
			}
			return false;
		}
		const region = [{ x: clip.x - r.x, y: clip.y - r.y, width: clip.width, height: clip.height }];
		// This order never lets the visible part overhang the monitor for a frame.
		if (dir === "in") {
			o.win.setBounds(r);
			o.win.setShape(region);
		} else {
			o.win.setShape(region);
			o.win.setBounds(r);
		}
		if (!visible) {
			o.win.setOpacity(1);
			o.win.show();
			o.onShown?.();
			visible = true;
		}
		return true;
	};

	place(from);
	await animate(o.clock, o.durationMs, (p) => place(lerp(from, to, p)) || dir === "in");
	if (dir === "in") {
		o.win.setBounds(rect);
		o.win.setShape([]); // fully rectangular again, so the inner edge can be dragged
	} else if (visible) {
		o.onGone?.();
	}
}

/** Animates a visible Quake window to a new place (when the windows sharing its edge change). */
export function move(win: NativeWindow, to: Rect, clock: Window, durationMs: number): Promise<void> {
	const from = win.getBounds();
	return animate(clock, durationMs, (p) => {
		win.setBounds(lerp(from, to, p));
		return true;
	});
}
