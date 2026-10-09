import type { SplitDirection, ViewState } from "obsidian";
import type { Rect } from "./electron";

export type Edge = "N" | "S" | "E" | "W";
export type Mode = "normal" | "quake";

export const EDGE_NAMES: Record<Edge, string> = { N: "top", S: "bottom", E: "right", W: "left" };

export function modeName(mode: Mode): string {
	return mode === "normal" ? "Normal" : "Quake";
}

export interface HotkeyBinding {
	/** Electron accelerator, e.g. "Control+Alt+F10". */
	accelerator: string;
	mode: Mode;
}

export interface QuakeConfig {
	/** The edge the window first opens on; after that, the last edge used. */
	edge: Edge;
	/** Default depth on the top and bottom edges: how far the window reaches in, in % of the monitor's height. */
	depth: number;
	/** Default span on the top and bottom edges: how much of the width it covers, in %. */
	span: number;
	/** The same two defaults for the left and right edges: % of the monitor's width, and of its height. */
	sideDepth: number;
	sideSpan: number;
	/** How long a slide or fade takes, in ms; also used for Normal mode's fade. */
	durationMs: number;
}

/** Where a Quake window sits on one edge, in % of the monitor's usable area. */
export interface QuakePlacement {
	depth: number;
	span: number;
	/** The middle of the window along the edge: 50 is centred. */
	centre: number;
}

/** A named window as set up in settings. */
export interface WindowConfig {
	/** Stable id; command ids and saved state hang off it, so renaming is safe. */
	id: string;
	name: string;
	hotkeys: HotkeyBinding[];
	/** Vault path of the note a fresh window opens with; empty for a new tab. */
	startingNote: string;
	quake: QuakeConfig;
}

/** A node of Obsidian's saved layout (a private format): only the parts Hideaway reads. */
export interface LayoutNode {
	id?: string;
	/** "leaf", "tabs", "split", or "window" (a pop-out's root). */
	type?: string;
	children?: LayoutNode[];
	/** A leaf: what it shows. */
	state?: ViewState;
	/** Tabs: which one is shown. */
	currentTab?: number;
	/** A split or a window. */
	direction?: SplitDirection;
	/** A pop-out's root: its size. */
	width?: number;
	height?: number;
}

/** What Hideaway remembers about a named window between sessions. */
export interface WindowState {
	/** Obsidian's id for the pop-out, while it exists (open or hidden). */
	popoutId?: string;
	/** The window's part of Obsidian's layout: tabs and splits. */
	layout?: LayoutNode;
	/** Leaf id -> ephemeral state (cursor, scroll). */
	eStates?: Record<string, unknown>;
	activeLeafId?: string;
	/** Normal-mode position; Obsidian's layout only knows the last position. */
	normalRect?: Rect;
	/** The edge a Quake window was last on. */
	quakeEdge?: Edge;
	/** Size and position the user chose, per edge. Edges without an entry use the defaults. */
	quakePlacement?: Partial<Record<Edge, QuakePlacement>>;
}

export interface HideawayData {
	version: 2;
	windows: WindowConfig[];
	/** Keyed by WindowConfig.id. */
	state: Record<string, WindowState>;
}

export const DEFAULT_QUAKE: QuakeConfig = { edge: "N", depth: 40, span: 100, sideDepth: 40, sideSpan: 100, durationMs: 150 };

/** The placement a window gets on an edge where the user hasn't chosen one. */
export function defaultPlacement(q: QuakeConfig, edge: Edge): QuakePlacement {
	const sides = edge === "E" || edge === "W";
	return { depth: sides ? q.sideDepth : q.depth, span: sides ? q.sideSpan : q.span, centre: 50 };
}

const EDGES: Edge[] = ["N", "S", "E", "W"];

/** A window as version 1 or 2 saved it; version 1's hotkey modes were edges ("N", …) as well as "normal". */
interface SavedWindow extends Partial<Omit<WindowConfig, "hotkeys" | "quake">> {
	hotkeys?: { accelerator: string; mode: string }[];
	quake?: Partial<QuakeConfig>;
}

/**
 * Turns saved data into the current shape, or returns null when it can't be
 * used (no version, e.g. the prototype's). Version 1 had one hotkey mode per
 * edge; those become Quake hotkeys, and the first one's edge the starting edge.
 */
export function migrate(saved: unknown): HideawayData | null {
	const data = saved as { version?: number; windows?: SavedWindow[]; state?: Record<string, WindowState> } | null;
	if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.windows)) return null;
	const windows = data.windows.map((w): WindowConfig => {
		const oldModes = (w.hotkeys ?? []).map((h) => h.mode);
		const hotkeys: HotkeyBinding[] = (w.hotkeys ?? []).map((h) => ({
			accelerator: h.accelerator,
			mode: h.mode === "normal" ? "normal" : "quake",
		}));
		const firstEdge = oldModes.find((m) => EDGES.includes(m as Edge)) as Edge | undefined;
		return {
			...w,
			hotkeys,
			quake: {
				...DEFAULT_QUAKE,
				...w.quake,
				edge: w.quake?.edge ?? firstEdge ?? DEFAULT_QUAKE.edge,
				// Data from before the side defaults existed: they start the same as the top/bottom ones.
				sideDepth: w.quake?.sideDepth ?? w.quake?.depth ?? DEFAULT_QUAKE.sideDepth,
				sideSpan: w.quake?.sideSpan ?? w.quake?.span ?? DEFAULT_QUAKE.sideSpan,
			},
		} as WindowConfig;
	});
	return { version: 2, windows, state: data.state ?? {} };
}

export function defaultData(): HideawayData {
	return {
		version: 2,
		windows: [
			{
				id: "scratch",
				name: "Scratch",
				hotkeys: [],
				startingNote: "",
				quake: { ...DEFAULT_QUAKE },
			},
		],
		state: {},
	};
}
