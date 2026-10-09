import { AbstractInputSuggest, App, ButtonComponent, Modal, PluginSettingTab, Scope, Setting, TFile } from "obsidian";
import { Edge, EDGE_NAMES, HotkeyBinding, Mode, modeName, WindowConfig } from "./data";
import { formatAccelerator, HOTKEY_PROBLEMS, HotkeyStatus, isAltGrRisk, recordKey } from "./hotkeys";
import type HideawayPlugin from "./main";

const MODES: Mode[] = ["normal", "quake"];
const EDGES: Edge[] = ["N", "S", "E", "W"];

export class HideawaySettingTab extends PluginSettingTab {
	/** Stops the key recorder, if one is running. */
	private stopRecording: (() => void) | null = null;

	constructor(app: App, private plugin: HideawayPlugin) {
		super(app, plugin);
	}

	display() {
		this.stopRecording?.();
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Each window gets its own system-wide hotkeys: press one to show the window, press it again to hide it.",
		});
		for (const cfg of this.plugin.data.windows) this.renderWindow(containerEl, cfg);
		new Setting(containerEl).addButton((b) =>
			b.setButtonText("Add window").setCta().onClick(() => {
				this.plugin.addWindow();
				this.refresh();
			}),
		);
	}

	/** Redraws after a change without jumping back to the top. */
	private refresh() {
		// The settings page scrolls in this element or its parent, depending on the layout.
		const scrollers = [this.containerEl, this.containerEl.parentElement].filter((e): e is HTMLElement => !!e);
		const tops = scrollers.map((e) => e.scrollTop);
		this.display();
		scrollers.forEach((e, i) => (e.scrollTop = tops[i]));
	}

	hide() {
		this.stopRecording?.();
		// Apply a rename that's still waiting for typing to pause.
		this.plugin.requestApply.run();
	}

	private renderWindow(el: HTMLElement, cfg: WindowConfig) {
		const heading = new Setting(el).setName(cfg.name || "Untitled").setHeading();

		new Setting(el).setName("Name").addText((t) =>
			t.setValue(cfg.name).onChange((value) => {
				cfg.name = value;
				heading.setName(value || "Untitled");
				this.plugin.requestApply();
			}),
		);

		const statuses = this.plugin.hotkeyStatus.get(cfg.id) ?? [];
		cfg.hotkeys.forEach((binding, i) => this.renderHotkey(el, cfg, binding, i, statuses[i]));
		new Setting(el)
			.setName(cfg.hotkeys.length === 0 ? "Hotkeys" : "")
			.setDesc(cfg.hotkeys.length === 0 ? "No hotkeys yet. Add one to show this window from any app. Its commands also work, while Obsidian is in front." : "")
			.addButton((b) =>
				b.setButtonText("Add hotkey").onClick(() => {
					cfg.hotkeys.push({ accelerator: "", mode: "normal" });
					this.plugin.applySettings();
					this.refresh();
				}),
			);

		new Setting(el)
			.setName("Starting note")
			.setDesc("Opened when the window is new, or after all its tabs were closed. Leave empty for a new tab.")
			.addText((t) => {
				t.setPlaceholder("Folder/Note.md").setValue(cfg.startingNote);
				t.onChange((value) => {
					cfg.startingNote = value.trim();
					this.plugin.requestSave();
				});
				const suggest = new NoteSuggest(this.app, t.inputEl);
				suggest.onSelect((file) => {
					t.setValue(file.path);
					cfg.startingNote = file.path;
					this.plugin.requestSave();
					suggest.close();
				});
			});

		const q = cfg.quake;
		new Setting(el)
			.setName("Starting edge")
			.setDesc("Where Quake mode opens the first time. After that it opens on the edge it was last on.")
			.addDropdown((d) => {
				for (const edge of EDGES) d.addOption(edge, EDGE_NAMES[edge]);
				d.setValue(q.edge).onChange((value) => {
					q.edge = value as Edge;
					this.plugin.requestSave();
				});
			});
		this.addNumbers(el, "Quake depth", "The default: how far a Quake window reaches in from its edge, in % of the screen (10 to 100). Top/bottom is a share of the height, left/right of the width.", 10, 100, [
			{ label: "Top/bottom", value: q.depth, set: (v) => (q.depth = v) },
			{ label: "Left/right", value: q.sideDepth, set: (v) => (q.sideDepth = v) },
		], cfg);
		this.addNumbers(el, "Quake span", "The default: how much of its edge it covers, in % (10 to 100). Top/bottom is a share of the width, left/right of the height.", 10, 100, [
			{ label: "Top/bottom", value: q.span, set: (v) => (q.span = v) },
			{ label: "Left/right", value: q.sideSpan, set: (v) => (q.sideSpan = v) },
		], cfg);
		this.addNumbers(el, "Quake slide duration", "In milliseconds (0 to 1000). 0 shows it instantly.", 0, 1000, [{ value: q.durationMs, set: (v) => (q.durationMs = v) }]);
		new Setting(el)
			.setName("Reset position and size")
			.setDesc("Back to the defaults above on the current edge, centred. A Normal window forgets its saved position.")
			.addButton((b) => b.setButtonText("Reset").onClick(() => this.plugin.resetWindow(cfg)));

		new Setting(el).addButton((b) =>
			b.setButtonText("Remove window").setWarning().onClick(() => {
				new ConfirmModal(
					this.app,
					`Remove "${cfg.name || "Untitled"}"?`,
					"Its hotkeys and commands are removed. If the window is open or hidden, it becomes an ordinary pop-out window with its tabs.",
					"Remove",
					() => {
						this.plugin.removeWindow(cfg);
						this.refresh();
					},
				).open();
			}),
		);
	}

	/**
	 * One or more whole-number fields in a row. Out-of-range values are clamped when you
	 * leave a field or press Enter; empty or invalid input goes back to the last good value.
	 */
	private addNumbers(el: HTMLElement, name: string, desc: string, min: number, max: number, fields: { label?: string; value: number; set: (v: number) => void }[], live?: WindowConfig) {
		const setting = new Setting(el).setName(name).setDesc(desc);
		for (const field of fields) {
			if (field.label) setting.controlEl.createSpan({ cls: "setting-item-description", text: field.label });
			setting.addText((t) => {
				let good = field.value;
				t.inputEl.type = "number";
				t.inputEl.min = String(min);
				t.inputEl.max = String(max);
				t.inputEl.step = "1";
				t.inputEl.setCssProps({ width: "5em" });
				t.setValue(String(good));
				const commit = () => {
					const typed = t.inputEl.value.trim();
					const parsed = typed === "" ? NaN : Number(typed);
					if (Number.isFinite(parsed)) good = Math.min(max, Math.max(min, Math.round(parsed)));
					t.setValue(String(good));
					if (good === field.value) return;
					field.value = good;
					field.set(good);
					this.plugin.requestSave();
					if (live) this.plugin.refreshQuake(live);
				};
				t.inputEl.addEventListener("blur", commit);
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") commit();
				});
			});
		}
	}

	private renderHotkey(el: HTMLElement, cfg: WindowConfig, binding: HotkeyBinding, index: number, status?: HotkeyStatus) {
		const row = new Setting(el).setName(index === 0 ? "Hotkeys" : "");
		row.addButton((b) => {
			b.setButtonText(binding.accelerator ? formatAccelerator(binding.accelerator) : "Click to set");
			b.onClick(() => this.record(b, binding));
		});
		row.addDropdown((d) => {
			for (const mode of MODES) d.addOption(mode, modeName(mode));
			d.setValue(binding.mode).onChange((value) => {
				binding.mode = value as Mode;
				this.plugin.applySettings();
			});
		});
		row.addExtraButton((b) =>
			b.setIcon("trash").setTooltip("Remove hotkey").onClick(() => {
				cfg.hotkeys.splice(cfg.hotkeys.indexOf(binding), 1);
				this.plugin.applySettings();
				this.refresh();
			}),
		);

		const warnings: string[] = [];
		if (status && status !== "ok") warnings.push(`This hotkey ${HOTKEY_PROBLEMS[status]}.`);
		if (binding.accelerator && isAltGrRisk(binding.accelerator)) {
			warnings.push("Ctrl+Alt+key is AltGr+key on many keyboard layouts, so it may block typing a character.");
		}
		for (const w of warnings) row.descEl.createDiv({ cls: "mod-warning", text: w });
	}

	/** Click-and-press key recorder. Esc cancels; clicking elsewhere cancels too. */
	private record(button: ButtonComponent, binding: HotkeyBinding) {
		this.stopRecording?.();
		// Hideaway's own hotkeys would otherwise catch the keys before we see them.
		this.plugin.suspendHotkeys();
		button.setButtonText("Press keys… (Esc to cancel)");

		// A scope on top of Obsidian's catches every key, so Esc doesn't close settings.
		const scope = new Scope(this.app.scope);
		let done = false;
		const finish = (accelerator: string | null) => {
			if (done) return;
			done = true;
			this.app.keymap.popScope(scope);
			button.buttonEl.removeEventListener("blur", onBlur);
			this.stopRecording = null;
			if (accelerator) binding.accelerator = accelerator;
			this.plugin.applySettings(); // registers the hotkeys again, including the new one
			this.refresh();
		};
		const onBlur = () => finish(null);
		scope.register(null, null, (evt) => {
			const result = recordKey(evt);
			if (result.kind === "key") finish(result.accelerator);
			else if (result.kind === "cancel") finish(null);
			else if (result.kind === "rejected") button.setButtonText(result.reason);
			return false;
		});
		this.app.keymap.pushScope(scope);
		button.buttonEl.addEventListener("blur", onBlur);
		this.stopRecording = () => finish(null);
	}
}

class NoteSuggest extends AbstractInputSuggest<TFile> {
	constructor(private vaultApp: App, inputEl: HTMLInputElement) {
		super(vaultApp, inputEl);
	}

	protected getSuggestions(query: string): TFile[] {
		const q = query.toLowerCase();
		return this.vaultApp.vault.getMarkdownFiles().filter((f) => f.path.toLowerCase().includes(q)).slice(0, 50);
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		el.setText(file.path);
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
				b.setButtonText(this.action).setWarning().onClick(() => {
					this.close();
					this.onConfirm();
				}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
