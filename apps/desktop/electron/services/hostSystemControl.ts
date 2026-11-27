/**
 * Win32 host control primitives for the Host Companion Agent.
 *
 * Everything here is intentionally free of `electron` imports: the module only
 * uses Node's `child_process` and the shared `DisplayMonitorInfo` /
 * `SystemActionType` types from `./hostAgentServer`, so the compiled CommonJS
 * output can be loaded directly by Node's built-in test runner.
 *
 * All Windows work goes through one-shot encoded PowerShell commands:
 * `-NoProfile -NonInteractive -EncodedCommand <utf16le base64>`.
 */

import { execFile, spawn } from "node:child_process";
import type { DisplayMonitorInfo, SystemActionType } from "./hostAgentServer";
import { resolveWinHelperExe } from "./winHelper";

function runWinHelper(args: string[], timeoutMs: number): Promise<string | null> {
  const helperExe = resolveWinHelperExe();
  if (!helperExe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      helperExe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

export interface SystemActionScript {
  powershell?: string;
  exe?: string;
  args?: string[];
  directUnsupportedMessage?: string;
}

const MONITOR_START_MARKER = "<<<SILKWARP_MONITORS>>>";
const MONITOR_END_MARKER = "<<<SILKWARP_END>>>";
const MUTE_MARKER_PATTERN = /<<<SILKWARP_MUTE:(true|false)>>>/i;
const ACTION_OK_MARKER = "<<<SILKWARP_ACTION:OK>>>";
const SAS_OK_MARKER = "<<<SILKWARP_SAS:OK>>>";
const SAS_DENIED_MARKER = "<<<SILKWARP_SAS:DENIED>>>";

const VIRTUAL_MONITOR_KEYWORDS = [
  "virtual",
  "sudomaker",
  "apollo",
  "indirect display",
  "usb mobile monitor",
  "iddsample",
];

const ACTION_SUCCESS_MESSAGES: Record<SystemActionType, string> = {
  lock: "已锁定被控端",
  taskmgr: "已在被控端打开任务管理器",
  show_desktop: "已显示被控端桌面",
  sas: "已向被控端发送 Ctrl+Alt+Del",
  repair_ime: "已重置被控端输入法服务",
  reboot: "已下发重启指令，被控端将在 2 秒后重启",
  shutdown: "已下发关机指令，被控端将在 2 秒后关机",
};

const SAS_DENIED_MESSAGE =
  "SendSAS 被系统策略拦截（需系统服务权限或启用 SoftwareSASGeneration），建议改用【锁定】或【任务管理器】";

/**
 * Returns true when a monitor descriptor looks like a virtual / indirect
 * display (Apollo, SudoMaker, IddSample, USB mobile monitors, ...).
 */
export function isVirtualMonitorDescriptor(
  friendlyName: string,
  deviceId: string,
  driverString?: string,
): boolean {
  const haystack = `${friendlyName || ""} ${deviceId || ""} ${driverString || ""}`.toLowerCase();
  return VIRTUAL_MONITOR_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sanitizeDimension(value: unknown): number {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return 0;
  return Math.max(0, Math.round(numeric));
}

function sanitizeCoordinate(value: unknown): number {
  const numeric = toFiniteNumber(value);
  return numeric === null ? 0 : Math.round(numeric);
}

function toCleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildMonitorInfo(
  source: Record<string, unknown>,
  fallbackIndex: number,
): DisplayMonitorInfo | null {
  const deviceName = toCleanString(source.deviceName ?? source.device_name);
  const friendlyName = toCleanString(source.friendlyName ?? source.friendly_name);
  const deviceId = toCleanString(source.deviceId ?? source.device_id);
  const driver = toCleanString(source.driver ?? source.driverString);
  const rawId = toCleanString(source.id);
  const id = rawId || deviceName;

  if (!id && !friendlyName && !deviceName) return null;

  const width = sanitizeDimension(source.width);
  const height = sanitizeDimension(source.height);
  const x = sanitizeCoordinate(source.x);
  const y = sanitizeCoordinate(source.y);
  const rawIndex = toFiniteNumber(source.index);
  const index =
    rawIndex !== null && Number.isInteger(rawIndex) && rawIndex >= 0
      ? rawIndex
      : fallbackIndex;

  const isVirtual =
    typeof source.isVirtual === "boolean"
      ? source.isVirtual
      : isVirtualMonitorDescriptor(friendlyName, deviceId, driver);

  const active =
    typeof source.active === "boolean" ? source.active : width > 0 && height > 0;

  return {
    index,
    id: id || `\\\\.\\DISPLAY${index + 1}`,
    deviceName: deviceName || id,
    friendlyName,
    width,
    height,
    x,
    y,
    isPrimary: Boolean(source.isPrimary ?? source.is_primary),
    isVirtual,
    active,
  };
}

function parseTabRecord(line: string, fallbackIndex: number): DisplayMonitorInfo | null {
  const parts = line.split("\t");
  if (parts.length < 7) return null;
  const rawIndex = Number(parts[0]);
  if (!Number.isFinite(rawIndex) || rawIndex < 0) return null;

  return buildMonitorInfo(
    {
      index: rawIndex,
      deviceName: parts[1],
      friendlyName: parts[2],
      deviceId: parts[3],
      driver: parts[4],
      width: parts[5],
      height: parts[6],
      x: parts[7] ?? 0,
      y: parts[8] ?? 0,
      isPrimary: (parts[9] ?? "").toLowerCase() === "true",
      isVirtual: parts[10] === undefined ? undefined : parts[10].toLowerCase() === "true",
      active: parts[11] === undefined ? undefined : parts[11].toLowerCase() === "true",
    },
    fallbackIndex,
  );
}

function parseMonitorRecord(line: string, fallbackIndex: number): DisplayMonitorInfo | null {
  const trimmed = line.replace(/^﻿/, "").trim();
  if (!trimmed) return null;

  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return buildMonitorInfo(parsed as Record<string, unknown>, fallbackIndex);
      }
      return null;
    } catch {
      // fall through to the tab-delimited fallback below
    }
  }

  return parseTabRecord(trimmed, fallbackIndex);
}

/**
 * Parses the marker-delimited monitor dump emitted by `listHostDisplays()`.
 *
 * Each record is one line of JSON (a tab-delimited legacy form is accepted as
 * a fallback). Invalid records are skipped, negative dimensions are clamped to
 * zero, and the original record order / valid indexes are preserved.
 */
export function parseMonitorLines(raw: string): DisplayMonitorInfo[] {
  if (typeof raw !== "string" || !raw) return [];

  const startIndex = raw.indexOf(MONITOR_START_MARKER);
  if (startIndex < 0) return [];

  let body = raw.slice(startIndex + MONITOR_START_MARKER.length);
  const endIndex = body.indexOf(MONITOR_END_MARKER);
  if (endIndex >= 0) body = body.slice(0, endIndex);

  const displays: DisplayMonitorInfo[] = [];
  for (const line of body.split(/\r?\n/)) {
    const record = parseMonitorRecord(line, displays.length);
    if (record) displays.push(record);
  }
  return displays;
}

/**
 * Maps a system action to its execution descriptor.
 *
 * `exe`/`args` actions are launched directly; `powershell` actions are sent
 * through `runEncodedPowerShell()` and report success with a marker line.
 */
export function buildSystemActionScript(action: SystemActionType): SystemActionScript {
  switch (action) {
    case "lock":
      return {
        powershell: String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SilkWarpLock
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool LockWorkStation();
}
'@
$ok = [SilkWarpLock]::LockWorkStation()
if ($ok) { Write-Output '${ACTION_OK_MARKER}' } else { Write-Output '<<<SILKWARP_ACTION:FAILED>>>' }
`,
      };

    case "show_desktop":
      return {
        powershell: String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
Write-Output '${ACTION_OK_MARKER}'
`,
      };

    case "taskmgr":
      return { exe: "taskmgr.exe", args: [] };

    case "sas":
      return {
        powershell: String.raw`
$ErrorActionPreference = 'Stop'
try {
    # SoftwareSASGeneration: 0=disabled, 1=services only, 2=services+apps, 3=+Ease of Access.
    # SilkWarp runs as a normal desktop app, so only 2/3 let SendSAS actually fire;
    # value 1 would silently no-op, which we report as DENIED instead of a fake OK.
    $policy = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name SoftwareSASGeneration -ErrorAction SilentlyContinue).SoftwareSASGeneration
    if ($null -eq $policy -or [int]$policy -lt 2) {
        Write-Output '${SAS_DENIED_MARKER}'
        exit 0
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SilkWarpSas
{
    [DllImport("sas.dll", SetLastError = true)]
    public static extern void SendSAS(bool asUser);
}
'@
    [SilkWarpSas]::SendSAS($false)
    Write-Output '${SAS_OK_MARKER}'
} catch {
    Write-Output '${SAS_DENIED_MARKER}'
}
`,
      };

    case "repair_ime":
      return {
        powershell: String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name 'TextInputHost','ChsIME' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name 'ctfmon' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 150
$ctfmon = Join-Path $env:WINDIR 'System32\ctfmon.exe'
if (Test-Path -LiteralPath $ctfmon) {
    Start-Process -FilePath $ctfmon -WindowStyle Hidden
}
Write-Output '${ACTION_OK_MARKER}'
`,
      };

    case "reboot":
      return {
        exe: "shutdown.exe",
        args: ["/r", "/t", "2", "/c", "SilkWarp 远程重启"],
      };

    case "shutdown":
      return {
        exe: "shutdown.exe",
        args: ["/s", "/t", "2", "/c", "SilkWarp 远程关机"],
      };

    default:
      return { directUnsupportedMessage: `不支持的系统动作: ${String(action)}` };
  }
}

/**
 * Runs a PowerShell script via `-EncodedCommand` (UTF-16LE base64) and
 * resolves with stdout. UTF-8 output encoding is forced so Chinese text and
 * friendly monitor names survive the round-trip.
 */
export function runEncodedPowerShell(script: string, timeoutMs = 10000): Promise<string> {
  const prefix =
    "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n";
  const encoded = Buffer.from(`${prefix}${script}`, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim() || error.message || "PowerShell 执行失败";
          reject(new Error(detail));
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

export function buildListDisplaysScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SilkWarpDisplays
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;
        public uint StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODEW
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmDeviceName;
        public ushort dmSpecVersion;
        public ushort dmDriverVersion;
        public ushort dmSize;
        public ushort dmDriverExtra;
        public uint dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public uint dmDisplayOrientation;
        public uint dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel;
        public uint dmPelsWidth;
        public uint dmPelsHeight;
        public uint dmDisplayFlags;
        public uint dmDisplayFrequency;
        public uint dmICMMethod;
        public uint dmICMIntent;
        public uint dmMediaType;
        public uint dmDitherType;
        public uint dmReserved1;
        public uint dmReserved2;
        public uint dmPanningWidth;
        public uint dmPanningHeight;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr rect, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplayDevices(string device, uint devNum, ref DISPLAY_DEVICE info, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplaySettingsW(string lpszDeviceName, int iModeNum, ref DEVMODEW lpDevMode);

    private static string Escape(string value)
    {
        if (value == null) return "";
        StringBuilder sb = new StringBuilder(value.Length + 8);
        foreach (char c in value)
        {
            if (c == '\\') sb.Append('\\').Append('\\');
            else if (c == '"') sb.Append('\\').Append('"');
            else if (c == '\n') sb.Append('\\').Append('n');
            else if (c == '\r') sb.Append('\\').Append('r');
            else if (c == '\t') sb.Append('\\').Append('t');
            else if (c < ' ') sb.Append('\\').Append('u').Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    private static bool IsVirtual(string friendly, string deviceId, string driver)
    {
        string haystack = (friendly + " " + deviceId + " " + driver).ToLowerInvariant();
        return haystack.Contains("virtual")
            || haystack.Contains("sudomaker")
            || haystack.Contains("apollo")
            || haystack.Contains("indirect display")
            || haystack.Contains("usb mobile monitor")
            || haystack.Contains("iddsample");
    }

    public static string[] GetDisplays()
    {
        List<string> lines = new List<string>();
        Dictionary<string, string> adapters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        DISPLAY_DEVICE adapter = new DISPLAY_DEVICE();
        adapter.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        uint adapterIndex = 0;
        while (EnumDisplayDevices(null, adapterIndex, ref adapter, 0))
        {
            if (!string.IsNullOrEmpty(adapter.DeviceName))
            {
                adapters[adapter.DeviceName] = adapter.DeviceString;
            }
            adapter = new DISPLAY_DEVICE();
            adapter.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            adapterIndex++;
        }

        int index = 0;
        MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!GetMonitorInfo(hMonitor, ref info)) return true;

            DISPLAY_DEVICE device = new DISPLAY_DEVICE();
            device.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            string friendly = "";
            string deviceId = "";
            if (EnumDisplayDevices(info.szDevice, 0, ref device, 0))
            {
                friendly = device.DeviceString;
                deviceId = device.DeviceID;
            }

            string driver = "";
            adapters.TryGetValue(info.szDevice, out driver);

            int width = info.rcMonitor.Right - info.rcMonitor.Left;
            int height = info.rcMonitor.Bottom - info.rcMonitor.Top;
            DEVMODEW devMode = new DEVMODEW();
            devMode.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODEW));
            if (EnumDisplaySettingsW(info.szDevice, -1, ref devMode) && devMode.dmPelsWidth > 0 && devMode.dmPelsHeight > 0)
            {
                width = (int)devMode.dmPelsWidth;
                height = (int)devMode.dmPelsHeight;
            }
            bool primary = (info.dwFlags & 1) == 1;
            bool virtualMonitor = IsVirtual(friendly, deviceId, driver);

            StringBuilder sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"index\":").Append(index).Append(",");
            sb.Append("\"id\":\"").Append(Escape(info.szDevice)).Append("\",");
            sb.Append("\"deviceName\":\"").Append(Escape(info.szDevice)).Append("\",");
            sb.Append("\"friendlyName\":\"").Append(Escape(friendly)).Append("\",");
            sb.Append("\"deviceId\":\"").Append(Escape(deviceId)).Append("\",");
            sb.Append("\"driver\":\"").Append(Escape(driver)).Append("\",");
            sb.Append("\"width\":").Append(width).Append(",");
            sb.Append("\"height\":").Append(height).Append(",");
            sb.Append("\"x\":").Append(info.rcMonitor.Left).Append(",");
            sb.Append("\"y\":").Append(info.rcMonitor.Top).Append(",");
            sb.Append("\"isPrimary\":").Append(primary ? "true" : "false").Append(",");
            sb.Append("\"isVirtual\":").Append(virtualMonitor ? "true" : "false").Append(",");
            sb.Append("\"active\":true");
            sb.Append("}");
            lines.Add(sb.ToString());
            index++;
            return true;
        };

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        return lines.ToArray();
    }
}
'@
Write-Output '${MONITOR_START_MARKER}'
foreach ($line in [SilkWarpDisplays]::GetDisplays()) {
    Write-Output $line
}
Write-Output '${MONITOR_END_MARKER}'
`;
}

function buildMasterMuteScript(action: "get" | "set", muted?: boolean): string {
  const setCall =
    action === "set"
      ? `[SilkWarpAudio]::SetMute(${muted ? "$true" : "$false"})`
      : "[SilkWarpAudio]::GetMute()";
  return String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ClassInterface(ClassInterfaceType.None)]
public class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePtr);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume
{
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint channelCount);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid eventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channelNumber, float level, ref Guid eventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channelNumber, float level, ref Guid eventContext);
    [PreserveSig] int GetChannelVolumeLevel(uint channelNumber, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channelNumber, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

public static class SilkWarpAudio
{
    private static IAudioEndpointVolume Open(out object enumeratorObj, out object deviceObj)
    {
        enumeratorObj = null;
        deviceObj = null;
        MMDeviceEnumeratorComObject enumerator = new MMDeviceEnumeratorComObject();
        enumeratorObj = enumerator;
        IMMDeviceEnumerator enumeratorInterface = (IMMDeviceEnumerator)enumerator;
        IMMDevice device;
        int hr = enumeratorInterface.GetDefaultAudioEndpoint(0, 1, out device);
        if (hr != 0 || device == null) throw new COMException("GetDefaultAudioEndpoint failed", hr);
        deviceObj = device;
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object volumeObj;
        hr = device.Activate(ref iid, 0, IntPtr.Zero, out volumeObj);
        if (hr != 0 || volumeObj == null) throw new COMException("Activate failed", hr);
        return (IAudioEndpointVolume)volumeObj;
    }

    public static bool GetMute()
    {
        object enumeratorObj = null;
        object deviceObj = null;
        object volumeObj = null;
        try
        {
            volumeObj = Open(out enumeratorObj, out deviceObj);
            IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObj;
            bool muted;
            int hr = volume.GetMute(out muted);
            if (hr != 0) throw new COMException("GetMute failed", hr);
            return muted;
        }
        finally
        {
            if (volumeObj != null) Marshal.ReleaseComObject(volumeObj);
            if (deviceObj != null) Marshal.ReleaseComObject(deviceObj);
            if (enumeratorObj != null) Marshal.ReleaseComObject(enumeratorObj);
        }
    }

    public static bool SetMute(bool muted)
    {
        object enumeratorObj = null;
        object deviceObj = null;
        object volumeObj = null;
        try
        {
            volumeObj = Open(out enumeratorObj, out deviceObj);
            IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObj;
            Guid context = Guid.Empty;
            int hr = volume.SetMute(muted, ref context);
            if (hr != 0) throw new COMException("SetMute failed", hr);
            bool current;
            hr = volume.GetMute(out current);
            if (hr != 0) throw new COMException("GetMute failed", hr);
            return current;
        }
        finally
        {
            if (volumeObj != null) Marshal.ReleaseComObject(volumeObj);
            if (deviceObj != null) Marshal.ReleaseComObject(deviceObj);
            if (enumeratorObj != null) Marshal.ReleaseComObject(enumeratorObj);
        }
    }
}
'@
    $muted = ${setCall}
    if ($muted) { Write-Output '<<<SILKWARP_MUTE:true>>>' } else { Write-Output '<<<SILKWARP_MUTE:false>>>' }
} catch {
    Write-Output '<<<SILKWARP_MUTE:false>>>'
}
`;
}

function parseMuteMarker(output: string): boolean {
  const match = output.match(MUTE_MARKER_PATTERN);
  return Boolean(match && match[1].toLowerCase() === "true");
}

/**
 * Enumerates active monitors on the host. Returns an empty list on non-Windows
 * platforms or when enumeration fails.
 */
export async function listHostDisplays(): Promise<DisplayMonitorInfo[]> {
  if (process.platform !== "win32") return [];
  const helperOutput = await runWinHelper(["displays"], 5000);
  if (helperOutput !== null && helperOutput.includes(MONITOR_START_MARKER)) {
    return parseMonitorLines(helperOutput);
  }
  try {
    const output = await runEncodedPowerShell(buildListDisplaysScript(), 15000);
    return parseMonitorLines(output);
  } catch {
    return [];
  }
}

/** Reads the default render endpoint's master mute state. */
export async function getHostMasterMute(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const helperOutput = await runWinHelper(["mute-get"], 4000);
  if (helperOutput !== null && MUTE_MARKER_PATTERN.test(helperOutput)) {
    return parseMuteMarker(helperOutput);
  }
  try {
    const output = await runEncodedPowerShell(buildMasterMuteScript("get"), 10000);
    return parseMuteMarker(output);
  } catch {
    return false;
  }
}

/** Sets the default render endpoint's master mute state and returns the new state. */
export async function setHostMasterMute(muted: boolean): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const helperOutput = await runWinHelper(["mute-set", muted ? "true" : "false"], 4000);
  if (helperOutput !== null && MUTE_MARKER_PATTERN.test(helperOutput)) {
    return parseMuteMarker(helperOutput);
  }
  try {
    const output = await runEncodedPowerShell(buildMasterMuteScript("set", muted), 10000);
    return parseMuteMarker(output);
  } catch {
    return false;
  }
}

function interpretActionOutput(action: SystemActionType, output: string): { ok: boolean; message: string } {
  if (action === "sas") {
    if (output.includes(SAS_OK_MARKER)) {
      return { ok: true, message: ACTION_SUCCESS_MESSAGES.sas };
    }
    return { ok: false, message: SAS_DENIED_MESSAGE };
  }

  if (output.includes(ACTION_OK_MARKER)) {
    return { ok: true, message: ACTION_SUCCESS_MESSAGES[action] };
  }
  return { ok: false, message: `系统动作未成功执行: ${action}` };
}

/**
 * Executes a host system action and returns a user-facing Chinese message.
 *
 * `sas` is special-cased: Windows blocks software-generated SAS by default, so
 * a denied result is reported as a recoverable failure instead of throwing.
 */
export async function runHostSystemAction(
  action: SystemActionType,
): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "win32") {
    return { ok: false, message: "系统动作仅支持 Windows 被控端" };
  }

  const spec = buildSystemActionScript(action);
  if (spec.directUnsupportedMessage) {
    return { ok: false, message: spec.directUnsupportedMessage };
  }

  try {
    if (spec.exe) {
      if (action === "taskmgr") {
        const child = spawn(spec.exe, spec.args ?? [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.on("error", () => {
          // Reported asynchronously; the action itself was dispatched.
        });
        child.unref();
        return { ok: true, message: ACTION_SUCCESS_MESSAGES[action] };
      }

      await new Promise<void>((resolve, reject) => {
        execFile(
          spec.exe as string,
          spec.args ?? [],
          { timeout: 10000, windowsHide: true },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
      return { ok: true, message: ACTION_SUCCESS_MESSAGES[action] };
    }

    if (action === "lock" || action === "show_desktop" || action === "sas" || action === "repair_ime") {
      const helperOutput = await runWinHelper(["action", action], 8000);
      if (helperOutput !== null) {
        return interpretActionOutput(action, helperOutput);
      }
    }

    if (spec.powershell) {
      const output = await runEncodedPowerShell(spec.powershell, 12000);
      return interpretActionOutput(action, output);
    }

    return { ok: false, message: `系统动作未配置执行方式: ${action}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `执行失败：${detail}` };
  }
}
