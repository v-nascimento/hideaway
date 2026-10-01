import { debounce, Notice, TFile, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import type HideawayPlugin from "./main";
import type { Mode, WindowConfig, WindowState } from "./data";
import type { Native, NativeWindow, Rect } from "./electron";

const DEFAULT_SIZE = { width: 900, height: 650 };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A named window that currently exists (shown or hidden). */
interface LiveWindow {
	cfg: WindowConfig;
	win: NativeWindow;
	ww: WorkspaceWindow;
	mode: Mode;
	/** False while hidden; anything that shows it then is undone (Tray, Obsidian). */
	wantVisible: boolean;
	/** Set once the window starts closing; its layout must not be touched after that. */
	closing: boolean;
	cleanups: (() => void)[];
}

/** Compact description of a layout tree, for the debug log. */
function shape(node: any): string {
	if (!node) return "?";
	if (node.type === "leaf") return "L";
	const kids = (node.children ?? []).map(shape).join(",");
	if (node.type === "tabs") return `T[${kids}]`;
	return `${node.type === "window" ? "W" : "S"}-${node.direction ?? "?"}(${kids})`;
}

export class WindowManager {
	private live = new Map<string, LiveWindow>();
	private busy = new Set<string>();
	private quitting = false;

	constructor(private plugin: HideawayPlugin, private native: Native) {
		// When Obsidian quits, don't bring hidden windows back on the way out.
		plugin.registerDomEvent(window, "beforeunload", () => {
			this.quitting = true;
			// If Tray only hid the main window, Obsidian is still running.
			window.setTimeout(() => (this.quitting = false), 2000);
		});
		this.hookTabClose();
	}

	private get app() {
		return this.plugin.app;
	}

	private state(cfg: WindowConfig): WindowState {
		return (this.plugin.data.state[cfg.id] ??= {});
	}

	// ---------- finding windows ----------

	private leavesIn(ww: WorkspaceWindow): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.getContainer() === ww) leaves.push(leaf);
		});
		return leaves;
	}

	private popoutById(id: string): WorkspaceWindow | null {
		let found: WorkspaceWindow | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const c = leaf.getContainer();
			if (c instanceof WorkspaceWindow && (c as any).id === id) found = c;
		});
		return found;
	}

	private layoutOf(ww: WorkspaceWindow): any {
		const layout = this.app.workspace.getLayout() as any;
		return layout?.floating?.children?.find((c: any) => c.id === (ww as any).id);
	}

	/** After Obsidian starts (or the plugin loads), take back windows Obsidian restored and hide them. */
	async adoptAll() {
		for (const cfg of this.plugin.data.windows) {
			const id = this.state(cfg).popoutId;
			const ww = id ? this.popoutById(id) : null;
			if (!ww) continue;
			const win = await this.native.findWindow(ww.doc);
			if (!win) continue;
			const was = win.getBounds();
			this.native.hide(win, false);
			this.native.park(win);
			this.attach(cfg, win, ww);
			this.plugin.log(`${cfg.name}: adopted after load and hid it (restored at x=${was.x} y=${was.y})`);
		}
		this.app.workspace.requestSaveLayout();
	}

	// ---------- creating and rebuilding (PLAN Q2, Q8) ----------

	private async open(cfg: WindowConfig): Promise<LiveWindow | null> {
		const st = this.state(cfg);
		return st.layout ? this.rebuild(cfg, st) : this.createFresh(cfg);
	}

	/** Opens a pop-out off-screen and hides it, so Obsidian's automatic show doesn't flash. */
	private async openHidden(width: number, height: number) {
		const leaf = this.app.workspace.openPopoutLeaf({ x: -32000, y: -32000, size: { width, height } });
		const ww = leaf.getContainer();
		if (!(ww instanceof WorkspaceWindow)) return null;
		const win = await this.native.findWindow(ww.doc);
		if (!win) return null;
		this.native.hide(win, false);
		this.native.park(win);
		return { leaf, ww, win };
	}

	private async createFresh(cfg: WindowConfig): Promise<LiveWindow | null> {
		const made = await this.openHidden(DEFAULT_SIZE.width, DEFAULT_SIZE.height);
		if (!made) return null;
		const note = cfg.startingNote ? this.app.vault.getAbstractFileByPath(cfg.startingNote) : null;
		if (note instanceof TFile) await made.leaf.openFile(note);
		this.plugin.log(`${cfg.name}: created fresh${note ? ` with ${cfg.startingNote}` : ""}`);
		return this.attach(cfg, made.win, made.ww);
	}

	private async rebuild(cfg: WindowConfig, st: WindowState): Promise<LiveWindow | null> {
		const root = st.layout;
		const t0 = performance.now();
		const made = await this.openHidden(root.width ?? DEFAULT_SIZE.width, root.height ?? DEFAULT_SIZE.height);
		if (!made) return null;
		const idMap = new Map<string, WorkspaceLeaf>();
		try {
			await this.buildNode(root, made.leaf, idMap);
		} catch (e) {
			this.plugin.log(`${cfg.name}: rebuild error: ${e}`);
		}
		const active = st.activeLeafId ? idMap.get(st.activeLeafId) : undefined;
		if (active) this.app.workspace.setActiveLeaf(active, { focus: false });
		// Give the editors a moment to load before putting the cursors back.
		await wait(50);
		for (const [oldId, leaf] of idMap) {
			const e = st.eStates?.[oldId];
			if (e) leaf.setEphemeralState(e);
		}
		this.plugin.log(`${cfg.name}: rebuilt ${idMap.size} tab(s) in ${Math.round(performance.now() - t0)} ms (${shape(root)})`);
		return this.attach(cfg, made.win, made.ww);
	}

	/** Rebuilds one node of a saved layout into `leaf`, an empty slot. */
	private async buildNode(node: any, leaf: WorkspaceLeaf, idMap: Map<string, WorkspaceLeaf>) {
		const ws = this.app.workspace;
		if (node.type === "leaf") {
			await leaf.setViewState(node.state);
			idMap.set(node.id, leaf);
			return;
		}
		const kids: any[] = node.children ?? [];
		if (node.type === "tabs") {
			const leaves = [leaf];
			for (let i = 1; i < kids.length; i++) leaves.push(ws.createLeafInParent(leaf.parent as any, i));
			for (let i = 0; i < kids.length; i++) await this.buildNode(kids[i], leaves[i], idMap);
			const current = leaves[node.currentTab ?? 0];
			if (current) ws.setActiveLeaf(current, { focus: false });
			return;
		}
		// "window" or "split": make a slot for every child first, then fill them.
		const slots = [leaf];
		for (let i = 1; i < kids.length; i++) slots.push(ws.createLeafBySplit(slots[i - 1], node.direction ?? "vertical"));
		for (let i = 0; i < kids.length; i++) await this.buildNode(kids[i], slots[i], idMap);
	}

	private attach(cfg: WindowConfig, win: NativeWindow, ww: WorkspaceWindow): LiveWindow {
		const lw: LiveWindow = { cfg, win, ww, mode: "normal", wantVisible: false, closing: false, cleanups: [] };
		this.live.set(cfg.id, lw);
		this.state(cfg).popoutId = (ww as any).id;
		this.plugin.requestSave();

		// Tray's show-all (or Obsidian) may show a hidden window: hide it again and
		// focus the main window, so Tray sees Obsidian as visible (PLAN Q7).
		lw.cleanups.push(this.native.listen(win, "show", () => {
			if (lw.wantVisible) return;
			win.hide();
			this.native.park(win);
			const main = this.native.mainWindow();
			if (main.isVisible()) main.focus();
		}));
		lw.cleanups.push(this.native.listen(win, "closed", () => {
			this.plugin.log(`${cfg.name}: closed`);
			this.detach(lw);
		}));

		// Cursor moves don't change the layout, so watch the selection instead.
		const cursorsSoon = debounce(() => this.saveCursors(lw), 500, true);
		ww.doc.addEventListener("selectionchange", cursorsSoon);
		lw.cleanups.push(() => ww.doc.removeEventListener("selectionchange", cursorsSoon));

		// X closes the window (PLAN: Close button). Its tabs are already saved, since
		// Obsidian empties the window before this point; only the position is left.
		const onBeforeUnload = () => {
			lw.closing = true;
			this.rememberNormalRect(lw);
		};
		ww.win.addEventListener("beforeunload", onBeforeUnload);
		lw.cleanups.push(() => ww.win.removeEventListener("beforeunload", onBeforeUnload));

		return lw;
	}

	/**
	 * Closing the last tab closes the window directly, without emptying it first,
	 * so it looks like a close with X everywhere except here: Obsidian's tab-close
	 * action (WorkspaceLeaf.detach), which every way of closing a tab goes through.
	 * Wrapped for as long as the plugin is loaded.
	 */
	private hookTabClose() {
		const proto = WorkspaceLeaf.prototype as any;
		const original = proto.detach;
		let active = true;
		const manager = this;
		const wrapper = function (this: WorkspaceLeaf, ...args: unknown[]) {
			if (active) manager.beforeTabClose(this);
			return original.apply(this, args);
		};
		proto.detach = wrapper;
		this.plugin.register(() => {
			active = false;
			// Only restore if no other plugin has wrapped it since; otherwise stay inert.
			if (proto.detach === wrapper) proto.detach = original;
		});
	}

	/**
	 * If this is the window's last tab, the next window starts fresh. A close with X
	 * also closes the tabs, but Obsidian has already taken them out of the window by
	 * then (0 left), so that case keeps the saved tabs.
	 */
	private beforeTabClose(leaf: WorkspaceLeaf) {
		const lw = [...this.live.values()].find((l) => leaf.getContainer() === l.ww);
		if (!lw || lw.closing) return;
		const leaves = this.leavesIn(lw.ww).length;
		this.plugin.log(`${lw.cfg.name}: tab closing; tabs in window: ${leaves}`);
		if (leaves !== 1) return;
		lw.closing = true;
		const st = this.state(lw.cfg);
		st.layout = undefined;
		st.eStates = undefined;
		st.activeLeafId = undefined;
		this.plugin.requestSave();
		this.plugin.log(`${lw.cfg.name}: last tab closed, next window starts fresh`);
	}

	private detach(lw: LiveWindow) {
		for (const off of lw.cleanups) off();
		lw.cleanups = [];
		if (this.live.get(lw.cfg.id) === lw) this.live.delete(lw.cfg.id);
	}

	// ---------- remembering (PLAN Q8) ----------

	/** Called on every layout change: keep each window's tabs and splits. */
	onLayoutChange() {
		for (const lw of this.live.values()) {
			if (lw.closing) continue; // closed with X: keep what we have
			const node = this.layoutOf(lw.ww);
			const leaves = this.leavesIn(lw.ww).length;
			// Window gone or emptied: keep what we have (beforeTabClose handles the last tab).
			if (!node || leaves === 0) continue;
			this.state(lw.cfg).layout = node;
			this.saveCursors(lw);
		}
	}

	private saveCursors(lw: LiveWindow) {
		const leaves = this.leavesIn(lw.ww);
		if (leaves.length === 0) return;
		const st = this.state(lw.cfg);
		const eStates: Record<string, unknown> = {};
		for (const leaf of leaves) eStates[(leaf as any).id] = leaf.getEphemeralState();
		const active = this.app.workspace.getMostRecentLeaf(lw.ww);
		st.eStates = eStates;
		st.activeLeafId = active ? (active as any).id : undefined;
		this.plugin.requestSave();
	}

	private rememberNormalRect(lw: LiveWindow) {
		if (lw.mode !== "normal" || !lw.win.isVisible()) return;
		const rect = lw.win.getBounds();
		if (this.native.isParked(rect)) return;
		this.state(lw.cfg).normalRect = rect;
		this.plugin.requestSave();
	}

	private normalRect(cfg: WindowConfig): Rect {
		const saved = this.state(cfg).normalRect;
		if (saved && this.native.isOnScreen(saved)) return saved;
		return this.native.centredOnCursor(DEFAULT_SIZE.width, DEFAULT_SIZE.height);
	}

	// ---------- toggle rules (PLAN §4) ----------

	async toggle(cfg: WindowConfig, mode: Mode) {
		// Ignore presses while this window is opening or animating, so they can't pile up.
		if (this.busy.has(cfg.id)) return;
		this.busy.add(cfg.id);
		try {
			let lw = this.live.get(cfg.id);
			if (!lw || lw.win.isDestroyed()) lw = (await this.open(cfg)) ?? undefined;
			if (!lw) {
				new Notice(`Hideaway: couldn't open ${cfg.name}.`);
				return;
			}
			if (!lw.win.isVisible()) {
				await this.show(lw, mode);
			} else if (lw.mode !== mode) {
				await this.hide(lw, true);
				await this.show(lw, mode);
			} else if (!lw.win.isFocused()) {
				this.focus(lw);
			} else {
				await this.hide(lw);
			}
		} catch (e) {
			this.plugin.log(`${cfg.name}: toggle failed: ${e}`);
			new Notice(`Hideaway: ${cfg.name}: ${e instanceof Error ? e.message : e}`);
		} finally {
			this.busy.delete(cfg.id);
		}
	}

	private async show(lw: LiveWindow, mode: Mode) {
		if (mode !== "normal") throw new Error("Quake Mode isn't built yet.");
		lw.wantVisible = true;
		lw.mode = mode;
		this.native.unminimize(lw.win);
		this.native.setQuakeStyle(lw.win, false);
		this.native.showAt(lw.win, this.normalRect(lw.cfg));
		this.focus(lw);
	}

	/** Brings the window forward and focuses its last active tab, cursor where it was left. */
	private focus(lw: LiveWindow) {
		lw.win.show();
		lw.win.focus();
		lw.ww.win.focus();
		const leaf = this.app.workspace.getMostRecentLeaf(lw.ww);
		if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private async hide(lw: LiveWindow, switching = false) {
		this.saveCursors(lw);
		this.rememberNormalRect(lw);
		lw.wantVisible = false;
		this.native.hide(lw.win, !switching);
		if (switching) return;
		this.native.park(lw.win);
		// Moving a window isn't a layout change, so ask Obsidian to save the parked
		// position now; otherwise a restart brings the window back on-screen.
		this.app.workspace.requestSaveLayout();
	}

	/** "Reset position and size": forget the saved position and recentre a visible window. */
	reset(cfg: WindowConfig) {
		this.state(cfg).normalRect = undefined;
		this.plugin.requestSave();
		const lw = this.live.get(cfg.id);
		if (lw && lw.wantVisible && lw.mode === "normal") {
			this.native.showAt(lw.win, this.normalRect(cfg));
		}
	}

	// ---------- unload (PLAN §8) ----------

	/** Turns every named window back into an ordinary pop-out. */
	releaseAll() {
		for (const lw of [...this.live.values()]) {
			this.detach(lw);
			try {
				if (lw.win.isDestroyed()) continue;
				this.native.release(lw.win, this.normalRect(lw.cfg), !this.quitting);
			} catch (e) {
				this.plugin.log(`${lw.cfg.name}: release failed: ${e}`);
			}
		}
	}
}
