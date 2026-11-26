import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { ActiveSessionState, WindowRect } from "../types";

export const COLLAPSED_SIZE = { width: 290, height: 38 };
export const EXPANDED_SIZE = { width: 580, height: 470 };

const EDGE_MARGIN = 4;
const TOP_OFFSET = 6;

/**
 * Top-of-screen transparent floating session control bar.
 *
 * The bar tracks the remote Moonlight window in physical Win32 pixels, converts
 * them to DIPs with `screen.screenToDipRect` (multi-DPI correctness) and clamps
 * itself into the matching display's work area.
 */
export class FloatingBarWindow {
  private win: BrowserWindow | null = null;
  private expanded = false;
  private offsetX = 0;
  private lastRect: WindowRect | null = null;
  private lastState: ActiveSessionState | null = null;
  private ready = false;
  private loaded = false;

  constructor() {
    this.create();
  }

  private create(): void {
    this.win = new BrowserWindow({
      ...COLLAPSED_SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const win = this.win;
    win.setAlwaysOnTop(true, "screen-saver");

    if (process.env.VITE_DEV_SERVER_URL) {
      void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#session-bar`);
    } else {
      void win.loadFile(path.resolve(__dirname, "../dist/index.html"), { hash: "session-bar" });
    }

    win.once("ready-to-show", () => {
      this.ready = true;
      this.positionFor(this.lastRect);
      win.showInactive();
      this.flushState();
    });

    win.webContents.on("did-finish-load", () => {
      this.loaded = true;
      this.flushState();
    });

    win.on("closed", () => {
      this.win = null;
      this.ready = false;
      this.loaded = false;
    });
  }

  private currentSize(): { width: number; height: number } {
    return this.expanded ? EXPANDED_SIZE : COLLAPSED_SIZE;
  }

  private positionFor(winRect: WindowRect | null): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;

    const { width: curWidth, height: curHeight } = this.currentSize();

    let workArea: Electron.Rectangle;
    let targetX: number;
    let targetY: number;

    if (winRect === null) {
      const primary = screen.getPrimaryDisplay();
      workArea = primary.workArea;
      targetX = Math.round(workArea.x + (workArea.width - curWidth) / 2 + this.offsetX);
      targetY = workArea.y + 8;
    } else {
      const dipRect = screen.screenToDipRect(null, {
        x: winRect.x,
        y: winRect.y,
        width: Math.max(1, winRect.width),
        height: Math.max(1, winRect.height),
      });
      workArea = screen.getDisplayMatching(dipRect).workArea;
      targetX = Math.round(dipRect.x + (dipRect.width - curWidth) / 2 + this.offsetX);
      targetY = Math.round(dipRect.y + TOP_OFFSET);
    }

    const minX = workArea.x + EDGE_MARGIN;
    const maxX = workArea.x + workArea.width - curWidth - EDGE_MARGIN;
    const minY = workArea.y + EDGE_MARGIN;
    const maxY = workArea.y + workArea.height - curHeight - EDGE_MARGIN;

    const x = Math.max(minX, Math.min(maxX, targetX));
    const y = Math.max(minY, Math.min(maxY, targetY));

    win.setBounds({ x, y, width: curWidth, height: curHeight }, false);
  }

  updateAnchor(winRect: WindowRect | null): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;

    this.lastRect = winRect;

    if (winRect !== null && (winRect.minimized || !winRect.visible)) {
      if (win.isVisible()) win.hide();
      return;
    }

    this.positionFor(winRect);
    if (this.ready && !win.isVisible()) {
      win.showInactive();
    }
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    if (!this.win || this.win.isDestroyed()) return;
    this.updateAnchor(this.lastRect);
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  nudgeOffset(deltaX: number): void {
    this.offsetX += Math.round(deltaX);
    this.updateAnchor(this.lastRect);
  }

  sendSessionState(state: ActiveSessionState | null): void {
    this.lastState = state;
    this.flushState();
  }

  private flushState(): void {
    if (!this.loaded) return;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send("session:stateChanged", this.lastState);
    } catch {
      // window tearing down
    }
  }

  show(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.positionFor(this.lastRect);
    win.showInactive();
  }

  hide(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.hide();
  }

  destroy(): void {
    const win = this.win;
    this.win = null;
    this.ready = false;
    this.loaded = false;
    this.lastState = null;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // already gone
    }
  }
}
