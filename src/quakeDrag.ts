// Moving and resizing a Quake window from inside the page. Hideaway follows the
// pointer itself, one change per frame, instead of fighting the system's own
// window drag and resize (which jittered: its events reach us too late to steer).

import type { Edge } from "./data";

/** A side of the window, as the pointer grabs it. */
export type Side = "l" | "r" | "t" | "b";

/** The sides a grip may take for each edge: every side except the one flush with the screen. */
const GRIPS: Record<Edge, Side[][]> = {
	N: [["l"], ["r"], ["b"], ["b", "l"], ["b", "r"]],
	S: [["l"], ["r"], ["t"], ["t", "l"], ["t", "r"]],
	W: [["t"], ["b"], ["r"], ["r", "t"], ["r", "b"]],
	E: [["t"], ["b"], ["l"], ["l", "t"], ["l", "b"]],
};

/** On the pop-out's body while Hideaway moves and resizes it from the page (see styles.css). */
const FRAME_CLASS = "hideaway-quake-frame";

const THIN = 6; // px
const CORNER = 14; // px

const CURSORS: Record<string, string> = {
	l: "ew-resize", r: "ew-resize", t: "ns-resize", b: "ns-resize",
	bl: "nesw-resize", lb: "nesw-resize", tr: "nesw-resize", rt: "nesw-resize",
	br: "nwse-resize", rb: "nwse-resize", tl: "nwse-resize", lt: "nwse-resize",
};

/** The empty parts of the title bar and tab bar: where a drag may start. */
function isHandle(el: Element): boolean {
	return el.matches(".titlebar, .workspace-tab-header-container, .workspace-tab-header-spacer");
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface FrameHandlers {
	/** The window's bounds if the user can drag or resize it now; otherwise null. */
	start(): Bounds | null;
	/** Dragging by the title bar: the window's wanted top-left corner. */
	move(x: number, y: number): void;
	/** Dragging a side or corner: how far the pointer moved since the grab. */
	resize(from: Bounds, sides: Side[], dx: number, dy: number): void;
	/** The pointer was released. */
	drop(kind: "move" | "resize"): void;
}

export class QuakeFrame {
	private grips: HTMLElement[] = [];
	private edge: Edge | null = null;
	private offDown: (() => void) | null = null;

	constructor(private doc: Document, private handlers: FrameHandlers) {}

	/** Turns Hideaway's dragging and resizing on for a window on `edge`, or off (the system's are back) with null. */
	sync(edge: Edge | null) {
		if (edge === this.edge) return;
		this.edge = edge;
		this.clearGrips();
		if (!edge) return this.disable();
		if (!this.offDown) this.enable();
		for (const sides of GRIPS[edge]) this.addGrip(sides);
	}

	disable() {
		this.edge = null;
		this.clearGrips();
		this.offDown?.();
		this.offDown = null;
		this.doc.body.removeClass(FRAME_CLASS);
	}

	private enable() {
		// Obsidian marks the title bar and tab bar as the system's drag area; this class takes
		// that away (styles.css) so the pointer reaches the page.
		this.doc.body.addClass(FRAME_CLASS);
		const onDown = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (e.button === 0 && target && isHandle(target)) this.track(e, null);
		};
		this.doc.addEventListener("pointerdown", onDown, true);
		this.offDown = () => this.doc.removeEventListener("pointerdown", onDown, true);
	}

	private clearGrips() {
		for (const g of this.grips) g.remove();
		this.grips = [];
	}

	/** An invisible strip along a side, or a square at a corner, that starts a resize. */
	private addGrip(sides: Side[]) {
		const el = this.doc.body.createDiv();
		const s = el.style;
		s.position = "fixed";
		s.zIndex = sides.length > 1 ? "100001" : "100000";
		s.setProperty("-webkit-app-region", "no-drag");
		s.cursor = CURSORS[sides.join("")];
		const [first, second] = sides;
		if (second) {
			s.width = s.height = `${CORNER}px`;
			s[first === "l" || second === "l" ? "left" : "right"] = "0";
			s[first === "t" || second === "t" ? "top" : "bottom"] = "0";
		} else if (first === "l" || first === "r") {
			s.top = s.bottom = "0";
			s.width = `${THIN}px`;
			s[first === "l" ? "left" : "right"] = "0";
		} else {
			s.left = s.right = "0";
			s.height = `${THIN}px`;
			s[first === "t" ? "top" : "bottom"] = "0";
		}
		el.addEventListener("pointerdown", (e) => {
			if (e.button === 0) this.track(e, sides);
		});
		this.grips.push(el);
	}

	/** Follows the pointer from a press until it's released; `sides` is null for a title-bar drag. */
	private track(e: PointerEvent, sides: Side[] | null) {
		const from = this.handlers.start();
		if (!from) return;
		const win = this.doc.defaultView!;
		const originX = e.screenX;
		const originY = e.screenY;
		let dx = 0;
		let dy = 0;
		let moved = false;
		let frame = 0;
		const apply = () => {
			frame = 0;
			if (sides) this.handlers.resize(from, sides, dx, dy);
			else this.handlers.move(from.x + dx, from.y + dy);
		};
		const onMove = (m: PointerEvent) => {
			dx = m.screenX - originX;
			dy = m.screenY - originY;
			moved = true;
			if (!frame) frame = win.requestAnimationFrame(apply);
		};
		const onUp = () => {
			win.removeEventListener("pointermove", onMove, true);
			win.removeEventListener("pointerup", onUp, true);
			win.removeEventListener("pointercancel", onUp, true);
			if (frame) win.cancelAnimationFrame(frame);
			if (moved) apply();
			this.handlers.drop(sides ? "resize" : "move");
		};
		win.addEventListener("pointermove", onMove, true);
		win.addEventListener("pointerup", onUp, true);
		win.addEventListener("pointercancel", onUp, true);
		e.preventDefault();
	}
}
