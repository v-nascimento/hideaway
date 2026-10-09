import { debounce, Notice, TFile, WorkspaceLeaf, WorkspaceWindow } from "obsidian";
import type HideawayPlugin from "./main";
import { defaultPlacement, Edge, Mode, QuakePlacement, WindowConfig, WindowState } from "./data";
import type { Native, NativeEvent, NativeInput, NativeWindow, Rect } from "./electron";
import { alongAxis, edgeAtPoint, fade, FADE_FLOOR, isDefaultPlacement, move, neighbourArea, OPPOSITE, overlapAlong, placementFromRect, quakeRect, resizeRect, slide, slidesOnScreen } from "./quake";
import { QuakeButton } from "./quakeButton";
import { QuakeFrame } from "./quakeDrag";

const DEFAULT_SIZE = { width: 900, height: 650 };

/** Win+arrow, as seen in the focused window, and the edge each one asks for. */
const WIN_ARROW_EDGE: Record<string, Edge> = { ArrowUp: "N", ArrowDown: "S", ArrowLeft: "W", ArrowRight: "E" };
/** The side of a window that is flush with the screen, as Electron names it in `will-resize`. */
const FLUSH_SIDE: Record<Edge, string> = { N: "top", S: "bottom", W: "left", E: "right" };

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

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
	/** While shown in Quake mode: where, and which edge group it belongs to. */
	quake?: QuakePlace;
	/** Above 0 while Hideaway itself moves the window, so it isn't taken for a user move or resize. */
	animating: number;
	/** The reset button in the tab bar (Quake mode only). */
	button: QuakeButton;
	/** Moves and resizes the window from the page in Quake mode. */
	frame: QuakeFrame;
	cleanups: (() => void)[];
}

interface QuakePlace {
	area: Rect;
	edge: Edge;
	/** Edge group key: same monitor and edge. */
	group: string;
	rect: Rect;
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
	/** Quake windows shown on the same monitor edge, in opening order (PLAN: sharing an edge). */
	private edgeGroups = new Map<string, LiveWindow[]>();

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
		const lw: LiveWindow = {
			cfg,
			win,
			ww,
			mode: "normal",
			wantVisible: false,
			closing: false,
			animating: 0,
			button: new QuakeButton(ww.doc, () => void this.reset(cfg)),
			frame: new QuakeFrame(ww.doc, {
				start: () => (this.userControlled(lw) ? win.getBounds() : null),
				move: (x, y) => this.dragTo(lw, x, y),
				resize: (from, sides, dx, dy) => this.resizeTo(lw, from, sides, dx, dy),
				drop: (kind) => (kind === "move" ? this.onMoved(lw) : this.onResized(lw)),
			}),
			cleanups: [],
		};
		lw.cleanups.push(() => {
			lw.button.remove();
			lw.frame.disable();
		});
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
			// Windows that shared its edge fill the space again.
			void this.leaveEdgeGroup(lw, true);
		}));

		this.watchUserMoves(lw);

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

	// ---------- the user moving and resizing a Quake window (PLAN: Quake changes) ----------

	/** True while the user can be moving or resizing this window: shown in Quake mode and not being moved by Hideaway. */
	private userControlled(lw: LiveWindow): boolean {
		return !!lw.quake && lw.wantVisible && !lw.animating && !lw.closing && !this.busy.has(lw.cfg.id);
	}

	/**
	 * True while the window's edge is split equally: other windows are on it and, at their own
	 * sizes and places, they would overlap. Otherwise each window keeps its own place.
	 */
	private sharing(lw: LiveWindow): boolean {
		const q = lw.quake;
		const members = this.edgeGroups.get(q?.group ?? "") ?? [];
		if (!q || members.length < 2) return false;
		return overlapAlong([...this.ownRects(members, q.area, q.edge).values()], q.edge);
	}

	/**
	 * The first move or resize on an equally split edge keeps the split as it is: every
	 * window's current size and place become its own, so they no longer overlap and can be adjusted.
	 */
	private freezeSplit(lw: LiveWindow) {
		const q = lw.quake!;
		for (const m of this.edgeGroups.get(q.group) ?? []) {
			if (m.quake && this.alive(m)) this.savePlacement(m, q.edge, placementFromRect(m.quake.rect, q.area, q.edge));
		}
	}

	/** The stretch of the edge a window can move or grow into: bounded by its neighbours, or the whole monitor. */
	private lane(lw: LiveWindow): Rect {
		const q = lw.quake!;
		const horiz = q.edge === "N" || q.edge === "S";
		const own = horiz ? [q.rect.x, q.rect.x + q.rect.width] : [q.rect.y, q.rect.y + q.rect.height];
		let lo = horiz ? q.area.x : q.area.y;
		let hi = horiz ? q.area.x + q.area.width : q.area.y + q.area.height;
		for (const m of this.edgeGroups.get(q.group) ?? []) {
			if (m === lw || !m.quake) continue;
			const r = m.quake.rect;
			const [from, to] = horiz ? [r.x, r.x + r.width] : [r.y, r.y + r.height];
			if (to <= own[0]) lo = Math.max(lo, to);
			else if (from >= own[1]) hi = Math.min(hi, from);
		}
		return horiz ? { ...q.area, x: lo, width: hi - lo } : { ...q.area, y: lo, height: hi - lo };
	}

	private watchUserMoves(lw: LiveWindow) {
		const { win } = lw;
		const listen = (event: string, fn: (...args: any[]) => void) => lw.cleanups.push(this.native.listen(win, event, fn));

		// Fallback if the system resizes anyway: the edge flush against the screen can't be dragged.
		listen("will-resize", (event: NativeEvent, _next: Rect, details: { edge: string }) => {
			const q = lw.quake;
			if (q && this.userControlled(lw) && details.edge.includes(FLUSH_SIDE[q.edge])) event.preventDefault();
		});
		listen("moved", () => this.onMoved(lw));
		listen("resized", () => this.onResized(lw));
		// Dragging to the top of the screen, or Win+Up, maximizes the window: take it as "move to the top".
		listen("maximize", () => this.onMaximize(lw));
		// Win+Down minimizes the window: take it as "move to the bottom". The key press itself never reaches us
		// (and the Win key's own press isn't reliable), so any minimize counts; hiding is the hotkey's job.
		listen("minimize", () => this.onMinimize(lw));
		lw.cleanups.push(this.native.listenInput(win, (input) => this.onKey(lw, input)));
	}

	/** After a drag: dropped with the pointer at a screen edge changes edge; otherwise the new position along the edge is saved. */
	private onMoved(lw: LiveWindow) {
		const q = lw.quake;
		if (!q || !this.userControlled(lw)) return;
		const cursor = this.native.cursorPoint();
		const area = this.native.workAreaAt(cursor);
		const edge = edgeAtPoint(cursor, area);
		this.plugin.log(`${lw.cfg.name}: moved, pointer ${JSON.stringify(cursor)} edge=${edge ?? "none"} (on ${q.edge})`);
		if (edge && (edge !== q.edge || !sameRect(area, q.area))) {
			void this.exclusive(lw.cfg.id, () => this.relocate(lw, edge, area), lw);
			return;
		}
		this.saveFromBounds(lw);
	}

	/** After a resize: the span stays centred where it was, whichever side was dragged. */
	private onResized(lw: LiveWindow) {
		if (lw.quake && this.userControlled(lw)) this.saveFromBounds(lw, true);
	}

	/** A title-bar drag: the window follows the pointer along its edge only; on a shared edge it stays put. */
	private dragTo(lw: LiveWindow, x: number, y: number) {
		const q = lw.quake;
		if (!q || lw.win.isDestroyed()) return;
		if (this.sharing(lw)) this.freezeSplit(lw);
		lw.win.setBounds(alongAxis({ ...q.rect, x, y }, q.edge, this.lane(lw)));
	}

	/** A pointer resize in progress: depth on one side, span about the centre (within the free stretch). */
	private resizeTo(lw: LiveWindow, from: Rect, sides: ("l" | "r" | "t" | "b")[], dx: number, dy: number) {
		const q = lw.quake;
		if (!q || lw.win.isDestroyed()) return;
		if (this.sharing(lw)) this.freezeSplit(lw);
		lw.win.setBounds(resizeRect(from, sides, dx, dy, q.edge, q.area, this.lane(lw)));
	}

	/** Saves the window's size and position for its edge, then snaps it flush and into its slot. */
	private saveFromBounds(lw: LiveWindow, keepCentre = false) {
		const q = lw.quake!;
		const placement = placementFromRect(lw.win.getBounds(), q.area, q.edge);
		if (keepCentre) placement.centre = this.placementOf(lw, q.edge).centre;
		// While the edge is split equally only the depth is the window's own.
		this.savePlacement(lw, q.edge, this.sharing(lw) ? { ...this.placementOf(lw, q.edge), depth: placement.depth } : placement);
		const members = this.edgeGroups.get(q.group) ?? [lw];
		const rects = this.slotRects(members);
		q.rect = rects.get(lw) ?? q.rect;
		lw.win.setBounds(q.rect);
		// If this made the windows overlap, the others move into the equal split.
		void Promise.all(this.moveMembers(members.filter((m) => m !== lw && m.quake && !sameRect(m.quake.rect, rects.get(m)!)), rects));
		this.syncButton(lw);
		this.plugin.log(`${lw.cfg.name}: placement on ${q.edge} saved: ${JSON.stringify(this.placementOf(lw, q.edge))}`);
	}

	private onMaximize(lw: LiveWindow) {
		const q = lw.quake;
		if (!q || !this.userControlled(lw)) return;
		this.plugin.log(`${lw.cfg.name}: maximize taken as move to top`);
		const cursor = this.native.cursorPoint();
		const dropArea = this.native.workAreaAt(cursor);
		const area = edgeAtPoint(cursor, dropArea) === "N" ? dropArea : q.area;
		void this.exclusive(
			lw.cfg.id,
			async () => {
				lw.win.unmaximize();
				if (edgeAtPoint(cursor, dropArea) === "N") await this.relocate(lw, "N", area);
				else await this.stepToward(lw, "N"); // Win+Up
			},
			lw,
		);
	}

	private onMinimize(lw: LiveWindow) {
		if (!lw.quake || !this.userControlled(lw)) return;
		this.plugin.log(`${lw.cfg.name}: minimize taken as Win+Down`);
		void this.exclusive(
			lw.cfg.id,
			async () => {
				lw.win.restore();
				await this.stepToward(lw, "S");
			},
			lw,
		);
	}

	private onKey(lw: LiveWindow, input: NativeInput) {
		const edge = input.meta && input.type === "keyUp" ? WIN_ARROW_EDGE[input.key] : undefined;
		if (!edge || !lw.quake || !this.userControlled(lw)) return;
		this.plugin.log(`${lw.cfg.name}: Win+${input.key} -> ${edge}`);
		void this.exclusive(
			lw.cfg.id,
			() => this.stepToward(lw, edge),
			lw,
		);
	}

	/** Runs `fn` unless this window is busy; while it runs, the window's own moves aren't taken for the user's. */
	private async exclusive(id: string, fn: () => Promise<void>, lw?: LiveWindow) {
		if (this.busy.has(id)) return;
		this.busy.add(id);
		if (lw) lw.animating++;
		try {
			await fn();
		} catch (e) {
			this.plugin.log(`${id}: failed: ${e}`);
		} finally {
			if (lw) lw.animating--;
			this.busy.delete(id);
		}
	}

	/** False for a window whose native window is gone; such a window must not stay in an edge group. */
	private alive(lw: LiveWindow): boolean {
		try {
			if (!lw.win.isDestroyed()) return true;
		} catch {
			// the window object itself is gone
		}
		this.plugin.log(`${lw.cfg.name}: dropped a destroyed window from its edge group`);
		return false;
	}

	private placementOf(lw: LiveWindow, edge: Edge): QuakePlacement {
		return this.state(lw.cfg).quakePlacement?.[edge] ?? defaultPlacement(lw.cfg.quake, edge);
	}

	private savePlacement(lw: LiveWindow, edge: Edge, placement: QuakePlacement) {
		const st = this.state(lw.cfg);
		(st.quakePlacement ??= {})[edge] = placement;
		this.plugin.requestSave();
	}

	/** The reset button shows in Quake mode while the current edge's placement isn't the default. */
	private syncButton(lw: LiveWindow) {
		const q = lw.quake;
		const custom = !!q && !isDefaultPlacement(this.state(lw.cfg).quakePlacement?.[q.edge], defaultPlacement(lw.cfg.quake, q.edge));
		lw.button.sync(lw.mode === "quake" && lw.wantVisible && custom);
		lw.frame.sync(lw.mode === "quake" && lw.wantVisible && q ? q.edge : null);
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
			this.syncButton(lw); // tab changes and splits rebuild the tab bar
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

	/** "Toggle" for Quake mode opens on the last edge used (or the starting edge the first time). */
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

	private async show(lw: LiveWindow, mode: Mode, area?: Rect) {
		lw.wantVisible = true;
		lw.mode = mode;
		this.native.unminimize(lw.win);
		if (mode === "normal") {
			lw.button.remove();
			lw.frame.sync(null);
			this.native.setQuakeStyle(lw.win, false);
			this.native.showAt(lw.win, this.normalRect(lw.cfg), FADE_FLOOR);
			this.focus(lw);
			await this.animated(lw, () => fade("in", lw.win, lw.ww.win, lw.cfg.quake.durationMs));
		} else {
			await this.showQuake(lw, area);
		}
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
		if (lw.quake) await this.hideQuake(lw, switching);
		else {
			await this.animated(lw, () => fade("out", lw.win, lw.ww.win, lw.cfg.quake.durationMs));
			this.native.hide(lw.win, !switching);
		}
		if (switching) return;
		this.native.park(lw.win);
		// Moving a window isn't a layout change, so ask Obsidian to save the parked
		// position now; otherwise a restart brings the window back on-screen.
		this.app.workspace.requestSaveLayout();
	}

	/**
	 * "Reset position and size": back to the defaults on the current edge (a
	 * window in Normal mode forgets its saved position); a shown window moves there now.
	 */
	async reset(cfg: WindowConfig) {
		await this.exclusive(cfg.id, async () => {
			const st = this.state(cfg);
			const lw = this.live.get(cfg.id);
			const edge = lw?.quake?.edge ?? st.quakeEdge ?? cfg.quake.edge;
			if (st.quakePlacement) delete st.quakePlacement[edge];
			if (!lw?.quake) st.normalRect = undefined;
			this.plugin.requestSave();
			if (!lw || !lw.wantVisible) return;
			if (lw.quake) {
				const members = this.edgeGroups.get(lw.quake.group) ?? [lw];
				await Promise.all(this.moveMembers(members, this.slotRects(members)));
				this.syncButton(lw);
			} else {
				this.native.showAt(lw.win, this.normalRect(cfg));
			}
		});
	}

	/** The "Reset the window in front" command: resets whichever Hideaway window is in front. */
	resetFocused() {
		const lw = [...this.live.values()].find((l) => l.wantVisible && (l.win.isFocused() || l.ww.doc === activeDocument));
		if (lw) void this.reset(lw.cfg);
		else new Notice("Hideaway: no Hideaway window is in front.");
	}

	/** After a default (depth, span) changed in settings: a shown window on an edge using the defaults follows. */
	refresh(cfg: WindowConfig) {
		const lw = this.live.get(cfg.id);
		if (!lw?.quake || !lw.wantVisible || lw.animating || this.busy.has(cfg.id)) return;
		const members = this.edgeGroups.get(lw.quake.group) ?? [lw];
		void Promise.all(this.moveMembers(members, this.slotRects(members))).then(() => this.syncButton(lw));
	}

	/** "Move to top / bottom / left / right": a shown Quake window slides to that edge; otherwise it opens there. */
	async moveTo(cfg: WindowConfig, edge: Edge) {
		const lw = this.live.get(cfg.id);
		if (lw?.quake && lw.wantVisible) {
			await this.exclusive(cfg.id, () => this.stepToward(lw, edge), lw);
			return;
		}
		this.state(cfg).quakeEdge = edge;
		await this.toggle(cfg, "quake");
	}

	/**
	 * Win+arrow and "Move to …": a window not yet on that edge slides to it; one already there
	 * crosses into the monitor beyond it (if any) in one movement, arriving on that monitor's facing edge.
	 */
	private async stepToward(lw: LiveWindow, edge: Edge) {
		const q = lw.quake!;
		if (edge === q.edge) {
			const next = neighbourArea(this.native.workAreas(), q.area, edge);
			if (next) return this.relocate(lw, OPPOSITE[edge], next);
		}
		return this.slideToEdge(lw, edge, q.area);
	}

	/** Slides a shown Quake window out and back in at an edge of a monitor. */
	private async slideToEdge(lw: LiveWindow, edge: Edge, area: Rect) {
		const q = lw.quake!;
		if (edge === q.edge && sameRect(area, q.area)) {
			this.focus(lw);
			return;
		}
		this.plugin.log(`${lw.cfg.name}: slide to ${edge}`);
		this.state(lw.cfg).quakeEdge = edge;
		await this.hide(lw, true);
		await this.show(lw, "quake", area);
	}

	/** Moves a shown Quake window to another edge or monitor straight from where it is, never showing beyond the two monitors. */
	private async relocate(lw: LiveWindow, edge: Edge, area: Rect) {
		this.plugin.log(`${lw.cfg.name}: relocate to ${edge}`);
		const from = lw.quake!.area;
		await this.leaveEdgeGroup(lw, true);
		const { members, rects } = this.enterEdgeGroup(lw, edge, area);
		await Promise.all([
			move(lw.win, lw.quake!.rect, lw.ww.win, lw.cfg.quake.durationMs, [from, area]),
			...this.moveMembers(members.filter((m) => m !== lw), rects),
		]);
		lw.win.setBounds(lw.quake!.rect);
		this.syncButton(lw);
		this.focus(lw);
	}

	// ---------- Quake mode (PLAN §5) ----------

	/** Joins the windows sharing an edge of a monitor, in opening order, and works out everyone's place. */
	private enterEdgeGroup(lw: LiveWindow, edge: Edge, area: Rect) {
		const group = `${area.x},${area.y},${area.width},${area.height}:${edge}`;
		const members = [...(this.edgeGroups.get(group) ?? []).filter((m) => this.alive(m)), lw];
		this.edgeGroups.set(group, members);
		const rects = this.slotRects(members, area, edge);
		lw.quake = { area, edge, group, rect: rects.get(lw)! };
		this.state(lw.cfg).quakeEdge = edge;
		this.plugin.requestSave();
		return { members, rects };
	}

	/**
	 * Slides a window in from its edge (the last one used, or the starting edge) on
	 * the monitor under the mouse, or on `monitor`, sharing the edge with windows already there.
	 */
	private async showQuake(lw: LiveWindow, monitor?: Rect) {
		await this.leaveEdgeGroup(lw, true); // in case Tray hid it while shown
		const edge = this.state(lw.cfg).quakeEdge ?? lw.cfg.quake.edge;
		const area = monitor ?? this.native.cursorWorkArea();
		const { members, rects } = this.enterEdgeGroup(lw, edge, area);
		this.native.setQuakeStyle(lw.win, true);
		await Promise.all([
			this.animated(lw, () =>
				slide("in", lw.quake!.rect, {
					win: lw.win,
					clock: lw.ww.win,
					area,
					edge,
					durationMs: lw.cfg.quake.durationMs,
					fade: slidesOnScreen(lw.quake!.rect, edge, this.native.screens()),
					onShown: () => this.focus(lw),
				}),
			),
			...this.moveMembers(members.filter((m) => m !== lw), rects),
		]);
		this.syncButton(lw);
	}

	private async hideQuake(lw: LiveWindow, switching: boolean) {
		const q = lw.quake!;
		const from = lw.win.getBounds();
		await Promise.all([
			this.animated(lw, () =>
				slide("out", from, {
					win: lw.win,
					clock: lw.ww.win,
					area: q.area,
					edge: q.edge,
					durationMs: lw.cfg.quake.durationMs,
					fade: slidesOnScreen(from, q.edge, this.native.screens()),
					onGone: () => this.native.hide(lw.win, !switching),
				}),
			),
			this.leaveEdgeGroup(lw, true),
		]);
	}

	/** Each member at its own saved depth, span and position on the edge. */
	private ownRects(members: LiveWindow[], area: Rect, edge: Edge): Map<LiveWindow, Rect> {
		const rects = new Map<LiveWindow, Rect>();
		for (const m of members) {
			const p = this.placementOf(m, edge);
			rects.set(m, quakeRect(area, edge, p.depth, p.span, { index: 0, count: 1 }, p.centre));
		}
		return rects;
	}

	/**
	 * Each member's place on the edge. Windows keep their own size and position as long as they
	 * don't overlap. If they would, they split the widest of their spans equally, centred, in
	 * opening order, each keeping its own depth; their own places come back once they don't overlap.
	 */
	private slotRects(members: LiveWindow[], area?: Rect, edge?: Edge): Map<LiveWindow, Rect> {
		const ref = members.find((m) => m.quake)?.quake;
		const a = area ?? ref!.area;
		const e = edge ?? ref!.edge;
		const own = this.ownRects(members, a, e);
		if (!overlapAlong([...own.values()], e)) return own;
		const rects = new Map<LiveWindow, Rect>();
		const span = Math.max(...members.map((m) => this.placementOf(m, e).span));
		members.forEach((m, index) => {
			rects.set(m, quakeRect(a, e, this.placementOf(m, e).depth, span, { index, count: members.length }, 50));
		});
		return rects;
	}

	/** Animates shown Quake windows to their (new) places. */
	private moveMembers(members: LiveWindow[], rects: Map<LiveWindow, Rect>): Promise<void>[] {
		return members.map((m) => {
			const rect = rects.get(m);
			if (!m.quake || !rect || !this.alive(m)) return Promise.resolve();
			m.quake.rect = rect;
			return this.animated(m, () => move(m.win, rect, m.ww.win, m.cfg.quake.durationMs));
		});
	}

	/** Takes a window out of its edge group; with `fill`, the rest slide over to fill the space. */
	private async leaveEdgeGroup(lw: LiveWindow, fill: boolean) {
		const q = lw.quake;
		lw.quake = undefined;
		if (!q) return;
		const rest = (this.edgeGroups.get(q.group) ?? []).filter((m) => m !== lw && this.alive(m));
		if (rest.length > 0) this.edgeGroups.set(q.group, rest);
		else this.edgeGroups.delete(q.group);
		if (fill && rest.length > 0) await Promise.all(this.moveMembers(rest, this.slotRects(rest)));
	}

	private async animated(lw: LiveWindow, run: () => Promise<void>) {
		lw.animating++;
		try {
			await run();
		} finally {
			lw.animating--;
		}
	}

	// ---------- unload (PLAN §8) ----------

	/** Turns one named window back into an ordinary pop-out (window removed in settings). */
	release(cfgId: string) {
		const lw = this.live.get(cfgId);
		if (!lw) return;
		this.detach(lw);
		void this.leaveEdgeGroup(lw, true);
		if (!lw.win.isDestroyed()) this.native.release(lw.win, this.normalRect(lw.cfg), true);
	}

	/** Turns every named window back into an ordinary pop-out. */
	releaseAll() {
		this.edgeGroups.clear();
		for (const lw of [...this.live.values()]) {
			this.detach(lw);
			lw.quake = undefined;
			try {
				if (lw.win.isDestroyed()) continue;
				this.native.release(lw.win, this.normalRect(lw.cfg), !this.quitting);
			} catch (e) {
				this.plugin.log(`${lw.cfg.name}: release failed: ${e}`);
			}
		}
	}
}
