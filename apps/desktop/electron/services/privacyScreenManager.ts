/**
 * Privacy curtain ("防窥幕布") for the Host Companion Agent.
 *
 * When enabled, every display gets a black, always-on-top, click-through
 * `BrowserWindow` marked with `setContentProtection(true)`. On Windows that maps
 * to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, so desktop capture
 * (Apollo / Moonlight / recorders) still sees the real desktop while the
 * physical monitor shows only black.
 *
 * A local rescue hotkey (`Ctrl+Alt+Shift+P`) is registered so the person sitting
 * at the host can always restore the displays without remote help.
 *
 * This module imports `electron`, so it is only loaded by the main process; the
 * pure host-control helpers live in `hostSystemControl.ts` instead.
 */

import { BrowserWindow, globalShortcut, screen } from "electron";

const RESCUE_SHORTCUT = "CommandOrControl+Alt+Shift+P";

const OVERLAY_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000000;
    overflow: hidden;
    cursor: none;
  }
  .hint {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    color: #475569;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    letter-spacing: 0.02em;
    user-select: none;
    white-space: nowrap;
  }
</style>
</head>
<body>__SILKWARP_HINT__</body>
</html>`;

const HINT_TEXT = "隐私保护防窥幕布已开启 · 本机按 Ctrl+Alt+Shift+P 可随时恢复显示";

export interface PrivacyEnableResult {
  active: boolean;
  supported: boolean;
  message?: string;
}

export interface PrivacyDisableResult {
  active: boolean;
  supported: boolean;
}

function buildOverlayUrl(showHint: boolean): string {
  const hint = showHint ? `<div class="hint">${HINT_TEXT}</div>` : "";
  const html = OVERLAY_HTML.replace("__SILKWARP_HINT__", hint);
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Manages the per-display privacy overlays and the local rescue shortcut.
 *
 * `enable()` / `disable()` are idempotent and safe to call from any lifecycle
 * point; `dispose()` is a thin alias used on app quit.
 */
export class PrivacyScreenManager {
  active = false;
  windows: BrowserWindow[] = [];
  onLocalEscape?: () => void;

  private shortcutRegistered = false;
  private readonly onDisplayAdded = (): void => {
    this.rebuildOverlays();
  };
  private readonly onDisplayRemoved = (): void => {
    this.rebuildOverlays();
  };
  private readonly onDisplayMetricsChanged = (): void => {
    this.rebuildOverlays();
  };
  private listenersAttached = false;

  /** Privacy curtains rely on Win32 `WDA_EXCLUDEFROMCAPTURE`. */
  isSupported(): boolean {
    return process.platform === "win32";
  }

  isActive(): boolean {
    return this.active;
  }

  enable(onLocalEscape?: () => void): PrivacyEnableResult {
    if (!this.isSupported()) {
      return {
        active: false,
        supported: false,
        message: "隐私幕布仅支持 Windows 被控端",
      };
    }

    this.onLocalEscape = onLocalEscape;

    // Re-enabling replaces any previous curtains and hotkey registration.
    this.destroyOverlays();
    this.unregisterShortcut();

    let message: string | undefined;
    try {
      this.shortcutRegistered = globalShortcut.register(RESCUE_SHORTCUT, () => {
        this.disable();
        const callback = this.onLocalEscape;
        try {
          callback?.();
        } catch {
          // a throwing consumer must not leave the host stuck behind curtains
        }
      });
      if (!this.shortcutRegistered) {
        message = `本机救援快捷键 ${RESCUE_SHORTCUT} 注册失败（可能被其他程序占用），请通过远程关闭隐私幕布`;
      }
    } catch {
      this.shortcutRegistered = false;
      message = `本机救援快捷键 ${RESCUE_SHORTCUT} 注册失败，请通过远程关闭隐私幕布`;
    }

    this.active = true;
    this.attachScreenListeners();
    this.createOverlays();

    return { active: true, supported: true, message };
  }

  disable(): PrivacyDisableResult {
    const supported = this.isSupported();
    this.unregisterShortcut();
    this.detachScreenListeners();
    this.destroyOverlays();
    this.active = false;
    return { active: false, supported };
  }

  dispose(): void {
    this.disable();
    this.onLocalEscape = undefined;
  }

  private attachScreenListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    screen.on("display-added", this.onDisplayAdded);
    screen.on("display-removed", this.onDisplayRemoved);
    screen.on("display-metrics-changed", this.onDisplayMetricsChanged);
  }

  private detachScreenListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    screen.removeListener("display-added", this.onDisplayAdded);
    screen.removeListener("display-removed", this.onDisplayRemoved);
    screen.removeListener("display-metrics-changed", this.onDisplayMetricsChanged);
  }

  private unregisterShortcut(): void {
    if (!this.shortcutRegistered) return;
    this.shortcutRegistered = false;
    try {
      globalShortcut.unregister(RESCUE_SHORTCUT);
    } catch {
      // shortcut service already torn down
    }
  }

  private rebuildOverlays(): void {
    if (!this.active) return;
    this.destroyOverlays();
    this.createOverlays();
  }

  private createOverlays(): void {
    const primaryId = screen.getPrimaryDisplay().id;
    for (const display of screen.getAllDisplays()) {
      const win = this.createOverlayForDisplay(display, display.id === primaryId);
      if (win) this.windows.push(win);
    }
  }

  private createOverlayForDisplay(
    display: Electron.Display,
    showHint: boolean,
  ): BrowserWindow | null {
    const { x, y, width, height } = display.bounds;
    let win: BrowserWindow;
    try {
      win = new BrowserWindow({
        x,
        y,
        width: Math.max(1, width),
        height: Math.max(1, height),
        frame: false,
        transparent: false,
        backgroundColor: "#000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
    } catch {
      return null;
    }

    try {
      // WDA_EXCLUDEFROMCAPTURE: capture APIs see the real desktop, the physical
      // panel sees black. Must be applied after the native window exists.
      win.setContentProtection(true);
      win.setAlwaysOnTop(true, "screen-saver");
      win.setIgnoreMouseEvents(true);
      win.setBounds({ x, y, width: Math.max(1, width), height: Math.max(1, height) });
      void win.loadURL(buildOverlayUrl(showHint));
      win.once("ready-to-show", () => {
        if (!win.isDestroyed()) win.showInactive();
      });
      win.on("closed", () => {
        this.windows = this.windows.filter((item) => item !== win);
      });
      return win;
    } catch {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        // already gone
      }
      return null;
    }
  }

  private destroyOverlays(): void {
    const wins = this.windows;
    this.windows = [];
    for (const win of wins) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        // window already torn down
      }
    }
  }
}
