import { debounce, Notice, Plugin } from "obsidian";
import { defaultData, HideawayData, modeName } from "./data";
import { Native } from "./electron";
import { WindowManager } from "./windows";

// Writes debug.log in the plugin's folder while Hideaway is in development.
// Turn off before the first release.
const DEBUG_LOG = true;

export default class HideawayPlugin extends Plugin {
	data: HideawayData = defaultData();
	private native: Native | null = null;
	private windows: WindowManager | null = null;
	private registeredKeys: string[] = [];
	private logChain: Promise<void> = Promise.resolve();

	requestSave = debounce(() => void this.saveData(this.data), 500, true);

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
		this.registerHotkeys();
		this.register(() => this.windows?.releaseAll());

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

	private addWindowCommands() {
		for (const cfg of this.data.windows) {
			this.addCommand({
				id: `toggle-${cfg.id}`,
				name: `Toggle ${cfg.name}`,
				callback: () => void this.windows?.toggle(cfg, "normal"),
			});
			this.addCommand({
				id: `reset-${cfg.id}`,
				name: `Reset ${cfg.name} position and size`,
				callback: () => this.windows?.reset(cfg),
			});
		}
	}

	// ---------- system-wide hotkeys (PLAN §3) ----------

	private registerHotkeys() {
		const native = this.native;
		if (!native) return;
		const seen = new Set<string>();
		for (const cfg of this.data.windows) {
			for (const binding of cfg.hotkeys) {
				const key = binding.accelerator;
				if (!key) continue;
				if (seen.has(key)) {
					new Notice(`Hideaway: ${key} is set more than once; only the first one works.`);
					continue;
				}
				seen.add(key);
				const result = native.registerShortcut(key, () => void this.windows?.toggle(cfg, binding.mode));
				this.log(`hotkey ${key} (${cfg.name}, ${modeName(binding.mode)}): ${result}`);
				if (result === "ok") this.registeredKeys.push(key);
				else new Notice(`Hideaway: ${key} (${cfg.name}) ${result === "taken" ? "is already used by another app" : "isn't a valid hotkey"}.`);
			}
		}
	}

	private unregisterHotkeys() {
		for (const key of this.registeredKeys) this.native?.unregisterShortcut(key);
		this.registeredKeys = [];
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
