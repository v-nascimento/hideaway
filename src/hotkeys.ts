// Turning key presses into system-wide hotkeys (Electron "accelerators") and back.

import type { ShortcutResult } from "./electron";

/** Result of registering one hotkey; "duplicate" = already used by another Hideaway hotkey. */
export type HotkeyStatus = ShortcutResult | "duplicate";

export const HOTKEY_PROBLEMS: Record<Exclude<HotkeyStatus, "ok">, string> = {
	taken: "is already used by another app",
	invalid: "isn't a valid hotkey",
	duplicate: "is already used by another Hideaway hotkey",
};

/** Physical key (KeyboardEvent.code) -> accelerator key. Physical keys, so the
 *  recorded hotkey doesn't depend on the keyboard layout's characters. */
const KEYS: Record<string, string> = {
	Space: "Space", Tab: "Tab", Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
	Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
	ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
	Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
	Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
	NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec",
};

function keyFromCode(code: string): string | null {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
	return KEYS[code] ?? null;
}

export type RecordResult =
	| { kind: "key"; accelerator: string }
	| { kind: "cancel" }
	| { kind: "incomplete" } // only modifiers so far
	| { kind: "rejected"; reason: string };

/** Interprets one keydown while recording. */
export function recordKey(e: KeyboardEvent): RecordResult {
	if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return { kind: "cancel" };
	if (["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"].includes(e.key)) return { kind: "incomplete" };
	const key = keyFromCode(e.code);
	if (!key) return { kind: "rejected", reason: "That key can't be used." };
	const mods: string[] = [];
	if (e.ctrlKey) mods.push("Control");
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");
	if (e.metaKey) mods.push("Super");
	// A system-wide hotkey without a modifier would swallow that key everywhere.
	if (mods.length === 0 && !/^F\d+$/.test(key)) {
		return { kind: "rejected", reason: "Add Ctrl, Alt, Shift or Win (only F-keys work alone)." };
	}
	return { kind: "key", accelerator: [...mods, key].join("+") };
}

/** "Control+Alt+F10" -> "Ctrl + Alt + F10" */
export function formatAccelerator(accelerator: string): string {
	const names: Record<string, string> = { Control: "Ctrl", Super: "Win", Up: "↑", Down: "↓", Left: "←", Right: "→" };
	return accelerator.split("+").map((part) => names[part] ?? part).join(" + ");
}

/** Ctrl+Alt+<character key> is AltGr+<key> on many layouts, which types characters (PLAN §3). */
export function isAltGrRisk(accelerator: string): boolean {
	const parts = accelerator.split("+");
	const key = parts[parts.length - 1];
	const typesCharacter = /^[A-Z0-9]$/.test(key) || "`-=[]\\;',./".includes(key);
	return parts.includes("Control") && parts.includes("Alt") && typesCharacter;
}
