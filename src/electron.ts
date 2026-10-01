// The only file that talks to Electron (PLAN §1). Everything platform-specific
// lives here, so macOS and Linux can be added later.

export type Rect = { x: number; y: number; width: number; height: number };

/** The parts of Electron's BrowserWindow that Hideaway uses. */
export interface NativeWindow {
	isDestroyed(): boolean;
	isVisible(): boolean;
	isFocused(): boolean;
	isMinimized(): boolean;
	getBounds(): Rect;
	setBounds(rect: Rect): void;
	getTitle(): string;
	show(): void;
	hide(): void;
	focus(): void;
	minimize(): void;
	restore(): void;
	setOpacity(opacity: number): void;
	setAlwaysOnTop(flag: boolean): void;
	setSkipTaskbar(skip: boolean): void;
	setShape(rects: Rect[]): void;
	on(event: string, listener: () => void): void;
	removeListener(event: string, listener: () => void): void;
}

interface Display {
	bounds: Rect;
	workArea: Rect;
}

interface Remote {
	BrowserWindow: { getAllWindows(): NativeWindow[] };
	getCurrentWindow(): NativeWindow;
	globalShortcut: {
		register(accelerator: string, callback: () => void): boolean;
		unregister(accelerator: string): void;
		isRegistered(accelerator: string): boolean;
	};
	screen: {
		getCursorScreenPoint(): { x: number; y: number };
		getDisplayNearestPoint(point: { x: number; y: number }): Display;
		getAllDisplays(): Display[];
	};
}

export type ShortcutResult = "ok" | "taken" | "invalid";

/** Where hidden windows wait: far off every monitor. */
const PARKED = -32000;
// Shortcuts held by Hideaway. Kept on the page (not the plugin instance) so a
// reloaded copy can take back shortcuts an old copy failed to release.
const OWNED_SHORTCUTS = "__hideawayShortcuts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function intersect(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export class Native {
	private constructor(private remote: Remote) {}

	/** Returns null when Electron isn't reachable (e.g. mobile). */
	static connect(): Native | null {
		try {
			const electron = require("electron");
			const remote = electron.remote ?? require("@electron/remote");
			return remote ? new Native(remote) : null;
		} catch {
			return null;
		}
	}

	/** Finds the native window behind a pop-out by briefly giving it a unique title. */
	async findWindow(doc: Document): Promise<NativeWindow | null> {
		const original = doc.title;
		const marker = `hideaway-${Date.now()}-${Math.random()}`;
		doc.title = marker;
		try {
			for (let i = 0; i < 100; i++) {
				const win = this.remote.BrowserWindow.getAllWindows().find((w) => w.getTitle() === marker);
				if (win) return win;
				await wait(10);
			}
			return null;
		} finally {
			doc.title = original;
		}
	}

	mainWindow(): NativeWindow {
		return this.remote.getCurrentWindow();
	}

	listen(win: NativeWindow, event: string, listener: () => void): () => void {
		win.on(event, listener);
		return () => {
			try {
				win.removeListener(event, listener);
			} catch {
				// window already destroyed
			}
		};
	}

	/**
	 * Hides a window and leaves it transparent, so nothing appears if Tray or
	 * Obsidian shows it anyway. Minimizing first makes Windows give focus back to
	 * the app used before (PLAN Q5); the transparency hides the animation.
	 */
	hide(win: NativeWindow, returnFocus: boolean) {
		win.setOpacity(0);
		if (returnFocus) win.minimize();
		win.hide();
	}

	/** Moves a hidden window far off-screen, keeping its size. */
	park(win: NativeWindow) {
		const b = win.getBounds();
		win.setOpacity(0);
		win.setBounds({ x: PARKED, y: PARKED, width: b.width, height: b.height });
	}

	isParked(rect: Rect): boolean {
		return rect.x <= PARKED / 2 && rect.y <= PARKED / 2;
	}

	/** Un-minimizes invisibly, so Windows doesn't animate it up from the taskbar. */
	unminimize(win: NativeWindow) {
		if (!win.isMinimized()) return;
		win.setOpacity(0);
		win.restore();
		win.hide();
	}

	/** Always on top and out of the taskbar and Alt+Tab (Quake), or neither (Normal). */
	setQuakeStyle(win: NativeWindow, quake: boolean) {
		win.setAlwaysOnTop(quake);
		win.setSkipTaskbar(quake);
	}

	/** Shows a window fully, at the given position. */
	showAt(win: NativeWindow, rect: Rect) {
		win.setShape([]);
		win.setBounds(rect);
		win.setOpacity(1);
		win.show();
	}

	/** Restores a window to an ordinary pop-out (PLAN §8). */
	release(win: NativeWindow, rect: Rect, show: boolean) {
		if (win.isMinimized()) win.restore();
		win.setShape([]);
		this.setQuakeStyle(win, false);
		win.setBounds(rect);
		win.setOpacity(1);
		if (show) win.show();
	}

	cursorWorkArea(): Rect {
		const s = this.remote.screen;
		return s.getDisplayNearestPoint(s.getCursorScreenPoint()).workArea;
	}

	/** True when at least part of the rect is on some monitor. */
	isOnScreen(rect: Rect): boolean {
		return this.remote.screen.getAllDisplays().some((d) => intersect(rect, d.workArea) !== null);
	}

	centredOnCursor(width: number, height: number): Rect {
		const area = this.cursorWorkArea();
		const w = Math.min(width, area.width);
		const h = Math.min(height, area.height);
		return { x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2), width: w, height: h };
	}

	// ---------- system-wide shortcuts (PLAN §3) ----------

	private owned(): Set<string> {
		const page = window as unknown as Record<string, Set<string> | undefined>;
		return (page[OWNED_SHORTCUTS] ??= new Set<string>());
	}

	registerShortcut(accelerator: string, callback: () => void): ShortcutResult {
		const gs = this.remote.globalShortcut;
		const owned = this.owned();
		try {
			// Left behind by an old copy of Hideaway that didn't unload cleanly.
			if (owned.has(accelerator) && gs.isRegistered(accelerator)) gs.unregister(accelerator);
			if (!gs.register(accelerator, callback)) return "taken";
		} catch {
			return "invalid";
		}
		owned.add(accelerator);
		return "ok";
	}

	unregisterShortcut(accelerator: string) {
		try {
			this.remote.globalShortcut.unregister(accelerator);
		} catch {
			// not registered
		}
		this.owned().delete(accelerator);
	}
}
