import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { SessionHotkeyAction, WindowRect } from "../types";
import { buildWindowTrackerHelperArgs, resolveWinHelperExe } from "./winHelper";

/**
 * Lightweight Win32 window tracker + hotkey injector.
 *
 * Design constraints:
 * - No native C++ / node-gyp dependency. Prefers the pre-compiled zero-dep
 *   `silkwarp-win-helper.exe` (~20 KB, instant startup) and falls back to one
 *   hidden `powershell.exe` helper when the binary is absent.
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

export interface WindowTrackerOptions {
  windowTitle?: string;
  suppressLocalIme?: boolean;
}

export function buildTrackerScript(targetPid: number, options: WindowTrackerOptions = {}): string {
  const titleB64 = Buffer.from(options.windowTitle || "", "utf8").toString("base64");
  const suppressImeFlag = options.suppressLocalIme !== false ? "$true" : "$false";
  const hotkeysJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(HOTKEY_VK).map(([action, vk]) => [action.toUpperCase(), vk]),
    ),
  );

  return `
$ErrorActionPreference = 'SilentlyContinue'
$targetPid = ${targetPid}
$pollMs = ${POLL_INTERVAL_MS}
$desiredTitle = ''
if ('${titleB64}' -ne '') {
    $desiredTitle = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${titleB64}'))
}
$suppressLocalIme = ${suppressImeFlag}
$hotkeysJson = @'
${hotkeysJson}
'@
$hotkeys = $hotkeysJson | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
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

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool SetWindowTextW(IntPtr hWnd, string lpString);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetKeyboardLayoutList(int nBuff, [Out] IntPtr[] lpList);

    [DllImport("user32.dll")]
    public static extern IntPtr GetKeyboardLayout(uint idThread);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("imm32.dll")]
    public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);

    public static void EnsureWindowTitle(IntPtr hWnd, string desired) {
        if (hWnd == IntPtr.Zero || string.IsNullOrEmpty(desired)) return;
        try {
            StringBuilder sb = new StringBuilder(256);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            string current = sb.ToString();
            if (string.IsNullOrEmpty(current) || current.IndexOf("Moonlight", StringComparison.OrdinalIgnoreCase) >= 0) {
                if (!string.Equals(current, desired, StringComparison.Ordinal)) {
                    SetWindowTextW(hWnd, desired);
                }
            }
        } catch {
        }
    }

    public static void SuppressLocalIme(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        try {
            IntPtr hImeWnd = ImmGetDefaultIMEWnd(hWnd);
            if (hImeWnd != IntPtr.Zero) {
                IntPtr openStatus;
                SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0005, IntPtr.Zero, 0x0002u, 50u, out openStatus);
                if (openStatus != IntPtr.Zero) {
                    IntPtr r1;
                    SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0006, IntPtr.Zero, 0x0002u, 50u, out r1);
                }
                IntPtr conv;
                SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0001, IntPtr.Zero, 0x0002u, 50u, out conv);
                if ((conv.ToInt64() & 1L) != 0L) {
                    IntPtr r2;
                    SendMessageTimeoutW(hImeWnd, 0x0283u, (IntPtr)0x0002, IntPtr.Zero, 0x0002u, 50u, out r2);
                }
            }
            uint pid;
            uint tid = GetWindowThreadProcessId(hWnd, out pid);
            if (tid != 0) {
                IntPtr cur = GetKeyboardLayout(tid);
                if ((cur.ToInt64() & 0x3FFL) != 0x09L) {
                    uint count = GetKeyboardLayoutList(0, null);
                    if (count > 0 && count <= 64) {
                        IntPtr[] list = new IntPtr[count];
                        uint got = GetKeyboardLayoutList((int)count, list);
                        for (int i = 0; i < got; i++) {
                            if ((list[i].ToInt64() & 0x3FFL) == 0x09L) {
                                PostMessageW(hWnd, 0x0050u, IntPtr.Zero, list[i]);
                                break;
                            }
                        }
                    }
                }
            }
        } catch {
        }
    }
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
    foreach ($stale in @(0x46, 0x0D)) {
        [SwWin32]::keybd_event([byte]$stale, [byte][SwWin32]::MapVirtualKey([uint32]$stale, 0), 0x0002, [UIntPtr]::Zero)
    }
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
$imeAppliedOnce = $false

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
        if ($desiredTitle -ne '') {
            [SwWin32]::EnsureWindowTitle($hwnd, $desiredTitle)
        }
        $wr = New-Object SwWin32+RECT
        $cr = New-Object SwWin32+RECT
        if ([SwWin32]::GetWindowRect($hwnd, [ref]$wr) -and [SwWin32]::GetClientRect($hwnd, [ref]$cr)) {
            $width = $wr.Right - $wr.Left
            $height = $wr.Bottom - $wr.Top
            if ($width -gt 0 -and $height -gt 0) {
                $visible = [SwWin32]::IsWindowVisible($hwnd)
                $minimized = [SwWin32]::IsIconic($hwnd)
                $foreground = ([SwWin32]::GetForegroundWindow() -eq $hwnd)
                if ($suppressLocalIme -and (-not $imeAppliedOnce -or $foreground)) {
                    [SwWin32]::SuppressLocalIme($hwnd)
                    $imeAppliedOnce = $true
                }
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
  private readonly options: WindowTrackerOptions;
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
    options: WindowTrackerOptions = {},
  ) {
    this.targetPid = targetPid;
    this.callbacks = callbacks;
    this.options = options;
    if (process.platform !== "win32") return;
    if (!Number.isInteger(targetPid) || targetPid <= 0) return;
    this.start();
  }

  private start(): void {
    try {
      const helperExe = resolveWinHelperExe();
      if (helperExe) {
        const args = buildWindowTrackerHelperArgs(this.targetPid, this.options);
        this.child = spawn(helperExe, args, {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } else {
        const script = buildTrackerScript(this.targetPid, this.options);
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        this.child = spawn(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
        );
      }

      // Broken pipes during teardown dispatch async `error` events on next tick.
      this.child.stdin?.on("error", () => {});
      this.child.stdout?.on("error", () => {});

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

  private safeWriteStdin(child: ChildProcess | null, payload: string, endAfter = false): void {
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return;
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) return;
    try {
      stdin.write(payload, () => {});
      if (endAfter && !stdin.destroyed && !stdin.writableEnded) {
        stdin.end();
      }
    } catch {
      // helper already gone; async pipe errors are also swallowed on stdin error listener
    }
  }

  private writeCommand(cmd: string): void {
    if (this.stopped) return;
    this.safeWriteStdin(this.child, `${cmd}\n`, false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.exitNotified = true;

    const child = this.child;
    this.child = null;
    if (!child) return;

    this.safeWriteStdin(child, "QUIT\n", true);
    child.stdout?.removeAllListeners("data");
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    child.on("error", () => {});

    const killTimer = setTimeout(() => {
      try {
        if (!child.killed && child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      } catch {
        // ignore
      }
    }, 400);
    killTimer.unref?.();
  }
}
