import type { Rect } from "./electron";

export type Edge = "N" | "S" | "E" | "W";
export type Mode = "normal" | Edge;

export const EDGE_NAMES: Record<Edge, string> = { N: "top", S: "bottom", E: "right", W: "left" };

export function modeName(mode: Mode): string {
	return mode === "normal" ? "Normal" : `Quake Mode ${mode} (${EDGE_NAMES[mode]})`;
}

export interface HotkeyBinding {
	/** Electron accelerator, e.g. "Control+Alt+F10". */
	accelerator: string;
	mode: Mode;
}

export interface QuakeConfig {
	/** How far the window reaches in from the edge, in % of the monitor. */
	depth: number;
	/** How much of the edge it covers, in %. */
	span: number;
	durationMs: number;
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

/** What Hideaway remembers about a named window between sessions. */
export interface WindowState {
	/** Obsidian's id for the pop-out, while it exists (open or hidden). */
	popoutId?: string;
	/** The window's part of Obsidian's layout: tabs and splits. */
	layout?: any;
	/** Leaf id -> ephemeral state (cursor, scroll). */
	eStates?: Record<string, unknown>;
	activeLeafId?: string;
	/** Normal-mode position; Obsidian's layout only knows the last position. */
	normalRect?: Rect;
}

export interface HideawayData {
	version: 1;
	windows: WindowConfig[];
	/** Keyed by WindowConfig.id. */
	state: Record<string, WindowState>;
}

export const DEFAULT_QUAKE: QuakeConfig = { depth: 40, span: 100, durationMs: 150 };

export function defaultData(): HideawayData {
	return {
		version: 1,
		windows: [
			{
				id: "scratch",
				name: "Scratch",
				hotkeys: [{ accelerator: "Control+Alt+F10", mode: "normal" }],
				startingNote: "",
				quake: { ...DEFAULT_QUAKE },
			},
		],
		state: {},
	};
}
