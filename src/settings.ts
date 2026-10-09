import { App, ButtonComponent, Modal, PluginSettingTab, Scope, Setting, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from "obsidian";
import { DEFAULT_QUAKE, Edge, EDGE_NAMES, HotkeyBinding, Mode, modeName, WindowConfig } from "./data";
import { formatAccelerator, HOTKEY_PROBLEMS, isAltGrRisk, recordKey } from "./hotkeys";
import type HideawayPlugin from "./main";

const MODES: Mode[] = ["normal", "quake"];
const EDGES: Edge[] = ["N", "S", "E", "W"];

/** The per-window values edited with Obsidian's own controls. Their keys are `<window id>/<field>`. */
type QuakeNumber = "depth" | "sideDepth" | "span" | "sideSpan" | "durationMs";
type Field = "name" | "startingNote" | "edge" | QuakeNumber;

/** Whole numbers within a range; anything else is shown as an error and not saved. */
const wholeNumber = (min: number, max: number) => (value: number) =>
	Number.isInteger(value) && value >= min && value <= max ? undefined : `Enter a whole number from ${min} to ${max}.`;

/**
 * Obsidian's declarative settings (1.13): one entry per window, each opening its own page.
 * Obsidian renders the rows and makes them searchable; values are read and written through
 * getControlValue / setControlValue. The key recorder rows are drawn by Hideaway itself.
 */
export class HideawaySettingTab extends PluginSettingTab {
	/** Stops the key recorder, if one is running; `rerender` false when the row is being torn down anyway. */
	private stopRecording: ((rerender: boolean) => void) | null = null;

	constructor(app: App, private plugin: HideawayPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "",
				desc: "Each window gets its own system-wide hotkeys: press one to show the window, press it again to hide it.",
				searchable: false,
			},
			{
				type: "list",
				heading: "Windows",
				emptyState: "No windows yet.",
				addItem: {
					name: "Add window",
					action: () => {
						this.plugin.addWindow();
						this.update();
					},
				},
				onDelete: (index) => this.confirmRemove(this.plugin.data.windows[index]),
				items: this.plugin.data.windows.map((cfg) => this.windowPage(cfg)),
			},
		];
	}

	hide() {
		this.stopRecording?.(false);
		// Apply a rename that's still waiting for typing to pause, and show the new name next time.
		this.plugin.requestApply.run();
		this.update();
	}

	getControlValue(key: string): unknown {
		const target = this.target(key);
		if (!target) return undefined;
		const { cfg, field } = target;
		if (field === "name") return cfg.name;
		if (field === "startingNote") return cfg.startingNote;
		return cfg.quake[field];
	}

	setControlValue(key: string, value: unknown) {
		const target = this.target(key);
		if (!target) return;
		const { cfg, field } = target;
		if (field === "name") {
			cfg.name = typeof value === "string" ? value : "";
			this.plugin.requestApply(); // command names follow once typing pauses
			return;
		}
		if (field === "startingNote") cfg.startingNote = typeof value === "string" ? value.trim() : "";
		else if (field === "edge") cfg.quake.edge = value as Edge;
		else cfg.quake[field] = value as number;
		this.plugin.requestSave();
		// A shown Quake window follows new default sizes right away.
		if (field !== "startingNote" && field !== "edge" && field !== "durationMs") this.plugin.refreshQuake(cfg);
	}

	/** The window and field a control key stands for. */
	private target(key: string): { cfg: WindowConfig; field: Field } | null {
		const slash = key.indexOf("/");
		const cfg = this.plugin.data.windows.find((w) => w.id === key.slice(0, slash));
		return cfg ? { cfg, field: key.slice(slash + 1) as Field } : null;
	}

	private windowPage(cfg: WindowConfig): SettingDefinitionPage {
		const key = (field: Field) => `${cfg.id}/${field}`;
		const quakeNumber = (field: QuakeNumber, name: string, desc: string, min: number, max: number): SettingGroupItem => ({
			name,
			desc,
			control: { type: "number", key: key(field), defaultValue: DEFAULT_QUAKE[field], min, max, step: 1, validate: wholeNumber(min, max) },
		});
		return {
			type: "page",
			name: cfg.name || "Untitled",
			displayValue: () => this.hotkeySummary(cfg),
			status: () => (this.hotkeyWarnings(cfg).some((w) => w.length > 0) ? "warning" : null),
			items: [
				{
					type: "group",
					items: [
						{ name: "Name", control: { type: "text", key: key("name"), placeholder: "Untitled" } },
						{
							name: "Starting note",
							desc: "Opened when the window is new, or after all its tabs were closed. Leave empty for a new tab.",
							control: { type: "file", key: key("startingNote"), placeholder: "Folder/Note.md", filter: (file) => file.extension === "md" },
						},
					],
				},
				{
					type: "list",
					heading: "Hotkeys",
					emptyState: "No hotkeys yet. Add one to show this window from any app. Its commands also work, while Obsidian is in front.",
					addItem: {
						name: "Add hotkey",
						action: () => {
							cfg.hotkeys.push({ accelerator: "", mode: "normal" });
							this.plugin.applySettings();
							this.update();
						},
					},
					onDelete: (index) => {
						cfg.hotkeys.splice(index, 1);
						this.plugin.applySettings();
						this.update();
					},
					items: cfg.hotkeys.map((binding, index) => this.hotkeyRow(cfg, binding, index)),
				},
				{
					type: "group",
					heading: "Quake mode",
					items: [
						{
							name: "Starting edge",
							desc: "Where the window first slides in. After that, it opens on the edge it was last on.",
							control: { type: "dropdown", key: key("edge"), defaultValue: DEFAULT_QUAKE.edge, options: Object.fromEntries(EDGES.map((e) => [e, EDGE_NAMES[e]])) },
						},
						quakeNumber("depth", "Depth at top and bottom", "The default: how far the window reaches in from the top or bottom edge, in % of the screen height (10 to 100).", 10, 100),
						quakeNumber("sideDepth", "Depth at left and right", "The default: how far the window reaches in from the left or right edge, in % of the screen width (10 to 100).", 10, 100),
						quakeNumber("span", "Span at top and bottom", "The default: how much of the top or bottom edge it covers, in % of the screen width (10 to 100).", 10, 100),
						quakeNumber("sideSpan", "Span at left and right", "The default: how much of the left or right edge it covers, in % of the screen height (10 to 100).", 10, 100),
						quakeNumber("durationMs", "Animation duration", "How long the window slides or fades in and out, in milliseconds (0 to 1000). 0 shows it instantly.", 0, 1000),
						{
							name: "Reset position and size",
							desc: "Back to the defaults above on the current edge, centred. In normal mode, it forgets its saved position instead.",
							render: (setting) => {
								setting.addButton((b) => b.setButtonText("Reset").onClick(() => this.plugin.resetWindow(cfg)));
							},
						},
					],
				},
			],
		};
	}

	/** One hotkey: the key recorder and the mode, with any warnings below the name. */
	private hotkeyRow(cfg: WindowConfig, binding: HotkeyBinding, index: number): SettingGroupItem {
		const warnings = this.hotkeyWarnings(cfg)[index];
		return {
			name: binding.accelerator ? formatAccelerator(binding.accelerator) : "Not set yet",
			desc: createFragment((f) => {
				for (const w of warnings) f.createDiv({ cls: "mod-warning", text: w });
			}),
			render: (setting) => {
				setting.addButton((b) => {
					b.setButtonText(binding.accelerator ? "Change" : "Set hotkey");
					b.onClick(() => this.record(b, binding));
				});
				setting.addDropdown((d) => {
					for (const mode of MODES) d.addOption(mode, modeName(mode));
					d.setValue(binding.mode).onChange((value) => {
						binding.mode = value as Mode;
						this.plugin.applySettings();
						this.update();
					});
				});
				return () => this.stopRecording?.(false);
			},
		};
	}

	/** Per hotkey of the window, its problems as sentences (none: an empty list). */
	private hotkeyWarnings(cfg: WindowConfig): string[][] {
		const statuses = this.plugin.hotkeyStatus.get(cfg.id) ?? [];
		return cfg.hotkeys.map((binding, i) => {
			const warnings: string[] = [];
			const status = statuses[i];
			if (status && status !== "ok") warnings.push(`This hotkey ${HOTKEY_PROBLEMS[status]}.`);
			if (binding.accelerator && isAltGrRisk(binding.accelerator)) {
				warnings.push("Ctrl+Alt+key is AltGr+key on many keyboard layouts, so it may block typing a character.");
			}
			return warnings;
		});
	}

	/** Shown on the window's entry: its hotkeys and their modes. */
	private hotkeySummary(cfg: WindowConfig): string {
		const set = cfg.hotkeys.filter((h) => h.accelerator);
		if (set.length === 0) return "No hotkeys";
		return set.map((h) => `${formatAccelerator(h.accelerator)} (${modeName(h.mode)})`).join(", ");
	}

	private confirmRemove(cfg: WindowConfig | undefined) {
		if (!cfg) return;
		new ConfirmModal(
			this.app,
			`Remove "${cfg.name || "Untitled"}"?`,
			"Its hotkeys and commands are removed. If the window is open or hidden, it becomes an ordinary pop-out window with its tabs.",
			"Remove",
			() => {
				this.plugin.removeWindow(cfg);
				this.update();
			},
		).open();
	}

	/** Click-and-press key recorder. Esc cancels; clicking elsewhere cancels too. */
	private record(button: ButtonComponent, binding: HotkeyBinding) {
		this.stopRecording?.(true);
		// Hideaway's own hotkeys would otherwise catch the keys before we see them.
		this.plugin.suspendHotkeys();
		button.setButtonText("Press keys… (escape to cancel)");

		// A scope on top of Obsidian's catches every key, so Esc doesn't close settings.
		const scope = new Scope(this.app.scope);
		let done = false;
		const finish = (accelerator: string | null, rerender: boolean) => {
			if (done) return;
			done = true;
			this.app.keymap.popScope(scope);
			button.buttonEl.removeEventListener("blur", onBlur);
			this.stopRecording = null;
			if (accelerator) binding.accelerator = accelerator;
			this.plugin.applySettings(); // registers the hotkeys again, including the new one
			if (rerender) this.update();
		};
		const onBlur = () => finish(null, true);
		scope.register(null, null, (evt) => {
			const result = recordKey(evt);
			if (result.kind === "key") finish(result.accelerator, true);
			else if (result.kind === "cancel") finish(null, true);
			else if (result.kind === "rejected") button.setButtonText(result.reason);
			return false;
		});
		this.app.keymap.pushScope(scope);
		button.buttonEl.addEventListener("blur", onBlur);
		this.stopRecording = (rerender) => finish(null, rerender);
	}
}

class ConfirmModal extends Modal {
	constructor(app: App, private title: string, private message: string, private action: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText(this.action).setDestructive().onClick(() => {
					this.close();
					this.onConfirm();
				}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
