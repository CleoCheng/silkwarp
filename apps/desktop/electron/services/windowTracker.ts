import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { SessionHotkeyAction, WindowRect } from "../types";

/**
 * Lightweight Win32 window tracker + hotkey injector.
 *
 * Design constraints:
 * - No native C++ / node-gyp dependency. One hidden `powershell.exe` helper is
 *   kept resident per active session; it compiles a small C# P/Invoke helper
 *   with `Add-Type` once and then polls the Moonlight window every 150ms.
 * - A background .NET thread drains stdin into a ConcurrentQueue so the polling
 *   loop never blocks on console input.
 * - The helper only writes a line to stdout when the rect or window state
 *   actually changes, so IPC chatter stays low.
 * - Non-Windows platforms degrade to a no-op so the rest of the app still
 *   builds and runs.
 */

const POLL_INTERVAL_MS = 150;

const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_SHIFT = 0x10;

const HOTKEY_VK: Record<SessionHotkeyAction, number> = {
  fullscreen: 0x58, // X
  perf: 0x53, // S
  mouse: 0x5a, // Z
};

export function buildTrackerScript(targetPid: number): string {
  const hotkeysJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(HOTKEY_VK).map(([action, vk]) => [action.toUpperCase(), vk]),
    ),
  );

  return `
$ErrorActionPreference = 'SilentlyContinue'
$targetPid = ${targetPid}
$pollMs = ${POLL_INTERVAL_MS}
$hotkeysJson = @'
${hotkeysJson}
'@
$hotkeys = $hotkeysJson | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Concurrent;

public static class SwWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}

public static class SwInput {
    public static readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
    public static volatile bool Eof = false;

    public static void Start() {
        Thread t = new Thread(delegate() {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    Queue.Enqueue(line);
                }
            } catch {
            }
            Eof = true;
        });
        t.IsBackground = true;
        t.Start();
    }
}
"@

[SwInput]::Start()

function Emit-Json([string]$json) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Send-Hotkey([int]$vk) {
    $scan = [byte][SwWin32]::MapVirtualKey([uint32]$vk, 0)
    $mods = @(${VK_CONTROL}, ${VK_MENU}, ${VK_SHIFT})
    foreach ($m in $mods) {
        [SwWin32]::keybd_event([byte]$m, [byte][SwWin32]::MapVirtualKey([uint32]$m, 0), 0, [UIntPtr]::Zero)
    }
    [SwWin32]::keybd_event([byte]$vk, $scan, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [SwWin32]::keybd_event([byte]$vk, $scan, 0x0002, [UIntPtr]::Zero)
    for ($i = $mods.Count - 1; $i -ge 0; $i--) {
        $m = $mods[$i]
        [SwWin32]::keybd_event([byte]$m, [byte][SwWin32]::MapVirtualKey([uint32]$m, 0), 0x0002, [UIntPtr]::Zero)
    }
}

$lastSig = ''
$exited = $false
$eofSince = [DateTime]::MinValue

while (-not $exited) {
    $hwnd = [IntPtr]::Zero
    try {
        $proc = [System.Diagnostics.Process]::GetProcessById($targetPid)
        if ($proc.HasExited) {
            Emit-Json '{"type":"exit"}'
            break
        }
        $hwnd = $proc.MainWindowHandle
    } catch {
        Emit-Json '{"type":"exit"}'
        break
    }

    $cmd = $null
    while ([SwInput]::Queue.TryDequeue([ref]$cmd)) {
        $upper = $cmd.Trim().ToUpperInvariant()
        if ($upper -eq 'QUIT') { $exited = $true; break }
        if ($upper -eq 'FOCUS') {
            if ($hwnd -ne [IntPtr]::Zero) { [void][SwWin32]::SetForegroundWindow($hwnd) }
            continue
        }
        if ($upper.StartsWith('HOTKEY:')) {
            $action = $upper.Substring(7).Trim()
            if ($hwnd -ne [IntPtr]::Zero) {
                [void][SwWin32]::SetForegroundWindow($hwnd)
                Start-Sleep -Milliseconds 60
            }
            $vk = 0
            if ($null -ne $hotkeys.$action) { $vk = [int]$hotkeys.$action }
            if ($vk -gt 0) { Send-Hotkey $vk }
        }
    }
    if ($exited) { break }

    # Parent closed our stdin (SilkWarp exited or crashed): do not linger.
    # Grace period keeps startup races (before the first command) safe.
    if ([SwInput]::Eof -and [SwInput]::Queue.IsEmpty) {
        if ($eofSince -eq [DateTime]::MinValue) { $eofSince = [DateTime]::UtcNow }
        if (([DateTime]::UtcNow - $eofSince).TotalSeconds -ge 5) { break }
    } else {
        $eofSince = [DateTime]::MinValue
    }

    if ($hwnd -ne [IntPtr]::Zero) {
        $wr = New-Object SwWin32+RECT
        $cr = New-Object SwWin32+RECT
        if ([SwWin32]::GetWindowRect($hwnd, [ref]$wr) -and [SwWin32]::GetClientRect($hwnd, [ref]$cr)) {
            $width = $wr.Right - $wr.Left
            $height = $wr.Bottom - $wr.Top
            if ($width -gt 0 -and $height -gt 0) {
                $visible = [SwWin32]::IsWindowVisible($hwnd)
                $minimized = [SwWin32]::IsIconic($hwnd)
                $foreground = ([SwWin32]::GetForegroundWindow() -eq $hwnd)
                $sig = "$($wr.Left),$($wr.Top),$width,$height,$($cr.Right),$($cr.Bottom),$visible,$minimized,$foreground"
                if ($sig -ne $lastSig) {
                    $lastSig = $sig
                    $obj = [ordered]@{
                        type = 'rect'
                        x = $wr.Left
                        y = $wr.Top
                        width = $width
                        height = $height
                        clientWidth = $cr.Right
                        clientHeight = $cr.Bottom
                        visible = [bool]$visible
                        minimized = [bool]$minimized
                        foreground = [bool]$foreground
                    }
                    Emit-Json ($obj | ConvertTo-Json -Compress)
                }
            }
        }
    }

    Start-Sleep -Milliseconds $pollMs
}

exit 0
`;
}

export class WindowTracker {
  private readonly targetPid: number;
  private readonly callbacks: {
    onRect: (rect: WindowRect) => void;
    onExit: () => void;
  };
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stopped = false;
  private exitNotified = false;

  constructor(
    targetPid: number,
    callbacks: { onRect: (rect: WindowRect) => void; onExit: () => void },
  ) {
    this.targetPid = targetPid;
    this.callbacks = callbacks;
    if (process.platform !== "win32") return;
    if (!Number.isInteger(targetPid) || targetPid <= 0) return;
    this.start();
  }

  private start(): void {
    try {
      const script = buildTrackerScript(this.targetPid);
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      this.child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
      );

      this.child.stdout?.on("data", (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString("utf-8");
        this.drainLines();
      });

      this.child.on("error", () => {
        this.notifyExit();
      });

      this.child.on("exit", () => {
        this.notifyExit();
      });
    } catch {
      this.child = null;
    }
  }

  private drainLines(): void {
    let newlineIdx = this.stdoutBuffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (line) this.handleLine(line);
      newlineIdx = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (parsed.type === "exit") {
      this.notifyExit();
      return;
    }
    if (parsed.type !== "rect") return;

    const rect: WindowRect = {
      x: Number(parsed.x) || 0,
      y: Number(parsed.y) || 0,
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      clientWidth: Number(parsed.clientWidth) || 0,
      clientHeight: Number(parsed.clientHeight) || 0,
      visible: Boolean(parsed.visible),
      minimized: Boolean(parsed.minimized),
      foreground: Boolean(parsed.foreground),
    };
    try {
      this.callbacks.onRect(rect);
    } catch {
      // a throwing consumer must not kill the tracker
    }
  }

  private notifyExit(): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    if (this.stopped) return;
    try {
      this.callbacks.onExit();
    } catch {
      // ignore
    }
  }

  sendHotkey(action: SessionHotkeyAction): void {
    this.writeCommand(`HOTKEY:${action.toUpperCase()}`);
  }

  focusTarget(): void {
    this.writeCommand("FOCUS");
  }

  private writeCommand(cmd: string): void {
    if (!this.child || this.child.killed || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(`${cmd}\n`);
    } catch {
      // helper already gone; exit callback will clean up
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.exitNotified = true;

    const child = this.child;
    this.child = null;
    if (!child) return;

    try {
      child.stdin?.write("QUIT\n");
    } catch {
      // ignore
    }
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    child.stdout?.removeAllListeners();
    child.removeAllListeners("exit");
    child.removeAllListeners("error");

    const killTimer = setTimeout(() => {
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
    }, 400);
    killTimer.unref?.();
  }
}
