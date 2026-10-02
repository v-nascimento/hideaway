// The "reset position and size" button in a Quake window's tab bar (PLAN: Reset button).

import { setIcon } from "obsidian";

export class QuakeButton {
	private el: HTMLElement | null = null;

	constructor(private doc: Document, private onClick: () => void) {}

	/**
	 * Shows or hides the button. The tab bar is rebuilt by tab changes, splits and
	 * layout rebuilds, so this puts the button back wherever it went missing.
	 */
	sync(show: boolean) {
		// The top-right tab group is the one that sits next to the window controls.
		const host = this.doc.querySelector<HTMLElement>(".workspace-tabs.mod-top-right-space .workspace-tab-header-container");
		if (!show || !host) {
			this.remove();
			return;
		}
		if (this.el && this.el.parentElement === host) return;
		this.remove();
		const el = host.createDiv({ cls: "clickable-icon hideaway-reset", attr: { "aria-label": "Reset position and size" } });
		setIcon(el, "rotate-ccw");
		el.addEventListener("click", this.onClick);
		this.el = el;
	}

	remove() {
		this.el?.remove();
		this.el = null;
	}
}
