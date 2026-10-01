import { debounce, Notice, Plugin } from "obsidian";
import { DEFAULT_QUAKE, defaultData, Edge, HideawayData, modeName, WindowConfig } from "./data";
import { Native } from "./electron";
import { HOTKEY_PROBLEMS, HotkeyStatus } from "./hotkeys";
import { HideawaySettingTab } from "./settings";
import { WindowManager } from "./windows";

// Writes debug.log in the plugin's folder. For development only; keep off in releases.
const DEBUG_LOG = false;

const EDGES: Edge[] = ["N", "S", "E", "W"];

export default class HideawayPlugin extends Plugin {
	data: HideawayData = defaultData();
	private native: Native | null = null;
	private windows: WindowManager | null = null;
	private registeredKeys: string[] = [];
	private commandIds: string[] = [];
	/** Per window id, per hotkey row: how registering it went (shown in settings). */
	hotkeyStatus = new Map<string, HotkeyStatus[]>();
	private logChain: Promise<void> = Promise.resolve();

	requestSave = debounce(() => void this.saveData(this.data), 500, true);
	/** Renames and edits are applied once typing pauses. */
	requestApply = debounce(() => this.applySettings(), 500, true);

	async onload() {
		if (process.platform !== "win32") {
			new Notice("Hideaway currently supports Windows only.");
			return;
		}
		this.native = Native.connect();
		if (!this.native) {
			new Notice("Hideaway: couldn't reach the window controls.");
			return;
		}
		await this.loadSettings();
		this.windows = new WindowManager(this, this.native);
		this.addWindowCommands();
		this.registerHotkeys(true);
		this.register(() => this.windows?.releaseAll());
		this.addSettingTab(new HideawaySettingTab(this.app, this));

		const layoutChanged = debounce(() => this.windows?.onLayoutChange(), 300, true);
		this.registerEvent(this.app.workspace.on("layout-change", layoutChanged));
		this.app.workspace.onLayoutReady(() => void this.windows?.adoptAll());
		this.log("loaded");
	}

	onunload() {
		this.unregisterHotkeys();
		this.requestSave.run();
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<HideawayData> | null;
		// Anything without the current version (e.g. the prototype's data) is replaced.
		if (saved?.version === 1 && Array.isArray(saved.windows)) {
			this.data = { ...defaultData(), ...saved } as HideawayData;
		}
	}

	// ---------- settings changes ----------

	/** Saves and applies settings now: hotkeys and command names follow immediately. */
	applySettings() {
		this.requestApply.cancel();
		this.requestSave();
		this.unregisterHotkeys();
		this.registerHotkeys(false);
		this.removeWindowCommands();
		this.addWindowCommands();
	}

	addWindow(): WindowConfig {
		const cfg: WindowConfig = {
			id: `w${Date.now().toString(36)}`,
			name: `Window ${this.data.windows.length + 1}`,
			hotkeys: [],
			startingNote: "",
			quake: { ...DEFAULT_QUAKE },
		};
		this.data.windows.push(cfg);
		this.applySettings();
		return cfg;
	}

	/** Removes a window from settings; if it exists, it becomes an ordinary pop-out. */
	removeWindow(cfg: WindowConfig) {
		this.windows?.release(cfg.id);
		this.data.windows = this.data.windows.filter((w) => w !== cfg);
		delete this.data.state[cfg.id];
		this.hotkeyStatus.delete(cfg.id);
		this.applySettings();
	}

	private addWindowCommands() {
		for (const cfg of this.data.windows) {
			const name = cfg.name.trim() || "Untitled";
			this.addWindowCommand(`toggle-${cfg.id}`, `Toggle ${name}`, () => void this.windows?.toggle(cfg, "normal"));
			for (const edge of EDGES) {
				this.addWindowCommand(`quake-${edge.toLowerCase()}-${cfg.id}`, `${name}: ${modeName(edge)}`, () => void this.windows?.toggle(cfg, edge));
			}
			this.addWindowCommand(`reset-${cfg.id}`, `Reset ${name} position and size`, () => this.windows?.reset(cfg));
		}
	}

	private addWindowCommand(id: string, name: string, callback: () => void) {
		this.addCommand({ id, name, callback });
		this.commandIds.push(id);
	}

	private removeWindowCommands() {
		for (const id of this.commandIds) this.removeCommand(id);
		this.commandIds = [];
	}

	// ---------- system-wide hotkeys (PLAN §3) ----------

	/** Registers every window's hotkeys. On load, problems are also shown as notices. */
	private registerHotkeys(notify: boolean) {
		const native = this.native;
		if (!native) return;
		this.hotkeyStatus.clear();
		const seen = new Set<string>();
		for (const cfg of this.data.windows) {
			const statuses: HotkeyStatus[] = [];
			this.hotkeyStatus.set(cfg.id, statuses);
			for (const binding of cfg.hotkeys) {
				const key = binding.accelerator;
				if (!key) {
					statuses.push("ok");
					continue;
				}
				let result: HotkeyStatus;
				if (seen.has(key)) {
					result = "duplicate";
				} else {
					seen.add(key);
					result = native.registerShortcut(key, () => void this.windows?.toggle(cfg, binding.mode));
					if (result === "ok") this.registeredKeys.push(key);
				}
				statuses.push(result);
				this.log(`hotkey ${key} (${cfg.name}, ${modeName(binding.mode)}): ${result}`);
				if (notify && result !== "ok") new Notice(`Hideaway: ${key} (${cfg.name}) ${HOTKEY_PROBLEMS[result]}.`);
			}
		}
	}

	private unregisterHotkeys() {
		for (const key of this.registeredKeys) this.native?.unregisterShortcut(key);
		this.registeredKeys = [];
	}

	/** While recording a hotkey in settings, Hideaway's own hotkeys mustn't catch the keys. */
	suspendHotkeys() {
		this.unregisterHotkeys();
	}

	resumeHotkeys() {
		this.unregisterHotkeys();
		this.registerHotkeys(false);
	}

	// ---------- debug log ----------

	/** Only ever called with Hideaway's own windows and settings, never other windows or vaults. */
	log(msg: string) {
		if (!DEBUG_LOG) return;
		const path = `${this.manifest.dir}/debug.log`;
		const line = `${new Date().toISOString()} ${msg}\n`;
		const adapter = this.app.vault.adapter;
		this.logChain = this.logChain
			.then(async () => {
				if (await adapter.exists(path)) await adapter.append(path, line);
				else await adapter.write(path, line);
			})
			.catch(() => {
				// logging must never break the plugin
			});
	}
}
