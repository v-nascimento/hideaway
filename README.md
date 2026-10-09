# Hideaway

Give Obsidian pop-out windows their own system-wide hotkeys. Press a hotkey from any app to show a window; press it again to hide it. A window can also slide in from a screen edge, like the drop-down console in Quake.

<!-- screenshot: a Quake window sliding in from the top -->

**Windows only.** Obsidian 1.13.1 or later, desktop.

## Getting started

1. Open **Settings → Hideaway** and click the window there, called *Scratch* to start with.
2. Next to **Hotkeys**, click **+** (Add hotkey), then **Set hotkey**, and press the keys you want, for example `Ctrl + Alt + F10`.
3. Choose the mode for that hotkey: **Normal** or **Quake**.
4. Press the hotkey from any app.

Obsidian has to be running (minimized or in the tray is fine) for the hotkeys to work.

## What a hotkey does

| The window is… | Pressing its hotkey… |
|---|---|
| hidden | shows it, with the cursor where you left it |
| shown in the other mode | switches it to this mode |
| shown but behind other windows | brings it to the front |
| in front | hides it, and you're back in the app you were using |

A window can have several hotkeys, each with its own mode.

### Normal mode

The window fades in where you left it, like an ordinary window, and appears in the taskbar while shown. It fades out when you hide it.

### Quake mode

The window slides in from an edge of the monitor your mouse is on. On an edge next to another monitor or the taskbar it fades in and out instead, so it never shows over them. It stays on top and doesn't appear in the taskbar or Alt+Tab.

- **Change edge:** press `Win + ←/→/↑/↓` while it's in front, drag it and let go at a screen edge, or use the "Move to …" commands. Pressing the arrow for the edge it's already on moves it to the next monitor, if there is one.
- **Move and resize:** drag it along its edge, or drag any side except the one against the screen. Hideaway remembers the size and position for each edge.
- **Reset:** the button at the right of its tab bar, the **Reset the window in front** command, or the button in settings.
- **Several windows on one edge** keep their own sizes while they fit, and sit side by side when they don't.

## Tabs and closing

- A window keeps its tabs and splits, also across restarts. The **starting note** is only used when it opens for the first time.
- Closing it with **X** remembers its tabs; the next hotkey press brings them back.
- Closing its **last tab** starts it fresh next time.
- Windows that were hidden when you quit Obsidian come back hidden.

## Settings

Settings → Hideaway lists your windows; open one to edit it. For each window: name, starting note, hotkeys and their modes, the starting edge for Quake mode, the default depth and span (in % of the screen, separately for top/bottom and left/right), and the animation duration (how long it slides or fades; 0 shows it instantly). All of it is also found through Obsidian's settings search.

Hotkeys need Ctrl, Alt, Shift or Win (F-keys can be used alone). Hideaway warns you when another app already uses a hotkey, and about `Ctrl + Alt + letter`, which types characters on many keyboard layouts. `Win + arrow` can't be used, because it moves Quake windows.

## Commands

Each window gets commands in the command palette: toggle (Normal), Quake mode, move to top / bottom / left / right, and reset position and size. They work while Obsidian is in front, and you can give them Obsidian hotkeys.

## Good to know

- **Tray plugin:** Hideaway works alongside it. Tray keeps handling the main window; Hideaway only handles its own windows.
- **One vault at a time:** enable Hideaway in one vault per computer. If two open vaults use it, the second one can't register the same hotkeys and shows a warning.
- **Disabling Hideaway** turns its windows back into ordinary pop-out windows and releases the hotkeys.
- Hideaway controls windows through Electron directly and relies on a few parts of Obsidian that aren't part of the public plugin API. A future Obsidian update could break it; please [open an issue](https://github.com/v-nascimento/hideaway/issues) if it does.

## Privacy and permissions

- No network requests, no telemetry, no accounts.
- Registers system-wide hotkeys while Obsidian is running, and moves, shows and hides only its own windows.
- Never changes your notes; it only opens them. Its settings are stored in its own plugin folder.

## License

[MIT](LICENSE)
