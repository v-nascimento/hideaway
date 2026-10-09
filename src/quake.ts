// Quake mode geometry and animation (PLAN §5). Pure placement maths plus the
// slide, which is clipped to its monitor so it never shows on a neighbour.

import type { Edge, QuakePlacement } from "./data";
import { intersect, NativeWindow, Rect } from "./electron";

/** Smallest depth and span, in %. */
export const MIN_PCT = 10;
/** How close (px) the pointer must be to a screen edge for a drop to count as being at it. */
const EDGE_GRAB = 6;

/** A window's share of an edge it shares with others: `index` of `count`. */
export interface Slot {
	index: number;
	count: number;
}

/** Edges whose span runs horizontally. */
const horizontal = (edge: Edge) => edge === "N" || edge === "S";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Where a Quake window sits on a monitor's usable area: `depthPct` in from the
 * edge, a `spanPct` stretch along it with its middle at `centrePct`, shared
 * equally with the other windows on it (PLAN: sharing an edge). The stretch is
 * kept fully on the monitor.
 */
export function quakeRect(area: Rect, edge: Edge, depthPct: number, spanPct: number, slot: Slot, centrePct = 50): Rect {
	const edgeLength = horizontal(edge) ? area.width : area.height;
	const crossLength = horizontal(edge) ? area.height : area.width;
	const span = Math.round((edgeLength * spanPct) / 100);
	const depth = Math.round((crossLength * depthPct) / 100);
	const share = Math.floor(span / slot.count);
	const first = clamp(Math.round((edgeLength * centrePct) / 100 - span / 2), 0, edgeLength - span);
	const start = first + share * slot.index;
	// The last slot takes the rounding remainder, so the shares fill the span exactly.
	const length = slot.index === slot.count - 1 ? span - share * (slot.count - 1) : share;
	if (horizontal(edge)) {
		const y = edge === "N" ? area.y : area.y + area.height - depth;
		return { x: area.x + start, y, width: length, height: depth };
	}
	const x = edge === "W" ? area.x : area.x + area.width - depth;
	return { x, y: area.y + start, width: depth, height: length };
}

/** A window's depth, span and position in % of the monitor (after the user resizes or moves it). */
export function placementFromRect(rect: Rect, area: Rect, edge: Edge): QuakePlacement {
	const h = horizontal(edge);
	const edgeLength = h ? area.width : area.height;
	const crossLength = h ? area.height : area.width;
	const length = h ? rect.width : rect.height;
	const start = h ? rect.x - area.x : rect.y - area.y;
	const depth = h ? rect.height : rect.width;
	const span = clamp(round1((length / edgeLength) * 100), MIN_PCT, 100);
	return {
		depth: clamp(round1((depth / crossLength) * 100), MIN_PCT, 100),
		span,
		centre: clamp(round1(((start + length / 2) / edgeLength) * 100), 0, 100),
	};
}

/** True when a placement is (about) the default: the window is centred at its default size. */
export function isDefaultPlacement(p: QuakePlacement | undefined, defaults: QuakePlacement): boolean {
	if (!p) return true;
	return Math.abs(p.depth - defaults.depth) < 0.5 && Math.abs(p.span - defaults.span) < 0.5 && Math.abs(p.centre - defaults.centre) < 0.5;
}

/** Which edge of a monitor's usable area the pointer is at (or past), if any; the nearest wins in a corner. */
export function edgeAtPoint(point: { x: number; y: number }, area: Rect): Edge | null {
	const gaps: [Edge, number][] = [
		["N", point.y - area.y],
		["S", area.y + area.height - 1 - point.y],
		["W", point.x - area.x],
		["E", area.x + area.width - 1 - point.x],
	];
	const near = gaps.filter(([, gap]) => gap <= EDGE_GRAB);
	if (near.length === 0) return null;
	return near.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

export const OPPOSITE: Record<Edge, Edge> = { N: "S", S: "N", E: "W", W: "E" };

/**
 * The monitor next to `current` on its `edge` side: the nearest one that lies
 * entirely beyond that side and shares some of its length. Null if there is none.
 */
export function neighbourArea(areas: Rect[], current: Rect, edge: Edge): Rect | null {
	let best: Rect | null = null;
	let bestGap = Infinity;
	for (const a of areas) {
		let gap: number;
		let overlap: boolean;
		if (edge === "W" || edge === "E") {
			gap = edge === "W" ? current.x - (a.x + a.width) : a.x - (current.x + current.width);
			overlap = Math.min(a.y + a.height, current.y + current.height) > Math.max(a.y, current.y);
		} else {
			gap = edge === "N" ? current.y - (a.y + a.height) : a.y - (current.y + current.height);
			overlap = Math.min(a.x + a.width, current.x + current.width) > Math.max(a.x, current.x);
		}
		if (gap >= 0 && overlap && gap < bestGap) {
			best = a;
			bestGap = gap;
		}
	}
	return best;
}

/**
 * A resize by the pointer: the window `from`, with its `sides` dragged by `dx`, `dy`. The depth
 * moves one side only (the edge flush with the screen stays put); the span grows or shrinks
 * about the window's centre, within `lane` (the stretch of the edge free of other windows);
 * a null lane means the span can't change (windows split an edge equally).
 * Depth and span stay between 10 % and the monitor.
 */
export function resizeRect(from: Rect, sides: ("l" | "r" | "t" | "b")[], dx: number, dy: number, edge: Edge, area: Rect, lane: Rect | null): Rect {
	const h = horizontal(edge);
	const r = { ...from };
	const minW = Math.round((area.width * MIN_PCT) / 100);
	const minH = Math.round((area.height * MIN_PCT) / 100);
	const left = sides.includes("l");
	const right = sides.includes("r");
	if (left || right) {
		const grow = right ? dx : -dx;
		if (h) {
			if (lane) {
				r.width = clamp(from.width + 2 * grow, Math.min(minW, lane.width), lane.width);
				r.x = clamp(Math.round(from.x + (from.width - r.width) / 2), lane.x, lane.x + lane.width - r.width);
			}
		} else {
			r.width = clamp(from.width + grow, minW, area.width);
			r.x = edge === "W" ? area.x : area.x + area.width - r.width;
		}
	}
	const top = sides.includes("t");
	const bottom = sides.includes("b");
	if (top || bottom) {
		const grow = bottom ? dy : -dy;
		if (!h) {
			if (lane) {
				r.height = clamp(from.height + 2 * grow, Math.min(minH, lane.height), lane.height);
				r.y = clamp(Math.round(from.y + (from.height - r.height) / 2), lane.y, lane.y + lane.height - r.height);
			}
		} else {
			r.height = clamp(from.height + grow, minH, area.height);
			r.y = edge === "N" ? area.y : area.y + area.height - r.height;
		}
	}
	return r;
}

/** Rects that overlap by no more than this many px along the edge count as touching (rounding). */
const TOUCH_PX = 2;

/** True when any two rects overlap along `edge` (touching doesn't count). */
export function overlapAlong(rects: Rect[], edge: Edge): boolean {
	const h = horizontal(edge);
	const spans = rects.map((r) => (h ? [r.x, r.x + r.width] : [r.y, r.y + r.height])).sort((a, b) => a[0] - b[0]);
	return spans.some((s, i) => i > 0 && s[0] < spans[i - 1][1] - TOUCH_PX);
}

/** `rect` kept flush against `edge` and moved only along it, within the monitor. */
export function alongAxis(rect: Rect, edge: Edge, area: Rect): Rect {
	if (horizontal(edge)) {
		const x = clamp(rect.x, area.x, Math.max(area.x, area.x + area.width - rect.width));
		const y = edge === "N" ? area.y : area.y + area.height - rect.height;
		return { ...rect, x, y };
	}
	const y = clamp(rect.y, area.y, Math.max(area.y, area.y + area.height - rect.height));
	const x = edge === "W" ? area.x : area.x + area.width - rect.width;
	return { ...rect, x, y };
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

/**
 * True when sliding through `edge` would put part of the window on a screen outside its usable
 * area: another monitor, or its own taskbar. Clipping no longer takes effect in time there
 * (Electron 43, PLAN findings), so it fades instead.
 */
export function slidesOnScreen(rect: Rect, edge: Edge, screens: Rect[]): boolean {
	const beyond = beyondEdge(rect, edge);
	return screens.some((s) => intersect(beyond, s) !== null);
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
/** Sliding out speeds up (leaving), where sliding in slows down (arriving). */
const easeIn = (t: number) => t * t * t;

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
function animate(clock: Window, durationMs: number, frame: (progress: number) => boolean, ease = easeOut): Promise<void> {
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
			const more = frame(ease(t));
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
	/** Fade in or out where the window sits instead of sliding (see `slidesOnScreen`). */
	fade?: boolean;
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
	if (o.fade) return fadeInPlace(dir, rect, o);
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
	await animate(o.clock, o.durationMs, (p) => place(lerp(from, to, p)) || dir === "in", dir === "in" ? easeOut : easeIn);
	if (dir === "in") {
		o.win.setBounds(rect);
		o.win.setShape([]); // fully rectangular again, so the inner edge can be dragged
	} else if (visible) {
		o.onGone?.();
	}
}

/** Faintest opacity while fading: a fully transparent window may stop getting frames, which would stall the fade. */
const FADE_FLOOR = 0.01;

/** Fades a Quake window in at `rect`, or out where it is, so no part of it ever leaves its monitor. */
async function fadeInPlace(dir: "in" | "out", rect: Rect, o: SlideOptions): Promise<void> {
	const opacity = (p: number) => {
		o.win.setOpacity(Math.max(FADE_FLOOR, dir === "in" ? p : 1 - p));
		return true;
	};
	if (dir === "in") {
		o.win.setShape([]);
		o.win.setOpacity(FADE_FLOOR);
		o.win.setBounds(rect);
		o.win.show();
		o.onShown?.();
		await animate(o.clock, o.durationMs, opacity);
		o.win.setOpacity(1);
	} else {
		await animate(o.clock, o.durationMs, opacity, easeIn);
		o.onGone?.();
	}
}

/**
 * Animates a visible Quake window to a new place (when the windows sharing its edge change, or
 * when it crosses to another edge or monitor). With `clipTo`, only the parts over those monitors show.
 */
export function move(win: NativeWindow, to: Rect, clock: Window, durationMs: number, clipTo?: Rect[]): Promise<void> {
	const from = win.getBounds();
	return animate(clock, durationMs, (p) => {
		const r = lerp(from, to, p);
		if (clipTo) win.setShape(clipRegion(r, clipTo));
		win.setBounds(r);
		return true;
	}).then(() => {
		if (clipTo) win.setShape([]); // fully rectangular again, so the inner edge can be dragged
	});
}

/** The parts of `r` over `areas`, relative to `r`, for setShape. An empty list would show the whole window, so "nothing" is a zero-size rect. */
function clipRegion(r: Rect, areas: Rect[]): Rect[] {
	const parts = areas.map((a) => intersect(r, a)).filter((c): c is Rect => !!c);
	if (parts.length === 0) return [{ x: 0, y: 0, width: 0, height: 0 }];
	return parts.map((c) => ({ x: c.x - r.x, y: c.y - r.y, width: c.width, height: c.height }));
}
